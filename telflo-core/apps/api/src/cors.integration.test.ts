import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { createInMemoryMailer } from "./mail/in-memory-mailer.js";
import { loadSettings } from "./settings.js";
import { buildServer } from "./server.js";
import { TEST_RATE_LIMITS } from "./http/rate-limits.js";
import { useFakeOpampServer } from "./testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "./testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "./testing/file-store.js";
import { UNCALLED_TESTING } from "./testing/otelcol-testing.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

/**
 * With no CORS plugin registered, a browser's preflight `OPTIONS` for a
 * cross-origin, credentialed request 404s and the real request never leaves
 * the browser — invisible to `server.inject()`-based tests and to curl, both
 * of which skip the browser's own CORS enforcement entirely. These tests
 * exercise the headers a browser actually checks, via the same
 * `server.inject()` mechanism the rest of this suite uses (it runs requests
 * through Fastify's real hook chain, including the `@fastify/cors` plugin,
 * without opening a socket).
 */
describe("CORS", () => {
  let server: FastifyInstance;
  let db: Kysely<Database>;
  let allowedOrigin: string;

  beforeAll(async () => {
    const settings = loadSettings(process.env);
    allowedOrigin = settings.webOrigin;
    db = createDb(createPool(settings.databaseUrl));
    server = buildServer({
      settings,
      db,
      mailer: createInMemoryMailer(),
      rateLimits: TEST_RATE_LIMITS,
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
  });

  it("echoes the configured web origin back on a simple request", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: allowedOrigin },
    });
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  });

  it("sets Access-Control-Allow-Credentials, required by fetch's credentials: 'include'", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: allowedOrigin },
    });
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not echo back an origin that was not configured", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://attacker.example" },
    });
    expect(response.headers["access-control-allow-origin"]).not.toBe("https://attacker.example");
  });

  it("never sets a wildcard origin, which credentials: 'include' forbids", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: allowedOrigin },
    });
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("answers the preflight OPTIONS for the register route with 2xx and the allowed origin", async () => {
    // This is the exact request a browser sends before POST
    // /api/v1/auth/register, because api-client.ts sets
    // content-type: application/json, which forces a preflight. Without the
    // CORS plugin it 404s (no route registered for OPTIONS).
    const response = await server.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/register",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("allows the CSRF header in the preflight for a state-changing request", async () => {
    // Without it, a cross-origin client could send no POST or DELETE at all:
    // every one must carry x-telflo-csrf.
    const response = await server.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/sessions",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-telflo-csrf",
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    const allowedHeaders = String(response.headers["access-control-allow-headers"]).toLowerCase().split(/,\s*/);
    expect(allowedHeaders).toContain("x-telflo-csrf");
    expect(allowedHeaders).toContain("content-type");
  });

  it("puts the CORS headers on a CSRF refusal, so a cross-origin client can read it", async () => {
    const response = await server.inject({
      method: "DELETE",
      url: "/api/v1/auth/sessions/current",
      headers: { origin: allowedOrigin },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  });
});
