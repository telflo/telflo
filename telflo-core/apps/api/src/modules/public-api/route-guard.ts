import type { FastifyInstance, RouteOptions } from "fastify";
import { AppError } from "../../errors.js";
import { isPublicPath } from "../../http/public-path.js";
import { invalidApiToken } from "./errors.js";

/*
 * The public surface's invariant (D25 decision 13; Rulings 163 and 164): no
 * request under `/api/public/v1`, in any spelling, is answered by a route
 * that escapes the public plugin's checks. Two guards, both added first
 * thing in buildServer:
 *
 *   - THE VERIFICATION, at request time (the guarantee, Ruling 164): a root
 *     `onRequest` hook, run before every other hook. A request whose path,
 *     normalized by http/public-path.ts (absolute form stripped, decoded
 *     until stable, slashes collapsed, dot segments resolved; the request
 *     log's normalizer too, Ruling 173), is under the prefix must have matched
 *     a route the public plugin's own `onRoute` hook verified, or one the
 *     open routes' plugin verified on OPEN_PUBLIC_ROUTES, or the root's
 *     CORS preflight (`OPTIONS *`, Ruling 163: exempt by its method and
 *     URL; @fastify/cors is its only registrant, and the router holds one
 *     route per method and URL). The verification is a
 *     private symbol on the route's config holding a private token, which
 *     Fastify copies into the route's context; a token is good only for
 *     the method and URL it was made for. A request no route matched
 *     passes only to the public plugin's OWN not-found handler (Ruling
 *     166), which answers after its token check: its config holds a private
 *     token too (publicNotFoundOptions), and any other not-found handler
 *     (the root's, or one a plugin with a deeper prefix set) is refused.
 *     Anything else answers the one 401 and logs a warn naming the route's
 *     pattern, never the request's URL. So a root route with a parameter or
 *     a wildcard (`/api/:x/v1/…`, `/api/*`) can never answer a public path.
 *   - THE REGISTRATION GUARD (an early failure, not the guarantee): a root
 *     `onRoute` hook refusing, with a throw so `ready()` rejects, a route
 *     whose URL could match a public path (isUnderPublicPrefix, segment by
 *     segment, a parameter or a wildcard matching too) unless it is the
 *     public plugin's, an open route on the allowlist, or the CORS
 *     preflight.
 *
 * The two plugins claim their surface with claimPublicSurface, which only
 * plugin.ts and open-routes.ts call (context-source.test.ts pins it): it
 * refuses an instance that already holds a surface (its own or a parent's:
 * a decoration is inherited), so no plugin under one can change it, and
 * the decoration's symbol is this file's alone. setNotFoundHandler is
 * called only in errors.ts (the root's) and plugin.ts (context-source.test.ts
 * pins both).
 */

/** The public surface's prefix (D22 decision 33). */
export const PUBLIC_API_PREFIX = "/api/public/v1";

/** The prefix's segments, lower case. */
const PREFIX_SEGMENTS = ["api", "public", "v1"] as const;

/** Each method a route answers, as `onRoute` sees it. */
export function methodsOf(route: Pick<RouteOptions, "method">): string[] {
  return Array.isArray(route.method) ? route.method.map(String) : [String(route.method)];
}

/** Which of the two public plugins an instance (or a plugin under it) is. */
type PublicSurface = "plugin" | "open";

const SURFACE = Symbol("telflo.publicApiSurface");

/** Where a verified route's config holds its token. Fastify copies the config, symbol keys included, into the route's context. */
const VERIFIED = Symbol("telflo.publicApiVerifiedRoute");

/** Each token the two plugins' `onRoute` made, with the `METHOD url`s it is good for. */
const verifiedTokens = new WeakMap<object, ReadonlySet<string>>();

/** Where the public plugin's not-found handler's config holds its token (Ruling 166). */
const PUBLIC_NOT_FOUND = Symbol("telflo.publicApiNotFound");

/** The public plugin's not-found handlers' tokens. */
const publicNotFoundTokens = new WeakSet<object>();

/**
 * The open routes, `METHOD path` exactly (Ruling 163): /health, the
 * document, and the reference page's routes D25 Task 7 adds (`/docs`, its
 * redirect, and `/docs/*`, the page and its assets), each GET and HEAD;
 * and D27's anonymous validate (decision 23), POST only. Anything else the
 * open plugin registers is refused (a GET of the anonymous validate's path
 * included).
 */
export const OPEN_PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  ...["/health", "/openapi.json", "/docs", "/docs/*"].flatMap((path) =>
    ["GET", "HEAD"].map((method) => `${method} ${PUBLIC_API_PREFIX}${path}`),
  ),
  `POST ${PUBLIC_API_PREFIX}/validate/anonymous`,
]);

/** The root's CORS preflight (@fastify/cors' `OPTIONS *`, Ruling 163): the router holds one route per method and URL, so it is exactly that. */
const CORS_PREFLIGHT = "OPTIONS *";

function surfaceOf(instance: FastifyInstance): PublicSurface | undefined {
  const surface: unknown = (instance as unknown as Record<symbol, unknown>)[SURFACE];
  return surface === "plugin" || surface === "open" ? surface : undefined;
}

/**
 * Claims `instance` (a plugin's own) as the public plugin's or the open
 * routes', first thing in that plugin, and verifies each route it (or a
 * plugin under it) registers: every route for the public plugin, whose own
 * `onRoute` requires `config.access`; for the open routes, those on
 * OPEN_PUBLIC_ROUTES (the registration guard refuses the rest). Throws on
 * an instance that already holds a surface. Called only by plugin.ts and
 * open-routes.ts (database/context-source.test.ts).
 */
