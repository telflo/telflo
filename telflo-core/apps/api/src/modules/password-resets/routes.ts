import {
  AcceptedResponseSchema,
  ErrorResponseSchema,
  PasswordResetRequestSchema,
  PasswordResetSchema,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerDependencies } from "../../dependencies.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createUserRepository } from "../identity/repositories/user-repository.js";
import { clearSessionCookies } from "../sessions/cookies.js";
import { createSessionRepository } from "../sessions/repositories/session-repository.js";
import { createPasswordResetTokenRepository } from "./repositories/password-reset-token-repository.js";
import { createPasswordResetService, type WithPasswordResetTransaction } from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface PasswordResetRoutesDependencies extends ServerDependencies {
  now: () => Date;
  runAfterResponse: RunAfterResponse;
}

/** 204 carries no body; Fastify drops the payload for it. */
const noContent = z.null();

/** Where a request came from, for the audit trail. */
function requestOrigin(request: FastifyRequest): { ipAddress: string | undefined; userAgent: string | undefined } {
  return { ipAddress: clientIpForAudit(request.ip), userAgent: auditUserAgent(request) };
}

/**
 * D3 decision 1's reset endpoints. Neither is authenticated.
 *
 * The validator/serializer compilers are server-wide and set once in
 * buildServer, not here.
 */
export function registerPasswordResetRoutes(
  server: FastifyInstance,
  deps: PasswordResetRoutesDependencies,
  rateLimiters: RateLimiters,
): void {
  const { settings, db, now, runAfterResponse } = deps;
  // Every repository bound to one transaction (D3 decision 5). The user
  // repository is handed out as its one transaction-safe method only: see
  // PasswordResetTransaction.
  const withTransaction: WithPasswordResetTransaction = (work) =>
    db.transaction().execute((transaction) =>
      work({
        users: createUserRepository(transaction),
        passwordResetTokens: createPasswordResetTokenRepository(transaction),
        sessions: createSessionRepository(transaction),
      }),
    );
  const service = createPasswordResetService({
    users: createUserRepository(db),
    audit: createAuditRepository(db),
    mailer: deps.mailer,
    settings,
    now,
    withTransaction,
  });

  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/v1/auth/password-reset-requests",
    {
      // The shared per-IP bucket (D2a decision 9), then the per-address
      // limit, which needs the validated body (D3 decision 6).
      onRequest: rateLimiters.identityPerIp,
      preHandler: rateLimiters.emailPerAddress,
      schema: {
        body: PasswordResetRequestSchema,
        response: { 202: AcceptedResponseSchema, 400: ErrorResponseSchema, 429: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      // Nothing the response waits for may depend on the address (D3
      // decision 2): the lookup, the token and the email all happen after it.
      // Do not await the work here.
      const input = { email: request.body.email, ...requestOrigin(request) };
      runAfterResponse(() => service.requestReset(input));
      return reply.status(202).send({ status: "accepted" });
    },
  );

  typed.post(
    "/api/v1/auth/password-resets",
    {
      onRequest: rateLimiters.identityPerIp,
      schema: {
        body: PasswordResetSchema,
        response: { 204: noContent, 400: ErrorResponseSchema, 429: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const reset = await service.completeReset({ ...request.body, ...requestOrigin(request) });
      // The user signs in again with the new password, so a lockout earned
      // by guessing the old one must not stand in the way (D3 decision 5).
      rateLimiters.signInPerEmail.succeeded(reset.email);
      // Every session was revoked; this browser drops its dead pair.
      clearSessionCookies(reply, settings);
      return reply.status(204).send(null);
    },
  );
}
