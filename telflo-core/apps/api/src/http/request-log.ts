import type { FastifyRequest } from "fastify";
import { DECODING_ROUNDS, isPublicPath, publicPathOf } from "./public-path.js";

/**
 * The OIDC endpoints' paths (D2c decision 1). The callback's query holds the
 * authorization code and `state`, which must never reach a log line; the
 * start's holds only `redirectTo`, but one rule for the prefix is simpler to
 * trust than one per route.
 */
const OIDC_PATH_PREFIX = "/api/v1/auth/oidc/";

/**
 * The configurations list's route. Its `q` is the search text, usually a
 * configuration's name (D7 Preflight ruling 4). The gateway's access log
 * still records it; that is D30's to decide.
 */
const CONFIGURATIONS_LIST_ROUTE = "/api/v1/organizations/:organizationId/configurations";

/**
 * The same list's path as a request spells it, trailing slash included: a
 * request that matched no route (that slash, say) has no route to check.
 */
const CONFIGURATIONS_LIST_PATH = /^\/api\/v1\/organizations\/[^/]+\/configurations\/?$/;

/**
 * Every route under an organization's fleets (D16b Preflight ruling 16):
 * the collector list's `q` holds a collector's name or address, and its
 * cursor sorted by name the base64url of a name, so no `/fleets` route's
 * query is logged, whatever the route.
 */
const FLEETS_ROUTE_PREFIX = "/api/v1/organizations/:organizationId/fleets";

/** The same, as a request spells the path: a request that matched no route (a trailing slash, say) has no route to check. */
const FLEETS_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets(\/|$)/;

/**
 * Every product-admin route (D29 decision 41, Preflight ruling 9): the
 * Users search's `q` holds another person's email or an organization's
 * name, so no `/api/v1/product-admin` route's query is logged, whatever
 * the route (the fleets' rule).
 */
const PRODUCT_ADMIN_ROUTE_PREFIX = "/api/v1/product-admin";

/**
 * The same, as a request spells the path, case aside (a spelling the router
 * matches no route for, a trailing slash or another case, has no route to
 * check).
 */
const PRODUCT_ADMIN_PATH = /^\/api\/v1\/product-admin(\/|$)/i;

function isProductAdminRoute(routeUrl: string | undefined): boolean {
  return (
    routeUrl !== undefined && (routeUrl === PRODUCT_ADMIN_ROUTE_PREFIX || routeUrl.startsWith(`${PRODUCT_ADMIN_ROUTE_PREFIX}/`))
  );
}

/** Whether the path, as spelt or percent-decoded once, runs of slashes made one, is under product administration. */
function isProductAdminPath(path: string): boolean {
  return spellingsOf(path).some((spelling) => PRODUCT_ADMIN_PATH.test(spelling));
}

/**
 * The public surface (D25 decision 47; Rulings 167, 171 and 173): a request
 * http/public-path.ts puts under `/api/public/v1`, in any spelling, logs
 * its MATCHED ROUTE's pattern (`…/validation-pipelines/*`, never a
 * pipeline's name, never the query) or, when no route matched,
 * PUBLIC_UNMATCHED_URL; the plugin's 404 echoes the same. An allowlist, so
 * no spelling of a path or query can carry configuration text into a log
 * line or a reply.
 */
const PUBLIC_API_ROUTE_PREFIX = "/api/public/v1";
export const PUBLIC_UNMATCHED_URL = "/api/public/v1/[unmatched]";

function isPublicApiRoute(routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && (routeUrl === PUBLIC_API_ROUTE_PREFIX || routeUrl.startsWith(`${PUBLIC_API_ROUTE_PREFIX}/`));
}

