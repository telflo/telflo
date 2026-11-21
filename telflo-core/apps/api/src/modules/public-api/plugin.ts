import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { sendNotFound } from "../../errors.js";
import type { PerKeyLimiter } from "../../http/rate-limits.js";
import { assertAccess, assertDeclaredAccess, type PublicRouteAccess } from "./access.js";
import { requireAcceptedApiToken, type ApiTokenCheck, type ApiTokenOrganizationCheck } from "./authenticate-api-token.js";
import { claimPublicSurface, methodsOf, publicNotFoundOptions } from "./route-guard.js";

/*
 * The public surface's plugin, registered encapsulated with the prefix
 * `/api/public/v1` by registerPublicApiRoutes (routes.ts). It holds:
 *   - an `onRoute` hook refusing a route without a valid `config.access`
 *     (access.ts), so `ready()` rejects and no route can fail open; it
 *     records each route for the OpenAPI document's coverage test;
 *   - an `onRequest` hook, run before any body is read or validated:
 *       1. the token check (authenticate-api-token.ts): every refusal the
 *          one 401;
 *       2. the per-token limit, `token:<tokenId>`, 60 a minute: counted
 *          once the check accepts the request, never on the raw bearer,
 *          and BEFORE a personal token's organization check;
 *       3. a personal token's organization, `X-Telflo-Org`, and the
 *          person's live membership there, read on every request:
 *          required unless the route declares `organization: "optional"`
 *          (`/whoami`, `/orgs`), where a header that is sent is still
 *          checked; a service account's token ignores it. An unknown path
 *          skips it (the 404 needs no organization);
 *       4. the route's access: a read token on a `write` route answers
 *          403 `insufficient_access`;
 *   - an `onSend` hook giving every reply without its own Cache-Control
 *     `no-store`;
 *   - its own not-found handler, which the `onRequest` hook runs before: an
 *     unknown public path answers the 401 to an unauthenticated caller and
 *     `404 not_found` (the root's words) only after the check, and a 404
 *     after the check counts against the token's limit.
 * No route under the prefix escapes it (route-guard.ts): the root's
 * verification answers the one 401 for a request under the prefix that
 * matched any route but this plugin's (or an allowed open route), and the
 * root's registration guard refuses such a route early.
 * The router's own refusals answer before any hook:
 * a malformed escape is 400 `invalid_request`, a path parameter over 100
 * characters 414 (errors.ts' respondToFrameworkError).
 */

export { methodsOf, PUBLIC_API_PREFIX } from "./route-guard.js";

/** A route of the public surface as registered: its method, its full URL (prefix and `:params`) and what it needs. */
export interface RecordedPublicRoute {
  method: string;
  url: string;
  /** `none` for the open routes (open-routes.ts), outside the check. */
  access: PublicRouteAccess | "none";
}

export interface PublicApiPluginOptions {
  /** The token check (createAuthenticateApiToken). */
  check: ApiTokenCheck;
  /** A personal token's organization check (createApiTokenOrganizationCheck), after the count. */
  organization: ApiTokenOrganizationCheck;
  /** The per-token count (RateLimiters' publicApiPerToken). */
  perToken: PerKeyLimiter;
  /** Told of each route as it is registered (HEAD's included). */
  record: (route: RecordedPublicRoute) => void;
  /** Registers the areas' routes into the plugin, after its hooks. */
  routes: (api: FastifyInstance) => void;
}

export function createPublicApiPlugin({ check, organization, perToken, record, routes }: PublicApiPluginOptions): FastifyPluginAsync {
  return async (api) => {
    // First: this plugin's routes (and its children's) are the public plugin's, verified for the root's guards (route-guard.ts).
    claimPublicSurface(api, "plugin");
    api.addHook("onRoute", (route) => {
      const access = assertDeclaredAccess(route);
      for (const method of methodsOf(route)) record({ method, url: route.url, access });
    });

    api.addHook("onRequest", async (request) => {
      await check(request);
      const accepted = requireAcceptedApiToken(request);
      perToken.count(`token:${accepted.tokenId}`);
      if (request.is404) return;
      const { config } = request.routeOptions;
      await organization(request, config.organization === "optional" ? "optional" : "required");
      assertAccess(config.access, accepted.access);
    });

    // Every reply here is kept by no cache unless its route set its own Cache-Control: the refusals (401,
    // 403, 404, 429, a 400) and the routes' replies alike, so no browser's disk cache keeps a try-it call's
    // URL and answer (the reference page's) and no proxy a token's reply.
    api.addHook("onSend", async (_request, reply, payload) => {
      if (!reply.hasHeader("cache-control")) void reply.header("cache-control", "no-store");
      return payload;
    });

    // Its own, marked for the root's verification: the only not-found handler that may answer under the prefix.
    api.setNotFoundHandler(publicNotFoundOptions(api), sendNotFound);

    routes(api);
  };
}
