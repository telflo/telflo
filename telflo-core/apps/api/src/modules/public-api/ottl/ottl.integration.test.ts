import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { createDb, createPool, type ApiTokenAccess, type Database } from "@telflo/db";
import { addApiToken, addMembership, addServiceAccount, createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import { RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { buildServer } from "../../../server.js";
import { loadSettings, type AppSettings } from "../../../settings.js";
import { fakeOttlEvaluatorMarker } from "../../../testing/fake-ottl-evaluator.js";
import { UNCALLED_FILE_STORE } from "../../../testing/file-store.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../../testing/otelcol-validator.js";
import { useFakeOttlEvaluator } from "../../../testing/ottl-evaluator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";

/*
 * POST /api/public/v1/ottl/lint (D25 decision 17's route 16; decisions 33
 * and 53; Preflight rulings 13 and 17), on the real server through real
 * service-account tokens, with the OpenAPI-checked fake evaluator: both
 * modes (each mode's cases), the request's 400s, a YAML's 422, the evaluator's
 * 503, the person's 30 lints a minute per organization, the body's limit,
 * and every reply checked against the public OpenAPI document. Tokens are
 * built at run time and never printed: the canaries are booleans.
 */

const opamp = useFakeOpampServer();
const evaluator = useFakeOttlEvaluator();

const ROUTE = "/api/public/v1/ottl/lint";

/** An expression no log line may hold. */
const MARKER = "lint-marker-62a0";

/** A configuration for config mode, the invalid statement marked for the fake. */
const CONFIG = `
processors:
  transform:
    log_statements:
      - context: log
        statements:
          - set(attributes["env"], "prod")
          - 'set(body, "${fakeOttlEvaluatorMarker("invalid")}")'
    metric_statements:
      - convert_sum_to_gauge()
  filter:
    logs:
      log_record:
        - IsMatch(body, "debug")
connectors:
  routing:
    table:
      - context: request
        condition: request["X"] == "y"
        pipelines: [logs/a]
`;

interface LintBody {
  valid: boolean;
  ottlVersion: string | null;
  checked: number;
  items: Array<{
    kind: string;
    index: number;
    input: string;
    valid: boolean;
    error: string | null;
    context: string | null;
    location: string | null;
    note: string | null;
  }>;
  skipped: string[];
}

describe("POST /api/public/v1/ottl/lint (D25 decision 33)", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let logLines: string[] = [];
  const servers: FastifyInstance[] = [];

  async function serverWith(rateLimits: RateLimits): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: { ...UNCALLED_TESTING, ottlEvaluator: evaluator.client },
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

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = await serverWith(TEST_RATE_LIMITS);
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
    evaluator.fake.takeRequests();
  });

  /** A live token of a new service account in a new group organization, or in `organizationId`. */
  const liveToken = async (access: ApiTokenAccess = "read", organizationId?: string) => {
    let organization = organizationId;
    if (organization === undefined) {
      const admin = await createUserWithOrganization(ownerDb);
      organization = (await addMembership(ownerDb, { userId: admin.user.id, role: "admin" })).organization.id;
    }
    const at = new Date(Date.now() - 60_000);
    const { user } = await addServiceAccount(ownerDb, { organizationId: organization, createdAt: at });
    const { token } = await addApiToken(ownerDb, { organizationId: organization, serviceAccountUserId: user.id, created_at: at, access });
    return { token, organizationId: organization, userId: user.id };
  };

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  const lint = (token: string | undefined, payload: unknown, on: FastifyInstance = server) =>
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

  describe("expressions against one context (expression mode)", () => {
    it("test_lint_expressions: each verdict in order, its input echoed from the request, through a read token, no-store", async () => {
      const { token } = await liveToken("read");
      const conditions = ["severity_number >= 17", `body == "${fakeOttlEvaluatorMarker("invalid")}"`];
      const statements = ['set(attributes["a"], "b")'];
      const response = checked(await lint(token, { context: "log", conditions, statements }), token);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<LintBody>();
      expect(body).toMatchObject({ valid: false, checked: 3, ottlVersion: "v0.162.0", skipped: [] });
      expect(body.items).toEqual([
        { kind: "condition", index: 0, input: conditions[0], valid: true, error: null, context: "log", location: null, note: null },
        {
          kind: "condition",
          index: 1,
          input: conditions[1],
          valid: false,
          error: expect.stringMatching(/^OTTL syntax error: /),
          context: "log",
          location: null,
          note: null,
        },
        { kind: "statement", index: 0, input: statements[0], valid: true, error: null, context: "log", location: null, note: null },
      ]);
      expect(evaluator.fake.takeRequests()).toEqual([{ operation: "lint", body: { context: "log", conditions, statements } }]);
    });

    it("a write token may call it too; value expressions go as valueExpressions; no transform-only note outside a YAML", async () => {
      const { token } = await liveToken("write");
      const body = checked(
        await lint(token, { context: "datapoint", valueExpressions: ['attributes["route"]'], statements: ["convert_sum_to_gauge()"] }),
        token,
      ).json<LintBody>();
      expect(body.items.map(({ kind, index, valid, note }) => ({ kind, index, valid, note }))).toEqual([
        { kind: "statement", index: 0, valid: false, note: null },
        { kind: "valueExpression", index: 0, valid: true, note: null },
      ]);
    });

    it("test_unknown_context and test_request_shape: 400 invalid_request for an unknown context, no expression, no context, both modes, an unknown member, more than 200", async () => {
      const { token } = await liveToken();
      const many = (count: number) => Array.from({ length: count }, (_, at) => `attributes["k${at}"] == "v"`);
      for (const payload of [
        { context: "trace", conditions: ["true"] },
        { context: "log" },
        { context: "log", conditions: [], statements: [] },
        { conditions: ["true"] },
        { yaml: "a: 1", context: "log" },
        { yaml: "a: 1", conditions: ["true"] },
        { bogus: 1 },
        {},
        { context: "log", conditions: many(201) },
        { context: "log", conditions: many(150), statements: many(51) },
        { context: "log", conditions: ["x".repeat(8_193)] },
      ]) {
        expectRefusal(checked(await lint(token, payload), token), 400, "invalid_request");
      }
      expect(evaluator.fake.takeRequests()).toEqual([]);
      // 200 in all is taken.
      const taken = checked(await lint(token, { context: "log", conditions: many(150), statements: many(50) }), token);
      expect(taken.json<LintBody>().checked).toBe(200);
      evaluator.fake.takeRequests();
    });
  });

  describe("a collector configuration (config mode)", () => {
    it("test_lint_config_maps_locations_and_downgrades_custom_functions: YAML order, locations, contexts, the note, the skips", async () => {
      const { token } = await liveToken();
      const body = checked(await lint(token, { yaml: CONFIG }), token).json<LintBody>();
      expect(body.checked).toBe(4);
      const byLocation = new Map(body.items.map((item) => [item.location, item]));
      expect(byLocation.get("processors.transform.log_statements[0].statements[0]")).toMatchObject({ valid: true, context: "log" });
      expect(byLocation.get("processors.transform.log_statements[0].statements[1]")).toMatchObject({ valid: false, context: "log" });
      const custom = byLocation.get("processors.transform.metric_statements[0]")!;
      expect(custom).toMatchObject({ valid: true, error: null, context: "datapoint", input: "convert_sum_to_gauge()" });
      expect(custom.note).toContain("convert_sum_to_gauge");
      expect(byLocation.get("processors.filter.logs.log_record[0]")).toMatchObject({ context: "log", valid: true });
      expect(body.valid).toBe(false);
      expect(body.skipped.some((entry) => entry.includes("request"))).toBe(true);
      // The YAML's order, the indexes sequential.
      expect(body.items.map((item) => item.index)).toEqual([0, 1, 2, 3]);
      expect(body.items[0]!.location!.startsWith("processors.transform.log_statements")).toBe(true);
      // One evaluator call per context, in the order each first appears.
      expect(evaluator.fake.takeRequests().map(({ body: sent }) => (sent as { context: string }).context)).toEqual(["log", "datapoint"]);
    });

    it("notes a flat transform statement's inferred context", async () => {
      const { token } = await liveToken();
      const body = checked(await lint(token, { yaml: 'processors:\n  transform:\n    trace_statements:\n      - set(name, "x")\n' }), token).json<LintBody>();
      expect(body.items).toEqual([
        {
          kind: "statement",
          index: 0,
          input: 'set(name, "x")',
          valid: true,
          error: null,
          context: "span",
          location: "processors.transform.trace_statements[0]",
          note: "context inferred as 'span' (flat transform statement); a path error here may be a false positive",
        },
      ]);
    });

    it("test_lint_config_with_no_ottl_is_valid_and_empty, asking the evaluator nothing and spending no lint", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, ottlLintsPerUser: { max: 1, windowMs: 60_000 } });
      const { token } = await liveToken();
      for (let request = 0; request < 3; request += 1) {
        const response = checked(await lint(token, { yaml: "receivers: {otlp: {}}\nprocessors: {batch: {}}\n" }, limited), token);
        expect(response.json()).toEqual({ valid: true, ottlVersion: null, checked: 0, items: [], skipped: [] });
      }
      expect(evaluator.fake.takeRequests()).toEqual([]);
    });

    it("test_lint_config_bad_yaml: 422 configuration_invalid for a YAML that doesn't parse or isn't a mapping, its reason in fixed words", async () => {
      const { token } = await liveToken();
      for (const [yaml, reason] of [
        [`a: [unclosed ${MARKER}`, "The YAML doesn't parse."],
        ["- just\n- a list\n", "The YAML must be a collector configuration (a mapping)."],
        ["a: 1\na: 2\n", "The YAML doesn't parse."],
      ] as const) {
        const response = checked(await lint(token, { yaml }), token);
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({
          error: { code: "configuration_invalid", message: "The configuration is not valid.", details: { errors: [{ message: reason, componentPath: null }] } },
        });
      }
      expect(evaluator.fake.takeRequests()).toEqual([]);
    });

    it("answers a YAML's expression over 8,192 characters as its item's error and sends the rest, its indexes kept (Ruling 168)", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, ottlLintsPerUser: { max: 1, windowMs: 60_000 } });
      const { token } = await liveToken();
      const long = `name == "${"x".repeat(9_000)}"`;
      const yaml = `processors:\n  filter:\n    traces:\n      span:\n        - name == "a"\n        - '${long}'\n        - name == "b"\n`;
      const response = checked(await lint(token, { yaml }, limited), token);
      expect(response.statusCode).toBe(200);
      const body = response.json<LintBody>();
      expect(body.items.map(({ index, location, valid, error }) => ({ index, location, valid, error }))).toEqual([
        { index: 0, location: "processors.filter.traces.span[0]", valid: true, error: null },
        { index: 1, location: "processors.filter.traces.span[1]", valid: false, error: "The condition is longer than 8,192 bytes." },
        { index: 2, location: "processors.filter.traces.span[2]", valid: true, error: null },
      ]);
      expect(body.items[1]!.input === long).toBe(true);
      expect(evaluator.fake.takeRequests()).toEqual([{ operation: "lint", body: { context: "span", conditions: ['name == "a"', 'name == "b"'] } }]);
      // One lint spent, as one evaluator call made.
      expectRefusal(await lint(token, { yaml }, limited), 429, "rate_limited");
    });

    it("refuses a configuration holding more than 200 expressions with 400 invalid_request, asking nothing", async () => {
      const { token } = await liveToken();
      const conditions = Array.from({ length: 201 }, (_, at) => `        - name == "n${at}"`).join("\n");
      expectRefusal(checked(await lint(token, { yaml: `processors:\n  filter:\n    traces:\n      span:\n${conditions}\n` }), token), 400, "invalid_request");
      expect(evaluator.fake.takeRequests()).toEqual([]);
    });
  });

  describe("the evaluator, the limits and the log", () => {
    it("test_evaluator_unreachable and its kin: 503 ottl_lint_unavailable whatever the evaluator's failure, never a verdict", async () => {
      const { token } = await liveToken();
      expectRefusal(checked(await lint(token, { context: "log", conditions: [fakeOttlEvaluatorMarker("unavailable")] }), token), 503, "ottl_lint_unavailable");
      for (const fault of ["evaluator_busy", "invalid_request", "error_500", "reset", "missing_result"] as const) {
        evaluator.fake.nextFault(fault);
        const response = checked(await lint(token, { context: "log", conditions: ["true", "false"] }), token);
        expect(response.json()).toEqual({ error: { code: "ottl_lint_unavailable", message: "OTTL lint is unavailable right now. Try again shortly." } });
      }
      // A YAML's second context failing fails the whole lint.
      evaluator.fake.nextFault("error_500");
      expectRefusal(checked(await lint(token, { yaml: CONFIG }), token), 503, "ottl_lint_unavailable");
      evaluator.fake.takeRequests();
    });

    it("spends the token's user's 30 lints a minute in its organization, then 429 rate_limited with Retry-After; another organization's are its own", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, ottlLintsPerUser: RATE_LIMITS.ottlLintsPerUser });
      const { token, organizationId } = await liveToken();
      const statuses: number[] = [];
      for (let request = 0; request < 30; request += 1) statuses.push((await lint(token, { context: "log", conditions: ["true"] }, limited)).statusCode);
      expect(statuses.every((status) => status === 200)).toBe(true);
      const refused = checked(await lint(token, { context: "log", conditions: ["true"] }, limited), token);
      expectRefusal(refused, 429, "rate_limited");
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
      // A YAML lint spends the same budget.
      expectRefusal(await lint(token, { yaml: CONFIG }, limited), 429, "rate_limited");
      // Another service account in the same organization, and one elsewhere: their own.
      expect((await lint((await liveToken("read", organizationId)).token, { context: "log", conditions: ["true"] }, limited)).statusCode).toBe(200);
      expect((await lint((await liveToken()).token, { context: "log", conditions: ["true"] }, limited)).statusCode).toBe(200);
      expect(RATE_LIMITS.ottlLintsPerUser).toEqual({ max: 30, windowMs: 60_000 });
      evaluator.fake.takeRequests();
    });

    it("answers the one 401 without a token, and 413 past its 2 MiB body, asking nothing", async () => {
      const anonymous = await lint(undefined, { context: "log", conditions: ["true"] });
      expectRefusal(anonymous, 401, "invalid_api_token");
      expect(validatePublicReply("POST", ROUTE, 401, anonymous.json()).isValid).toBe(true);
      const { token } = await liveToken();
      expectRefusal(checked(await lint(token, { yaml: "#".repeat(2 * 1024 * 1024 + 1) }), token), 413, "payload_too_large");
      expect(evaluator.fake.takeRequests()).toEqual([]);
    });

    it("logs the organization's id, the mode, counts and the result only: never an expression, the YAML or the evaluator's words", async () => {
      const { token, organizationId } = await liveToken();
      await lint(token, { context: "log", conditions: [`body == "${MARKER}"`, `${MARKER} == "${fakeOttlEvaluatorMarker("invalid")}"`] });
      await lint(token, { yaml: `processors:\n  filter:\n    logs:\n      log_record:\n        - body == "${MARKER}"\n` });
      await lint(token, { yaml: `a: [${MARKER}` });
      evaluator.fake.nextFault("error_500");
      await lint(token, { context: "log", conditions: [MARKER] });
      const joined = logLines.join("\n");
      expect(holdsToken(joined, token)).toBe(false);
      expect(joined.includes(MARKER)).toBe(false);
      expect(joined.includes("OTTL syntax error")).toBe(false);
      const linted = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.msg === "OTTL linted" || entry.msg === "the OTTL evaluator couldn't lint")
        .map(({ level, time: _time, pid: _pid, hostname: _hostname, reqId: _reqId, msg: _msg, ...fields }) => ({ level, ...fields }));
      expect(linted).toEqual([
        { level: 30, organizationId, mode: "expressions", checked: 2, result: "invalid" },
        { level: 30, organizationId, mode: "configuration", checked: 1, skipped: 0, result: "valid" },
        { level: 40, organizationId, mode: "expressions", result: "unavailable", reason: "server_error", status: 500 },
      ]);
      evaluator.fake.takeRequests();
    });
  });
});
