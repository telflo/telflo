import {
  ErrorResponseSchema,
  IDENTITY_PROVIDER_ID_PATTERN,
  IdentityLinkRequestSchema,
  IdentityLinkResponseSchema,
  OidcProvidersResponseSchema,
  safeRedirectPath,
  SignInMethodsResponseSchema,
  UnlinkIdentityRequestSchema,
  type OidcLinkResultCode,
  type OidcQueryErrorCode,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDependencies } from "../../dependencies.js";
import { AppError } from "../../errors.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { providerUnavailable } from "../account/errors.js";
import { createUserSettingsRepository } from "../account/repositories/user-settings-repository.js";
import { setStoredThemeCookie } from "../account/theme-cookie.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createUserIdentityRepository } from "../identity/repositories/user-identity-repository.js";
import { createUserRepository } from "../identity/repositories/user-repository.js";
import { createVerificationTokenRepository } from "../identity/repositories/verification-token-repository.js";
import { createPasswordResetTokenRepository } from "../password-resets/repositories/password-reset-token-repository.js";
import {
  clearedOidcFlowCookieOptions,
  oidcFlowCookieName,
  oidcFlowCookieOptions,
  setSessionCookies,
} from "../sessions/cookies.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { createAuthenticate, requireAuthentication } from "../sessions/authenticate.js";
import { createSessionRepository } from "../sessions/repositories/session-repository.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { LINK_REDIRECT_PATH, readFlowCookie } from "./flow-cookie.js";
import { createOidcProviderRegistry } from "./providers.js";
import { createOidcService, oidcCallbackUrl, unknownProvider, type WithOidcTransaction } from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface OidcRoutesDependencies extends ServerDependencies {
  now: () => Date;
  opampRegistration: OpampRegistration;
  /** Required, as the password-reset routes' (D21 Preflight ruling 18): a link's and an unlink's emails go after the response. */
  runAfterResponse: RunAfterResponse;
}

const ProviderParamsSchema = z.object({ provider: z.string().min(1).max(64) });
const StartQuerySchema = z.object({ redirectTo: z.string().optional() });
/** An identity's provider, as the flow cookie checks it: one no longer configured can still be unlinked. */
const IdentityParamsSchema = z.object({ provider: z.string().regex(IDENTITY_PROVIDER_ID_PATTERN) }).strict();

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Where a request came from, for the audit trail. */
function requestOrigin(request: FastifyRequest): { ipAddress: string | undefined; userAgent: string | undefined } {
  return { ipAddress: clientIpForAudit(request.ip), userAgent: auditUserAgent(request) };
}

/**
 * D2c decision 1's sign-in endpoints. The start and the callback are GETs,
 * top-level navigations: neither can carry the CSRF header, and neither
 * needs it. The start only sets a cookie; the callback acts only when its
 * `state` matches the cookie this browser was given (decision 3).
 *
 * The validator/serializer compilers are server-wide and set once in
 * buildServer, not here.
 */
