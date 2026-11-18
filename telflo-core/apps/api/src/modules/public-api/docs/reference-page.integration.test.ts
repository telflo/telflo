import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { TEST_RATE_LIMITS } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { buildServer } from "../../../server.js";
import { loadSettings } from "../../../settings.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../../testing/otelcol-validator.js";
import { REFERENCE_PAGE_CSP } from "./reference-page.js";

/*
 * The API reference page on the real server (D25 decision 49, Preflight
 * ruling 20, Ruling 160): served by the open routes without a token, the
 * page and its three assets from the files beside this test, B18's CSP
 * exactly with no-referrer and nosniff on every reply, the caches, the 301
 * from /docs, the 404 for anything else, HEAD, and the request log's line
 * (the route's pattern, never the path or query as sent). No token is
 * made here: the page's routes read none.
 */

const opamp = useFakeOpampServer();

const PAGE = "/api/public/v1/docs/";

/** B18's policy, written out here as well, so a change to the constant fails this test. */
const B18_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fileBeside = (relative: string) => readFileSync(new URL(relative, import.meta.url));

describe("the API reference page (D25 decision 49)", () => {
  let db: Kysely<Database>;
  let server: FastifyInstance;
  let logLines: string[] = [];

  beforeAll(async () => {
    const settings = loadSettings(process.env);
    db = createDb(createPool(settings.databaseUrl));
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
  });

  beforeEach(() => {
    logLines = [];
  });

  /** The three headers every reply of the page's routes carries. */
  const expectPageHeaders = (headers: Record<string, unknown>) => {
    expect({
      csp: headers["content-security-policy"],
      referrer: headers["referrer-policy"],
      nosniff: headers["x-content-type-options"],
    }).toEqual({ csp: B18_CSP, referrer: "no-referrer", nosniff: "nosniff" });
  };

  it("keeps B18's CSP exactly", () => {
    expect(REFERENCE_PAGE_CSP).toBe(B18_CSP);
  });

  it("GET /docs/ answers the page without a token: HTML, revalidated, its assets by absolute paths, no inline script or style", async () => {
    for (const headers of [{}, { authorization: "Bearer nonsense" }, { cookie: "telflo_access=x" }]) {
      const response = await server.inject({ method: "GET", url: PAGE, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-cache");
      expectPageHeaders(response.headers);
      expect(response.body).toBe(fileBeside("./index.html").toString("utf8"));
    }
    const html = fileBeside("./index.html").toString("utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
    expect(scripts).toEqual([' src="/api/public/v1/docs/swagger-ui-bundle.js"', ' src="/api/public/v1/docs/init.js"']);
    expect([...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((match) => match[1])).toEqual(["/api/public/v1/docs/swagger-ui.css"]);
    expect(/<style\b|\sstyle=|\son[a-z]+=/i.test(html)).toBe(false);
  });

  it.each([
    ["swagger-ui-bundle.js", "./swagger-ui/swagger-ui-bundle.js", "text/javascript; charset=utf-8", "public, max-age=3600"],
    ["swagger-ui.css", "./swagger-ui/swagger-ui.css", "text/css; charset=utf-8", "public, max-age=3600"],
    ["init.js", "./init.js", "text/javascript; charset=utf-8", "no-cache"],
  ])("GET /docs/%s answers the file beside this module, its type and cache", async (name, relative, type, cacheControl) => {
    const response = await server.inject({ method: "GET", url: `${PAGE}${name}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(type);
    expect(response.headers["cache-control"]).toBe(cacheControl);
    expectPageHeaders(response.headers);
    expect(sha256(response.rawPayload)).toBe(sha256(fileBeside(relative)));
  });

  it("serves the vendored Swagger UI 5.32.15 files unchanged (docs/third-party-assets.md's sha256s)", () => {
    expect({
      bundle: sha256(fileBeside("./swagger-ui/swagger-ui-bundle.js")),
      css: sha256(fileBeside("./swagger-ui/swagger-ui.css")),
    }).toEqual({
      bundle: "a7e344f2770b2f07527ce828e0951626983b8f2dcdb7a826689c0232023f995b",
      css: "d7f39f764aa18c7b47dd05b9af5613e373e4ac0f3557c2693d52d0abc2464d76",
    });
  });

  it("GET /docs answers 301 to /docs/ with its slash (Ruling 160), with the page's headers", async () => {
    const response = await server.inject({ method: "GET", url: "/api/public/v1/docs" });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(PAGE);
    expectPageHeaders(response.headers);
  });

  it("HEAD answers the page's and an asset's headers without a body", async () => {
    for (const url of [PAGE, `${PAGE}swagger-ui.css`]) {
      const response = await server.inject({ method: "HEAD", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("");
      expectPageHeaders(response.headers);
    }
    expect((await server.inject({ method: "HEAD", url: "/api/public/v1/docs" })).statusCode).toBe(301);
  });

  it.each([
    "LICENSE",
    "NOTICE",
    "swagger-ui-bundle.js.LICENSE.txt",
    "swagger-ui/swagger-ui.css",
    "index.html",
    "reference-page.ts",
    "init.js/",
    "swagger-ui.css.map",
    "x?y=1",
  ])("GET /docs/%s, a name not on the page's list, answers the root's 404 words, no-store, nothing read from disk", async (name) => {
    const response = await server.inject({ method: "GET", url: `${PAGE}${name}` });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expectPageHeaders(response.headers);
    expect(response.json()).toEqual({ error: { code: "not_found", message: "No route for GET /api/public/v1/[unmatched]" } });
  });

  it.each([
    ["an encoded parent segment", "..%2fLICENSE"],
    ["an encoded dot segment", "%2e%2e/swagger-ui/LICENSE"],
    ["an encoded slash into the vendored folder", "swagger-ui%2fLICENSE"],
    ["an absolute path after the slash", "/etc/passwd"],
    ["an encoded absolute path", "%2fetc%2fpasswd"],
  ])("a traversal (%s) never answers a file by its name: a 404 or the public plugin's 401, no file's text", async (_label, name) => {
    const response = await server.inject({ method: "GET", url: `${PAGE}${name}` });
    expect([404, 401]).toContain(response.statusCode);
    expect(["Apache License", "root:", "SmartBear"].some((text) => response.body.includes(text))).toBe(false);
  });

  it("other methods aren't routes of the page: the public plugin's check answers them", async () => {
    const response = await server.inject({ method: "POST", url: PAGE, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "invalid_api_token" } });
  });

  it("logs the route's pattern only, never the path or query as sent (Ruling 173)", async () => {
    const MARKER = "marker-reference-page";
    await server.inject({ method: "GET", url: `${PAGE}?q=${MARKER}` });
    await server.inject({ method: "GET", url: `${PAGE}${MARKER}.js?q=${MARKER}` });
    await server.inject({ method: "GET", url: `/api/public/v1/docs?q=${MARKER}` });
    const urls = logLines.flatMap((line) => {
      const { req } = JSON.parse(line) as { req?: { url?: string } };
      return req?.url === undefined ? [] : [req.url];
    });
    expect(urls).toEqual(["/api/public/v1/docs/*", "/api/public/v1/docs/*", "/api/public/v1/docs"]);
    expect(logLines.join("\n").includes(MARKER)).toBe(false);
  });
});
