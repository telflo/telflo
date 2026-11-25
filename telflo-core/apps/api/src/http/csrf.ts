import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, type SessionErrorCode } from "@telflo/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { isPublicPath } from "./public-path.js";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** The public surface's routes, as registered (the matched route's pattern, never a spelling of it). */
const PUBLIC_ROUTE_PREFIX = "/api/public/v1/";

/**
 * Session cookies are sent by the browser on any request to this origin,
 * including one a hostile page triggers. A cross-site form cannot set a
 * custom header, and a cross-site `fetch` that sets one needs a preflight
 * that CORS refuses, so requiring the header on every state-changing request
 * means only our own clients can make one.
 *
 * Every state-changing request needs it but the public surface's,
 * `/api/public/v1/*`, which takes a service account's bearer `tf_` token and
 * no cookie (a browser never attaches a bearer on its own). Which surface a
 * request is on is read from the route the router matched, never from the
 * raw URL: the router percent-decodes a path before matching it, so
 * `/%61pi/v1/…` reaches the same cookie route as `/api/v1/…`. A request no
 * route matched is the public surface's only when http/public-path.ts's
 * normalizer puts it there (so its own 404 answers); any other gets 403, not
 * a 404 that would map the API.
 *
 * An `onRequest` hook, so it runs before body parsing, validation and every
 * route handler, and also before the not-found handler.
 */
export function registerCsrfGuard(server: FastifyInstance): void {
  server.addHook("onRequest", async (request) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return;
    if (request.headers[CSRF_HEADER_NAME] === CSRF_HEADER_VALUE) return;
    if (isPublicSurface(request)) return;
    throw new AppError("csrf_header_missing" satisfies SessionErrorCode, "This request is missing a required header.", 403);
  });
}

function isPublicSurface(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined) return route.startsWith(PUBLIC_ROUTE_PREFIX);
  return isPublicPath(request.url);
}
