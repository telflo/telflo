import {
  ACCOUNT_SESSIONS_MAXIMUM,
  AccountSessionsResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  CurrentUserResponseSchema,
  ErrorResponseSchema,
  SwitchOrganizationRequestSchema,
  SwitchOrganizationResponseSchema,
  TermsAcceptanceRequestSchema,
  type SessionErrorCode,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { setDatabaseContext, withUserContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import { AppError } from "../../errors.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { cannotRevokeCurrentSession, sessionNotFound } from "../account/errors.js";
import { createUserSettingsRepository } from "../account/repositories/user-settings-repository.js";
import { setStoredThemeCookie } from "../account/theme-cookie.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createMemberRepository } from "../organizations/repositories/member-repository.js";
import { canonicalIdOf } from "../organizations/service.js";
import {
  createActiveOrganizationRepository,
  createOrganizationRepository,
  type WithUserOrganizations,
} from "../organizations/repositories/organization-repository.js";
import { createUserRepository } from "../identity/repositories/user-repository.js";
import { assertCurrentTermsVersion } from "../identity/terms.js";
import { createAccessTokens, type IAccessTokens } from "./access-tokens.js";
import { createAuthenticate, decorateAuthentication, requireAuthentication } from "./authenticate.js";
import {
  ACCESS_COOKIE_NAME,
  accessCookieOptions,
  clearSessionCookies,
  REFRESH_COOKIE_NAME,
  setSessionCookies,
} from "./cookies.js";
import { createRefreshTokenRepository } from "./repositories/refresh-token-repository.js";
import { createSessionRepository } from "./repositories/session-repository.js";
import { createSessionService, type ISessionService, type WithSessionTransaction } from "./service.js";
import { parseUserAgent } from "./user-agent.js";
import { mayCreateOrganizations, readOrganizationCreation } from "../site-settings/organization-creation.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface SessionRoutesDependencies extends ServerDependencies {
  now: () => Date;
}

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  429: ErrorResponseSchema,
};

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

/** One session to sign out: a uuid, strictly (a non-uuid is 400 invalid_request; the static `current` wins). */
const SessionParamsSchema = z.object({ sessionId: z.string().uuid() }).strict();

/** Where a request came from, for the audit trail. */
function requestOrigin(request: FastifyRequest): { ipAddress: string | undefined; userAgent: string | undefined } {
  return { ipAddress: clientIpForAudit(request.ip), userAgent: auditUserAgent(request) };
}

/**
 * The session service on the database: every repository it writes through in
 * a transaction is bound to that transaction. Also used by the OIDC routes,
 * whose sign-in starts its session here.
 */
export function createDatabaseSessionService(deps: SessionRoutesDependencies): {
  service: ISessionService;
  accessTokens: IAccessTokens;
  withUserOrganizations: WithUserOrganizations;
} {
  const { settings, db, now } = deps;
  const accessTokens = createAccessTokens({
    secret: settings.accessTokenSecret,
    ttlMinutes: settings.accessTokenTtlMinutes,
    now,
  });
  const withUserOrganizations: WithUserOrganizations = (userId, work) =>
    withUserContext(db, userId, (transaction) => work(createOrganizationRepository(transaction)));
  const withTransaction: WithSessionTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({
        users: createUserRepository(transaction),
        sessions: createSessionRepository(transaction),
        organizations: createOrganizationRepository(transaction),
        refreshTokens: createRefreshTokenRepository(transaction),
        audit: createAuditRepository(transaction),
        setDatabaseContext: (context) => setDatabaseContext(transaction, context),
        inOrganization: (organizationId) => ({
          organization: createActiveOrganizationRepository(transaction, { organizationId }),
          members: createMemberRepository(transaction, { organizationId }),
        }),
      }),
    );
  const service = createSessionService({
    users: createUserRepository(db),
    withUserOrganizations,
    sessions: createSessionRepository(db),
    audit: createAuditRepository(db),
    withTransaction,
    accessTokens,
    settings,
    now,
  });
  return { service, accessTokens, withUserOrganizations };
}

/**
 * The session endpoints. Tokens travel only in HttpOnly cookies, never
 * in a response body, so no script on the page can read them.
 *
 * The validator/serializer compilers are server-wide and set once in
 * buildServer, not here.
 */
