import { AcceptedResponseSchema, ErrorResponseSchema, SalesInquiryRequestSchema } from "@telflo/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDependencies } from "../../dependencies.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import { notFoundWhen } from "../../http/not-found-when.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createAuditRepository } from "../identity/repositories/audit-repository.js";
import { createSalesInquiryService } from "./service.js";
import { auditUserAgent } from "../../http/audit-user-agent.js";

/**
 * The honeypot: a filled `website` is answered with 202 and nothing is sent
 * or audited. A `preValidation` hook, so the parsed body is at hand but not
 * yet validated: a bot gets the same 202 even for a body the schema would
 * refuse.
 */
async function honeypot(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const website = (request.body as { website?: unknown } | undefined)?.website;
  if (typeof website === "string" && website.trim().length > 0) {
    // Returning the reply ends the request here: no validation, no handler.
    return reply.status(202).send({ status: "accepted" });
  }
  return undefined;
}

/**
 * The contact form endpoint. No session is needed; the CSRF header is, as on
 * every POST under `/api/v1/`.
 *
 * Switched: with TELFLO_SALES_INQUIRY off, the open source's default, it
 * answers as a path nothing serves (404 `not_found`), before the
 * per-address limit counts it. On, TELFLO_SALES_INQUIRY_TO is required (the
 * settings refuse to start without it), and it is where every inquiry goes.
 *
 * The validator/serializer compilers are server-wide and set once in
 * buildServer, not here.
 */
export function registerSalesInquiryRoutes(
  server: FastifyInstance,
  deps: ServerDependencies,
  rateLimiters: RateLimiters,
): void {
  const service = createSalesInquiryService({
    audit: createAuditRepository(deps.db),
    mailer: deps.mailer,
    recipient: deps.settings.salesInquiryTo,
    log: server.log,
  });

  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/v1/sales-inquiries",
    {
      // The switch first: off, nothing counts. Then its own per-IP bucket.
      // An `onRequest` hook, so it counts every request the CSRF guard lets
      // through: a honeypot or an invalid body too.
      onRequest: [notFoundWhen(!deps.settings.site.salesInquiry), rateLimiters.salesInquiriesPerIp],
      preValidation: honeypot,
      schema: {
        body: SalesInquiryRequestSchema,
        response: {
          202: AcceptedResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
          502: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await service.submit({
        name: request.body.name,
        email: request.body.email,
        message: request.body.message,
        ipAddress: clientIpForAudit(request.ip),
        userAgent: auditUserAgent(request),
      });
      return reply.status(202).send({ status: "accepted" });
    },
  );
}