export function claimPublicSurface(instance: FastifyInstance, surface: PublicSurface): void {
  if ((instance as unknown as Record<symbol, unknown>)[SURFACE] !== undefined) {
    throw new Error("this instance already holds a public surface");
  }
  instance.decorate(SURFACE, surface);
  instance.addHook("onRoute", (route) => {
    const keys = methodsOf(route).map((method) => `${method} ${route.url}`);
    if (surface === "open" && !keys.every((key) => OPEN_PUBLIC_ROUTES.has(key))) return;
    const token = {};
    verifiedTokens.set(token, new Set(keys));
    const config = (route.config ??= {}) as Record<symbol, unknown>;
    config[VERIFIED] = token;
  });
}

/**
 * The options the public plugin passes to its own `setNotFoundHandler`
 * (Ruling 166): a config holding a private token, which Fastify keeps as
 * the not-found context's config, so the verification can tell this
 * handler from any other. Throws for an instance that isn't the public
 * plugin's (claimPublicSurface). Called only by plugin.ts
 * (context-source.test.ts).
 */
export function publicNotFoundOptions(instance: FastifyInstance): { preValidation?: never; config: object } {
  if (surfaceOf(instance) !== "plugin") throw new Error("only the public plugin sets the public not-found handler");
  const token = {};
  publicNotFoundTokens.add(token);
  return { config: { [PUBLIC_NOT_FOUND]: token } };
}

/**
 * A URL as the guards compare it: percent-decoded once (a lone `%` left as
 * is), lower-cased, its runs of slashes made one and its dot segments
 * resolved, with a leading slash.
 */
export function normalizedRouteUrl(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  const segments: string[] = [];
  for (const segment of `/${decoded}`.toLowerCase().replace(/\/{2,}/g, "/").split("/").slice(1)) {
    if (segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Whether a route's URL could match a path under the prefix (Ruling 164),
 * normalized, segment by segment against `api`, `public`, `v1`: a segment
 * holding a parameter (`:`) matches any; one holding a wildcard (`*`)
 * matches when its part before the `*` begins the rest of the prefix, and
 * then matches everything; otherwise the segment must be the prefix's. A
 * URL whose segments run out before the three matched is not under it.
 */
export function isUnderPublicPrefix(url: string): boolean {
  const segments = normalizedRouteUrl(url).split("/").slice(1);
  for (const [index, wanted] of PREFIX_SEGMENTS.entries()) {
    const segment = segments[index];
    if (segment === undefined) return false;
    const star = segment.indexOf("*");
    if (star !== -1) return PREFIX_SEGMENTS.slice(index).join("/").startsWith(segment.slice(0, star));
    if (segment.includes(":")) continue;
    if (segment !== wanted) return false;
  }
  return true;
}

/**
 * Whether a request is under the prefix: http/public-path.ts' one
 * normalizer, the request log's too (Ruling 173), so an absolute-form,
 * doubly encoded or case-changed spelling is the same request to both.
 */
export function isPublicRequestPath(url: string): boolean {
  return isPublicPath(url);
}

/** The registration guard's check, for one route registered on `instance`: throws on a route that could escape the plugin. */
export function assertPublicRouteContained(instance: FastifyInstance, route: Pick<RouteOptions, "method" | "url">): void {
  if (!isUnderPublicPrefix(route.url)) return;
  const keys = methodsOf(route).map((method) => `${method} ${route.url}`);
  if (keys.every((key) => key === CORS_PREFLIGHT)) return;
  const surface = surfaceOf(instance);
  if (surface === "plugin") return;
  if (surface === "open" && keys.every((key) => OPEN_PUBLIC_ROUTES.has(key))) return;
  throw new Error(
    `a route under ${PUBLIC_API_PREFIX} must be the public plugin's or an allowed open route: ${methodsOf(route).join(",")} ${route.url}`,
  );
}

/** The registration guard: a root `onRoute` hook (buildServer, before any route). */
export function registerPublicRouteGuard(server: FastifyInstance): void {
  server.addHook("onRoute", function (this: FastifyInstance, route) {
    assertPublicRouteContained(this, route);
  });
}

/**
 * The verification's refusal: the one 401 (invalidApiToken), `no-store`
 * as every public reply is (D25 Rulings 185 and 187): it is answered
 * outside the public plugin, whose `onSend` hook sets it on its own.
 */
function verificationRefused(): AppError {
  const refusal = invalidApiToken();
  return new AppError(refusal.code, refusal.message, refusal.statusCode, undefined, {
    ...refusal.headers,
    "cache-control": "no-store",
  });
}

/**
 * The verification: a root `onRequest` hook (buildServer, before any other
 * hook or plugin). Answers the one 401 for a request under the prefix that
 * matched a route neither public plugin verified (nor the CORS preflight).
 */
export function registerPublicRouteVerification(server: FastifyInstance): void {
  server.addHook("onRequest", async (request) => {
    if (!isPublicRequestPath(request.url)) return;
    const config = request.routeOptions.config as unknown as Record<symbol, unknown> | undefined;
    if (request.is404) {
      const notFound = config?.[PUBLIC_NOT_FOUND];
      if (typeof notFound === "object" && notFound !== null && publicNotFoundTokens.has(notFound)) return;
      request.log.warn("a request under /api/public/v1 reached a not-found handler outside the public plugin");
      throw verificationRefused();
    }
    const { method, url } = request.routeOptions;
    const key = `${request.method} ${url ?? ""}`;
    if (`${String(method)} ${url ?? ""}` === CORS_PREFLIGHT) return;
    const token = config?.[VERIFIED];
    const keys = typeof token === "object" && token !== null ? verifiedTokens.get(token) : undefined;
    if (keys?.has(key)) return;
    request.log.warn({ route: url }, "a request under /api/public/v1 matched a route outside the public plugin");
    throw verificationRefused();
  });
}
