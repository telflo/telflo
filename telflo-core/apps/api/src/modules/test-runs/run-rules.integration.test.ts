import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely, type Selectable } from "kysely";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  RULES_UNAVAILABLE_AT_QUEUE_MESSAGE,
  RULES_UNAVAILABLE_RUN_MESSAGE,
  TestRunResponseSchema,
  type TestRunDetail,
} from "@telflo/contracts";
import type { Database, TestRunsTable } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestDefinition,
  addTestDefinitionInput,
  addTestInputFile,
  addTestSuite,
  addTestTemplate,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { createFileStore } from "../../file-store/create-file-store.js";
import type { FileKey, IFileStore } from "../../file-store/file-store.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { otelcolTestingRunTimeoutMs, type OtelcolTestingClient } from "../../otelcol-testing/client.js";
import type { OttlEvaluatorClient } from "../../ottl-evaluator/client.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { fakeOtelcolTestingMarker } from "../../testing/fake-otelcol-testing.js";
import { fakeOttlEvaluatorMarker } from "../../testing/fake-ottl-evaluator.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING, useFakeOtelcolTesting } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_OTTL_EVALUATOR, useFakeOttlEvaluator } from "../../testing/ottl-evaluator.js";
import { hashPassword } from "../identity/password.js";
import {
  createTestRunDispatcher,
  finishTestRun,
  TEST_RUN_EVALUATION_LEASE_MS,
  TEST_RUN_EVALUATOR_RETRY_MS,
  TEST_RUN_FILES_SECONDS,
  TEST_RUN_LEASE_OVERHEAD_SECONDS,
  TEST_RUN_SEND_WINDOW_SECONDS,
  testRunPreSendReserveMs,
  type TestRunDispatcher,
  type TestRunDispatcherLog,
} from "./dispatcher.js";
import type { IOrganizationVariables } from "./organization-variables.js";
import { failureResults, TEST_RUN_FAILURES } from "./run-results.js";
import { createTestRunQueueSignal, type TestRunQueueSignal } from "./test-runs-dependencies.js";

/*
 * D15a Task 7: the rules on runs (decisions 2, 3, 14 and 15; Preflight
 * rulings 11, 21, 22 and 25). A run queued through the API takes its
 * pipeline's rules' snapshot in its insert; the dispatcher, once the fake
 * tester answers, has the OpenAPI-checked fake evaluator check them (its
 * markers steer each rule's answer, nextFault queues the whole request's
 * failure); the run's detail carries the rules and their results. Against
 * Postgres as the API's own role, with a real FileStore on a temporary
 * directory. Every wait is on a condition (a tick, settled()); the busy
 * evaluator's 1 s is the dispatcher's injected wait, and the lease's time
 * its injected monotonic clock.
 */

const opamp = useFakeOpampServer();
const tester = useFakeOtelcolTesting();
const evaluator = useFakeOttlEvaluator();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const TEN_MIB = 10 * 1024 * 1024;

/** Markers no log line may hold (ADR 0024): a rule's name, description and pattern, and the output's text. */
const RULE_NAME_MARKER = "rule-name-marker-4b2e";
const RULE_DESCRIPTION_MARKER = "rule-description-marker-9d1f";
const PATTERN_MARKER = "rule-pattern-marker-60aa";
const OUTPUT_MARKER = "output-marker-c3d7";

/** The input the fake tester echoes as the run's output. */
const INPUT = Buffer.from(`{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"${OUTPUT_MARKER}"}}]}]}]}`);

const RUN_TEXT = "receivers: {}\n";

type Run = Selectable<TestRunsTable>;

/** A log that records every line, to check none holds a rule, an output or a result. */
function recordingLog(): TestRunDispatcherLog & { lines: Array<{ details: Record<string, unknown>; message: string }> } {
  const lines: Array<{ details: Record<string, unknown>; message: string }> = [];
  return {
    lines,
    warn: (details, message) => lines.push({ details, message }),
    error: (details, message) => lines.push({ details, message }),
  };
}

async function* once(bytes: Buffer): AsyncGenerator<Buffer> {
  yield bytes;
}

