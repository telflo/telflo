import type { ApiTokenAccess } from "@telflo/db";
import type { RouteOptions } from "fastify";
import { insufficientAccess } from "./errors.js";

/*
 * Read and write on the public surface (D25 decisions 13, 14 and 25;
 * Preflight ruling 3). Every route of the `/api/public/v1` plugin declares
 * `config.access`, and the plugin's `onRoute` hook refuses to register one
 * that doesn't, so no route can fail open: `ready()` rejects. After the
 * token check, a `write` route needs a `write` token; a read token answers
 * 403 `insufficient_access`.
 */

declare module "fastify" {
  interface FastifyContextConfig {
    /** What a public route needs of the token (D25 decision 13). Only the public plugin's routes set it. */
    access?: "read" | "write";
    /**
     * A public route a personal token may call without `X-Telflo-Org`
     * (D25 decision 24: `/whoami`, `/orgs`); a header that is sent is still
     * checked. Absent: the organization is required (D25 Task 6).
     */
    organization?: "optional";
  }
}

/** What a public route needs of the token. */
export type PublicRouteAccess = "read" | "write";

const ACCESSES: ReadonlySet<unknown> = new Set<PublicRouteAccess>(["read", "write"]);
const ORGANIZATION_OPTIONS: ReadonlySet<unknown> = new Set([undefined, "optional"]);

/**
 * The plugin's `onRoute` check: a route without a valid `config.access`, or
 * with an `organization` other than `"optional"`, throws, and the server's
 * `ready()` rejects with the route named (its method and path, never a
 * request's). Returns the route's access.
 */
export function assertDeclaredAccess(route: Pick<RouteOptions, "method" | "url" | "config">): PublicRouteAccess {
  const config = (route.config ?? {}) as { access?: unknown; organization?: unknown };
  const name = `${String(route.method)} ${route.url}`;
  if (!ACCESSES.has(config.access)) {
    throw new Error(`a public route must declare config.access "read" or "write": ${name}`);
  }
  if (!ORGANIZATION_OPTIONS.has(config.organization)) {
    throw new Error(`a public route's config.organization may only be "optional": ${name}`);
  }
  return config.access as PublicRouteAccess;
}

/**
 * The check after the token's (decision 25): `needed` is the matched
 * route's `config.access`. A `write` route refuses a `read` token with 403
 * `insufficient_access`. A route that reached here without an access
 * (which `assertDeclaredAccess` makes impossible) fails closed, as a
 * server error.
 */
export function assertAccess(needed: unknown, granted: ApiTokenAccess): void {
  if (needed === "read") return;
  if (needed === "write") {
    if (granted !== "write") throw insufficientAccess();
    return;
  }
  throw new Error("a public route without config.access was matched");
}
