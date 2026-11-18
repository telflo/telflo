import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
  VALIDATION_RULE_LIMIT_MESSAGE,
  validationPipelineExistsMessage,
} from "@telflo/contracts";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addValidationPipeline,
  addValidationRule,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  withFailingInsert,
  type TestDatabases,
} from "@telflo/db/testing";
import { createDb, type Database, type OrganizationRole } from "@telflo/db";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { OttlEvaluatorClient } from "../../ottl-evaluator/client.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { fakeOttlEvaluatorMarker } from "../../testing/fake-ottl-evaluator.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_OTTL_EVALUATOR, useFakeOttlEvaluator } from "../../testing/ottl-evaluator.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs (D11b decision 8), and the OTTL
// evaluator's OpenAPI-checked fake (D15a Task 5): this file's own.
const opamp = useFakeOpampServer();
const evaluator = useFakeOttlEvaluator();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** Markers no log line, URL or audit row may hold: a rule's name, description, pattern and OTTL (ADR 0024). */
const NAME_MARKER = "rule-name-marker-5c1e";
const DESCRIPTION_MARKER = "rule-description-marker-8a7d";
const PATTERN_MARKER = "rule-pattern-marker-2f90";
const CONDITION_MARKER = "rule-condition-marker-77b3";

/** The fake evaluator's words for a rule its `invalid` marker names (fake-ottl-evaluator.ts's invalidMessage). */
const OTTL_SYNTAX_ERROR = 'OTTL syntax error: 1:1: unexpected token "fake-ottl-evaluator" (fake)';
const INVALID_REGEX = "Invalid regex: error parsing regexp: missing closing ): `(fake-ottl-evaluator` (fake)";

/** The words, exactly. */
const MESSAGES = {
  organizationNotFound: "Organization not found",
  configurationNotFound: "Configuration not found",
  versionNotFound: "Version not found",
  pipelineNotFound: "Validation pipeline not found",
  ruleNotFound: "Validation rule not found",
  invalid: "The request was not valid.",
  termsRequired: "Accept the current Terms of Service to continue.",
  rateLimited: "Too many rule checks in the last minute. Try again shortly.",
};

/** A race's own timeout: generous, and well past LOCK_WAIT_HANG_GUARD, so a hung wait ends there first. */
const LOCK_RACE_TIMEOUT = 30_000;

/** The one wall-clock limit of a wait on a condition: a hang guard only, never a pause. */
const LOCK_WAIT_HANG_GUARD = 10_000;

/** The application name of the one-connection pool's backend, which pg_stat_activity shows. */
const ONE_CONNECTION_APPLICATION_NAME = "validation-pipelines-one-connection";

/** Ana's Record attribute rule, as its builder saves it (spec's story): canonical OTTL. */
const ATTRIBUTE_RULE = {
  kind: "ottl",
  target: "output",
  ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' },
};

/** A Record count rule, as its builder saves it. */
const COUNT_RULE = {
  kind: "ottl",
  target: "output",
  ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "between", value: 1, value2: 10 } },
};