/**
 * The open flow read's routes (D31-1 decisions 19, 34 and 40, Preflight
 * ruling 2; Ruling 286): the request line holds the method, the route's
 * pattern and the status only, never the slug as sent nor a query. A
 * request that matched one logs its pattern. One that matched no route
 * logs the pattern it falls under: the list's when its path, normalized as
 * http/public-path.ts reads it (decoded, slashes made one, dot segments
 * resolved; case aside), is the list's; otherwise the slug's whenever the
 * path (an absolute-form `scheme://authority` stripped), as sent or after
 * any number of percent-decoding rounds up to http/public-path.ts's
 * DECODING_ROUNDS, each with runs of slashes made one, starts with
 * `/api/v1/published-flows` followed by the end, `/`, `;`, or a decoded
 * `?` or `#` (Ruling 290), case aside (Ruling 287's invariant): a
 * trailing slash, a second segment, an encoded or doubly encoded slash or
 * letter, a `..` that resolves outside the prefix, a `;`-parameter.
 * `/api/v1/published-flowsx` is a lookalike, logged as sent. The gateway's
 * access log keeps the path as sent (Preflight ruling 3: D30's).
 */
export const PUBLISHED_FLOWS_ROUTE = "/api/v1/published-flows";
export const PUBLISHED_FLOW_ROUTE = "/api/v1/published-flows/:slug";

/** The list's path, case aside, on a path normalized by publicPathOf. */
const PUBLISHED_FLOWS_PATH = /^\/api\/v1\/published-flows$/i;

/**
 * Under the list's path, with a boundary (`/`, `;`, a decoded `?` or `#`,
 * or the end), case aside (Ruling 290: `%3F` and `%23` decode to the path's
 * characters, never a query, so they are boundaries too).
 */
