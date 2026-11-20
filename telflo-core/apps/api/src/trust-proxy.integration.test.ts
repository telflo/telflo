import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { createInMemoryMailer } from "./mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "./settings.js";
import { buildServer } from "./server.js";
import { TEST_RATE_LIMITS } from "./http/rate-limits.js";
import { useFakeOpampServer } from "./testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "./testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "./testing/file-store.js";
import { UNCALLED_TESTING } from "./testing/otelcol-testing.js";

// The opamp-server every server needs: this file's own fake.
const opamp = useFakeOpampServer();

/**
 * Per-IP rate limits and the audit log both read request.ip. It must be the
 * socket peer when no proxy is trusted, and exactly one hop in when one is:
 * never whatever a client chooses to write at the left of X-Forwarded-For.
 */
describe("proxy trust", () => {
  let db: Kysely<Database>;
  let baseSettings: AppSettings;
  const servers: FastifyInstance[] = [];

  beforeAll(() => {
    baseSettings = loadSettings(process.env);
    db = createDb(createPool(baseSettings.databaseUrl));
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await db.destroy();
  });

  async function serverWithHops(trustProxyHops: number): Promise<FastifyInstance> {
    const server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: { ...baseSettings, trustProxyHops },
      db,
      mailer: createInMemoryMailer(),
      rateLimits: TEST_RATE_LIMITS,
    });
    server.get("/test/request-ip", (request) => ({ ip: request.ip }));
    servers.push(server);
    await server.ready();
    return server;
  }

  async function ipSeenBy(server: FastifyInstance, forwardedFor: string): Promise<string> {
    const response = await server.inject({
      method: "GET",
      url: "/test/request-ip",
      remoteAddress: "10.0.0.2",
      headers: { "x-forwarded-for": forwardedFor },
    });
    return (response.json() as { ip: string }).ip;
  }

  it("ignores X-Forwarded-For when no proxy hops are trusted", async () => {
    const server = await serverWithHops(0);
    expect(await ipSeenBy(server, "198.51.100.9")).toBe("10.0.0.2");
  });

  it("takes the client address from the one trusted hop", async () => {
    const server = await serverWithHops(1);
    expect(await ipSeenBy(server, "198.51.100.9")).toBe("198.51.100.9");
  });

  it("does not believe an address a client prepended beyond the trusted hop", async () => {
    const server = await serverWithHops(1);
    expect(await ipSeenBy(server, "203.0.113.66, 198.51.100.9")).toBe("198.51.100.9");
  });
});
