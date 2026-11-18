import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, type SessionErrorCode } from "@telflo/contracts";
import type { FastifyInstance } from "fastify";
import { AppError } from "../errors.js";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GUARDED_PREFIX = "/api/v1/";

/**
 * D2a decision 6. Session cookies are sent by the browser on any request to
 * this origin, including one a hostile page triggers. A cross-site form
 * cannot set a custom header, and a cross-site `fetch` that sets one needs a
 * preflight that CORS refuses, so requiring the header on every
 * state-changing request under `/api/v1/` means only our own clients can make
 * one.
 *
 * `/health` and the public surface, `/api/public/v1/*` (D22), are outside
 * the prefix: the second takes a service account's bearer `tf_` token and
 * no cookie, and a browser never attaches a bearer on its own.
 *
 * An `onRequest` hook, so it runs before body parsing, validation and every
 * route handler, and also before the not-found handler: an unknown route
 * under the prefix gets 403, not a 404 that would map the API.
 */
export function registerCsrfGuard(server: FastifyInstance): void {
  server.addHook("onRequest", async (request) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return;
    if (!request.url.startsWith(GUARDED_PREFIX)) return;
    if (request.headers[CSRF_HEADER_NAME] === CSRF_HEADER_VALUE) return;
    throw new AppError("csrf_header_missing" satisfies SessionErrorCode, "This request is missing a required header.", 403);
  });
}
