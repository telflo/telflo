import { AdminUsersPageSchema, ErrorResponseSchema, ListAdminUsersQuerySchema } from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { notFoundWhen } from "../../http/not-found-when.js";
import type { RateLimiters } from "../../http/rate-limits.js";
import { canonicalIdOf } from "../organizations/service.js";
import { userNotFound } from "./errors.js";
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
import { createUsersService } from "./users-service.js";

/*
 * Users:
 *
 *   * `GET /api/v1/product-admin/users?q=&cursor=`: every live person,
 *     newest first, 50 a page (ADMIN_USERS_PAGE_SIZE), searched by email or
 *     organization name, each with what blocks their delete; through
 *     SystemRepository.listUsers (audited `product_admin.users_listed`).
 *   * `DELETE /api/v1/product-admin/users/:userId`: 204; 404
 *     `user_not_found`; 409 `user_delete_blocked` (`details: { kind }`),
 *     `user_delete_self`, `user_delete_busy`; 403 `product_admin_required`
 *     when the caller lost the flag meanwhile; 10 a minute per product
 *     admin (`productAdminDeletesPerUser`).
 *
 * Both through users-service.ts, and both answer as a path nothing serves
 * (404 not_found) while TELFLO_USER_ADMIN is off, the open source's default. The delete's limit is counted after the gate,
 * the path's schema and canonicalIdOf (a non-canonical id is 404 and counts
 * nothing), before the database is asked, so an unknown person's 404 counts.
 * The search's term reaches the database only: the request log drops the query
 * of every product-admin route.
 */
export function registerProductAdminUsersRoutes(
  server: FastifyInstance,
  deps: ProductAdminRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "productAdminDeletesPerUser">,
): void {
  const gate = productAdminGate(deps);
  const service = createUsersService({
    systemRepository: createSystemRepository(deps.db),
    now: deps.now,
    opampRegistration: deps.opampRegistration,
    fileStore: deps.fileStore,
    log: server.log,
  });
  const typed = server.withTypeProvider<ZodTypeProvider>();
  // Users' switch (TELFLO_USER_ADMIN): first in every route's onRequest.
  const userAdminOff = notFoundWhen(!deps.settings.site.userAdmin);

  typed.get(
    `${PRODUCT_ADMIN_ROUTE_PREFIX}/users`,
    {
      onRequest: userAdminOff,
      preHandler: gate,
      onSend: noStore,
      schema: {
        querystring: ListAdminUsersQuerySchema,
        response: { 200: AdminUsersPageSchema, 400: ErrorResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (request) => service.list(productAdminActorOf(request), { q: request.query.q, cursor: request.query.cursor }),
  );

  typed.delete(
    `${PRODUCT_ADMIN_ROUTE_PREFIX}/users/:userId`,
    {
      onRequest: userAdminOff,
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
      const actor = productAdminActorOf(request);
      const userId = canonicalIdOf(request.params.userId);
      if (userId === undefined) throw userNotFound();
      rateLimiters.productAdminDeletesPerUser(actor.userId);
      await service.delete(actor, userId);
      return reply.status(204).send(null);
    },
  );
}
