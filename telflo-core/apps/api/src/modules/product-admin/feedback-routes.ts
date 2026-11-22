import {
  AcknowledgeFeedbackRequestSchema,
  ErrorResponseSchema,
  ListUserFeedbackQuerySchema,
  PendingFeedbackCountSchema,
  UserFeedbackPageSchema,
} from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { notFoundWhen } from "../../http/not-found-when.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createFeedbackAdminService } from "./feedback-admin-service.js";
import { createSystemRepository } from "./repositories/system-repository.js";
import {
  FeedbackIdParamsSchema,
  noContent,
  noStore,
  PRODUCT_ADMIN_ROUTE_PREFIX,
  productAdminActorOf,
  productAdminGate,
  type ProductAdminRoutesDependencies,
} from "./routing.js";

/*
 * User Feedback for product admins:
 *
 *   * `GET /api/v1/product-admin/feedback?cursor=`: the pending items,
 *     newest first, 25 a page (USER_FEEDBACK_PAGE_SIZE), with the sender's
 *     current email and `authorDeleted` (SystemRepository.listFeedback).
 *   * `GET /api/v1/product-admin/feedback/pending-count`: `{ count }`
 *     (SystemRepository.countPendingFeedback, not audited).
 *   * `POST /api/v1/product-admin/feedback/:id/acknowledge` `{ reply }`: 204,
 *     the reply emailed to the sender after the response, never stored;
 *     409 `feedback_author_deleted`.
 *   * `POST /api/v1/product-admin/feedback/:id/dismiss`: 204, no email.
 *   * Either: 404 `feedback_not_found` (missing or handled); 403
 *     `product_admin_required` when the caller lost the flag meanwhile; 30
 *     a minute per product admin (`productAdminWritesPerUser`).
 *
 * Every one answers as a path nothing serves (404 not_found) while
 * TELFLO_USER_FEEDBACK is off, the open source's default.
 *
 * The service does the work: feedback-admin-service.ts.
 */
export function registerProductAdminFeedbackRoutes(
  server: FastifyInstance,
  deps: ProductAdminRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "productAdminWritesPerUser">,
): void {
  const service = createFeedbackAdminService({
    system: createSystemRepository(deps.db),
    mailer: deps.mailer,
    runAfterResponse: deps.runAfterResponse,
    log: server.log,
    now: deps.now,
    countWrite: (userId) => rateLimiters.productAdminWritesPerUser(userId),
  });
  const gate = productAdminGate(deps);
  const typed = server.withTypeProvider<ZodTypeProvider>();
  // The feedback's switch (TELFLO_USER_FEEDBACK): first in every route's onRequest.
  const userFeedbackOff = notFoundWhen(!deps.settings.site.userFeedback);
  const route = `${PRODUCT_ADMIN_ROUTE_PREFIX}/feedback`;
  const writeResponses = {
    204: noContent,
    400: ErrorResponseSchema,
    401: ErrorResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
    409: ErrorResponseSchema,
    429: ErrorResponseSchema,
  };

  typed.get(
    route,
    {
      onRequest: userFeedbackOff,
      preHandler: gate,
      onSend: noStore,
      schema: {
        querystring: ListUserFeedbackQuerySchema,
        response: { 200: UserFeedbackPageSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (request) => service.list(productAdminActorOf(request), request.query.cursor),
  );

  typed.get(
    `${route}/pending-count`,
    {
      onRequest: userFeedbackOff,
      preHandler: gate,
      onSend: noStore,
      schema: { response: { 200: PendingFeedbackCountSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema } },
    },
    async (request) => ({ count: await service.pendingCount(productAdminActorOf(request)) }),
  );

  typed.post(
    `${route}/:id/acknowledge`,
    {
      onRequest: userFeedbackOff,
      preHandler: gate,
      onSend: noStore,
      schema: { params: FeedbackIdParamsSchema, body: AcknowledgeFeedbackRequestSchema, response: writeResponses },
    },
    async (request, reply) => {
      await service.acknowledge(productAdminActorOf(request), request.params.id, request.body.reply);
      return reply.status(204).send(null);
    },
  );

  typed.post(
    `${route}/:id/dismiss`,
    {
      onRequest: userFeedbackOff,
      preHandler: gate,
      onSend: noStore,
      schema: { params: FeedbackIdParamsSchema, response: writeResponses },
    },
    async (request, reply) => {
      await service.dismiss(productAdminActorOf(request), request.params.id);
      return reply.status(204).send(null);
    },
  );
}
