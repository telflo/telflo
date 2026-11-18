import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, FLOW_YAML_MAXIMUM_LENGTH } from "@telflo/contracts";
import {
  addMembership,
  createUserWithOrganization,
  loadFlowsMigration,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { RATE_LIMITED_MESSAGE, RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";
import { lintFlowConfig } from "./lint.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const URL = "/api/v1/flows/lint";

const PRODUCT_ADMIN_REQUIRED = {
  error: { code: "product_admin_required", message: "Only a product admin can do that." },
};

/** Text no log line may hold: a linted configuration's own words, which the findings and destinations quote. */
const SECRET_MARKER = "secret-marker-5d1e8b";
const DESTINATION_MARKER = "destination-marker-c03f6a.example";
const COMMENT_MARKER = "comment-marker-2b94d7";
const MARKED_YAML =
  `# ${COMMENT_MARKER}\n` +
  "receivers:\n  otlp: {}\n" +
  `exporters:\n  otlp_http:\n    endpoint: https://${DESTINATION_MARKER}\n    headers:\n      api-key: ${SECRET_MARKER}\n` +
  "service:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp_http]\n";

function accessCookie(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith("telflo_access="));
  if (!line) throw new Error("the response set no access cookie");
  return line.slice("telflo_access=".length, line.indexOf(";"));
}

/**
 * `POST /api/v1/flows/lint` (D12 decision 6, Preflight ruling 3) against
 * Postgres: the flow lint behind the product-admin flag, rate limited per
 * product admin, never logged and never audited. What the lint answers is
 * lint.test.ts's; here, that the
 * endpoint answers exactly lintFlowConfig's answer.
 */
describe("POST /api/v1/flows/lint", () => {
  let databases: TestDatabases;
  let server: FastifyInstance;
  let passwordHash: string;
  /** Every line the server logged, at trace level, since the test began. */
  let lines: string[] = [];

  function serverWith(rateLimits: RateLimits, logStream?: { write: (line: string) => void }): FastifyInstance {
    return buildServer({
      settings: loadSettings(process.env),
      db: databases.db,
      mailer: createInMemoryMailer(),
      rateLimits,
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      ...(logStream ? { logStream } : {}),
    });
  }

  beforeAll(async () => {
    databases = openTestDatabases();
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    try {
      server = serverWith(TEST_RATE_LIMITS, { write: (line) => void lines.push(line) });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    lines = [];
  });

  type Kind = "productAdmin" | "organizationAdmin" | "contributor";

  /**
   * A verified user signed in through this file's server: a product admin,
   * an organization's admin without the flag, or a contributor of a group
   * organization without it, active in that group.
   */
  async function signedIn(kind: Kind): Promise<string> {
    const account = await createUserWithOrganization(databases.ownerDb, {
      user: {
        email: `lint-${randomUUID()}@example.com`,
        password_hash: passwordHash,
        ...(kind === "productAdmin" ? { is_product_admin: true } : {}),
      },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    if (kind !== "contributor") return accessCookie(response);
    const { organization: group } = await addMembership(databases.ownerDb, {
      userId: account.user.id,
      role: "contributor",
    });
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: accessCookie(response) },
      payload: { organizationId: group.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return switched.headers["set-cookie"] === undefined ? accessCookie(response) : accessCookie(switched);
  }

  const lint = (access: string | undefined, payload: unknown, on: FastifyInstance = server) =>
    on.inject({
      method: "POST",
      url: URL,
      headers: { ...csrfHeaders, "content-type": "application/json" },
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

  const auditRows = () => databases.ownerDb.selectFrom("audit_events").selectAll().execute();

  describe("who may lint (decision 6: product admins only, a Parity Note)", () => {
    it("answers 401 signed out", async () => {
      const response = await lint(undefined, { yaml: MARKED_YAML });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });

    it("refuses an organization's admin and a contributor 403 product_admin_required", async () => {
      for (const kind of ["organizationAdmin", "contributor"] as const) {
        const response = await lint(await signedIn(kind), { yaml: MARKED_YAML });
        expect({ kind, status: response.statusCode, body: response.json() }).toEqual({
          kind,
          status: 403,
          body: PRODUCT_ADMIN_REQUIRED,
        });
      }
    });
  });

  describe("what a product admin gets", () => {
    it("answers lintFlowConfig's answer exactly, which no cache keeps, and audits nothing", async () => {
      const access = await signedIn("productAdmin");
      const auditsBefore = await auditRows();
      const response = await lint(access, { yaml: MARKED_YAML });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(lintFlowConfig(MARKED_YAML));
      expect(response.json()).toEqual({
        blocked: true,
        findings: [
          {
            severity: "block",
            code: "hardcoded-credential",
            message:
              "'api-key' contains a literal value. Publishing this would share your own credential — replace it with ${env:...}.",
            path: ".exporters.otlp_http.headers.api-key",
          },
          {
            severity: "block",
            code: "literal-endpoint",
            message:
              `'endpoint' is the hardcoded destination 'https://${DESTINATION_MARKER}'. Shared flows must use \${env:...} ` +
              "so importers send data to their own backend, not one chosen by the publisher.",
            path: "exporters.otlp_http.endpoint",
          },
          {
            severity: "warn",
            code: "no-memory-limiter",
            message:
              "No memory_limiter processor. Under load the collector can be OOM-killed instead of applying backpressure.",
            path: "processors",
          },
        ],
        destinations: [`exporters.otlp_http.endpoint → https://${DESTINATION_MARKER}`],
      });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(await auditRows()).toEqual(auditsBefore);
    });

    it("lints a seeded flow: dual-ship-migration-bridge is blocked by its literal Datadog site", async () => {
      const { seededFlows } = await loadFlowsMigration();
      const flow = seededFlows.find((seeded) => seeded.slug === "dual-ship-migration-bridge");
      if (!flow) throw new Error("the seed has no dual-ship-migration-bridge");
      const response = await lint(await signedIn("productAdmin"), { yaml: flow.yaml_content });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        blocked: true,
        destinations: ["exporters.datadog.api.site → datadoghq.com", expect.any(String)],
      });
    });

    it("answers a blank YAML the lint's empty-config, not a refusal, and invalid YAML the lint's invalid-yaml", async () => {
      const access = await signedIn("productAdmin");
      for (const yaml of ["", "  \n"]) {
        const response = await lint(access, { yaml });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          blocked: true,
          findings: [
            { severity: "block", code: "empty-config", message: "The configuration is empty.", path: "config" },
          ],
          destinations: [],
        });
      }
      const invalid = await lint(access, { yaml: "a: [1\n" });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.json().findings.map((finding: { code: string }) => finding.code)).toEqual(["invalid-yaml"]);
    });
  });

  describe("the request (contract and body limits)", () => {
    it("refuses a body without the YAML, with anything else, or with YAML that isn't a string, 400 invalid_request", async () => {
      const access = await signedIn("productAdmin");
      for (const payload of [{}, { yaml: null }, { yaml: 1 }, { yaml: "a: 1\n", slug: "x" }, "not json"]) {
        const response = await lint(access, payload);
        expect({ payload, status: response.statusCode, code: response.json().error.code }).toEqual({
          payload,
          status: 400,
          code: "invalid_request",
        });
      }
    });

    it("takes a flow's longest YAML, 262,144 characters, even at 1.5 MiB once JSON escapes them, and refuses one character more", async () => {
      const access = await signedIn("productAdmin");
      // Every character JSON-escaped as \u0001, six bytes: the largest body the YAML's limit allows.
      const escaped = "\u0001".repeat(FLOW_YAML_MAXIMUM_LENGTH);
      const body = JSON.stringify({ yaml: escaped });
      expect(Buffer.byteLength(body)).toBeGreaterThan(1.5 * 1024 * 1024);
      const longest = await lint(access, body);
      expect(longest.statusCode).toBe(200);
      expect(longest.json().findings.map((finding: { code: string }) => finding.code)).toEqual(["invalid-yaml"]);

      const tooLong = await lint(access, { yaml: "a".repeat(FLOW_YAML_MAXIMUM_LENGTH + 1) });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json().error.code).toBe("invalid_request");
    });

    it("refuses a body over 2 MiB 413 payload_too_large before reading it, though the gateway's flows location admits 4 MiB", async () => {
      const access = await signedIn("productAdmin");
      const response = await lint(access, JSON.stringify({ yaml: "a".repeat(2 * 1024 * 1024) }));
      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe("payload_too_large");
    });
  });

  describe("the rate limit (20 a minute per product admin)", () => {
    it("admits 20 lints a minute per product admin and refuses the 21st 429 rate_limited with retry-after; refusals before the flag check and invalid bodies count nothing", async () => {
      expect(RATE_LIMITS.flowLintsPerUser).toEqual({ max: 20, windowMs: 60_000 });
      const first = await signedIn("productAdmin");
      const second = await signedIn("productAdmin");
      const notAdmin = await signedIn("organizationAdmin");
      const limited = serverWith(RATE_LIMITS);
      try {
        await limited.ready();
        // Refused before the count: a non-admin's 403s, a signed-out 401, a product admin's 400s.
        for (let index = 0; index < 25; index += 1) {
          expect((await lint(notAdmin, { yaml: "a: 1\n" }, limited)).statusCode).toBe(403);
        }
        expect((await lint(undefined, { yaml: "a: 1\n" }, limited)).statusCode).toBe(401);
        for (let index = 0; index < 3; index += 1) {
          expect((await lint(first, {}, limited)).statusCode).toBe(400);
        }

        for (let index = 0; index < RATE_LIMITS.flowLintsPerUser.max; index += 1) {
          expect((await lint(first, { yaml: "a: 1\n" }, limited)).statusCode).toBe(200);
        }
        const refused = await lint(first, { yaml: "a: 1\n" }, limited);
        expect(refused.statusCode).toBe(429);
        expect(refused.json()).toEqual({ error: { code: "rate_limited", message: RATE_LIMITED_MESSAGE } });
        const retryAfter = Number(refused.headers["retry-after"]);
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(60);

        // Another product admin's lints are their own.
        expect((await lint(second, { yaml: "a: 1\n" }, limited)).statusCode).toBe(200);
      } finally {
        await limited.close();
      }
    });
  });

  it("logs neither the YAML nor its findings or destinations, at trace level, on an answer, a refusal or invalid YAML", async () => {
    const access = await signedIn("productAdmin");
    expect((await lint(access, { yaml: MARKED_YAML })).statusCode).toBe(200);
    expect((await lint(access, { yaml: `${MARKED_YAML}  [bad` })).statusCode).toBe(200);
    expect((await lint(access, { yaml: `? [${SECRET_MARKER}]\n: !${COMMENT_MARKER} x\n` })).statusCode).toBe(200);
    expect((await lint(access, { yaml: MARKED_YAML, extra: SECRET_MARKER })).statusCode).toBe(400);
    expect((await lint(access, `{"yaml": "${SECRET_MARKER}`)).statusCode).toBe(400);
    expect((await lint(await signedIn("contributor"), { yaml: MARKED_YAML })).statusCode).toBe(403);
    expect((await lint(undefined, { yaml: MARKED_YAML })).statusCode).toBe(401);

    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    for (const marker of [SECRET_MARKER, DESTINATION_MARKER, COMMENT_MARKER]) expect(logged).not.toContain(marker);
  });
});
