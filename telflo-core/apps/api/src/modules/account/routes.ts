import {
  ApiTokensResponseSchema,
  ChangePasswordRequestSchema,
  CreateApiTokenRequestSchema,
  CreatedApiTokenResponseSchema,
  ErrorResponseSchema,
  UpdateUserPreferencesRequestSchema,
  UserPreferencesSchema,
  type ApiToken as ApiTokenResponseBody,
} from "@telflo/contracts";
import type { Database } from "@telflo/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { z } from "zod";
import { withAuthContext } from "../../database/context.js";
import type { ServerDependencies } from "../../dependencies.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createUserRepository } from "../identity/repositories/user-repository.js";
import { actorOf } from "../organizations/routes.js";
import { createPasswordResetTokenRepository } from "../password-resets/repositories/password-reset-token-repository.js";
import { createAuthenticate, requireAuthentication } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import {
  createPersonalApiTokenService,
  type IPersonalApiTokenService,
  type ListedPersonalApiToken,
  type WithPersonalApiTokenTransaction,
} from "./personal-api-tokens.js";
import { createPersonalApiTokenRepository } from "./repositories/personal-api-token-repository.js";
import { createUserSettingsRepository } from "./repositories/user-settings-repository.js";
import { createAccountService, type WithAccountTransaction } from "./service.js";
import { setThemeCookie } from "./theme-cookie.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface AccountRoutesDependencies extends ServerDependencies {
  now: () => Date;
  /** Required, as the password-reset routes': the security emails go after the response. */
  runAfterResponse: RunAfterResponse;
}

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Where a request came from, for the audit trail. */
function requestOrigin(request: FastifyRequest): { ipAddress: string | undefined; userAgent: string | undefined } {
  return { ipAddress: clientIpForAudit(request.ip), userAgent: auditUserAgent(request) };
}

/** The session's 401 and the contract's 400; no terms check, no limit, so no 403 or 429. */
const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
};

/**
 * Any string: an id that isn't a canonical uuid names no token, and gets
 * the service's 404 api_token_not_found, as an unknown one does.
 */
const PersonalApiTokenParamsSchema = z.object({ tokenId: z.string() });

/** The create's reply carries the token: no cache, the browser's or a proxy's, may keep it. */
const NO_STORE = "no-store";

/** A token as listed: its prefix, never the token or its hash; the person stays in the API. */
function toApiTokenResponseBody(token: ListedPersonalApiToken): ApiTokenResponseBody {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    access: token.access,
    expiresAt: token.expiresAt === null ? null : token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt === null ? null : token.lastUsedAt.toISOString(),
    createdAt: token.createdAt.toISOString(),
    isExpired: token.isExpired,
  };
}

/**
 * A person's own tokens' service over the API's database: each unit of
 * work one transaction in the session's context (the person and their
 * active organization), which personal_api_tokens' row-level security reads
 * by the person only.
 */
export function createDatabasePersonalApiTokenService(db: Kysely<Database>, now: () => Date): IPersonalApiTokenService {
  const withTransaction: WithPersonalApiTokenTransaction = (context, work) =>
    withAuthContext(db, context, (transaction) =>
      work({
        users: createUserRepository(transaction),
        tokens: createPersonalApiTokenRepository(transaction),
        audit: createAuditRepository(transaction),
      }),
    );
  return createPersonalApiTokenService({ withTransaction, now });
}

/**
 * The account's own routes, under `/api/v1/auth/me` beside the terms
 * acceptance. They run `authenticate` only, never `requireCurrentTerms`: they
 * are the person's own, like `/me`, and the terms dialog blocks the shell
 * anyway. The person is always the session's user: no route takes a user id.
 *
 * Preferences aren't security events: no audit row, and no rate limit (a
 * session is needed).
 */
