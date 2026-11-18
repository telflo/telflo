import type { FastifyInstance } from "fastify";
import type { RateLimiters } from "../../http/rate-limits.js";
import type { PublicApiArea, PublicApiRoutesDependencies } from "./area.js";
import {
  createApiTokenOrganizationCheck,
  createApiTokenStore,
  createAuthenticateApiToken,
  decorateApiTokenAuthentication,
} from "./authenticate-api-token.js";
import { registerConfigurationPublicRoutes } from "./configurations/routes.js";
import { registerFleetPublicRoutes } from "./fleets/routes.js";
import { registerFlowPublicRoutes } from "./flows/routes.js";
import { createOpenRoutesPlugin } from "./open-routes.js";
import { registerOrganizationPublicRoutes } from "./organizations/routes.js";
import { registerOttlPublicRoutes } from "./ottl/routes.js";
import { createPublicApiPlugin, PUBLIC_API_PREFIX, type RecordedPublicRoute } from "./plugin.js";
import { registerTestRunPublicRoutes } from "./test-runs/routes.js";
import { registerValidatePublicRoutes } from "./validate/routes.js";
import { registerValidationPipelinePublicRoutes } from "./validation-pipelines/routes.js";

export type { PublicApiRoutesDependencies } from "./area.js";

/*
 * The public surface, `/api/public/v1/` (D22 decision 33, D25 decisions 13
 * and 16; api.md's second surface): the API's own, for the CLI, CI and
 * servers holding a `tf_` token. One encapsulated plugin (plugin.ts) owns
 * the prefix: its `onRequest` runs the token check, the per-token limit and
 * the access check before any body is read, and each area registers its
 * routes into it (`<area>/routes.ts`), every one declaring
 * `config.access`; between the count and the access, a personal token's
 * organization (X-Telflo-Org) is checked. No route calls `authenticate` or
 * `requireCurrentTerms` (decision 35). The open routes, /health, /openapi.json, the reference
 * page and D27's anonymous validate, are a sibling plugin with the same prefix and none of its
 * hooks (open-routes.ts); the anonymous validate gets the validation service and its own limits.
 *
 * CORS lists no `authorization` header (server.ts), so a cross-origin
 * browser page can't call it; the CSRF guard leaves it alone (outside
 * `/api/v1/`); the gateway's `location /api/` routes it, its access log
 * redacting any `tf_` in a URL (decision 40); the request log drops every
 * public path's query (D25 decision 47).
 */

/** The areas, in registration order (decision 17's table). */
const PUBLIC_API_AREAS: readonly PublicApiArea[] = [
  registerOrganizationPublicRoutes,
  registerConfigurationPublicRoutes,
  registerValidationPipelinePublicRoutes,
  registerValidatePublicRoutes,
  registerOttlPublicRoutes,
  registerFleetPublicRoutes,
  registerFlowPublicRoutes,
  registerTestRunPublicRoutes,
];

/** Each server's public routes as they registered, for the OpenAPI document's coverage test. */
const registeredRoutes = new WeakMap<FastifyInstance, RecordedPublicRoute[]>();

/** The public routes `server` registered (the plugin's and the open ones, HEAD's included), once it is ready. */
export function publicApiRoutesOf(server: FastifyInstance): readonly RecordedPublicRoute[] {
  return registeredRoutes.get(server) ?? [];
}

export function registerPublicApiRoutes(
  server: FastifyInstance,
  deps: PublicApiRoutesDependencies,
  rateLimiters: RateLimiters,
): void {
  const { db, now } = deps;
  // On the root, once (Preflight ruling 3): the request property's shape.
  decorateApiTokenAuthentication(server);
  const recorded: RecordedPublicRoute[] = [];
  registeredRoutes.set(server, recorded);
  const record = (route: RecordedPublicRoute) => void recorded.push(route);

  void server.register(
    createOpenRoutesPlugin(record, {
      anonymousValidate: deps.settings.site.anonymousValidate,
      validation: deps.services.configurations.validation,
      anonymousValidationLimiter: rateLimiters.anonymousValidations,
    }),
    { prefix: PUBLIC_API_PREFIX },
  );
  const store = createApiTokenStore(db);
  void server.register(
    createPublicApiPlugin({
      check: createAuthenticateApiToken({ store, failures: rateLimiters.apiTokenFailuresPerIp, now }),
      organization: createApiTokenOrganizationCheck({ store }),
      perToken: rateLimiters.publicApiPerToken,
      record,
      routes: (api) => {
        for (const area of PUBLIC_API_AREAS) area(api, { deps, rateLimiters });
      },
    }),
    { prefix: PUBLIC_API_PREFIX },
  );
}