export function registerSessionRoutes(
  server: FastifyInstance,
  deps: SessionRoutesDependencies,
  rateLimiters: RateLimiters,
): void {
  const { settings, db, now } = deps;
  const { service, accessTokens, withUserOrganizations } = createDatabaseSessionService(deps);
  const users = createUserRepository(db);
  const userSettings = createUserSettingsRepository(db);
  const sessionRepository = createSessionRepository(db);

  decorateAuthentication(server);
  const authenticate = createAuthenticate(service);
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/v1/auth/sessions",
    {
      // The shared per-IP bucket first, before the body is even parsed; the
      // per-email limit needs the validated body, so it waits for preHandler.
      onRequest: rateLimiters.identityPerIp,
      preHandler: rateLimiters.signInPerEmail.preHandler,
      schema: {
        body: CreateSessionRequestSchema,
        response: { 200: CreateSessionResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      // Only failed sign-ins count toward the per-email limit, and a success
      // clears it.
      const issued = await service.signIn({ ...request.body, ...requestOrigin(request) }).catch((error: unknown) => {
        rateLimiters.signInPerEmail.failed(request.body.email, error);
        throw error;
      });
      rateLimiters.signInPerEmail.succeeded(request.body.email);
      setSessionCookies(reply, settings, issued);
      // After the session cookies, and never throwing.
      await setStoredThemeCookie(reply, settings, userSettings, issued.user.id, request.log);
      return reply.send({ user: issued.user });
    },
  );

  typed.post(
    "/api/v1/auth/refresh",
    {
      onRequest: rateLimiters.refreshPerIp,
      schema: { response: { 200: CreateSessionResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const refreshToken = request.cookies[REFRESH_COOKIE_NAME];
      try {
        if (!refreshToken) throw new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
        const result = await service.refresh({ refreshToken, ...requestOrigin(request) });
        // Each answer also refreshes the theme cookie from the stored theme,
        // after the session's cookies and never throwing: a change made in
        // another browser reaches this one.
        if (result.kind === "rotated") {
          setSessionCookies(reply, settings, result.issued);
          await setStoredThemeCookie(reply, settings, userSettings, result.issued.user.id, request.log);
          return reply.send({ user: result.issued.user });
        }
        // The grace window: only a new access token. The concurrent refresh
        // that won the rotation set the new refresh cookie in the same jar;
        // setting or clearing it here would overwrite that.
        void reply.setCookie(ACCESS_COOKIE_NAME, result.accessToken, accessCookieOptions(settings));
        await setStoredThemeCookie(reply, settings, userSettings, result.user.id, request.log);
        return reply.send({ user: result.user });
      } catch (error) {
        // A refused refresh leaves nothing worth keeping: the browser drops
        // both cookies, so it stops presenting a dead pair. An unexpected
        // failure (the database unreachable, say) is not a refusal, and
        // keeps them so a retry can succeed.
        if (error instanceof AppError) clearSessionCookies(reply, settings);
        throw error;
      }
    },
  );

  /**
   * Logout. An expired but validly signed access token still names the
   * session to revoke, so a user idle past the access TTL can log out. With
   * no usable token at all there is nothing to revoke, and the cookies are
   * still cleared.
   */
  typed.delete(
    "/api/v1/auth/sessions/current",
    { schema: { response: { 204: noContent, ...errorResponses } } },
    async (request, reply) => {
      const accessToken = request.cookies[ACCESS_COOKIE_NAME];
      const verified = accessToken ? await accessTokens.verify(accessToken) : undefined;
      const claims = verified && verified.status !== "invalid" ? verified.claims : undefined;
      await service.signOut({
        sessionId: claims?.sessionId,
        userId: claims?.userId,
        organizationId: claims?.organizationId,
        ...requestOrigin(request),
      });
      clearSessionCookies(reply, settings);
      return reply.status(204).send(null);
    },
  );

  typed.delete(
    "/api/v1/auth/sessions",
    { preHandler: authenticate, schema: { response: { 204: noContent, ...errorResponses } } },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      await service.signOutEverywhere({
        userId: authentication.context.userId,
        email: authentication.email,
        organizationId: authentication.context.organizationId,
        ...requestOrigin(request),
      });
      clearSessionCookies(reply, settings);
      return reply.status(204).send(null);
    },
  );

  /**
   * Since when a session counts as live: refreshed within the refresh token's
   * lifetime, by the injected clock. An idle session past it can never refresh
   * again.
   */
  const liveSince = () => new Date(now().getTime() - settings.refreshTokenTtlDays * DAY_IN_MILLISECONDS);

  /**
   * The caller's live sessions: the current one first, then by last
   * activity, at most ACCOUNT_SESSIONS_MAXIMUM, with the exact total. The
   * user agent leaves the API only as its two families; the raw string is
   * never in the reply and never logged.
   */
  typed.get(
    "/api/v1/auth/sessions",
    { preHandler: authenticate, schema: { response: { 200: AccountSessionsResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      const { userId, sessionId } = requireAuthentication(request).context;
      const page = await sessionRepository.listLiveForUser(userId, sessionId, liveSince(), ACCOUNT_SESSIONS_MAXIMUM);
      return reply.send({
        items: page.sessions.map((session) => ({
          id: session.id,
          isCurrent: session.id === sessionId,
          signedInAt: session.createdAt.toISOString(),
          lastActiveAt: session.lastRefreshedAt.toISOString(),
          ipAddress: session.ipAddress,
          ...parseUserAgent(session.userAgent),
        })),
        total: page.total,
      });
    },
  );

  /**
   * Signs out one of the caller's other sessions: its row revoked with
   * `signed_out_elsewhere`, so its next request, and its next refresh, is
   * refused. The caller's own is Log out's (409). Another user's, an unknown
   * and an ended session are one 404: nothing says which. The update and its
   * audit row commit together.
   */
  typed.delete(
    "/api/v1/auth/sessions/:sessionId",
    {
      preHandler: authenticate,
      schema: {
        params: SessionParamsSchema,
        response: { 204: noContent, ...errorResponses, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      const { userId, organizationId, sessionId: currentSessionId } = authentication.context;
      // Lowercased before the comparison: Postgres matches an id in capitals
      // to the same row, so a case-sensitive check would let the
      // caller's own session past it. The params schema has refused every
      // other spelling with 400; undefined can't reach here, and would be
      // nothing's id.
      const sessionId = canonicalIdOf(request.params.sessionId);
      if (sessionId === undefined) throw sessionNotFound();
      if (sessionId === currentSessionId) throw cannotRevokeCurrentSession();
      const at = now();
      const isRevoked = await db.transaction().execute(async (transaction) => {
        const revoked = await createSessionRepository(transaction).revokeOwn(
          sessionId,
          userId,
          currentSessionId,
          liveSince(),
          "signed_out_elsewhere",
          at,
        );
        if (!revoked) return false;
        await createAuditRepository(transaction).record({
          action: "user.session_revoked",
          actorUserId: userId,
          actorEmail: authentication.email,
          organizationId,
          subjectType: "session",
          subjectId: sessionId,
          ...requestOrigin(request),
        });
        return true;
      });
      if (!isRevoked) throw sessionNotFound();
      return reply.status(204).send(null);
    },
  );

  typed.get(
    "/api/v1/auth/me",
    { preHandler: authenticate, schema: { response: { 200: CurrentUserResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      const { context } = authentication;
      const [user, memberships, preferences, organizationCreation] = await Promise.all([
        users.findById(context.userId),
        withUserOrganizations(context.userId, (organizations) => organizations.listForUser(context.userId)),
        userSettings.find(context.userId),
        readOrganizationCreation(db),
      ]);
      // Deleted since `authenticate` accepted the token: the session is over.
      if (!user) throw new AppError("unauthenticated" satisfies SessionErrorCode, "You need to sign in.", 401);
      return reply.send({
        user: { id: context.userId, email: authentication.email },
        organization: {
          id: context.organizationId,
          name: authentication.organizationName,
          type: authentication.organizationType,
          logoId: authentication.organizationLogoId,
          role: context.role,
        },
        organizations: memberships.map(({ id, name, type, logoId, role }) => ({ id, name, type, logoId, role })),
        // While the site asks for Terms (its version isn't ""), null (a
        // federated sign-up, or a takeover) and any older version alike need
        // them accepted; a site without Terms asks nobody.
        termsAcceptanceRequired:
          settings.site.terms.version !== "" && user.acceptedTermsVersion !== settings.site.terms.version,
        // The row's flag as this request's session check read it, so a
        // revocation shows on the next request.
        isProductAdmin: authentication.isProductAdmin,
        // Whether "Create Organization" is offered: the product admins'
        // switch, read now, and the flag above. The create checks again.
        mayCreateOrganizations: mayCreateOrganizations(organizationCreation, authentication.isProductAdmin),
        // The defaults with no row: the signed-in pages render the stored theme from it.
        preferences,
      });
    },
  );

  /**
   * Switches the session's active organization. Only the access cookie is
   * set: the refresh token belongs to the session, whose row now names
   * the new organization, so a refresh stays in it.
   */
  typed.put(
    "/api/v1/auth/sessions/current/organization",
    {
      preHandler: authenticate,
      schema: {
        body: SwitchOrganizationRequestSchema,
        response: { 200: SwitchOrganizationResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      const switched = await service.switchOrganization({
        context: authentication.context,
        email: authentication.email,
        organizationId: request.body.organizationId,
        ...requestOrigin(request),
      });
      if (switched.access) {
        void reply.setCookie(ACCESS_COOKIE_NAME, switched.access.token, accessCookieOptions(settings));
      }
      return reply.send({ organization: switched.organization });
    },
  );

  /**
   * Accepts the current terms. Only the site's Terms version
   * (TELFLO_TERMS_VERSION) is accepted, and none while the site asks for no
   * Terms: a page showing older terms gets `terms_version_not_current` rather
   * than recording consent to terms that no longer apply. Accepting the
   * version already accepted changes nothing and audits nothing, so a double
   * click or a retry leaves one audit row. Not rate limited: it needs a
   * session.
   */
  typed.put(
    "/api/v1/auth/me/terms-acceptance",
    {
      preHandler: authenticate,
      schema: { body: TermsAcceptanceRequestSchema, response: { 204: noContent, ...errorResponses } },
    },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      const { version } = request.body;
      assertCurrentTermsVersion(version, settings.site.terms.version);
      await db.transaction().execute(async (transaction) => {
        const { userId, organizationId } = authentication.context;
        const accepted = await createUserRepository(transaction).acceptTerms(userId, version, now());
        if (!accepted) return;
        await createAuditRepository(transaction).record({
          action: "user.terms_accepted",
          actorUserId: userId,
          actorEmail: authentication.email,
          organizationId,
          subjectType: "user",
          subjectId: userId,
          metadata: { version },
          ...requestOrigin(request),
        });
      });
      return reply.status(204).send(null);
    },
  );
}