export function registerAccountRoutes(
  server: FastifyInstance,
  deps: AccountRoutesDependencies,
  rateLimiters: RateLimiters,
): void {
  const { settings, db, now, runAfterResponse } = deps;
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const userSettings = createUserSettingsRepository(db);
  // Every repository bound to one transaction; the user repository is handed
  // out as its transaction-safe methods only (AccountTransaction).
  const withTransaction: WithAccountTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({
        users: createUserRepository(transaction),
        passwordResetTokens: createPasswordResetTokenRepository(transaction),
        audit: createAuditRepository(transaction),
      }),
    );
  const account = createAccountService({
    users: createUserRepository(db),
    audit: createAuditRepository(db),
    withTransaction,
    mailer: deps.mailer,
    settings,
    now,
    runAfterResponse,
  });
  const personalApiTokens = createDatabasePersonalApiTokenService(db, now);
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/v1/auth/me/preferences",
    { preHandler: authenticate, schema: { response: { 200: UserPreferencesSchema, ...errorResponses } } },
    async (request, reply) => {
      const { userId } = requireAuthentication(request).context;
      return reply.send(await userSettings.find(userId));
    },
  );

  /**
   * Merges the change onto the stored preferences and answers the whole
   * preferences after it. A change carrying `theme` also sets `telflo_theme`
   * to the stored theme.
   */
  typed.patch(
    "/api/v1/auth/me/preferences",
    {
      preHandler: authenticate,
      schema: {
        body: UpdateUserPreferencesRequestSchema,
        response: { 200: UserPreferencesSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { userId } = requireAuthentication(request).context;
      const preferences = await userSettings.merge(userId, request.body, now());
      if (request.body.theme !== undefined) setThemeCookie(reply, settings, preferences.theme);
      return reply.send(preferences);
    },
  );

  /**
   * Changes the password with the current one, answering 204. The shared per-IP
   * bucket first (`identityPerIp`), then, once the session is known, sign-in's
   * per-email failure budget keyed by the session's address. Every session is
   * kept and no cookie is set or cleared. The request log carries no body, so
   * neither password.
   */
  typed.put(
    "/api/v1/auth/me/password",
    {
      onRequest: rateLimiters.identityPerIp,
      preHandler: [authenticate, rateLimiters.signInPerEmail.reauthenticationPreHandler],
      schema: {
        body: ChangePasswordRequestSchema,
        response: {
          204: noContent,
          ...errorResponses,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      // Settled exactly once, whatever happens: a success clears the
      // address; anything else keeps the count only for a wrong current
      // password.
      let isReauthenticated = false;
      let failure: unknown;
      try {
        await account.changePassword({
          context: authentication.context,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
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

  // A person's own API tokens: the person's only, never an organization's,
  // so no admin check and no organization in the path; `authenticate` only
  // (no terms), the CSRF guard on the writes. Not rate limited: the cap of 20
  // under the user's lock bounds a create.
  typed.get(
    "/api/v1/auth/me/api-tokens",
    { preHandler: authenticate, schema: { response: { 200: ApiTokensResponseSchema, ...errorResponses } } },
    async (request, reply) => {
      const tokens = await personalApiTokens.list(actorOf(request));
      return reply.send({ items: tokens.map(toApiTokenResponseBody) });
    },
  );

  // The one reply that carries a personal token: never logged (the request
  // log has no bodies), never cached.
  typed.post(
    "/api/v1/auth/me/api-tokens",
    {
      preHandler: authenticate,
      schema: {
        body: CreateApiTokenRequestSchema,
        response: { 201: CreatedApiTokenResponseSchema, ...errorResponses, 409: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const created = await personalApiTokens.create(actorOf(request), request.body);
      return reply
        .status(201)
        .header("cache-control", NO_STORE)
        .send({ apiToken: toApiTokenResponseBody(created.apiToken), token: created.token });
    },
  );

  // A revoke: the row stays, revoked, and its name is free. An already
  // revoked token, or another person's, is the one 404.
  typed.delete(
    "/api/v1/auth/me/api-tokens/:tokenId",
    {
      preHandler: authenticate,
      schema: {
        params: PersonalApiTokenParamsSchema,
        response: { 204: noContent, ...errorResponses, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      await personalApiTokens.revoke(actorOf(request), request.params.tokenId);
      return reply.status(204).send(null);
    },
  );
}
