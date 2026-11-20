import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { Kysely } from "kysely";
import { createDb, createPool, type Database } from "@telflo/db";
import { TEST_CATALOGUE_FIXTURE_NOTE, truncateAll } from "@telflo/db/testing";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import type { OtelcolValidatorClient, ValidateRequest, ValidateResult } from "../../../otelcol-validator/client.js";
import { buildServer } from "../../../server.js";
import { loadSettings, type AppSettings } from "../../../settings.js";
import { FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER } from "../../../testing/fake-otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { useFakeOtelcolValidator } from "../../../testing/otelcol-validator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";

/*
 * POST /api/public/v1/validate/anonymous, on the real server with no token,
 * the OpenAPI-checked fake validator behind an in-process wrapper (every
 * call recorded; a test can hold one at a gate): the catalog's defaults
 * and a named collector, the validator's errors, no organization variables,
 * the three catalog 400s and the body's, the 503, the 1 MiB body limit,
 * the limits per address and overall (a minute's count and the slots in
 * flight), a bearer ignored and not counted, `no-store` on every reply,
 * nothing of the text in a log line, and every reply checked against the
 * public OpenAPI document. Addresses are set per request (`remoteAddress`;
 * the test servers trust no hop). Its fixture rows (a distribution with two
 * versions, a deprecated Contrib version) are marked
 * TEST_CATALOGUE_FIXTURE_NOTE, as the public validate's tests' are, and
 * removed afterwards.
 */

const opamp = useFakeOpampServer();
const validator = useFakeOtelcolValidator();

const ROUTE = "/api/public/v1/validate/anonymous";

const CONTRIB = "otelcol-contrib";
const FIXTURE_PREFIX = "anonymous-validate-fixture-";
const runId = randomUUID().slice(0, 8);
const RETIRED = `0.2.${parseInt(runId, 16)}`;
const FIXTURE = `${FIXTURE_PREFIX}${runId}`;
const FIXTURE_DEFAULT = "9.8.1";
const FIXTURE_OTHER = "9.8.0";

/** A text no log line may hold, and a component the fake refuses (its error quotes it). */
const TEXT_MARKER = "anonymous-text-marker-7d2e";
const REFUSED_TYPE = "unknown_anonmarker";
const textWith = (extra = "") =>
  `receivers:\n  otlp:\n    protocols:\n      grpc: {}\n# ${TEXT_MARKER}\nexporters:\n  debug: {}\n${extra}`;

/** A one-shot gate: `hold` waits until `release`, and `reached` resolves once something holds. */
function createGate() {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (open = resolve));
  return {
    reached,
    release: () => open(),
    hold: async () => {
      reach();
      await released;
    },
  };
}

