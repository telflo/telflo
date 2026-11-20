import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { addApiToken, addMembership, addServiceAccount, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { apiTokenHash } from "../service-accounts/tokens.js";
import type * as RouteGuard from "./route-guard.js";

/*
 * The public surface's request-time verification, on the real server: a
 * request under /api/public/v1 answered by any route but the public
 * plugin's, an allowed open route or the CORS preflight is the one 401, a
 * valid token or not. The registration guard would refuse these
 * routes before they could answer (route-guard.test.ts); here it is left
 * out, so the verification alone is what stands, as it must for any
 * spelling a registration check misses. Tokens are built at run time and
 * checked with boolean canaries only.
 */

// The registration guard only: the verification, and everything else in the file, stay real.
vi.mock("./route-guard.js", async (importOriginal) => {
  const original = await importOriginal<typeof RouteGuard>();
  return { ...original, registerPublicRouteGuard: () => undefined };
});

const opamp = useFakeOpampServer();

const REFUSAL = JSON.stringify({ error: { code: "invalid_api_token", message: "Missing or invalid API token" } });

/** Six root routes, each of which the router matches for GET /api/public/v1/escape. */
const ESCAPING_ROUTES = [
  "/api/:x/v1/escape",
  "/api/public/:v/escape",
  "/:a/public/v1/escape",
  "/api/:x(^public$)/v1/escape",
  "/api/*",
  "/api/public/*",
] as const;

describe("the public surface's verification at request time", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  const servers: FastifyInstance[] = [];
  let logLines: string[] = [];

  /** The real server, with `route` added on its root answering 200 (the registration guard left out above). */
  const serverWith = async (route?: string) => {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    let server: FastifyInstance;
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
    if (route !== undefined) server.get(route, async () => ({ escaped: true }));
    await server.ready();
    servers.push(server);
    return server;
  };

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
  });

  /** A live token of a new service account. */
  const liveToken = async () => {
    const admin = await createUserWithOrganization(ownerDb);
    const { organization } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const at = new Date(Date.now() - 60_000);
    const { user } = await addServiceAccount(ownerDb, { organizationId: organization.id, createdAt: at });
    const { token } = await addApiToken(ownerDb, { organizationId: organization.id, serviceAccountUserId: user.id, created_at: at });
    return token;
  };

  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  it.each(ESCAPING_ROUTES)("a root route %s answers no public path: the one 401, with no token and with a valid one", async (route) => {
    const server = await serverWith(route);
    const token = await liveToken();
    logLines = [];
    // The route answers outside the prefix, so it is registered and matched: the refusal is the prefix's alone.
    const anonymous = await server.inject({ method: "GET", url: "/api/public/v1/escape?name=Acme" });
    const withToken = await server.inject({ method: "GET", url: "/api/public/v1/escape", headers: { authorization: `Bearer ${token}` } });
    expect(holdsToken(withToken.body, token)).toBe(false);
    expect(holdsToken(logLines.join("\n"), token)).toBe(false);
    for (const response of [anonymous, withToken]) {
      // no-store as every public reply: this one is answered outside the plugin's onSend hook.
      expect([response.statusCode, response.body === REFUSAL, response.headers["www-authenticate"], response.headers["cache-control"]]).toEqual([
        401,
        true,
        "Bearer",
        "no-store",
      ]);
    }
    const warnings = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.level === 40);
    expect(warnings.map((entry) => [entry.msg, entry.route])).toEqual([
      ["a request under /api/public/v1 matched a route outside the public plugin", route],
      ["a request under /api/public/v1 matched a route outside the public plugin", route],
    ]);
    expect(logLines.join("\n").includes("Acme")).toBe(false);
    // Spellings the normalization takes for the prefix, matched by the same route.
    for (const url of ["/api//public/v1/escape", "/api/./public/v1/escape", "/api/publi%63/v1/escape"]) {
      const response = await server.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      if (response.statusCode !== 404) expect([url, response.statusCode, response.body === REFUSAL]).toEqual([url, 401, true]);
    }
  });

  it("a root route for every method on /api/* answers none of them under the prefix: the one 401 for each, with and without a token", async () => {
    const server = await (async () => {
      const previousLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = "info";
      try {
        const built = buildServer({
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
        built.route({ method: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"], url: "/api/*", handler: async () => ({ escaped: true }) });
        built.options("/api/*", async () => ({ escaped: true }));
        await built.ready();
        servers.push(built);
        return built;
      } finally {
        process.env.LOG_LEVEL = previousLevel;
      }
    })();
    const token = await liveToken();
    const answered: [string, string, number, boolean][] = [];
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const) {
      for (const authorization of [undefined, `Bearer ${token}`]) {
        const response = await server.inject({
          method,
          url: "/api/public/v1/escape",
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        });
        expect(holdsToken(response.body, token)).toBe(false);
        // A HEAD's reply carries the 401's headers; its body is no one's to read.
        const isRefusal =
          response.headers["www-authenticate"] === "Bearer" &&
          response.headers["cache-control"] === "no-store" &&
          (method === "HEAD" || response.body === REFUSAL);
        answered.push([method, authorization === undefined ? "no token" : "a token", response.statusCode, isRefusal]);
      }
    }
    expect(answered).toEqual(
      ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].flatMap((method) => [
        [method, "no token", 401, true],
        [method, "a token", 401, true],
      ]),
    );
    // Outside the prefix (a segment boundary), the route answers as any route does.
    for (const url of ["/api/public/v1x", "/api/public/v10/x", "/api/other"]) {
      expect([url, (await server.inject({ method: "GET", url })).statusCode]).toEqual([url, 200]);
    }
  });

  it("leaves the plugin's routes, the open routes, the 404 after the check, the CORS preflight and every other path as they were", async () => {
    const server = await serverWith("/api/:x/v1/escape");
    const token = await liveToken();
    const whoami = await server.inject({ method: "GET", url: "/api/public/v1/whoami", headers: { authorization: `Bearer ${token}` } });
    expect(holdsToken(whoami.body, token)).toBe(false);
    expect(whoami.statusCode).toBe(200);
    expect((await server.inject({ method: "HEAD", url: "/api/public/v1/whoami", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    const anonymous = await server.inject({ method: "GET", url: "/api/public/v1/whoami" });
    expect(anonymous.statusCode === 401 && anonymous.body === REFUSAL).toBe(true);
    expect((await server.inject({ method: "GET", url: "/api/public/v1/health" })).statusCode).toBe(200);
    expect((await server.inject({ method: "HEAD", url: "/api/public/v1/health" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/public/v1/openapi.json" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/public/v1/nope", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
    expect((await server.inject({ method: "GET", url: "/api/public/v1/nope" })).statusCode).toBe(401);
    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/api/public/v1/whoami",
      headers: { origin: settings.webOrigin, "access-control-request-method": "GET" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(String(preflight.headers["access-control-allow-headers"] ?? "").toLowerCase().includes("authorization")).toBe(false);
    // Outside the prefix, the root route answers as any route does.
    expect((await server.inject({ method: "GET", url: "/api/other/v1/escape" })).json()).toEqual({ escaped: true });
    expect((await server.inject({ method: "GET", url: "/api/v1/flow-showcase" })).statusCode).toBe(200);
    // The open flow read: /api/v1/, no session, outside the public surface's check.
    expect((await server.inject({ method: "GET", url: "/api/v1/published-flows" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/v1/published-flows/no-such-flow" })).json()).toMatchObject({
      error: { code: "flow_not_found" },
    });
  });
});
