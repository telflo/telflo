import type { FastifyPluginAsync } from "fastify";
import { loadReferencePageFiles, redirectToReferencePage, serveReferencePageFile } from "./docs/reference-page.js";
import { publicApiDocumentJson } from "./openapi/document.js";
import type { RecordedPublicRoute } from "./plugin.js";
import { claimPublicSurface, methodsOf } from "./route-guard.js";
import { registerAnonymousValidateRoute, type AnonymousValidateDependencies } from "./validate/anonymous.js";

/*
 * The public surface's open routes: a sibling plugin with the
 * `/api/public/v1` prefix and none of the public plugin's hooks, so no
 * token, no organization and no per-token count. GET /health, GET
 * /openapi.json, the document, and the reference page (GET /docs, its 301,
 * and GET /docs/*, the page and its assets; docs/reference-page.ts), and
 * POST /validate/anonymous (validate/anonymous.ts), whose dependencies the
 * plugin is given. Only the routes on the root guard's allowlist
 * (route-guard.ts' OPEN_PUBLIC_ROUTES) may be registered here: anything
 * else refuses the server's start.
 */

/** The document changes only with a deploy: caches may keep it five minutes. */
const DOCUMENT_CACHE_CONTROL = "public, max-age=300";

export function createOpenRoutesPlugin(
  record: (route: RecordedPublicRoute) => void,
  deps: AnonymousValidateDependencies,
): FastifyPluginAsync {
  return async (open) => {
    // First: only OPEN_PUBLIC_ROUTES may be registered here, and only they are verified (route-guard.ts).
    claimPublicSurface(open, "open");
    open.addHook("onRoute", (route) => {
      for (const method of methodsOf(route)) record({ method, url: route.url, access: "none" });
    });

    // The process answers. The root's /health checks the database for the stack's probes.
    open.get("/health", async (_request, reply) => reply.header("cache-control", "no-store").send({ status: "healthy" }));

    // Read and assembled once, as the server readies, so a broken fragment stops it before it listens.
    const document = publicApiDocumentJson();
    open.get("/openapi.json", async (_request, reply) =>
      reply.header("cache-control", DOCUMENT_CACHE_CONTROL).type("application/json; charset=utf-8").send(document),
    );

    // The reference page, its files read once here (a missing one stops the start, as a broken fragment does).
    const pageFiles = loadReferencePageFiles();
    open.get("/docs", redirectToReferencePage);
    open.get("/docs/*", serveReferencePageFile(pageFiles));

    // POST /validate/anonymous: a text checked for no one, under its own limits (validate/anonymous.ts).
    registerAnonymousValidateRoute(open, deps);
  };
}