describe("POST /api/public/v1/validate/anonymous", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let contribDefault: string;
  let logLines: string[] = [];
  /** Every check the server asked the validator for since the test began. */
  let calls: ValidateRequest[] = [];
  /** A test's hook in front of the fake's client. */
  let hook: ((request: ValidateRequest) => Promise<ValidateResult>) | undefined;
  /** The organizations whose variables the server read since the test began: never any here. */
  let variableReads: string[] = [];
  const servers: FastifyInstance[] = [];

  const serverValidator: OtelcolValidatorClient = {
    validate: (request) => {
      calls.push(request);
      return (hook ?? ((checked: ValidateRequest) => validator.client.validate(checked)))(request);
    },
  };

  async function serverWith(rateLimits: RateLimits, overrides: Partial<AppSettings> = {}): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: {
          ...opamp.client,
          listVariables: (organizationId) => {
            variableReads.push(organizationId);
            return opamp.client.listVariables(organizationId);
          },
        },
        otelcolValidator: serverValidator,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings: { ...settings, ...overrides },
        db,
        mailer: createInMemoryMailer(),
        rateLimits,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    servers.push(built);
    await built.ready();
    return built;
  }

  const removeFixtures = async () => {
    await ownerDb.deleteFrom("collector_versions").where("description", "=", TEST_CATALOGUE_FIXTURE_NOTE).execute();
    await ownerDb.deleteFrom("collector_versions").where("distribution", "like", `${FIXTURE_PREFIX}%`).execute();
    await ownerDb.deleteFrom("collector_distributions").where("id", "like", `${FIXTURE_PREFIX}%`).execute();
    await ownerDb.deleteFrom("collector_distributions").where("description", "=", TEST_CATALOGUE_FIXTURE_NOTE).execute();
  };

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    await removeFixtures();
    const version = (distribution: string, number: string, fields: { isDefault?: boolean; deprecated?: boolean }) => ({
      distribution,
      version: number,
      label: `v${number}`,
      description: TEST_CATALOGUE_FIXTURE_NOTE,
      released_at: "2026-01-01",
      is_default: fields.isDefault ?? false,
      deprecated: fields.deprecated ?? false,
      deprecated_note: fields.deprecated ? "Retired fixture." : null,
      container_image: `example/${distribution}:${number}`,
      otelcol_contrib_version: distribution === CONTRIB ? null : "0.162.0",
      supported_components: null,
      otelcol_contrib: "{}",
      opamp_supervisor: "{}",
    });
    await ownerDb
      .insertInto("collector_distributions")
      .values([{ id: FIXTURE, label: "Fixture Build", description: TEST_CATALOGUE_FIXTURE_NOTE, icon: null, sort_order: 9, is_default: false }])
      .execute();
    await ownerDb
      .insertInto("collector_versions")
      .values([
        version(FIXTURE, FIXTURE_DEFAULT, { isDefault: true }),
        version(FIXTURE, FIXTURE_OTHER, {}),
        version(CONTRIB, RETIRED, { deprecated: true }),
      ])
      .execute();
    const offered = await ownerDb
      .selectFrom("collector_versions")
      .select(["version"])
      .where("distribution", "=", CONTRIB)
      .where("is_default", "=", true)
      .executeTakeFirstOrThrow();
    contribDefault = offered.version;
    server = await serverWith(TEST_RATE_LIMITS);
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await removeFixtures();
    await db?.destroy();
    await ownerDb?.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
    calls = [];
    hook = undefined;
    variableReads = [];
    validator.fake.takeRequests();
  });

  const validate = (
    payload: unknown,
    { on = server, from = "192.0.2.1", authorization }: { on?: FastifyInstance; from?: string; authorization?: string } = {},
  ) =>
    on.inject({
      method: "POST",
      url: ROUTE,
      remoteAddress: from,
      headers: authorization === undefined ? {} : { authorization },
      payload: payload as Record<string, unknown>,
    });

  /** The reply as the document allows it, and kept by no cache. */
  const checked = (response: LightMyRequestResponse) => {
    expect(validatePublicReply("POST", ROUTE, response.statusCode, response.json())).toEqual({ isValid: true, errors: [] });
    expect(response.headers["cache-control"]).toBe("no-store");
    return response;
  };

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string) => {
    expect([response.statusCode, response.json<{ error: { code: string } }>().error.code]).toEqual([statusCode, code]);
  };

  it("checks the text with no token, the catalog's defaults, the text alone sent (a ${org:NAME} as written, no variables read), no-store, no audit row", async () => {
    const yaml = textWith("# ${org:HOST}\n");
    const response = checked(await validate({ yaml }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true, collectorVersion: contribDefault, errors: [] });
    expect(calls).toEqual([{ distribution: CONTRIB, version: contribDefault, yaml }]);
    expect(validator.fake.takeRequests()).toEqual([{ distribution: CONTRIB, version: contribDefault, yaml }]);
    expect(variableReads).toEqual([]);
    expect(await ownerDb.selectFrom("audit_events").select("id").execute()).toEqual([]);
  });

  it("answers the collector's errors with their component paths, valid false", async () => {
    const response = checked(await validate({ yaml: textWith(`  ${REFUSED_TYPE}/edge:\n    endpoint: x\n`) }));
    expect(response.statusCode).toBe(200);
    const body = response.json<{ valid: boolean; errors: Array<{ message: string; componentPath: string | null }> }>();
    expect(body.valid).toBe(false);
    expect(body.errors).toEqual([{ message: expect.any(String), componentPath: `exporters::${REFUSED_TYPE}/edge` }]);
  });

  it("checks with a named distribution's default version, or a named version of it", async () => {
    expect(checked(await validate({ yaml: textWith(), distribution: FIXTURE })).json()).toEqual({
      valid: true,
      collectorVersion: FIXTURE_DEFAULT,
      errors: [],
    });
    expect(checked(await validate({ yaml: textWith(), distribution: FIXTURE, collectorVersion: FIXTURE_OTHER })).json()).toMatchObject({
      collectorVersion: FIXTURE_OTHER,
    });
    expect(calls.map(({ distribution, version }) => `${distribution} ${version}`)).toEqual([
      `${FIXTURE} ${FIXTURE_DEFAULT}`,
      `${FIXTURE} ${FIXTURE_OTHER}`,
    ]);
  });

  it("refuses an unknown distribution or version and a retired version with /validate's 400s, and a body the contract doesn't take, asking nothing", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ yaml: textWith(), distribution: "no-such-build" }, "collector_distribution_unknown"],
      [{ yaml: textWith(), collectorVersion: "0.0.1" }, "collector_version_unknown"],
      [{ yaml: textWith(), distribution: FIXTURE, collectorVersion: contribDefault }, "collector_version_unknown"],
      [{ yaml: textWith(), collectorVersion: RETIRED }, "collector_version_retired"],
      [{ yaml: textWith(), version: contribDefault }, "invalid_request"],
      [{ yaml: "" }, "invalid_request"],
      [{}, "invalid_request"],
      [{ yaml: textWith(), collectorVersion: "latest" }, "invalid_request"],
      [{ yaml: "a: \u0000" }, "invalid_request"],
    ];
    for (const [payload, code] of cases) expectRefusal(checked(await validate(payload)), 400, code);
    expect(calls).toEqual([]);
  });

  it("answers 503 validation_unavailable when the validator can't check the text, never valid false", async () => {
    expectRefusal(checked(await validate({ yaml: textWith(`${FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER}\n`) })), 503, "validation_unavailable");
    validator.fake.nextFault("error_500");
    expectRefusal(checked(await validate({ yaml: textWith() })), 503, "validation_unavailable");
  });

  it("answers 413 payload_too_large in the envelope past 1 MiB, asking nothing; a body under it is the contract's to refuse", async () => {
    // Over 1 MiB, under /validate's 2 MiB: the anonymous route's own limit.
    const tooLarge = checked(await validate({ yaml: "#".repeat(1024 * 1024) }));
    expectRefusal(tooLarge, 413, "payload_too_large");
    expect(tooLarge.json<{ error: { message: string } }>().error.message).toBe("The request body is too large.");
    // Just under 1 MiB: read, then refused by the text's 262,144 characters.
    expectRefusal(checked(await validate({ yaml: "#".repeat(1024 * 1024 - 20) })), 400, "invalid_request");
    expect(calls).toEqual([]);
  });

  it("admits 10 a minute per address, then 429 rate_limited with Retry-After, asking nothing; another address has its own", async () => {
    const limited = await serverWith({
      ...TEST_RATE_LIMITS,
      anonymousValidationsPerIp: RATE_LIMITS.anonymousValidationsPerIp,
      anonymousValidations: RATE_LIMITS.anonymousValidations,
    });
    const statuses: number[] = [];
    for (let request = 0; request < 10; request += 1) statuses.push((await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.10" })).statusCode);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const refused = checked(await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.10" }));
    expectRefusal(refused, 429, "rate_limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(calls).toHaveLength(10);
    expect((await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.11" })).statusCode).toBe(200);
  });

  it("counts before the catalog's reads: an unknown version spends the address's minute", async () => {
    const limited = await serverWith({ ...TEST_RATE_LIMITS, anonymousValidationsPerIp: { max: 1, windowMs: 60_000 } });
    expectRefusal(await validate({ yaml: textWith(), collectorVersion: "0.0.1" }, { on: limited, from: "192.0.2.12" }), 400, "collector_version_unknown");
    expectRefusal(await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.12" }), 429, "rate_limited");
    expect(calls).toEqual([]);
  });

  it("holds one in flight per address: a second is 429 with Retry-After 1, asking nothing; another address isn't held up", async () => {
    const gate = createGate();
    hook = async (request) => {
      if (request.yaml?.includes("# held") === true) await gate.hold();
      return validator.client.validate(request);
    };
    const first = validate({ yaml: textWith("# held\n") }, { from: "192.0.2.20" });
    await gate.reached;
    const second = checked(await validate({ yaml: textWith() }, { from: "192.0.2.20" }));
    expectRefusal(second, 429, "rate_limited");
    expect(second.headers["retry-after"]).toBe("1");
    expect((await validate({ yaml: textWith() }, { from: "192.0.2.21" })).statusCode).toBe(200);
    gate.release();
    expect((await first).statusCode).toBe(200);
    // Ended, it frees its slot, whatever its answer.
    validator.fake.nextFault("validator_busy");
    expect((await validate({ yaml: textWith() }, { from: "192.0.2.20" })).statusCode).toBe(503);
    expect((await validate({ yaml: textWith() }, { from: "192.0.2.20" })).statusCode).toBe(200);
    expect(calls).toHaveLength(4);
  });

  it("admits the overall minute's count across addresses, then refuses every address", async () => {
    const limited = await serverWith({ ...TEST_RATE_LIMITS, anonymousValidations: { max: 3, windowMs: 60_000 } });
    for (const from of ["192.0.2.30", "192.0.2.31", "192.0.2.32"]) {
      expect((await validate({ yaml: textWith() }, { on: limited, from })).statusCode).toBe(200);
    }
    for (const from of ["192.0.2.30", "192.0.2.33"]) {
      const refused = checked(await validate({ yaml: textWith() }, { on: limited, from }));
      expectRefusal(refused, 429, "rate_limited");
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    }
    expect(calls).toHaveLength(3);
  });

  it("holds four in flight overall; an overall refusal leaves the address's own minute unspent", async () => {
    const limited = await serverWith({ ...TEST_RATE_LIMITS, anonymousValidationsPerIp: { max: 1, windowMs: 60_000 } });
    const gates = [createGate(), createGate(), createGate(), createGate()];
    let held = 0;
    hook = async (request) => {
      const gate = gates[held];
      held += 1;
      await gate?.hold();
      return validator.client.validate(request);
    };
    const holding: Array<Promise<LightMyRequestResponse>> = [];
    for (const [index, from] of ["192.0.2.40", "192.0.2.41", "192.0.2.42", "192.0.2.43"].entries()) {
      holding.push(validate({ yaml: textWith() }, { on: limited, from }));
      await gates[index]!.reached;
    }
    // A fifth address, three times: refused overall, its one a minute never spent.
    for (let tries = 0; tries < 3; tries += 1) {
      const refused = checked(await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.44" }));
      expectRefusal(refused, 429, "rate_limited");
      expect(refused.headers["retry-after"]).toBe("1");
    }
    expect(calls).toHaveLength(4);
    for (const gate of gates) gate.release();
    expect((await Promise.all(holding)).map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
    expect((await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.44" })).statusCode).toBe(200);
    expect((await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.44" })).statusCode).toBe(429);
  });

  it("ignores a bearer: answered with no token check, not counted against the address's token failures", async () => {
    const limited = await serverWith({ ...TEST_RATE_LIMITS, apiTokenFailuresPerIp: { max: 1, windowMs: 60_000 } });
    const garbage = `Bearer tf_${randomBytes(32).toString("base64url")}`;
    for (let request = 0; request < 3; request += 1) {
      expect(checked(await validate({ yaml: textWith() }, { on: limited, from: "192.0.2.50", authorization: garbage })).statusCode).toBe(200);
    }
    // Had any counted, the address's one failure would be spent and this 429.
    const whoami = await limited.inject({ method: "GET", url: "/api/public/v1/whoami", remoteAddress: "192.0.2.50", headers: { authorization: garbage } });
    expectRefusal(whoami, 401, "invalid_api_token");
    expect(logLines.join("\n").includes(garbage.slice(10))).toBe(false);
  });

  describe("switched off, TELFLO_ANONYMOUS_VALIDATE's default", () => {
    /** Anonymous validate off (and the playground, which needs it), the address's limit one a minute. */
    const switchedOff = () =>
      serverWith(
        { ...TEST_RATE_LIMITS, anonymousValidationsPerIp: { max: 1, windowMs: 60_000 } },
        { site: { ...settings.site, anonymousValidate: false, playground: false } },
      );

    it("answers the root's 404 not_found, as a path nothing serves, asking nothing, logging no text", async () => {
      const off = await switchedOff();

      const response = await validate({ yaml: textWith() }, { on: off, from: "192.0.2.40" });
      const unknown = await off.inject({ method: "POST", url: "/api/v1/no-such-route", headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }, payload: {} });

      expect(response.statusCode).toBe(404);
      // sendNotFound's words, the path as the request log spells an unmatched public one: nothing names the route.
      expect(response.json()).toEqual({ error: { code: "not_found", message: "No route for POST /api/public/v1/[unmatched]" } });
      expect([unknown.statusCode, unknown.json<{ error: { code: string } }>().error.code]).toEqual([404, "not_found"]);
      expect(checked(response).statusCode).toBe(404);
      expect(calls).toEqual([]);
      expect(logLines.some((line) => line.includes(TEXT_MARKER))).toBe(false);
    });

    it("answers 404 before the body's limit and the anonymous limits count it", async () => {
      const off = await switchedOff();

      expect((await validate({ yaml: "#".repeat(1024 * 1024) }, { on: off, from: "192.0.2.41" })).statusCode).toBe(404);
      for (let request = 0; request < 3; request += 1) {
        expect((await validate({ yaml: textWith() }, { on: off, from: "192.0.2.41" })).statusCode).toBe(404);
      }
      expect(calls).toEqual([]);
    });

    it("leaves the rest of the open surface as it is: its GET is still the one 401, and the document still served", async () => {
      const off = await switchedOff();

      expectRefusal(await off.inject({ method: "GET", url: ROUTE }), 401, "invalid_api_token");
      expect((await off.inject({ method: "GET", url: "/api/public/v1/openapi.json" })).statusCode).toBe(200);
    });
  });

  it("answers a GET of its path the one 401, as any unregistered public path: only its POST is open", async () => {
    const response = await server.inject({ method: "GET", url: ROUTE });
    expectRefusal(response, 401, "invalid_api_token");
  });

  it("logs the request log's line only: never the text or the collector's words, a malformed body's and a 503's included", async () => {
    await validate({ yaml: textWith(`  ${REFUSED_TYPE}/edge:\n    endpoint: x\n`) });
    await validate({ yaml: textWith(`${FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER}\n`) });
    await validate({ yaml: textWith(), collectorVersion: "0.0.1" });
    await server.inject({
      method: "POST",
      url: ROUTE,
      headers: { "content-type": "application/json" },
      payload: `{"yaml": "${TEXT_MARKER}`,
    });
    await server.inject({ method: "POST", url: ROUTE, headers: { "content-type": "text/plain" }, payload: TEXT_MARKER });
    const joined = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(joined.includes(TEXT_MARKER)).toBe(false);
    expect(joined.includes(REFUSED_TYPE)).toBe(false);
    const entries = logLines.map((line) => JSON.parse(line) as { msg?: string; req?: { url?: string } });
    expect(entries.some((entry) => entry.req?.url === ROUTE)).toBe(true);
    expect(entries.some((entry) => entry.msg === "text validated")).toBe(false);
  });
});
