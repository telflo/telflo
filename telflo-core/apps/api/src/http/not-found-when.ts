import type { onRequestAsyncHookHandler } from "fastify";
import { sendNotFound } from "../errors.js";

/**
 * A switched-off route's gate: an `onRequest` hook, first in the route's
 * array, that answers exactly as a path no route serves does (`sendNotFound`:
 * 404 `not_found`, "No route for <method> <path>", the path as the request log
 * spells it) while `off`, so an install that doesn't offer the route shows no
 * trace of it. It runs before any per-address limit, the body's parsing and
 * its limit, and the handler; the routes stay registered (anonymous validate
 * stays on the open surface's allowlist). `off` is read once, from the
 * settings the server is built with: fixed per process. The global hooks (the
 * CSRF guard) still run first, as they do for an unknown path.
 */
export function notFoundWhen(off: boolean): onRequestAsyncHookHandler {
  return async (request, reply) => {
    if (!off) return;
    sendNotFound(request, reply);
    return reply;
  };
}