/** Ana's SSN rule (spec's story). */
const SSN_RULE = { kind: "not_contains_regex", target: "output", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" };

/** A rule whose condition the fake evaluator finds broken, in its words. */
const BROKEN_CONDITION = `attributes["env"] == "prod" and body == "${fakeOttlEvaluatorMarker("invalid")}"`;

/*
 * D15a Task 6: the validation pipelines and rules API (decisions 5, 6, 12,
 * 13, 16, 17 and 28; details 24 and 25; Preflight rulings 16, 19, 20 and
 * 24), against Postgres as the API's own role, with the OTTL evaluator's
 * fake (its markers steer its answers, nextFault queues failures).
 */
describe("the validation pipelines and rules API", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  /** A server whose evaluator rejects any call: a save that reaches it fails with a 500. */
  let uncalled: FastifyInstance;
  const servers: FastifyInstance[] = [];
  let logLines: string[] = [];
  /** The API's clock, which each test moves on by hand. */
  let clock = new Date();
  const tick = () => {
    clock = new Date(clock.getTime() + 60_000);
    return clock;
  };

  /** A server on the test database, logging every line to `logLines`. */
  async function serverWith(
    options: { rateLimits?: RateLimits; ottlEvaluator?: OttlEvaluatorClient; db?: Kysely<Database> } = {},
  ): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: { ...UNCALLED_TESTING, ottlEvaluator: options.ottlEvaluator ?? evaluator.client },
        settings: loadSettings(process.env),
        db: options.db ?? databases.db,
        now: () => new Date(clock.getTime()),
        mailer: createInMemoryMailer(),
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
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
    databases = openTestDatabases();
    passwordHash = await hashPassword(PASSWORD);
    server = await serverWith();
    uncalled = await serverWith({ ottlEvaluator: UNCALLED_OTTL_EVALUATOR });
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    logLines = [];
    evaluator.fake.takeRequests();
    clock = new Date(Date.UTC(2026, 9, 11, 9, 0, 0));
  });

  afterEach(() => {
    // The platform sent the fake nothing the evaluator's contract refuses.
    expect(evaluator.fake.takeViolations()).toEqual([]);
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  interface Person {
    userId: string;
    organizationId: string;
    access: string;
  }

  /** A signed-in person active in a group organization (a new one unless given), as `role`. */
  const member = async (organizationId?: string, role: OrganizationRole = "admin"): Promise<Person> => {
    const ownerDb = databases.ownerDb;
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const signedIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: cookieValue(signedIn, "telflo_access") },
      payload: { organizationId: organization.id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return { userId: account.user.id, organizationId: organization.id, access: (switched.headers["set-cookie"] === undefined ? cookieValue(signedIn, "telflo_access") : cookieValue(switched, "telflo_access")) };
  };

  /** Ana and Ben in one group organization, and Cara in another. */
  const team = async () => {
    const ana = await member();
    const ben = await member(ana.organizationId, "contributor");
    const cara = await member();
    return { ana, ben, cara };
  };

  /** A configuration `author` created, a draft unless `published`, with its version 1 and a draft version 2. */
  const configurationOf = async (author: Person, options: { published?: boolean } = {}) => {
    const ownerDb = databases.ownerDb;
    const configuration = await addConfiguration(ownerDb, {
      organizationId: author.organizationId,
      created_by_user_id: author.userId,
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: author.organizationId,
      created_by_user_id: author.userId,
      ...(options.published ? { publishedAt: new Date() } : {}),
    });
    const v2 = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: author.organizationId,
      version_number: 2,
      created_by_user_id: author.userId,
    });
    return {
      organizationId: author.organizationId,
      configurationId: configuration.id,
      versionId: version.id,
      v2: v2.id,
    };
  };
  type Target = Awaited<ReturnType<typeof configurationOf>>;

  /** Publishes `target`'s version 1, as a publish would. */
  const publish = (target: Target, by: Person) =>
    databases.ownerDb
      .updateTable("configuration_versions")
      .set({ published_at: new Date(), publication_id: randomUUID(), published_by_user_id: by.userId })
      .where("id", "=", target.versionId)
      .execute();

  type PathOptions = { organizationId?: string; versionId?: string };
  const pipelinesPath = (target: Target, options: PathOptions = {}) =>
    `/api/v1/organizations/${options.organizationId ?? target.organizationId}/configurations/${target.configurationId}` +
    `/versions/${options.versionId ?? target.versionId}/validation-pipelines`;
  const pipelinePath = (target: Target, pipelineId: string, options: PathOptions = {}) =>
    `${pipelinesPath(target, options)}/${pipelineId}`;
  const rulesPath = (target: Target, pipelineId: string, options: PathOptions = {}) =>
    `${pipelinePath(target, pipelineId, options)}/rules`;
  const rulePath = (target: Target, pipelineId: string, ruleId: string, options: PathOptions = {}) =>
    `${rulesPath(target, pipelineId, options)}/${ruleId}`;

  const call = (
    person: Person | undefined,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    options: { on?: FastifyInstance } = {},
  ) =>
    (options.on ?? server).inject({
      method,
      url,
      headers: csrfHeaders,
      ...(person === undefined ? {} : { cookies: { telflo_access: person.access } }),
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message: string): void {
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: statusCode,
      body: { error: { code, message } },
    });
  }

  /** A body the contract refuses: 400 `invalid_request`. */
  function expectInvalid(response: LightMyRequestResponse): void {
    expect({ status: response.statusCode, error: response.json<{ error: Record<string, unknown> }>().error }).toMatchObject({
      status: 400,
      error: { code: "invalid_request", message: MESSAGES.invalid },
    });
  }

  /** The evaluator's refusal: 400 `validation_rule_invalid`, its words as they are, with the field each is about. */
  function expectRuleInvalid(response: LightMyRequestResponse, field: string, message: string): void {
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: { error: { code: "validation_rule_invalid", message, details: { problems: [{ field, message }] } } },
    });
  }

  interface PipelineBody {
    id: string;
    configurationId: string;
    versionId: string;
    pipeline: string;
    signal: string;
    createdByUserId: string | null;
    createdAt: string;
  }

  interface RuleBody {
    id: string;
    validationPipelineId: string;
    position: number;
    kind: string;
    target: string;
    pattern: string | null;
    ottl: Record<string, unknown> | null;
    name: string;
    description: string;
    createdByUserId: string | null;
    createdAt: string;
    updatedAt: string;
  }

  /** A validation pipeline `person` creates on `target`'s version 1 (or `versionId`), through the API. */
  const createdPipeline = async (person: Person, target: Target, pipeline = "logs/default", options: PathOptions = {}) => {
    const response = await call(person, "POST", pipelinesPath(target, options), { pipeline });
    expect(response.statusCode).toBe(201);
    return response.json<{ validationPipeline: PipelineBody }>().validationPipeline;
  };

  /** A rule `person` creates in `pipelineId` on `target`, through the API. */
  const createdRule = async (person: Person, target: Target, pipelineId: string, body: Record<string, unknown>) => {
    const response = await call(person, "POST", rulesPath(target, pipelineId), body);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ rule: RuleBody }>().rule;
  };

  const auditRows = (prefix: string) =>
    databases.ownerDb
      .selectFrom("audit_events")
      .selectAll()
      .where("action", "like", `${prefix}%`)
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  const ruleRows = () =>
    databases.ownerDb.selectFrom("validation_rules").selectAll().orderBy("validation_pipeline_id").orderBy("position").execute();

  /** The validate requests the fake read since the last call. */
  const validations = () => evaluator.fake.takeRequests().filter((request) => request.operation === "validate");

  /** A request under way, and whether it has finished. */
  const started = (request: Promise<LightMyRequestResponse>) => {
    const tracked = { isSettled: false, response: request };
    const settle = () => {
      tracked.isSettled = true;
    };
    request.then(settle, settle);
    return tracked;
  };

  /**
   * Resolves with how many of the API's backends wait on a lock once each
   * of `requests` waits on one or has finished: a condition, polled with no
   * pause. A request that never blocks finishes, and the caller's
   * assertions catch it. LOCK_WAIT_HANG_GUARD alone ends a wait that never
   * comes, before the test's own timeout, so the holder rolls back first.
   */
  const untilEachWaitsOrSettles = async (requests: Array<{ isSettled: boolean }>): Promise<number> => {
    const deadline = Date.now() + LOCK_WAIT_HANG_GUARD;
    for (;;) {
      const settled = requests.filter((request) => request.isSettled).length;
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting
          from pg_stat_activity
         where datname = current_database()
           and usename = 'telflo_platform'
           and wait_event_type = 'Lock'
      `.execute(databases.ownerDb);
      const waiting = rows[0]!.waiting;
      if (waiting + settled >= requests.length) return waiting;
      if (Date.now() > deadline) {
        throw new Error(`of ${requests.length} requests, ${waiting} waited on a lock and ${settled} finished`);
      }
    }
  };

  /** `count` rules seeded in `pipelineId` as the tables' owner, at positions 1 to `count`. */
  const seedRules = (target: Target, pipelineId: string, count: number, by: Person) =>
    sql`
      insert into validation_rules (organization_id, configuration_id, configuration_version_id, validation_pipeline_id,
                                    position, kind, target, pattern, created_by_user_id, created_at, updated_at)
      select ${target.organizationId}, ${target.configurationId}, ${target.versionId}, ${pipelineId},
             n, 'contains_text', 'output', 'seeded ' || n, ${by.userId}, now(), now()
        from generate_series(1, ${count}::integer) as n
    `.execute(databases.ownerDb);

  describe("validation pipelines", () => {
    it("creates a validation pipeline (201), its signal its name's first part, its creator the caller at the API's clock, with an audit row of ids", async () => {
      const ana = await member();
      const target = await configurationOf(ana);

      const response = await call(ana, "POST", pipelinesPath(target), { pipeline: "traces/app" });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const pipeline = response.json<{ validationPipeline: PipelineBody }>().validationPipeline;
      expect(pipeline).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        configurationId: target.configurationId,
        versionId: target.versionId,
        pipeline: "traces/app",
        signal: "traces",
        createdByUserId: ana.userId,
        createdAt: clock.toISOString(),
      });
      expect(await auditRows("validation_pipeline.")).toEqual([
        expect.objectContaining({
          action: "validation_pipeline.created",
          actor_user_id: ana.userId,
          organization_id: ana.organizationId,
          subject_type: "validation_pipeline",
          subject_id: pipeline.id,
          metadata: { configurationId: target.configurationId, versionId: target.versionId },
        }),
      ]);
      expect(validations()).toEqual([]);
    });

    it("refuses a second validation pipeline for one YAML pipeline (409 validation_pipeline_exists, decision 24's words); another version and another pipeline still take one", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const first = await createdPipeline(ana, target, "logs/default");

      expectRefusal(
        await call(ana, "POST", pipelinesPath(target), { pipeline: "logs/default" }),
        409,
        "validation_pipeline_exists",
        validationPipelineExistsMessage("logs/default"),
      );
      expect(validationPipelineExistsMessage("logs/default")).toBe(
        'Pipeline "logs/default" already has a validation pipeline for this version.',
      );
      await createdPipeline(ana, target, "logs/default", { versionId: target.v2 });
      await createdPipeline(ana, target, "logs");
      const listed = (await call(ana, "GET", pipelinesPath(target))).json<{ validationPipelines: PipelineBody[] }>();
      expect(listed.validationPipelines.map((pipeline) => pipeline.pipeline)).toEqual(["logs/default", "logs"]);
      expect(listed.validationPipelines[0]).toEqual(first);
      expect(await auditRows("validation_pipeline.created")).toHaveLength(3);
    });

    it("refuses a name without a signal, an empty or long one, and an unknown field (400)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      for (const body of [
        { pipeline: "profiles/default" },
        { pipeline: "" },
        { pipeline: `logs/${"x".repeat(200)}` },
        { pipeline: "logs", signal: "logs" },
        {},
      ]) {
        expectInvalid(await call(ana, "POST", pipelinesPath(target), body));
      }
      expect(await databases.ownerDb.selectFrom("validation_pipelines").select("id").execute()).toEqual([]);
    });

    it("has no cap on a version's validation pipelines (the owner, decision 28): a 101st is created", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      await sql`
        insert into validation_pipelines (organization_id, configuration_id, configuration_version_id, pipeline_name,
                                          signal, created_by_user_id, created_at)
        select ${target.organizationId}, ${target.configurationId}, ${target.versionId}, 'logs/seeded-' || n, 'logs',
               ${ana.userId}, now()
          from generate_series(1, 100) as n
      `.execute(databases.ownerDb);

      await createdPipeline(ana, target, "metrics/the-101st");

      expect((await call(ana, "GET", pipelinesPath(target))).json<{ validationPipelines: PipelineBody[] }>().validationPipelines).toHaveLength(101);
    });

    it("lists the version's validation pipelines oldest first, by created_at then id, and none of another version's", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const first = await createdPipeline(ana, target, "logs");
      tick();
      const second = await createdPipeline(ana, target, "traces");
      const tied = await addValidationPipeline(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        pipeline_name: "metrics",
        signal: "metrics",
        created_at: new Date(clock.getTime()),
        created_by_user_id: ana.userId,
      });
      await createdPipeline(ana, target, "logs/on-v2", { versionId: target.v2 });

      const response = await call(ana, "GET", pipelinesPath(target));
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<{ validationPipelines: PipelineBody[] }>().validationPipelines.map((pipeline) => pipeline.id)).toEqual([
        first.id,
        ...[second.id, tied.id].sort(),
      ]);
    });

    it("deletes a validation pipeline (204) with its rules, auditing its id; another pipeline's rules stay", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const doomed = await createdPipeline(ana, target, "logs");
      const kept = await createdPipeline(ana, target, "traces");
      await createdRule(ana, target, doomed.id, { kind: "contains_text", target: "output", pattern: "a" });
      const keptRule = await createdRule(ana, target, kept.id, { kind: "contains_text", target: "stderr", pattern: "b" });

      const response = await call(ana, "DELETE", pipelinePath(target, doomed.id));

      expect(response.statusCode).toBe(204);
      expect((await ruleRows()).map((row) => row.id)).toEqual([keptRule.id]);
      expect(await databases.ownerDb.selectFrom("validation_pipelines").select("id").execute()).toEqual([{ id: kept.id }]);
      expect((await auditRows("validation_pipeline.deleted")).map((row) => [row.subject_id, row.metadata])).toEqual([
        [doomed.id, { configurationId: target.configurationId, versionId: target.versionId }],
      ]);
      expectRefusal(await call(ana, "DELETE", pipelinePath(target, doomed.id)), 404, "validation_pipeline_not_found", MESSAGES.pipelineNotFound);
    });

    it("answers an unknown, a malformed, a nil and another version's pipeline id with 404 validation_pipeline_not_found on every endpoint naming one, writing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const onV2 = await createdPipeline(ana, target, "logs", { versionId: target.v2 });
      const created = await call(ana, "POST", rulesPath(target, onV2.id, { versionId: target.v2 }), {
        kind: "contains_text",
        target: "output",
        pattern: "a",
      });
      expect(created.statusCode).toBe(201);
      const rule = created.json<{ rule: RuleBody }>().rule;
      // Created on v2 through its own path; here it is named under version 1's.
      for (const pipelineId of [randomUUID(), "not-a-uuid", "00000000-0000-0000-0000-000000000000", onV2.id]) {
        for (const [method, url, body] of [
          ["DELETE", pipelinePath(target, pipelineId), undefined],
          ["GET", rulesPath(target, pipelineId), undefined],
          ["POST", rulesPath(target, pipelineId), SSN_RULE],
          ["PATCH", rulePath(target, pipelineId, rule.id), { name: "x" }],
          ["DELETE", rulePath(target, pipelineId, rule.id), undefined],
        ] as const) {
          expectRefusal(await call(ana, method, url, body), 404, "validation_pipeline_not_found", MESSAGES.pipelineNotFound);
        }
      }
      expect(validations()).toEqual([]);
      expect((await ruleRows()).map((row) => [row.id, row.name])).toEqual([[rule.id, ""]]);
    });

    it("answers another configuration's version and a malformed configuration or version id with the configurations' 404s", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const other = await configurationOf(ana);
      expectRefusal(
        await call(ana, "GET", pipelinesPath(target, { versionId: other.versionId })),
        404,
        "configuration_version_not_found",
        MESSAGES.versionNotFound,
      );
      expectRefusal(
        await call(ana, "POST", pipelinesPath(target, { versionId: "not-a-uuid" }), { pipeline: "logs" }),
        404,
        "configuration_version_not_found",
        MESSAGES.versionNotFound,
      );
      expectRefusal(
        await call(ana, "GET", pipelinesPath({ ...target, configurationId: "not-a-uuid" })),
        404,
        "configuration_not_found",
        MESSAGES.configurationNotFound,
      );
      expect(await databases.ownerDb.selectFrom("validation_pipelines").select("id").execute()).toEqual([]);
    });
  });

  describe("rules", () => {
    it("creates a text rule (201) at the next position without asking the evaluator, its creator the caller, with an audit row of ids", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);

      const response = await call(ana, "POST", rulesPath(target, pipeline.id), {
        kind: "contains_text",
        target: "stderr",
        pattern: "  api key  ",
        name: `  Mentions the key ${NAME_MARKER} `,
        description: `Why ${DESCRIPTION_MARKER}`,
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      const rule = response.json<{ rule: RuleBody }>().rule;
      expect(rule).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        validationPipelineId: pipeline.id,
        position: 1,
        kind: "contains_text",
        target: "stderr",
        // A pattern is stored as it is sent: a text rule's spaces are part of it.
        pattern: "  api key  ",
        ottl: null,
        name: `Mentions the key ${NAME_MARKER}`,
        description: `Why ${DESCRIPTION_MARKER}`,
        createdByUserId: ana.userId,
        createdAt: clock.toISOString(),
        updatedAt: clock.toISOString(),
      });
      expect(validations()).toEqual([]);
      expect(await auditRows("validation_rule.")).toEqual([
        expect.objectContaining({
          action: "validation_rule.created",
          actor_user_id: ana.userId,
          subject_type: "validation_rule",
          subject_id: rule.id,
          metadata: { configurationId: target.configurationId, versionId: target.versionId, validationPipelineId: pipeline.id },
        }),
      ]);
    });

    it("checks a regex rule and an OTTL rule (the builders' canonical OTTL too) with the evaluator before storing them, in position order, with the pipeline's signal", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target, "logs/default");

      const ssn = await createdRule(ana, target, pipeline.id, SSN_RULE);
      const attribute = await createdRule(ana, target, pipeline.id, ATTRIBUTE_RULE);
      const count = await createdRule(ana, target, pipeline.id, COUNT_RULE);
      const distinct = await createdRule(ana, target, pipeline.id, {
        kind: "ottl",
        target: "output",
        ottl: { context: "resource", quantifier: "distinct", expression: 'attributes["service.name"]', count: { operator: "eq", value: 1 } },
      });

      expect(validations().map((request) => request.body)).toEqual([
        { signal: "logs", rule: SSN_RULE },
        { signal: "logs", rule: ATTRIBUTE_RULE },
        { signal: "logs", rule: COUNT_RULE },
        {
          signal: "logs",
          rule: {
            kind: "ottl",
            target: "output",
            ottl: { context: "resource", quantifier: "distinct", expression: 'attributes["service.name"]', count: { operator: "eq", value: 1 } },
          },
        },
      ]);
      expect([ssn, attribute, count, distinct].map((rule) => [rule.position, rule.kind, rule.pattern, rule.ottl])).toEqual([
        [1, "not_contains_regex", SSN_RULE.pattern, null],
        [2, "ottl", null, ATTRIBUTE_RULE.ottl],
        [3, "ottl", null, COUNT_RULE.ottl],
        [4, "ottl", null, distinct.ottl],
      ]);
      const listed = await call(ana, "GET", rulesPath(target, pipeline.id));
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(listed.json<{ rules: RuleBody[] }>().rules).toEqual([ssn, attribute, count, distinct]);
      // Stored as columns (Preflight ruling 16).
      const [, , countRow] = await ruleRows();
      expect(countRow).toMatchObject({
        ottl_context: "log",
        ottl_quantifier: "count",
        ottl_condition: "true",
        ottl_count_operator: "between",
        ottl_count_value: 1,
        ottl_count_value2: 10,
        ottl_expression: null,
        pattern: null,
      });
    });

    it("refuses a broken OTTL condition with the evaluator's words (400 validation_rule_invalid), storing and auditing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);

      const response = await call(ana, "POST", rulesPath(target, pipeline.id), {
        kind: "ottl",
        target: "output",
        ottl: { context: "log", quantifier: "all", condition: BROKEN_CONDITION },
      });

      expectRuleInvalid(response, "ottl.condition", OTTL_SYNTAX_ERROR);
      expect(validations()).toHaveLength(1);
      expect(await ruleRows()).toEqual([]);
      expect(await auditRows("validation_rule.")).toEqual([]);
    });

    it("refuses a regex RE2 doesn't take with the evaluator's words (400 validation_rule_invalid), storing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);

      const response = await call(ana, "POST", rulesPath(target, pipeline.id), {
        kind: "contains_regex",
        target: "output",
        pattern: `(?=lookahead)${fakeOttlEvaluatorMarker("invalid")}`,
      });

      expectRuleInvalid(response, "pattern", INVALID_REGEX);
      expect(await ruleRows()).toEqual([]);
    });

    it("refuses every checked save while the evaluator can't check it: down, failing or busy (503 rules_unavailable, decision 6's words); a text rule still saves", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);

      for (const fault of ["reset", "error_500", "evaluator_busy"] as const) {
        evaluator.fake.nextFault(fault);
        expectRefusal(
          await call(ana, "POST", rulesPath(target, pipeline.id), ATTRIBUTE_RULE),
          503,
          "rules_unavailable",
          RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
        );
      }
      // The fake's own markers: a busy and a failing evaluator, by the request.
      for (const marker of ["busy", "unavailable"] as const) {
        expectRefusal(
          await call(ana, "POST", rulesPath(target, pipeline.id), { ...SSN_RULE, pattern: fakeOttlEvaluatorMarker(marker) }),
          503,
          "rules_unavailable",
          RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
        );
      }
      expect(RULES_UNAVAILABLE_AT_SAVE_MESSAGE).toBe("Rules can't be checked right now. Try again shortly.");
      expect(await ruleRows()).toEqual([]);

      // A text rule needs no check: saved while the evaluator is down.
      evaluator.fake.nextFault("reset");
      await createdRule(ana, target, pipeline.id, { kind: "not_contains_text", target: "output", pattern: "password" });
      // The fault is still queued: the next check takes it.
      expectRefusal(
        await call(ana, "POST", rulesPath(target, pipeline.id), ATTRIBUTE_RULE),
        503,
        "rules_unavailable",
        RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
      );
      expect((await ruleRows()).map((row) => row.kind)).toEqual(["not_contains_text"]);
    });

    it("refuses an OTTL context its pipeline's signal doesn't have (400 invalid_request) before asking the evaluator", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const logs = await createdPipeline(ana, target, "logs/default");
      const traces = await createdPipeline(ana, target, "traces/default");

      for (const [pipelineId, context] of [
        [logs.id, "span"],
        [logs.id, "datapoint"],
        [traces.id, "log"],
        [traces.id, "metric"],
      ] as const) {
        const response = await call(ana, "POST", rulesPath(target, pipelineId), {
          kind: "ottl",
          target: "output",
          ottl: { context, quantifier: "any", condition: "true" },
        });
        expectInvalid(response);
      }
      expect(validations()).toEqual([]);
      // Each signal's own contexts are taken.
      await createdRule(ana, target, traces.id, { kind: "ottl", target: "output", ottl: { context: "spanevent", quantifier: "any", condition: "true" } });
      await createdRule(ana, target, logs.id, { kind: "ottl", target: "output", ottl: { context: "scope", quantifier: "any", condition: "true" } });
    });

    it("refuses a pattern, condition or expression of Unicode whitespace only, which the table's ASCII check would take (400 invalid_request, Ruling 36)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const blank = "  　";
      const rule = await createdRule(ana, target, pipeline.id, { kind: "contains_text", target: "output", pattern: "kept" });

      for (const body of [
        { kind: "contains_text", target: "output", pattern: blank },
        { kind: "contains_regex", target: "output", pattern: ` ${blank}\t` },
        { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "all", condition: blank } },
        { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "distinct", expression: blank, count: { operator: "eq", value: 1 } } },
      ]) {
        expectInvalid(await call(ana, "POST", rulesPath(target, pipeline.id), body));
        expectInvalid(await call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), body));
      }
      expect(validations()).toEqual([]);
      expect((await ruleRows()).map((row) => row.pattern)).toEqual(["kept"]);
    });

    it("refuses what the contract doesn't take: a field the kind doesn't have, an OTTL rule on the log, an unordered Between, a negative count, an unknown field (400)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      for (const body of [
        { kind: "contains_text", target: "output", pattern: "a", ottl: ATTRIBUTE_RULE.ottl },
        { kind: "ottl", target: "stderr", ottl: ATTRIBUTE_RULE.ottl },
        { ...COUNT_RULE, ottl: { ...COUNT_RULE.ottl, count: { operator: "between", value: 5, value2: 4 } } },
        { ...COUNT_RULE, ottl: { ...COUNT_RULE.ottl, count: { operator: "gt", value: -1 } } },
        { ...SSN_RULE, position: 3 },
        { kind: "json_path", target: "output", pattern: "$.a" },
      ]) {
        expectInvalid(await call(ana, "POST", rulesPath(target, pipeline.id), body));
      }
      expect(validations()).toEqual([]);
      expect(await ruleRows()).toEqual([]);
    });

    it("refuses a pipeline's 201st rule (409 validation_rule_limit_reached, decision 24's words) before asking the evaluator; another pipeline still takes one", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target, "logs");
      const other = await createdPipeline(ana, target, "traces");
      await seedRules(target, pipeline.id, 200, ana);

      for (const body of [SSN_RULE, { kind: "contains_text", target: "output", pattern: "x" }]) {
        expectRefusal(
          await call(ana, "POST", rulesPath(target, pipeline.id), body),
          409,
          "validation_rule_limit_reached",
          VALIDATION_RULE_LIMIT_MESSAGE,
        );
      }
      expect(VALIDATION_RULE_LIMIT_MESSAGE).toBe("A validation pipeline can have at most 200 rules.");
      expect(validations()).toEqual([]);
      expect((await call(ana, "GET", rulesPath(target, pipeline.id))).json<{ rules: RuleBody[] }>().rules).toHaveLength(200);
      await createdRule(ana, target, other.id, SSN_RULE);
      expect(await auditRows("validation_rule.created")).toHaveLength(1);
    });

    it(
      "counts the cap under the configuration's lock: five creates held at it with 199 rules give exactly one 201 and four 409s, never a 500 (Ruling 39)",
      async () => {
        const ana = await member();
        const target = await configurationOf(ana);
        const pipeline = await createdPipeline(ana, target);
        await seedRules(target, pipeline.id, 199, ana);

        // The tables' owner holds the configuration's row for update, as a
        // write does, until all five creates are past their reads (each sees
        // 199) and wait on it; then commits, and they go on one at a time.
        const { waited, responses } = await databases.ownerDb.connection().execute(async (connection) => {
          await sql`begin`.execute(connection);
          let isOpen = true;
          try {
            await sql`select id from configurations where id = ${target.configurationId} for update`.execute(connection);
            const creates = [1, 2, 3, 4, 5].map((n) =>
              started(
                call(ana, "POST", rulesPath(target, pipeline.id), { kind: "contains_text", target: "output", pattern: `racer ${n}` }),
              ),
            );
            const waited = await untilEachWaitsOrSettles(creates);
            await sql`commit`.execute(connection);
            isOpen = false;
            return { waited, responses: await Promise.all(creates.map((create) => create.response)) };
          } finally {
            if (isOpen) await sql`rollback`.execute(connection);
          }
        });

        // All five waited on the lock, then saw 199, 200, 200, 200, 200.
        expect(waited).toBe(5);
        const statuses = responses.map((response) => response.statusCode);
        expect(statuses).not.toContain(500);
        expect([...statuses].sort()).toEqual([201, 409, 409, 409, 409]);
        for (const refused of responses.filter((response) => response.statusCode === 409)) {
          expectRefusal(refused, 409, "validation_rule_limit_reached", VALIDATION_RULE_LIMIT_MESSAGE);
        }
        expect(responses.find((response) => response.statusCode === 201)!.json<{ rule: RuleBody }>().rule.position).toBe(200);
        expect((await ruleRows()).length).toBe(200);
        expect(await auditRows("validation_rule.created")).toHaveLength(1);
      },
      LOCK_RACE_TIMEOUT,
    );

    it(
      "asks the evaluator outside any transaction, holding no connection: on a one-connection pool, a checked POST and PATCH succeed while the evaluator itself queries that pool (Ruling 39)",
      async () => {
        const ana = await member();
        const target = await configurationOf(ana);
        const pipeline = await createdPipeline(ana, target);

        // The API's own role, as the server connects, on a pool of one
        // connection its backend names. A connection held across the check
        // would leave the evaluator's own query waiting for it: the pool's
        // connect timeout is a hang guard only.
        const url = new URL(process.env.TELFLO_DATABASE_URL!);
        url.searchParams.set("application_name", ONE_CONNECTION_APPLICATION_NAME);
        const oneDb = createDb(
          new pg.Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: LOCK_WAIT_HANG_GUARD }),
        );
        const asked: Array<{ idleInTransaction: number; pooled: number }> = [];
        const wrapped: OttlEvaluatorClient = {
          ...evaluator.client,
          validate: async (...args) => {
            // While the evaluator is asked: the pool's backends left idle in a
            // transaction, then a query on the pool's one connection.
            const held = await sql<{ count: number }>`
              select count(*)::int as count
                from pg_stat_activity
               where datname = current_database()
                 and usename = 'telflo_platform'
                 and application_name = ${ONE_CONNECTION_APPLICATION_NAME}
                 and state like 'idle in transaction%'
            `.execute(databases.ownerDb);
            const pooled = await sql<{ one: number }>`select 1 as one`.execute(oneDb);
            asked.push({ idleInTransaction: held.rows[0]!.count, pooled: pooled.rows[0]!.one });
            return evaluator.client.validate(...args);
          },
        };
        const oneConnection = await serverWith({ db: oneDb, ottlEvaluator: wrapped });
        try {
          const created = await call(ana, "POST", rulesPath(target, pipeline.id), SSN_RULE, { on: oneConnection });
          expect(created.statusCode, created.body).toBe(201);
          const rule = created.json<{ rule: RuleBody }>().rule;
          const patched = await call(
            ana,
            "PATCH",
            rulePath(target, pipeline.id, rule.id),
            { ...SSN_RULE, pattern: "\\b\\d{9}\\b" },
            { on: oneConnection },
          );
          expect(patched.statusCode, patched.body).toBe(200);
          expect(asked).toEqual([
            { idleInTransaction: 0, pooled: 1 },
            { idleInTransaction: 0, pooled: 1 },
          ]);
          expect(validations()).toHaveLength(2);
        } finally {
          await oneConnection.close();
          servers.splice(servers.indexOf(oneConnection), 1);
          await oneDb.destroy();
        }
      },
      LOCK_RACE_TIMEOUT,
    );

    it("deletes a rule (204), the others keeping their positions; the next takes the largest plus one", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const rules = [];
      for (const pattern of ["one", "two", "three"]) {
        rules.push(await createdRule(ana, target, pipeline.id, { kind: "contains_text", target: "output", pattern }));
      }

      // A gap stays where a rule was; the next takes the largest plus one, so the largest's place is taken again once it goes.
      expect((await call(ana, "DELETE", rulePath(target, pipeline.id, rules[1]!.id))).statusCode).toBe(204);
      const fourth = await createdRule(ana, target, pipeline.id, { kind: "contains_text", target: "output", pattern: "four" });
      expect((await call(ana, "DELETE", rulePath(target, pipeline.id, fourth.id))).statusCode).toBe(204);
      const fifth = await createdRule(ana, target, pipeline.id, { kind: "contains_text", target: "output", pattern: "five" });

      expect([fourth.position, fifth.position]).toEqual([4, 4]);
      expect(
        (await call(ana, "GET", rulesPath(target, pipeline.id))).json<{ rules: RuleBody[] }>().rules.map((rule) => [rule.position, rule.pattern]),
      ).toEqual([
        [1, "one"],
        [3, "three"],
        [4, "five"],
      ]);
      const ids = { configurationId: target.configurationId, versionId: target.versionId, validationPipelineId: pipeline.id };
      expect((await auditRows("validation_rule.deleted")).map((row) => [row.subject_id, row.metadata])).toEqual([
        [rules[1]!.id, ids],
        [fourth.id, ids],
      ]);
    });

    it("answers an unknown, a malformed and another pipeline's rule id with 404 validation_rule_not_found, writing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target, "logs");
      const other = await createdPipeline(ana, target, "traces");
      const elsewhere = await createdRule(ana, target, other.id, { kind: "contains_text", target: "output", pattern: "x" });
      for (const ruleId of [randomUUID(), "not-a-uuid", elsewhere.id]) {
        for (const [method, body] of [
          ["PATCH", { name: "x" }],
          ["PATCH", SSN_RULE],
          ["DELETE", undefined],
        ] as const) {
          expectRefusal(
            await call(ana, method, rulePath(target, pipeline.id, ruleId), body),
            404,
            "validation_rule_not_found",
            MESSAGES.ruleNotFound,
          );
        }
      }
      expect(validations()).toEqual([]);
      expect((await ruleRows()).map((row) => [row.id, row.name])).toEqual([[elsewhere.id, ""]]);
    });
  });

  describe("a rule's change (PATCH)", () => {
    it("renames a rule without asking the evaluator, even one the evaluator would refuse now (the server's evaluator rejects any call)", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const rule = await createdRule(ana, target, pipeline.id, ATTRIBUTE_RULE);
      validations();
      const at = tick();

      const renamed = await call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), { name: "Every record is prod", description: "Why" }, { on: uncalled });

      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json<{ rule: RuleBody }>().rule).toEqual({
        ...rule,
        name: "Every record is prod",
        description: "Why",
        updatedAt: at.toISOString(),
      });
      // The rule's content sent whole but unchanged needs no check either.
      const same = await call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), { ...ATTRIBUTE_RULE, name: "Again" }, { on: uncalled });
      expect(same.statusCode, same.body).toBe(200);
      expect(validations()).toEqual([]);
      expect((await auditRows("validation_rule.updated")).map((row) => row.metadata)).toEqual([
        { configurationId: target.configurationId, versionId: target.versionId, validationPipelineId: pipeline.id, changedFields: ["name", "description"] },
        { configurationId: target.configurationId, versionId: target.versionId, validationPipelineId: pipeline.id, changedFields: ["name"] },
      ]);
    });

    it("changes a quantifier, a count or a target without asking the evaluator; a new pattern, context, condition or expression is checked", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const ottlRule = await createdRule(ana, target, pipeline.id, COUNT_RULE);
      const textRule = await createdRule(ana, target, pipeline.id, { kind: "contains_regex", target: "output", pattern: "ERROR" });
      validations();
      const patch = (rule: RuleBody, body: Record<string, unknown>, on = uncalled) =>
        call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), body, { on });

      // Unchecked: the quantifier and the count, a regex's target, a regex kind's polarity.
      const any = await patch(ottlRule, { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "any", condition: "true" } });
      expect(any.statusCode, any.body).toBe(200);
      expect(any.json<{ rule: RuleBody }>().rule.ottl).toEqual({ context: "log", quantifier: "any", condition: "true" });
      expect((await patch(textRule, { kind: "not_contains_regex", target: "stderr", pattern: "ERROR" })).statusCode).toBe(200);
      expect(validations()).toEqual([]);

      // Checked: each of the checked fields, and a text kind made a regex with the same text.
      for (const [rule, body] of [
        [ottlRule, { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "any", condition: "false" } }],
        [ottlRule, { kind: "ottl", target: "output", ottl: { context: "resource", quantifier: "any", condition: "false" } }],
        [ottlRule, { kind: "ottl", target: "output", ottl: { context: "resource", quantifier: "distinct", condition: "false", expression: "body", count: { operator: "gt", value: 2 } } }],
        [textRule, { kind: "not_contains_regex", target: "stderr", pattern: "WARN" }],
        [textRule, { kind: "contains_text", target: "stderr", pattern: "WARN" }],
        [textRule, { kind: "contains_regex", target: "stderr", pattern: "WARN" }],
      ] as const) {
        const response = await patch(rule, body, server);
        expect(response.statusCode, response.body).toBe(200);
      }
      // Five checks: the text kind needed none.
      expect(validations().map((request) => (request.body as { rule: { kind: string } }).rule.kind)).toEqual([
        "ottl",
        "ottl",
        "ottl",
        "not_contains_regex",
        "contains_regex",
      ]);
      // An OTTL rule made a text rule loses its OTTL; and back, its pattern.
      const toText = await patch(ottlRule, { kind: "contains_text", target: "stderr", pattern: "x" });
      expect(toText.json<{ rule: RuleBody }>().rule).toMatchObject({ kind: "contains_text", target: "stderr", pattern: "x", ottl: null });
      const row = (await ruleRows()).find((each) => each.id === ottlRule.id)!;
      expect([row.ottl_context, row.ottl_quantifier, row.ottl_condition, row.ottl_expression, row.ottl_count_operator]).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      const back = await patch(ottlRule, ATTRIBUTE_RULE, server);
      expect(back.json<{ rule: RuleBody }>().rule).toMatchObject({ kind: "ottl", pattern: null, ottl: ATTRIBUTE_RULE.ottl });
      const changed = (await auditRows("validation_rule.updated")).map((each) => (each.metadata as { changedFields: string[] }).changedFields);
      expect(changed.at(-2)).toEqual(["kind", "target", "pattern", "ottl"]);
      expect(changed.at(-1)).toEqual(["kind", "target", "pattern", "ottl"]);
    });

    it("refuses a broken condition on PATCH with the evaluator's words (400 validation_rule_invalid), leaving the rule as it was", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const rule = await createdRule(ana, target, pipeline.id, ATTRIBUTE_RULE);
      const before = await ruleRows();
      validations();
      tick();

      const response = await call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), {
        kind: "ottl",
        target: "output",
        ottl: { context: "log", quantifier: "all", condition: BROKEN_CONDITION },
        name: "Renamed with it",
      });

      expectRuleInvalid(response, "ottl.condition", OTTL_SYNTAX_ERROR);
      expect(validations()).toHaveLength(1);
      expect(await ruleRows()).toEqual(before);
      expect(await auditRows("validation_rule.updated")).toEqual([]);
    });

    it("refuses on PATCH a regex RE2 doesn't take, a context the signal doesn't have, and every check while the evaluator is down", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const rule = await createdRule(ana, target, pipeline.id, SSN_RULE);
      const before = await ruleRows();
      validations();
      const patch = (body: Record<string, unknown>) => call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), body);

      expectRuleInvalid(await patch({ ...SSN_RULE, pattern: `(${fakeOttlEvaluatorMarker("invalid")}` }), "pattern", INVALID_REGEX);
      expectInvalid(await patch({ kind: "ottl", target: "output", ottl: { context: "span", quantifier: "any", condition: "true" } }));
      evaluator.fake.nextFault("reset");
      expectRefusal(await patch(ATTRIBUTE_RULE), 503, "rules_unavailable", RULES_UNAVAILABLE_AT_SAVE_MESSAGE);
      expect(validations()).toHaveLength(1);
      expect(await ruleRows()).toEqual(before);
    });

    it("answers an empty PATCH ({}) and one changing nothing with the rule as it is (200), writing and auditing nothing, as a suite's PATCH", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const rule = await createdRule(ana, target, pipeline.id, { ...ATTRIBUTE_RULE, name: "Prod", description: "Only prod" });
      tick();
      for (const body of [{}, { name: "Prod" }, { ...ATTRIBUTE_RULE, name: " Prod ", description: "Only prod" }]) {
        const response = await call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), body, { on: uncalled });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<{ rule: RuleBody }>().rule).toEqual(rule);
      }
      expect(await auditRows("validation_rule.updated")).toEqual([]);
      expectInvalid(await call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), { pattern: "x" }));
      expectInvalid(await call(ana, "PATCH", rulePath(target, pipeline.id, rule.id), { position: 7 }));
    });
  });

  describe("the public API's mark (D25 decision 32, migration 1700000000039)", () => {
    /** Whether the stored rule is marked the public API's, as the owner reads it. */
    const isApiOwnedOf = async (ruleId: string) =>
      (
        await databases.ownerDb.selectFrom("validation_rules").select("is_api_owned").where("id", "=", ruleId).executeTakeFirstOrThrow()
      ).is_api_owned;

    it("stores a rule saved in the tab as not the API's, and keeps an API rule's mark through the tab's edit of it", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const saved = await createdRule(ana, target, pipeline.id, SSN_RULE);
      expect(await isApiOwnedOf(saved.id)).toBe(false);

      const apiOwned = await addValidationRule(databases.ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        validationPipelineId: pipeline.id,
        position: 2,
        created_by_user_id: ana.userId,
        is_api_owned: true,
      });
      const edited = await call(ana, "PATCH", rulePath(target, pipeline.id, apiOwned.id), {
        kind: "contains_text",
        target: "stderr",
        pattern: "edited in the tab",
        name: "Renamed",
        description: "Redescribed",
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json<{ rule: RuleBody }>().rule).toMatchObject({ name: "Renamed", pattern: "edited in the tab", target: "stderr" });
      expect(await isApiOwnedOf(apiOwned.id)).toBe(true);
      expect(await isApiOwnedOf(saved.id)).toBe(false);
    });
  });

  describe("the checks' limit (RATE_LIMITS: 30 a minute per person per organization, decision 16)", () => {
    it("counts every save the evaluator is asked about, refused or not, and never gives one back; a save needing no check isn't counted (429 validation_rule_rate_limited)", async () => {
      const limited = await serverWith({
        rateLimits: { ...TEST_RATE_LIMITS, validationRuleChecksPerUser: { max: 3, windowMs: 60_000 } },
      });
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const pipeline = await createdPipeline(ana, target);
      const post = (person: Person, body: Record<string, unknown>) =>
        call(person, "POST", rulesPath(target, pipeline.id), body, { on: limited });

      // Three checks: one valid, one the evaluator refuses, one while it is busy.
      expect((await post(ana, SSN_RULE)).statusCode).toBe(201);
      expect((await post(ana, { ...ATTRIBUTE_RULE, ottl: { ...ATTRIBUTE_RULE.ottl, condition: BROKEN_CONDITION } })).statusCode).toBe(400);
      evaluator.fake.nextFault("evaluator_busy");
      expect((await post(ana, ATTRIBUTE_RULE)).statusCode).toBe(503);
      // Refused before the evaluator: not counted.
      expect((await call(ana, "POST", rulesPath(target, randomUUID()), SSN_RULE, { on: limited })).statusCode).toBe(404);
      expect(validations()).toHaveLength(3);

      const refused = await post(ana, ATTRIBUTE_RULE);
      expectRefusal(refused, 429, "validation_rule_rate_limited", MESSAGES.rateLimited);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
      const [stored] = await ruleRows();
      const patched = await call(ana, "PATCH", rulePath(target, pipeline.id, stored!.id), { ...SSN_RULE, pattern: "\\d+" }, { on: limited });
      expectRefusal(patched, 429, "validation_rule_rate_limited", MESSAGES.rateLimited);
      expect(validations()).toEqual([]);

      // A text rule and a rename need no check, so the limit doesn't refuse them.
      expect((await post(ana, { kind: "contains_text", target: "output", pattern: "ok" })).statusCode).toBe(201);
      expect((await call(ana, "PATCH", rulePath(target, pipeline.id, stored!.id), { name: "n" }, { on: limited })).statusCode).toBe(200);
      // Ben's count is his own.
      expect((await post(ben, ATTRIBUTE_RULE)).statusCode).toBe(201);
    });
  });

  describe("visibility (decision 12)", () => {
    it("hides a draft's validation pipelines and rules from a teammate (404 configuration_not_found on all seven endpoints) until it is published; then he sees them and edits the rules", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const rule = await createdRule(ana, target, pipeline.id, ATTRIBUTE_RULE);
      validations();

      const endpoints = [
        ["GET", pipelinesPath(target), undefined],
        ["POST", pipelinesPath(target), { pipeline: "traces" }],
        ["DELETE", pipelinePath(target, pipeline.id), undefined],
        ["GET", rulesPath(target, pipeline.id), undefined],
        ["POST", rulesPath(target, pipeline.id), SSN_RULE],
        ["PATCH", rulePath(target, pipeline.id, rule.id), { ...ATTRIBUTE_RULE, ottl: { ...ATTRIBUTE_RULE.ottl, condition: "true" } }],
        ["DELETE", rulePath(target, pipeline.id, rule.id), undefined],
      ] as const;
      expect(endpoints).toHaveLength(7);
      for (const [method, url, body] of endpoints) {
        expectRefusal(await call(ben, method, url, body), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(validations()).toEqual([]);
      expect(await databases.ownerDb.selectFrom("validation_pipelines").select("id").execute()).toHaveLength(1);

      await publish(target, ana);

      expect((await call(ben, "GET", pipelinesPath(target))).json<{ validationPipelines: PipelineBody[] }>().validationPipelines).toEqual([pipeline]);
      expect((await call(ben, "GET", rulesPath(target, pipeline.id))).json<{ rules: RuleBody[] }>().rules).toEqual([rule]);
      // A published configuration's rules are every member's to edit (decision 13), on its published version.
      const edited = await call(ben, "PATCH", rulePath(target, pipeline.id, rule.id), {
        ...ATTRIBUTE_RULE,
        ottl: { ...ATTRIBUTE_RULE.ottl, condition: 'attributes["env"] == "staging"' },
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json<{ rule: RuleBody }>().rule).toMatchObject({ createdByUserId: ana.userId, ottl: { condition: 'attributes["env"] == "staging"' } });
      const bens = await createdRule(ben, target, pipeline.id, SSN_RULE);
      expect(bens).toMatchObject({ createdByUserId: ben.userId, position: 2 });
      expect((await call(ben, "DELETE", rulePath(target, pipeline.id, rule.id))).statusCode).toBe(204);
      expect(validations()).toHaveLength(2);
    });

    it("answers another organization with 404 everywhere: its path is organization_not_found, and its own path naming A's ids is configuration_not_found", async () => {
      const { ana, cara } = await team();
      const target = await configurationOf(ana, { published: true });
      const pipeline = await createdPipeline(ana, target);
      const rule = await createdRule(ana, target, pipeline.id, SSN_RULE);
      validations();
      const endpoints = (options: PathOptions) =>
        [
          ["GET", pipelinesPath(target, options), undefined],
          ["POST", pipelinesPath(target, options), { pipeline: "traces" }],
          ["DELETE", pipelinePath(target, pipeline.id, options), undefined],
          ["GET", rulesPath(target, pipeline.id, options), undefined],
          ["POST", rulesPath(target, pipeline.id, options), SSN_RULE],
          ["PATCH", rulePath(target, pipeline.id, rule.id, options), { ...SSN_RULE, pattern: "x+" }],
          ["DELETE", rulePath(target, pipeline.id, rule.id, options), undefined],
        ] as const;
      for (const [method, url, body] of endpoints({})) {
        expectRefusal(await call(cara, method, url, body), 404, "organization_not_found", MESSAGES.organizationNotFound);
      }
      for (const [method, url, body] of endpoints({ organizationId: cara.organizationId })) {
        expectRefusal(await call(cara, method, url, body), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      }
      expect(validations()).toEqual([]);
      expect((await ruleRows()).map((row) => [row.id, row.pattern])).toEqual([[rule.id, SSN_RULE.pattern]]);
      expect(await databases.ownerDb.selectFrom("validation_pipelines").select("id").execute()).toEqual([{ id: pipeline.id }]);
    });

    it("needs a session (401) and the current terms (403 terms_acceptance_required) on every endpoint, writing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      const rule = await createdRule(ana, target, pipeline.id, { kind: "contains_text", target: "output", pattern: "x" });
      const endpoints = [
        ["GET", pipelinesPath(target), undefined],
        ["POST", pipelinesPath(target), { pipeline: "traces" }],
        ["DELETE", pipelinePath(target, pipeline.id), undefined],
        ["GET", rulesPath(target, pipeline.id), undefined],
        ["POST", rulesPath(target, pipeline.id), SSN_RULE],
        ["PATCH", rulePath(target, pipeline.id, rule.id), { name: "x" }],
        ["DELETE", rulePath(target, pipeline.id, rule.id), undefined],
      ] as const;
      for (const [method, url, body] of endpoints) {
        expect((await call(undefined, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
      }
      await databases.ownerDb.updateTable("users").set({ accepted_terms_version: "2025-01-01" }).where("id", "=", ana.userId).execute();
      const before = await Promise.all([
        databases.ownerDb.selectFrom("validation_pipelines").selectAll().execute(),
        ruleRows(),
        databases.ownerDb.selectFrom("audit_events").select("id").execute(),
      ]);
      for (const [method, url, body] of endpoints) {
        const response = await call(ana, method, url, body);
        expect({ endpoint: `${method} ${url}`, status: response.statusCode, body: response.json() }).toEqual({
          endpoint: `${method} ${url}`,
          status: 403,
          body: { error: { code: "terms_acceptance_required", message: MESSAGES.termsRequired } },
        });
      }
      expect(
        await Promise.all([
          databases.ownerDb.selectFrom("validation_pipelines").selectAll().execute(),
          ruleRows(),
          databases.ownerDb.selectFrom("audit_events").select("id").execute(),
        ]),
      ).toEqual(before);
      expect(validations()).toEqual([]);
    });
  });

  describe("a new version's copy of its source's validation pipelines (decision 17, Preflight ruling 24)", () => {
    /** POST …/versions: a new version of `target`'s configuration from `sourceVersionId`, as `person`. */
    const newVersion = (person: Person, target: Target, sourceVersionId: string) =>
      call(person, "POST", `/api/v1/organizations/${target.organizationId}/configurations/${target.configurationId}/versions`, {
        sourceVersionId,
        // Only logs/default is in the text: the other pipelines are stale, and copied all the same.
        yamlContent: "service:\n  pipelines:\n    logs/default: {}\n",
        nodes: [],
        edges: [],
        pipelines: [],
      });

    /** A version's pipelines in (created_at, id) order and their rules by (the pipeline's place, position), as the tables' owner reads them. */
    const contentsOf = async (versionId: string) => {
      const ownerDb = databases.ownerDb;
      const pipelines = await ownerDb
        .selectFrom("validation_pipelines")
        .selectAll()
        .where("configuration_version_id", "=", versionId)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const rules = [];
      for (const pipeline of pipelines) {
        rules.push(
          ...(await ownerDb
            .selectFrom("validation_rules")
            .selectAll()
            .where("validation_pipeline_id", "=", pipeline.id)
            .orderBy("position")
            .execute()),
        );
      }
      return { pipelines, rules };
    };

    it("copies the pipelines in order (many sharing a created_at) and their rules with their positions, stale pipelines included, a teammate their creator at the version's time; the audit row counts them", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const ownerDb = databases.ownerDb;
      const at = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));
      // Five pipelines, three at one time, with random (v4) ids, so neither the insert's order nor uuidv7's is the list's.
      const names = ["logs/default", "traces/gone", "metrics/old", "logs", "traces"];
      const minutes = [0, 0, -1, 0, 1];
      for (const [index, name] of names.entries()) {
        const pipeline = await addValidationPipeline(ownerDb, {
          id: randomUUID(),
          organizationId: target.organizationId,
          configurationId: target.configurationId,
          configurationVersionId: target.versionId,
          pipeline_name: name,
          signal: name.split("/")[0] as "logs" | "traces" | "metrics",
          created_by_user_id: ana.userId,
          created_at: new Date(at.getTime() + minutes[index]! * 60_000),
        });
        // Positions with gaps, inserted out of order; the rules' kinds mixed.
        for (const position of [7, 1, 3]) {
          const ottl = position === 3;
          await addValidationRule(ownerDb, {
            id: randomUUID(),
            organizationId: target.organizationId,
            configurationId: target.configurationId,
            configurationVersionId: target.versionId,
            validationPipelineId: pipeline.id,
            position,
            kind: ottl ? "ottl" : position === 7 ? "not_contains_regex" : "contains_text",
            target: position === 1 ? "stderr" : "output",
            pattern: ottl ? null : `pattern ${index}.${position}`,
            ...(ottl
              ? {
                  ottl_context: name.startsWith("traces") ? "span" : name.startsWith("metrics") ? "datapoint" : "log",
                  ottl_quantifier: "distinct",
                  ottl_condition: `condition ${index}`,
                  ottl_expression: `attributes["k${index}"]`,
                  ottl_count_operator: "between",
                  ottl_count_value: index,
                  ottl_count_value2: index + 5,
                }
              : {}),
            name: `rule ${index}.${position}`,
            description: `about ${index}.${position}`,
            created_by_user_id: ana.userId,
            created_at: new Date(at.getTime() - position * 60_000),
          });
        }
      }
      // A pipeline on another version stays where it is.
      await addValidationPipeline(ownerDb, {
        organizationId: target.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.v2,
      });
      const source = await contentsOf(target.versionId);
      tick();

      const response = await newVersion(ben, target, target.versionId);

      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<{ version: { id: string; versionNumber: number } }>().version;
      const copy = await contentsOf(created.id);
      const pipelineFields = (row: (typeof source.pipelines)[number]) => ({ pipeline_name: row.pipeline_name, signal: row.signal });
      const ruleFields = (row: (typeof source.rules)[number]) => {
        const {
          id: _id,
          validation_pipeline_id: _pipeline,
          configuration_version_id: _version,
          created_by_user_id: _creator,
          created_at: _created,
          updated_at: _updated,
          ...fields
        } = row;
        return fields;
      };
      expect(copy.pipelines.map(pipelineFields)).toEqual(source.pipelines.map(pipelineFields));
      // The earliest first, the latest last; the three at one time between them, by their (random) ids.
      expect(copy.pipelines[0]!.pipeline_name).toBe("metrics/old");
      expect(copy.pipelines[4]!.pipeline_name).toBe("traces");
      expect(copy.rules.map(ruleFields)).toEqual(source.rules.map(ruleFields));
      expect(copy.rules.map((row) => row.position)).toEqual(names.flatMap(() => [1, 3, 7]));
      // Each rule is in its own pipeline's copy.
      const copiedPipelineOf = new Map(source.pipelines.map((pipeline, index) => [pipeline.id, copy.pipelines[index]!.id]));
      expect(copy.rules.map((row) => row.validation_pipeline_id)).toEqual(
        source.rules.map((row) => copiedPipelineOf.get(row.validation_pipeline_id)),
      );
      // New rows: new ids, the version's own, Ben their creator, at the version's time.
      for (const row of [...copy.pipelines, ...copy.rules]) {
        expect(row).toMatchObject({
          configuration_version_id: created.id,
          configuration_id: target.configurationId,
          organization_id: target.organizationId,
          created_by_user_id: ben.userId,
          created_at: clock,
        });
      }
      for (const row of copy.rules) expect(row.updated_at).toEqual(clock);
      expect(new Set([...copy.pipelines, ...copy.rules].map((row) => row.id)).size).toBe(20);
      // The source is as it was.
      expect(await contentsOf(target.versionId)).toEqual(source);
      // The API lists the new version's pipelines in that order, and each one's rules.
      const listed = (await call(ben, "GET", pipelinesPath(target, { versionId: created.id }))).json<{ validationPipelines: PipelineBody[] }>();
      expect(listed.validationPipelines.map((pipeline) => pipeline.pipeline)).toEqual(source.pipelines.map((row) => row.pipeline_name));
      const firstRules = (
        await call(ben, "GET", rulesPath(target, listed.validationPipelines[0]!.id, { versionId: created.id }))
      ).json<{ rules: RuleBody[] }>().rules;
      expect(firstRules.map((rule) => [rule.position, rule.kind])).toEqual([
        [1, "contains_text"],
        [3, "ottl"],
        [7, "not_contains_regex"],
      ]);

      const [audit] = await ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "configuration.version_created").execute();
      expect(audit!.metadata).toEqual({
        versionId: created.id,
        versionNumber: 3,
        sourceVersionId: target.versionId,
        copiedSuites: 0,
        copiedDefinitions: 0,
        copiedValidationPipelines: 5,
        copiedValidationRules: 15,
      });
      for (const text of ["pattern 0", "rule 0", "about 0", "condition 0", "traces/gone"]) {
        expect(JSON.stringify(audit)).not.toContain(text);
      }
    });

    it("refuses a teammate's version create from a draft with 404 before the copy, copying nothing; its author's create copies the pipelines", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      await createdRule(ana, target, pipeline.id, SSN_RULE);

      expectRefusal(await newVersion(ben, target, target.versionId), 404, "configuration_not_found", MESSAGES.configurationNotFound);
      expect(await databases.ownerDb.selectFrom("validation_pipelines").select("id").execute()).toHaveLength(1);

      const response = await newVersion(ana, target, target.versionId);
      expect(response.statusCode).toBe(201);
      const copy = await contentsOf(response.json<{ version: { id: string } }>().version.id);
      expect(copy.pipelines.map((row) => [row.pipeline_name, row.created_by_user_id])).toEqual([["logs/default", ana.userId]]);
      expect(copy.rules.map((row) => [row.pattern, row.position, row.created_by_user_id])).toEqual([[SSN_RULE.pattern, 1, ana.userId]]);
    });

    it("copies nothing when the create fails after the copy (the audit row refused): neither the version nor its pipelines and rules", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipeline = await createdPipeline(ana, target);
      await createdRule(ana, target, pipeline.id, SSN_RULE);
      const before = await Promise.all([
        databases.ownerDb.selectFrom("configuration_versions").select("id").execute(),
        databases.ownerDb.selectFrom("validation_pipelines").selectAll().execute(),
        ruleRows(),
      ]);

      await withFailingInsert(databases.ownerDb, "audit_events", "raise exception 'refused for the test'", async () => {
        expect((await newVersion(ana, target, target.versionId)).statusCode).toBe(500);
      });

      expect(
        await Promise.all([
          databases.ownerDb.selectFrom("configuration_versions").select("id").execute(),
          databases.ownerDb.selectFrom("validation_pipelines").selectAll().execute(),
          ruleRows(),
        ]),
      ).toEqual(before);
    });
  });

  describe("privacy (ADR 0024)", () => {
    it("puts no rule's name, description, pattern or OTTL in any audit row, and neither those nor the evaluator's words in any log line", async () => {
      const { ana, ben } = await team();
      const target = await configurationOf(ana, { published: true });
      const pipeline = await createdPipeline(ana, target, "logs/privacy");
      const named = { name: `Named ${NAME_MARKER}`, description: `Described ${DESCRIPTION_MARKER}` };
      const text = await createdRule(ana, target, pipeline.id, { kind: "contains_text", target: "output", pattern: PATTERN_MARKER, ...named });
      const ottl = await createdRule(ana, target, pipeline.id, {
        kind: "ottl",
        target: "output",
        ottl: { context: "log", quantifier: "all", condition: `body != "${CONDITION_MARKER}"` },
        ...named,
      });
      await call(ana, "PATCH", rulePath(target, pipeline.id, text.id), { kind: "contains_regex", target: "output", pattern: `${PATTERN_MARKER}+`, name: `Again ${NAME_MARKER}` });
      // Refused by the evaluator, on create and on change: its words quote the rule.
      const refusals = [
        await call(ben, "POST", rulesPath(target, pipeline.id), {
          kind: "ottl",
          target: "output",
          ottl: { context: "log", quantifier: "all", condition: `${CONDITION_MARKER} ${BROKEN_CONDITION}` },
        }),
        await call(ben, "PATCH", rulePath(target, pipeline.id, ottl.id), {
          kind: "contains_regex",
          target: "output",
          pattern: `(${PATTERN_MARKER} ${fakeOttlEvaluatorMarker("invalid")}`,
        }),
      ];
      expect(refusals.map((response) => response.json<{ error: { code: string } }>().error.code)).toEqual([
        "validation_rule_invalid",
        "validation_rule_invalid",
      ]);
      evaluator.fake.nextFault("error_500");
      expect((await call(ben, "POST", rulesPath(target, pipeline.id), { ...SSN_RULE, pattern: PATTERN_MARKER })).statusCode).toBe(503);
      await call(ana, "GET", rulesPath(target, pipeline.id));
      await newVersion(ana, target);
      await call(ana, "DELETE", rulePath(target, pipeline.id, text.id));
      await call(ana, "DELETE", pipelinePath(target, pipeline.id));

      const audits = await databases.ownerDb.selectFrom("audit_events").selectAll().execute();
      expect(audits.map((row) => row.action).filter((action) => action.startsWith("validation_")).sort()).toEqual([
        "validation_pipeline.created",
        "validation_pipeline.deleted",
        "validation_rule.created",
        "validation_rule.created",
        "validation_rule.deleted",
        "validation_rule.updated",
      ]);
      expect(logLines.length).toBeGreaterThan(0);
      // The checks' outcomes are logged, by ids alone.
      expect(logLines.some((line) => line.includes('"result":"invalid"'))).toBe(true);
      for (const marker of [NAME_MARKER, DESCRIPTION_MARKER, PATTERN_MARKER, CONDITION_MARKER, "logs/privacy"]) {
        expect(JSON.stringify(audits)).not.toContain(marker);
        expect(logLines.filter((line) => line.includes(marker))).toEqual([]);
      }
      for (const words of ["OTTL syntax error", "Invalid regex", "(fake)", "fake-ottl-evaluator"]) {
        expect(logLines.filter((line) => line.includes(words))).toEqual([]);
      }
    });

    /** POST …/versions from `target`'s version 1. */
    const newVersion = (person: Person, target: Target) =>
      call(person, "POST", `/api/v1/organizations/${target.organizationId}/configurations/${target.configurationId}/versions`, {
        sourceVersionId: target.versionId,
        yamlContent: "",
        nodes: [],
        edges: [],
        pipelines: [],
      });
  });
});
