import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type ApiTokenAccess, type Database } from "@telflo/db";
import {
  addApiToken,
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  TEST_CATALOGUE_FIXTURE_NOTE,
  truncateAll,
} from "@telflo/db/testing";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { buildServer } from "../../../server.js";
import { loadSettings, type AppSettings } from "../../../settings.js";
import { FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER } from "../../../testing/fake-otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { useFakeOtelcolValidator } from "../../../testing/otelcol-validator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";

/*
 * POST /api/public/v1/validate, on the real server through real
 * service-account tokens, with the OpenAPI-checked fake validator: the
 * catalogue's defaults, a named distribution and version, the catalogue's
 * three 400s, the validator's 503, the organization's variables' 503, the
 * person's validation limit, the body's limit, and every reply checked
 * against the public OpenAPI document. Its distributions of its own and its
 * deprecated versions are fixture rows it adds to the test database's
 * catalogue and removes (as the public configurations' tests add a retired
 * version), each marked TEST_CATALOGUE_FIXTURE_NOTE, so a run cut short
 * leaves nothing the next run's global setup doesn't remove before its
 * catalogue sync. It used to run on a throwaway database: dropping one
 * forces a checkpoint that took 5 to 11 s after the other public-api files
 * had written, past its after-hook's limit under load (the suite failing
 * with no failing test). Tokens are built at run time and never printed: the
 * canaries are booleans.
 */

const opamp = useFakeOpampServer();
const validator = useFakeOtelcolValidator();

const ROUTE = "/api/public/v1/validate";

const CONTRIB = "otelcol-contrib";
/** Every fixture distribution's id starts so; every fixture row's description is the test-only mark. */
const FIXTURE_PREFIX = "public-validate-fixture-";
const FIXTURE_NOTE = TEST_CATALOGUE_FIXTURE_NOTE;
const runId = randomUUID().slice(0, 8);
/** A Contrib version this file deprecates, and a fixture distribution with its two versions. */
const RETIRED = `0.1.${parseInt(runId, 16)}`;
const FIXTURE = `${FIXTURE_PREFIX}${runId}`;
const FIXTURE_DEFAULT = "9.9.1";
const FIXTURE_OTHER = "9.9.0";
/** A distribution with no default: one offered version that isn't the default, and a deprecated one. */
const NO_DEFAULT = `${FIXTURE_PREFIX}no-default-${runId}`;
const NO_DEFAULT_OFFERED = "8.0.0";
const NO_DEFAULT_RETIRED = "7.0.0";

/** A text no log line may hold, and a component the fake refuses. */
const TEXT_MARKER = "validate-text-marker-41c7";
const REFUSED_TYPE = "unknown_validatemarker";
const textWith = (extra = "") => `receivers:\n  otlp:\n    protocols:\n      grpc: {}\n# ${TEXT_MARKER}\nexporters:\n  debug: {}\n${extra}`;

