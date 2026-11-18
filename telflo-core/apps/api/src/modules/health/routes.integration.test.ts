import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

/**
 * A server writing its log lines to `lines`, at the API's production level
 * ("info", where Fastify writes its request lines), whatever LOG_LEVEL the
 * test run has.
 */
function buildLoggingServer(db: Kysely<Database>, lines: string[]): FastifyInstance {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "info";
  try {
    return buildServer({
      settings: loadSettings(process.env),
      db,
      mailer: createInMemoryMailer(),
      rateLimits: TEST_RATE_LIMITS,
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      logStream: { write: (line) => void lines.push(line) },
    });
  } finally {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  }
}

const messagesOf = (lines: string[]) => lines.map((line) => (JSON.parse(line) as { msg?: string }).msg);

describe("GET /health", () => {
  let server: FastifyInstance;
  let db: Kysely<Database>;
  const lines: string[] = [];

  beforeAll(async () => {
    db = createDb(createPool(loadSettings(process.env).databaseUrl));
    server = buildLoggingServer(db, lines);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it("reports ok when the database answers", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("writes no log line, since probes call it every few seconds (D33-1 decision 18)", async () => {
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(lines).toEqual([]);
  });

  it("returns the error envelope for an unknown route", async () => {
    const response = await server.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("leaves every other route's request lines as they were", async () => {
    expect((await server.inject({ method: "GET", url: "/nope" })).statusCode).toBe(404);
    expect(messagesOf(lines)).toEqual(expect.arrayContaining(["incoming request", "request completed"]));
  });
});

describe("GET /health with the database gone", () => {
  let server: FastifyInstance;
  let db: Kysely<Database>;
  const lines: string[] = [];

  beforeAll(async () => {
    // The same database on a closed loopback port: `select 1` fails to connect.
    const unreachable = new URL(loadSettings(process.env).databaseUrl);
    unreachable.hostname = "127.0.0.1";
    unreachable.port = "9";
    db = createDb(createPool(unreachable.toString()));
    server = buildLoggingServer(db, lines);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
  });

  it("fails and still writes no log line: the kubelet's probe events are the record", async () => {
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(500);
    expect(lines).toEqual([]);
  });
});
