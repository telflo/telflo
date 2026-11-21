import { readFileSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendNotFound } from "../../../errors.js";
import { PUBLIC_API_PREFIX } from "../route-guard.js";

/*
 * The API reference page:
 * Swagger UI with try-it over the public surface's OpenAPI document, served
 * from the API's own origin by the open routes (open-routes.ts registers
 * the two routes with this module's handlers), without a token. Swagger UI is vendored in swagger-ui/ (swagger-ui-dist 5.32.15,
 * Apache-2.0; docs/third-party-assets.md), not an npm dependency: the
 * package's own dependency runs install-time telemetry. The page is
 * index.html, its start init.js (the token in memory only, no form
 * history, a tokenless curl block, no cookie sent; see init.js).
 *
 *   GET /api/public/v1/docs    301 to /api/public/v1/docs/
 *   GET /api/public/v1/docs/   the page
 *   GET /api/public/v1/docs/{swagger-ui.css, swagger-ui-bundle.js, init.js}
 *
 * (HEAD too: Fastify's own for each GET.) Every file is read once, as the
 * server readies, and kept in memory: nothing on disk is read per request,
 * and no request names a file (the wildcard's value is looked up in a
 * fixed map; anything else is the root's 404 words). Every reply carries
 * a CSP measured with no violation in Chromium, Firefox
 * and WebKit (scripts, styles, images, fonts and fetches from this origin
 * only; no frame, base or form target), `Referrer-Policy: no-referrer` and
 * `nosniff`. The vendored assets are cached an hour; the page and init.js
 * are revalidated (`no-cache`), so a deploy's change reaches the browser.
 * No analytics: PostHog isn't on this page, which isn't the web app's.
 */

/** The page's policy, exactly. */
export const REFERENCE_PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Where the page lives, from the open routes' prefix. */
export const REFERENCE_PAGE_PATH = "/docs";

/** The vendored assets' cache (an hour) and the page's and its start's (always revalidated). */
const ASSET_CACHE_CONTROL = "public, max-age=3600";
const PAGE_CACHE_CONTROL = "no-cache";

export interface ReferenceFile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** Reads a file beside this module. */
function read(relative: string): Buffer {
  return readFileSync(new URL(relative, import.meta.url));
}

/**
 * The page's files by the wildcard's value under `/docs/` ("" for the page
 * itself), read now. Throws when one is missing, so the server doesn't
 * start without its reference page.
 */
export function loadReferencePageFiles(): ReadonlyMap<string, ReferenceFile> {
  return new Map<string, ReferenceFile>([
    ["", { body: read("./index.html"), contentType: "text/html; charset=utf-8", cacheControl: PAGE_CACHE_CONTROL }],
    ["init.js", { body: read("./init.js"), contentType: "text/javascript; charset=utf-8", cacheControl: PAGE_CACHE_CONTROL }],
    [
      "swagger-ui-bundle.js",
      {
        body: read("./swagger-ui/swagger-ui-bundle.js"),
        contentType: "text/javascript; charset=utf-8",
        cacheControl: ASSET_CACHE_CONTROL,
      },
    ],
    [
      "swagger-ui.css",
      { body: read("./swagger-ui/swagger-ui.css"), contentType: "text/css; charset=utf-8", cacheControl: ASSET_CACHE_CONTROL },
    ],
  ]);
}

/** The headers every reply of the page's routes carries. */
function withPageHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header("content-security-policy", REFERENCE_PAGE_CSP)
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff");
}

/** `GET /docs`: 301 to the page with its slash, whose absolute references don't need it but whose address should be one. */
export async function redirectToReferencePage(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return withPageHeaders(reply)
    .header("cache-control", PAGE_CACHE_CONTROL)
    .redirect(`${PUBLIC_API_PREFIX}${REFERENCE_PAGE_PATH}/`, 301);
}

/**
 * `GET /docs/*`: the file the wildcard names, from `files`
 * (loadReferencePageFiles), or the root's 404 words (no-store).
 */
export function serveReferencePageFile(
  files: ReadonlyMap<string, ReferenceFile>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    const name = (request.params as { "*"?: string })["*"] ?? "";
    const file = files.get(name);
    withPageHeaders(reply);
    if (file === undefined) {
      sendNotFound(request, reply.header("cache-control", "no-store"));
      return reply;
    }
    return reply.header("cache-control", file.cacheControl).type(file.contentType).send(file.body);
  };
}