describe("POST /api/public/v1/validate", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let contribDefault: string;
  let logLines: string[] = [];
  const servers: FastifyInstance[] = [];

  async function serverWith(rateLimits: RateLimits): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: validator.client,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
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

  /** Removes every fixture row of this file's, this run's and any run's cut short. */
  const removeFixtures = async () => {
    await ownerDb.deleteFrom("collector_versions").where("description", "=", FIXTURE_NOTE).execute();
    await ownerDb.deleteFrom("collector_versions").where("distribution", "like", `${FIXTURE_PREFIX}%`).execute();
    await ownerDb.deleteFrom("collector_distributions").where("id", "like", `${FIXTURE_PREFIX}%`).execute();
    await ownerDb.deleteFrom("collector_distributions").where("description", "=", FIXTURE_NOTE).execute();
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
      description: FIXTURE_NOTE,
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
      .values([
        { id: FIXTURE, label: "Fixture Build", description: FIXTURE_NOTE, icon: null, sort_order: 9, is_default: false },
        { id: NO_DEFAULT, label: "No Default Build", description: FIXTURE_NOTE, icon: null, sort_order: 10, is_default: false },
      ])
      .execute();
    await ownerDb
      .insertInto("collector_versions")
      .values([
        version(FIXTURE, FIXTURE_DEFAULT, { isDefault: true }),
        version(FIXTURE, FIXTURE_OTHER, {}),
        version(CONTRIB, RETIRED, { deprecated: true }),
        version(NO_DEFAULT, NO_DEFAULT_OFFERED, {}),
        version(NO_DEFAULT, NO_DEFAULT_RETIRED, { deprecated: true }),
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
    validator.fake.takeRequests();
  });

  /** A live token of a new service account in a new group organization. */
  const liveToken = async (access: ApiTokenAccess = "read") => {
    const admin = await createUserWithOrganization(ownerDb);
    const { organization } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const at = new Date(Date.now() - 60_000);
    const { user } = await addServiceAccount(ownerDb, { organizationId: organization.id, createdAt: at });
    const { token } = await addApiToken(ownerDb, { organizationId: organization.id, serviceAccountUserId: user.id, created_at: at, access });
    return { token, organizationId: organization.id };
  };

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  const validate = (token: string | undefined, payload: unknown, on: FastifyInstance = server) =>
    on.inject({
      method: "POST",
      url: ROUTE,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  /** The reply, after the canary: it never holds the token, and the document allows it. */
  const checked = (response: LightMyRequestResponse, token: string) => {
    expect(holdsToken(response.body, token)).toBe(false);
    expect(validatePublicReply("POST", ROUTE, response.statusCode, response.json())).toEqual({ isValid: true, errors: [] });
    return response;
  };

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  it("checks the text with the catalogue's default distribution and version, through a read token, no-store, stored nowhere", async () => {
    const { token, organizationId } = await liveToken("read");
    const response = checked(await validate(token, { yaml: textWith() }), token);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ valid: true, collectorVersion: contribDefault, errors: [] });
    expect(validator.fake.takeRequests()).toEqual([{ distribution: CONTRIB, version: contribDefault, yaml: textWith() }]);
    expect(await ownerDb.selectFrom("audit_events").select("id").where("organization_id", "=", organizationId).execute()).toEqual([]);
  });

  it("answers the collector's errors with their component paths, valid false; a write token may call it too", async () => {
    const { token } = await liveToken("write");
    const response = checked(await validate(token, { yaml: textWith(`  ${REFUSED_TYPE}/edge:\n    endpoint: x\n`) }), token);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ valid: boolean; errors: Array<{ message: string; componentPath: string | null }> }>();
    expect(body.valid).toBe(false);
    expect(body.errors).toEqual([{ message: expect.any(String), componentPath: `exporters::${REFUSED_TYPE}/edge` }]);
  });

  it("checks with a named distribution's default version, or a named version of it", async () => {
    const { token } = await liveToken();
    expect(checked(await validate(token, { yaml: textWith(), distribution: FIXTURE }), token).json()).toEqual({
      valid: true,
      collectorVersion: FIXTURE_DEFAULT,
      errors: [],
    });
    expect(checked(await validate(token, { yaml: textWith(), distribution: FIXTURE, collectorVersion: FIXTURE_OTHER }), token).json()).toMatchObject(
      { collectorVersion: FIXTURE_OTHER },
    );
    expect(validator.fake.takeRequests().map(({ distribution, version }) => `${distribution} ${version}`)).toEqual([
      `${FIXTURE} ${FIXTURE_DEFAULT}`,
      `${FIXTURE} ${FIXTURE_OTHER}`,
    ]);
  });

  it("refuses a distribution or version the catalogue doesn't have, and a retired version, with 400, asking nothing", async () => {
    const { token } = await liveToken();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ distribution: "no-such-build" }, "collector_distribution_unknown"],
      [{ collectorVersion: "0.0.1" }, "collector_version_unknown"],
      [{ distribution: FIXTURE, collectorVersion: contribDefault }, "collector_version_unknown"],
      [{ collectorVersion: RETIRED }, "collector_version_retired"],
    ];
    for (const [fields, code] of cases) {
      expectRefusal(checked(await validate(token, { yaml: textWith(), ...fields }), token), 400, code);
    }
    expect(validator.fake.takeRequests()).toEqual([]);
  });

  it("checks a distribution's existence and the named version's state directly: one with no default answers by its versions", async () => {
    const { token } = await liveToken();
    expect(checked(await validate(token, { yaml: textWith(), distribution: NO_DEFAULT, collectorVersion: NO_DEFAULT_OFFERED }), token).json()).toEqual({
      valid: true,
      collectorVersion: NO_DEFAULT_OFFERED,
      errors: [],
    });
    expectRefusal(checked(await validate(token, { yaml: textWith(), distribution: NO_DEFAULT, collectorVersion: NO_DEFAULT_RETIRED }), token), 400, "collector_version_retired");
    expectRefusal(checked(await validate(token, { yaml: textWith(), distribution: NO_DEFAULT, collectorVersion: FIXTURE_DEFAULT }), token), 400, "collector_version_unknown");
    // A default is needed only when the version is left out.
    expectRefusal(checked(await validate(token, { yaml: textWith(), distribution: NO_DEFAULT }), token), 400, "collector_distribution_unknown");
    expectRefusal(checked(await validate(token, { yaml: textWith(), distribution: "no-such-build", collectorVersion: FIXTURE_DEFAULT }), token), 400, "collector_distribution_unknown");
    expect(validator.fake.takeRequests().map(({ distribution, version }) => `${distribution} ${version}`)).toEqual([`${NO_DEFAULT} ${NO_DEFAULT_OFFERED}`]);
  });

  it("refuses a body the contract doesn't take with 400 invalid_request: an unknown member, an empty or missing text, a malformed version", async () => {
    const { token } = await liveToken();
    for (const payload of [
      { yaml: textWith(), version: contribDefault },
      { yaml: "" },
      {},
      { yaml: textWith(), collectorVersion: "latest" },
      { yaml: textWith(), distribution: "Not A Build" },
      { yaml: "a: \u0000" },
    ]) {
      expectRefusal(checked(await validate(token, payload), token), 400, "invalid_request");
    }
    expect(validator.fake.takeRequests()).toEqual([]);
  });

  it("answers 503 validation_unavailable when the validator can't check the text, never valid false", async () => {
    const { token } = await liveToken();
    expectRefusal(checked(await validate(token, { yaml: textWith(`${FAKE_OTELCOL_VALIDATOR_UNAVAILABLE_MARKER}\n`) }), token), 503, "validation_unavailable");
    validator.fake.nextFault("error_500");
    expectRefusal(checked(await validate(token, { yaml: textWith() }), token), 503, "validation_unavailable");
  });

  it("sends the organization's values for the names the text references to the validator, and only those", async () => {
    const { token, organizationId } = await liveToken();
    expect(["created", "unchanged"]).toContain((await opamp.client.createOrganization({ id: organizationId, name: "an organization" })).kind);
    for (const [name, value] of [["HOST", "otel.example:4317"], ["UNUSED", "never sent"]] as const) {
      expect((await opamp.client.createVariable(organizationId, { id: randomUUID(), name, value, description: null, actor: null })).kind).toBe("created");
    }
    const yaml = textWith("# ${org:HOST}\n");
    expect(checked(await validate(token, { yaml }), token).statusCode).toBe(200);
    expect(validator.fake.takeRequests()).toEqual([
      { distribution: CONTRIB, version: contribDefault, yaml, organizationVariables: { HOST: "otel.example:4317" } },
    ]);
    expect(logLines.some((line) => line.includes("otel.example"))).toBe(false);
  });

  it("answers 503 variables_unavailable when the organization's variables the text references can't be read, asking nothing", async () => {
    const { token, organizationId } = await liveToken();
    expect(["created", "unchanged"]).toContain((await opamp.client.createOrganization({ id: organizationId, name: "an organization" })).kind);
    opamp.fake.nextFault("error_500", "listVariables");
    expectRefusal(checked(await validate(token, { yaml: textWith("# ${org:HOST}\n") }), token), 503, "variables_unavailable");
    expect(validator.fake.takeRequests()).toEqual([]);
  });

  it("spends the token's user's validations: 60 a minute, then 429 validation_rate_limited with Retry-After", async () => {
    const limited = await serverWith({ ...TEST_RATE_LIMITS, validationsPerUser: RATE_LIMITS.validationsPerUser });
    const { token } = await liveToken();
    const statuses: number[] = [];
    for (let request = 0; request < 60; request += 1) statuses.push((await validate(token, { yaml: textWith() }, limited)).statusCode);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const refused = checked(await validate(token, { yaml: textWith() }, limited), token);
    expectRefusal(refused, 429, "validation_rate_limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // Another service account's token is another person: its own budget.
    const other = await liveToken();
    expect((await validate(other.token, { yaml: textWith() }, limited)).statusCode).toBe(200);
    validator.fake.takeRequests();
  });

  it("answers the one 401 without a token, and 413 past its 2 MiB body, asking nothing", async () => {
    const anonymous = await validate(undefined, { yaml: textWith() });
    expectRefusal(anonymous, 401, "invalid_api_token");
    expect(validatePublicReply("POST", ROUTE, 401, anonymous.json()).isValid).toBe(true);
    const { token } = await liveToken();
    const tooLarge = checked(await validate(token, { yaml: "#".repeat(2 * 1024 * 1024 + 1) }), token);
    expectRefusal(tooLarge, 413, "payload_too_large");
    expect(validator.fake.takeRequests()).toEqual([]);
  });

  it("logs ids, the version and the result only: never the text or the collector's words", async () => {
    const { token, organizationId } = await liveToken();
    await validate(token, { yaml: textWith(`  ${REFUSED_TYPE}/edge:\n    endpoint: x\n`) });
    const joined = logLines.join("\n");
    expect(holdsToken(joined, token)).toBe(false);
    expect(joined.includes(TEXT_MARKER)).toBe(false);
    expect(joined.includes(REFUSED_TYPE)).toBe(false);
    const validated = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.msg === "text validated");
    expect(validated).toHaveLength(1);
    const { level, time: _time, pid: _pid, hostname: _hostname, reqId: _reqId, msg: _msg, ...fields } = validated[0]!;
    expect(level).toBe(30);
    expect(fields).toEqual({ organizationId, distribution: CONTRIB, collectorVersion: contribDefault, result: "invalid" });
  });
});