const UNDER_PUBLISHED_FLOWS_PATH = /^\/api\/v1\/published-flows([/;?#]|$)/i;

/** An absolute-form request target's `scheme://authority` (RFC 9112 §3.2.2), as http/public-path.ts strips it. */
const ABSOLUTE_FORM_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** The pattern the open flow read's request logs, or undefined for a request that isn't one. */
function publishedFlowsUrlOf(url: string, routeUrl: string | undefined): string | undefined {
  if (routeUrl === PUBLISHED_FLOWS_ROUTE || routeUrl === PUBLISHED_FLOW_ROUTE) return routeUrl;
  // A request another route matched is that route's, logged as before.
  if (routeUrl !== undefined) return undefined;
  const normalized = publicPathOf(url);
  if (PUBLISHED_FLOWS_PATH.test(normalized)) return PUBLISHED_FLOWS_ROUTE;
  if (UNDER_PUBLISHED_FLOWS_PATH.test(normalized)) return PUBLISHED_FLOW_ROUTE;
  // The path as sent and after each round of decoding (Ruling 287): a `..` may resolve
  // outside the prefix, but a target that started under it, in any spelling, is logged by
  // a pattern. Each spellingsOf call reads one more round (its second spelling).
  const queryStart = queryStartOf(url);
  let spelling = (queryStart === -1 ? url : url.slice(0, queryStart)).replace(ABSOLUTE_FORM_AUTHORITY, "");
  for (let round = 0; round < DECODING_ROUNDS; round += 1) {
    const [asSpelt, decoded] = spellingsOf(spelling);
    if (UNDER_PUBLISHED_FLOWS_PATH.test(asSpelt) || UNDER_PUBLISHED_FLOWS_PATH.test(decoded)) return PUBLISHED_FLOW_ROUTE;
    if (decoded === asSpelt) break;
    spelling = decoded;
  }
  return undefined;
}

/**
 * The public download's route (D17c-2 decisions 2 and 28): its last
 * segment is a quick-deploy link's secret, a credential (whoever holds it
 * downloads an installer). A request that may hold one logs
 * REDACTED_QUICK_DEPLOY_URL in place of its URL, its query and all.
 */
export const QUICK_DEPLOY_ROUTE = "/api/v1/quick-deploy/:secret";
export const REDACTED_QUICK_DEPLOY_URL = "/api/v1/quick-deploy/[redacted]";

/** `/quick-deploy/`, or a path ending in `/quick-deploy`, case aside: the links' own routes (`/quick-deploy-links`) don't match. */
const QUICK_DEPLOY_SEGMENT = /\/quick-deploy(\/|$)/i;

/** A secret's prefix (decision 23), case aside, anywhere in the URL. */
const QUICK_DEPLOY_SECRET_PREFIX = /tqd_/i;

/**
 * The library link's public route (D23-2 decisions 45 and 47, Preflight
 * ruling 10): its last segment is a library link, a credential (whoever
 * holds it downloads the file). A request that may hold one logs
 * REDACTED_LIBRARY_LINK_URL in place of its URL, its query and all.
 */
export const LIBRARY_LINK_ROUTE = "/api/v1/library-links/:link";
export const REDACTED_LIBRARY_LINK_URL = "/api/v1/library-links/[redacted]";

/** `/library-links/`, or a path ending in `/library-links`, case aside. */
const LIBRARY_LINK_SEGMENT = /\/library-links(\/|$)/i;

/** A library link's prefix (decision 45), case aside, anywhere in the URL. */
const LIBRARY_LINK_PREFIX = /tll_/i;

/** Whether a spelling of `text` (as sent, percent-decoded once, runs of slashes made one) holds `tll_`, case aside. */
function mayHoldLibraryLinkPrefix(text: string): boolean {
  return spellingsOf(text).some((spelling) => LIBRARY_LINK_PREFIX.test(spelling));
}

/**
 * Whether the URL may carry a library link (Preflight ruling 10), by
 * quick-deploy's three rules: the route is the link's, or a spelling of
 * the path holds `/library-links/`, or a spelling of the whole URL holds
 * `tll_`. A spelling that matches no route (a dot segment, upper case, a
 * trailing slash, an encoded slash) is caught too, and a link pasted into
 * another route's query or after a raw `#`.
 */
function mayHoldLibraryLink(url: string, path: string, routeUrl: string | undefined): boolean {
  if (routeUrl === LIBRARY_LINK_ROUTE) return true;
  return spellingsOf(path).some((spelling) => LIBRARY_LINK_SEGMENT.test(spelling)) || mayHoldLibraryLinkPrefix(url);
}

/**
 * Whether a request's URL may carry a public link's secret, a quick-deploy
 * link's or a library link (D23-2 decision 47): its log line holds a
 * redaction, and a framework error's reply on it is the public routes'
 * plain text (errors.ts' respondToFrameworkError).
 */
export function urlMayHoldPublicLinkSecret(url: string, routeUrl: string | undefined): boolean {
  const queryStart = queryStartOf(url);
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return mayHoldQuickDeploySecret(url, path, routeUrl) || mayHoldLibraryLink(url, path, routeUrl);
}

/**
 * An API token's prefix (D22 decisions 7 and 40), case aside, anywhere in
 * the URL. A token never belongs in a URL (it travels in the
 * `Authorization` header, which the request log never carries); this
 * covers one pasted there. A URL any spelling of which holds it logs
 * REDACTED_API_TOKEN_URL in place of its URL, its query and all. False
 * positives (an opaque cursor or an asset's name holding `tf_`) only lose
 * a log line's URL.
 */
const API_TOKEN_PREFIX = /tf_/i;
export const REDACTED_API_TOKEN_URL = "/[redacted]";

/** Whether a spelling of the whole URL (as sent, percent-decoded once, runs of slashes made one) holds `tf_`, case aside. */
function mayHoldApiToken(url: string): boolean {
  return spellingsOf(url).some((spelling) => API_TOKEN_PREFIX.test(spelling));
}

/**
 * Whether the URL may carry a link's secret (Preflight ruling 11): the
 * route is the download's, or a spelling of the path (as spelt or
 * percent-decoded once, runs of slashes made one) holds `/quick-deploy/`,
 * or a spelling of the whole URL holds `tqd_`. A spelling that matches no
 * route (a dot segment, which find-my-way doesn't resolve, upper case, a
 * trailing slash, an encoded slash) is caught too: a 404's line is logged
 * as well. The whole URL is checked for the prefix, so a secret pasted
 * into another route's query, or after a raw `#`, is cut with it.
 */
function mayHoldQuickDeploySecret(url: string, path: string, routeUrl: string | undefined): boolean {
  if (routeUrl === QUICK_DEPLOY_ROUTE) return true;
  return (
    spellingsOf(path).some((spelling) => QUICK_DEPLOY_SEGMENT.test(spelling)) ||
    spellingsOf(url).some((spelling) => QUICK_DEPLOY_SECRET_PREFIX.test(spelling))
  );
}

/**
 * Whether a request's URL may carry a quick-deploy link's secret (the
 * check above, on the URL's path as the router ends it): its log line holds
 * REDACTED_QUICK_DEPLOY_URL, and a framework error's reply on it is the
 * public route's plain text (errors.ts' respondToFrameworkError).
 */
export function urlMayHoldQuickDeploySecret(url: string, routeUrl: string | undefined): boolean {
  const queryStart = queryStartOf(url);
  return mayHoldQuickDeploySecret(url, queryStart === -1 ? url : url.slice(0, queryStart), routeUrl);
}

function isFleetsRoute(routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && (routeUrl === FLEETS_ROUTE_PREFIX || routeUrl.startsWith(`${FLEETS_ROUTE_PREFIX}/`));
}

/**
 * The path as spelt and percent-decoded once, each with every run of
 * slashes made one (D16b Ruling 30): `/api/v1//organizations/...` or
 * `.../{org}//fleets` matches no route, so only its spelling can be checked,
 * and a doubled slash mustn't keep a query the single one drops.
 */
function spellingsOf(path: string): [string, string] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape elsewhere in the path (a lone `%`): each valid
    // escape decoded on its own, which spells every ASCII character right.
    decoded = path.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return [path.replace(/\/{2,}/g, "/"), decoded.replace(/\/{2,}/g, "/")];
}

/** Whether the path, as spelt or percent-decoded once, runs of slashes made one, is under an organization's fleets. */
function isFleetsPath(path: string): boolean {
  return spellingsOf(path).some((spelling) => FLEETS_PATH.test(spelling));
}

/**
 * Whether the path, as spelt or percent-decoded once, runs of slashes made
 * one, is under the OIDC prefix: `//api/v1/auth/oidc/...` or
 * `/api/v1/auth//oidc/...` matches no route, and its query mustn't be kept
 * where the single slash's is dropped.
 */
function isOidcPath(path: string): boolean {
  return spellingsOf(path).some((spelling) => spelling.startsWith(OIDC_PATH_PREFIX));
}

/** Whether the path, as spelt or percent-decoded once, runs of slashes made one, is the configurations list's. */
function isConfigurationsListPath(path: string): boolean {
  return spellingsOf(path).some((spelling) => CONFIGURATIONS_LIST_PATH.test(spelling));
}

/**
 * Where the router ends the path: the first `?` or `#`. find-my-way splits a
 * path at either (its url-sanitizer), so a request target holding a raw
 * `#` reaches a route with what follows as its query (D16b Ruling 40).
 */
function queryStartOf(url: string): number {
  const question = url.indexOf("?");
  const hash = url.indexOf("#");
  if (question === -1) return hash;
  if (hash === -1) return question;
  return Math.min(question, hash);
}

/**
 * The URL a log line (or the 404's reply) may hold: REDACTED_QUICK_DEPLOY_URL
 * when it may carry a quick-deploy link's secret, REDACTED_LIBRARY_LINK_URL
 * when it may carry a library link (D23-2 decision 47, checked right after
 * quick-deploy's), and REDACTED_API_TOKEN_URL
 * when a spelling of it holds an API token's `tf_` (D22 decision 40),
 * whether or not it has a query (so these checks come before the no-query
 * return); under the public surface's prefix (by its route, or by any
 * spelling http/public-path.ts reads), the matched route's pattern, or
 * PUBLIC_UNMATCHED_URL when none matched (D25 Ruling 173); the open flow
 * read's pattern for a request to it, or under its prefix matched by no
 * route (D31-1 decision 19); otherwise `url`
 * without its query when it, or the route it matched, is under the OIDC
 * prefix, is the configurations list, is under an organization's
 * fleets or is under product administration (D29 decision 41). The matched route is checked too, since a percent-encoded path
 * can reach the same route without a literal prefix; the percent-decoded
 * path as well, since an encoded path with a trailing slash matches no route,
 * and each spelling with its runs of slashes made one.
 */
export function loggedRequestUrl(url: string, routeUrl: string | undefined): string {
  const queryStart = queryStartOf(url);
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  if (mayHoldQuickDeploySecret(url, path, routeUrl)) return REDACTED_QUICK_DEPLOY_URL;
  if (mayHoldLibraryLink(url, path, routeUrl)) return REDACTED_LIBRARY_LINK_URL;
  if (mayHoldApiToken(url)) return REDACTED_API_TOKEN_URL;
  // Under the public prefix, by route or by any spelling: the route's pattern, or the fixed unmatched URL (Ruling 173).
  if (routeUrl !== undefined && isPublicApiRoute(routeUrl)) return routeUrl;
  if (isPublicPath(url)) return routeUrl ?? PUBLIC_UNMATCHED_URL;
  // The open flow read: its route's pattern only, matched or not (D31-1 decision 19).
  const publishedFlowsUrl = publishedFlowsUrlOf(url, routeUrl);
  if (publishedFlowsUrl !== undefined) return publishedFlowsUrl;
  if (queryStart === -1) return url;
  const isOidc = isOidcPath(path) || (routeUrl?.startsWith(OIDC_PATH_PREFIX) ?? false);
  const isConfigurationsList = routeUrl === CONFIGURATIONS_LIST_ROUTE || isConfigurationsListPath(path);
  const isFleets = isFleetsRoute(routeUrl) || isFleetsPath(path);
  const isProductAdmin = isProductAdminRoute(routeUrl) || isProductAdminPath(path);
  return isOidc || isConfigurationsList || isFleets || isProductAdmin ? path : url;
}

/** What a logged field holding a client's text shows in its place when that text may hold an API token or a library link. */
export const REDACTED_FIELD = "[redacted]";

/**
 * A logged field holding a client's text (D22 decision 40, Ruling 105: no
 * logged field holding a client-supplied value carries a `tf_` token; D23-2
 * decision 47 and Ruling 128 extend the class rule to a library link's
 * `tll_`): REDACTED_FIELD when a spelling of it (as sent, percent-decoded
 * once, runs of slashes made one: the URL's rule) holds `tf_` or `tll_`,
 * case aside; otherwise
 * the value as before, absent included. A header sent twice may come as a
 * list: any of its values holding one redacts the field.
 */
export function loggedClientField<T extends string | readonly string[] | undefined>(value: T): T | typeof REDACTED_FIELD {
  if (value === undefined) return value;
  const values: readonly string[] = typeof value === "string" ? [value] : value;
  return values.some((text) => mayHoldApiToken(text) || mayHoldLibraryLinkPrefix(text)) ? REDACTED_FIELD : value;
}

/**
 * Whether a client's text may hold a credential the platform hands out
 * (D25 Ruling 186): a `tf_` token, a library link's `tll_` or a
 * quick-deploy link's `tqd_`, in any spelling the request log recognizes
 * (as sent, percent-decoded once, runs of slashes made one; case aside).
 */
export function mayHoldCredential(text: string): boolean {
  return (
    mayHoldApiToken(text) ||
    mayHoldLibraryLinkPrefix(text) ||
    spellingsOf(text).some((spelling) => QUICK_DEPLOY_SECRET_PREFIX.test(spelling))
  );
}

/**
 * Fastify's own request serializer (fastify/lib/logger-pino.js), with the
 * URL passed through `loggedRequestUrl` and every other field a client
 * can write through `loggedClientField`: the Accept-Version header, the
 * host (the Host header, or X-Forwarded-Host once proxy hops are trusted)
 * and the address (X-Forwarded-For's, once they are: client-ip.ts). The
 * method is one Node's parser knows, and the port a number.
 */
export function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: loggedRequestUrl(request.url, request.routeOptions?.url),
    version: loggedClientField(request.headers?.["accept-version"]),
    host: loggedClientField(request.host),
    remoteAddress: loggedClientField(request.ip),
    remotePort: request.socket?.remotePort,
  };
}
