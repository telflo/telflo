import { CreateFeedbackRequestSchema, CreateFeedbackResponseSchema, ErrorResponseSchema } from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { auditUserAgent } from "../../http/audit-user-agent.js";
import { clientIpForAudit } from "../../http/client-ip.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import type { ProductAdminRoutesDependencies } from "../product-admin/routing.js";
import { createAuthenticate, requireAuthentication, requireCurrentTerms } from "../sessions/authenticate.js";
import { createDatabaseSessionService } from "../sessions/routes.js";
import { createFeedbackService } from "./service.js";

/*
 * "Contact us": `POST /api/v1/feedback` `{ text }` for any signed-in
 * person with the current terms (`[authenticate, requireCurrentTerms]`,
 * as any member route; CSRF is global), in their active organization: 201
 * `{ id }`. The text trimmed, 1 to 5,000 characters; 10 an hour per
 * person (`feedbackPerUser`, 429 with Retry-After). Writes the row (the
 * id from `select uuidv7()`, no RETURNING: the API's role may only
 * insert) and `feedback.created` in the person's organization, then
 * emails every product admin after the response (the sender's email,
 * never the text). The recipients' query lives in this module's
 * repository alone (a test pins it). The limit counts after validation
 * and the guards.
 */
export function registerFeedbackRoutes(
  server: FastifyInstance,
  deps: ProductAdminRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "feedbackPerUser">,
): void {
  const service = createFeedbackService({
    db: deps.db,
    mailer: deps.mailer,
    runAfterResponse: deps.runAfterResponse,
    log: server.log,
    now: deps.now,
    publicWebUrl: deps.settings.publicWebUrl,
    countFeedback: (userId) => rateLimiters.feedbackPerUser(userId),
  });
  const authenticate = createAuthenticate(createDatabaseSessionService(deps).service);
  const typed = server.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/v1/feedback",
    {
      preHandler: [authenticate, requireCurrentTerms],
      schema: {
        body: CreateFeedbackRequestSchema,
        response: {
          201: CreateFeedbackResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const authentication = requireAuthentication(request);
      const id = await service.create(
        {
          context: authentication.context,
          email: authentication.email,
          ipAddress: clientIpForAudit(request.ip),
          userAgent: auditUserAgent(request),
        },
        request.body.text,
      );
      return reply.status(201).send({ id });
    },
  );
}
