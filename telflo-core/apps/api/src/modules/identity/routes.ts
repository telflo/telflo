import {
  AcceptedResponseSchema,
  ErrorResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  VerificationEmailRequestSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResponseSchema,
} from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { FastifyInstance } from "fastify";
import type { ServerDependencies } from "../../dependencies.js";
import type { RunAfterResponse } from "../../http/after-response.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import type { OpampRegistration } from "../organizations/opamp-registration.js";
import { createAuditRepository } from "./repositories/audit-repository.js";
import { registrationGate } from "./registration.js";
import { createIdentityService } from "./service.js";
import { createUserRepository } from "./repositories/user-repository.js";
import { createVerificationTokenRepository } from "./repositories/verification-token-repository.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

export interface IdentityRoutesDependencies extends ServerDependencies {
  now: () => Date;
  runAfterResponse: RunAfterResponse;
  opampRegistration: OpampRegistration;
}

// The validator/serializer compilers are server-wide and set once in
// buildServer, not here — see the comment there.
export function registerIdentityRoutes(
  server: FastifyInstance,
  deps: IdentityRoutesDependencies,
  rateLimiters: RateLimiters,
): void {
  const { runAfterResponse } = deps;
  const service = createIdentityService({
    users: createUserRepository(deps.db),
    verificationTokens: createVerificationTokenRepository(deps.db),
    audit: createAuditRepository(deps.db),
    mailer: deps.mailer,
    settings: deps.settings,
    now: deps.now,
    opampRegistration: deps.opampRegistration,
  });

  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/v1/auth/register",
    {
      // The registration mode's gate first (D36-1 decision 35, Preflight
      // ruling 4): invite-only and closed answer 403 registration_not_open
      // before anything else reads the request. Then the per-IP bucket
      // shared with sign-in (D2a decision 9).
      onRequest: [registrationGate(deps.settings.site.registration, "self"), rateLimiters.identityPerIp],
      schema: {
        body: RegisterRequestSchema,
        // 403: registration isn't open (D36-1 decision 35). 422: an address
        // at the service accounts' domain (D22 decision 23).
        response: {
          200: RegisterResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          422: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.registerUser({
        ...request.body,
        ipAddress: clientIpForAudit(request.ip),
        userAgent: auditUserAgent(request),
      });
      return reply.send(result);
    },
  );

  typed.post(
    "/api/v1/auth/verify-email",
    {
      // Shares one per-IP bucket with sign-in (D2a decision 9).
      onRequest: rateLimiters.identityPerIp,
      schema: {
        body: VerifyEmailRequestSchema,
        response: { 200: VerifyEmailResponseSchema, 400: ErrorResponseSchema, 429: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await service.verifyEmail({
        ...request.body,
        ipAddress: clientIpForAudit(request.ip),
        userAgent: auditUserAgent(request),
      });
      return reply.send(result);
    },
  );

  typed.post(
    "/api/v1/auth/verification-emails",
    {
      // The shared per-IP bucket (D2a decision 9), then the per-address
      // limit, which needs the validated body. It is the same limiter
      // instance as the reset-request route's, so the two share one budget
      // per address (D3 decision 6).
      onRequest: rateLimiters.identityPerIp,
      preHandler: rateLimiters.emailPerAddress,
      schema: {
        body: VerificationEmailRequestSchema,
        response: { 202: AcceptedResponseSchema, 400: ErrorResponseSchema, 429: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      // Nothing the response waits for may depend on the address (D3
      // decision 2): the lookup, the token and the email all happen after it.
      // Do not await the work here.
      const input = {
        email: request.body.email,
        ipAddress: clientIpForAudit(request.ip),
        userAgent: auditUserAgent(request),
      };
      runAfterResponse(() => service.resendVerification(input));
      return reply.status(202).send({ status: "accepted" });
    },
  );
}