describe("the rules on runs", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let passwordHash: string;
  let collectorVersion: string;
  let root: string;
  let store: IFileStore;
  let signal: TestRunQueueSignal;
  let server: FastifyInstance;
  let log: ReturnType<typeof recordingLog>;
  let logLines: string[] = [];
  const dispatchers: TestRunDispatcher[] = [];
  /**
   * The organization variables' source the server and the dispatchers
   * share, as index.ts wires one source into both: by default one no run
   * here reads (their texts reference none); a test sets its own.
   */
  let variablesSource: IOrganizationVariables = UNCALLED_TESTING.organizationVariables;
  const organizationVariables: IOrganizationVariables = { read: (organizationId) => variablesSource.read(organizationId) };

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    passwordHash = await hashPassword(PASSWORD);
    root = await mkdtemp(join(tmpdir(), "telflo-run-rules-"));
    store = await createFileStore({ kind: "local", root });
    signal = createTestRunQueueSignal();
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: store,
        testing: {
          ...UNCALLED_TESTING,
          tester: tester.client,
          ottlEvaluator: evaluator.client,
          queued: signal,
          organizationVariables,
        },
        settings: loadSettings(process.env),
        db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    ({ version: collectorVersion } = await catalogueDefaults(ownerDb));
    log = recordingLog();
    logLines = [];
    tester.fake.setHealth("ready");
    tester.fake.takeRequests();
    evaluator.fake.takeRequests();
    variablesSource = UNCALLED_TESTING.organizationVariables;
  });

  afterEach(async () => {
    for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
    tester.fake.releaseHeld();
    expect(tester.fake.takeViolations()).toEqual([]);
    // The platform sent the evaluator nothing its contract refuses (the
    // output as {base64, truncated}, never bytesOnDisk; ids once).
    expect(evaluator.fake.takeViolations()).toEqual([]);
    // Nothing of a rule, the output or a result in any log line: the
    // dispatcher's or the server's (ADR 0024).
    const logged = JSON.stringify(log.lines) + logLines.join("\n");
    for (const marker of [RULE_NAME_MARKER, RULE_DESCRIPTION_MARKER, PATTERN_MARKER, OUTPUT_MARKER, "fake-ottl-evaluator"]) {
      expect(logged).not.toContain(marker);
    }
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

  /** A signed-in person, active in a new group organization. */
  const member = async (): Promise<Person> => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization } = await addMembership(ownerDb, { userId: account.user.id, role: "admin" });
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

  /** Ana's draft configuration and its version 1. */
  const configurationOf = async (author: Person) => {
    const configuration = await addConfiguration(ownerDb, {
      organizationId: author.organizationId,
      created_by_user_id: author.userId,
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: author.organizationId,
      created_by_user_id: author.userId,
    });
    return { organizationId: author.organizationId, configurationId: configuration.id, versionId: version.id };
  };
  type Target = Awaited<ReturnType<typeof configurationOf>>;

  const versionPath = (target: Target) =>
    `/api/v1/organizations/${target.organizationId}/configurations/${target.configurationId}/versions/${target.versionId}`;
  const runsPath = (target: Target) => `${versionPath(target)}/test-runs`;

  const call = (person: Person, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    server.inject({
      method,
      url,
      headers: csrfHeaders,
      cookies: { telflo_access: person.access },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  /** A validation pipeline for `pipeline` on `target`, through the API. */
  const createdPipeline = async (person: Person, target: Target, pipeline: string): Promise<string> => {
    const response = await call(person, "POST", `${versionPath(target)}/validation-pipelines`, { pipeline });
    expect(response.statusCode).toBe(201);
    return response.json<{ validationPipeline: { id: string } }>().validationPipeline.id;
  };

  /** A rule in `pipelineId`, through the API: its id. */
  const createdRule = async (person: Person, target: Target, pipelineId: string, body: Record<string, unknown>): Promise<string> => {
    const response = await call(person, "POST", `${versionPath(target)}/validation-pipelines/${pipelineId}/rules`, body);
    expect(response.statusCode).toBe(201);
    return response.json<{ rule: { id: string } }>().rule.id;
  };

  /** A text rule whose name and description carry markers, so the logs can be checked for them. */
  const textRule = (kind: "contains_text" | "not_contains_text", pattern: string) => ({
    kind,
    target: "output",
    pattern,
    name: `Rule ${RULE_NAME_MARKER}`,
    description: `About ${RULE_DESCRIPTION_MARKER}`,
  });

  /** `person`'s own test file with INPUT's bytes, as an upload leaves it. */
  const inputFile = async (person: Person): Promise<string> => {
    const file = await addTestInputFile(ownerDb, {
      organizationId: person.organizationId,
      ownerUserId: person.userId,
      size_bytes: INPUT.byteLength,
    });
    const key: FileKey = { kind: "test-input", organizationId: person.organizationId, userId: person.userId, fileId: file.id };
    await store.write(key, once(INPUT), { maxBytes: TEN_MIB });
    return file.id;
  };

  /** A one-off run's body. */
  const oneOff = (source: Record<string, string>, overrides: Record<string, unknown> = {}) => ({
    ...source,
    pipeline: "logs/app",
    signal: "logs",
    durationSeconds: 5,
    yaml: RUN_TEXT,
    collectorVersion,
    ...overrides,
  });

  /** Queues a run as `person`: the run as the API answers it. */
  const queued = async (person: Person, target: Target, body: Record<string, unknown>): Promise<TestRunDetail> => {
    const response = await call(person, "POST", runsPath(target), body);
    expect(response.statusCode, response.body).toBe(201);
    return TestRunResponseSchema.parse(response.json()).run;
  };

  /** A run as the API answers it now. */
  const detailOf = async (person: Person, target: Target, runId: string): Promise<TestRunDetail> => {
    const response = await call(person, "GET", `${runsPath(target)}/${runId}`);
    expect(response.statusCode).toBe(200);
    return TestRunResponseSchema.parse(response.json()).run;
  };

  const row = (id: string): Promise<Run> => ownerDb.selectFrom("test_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  function dispatcher(
    options: {
      tester?: OtelcolTestingClient;
      evaluator?: OttlEvaluatorClient;
      fileStore?: IFileStore;
      monotonicNow?: () => number;
      wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ): TestRunDispatcher {
    const created = createTestRunDispatcher({
      db,
      fileStore: options.fileStore ?? store,
      tester: options.tester ?? tester.client,
      evaluator: options.evaluator ?? evaluator.client,
      organizationVariables,
      queued: signal,
      runsPerTester: 4,
      log,
      ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    });
    dispatchers.push(created);
    return created;
  }

  /** Claims and carries every waiting run to its end. */
  const runAll = async (running: TestRunDispatcher = dispatcher()): Promise<void> => {
    await running.tick();
    await running.settled();
  };

  /** The evaluate requests the fake was sent since the last call. */
  const evaluations = () => evaluator.fake.takeRequests().filter((request) => request.operation === "evaluate");

  /** Ana, her draft, and a validation pipeline for logs/app with two text rules at positions 1 and 2: one passes, one fails. */
  const anaWithTwoRules = async () => {
    const ana = await member();
    const target = await configurationOf(ana);
    const pipelineId = await createdPipeline(ana, target, "logs/app");
    const passing = await createdRule(ana, target, pipelineId, textRule("contains_text", PATTERN_MARKER));
    const failing = await createdRule(ana, target, pipelineId, textRule("not_contains_text", fakeOttlEvaluatorMarker("fail")));
    evaluator.fake.takeRequests();
    return { ana, target, pipelineId, passing, failing };
  };

  describe("the snapshot at queue (decision 14, Preflight ruling 21)", () => {
    it("a run with no rules ends succeeded without asking the evaluator: no validation pipeline, or one with no rules, or one of another pipeline or signal", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const fileId = await inputFile(ana);
      // No validation pipeline for logs/app at all.
      const bare = await queued(ana, target, oneOff({ inputFileId: fileId }));
      expect(bare).toMatchObject({ validationRules: [], validationResults: null });
      // A validation pipeline for logs/app with no rule, and others' rules.
      await createdPipeline(ana, target, "logs/app");
      const other = await createdPipeline(ana, target, "logs/other");
      await createdRule(ana, target, other, textRule("contains_text", PATTERN_MARKER));
      const empty = await queued(ana, target, oneOff({ inputFileId: fileId }));
      expect(empty).toMatchObject({ validationRules: [], validationResults: null });
      expect((await row(empty.id)).validation_pipeline_id).not.toBeNull();
      evaluator.fake.takeRequests();

      // The evaluator can't be reached at all: neither run asks it.
      await runAll(dispatcher({ evaluator: UNCALLED_OTTL_EVALUATOR }));
      for (const run of [bare, empty]) {
        expect(await detailOf(ana, target, run.id)).toMatchObject({
          status: "succeeded",
          errorCode: null,
          validationRules: [],
          validationResults: null,
        });
      }
      expect(evaluator.fake.takeRequests()).toEqual([]);
    });

    it("snapshots the pipeline's rules in position order with their content, not another version's, pipeline's or signal's", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const v2 = await addConfigurationVersion(ownerDb, {
        configurationId: target.configurationId,
        organizationId: ana.organizationId,
        version_number: 2,
        created_by_user_id: ana.userId,
      });
      const pipelineId = await createdPipeline(ana, target, "logs/app");
      const first = await createdRule(ana, target, pipelineId, textRule("contains_text", PATTERN_MARKER));
      const second = await createdRule(ana, target, pipelineId, {
        kind: "ottl",
        target: "output",
        ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "between", value: 1, value2: 3 } },
      });
      // A deleted rule leaves a gap (position 3); the order is still by position.
      const deleted = await createdRule(ana, target, pipelineId, textRule("contains_text", "gone"));
      const third = await createdRule(ana, target, pipelineId, {
        kind: "ottl",
        target: "output",
        ottl: { context: "log", quantifier: "distinct", expression: "body", count: { operator: "gte", value: 1 } },
      });
      expect((await call(ana, "DELETE", `${versionPath(target)}/validation-pipelines/${pipelineId}/rules/${deleted}`)).statusCode).toBe(204);
      const fourth = await createdRule(ana, target, pipelineId, { kind: "contains_regex", target: "stderr", pattern: "ready" });
      // The same pipeline's name on version 2, and logs/app's rules don't belong to a metrics run.
      const otherVersion = { ...target, versionId: v2.id };
      const v2Pipeline = await createdPipeline(ana, otherVersion, "logs/app");
      await createdRule(ana, otherVersion, v2Pipeline, textRule("contains_text", "version-two"));
      evaluator.fake.takeRequests();

      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      expect(run.validationRules).toEqual([
        {
          id: first,
          position: 1,
          kind: "contains_text",
          target: "output",
          pattern: PATTERN_MARKER,
          ottl: null,
          name: `Rule ${RULE_NAME_MARKER}`,
          description: `About ${RULE_DESCRIPTION_MARKER}`,
        },
        {
          id: second,
          position: 2,
          kind: "ottl",
          target: "output",
          pattern: null,
          ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "between", value: 1, value2: 3 } },
          name: "",
          description: "",
        },
        {
          id: third,
          position: 4,
          kind: "ottl",
          target: "output",
          pattern: null,
          ottl: { context: "log", quantifier: "distinct", expression: "body", count: { operator: "gte", value: 1 } },
          name: "",
          description: "",
        },
        { id: fourth, position: 5, kind: "contains_regex", target: "stderr", pattern: "ready", ottl: null, name: "", description: "" },
      ]);
      expect((await row(run.id)).validation_pipeline_id).toBe(pipelineId);

      // A metrics run of the version's metrics pipeline takes none of logs/app's.
      const metrics = await queued(
        ana,
        target,
        oneOff({ inputFileId: await inputFile(ana) }, { pipeline: "metrics", signal: "metrics" }),
      );
      expect(metrics.validationRules).toEqual([]);
      expect((await row(metrics.id)).validation_pipeline_id).toBeNull();
    });

    it("a rule edited or added after queuing doesn't change the run's snapshot, which the evaluator checks; ↺ takes the current rules", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipelineId = await createdPipeline(ana, target, "logs/app");
      const ruleId = await createdRule(ana, target, pipelineId, textRule("contains_text", PATTERN_MARKER));
      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));

      // At 10:05 Ana edits the rule and adds another.
      const edited = await call(ana, "PATCH", `${versionPath(target)}/validation-pipelines/${pipelineId}/rules/${ruleId}`, {
        kind: "contains_text",
        target: "output",
        pattern: "edited-pattern",
      });
      expect(edited.statusCode).toBe(200);
      const added = await createdRule(ana, target, pipelineId, { kind: "not_contains_text", target: "output", pattern: "added" });
      evaluator.fake.takeRequests();

      const kept = await detailOf(ana, target, run.id);
      expect(kept.validationRules.map((rule) => [rule.id, rule.pattern])).toEqual([[ruleId, PATTERN_MARKER]]);

      // At 10:06 her ↺: the current rules.
      const rerun = await queued(ana, target, oneOff({ sourceRunId: run.id }));
      expect(rerun.validationRules.map((rule) => [rule.id, rule.pattern])).toEqual([
        [ruleId, "edited-pattern"],
        [added, "added"],
      ]);

      // Each is checked against its own snapshot.
      await runAll();
      const asked = evaluations().map((request) => (request.body as { rules: Array<{ id: string; pattern: string }> }).rules);
      expect(asked).toEqual(
        expect.arrayContaining([
          [expect.objectContaining({ id: ruleId, pattern: PATTERN_MARKER })],
          [expect.objectContaining({ id: ruleId, pattern: "edited-pattern" }), expect.objectContaining({ id: added, pattern: "added" })],
        ]),
      );
      expect(asked).toHaveLength(2);
      expect((await detailOf(ana, target, run.id)).validationRules).toEqual(kept.validationRules);
    });

    it("a run, its re-run and a definition's Play, queued through the API, each reach the tester with the values filled in as they are at its dispatch (D20 decision 13)", async () => {
      let value = "first$";
      variablesSource = { read: async () => ({ kind: "values", values: new Map([["REGION", value]]) }) };
      const ana = await member();
      const target = await configurationOf(ana);
      const yaml = `${RUN_TEXT}# region: \${org:REGION}\n`;
      const filled = (written: string) => `${RUN_TEXT}# region: ${written}\n`;

      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }, { yaml }));
      await runAll();
      expect(tester.fake.takeRequests().map((request) => request.yaml)).toEqual([filled("first$$")]);

      // The value changes: the re-run and the Play are sent the current one.
      value = "second$";
      const suite = await addTestSuite(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        created_by_user_id: ana.userId,
      });
      const input = await addTestDefinitionInput(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        size_bytes: INPUT.byteLength,
      });
      await store.write({ kind: "test-definition-input", organizationId: ana.organizationId, inputId: input.id }, once(INPUT), {
        maxBytes: TEN_MIB,
      });
      const definition = await addTestDefinition(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        testSuiteId: suite.id,
        inputId: input.id,
        target_pipeline: "logs/app",
        signal: "logs",
        created_by_user_id: ana.userId,
      });
      const rerun = await queued(ana, target, oneOff({ sourceRunId: run.id }, { yaml }));
      await runAll();
      const played = await queued(ana, target, { definitionId: definition.id, yaml, collectorVersion });
      await runAll();

      expect(tester.fake.takeRequests().map((request) => [request.runId, request.yaml])).toEqual([
        [rerun.id, filled("second$$")],
        [played.id, filled("second$$")],
      ]);
      for (const each of [run, rerun, played]) {
        expect(await detailOf(ana, target, each.id)).toMatchObject({ status: "succeeded", yaml });
      }
    });

    it("a definition's run and a template's run snapshot their pipeline's rules too", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipelineId = await createdPipeline(ana, target, "logs/app");
      const ruleId = await createdRule(ana, target, pipelineId, textRule("contains_text", PATTERN_MARKER));
      evaluator.fake.takeRequests();

      const suite = await addTestSuite(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        created_by_user_id: ana.userId,
      });
      const input = await addTestDefinitionInput(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        size_bytes: INPUT.byteLength,
      });
      await store.write({ kind: "test-definition-input", organizationId: ana.organizationId, inputId: input.id }, once(INPUT), {
        maxBytes: TEN_MIB,
      });
      const definition = await addTestDefinition(ownerDb, {
        organizationId: ana.organizationId,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        testSuiteId: suite.id,
        inputId: input.id,
        target_pipeline: "logs/app",
        signal: "logs",
        created_by_user_id: ana.userId,
      });
      const fromDefinition = await queued(ana, target, { definitionId: definition.id, yaml: RUN_TEXT, collectorVersion });
      expect(fromDefinition.validationRules.map((rule) => rule.id)).toEqual([ruleId]);

      const template = await addTestTemplate(ownerDb, { size_bytes: INPUT.byteLength });
      await store.write({ kind: "test-template", templateId: template.id }, once(INPUT), { maxBytes: TEN_MIB });
      const fromTemplate = await queued(ana, target, oneOff({ templateId: template.id }));
      expect(fromTemplate.validationRules.map((rule) => rule.id)).toEqual([ruleId]);

      await runAll();
      for (const run of [fromDefinition, fromTemplate]) {
        expect(await detailOf(ana, target, run.id)).toMatchObject({
          status: "succeeded",
          validationResults: [{ id: ruleId, passed: true, error: null, advisory: null, detail: null }],
        });
      }
      expect(evaluations()).toHaveLength(2);
    });

    it("a client can't supply its own rules or validation pipeline: the queue's schemas are strict (400), nothing queued", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const fileId = await inputFile(ana);
      const forged = [
        { id: randomUUID(), position: 1, kind: "contains_text", target: "output", pattern: "x", ottl: null, name: "", description: "" },
      ];
      for (const body of [
        oneOff({ inputFileId: fileId }, { validationRules: forged }),
        oneOff({ inputFileId: fileId }, { validationRules: [] }),
        oneOff({ inputFileId: fileId }, { validationPipelineId: randomUUID() }),
        { definitionId: randomUUID(), yaml: RUN_TEXT, collectorVersion, validationRules: forged },
      ]) {
        const response = await call(ana, "POST", runsPath(target), body);
        expect({ status: response.statusCode, body: response.json() }).toMatchObject({
          status: 400,
          body: { error: { code: "invalid_request" } },
        });
      }
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
      // The same request without the field: the database's (empty) snapshot.
      expect((await queued(ana, target, oneOff({ inputFileId: fileId }))).validationRules).toEqual([]);
    });

    it("refuses a one-off run whose pipeline isn't of its signal (400 invalid_request), queuing nothing", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const fileId = await inputFile(ana);
      for (const overrides of [
        { pipeline: "metrics/app", signal: "logs" },
        { pipeline: "logs", signal: "traces" },
        { pipeline: "logsx/app", signal: "logs" },
      ]) {
        const response = await call(ana, "POST", runsPath(target), oneOff({ inputFileId: fileId }, overrides));
        expect({ status: response.statusCode, code: response.json<{ error: { code: string } }>().error.code }).toEqual({
          status: 400,
          code: "invalid_request",
        });
      }
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
    });

    it("while the evaluator is known down, refuses a run that would carry rules (503 rules_unavailable, detail 24's words) and queues one without", async () => {
      const { ana, target } = await anaWithTwoRules();
      const fileId = await inputFile(ana);
      await sql`update ottl_evaluator_state set down_since = now()`.execute(ownerDb);

      const refused = await call(ana, "POST", runsPath(target), oneOff({ inputFileId: fileId }));
      expect({ status: refused.statusCode, body: refused.json() }).toEqual({
        status: 503,
        body: { error: { code: "rules_unavailable", message: RULES_UNAVAILABLE_AT_QUEUE_MESSAGE } },
      });
      const rerunSource = await queued(ana, target, oneOff({ inputFileId: fileId }, { pipeline: "logs/other" }));
      expect(rerunSource.validationRules).toEqual([]);
      // A re-run onto the pipeline with rules is refused too; one onto a pipeline without is queued.
      const rerun = await call(ana, "POST", runsPath(target), oneOff({ sourceRunId: rerunSource.id }));
      expect(rerun.statusCode).toBe(503);
      expect((await ownerDb.selectFrom("test_runs").select("id").execute()).map((each) => each.id)).toEqual([rerunSource.id]);

      // Up again: queued with its rules.
      await sql`update ottl_evaluator_state set down_since = null`.execute(ownerDb);
      expect((await queued(ana, target, oneOff({ inputFileId: fileId }))).validationRules).toHaveLength(2);
    });

    it("while the evaluator is known down, queues a run whose validation pipeline has no rule (D15a Ruling 41): it carries none", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipelineId = await createdPipeline(ana, target, "logs/app");
      // Another pipeline's rules don't count either.
      const other = await createdPipeline(ana, target, "logs/other");
      await createdRule(ana, target, other, textRule("contains_text", PATTERN_MARKER));
      evaluator.fake.takeRequests();
      await sql`update ottl_evaluator_state set down_since = now()`.execute(ownerDb);

      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      expect(run.validationRules).toEqual([]);
      expect((await row(run.id)).validation_pipeline_id).toBe(pipelineId);
    });

    it("while the evaluator is known down, queues a run whose pipeline has rules only on another version (D15a Ruling 41): it carries none", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const v2 = await addConfigurationVersion(ownerDb, {
        configurationId: target.configurationId,
        organizationId: ana.organizationId,
        version_number: 2,
        created_by_user_id: ana.userId,
      });
      // logs/app, its signal and its rule, on version 2 only.
      const otherVersion = { ...target, versionId: v2.id };
      const v2Pipeline = await createdPipeline(ana, otherVersion, "logs/app");
      await createdRule(ana, otherVersion, v2Pipeline, textRule("contains_text", PATTERN_MARKER));
      evaluator.fake.takeRequests();
      await sql`update ottl_evaluator_state set down_since = now()`.execute(ownerDb);

      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      expect(run.validationRules).toEqual([]);
      expect((await row(run.id)).validation_pipeline_id).toBeNull();
      // Version 2's run of the same pipeline is refused: its rules can't be checked.
      const refused = await call(ana, "POST", runsPath(otherVersion), oneOff({ inputFileId: await inputFile(ana) }));
      expect(refused.statusCode).toBe(503);
    });
  });

  describe("evaluation in the dispatcher (decisions 2, 3 and 15; Preflight rulings 11 and 22)", () => {
    it("Ana's two rules, one failing: Validation Failed, the detail carrying both results in the snapshot's order by the rules' ids", async () => {
      const { ana, target, passing, failing } = await anaWithTwoRules();
      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      await runAll();

      const detail = await detailOf(ana, target, run.id);
      expect(detail).toMatchObject({ status: "validation_failed", errorCode: null, errorMessage: null, outputSizeBytes: INPUT.byteLength });
      expect(detail.validationRules.map((rule) => rule.id)).toEqual([passing, failing]);
      expect(detail.validationResults).toEqual([
        { id: passing, passed: true, error: null, advisory: null, detail: null },
        {
          id: failing,
          passed: false,
          error: null,
          advisory: null,
          detail: expect.objectContaining({ kind: "unexpected_match", source: "output", totalMatchCount: 1 }),
        },
      ]);
      // The list row says so too.
      const list = await call(ana, "GET", runsPath(target));
      expect(list.json<{ runs: Array<{ id: string; status: string }> }>().runs).toEqual([
        expect.objectContaining({ id: run.id, status: "validation_failed" }),
      ]);
      const stored = await row(run.id);
      expect(stored.validation_results).toEqual(detail.validationResults);
      const types = await sql<{ passed: string }>`
        select string_agg(jsonb_typeof(result -> 'passed'), ',') as passed
          from test_runs, jsonb_array_elements(validation_results) result where id = ${run.id}
      `.execute(ownerDb);
      expect(types.rows[0]).toEqual({ passed: "boolean,boolean" });

      // What the evaluator was asked: the run's signal, the tester's output
      // as {base64, truncated}, the stored log, and the snapshot's rules in
      // order, each with its id.
      const [request, ...others] = evaluations();
      expect(others).toEqual([]);
      expect(request!.body).toEqual({
        signal: "logs",
        output: { base64: { sizeBytes: INPUT.byteLength, sha256: expect.any(String) }, truncated: false },
        log: stored.logs,
        rules: [
          { id: passing, kind: "contains_text", target: "output", pattern: PATTERN_MARKER },
          { id: failing, kind: "not_contains_text", target: "output", pattern: fakeOttlEvaluatorMarker("fail") },
        ],
      });
    });

    it("every rule passing: succeeded, with the results", async () => {
      const ana = await member();
      const target = await configurationOf(ana);
      const pipelineId = await createdPipeline(ana, target, "logs/app");
      const ruleId = await createdRule(ana, target, pipelineId, textRule("contains_text", PATTERN_MARKER));
      const errored = await createdRule(ana, target, pipelineId, textRule("contains_text", fakeOttlEvaluatorMarker("error")));
      evaluator.fake.takeRequests();
      // A rule's own error fails it (decision 3): Validation Failed, its message shown.
      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      await runAll();
      expect(await detailOf(ana, target, run.id)).toMatchObject({
        status: "validation_failed",
        validationResults: [
          { id: ruleId, passed: true },
          { id: errored, passed: false, error: "Not checked: the rules took longer than 20 s to check.", detail: null },
        ],
      });
      expect((await call(ana, "DELETE", `${versionPath(target)}/validation-pipelines/${pipelineId}/rules/${errored}`)).statusCode).toBe(204);
      const passing = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      await runAll();
      expect(await detailOf(ana, target, passing.id)).toMatchObject({
        status: "succeeded",
        errorCode: null,
        validationResults: [{ id: ruleId, passed: true, error: null, advisory: null, detail: null }],
      });
      evaluator.fake.takeRequests();
    });

    it("the tester's own failure ends the run as before: no rules checked, no results", async () => {
      const { ana, target } = await anaWithTwoRules();
      const run = await queued(
        ana,
        target,
        oneOff({ inputFileId: await inputFile(ana) }, { yaml: `${RUN_TEXT}${fakeOtelcolTestingMarker("collector-failed")}\n` }),
      );
      await runAll(dispatcher({ evaluator: UNCALLED_OTTL_EVALUATOR }));
      expect(await detailOf(ana, target, run.id)).toMatchObject({
        status: "failed",
        errorCode: "collector_failed",
        validationResults: null,
      });
      expect((await detailOf(ana, target, run.id)).validationRules).toHaveLength(2);
      expect(evaluator.fake.takeRequests()).toEqual([]);
    });

    it.each([
      // A reset comes before the fake reads the request: it keeps none.
      ["a connection reset", "reset", 0],
      ["500", "error_500", 1],
      ["400 (the platform broke the contract)", "invalid_request", 1],
      ["an answer missing a rule", "missing_result", 1],
      ["an answer for another rule", "extra_result", 1],
      ["an answer naming a rule twice", "duplicate_result", 1],
    ] as const)(
      "the evaluator unavailable at evaluation (%s): Error, rules_unavailable, the output, logs and timings kept and readable",
      async (_label, fault, requests) => {
        const { ana, target } = await anaWithTwoRules();
        const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
        evaluator.fake.nextFault(fault);
        await runAll();

        const detail = await detailOf(ana, target, run.id);
        expect(detail).toMatchObject({
          status: "failed",
          errorCode: "rules_unavailable",
          errorMessage: RULES_UNAVAILABLE_RUN_MESSAGE,
          strategy: "otlp",
          outputSizeBytes: INPUT.byteLength,
          outputTruncated: false,
          validationResults: null,
        });
        expect(detail.logs).toContain("[replay] 1 of 1 payloads sent");
        expect(detail.timings).toMatchObject({ totalMs: 5060 });
        expect(detail.validationRules).toHaveLength(2);
        const output = await call(ana, "GET", `${runsPath(target)}/${run.id}/files/output`);
        expect(output.statusCode).toBe(200);
        expect(output.rawPayload).toEqual(INPUT);
        expect(evaluations()).toHaveLength(requests);
        // The client's own log line (a deployment's to fix) aside, the dispatcher names the reason only.
        expect(log.lines).toContainEqual({
          details: expect.objectContaining({ runId: run.id, reason: expect.any(String) }),
          message: "a test run's rules couldn't be checked: the OTTL evaluator gave no answer",
        });
        // The malformed answers were the fake's own doing, not the platform's.
        evaluator.fake.takeViolations();
      },
    );

    it("busy once, then answered: asked again after 1 s, and the answer stored", async () => {
      const { ana, target, failing } = await anaWithTwoRules();
      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      const waits: number[] = [];
      evaluator.fake.nextFault("evaluator_busy");
      await runAll(dispatcher({ wait: async (ms) => void waits.push(ms) }));

      expect(waits).toEqual([TEST_RUN_EVALUATOR_RETRY_MS]);
      expect(TEST_RUN_EVALUATOR_RETRY_MS).toBe(1_000);
      expect(evaluations()).toHaveLength(2);
      expect(await detailOf(ana, target, run.id)).toMatchObject({
        status: "validation_failed",
        validationResults: [expect.objectContaining({ passed: true }), expect.objectContaining({ id: failing, passed: false })],
      });
    });

    it("busy twice: the outage path after the second (a third ask would have been answered)", async () => {
      const { ana, target } = await anaWithTwoRules();
      const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
      const waits: number[] = [];
      evaluator.fake.nextFault("evaluator_busy");
      evaluator.fake.nextFault("evaluator_busy");
      await runAll(dispatcher({ wait: async (ms) => void waits.push(ms) }));

      expect(waits).toEqual([TEST_RUN_EVALUATOR_RETRY_MS]);
      expect(evaluations()).toHaveLength(2);
      expect(await detailOf(ana, target, run.id)).toMatchObject({
        status: "failed",
        errorCode: "rules_unavailable",
        errorMessage: RULES_UNAVAILABLE_RUN_MESSAGE,
        outputSizeBytes: INPUT.byteLength,
        validationResults: null,
      });
    });

    describe("the lease (Preflight ruling 11, Ruling 41): 174 + d s, the evaluator asked only while 45 s of it are left", () => {
      /** A tester whose answer comes `elapsedMs` after the claim, on the dispatcher's monotonic clock. */
      function slowTester(clock: { now: number }, elapsedMs: number): OtelcolTestingClient {
        return {
          health: () => tester.client.health(),
          run: async (request, options) => {
            const result = await tester.client.run(request, options);
            clock.now = elapsedMs;
            return result;
          },
        };
      }
      /** The lease of a 5 s run, in milliseconds. */
      const leaseMs = (5 + TEST_RUN_LEASE_OVERHEAD_SECONDS) * 1000;

      it("exactly 45 s left: asked; less: the outage path, never asked", async () => {
        expect(TEST_RUN_LEASE_OVERHEAD_SECONDS).toBe(174);
        expect(TEST_RUN_EVALUATION_LEASE_MS).toBe(45_000);
        const { ana, target } = await anaWithTwoRules();
        const enough = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
        const clock = { now: 0 };
        await runAll(dispatcher({ tester: slowTester(clock, leaseMs - 45_000), monotonicNow: () => clock.now }));
        expect((await row(enough.id)).status).toBe("validation_failed");
        expect(evaluations()).toHaveLength(1);

        const late = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
        const lateClock = { now: 0 };
        await runAll(dispatcher({ tester: slowTester(lateClock, leaseMs - 45_000 + 1), monotonicNow: () => lateClock.now }));
        expect(await row(late.id)).toMatchObject({ status: "failed", error_code: "rules_unavailable", output_size_bytes: INPUT.byteLength });
        expect(evaluations()).toEqual([]);
      });

      it("the worst case (Ruling 41): sent at the send window's end, answered at the tester's full timeout, its files taking their full 30 s, the rules are still checked with the evaluator's 40 s; 1 ms past the window it is never sent", async () => {
        // 25 + (74 + d) + 30 + 40 + 5 = 174 + d; the pre-send check reserves all but the window.
        expect(TEST_RUN_SEND_WINDOW_SECONDS).toBe(25);
        expect(TEST_RUN_FILES_SECONDS).toBe(30);
        expect(TEST_RUN_LEASE_OVERHEAD_SECONDS).toBe(25 + 74 + 30 + 40 + 5);
        expect(testRunPreSendReserveMs(5)).toBe((74 + 5 + 30 + 40 + 5) * 1000);
        expect(leaseMs - testRunPreSendReserveMs(5)).toBe(TEST_RUN_SEND_WINDOW_SECONDS * 1000);
        const { ana, target } = await anaWithTwoRules();

        /**
         * Carries one run on a monotonic clock that only the run moves: its
         * input's read to `sentAtMs` after the claim, the tester's answer by
         * its client's full timeout, the answer's files' writes by their
         * full 30 s. What the evaluator was asked with, and when.
         */
        const carried = async (sentAtMs: number) => {
          const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
          const clock = { now: 0 };
          let sentAt: number | undefined;
          const asked: Array<{ leftMs: number; timeoutMs: number | undefined }> = [];
          const slowStore: IFileStore = {
            ...store,
            read: async (key) => {
              if (key.kind === "test-run" && key.name === "input") clock.now = sentAtMs;
              return store.read(key);
            },
            write: async (key, chunks, options) => {
              const written = await store.write(key, chunks, options);
              if (key.kind === "test-run" && sentAt !== undefined) {
                clock.now = sentAt + otelcolTestingRunTimeoutMs(5) + TEST_RUN_FILES_SECONDS * 1000;
              }
              return written;
            },
          };
          const fullTimeout: OtelcolTestingClient = {
            health: () => tester.client.health(),
            run: async (request, options) => {
              sentAt = clock.now;
              const result = await tester.client.run(request, options);
              clock.now = sentAt + otelcolTestingRunTimeoutMs(request.durationSeconds);
              return result;
            },
          };
          const watching: OttlEvaluatorClient = {
            ...evaluator.client,
            evaluate: (request, options) => {
              asked.push({ leftMs: leaseMs - clock.now, timeoutMs: options?.timeoutMs });
              return evaluator.client.evaluate(request, options);
            },
          };
          await runAll(dispatcher({ tester: fullTimeout, evaluator: watching, fileStore: slowStore, monotonicNow: () => clock.now }));
          return { run, sentAt, asked };
        };

        // Sent at 25 s: answered at 104 s, stored by 134 s, 45 s left: asked, its 40 s whole.
        const inWindow = await carried(TEST_RUN_SEND_WINDOW_SECONDS * 1000);
        expect(inWindow.sentAt).toBe(25_000);
        expect(inWindow.asked).toEqual([{ leftMs: 45_000, timeoutMs: 40_000 }]);
        expect(await row(inWindow.run.id)).toMatchObject({
          status: "validation_failed",
          error_code: null,
          output_size_bytes: INPUT.byteLength,
        });
        expect(evaluations()).toHaveLength(1);
        expect(tester.fake.takeRequests()).toHaveLength(1);

        // 1 ms past the window: never sent, interrupted.
        const late = await carried(TEST_RUN_SEND_WINDOW_SECONDS * 1000 + 1);
        expect(late.sentAt).toBeUndefined();
        expect(late.asked).toEqual([]);
        expect(await row(late.run.id)).toMatchObject({ status: "failed", error_code: "interrupted", output_size_bytes: null });
        expect(tester.fake.takeRequests()).toEqual([]);
        expect(evaluations()).toEqual([]);
      });

      it("busy, and after the 1 s wait too little lease is left: the outage path, not asked again", async () => {
        const { ana, target } = await anaWithTwoRules();
        const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
        const clock = { now: 0 };
        evaluator.fake.nextFault("evaluator_busy");
        await runAll(
          dispatcher({
            tester: slowTester(clock, leaseMs - 45_500),
            monotonicNow: () => clock.now,
            wait: async (ms) => void (clock.now += ms),
          }),
        );
        expect(evaluations()).toHaveLength(1);
        expect(await row(run.id)).toMatchObject({ status: "failed", error_code: "rules_unavailable" });
      });

      it("a lease lost during evaluation is the reaper's: the run stays interrupted, the answer dropped and its files removed", async () => {
        const { ana, target } = await anaWithTwoRules();
        const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
        // While the evaluator checks the rules, the run stops being this
        // lease's, as the reaper does once the lease has passed.
        const losing: OttlEvaluatorClient = {
          ...evaluator.client,
          evaluate: async (request, options) => {
            const answer = await evaluator.client.evaluate(request, options);
            const { lease_id } = await row(run.id);
            expect(await finishTestRun(db, { id: run.id, leaseId: lease_id! }, "failed", failureResults(TEST_RUN_FAILURES.interrupted))).toBe(true);
            return answer;
          },
        };
        await runAll(dispatcher({ evaluator: losing }));
        expect(await row(run.id)).toMatchObject({
          status: "failed",
          error_code: "interrupted",
          validation_results: null,
          output_size_bytes: null,
        });
        const output = await store.read({ kind: "test-run", organizationId: ana.organizationId, runId: run.id, name: "output" });
        expect(output.found).toBe(false);
        expect(evaluations()).toHaveLength(1);
      });

      it("stopped while the evaluator checks the rules: Error, interrupted, the tester's answer kept", async () => {
        const { ana, target } = await anaWithTwoRules();
        const run = await queued(ana, target, oneOff({ inputFileId: await inputFile(ana) }));
        evaluator.fake.nextFault("hang");
        let asked = (): void => undefined;
        const isAsked = new Promise<void>((resolve) => {
          asked = resolve;
        });
        const watching: OttlEvaluatorClient = {
          ...evaluator.client,
          evaluate: (request, options) => {
            asked();
            return evaluator.client.evaluate(request, options);
          },
        };
        const stopping = dispatcher({ evaluator: watching });
        await stopping.tick();
        await isAsked;
        await stopping.stop();
        expect(await row(run.id)).toMatchObject({
          status: "failed",
          error_code: "interrupted",
          error_message: "The run was interrupted. Run it again.",
          validation_results: null,
          output_size_bytes: INPUT.byteLength,
        });
        evaluator.fake.takeRequests();
      });
    });
  });
});