export function registerOidcRoutes(
  server: FastifyInstance,
  deps: OidcRoutesDependencies,
  rateLimiters: RateLimiters,
): void {
  const { settings, db, now } = deps;
  const providers = createOidcProviderRegistry(settings, deps.oidcFetch ? { fetch: deps.oidcFetch } : {});
  const { service: sessions, withUserOrganizations } = createDatabaseSessionService(deps);
  const authenticate = createAuthenticate(sessions);
  const userSettings = createUserSettingsRepository(db);
  // Every repository bound to one transaction (D2c Ruling 9). The user
  // repository is handed out as its transaction-safe methods only: see
  // OidcTransaction.
  const withTransaction: WithOidcTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({
        users: createUserRepository(transaction),
        identities: createUserIdentityRepository(transaction),
        passwordResetTokens: createPasswordResetTokenRepository(transaction),
        verificationTokens: createVerificationTokenRepository(transaction),
        sessions: createSessionRepository(transaction),
        audit: createAuditRepository(transaction),
      }),
    );
  const service = createOidcService({
    providers,
    users: createUserRepository(db),
    identities: createUserIdentityRepository(db),
    withUserOrganizations,
    audit: createAuditRepository(db),
    sessions,
    withTransaction,
    settings,
    now,
    opampRegistration: deps.opampRegistration,
    mailer: deps.mailer,
    runAfterResponse: deps.runAfterResponse,
  });

  /** A page on the web app. Every path here is already cleaned by safeRedirectPath. */
  const webUrl = (path: string) => `${settings.publicWebUrl}${path}`;

  /** The sign-in page with the error and the cleaned `redirectTo` kept (D2c decision 4). */
  const loginUrl = (code: OidcQueryErrorCode, redirectTo: string) =>
    webUrl(`/login?${new URLSearchParams({ error: code, redirectTo }).toString()}`);

  /** Where a link from Settings ends: the Account page with a fixed result code, no personal data (D21 decision 38). */
  const linkResultUrl = (code: OidcLinkResultCode) =>
    webUrl(`${LINK_REDIRECT_PATH}?${new URLSearchParams({ link: code }).toString()}`);

  /** One name for the flow cookie's set, read and clear (`__Secure-` when Secure). */
  const flowCookieName = oidcFlowCookieName(settings);

  const clearFlowCookie = (reply: FastifyReply) => {
    void reply.setCookie(flowCookieName, "", clearedOidcFlowCookieOptions(settings));
  };

  const typed = server.withTypeProvider<ZodTypeProvider>();

  // A static read of the settings, so not rate limited (D2c decision 7).
  typed.get(
    "/api/v1/auth/oidc-providers",
    { schema: { response: { 200: OidcProvidersResponseSchema } } },
    async (_request, reply) => reply.send({ providers: providers.list() }),
  );

  typed.get(
    "/api/v1/auth/oidc/:provider",
    {
      // The shared per-IP bucket (D2c decision 7): the callback can create
      // an account. The start may answer a 429 with the envelope.
      onRequest: rateLimiters.identityPerIp,
      schema: {
        params: ProviderParamsSchema,
        querystring: StartQuerySchema,
        response: { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 429: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await service.beginSignIn({
        providerId: request.params.provider,
        redirectTo: request.query.redirectTo,
      });
      if (result.kind === "unknown_provider") {
        throw unknownProvider();
      }
      void reply.header("cache-control", "no-store");
      if (result.kind === "unavailable") {
        // Discovery failed; the next sign-in tries again (D2c decision 2).
        request.log.warn({ err: result.error }, "OIDC provider discovery failed");
        return reply.redirect(loginUrl("oauth_failed", result.redirectTo), 302);
      }
      void reply.setCookie(flowCookieName, result.flowCookie, oidcFlowCookieOptions(settings));
      return reply.redirect(result.authorizationUrl.href, 302);
    },
  );

  /**
   * The browser is navigating here from the provider, so every outcome is a
   * redirect, never the error envelope: success to the web app, failure to
   * `/login?error=…`. The flow cookie is cleared whatever happens (D2c
   * decision 3), a 429 included.
   */
  server.get(
    "/api/v1/auth/oidc/:provider/callback",
    {
      onRequest: rateLimiters.identityPerIp,
      // The last resort: the service audits and redirects any unexpected
      // failure itself, keeping the flow's `redirectTo`. Anything thrown
      // past it, a hook's 429 included, still ends in a redirect: a link's
      // to the Account page (D21 Preflight ruling 7), anything else to
      // sign-in. It writes no audit row and sets no session or theme cookie.
      // Only an unexpected failure is logged: the query holds the code, and
      // the request serializer keeps it out of the request's own log lines.
      errorHandler: async (error, request, reply) => {
        const isRateLimited = error instanceof AppError && error.statusCode === 429;
        if (!isRateLimited) request.log.error({ err: error }, "OIDC callback failed");
        const cookie = request.cookies[flowCookieName];
        const flow = cookie ? await readFlowCookie(cookie, settings.accessTokenSecret, now()) : undefined;
        clearFlowCookie(reply);
        void reply.header("cache-control", "no-store");
        return reply.redirect(
          flow?.intent === "link" ? linkResultUrl("link_failed") : loginUrl("oauth_failed", "/app"),
          302,
        );
      },
    },
    async (request, reply) => {
      const { provider } = request.params as { provider: string };
      const cookie = request.cookies[flowCookieName];
      const flow = cookie ? await readFlowCookie(cookie, settings.accessTokenSecret, now()) : undefined;
      clearFlowCookie(reply);
      void reply.header("cache-control", "no-store");

      const result = await service.completeSignIn({
        providerId: provider,
        callbackUrl: oidcCallbackUrl(settings, provider, request.url),
        flow,
        origin: requestOrigin(request),
      });
      if (result.kind === "refused") {
        // An unexpected failure, already audited by a label; the log gets the error.
        if (result.error !== undefined) request.log.error({ err: result.error }, "OIDC callback failed");
        return reply.redirect(loginUrl(result.code, result.redirectTo), 302);
      }
      if (result.kind === "link_ended") {
        if (result.error !== undefined) request.log.error({ err: result.error }, "OIDC callback failed");
        // A link starts no session: no session cookie and no theme cookie.
        return reply.redirect(linkResultUrl(result.code), 302);
      }
      setSessionCookies(reply, settings, result.issued);
      // The stored theme, after the session's cookies and never throwing (D21 decision 23, Preflight ruling 4).
      await setStoredThemeCookie(reply, settings, userSettings, result.issued.user.id, request.log);
      // Cleaned when the flow started, and again now it ends.
      return reply.redirect(webUrl(safeRedirectPath(result.redirectTo)), 302);
    },
  );

  /**
   * The account's sign-in methods (D21 decision 37): `authenticate` only,
   * never the terms check (decision 20), and no limit.
   */
  typed.get(
    "/api/v1/auth/me/sign-in-methods",
    {
      preHandler: authenticate,
      schema: { response: { 200: SignInMethodsResponseSchema, 401: ErrorResponseSchema } },
    },
    async (request, reply) => reply.send(await service.signInMethods(requireAuthentication(request).context)),
  );

  /**
   * Starts linking a provider from Settings (D21 decision 38): a POST, so it
   * carries the CSRF header and the current password stays out of the URL.
   * The shared per-IP bucket first, then, once the session is known,
   * sign-in's per-email failure budget keyed by the session's address
   * (Preflight ruling 9), settled exactly once whatever happens. Answers
   * the provider's URL for the browser to go to, with the flow cookie set
   * under its own path (valid from this one), and nothing cached.
   */
  typed.post(
    "/api/v1/auth/me/identity-link-requests",
    {
      onRequest: rateLimiters.identityPerIp,
      preHandler: [authenticate, rateLimiters.signInPerEmail.reauthenticationPreHandler],
      schema: {
        body: IdentityLinkRequestSchema,
        response: {
          201: IdentityLinkResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      void reply.header("cache-control", "no-store");
      // Settled exactly once (Preflight ruling 9): a verified password clears
      // the address; anything else, a password-less start included, keeps
      // the count only for a wrong current password.
      let isReauthenticated = false;
      let failure: unknown;
      try {
        const result = await service.beginLink({
          providerId: request.body.provider,
          currentPassword: request.body.currentPassword,
          context: authentication.context,
          origin: requestOrigin(request),
        });
        if (result.kind === "unavailable") {
          // As the sign-in's start logs it; the next start tries again.
          request.log.warn({ err: result.error }, "OIDC provider discovery failed");
          throw providerUnavailable();
        }
        isReauthenticated = result.isReauthenticated;
        void reply.setCookie(flowCookieName, result.flowCookie, oidcFlowCookieOptions(settings));
        return reply.status(201).send({ authorizationUrl: result.authorizationUrl.href });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (isReauthenticated) rateLimiters.signInPerEmail.reauthenticated(authentication.email);
        else rateLimiters.signInPerEmail.reauthenticationSettled(authentication.email, failure);
      }
    },
  );

  /**
   * Unlinks a provider (D21 decision 39): a DELETE of the identity, with a
   * body so the current password stays out of the URL. Limited and settled
   * as the link's start. The sessions are kept.
   */
  typed.delete(
    "/api/v1/auth/me/identities/:provider",
    {
      onRequest: rateLimiters.identityPerIp,
      preHandler: [authenticate, rateLimiters.signInPerEmail.reauthenticationPreHandler],
      schema: {
        params: IdentityParamsSchema,
        body: UnlinkIdentityRequestSchema,
        response: {
          204: noContent,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      let isReauthenticated = false;
      let failure: unknown;
      try {
        await service.unlink({
          providerId: request.params.provider,
          currentPassword: request.body.currentPassword,
          context: authentication.context,
          origin: requestOrigin(request),
        });
        isReauthenticated = true;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (isReauthenticated) rateLimiters.signInPerEmail.reauthenticated(authentication.email);
        else rateLimiters.signInPerEmail.reauthenticationSettled(authentication.email, failure);
      }
      return reply.status(204).send(null);
    },
  );
}
