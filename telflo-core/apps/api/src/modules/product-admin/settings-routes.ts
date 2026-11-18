import { ChangeProductAdminSettingsRequestSchema, ErrorResponseSchema, ProductAdminSettingsSchema } from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { RateLimiters } from "../../http/rate-limits.js";
import { readOrganizationCreation } from "../site-settings/organization-creation.js";
import { createSystemRepository } from "./repositories/system-repository.js";
import { noStore, PRODUCT_ADMIN_ROUTE_PREFIX, productAdminActorOf, productAdminGate, type ProductAdminRoutesDependencies } from "./routing.js";
import { createSettingsService } from "./settings-service.js";

/*
 * The site's settings (D36-1 decision 51; Q252, Ruling 359):
 *
 *   * `GET /api/v1/product-admin/settings`: `{ organizationCreation }`,
 *     `everyone` or `product-admins`.
 *   * `PATCH /api/v1/product-admin/settings` `{ organizationCreation }`:
 *     200 with the settings, changed or already so (each audited); 403
 *     `product_admin_required` when the caller lost the flag meanwhile.
 *   * Both behind `[authenticate, requireProductAdmin]`, as every
 *     product-admin route (403 `product_admin_required` to anyone else);
 *     `Cache-Control: no-store`; the write counts against
 *     `productAdminWritesPerUser`.
 */
export function registerProductAdminSettingsRoutes(
  server: FastifyInstance,
  deps: ProductAdminRoutesDependencies,
  rateLimiters: Pick<RateLimiters, "productAdminWritesPerUser">,
): void {
  const gate = productAdminGate(deps);
  const service = createSettingsService({
    system: createSystemRepository(deps.db),
    readOrganizationCreation: () => readOrganizationCreation(deps.db),
    countWrite: (userId) => rateLimiters.productAdminWritesPerUser(userId),
  });
  const typed = server.withTypeProvider<ZodTypeProvider>();
  const route = `${PRODUCT_ADMIN_ROUTE_PREFIX}/settings`;

  typed.get(
    route,
    {
      preHandler: gate,
      onSend: noStore,
      schema: { response: { 200: ProductAdminSettingsSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema } },
    },
    async () => service.read(),
  );

  typed.patch(
    route,
    {
      preHandler: gate,
      onSend: noStore,
      schema: {
        body: ChangeProductAdminSettingsRequestSchema,
        response: {
          200: ProductAdminSettingsSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          429: ErrorResponseSchema,
        },
      },
    },
    async (request) => service.change(productAdminActorOf(request), request.body),
  );
}
