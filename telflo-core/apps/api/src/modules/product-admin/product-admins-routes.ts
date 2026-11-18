import { ErrorResponseSchema, GrantProductAdminRequestSchema, ProductAdminSchema, ProductAdminsResponseSchema } from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RateLimiters } from "../../http/rate-limits.js";
import { createProductAdminsService } from "./product-admins-service.js";
import { createSystemRepository } from "./repositories/system-repository.js";
import {
  noContent,
  noStore,
  PRODUCT_ADMIN_ROUTE_PREFIX,
  productAdminActorOf,
  productAdminGate,
  UserIdParamsSchema,
  type ProductAdminRoutesDependencies,
} from "./routing.js";

/*
 * Product admins (D29 decisions 5, 27 and 28; Task 3):
 *
 *   * `GET /api/v1/product-admin/product-admins`: `{ items: [{ id, email }] }`,
 *     by email (SystemRepository.listProductAdmins).
 *   * `POST /api/v1/product-admin/product-admins` `{ email }`: 201 `{ id,
 *     email }` on a grant, 200 when already one; 404
 *     `product_admin_target_not_found`; 403 `product_admin_required` when
 *     the caller lost the flag meanwhile.
 *   * `DELETE /api/v1/product-admin/product-admins/:userId`: 204; 404
 *     `product_admin_not_found`; 409 `last_product_admin`; 403
 *     `product_admin_required` when the caller lost the flag meanwhile.
 *   * Writes: 30 a minute per product admin (`productAdminWritesPerUser`,
 *     shared with feedback's acknowledge and dismiss).
 *
 * The answers are product-admins-service.ts's; the audit rows the
 * SystemRepository's (decision 20).
 */
export function registerProductAdminsRoutes(
  server: FastifyInstance,
  deps: ProductAdminRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "productAdminWritesPerUser">,
): void {
  const gate = productAdminGate(deps);
  const service = createProductAdminsService({
    system: createSystemRepository(deps.db),
    now: deps.now,
    countWrite: (userId) => rateLimiters.productAdminWritesPerUser(userId),
  });
  const typed = server.withTypeProvider<ZodTypeProvider>();
  const route = `${PRODUCT_ADMIN_ROUTE_PREFIX}/product-admins`;

  typed.get(
    route,
    {
      preHandler: gate,
      onSend: noStore,
      schema: { response: { 200: ProductAdminsResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema } },
    },
    async (request) => ({ items: await service.list(productAdminActorOf(request)) }),
  );

  typed.post(
    route,
    {
      preHandler: gate,
      onSend: noStore,
      schema: {
        body: GrantProductAdminRequestSchema,
        response: {
          200: ProductAdminSchema,
          201: ProductAdminSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { status, admin } = await service.grant(productAdminActorOf(request), request.body.email);
      return reply.status(status).send(admin);
    },
  );

  typed.delete(
    `${route}/:userId`,
    {
      preHandler: gate,
      onSend: noStore,
      schema: {
        params: UserIdParamsSchema,
        response: {
          204: noContent,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await service.revoke(productAdminActorOf(request), request.params.userId);
      return reply.status(204).send(null);
    },
  );
}
