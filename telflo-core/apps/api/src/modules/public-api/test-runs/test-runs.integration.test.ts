import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely, Selectable } from "kysely";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES,
  PUBLIC_VALIDATION_RULE_INVALID_MESSAGE,
  PublicQueueTestRunRequestSchema,
  TEST_RUNS_WAITING_MAXIMUM_PER_USER,
} from "@telflo/contracts";
import { createDb, createPool, type Database, type TestRunsTable } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addPersonalApiToken,
  addServiceAccount,
  addTestRun,
  addValidationPipeline,
  addValidationRule,
  catalogueDefaults,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { withAuthContext } from "../../../database/context.js";
import { createFileStore } from "../../../file-store/create-file-store.js";
import type { IFileStore } from "../../../file-store/file-store.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../../http/rate-limits.js";
import { createInMemoryMailer } from "../../../mail/in-memory-mailer.js";
import { buildServer } from "../../../server.js";
import { loadSettings, type AppSettings } from "../../../settings.js";
import { fakeOttlEvaluatorMarker } from "../../../testing/fake-ottl-evaluator.js";
import { useFakeOpampServer } from "../../../testing/opamp-server.js";
import { UNCALLED_TESTING, useFakeOtelcolTesting } from "../../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../../testing/otelcol-validator.js";
import { useFakeOttlEvaluator } from "../../../testing/ottl-evaluator.js";
import { validatePublicReply } from "../../../testing/public-api-openapi.js";
import { hashPassword } from "../../identity/password.js";
import { apiTokenHash } from "../../service-accounts/tokens.js";
import type { IOrganizationVariables } from "../../test-runs/organization-variables.js";
import { createTestRunDispatcher, type TestRunDispatcher, type TestRunDispatcherLog } from "../../test-runs/dispatcher.js";
import { createTestRunRepository } from "../../test-runs/repositories/test-run-repository.js";
import { createTestRunQueueSignal, type TestRunQueueSignal } from "../../test-runs/test-runs-dependencies.js";
import { publicApiDocument } from "../openapi/document.js";

/*
 * The public surface's test runs, through the real server as the API's own
 * role, a real FileStore on a temporary directory, the OpenAPI-checked fake
 * tester and fake OTTL evaluator, and the dispatcher claiming runs as its
 * own tests do. Each route: success through a real service account's token,
 * a read token on the POST 403, another organization's ids 404, another
 * member's YAML run 404, a person's run of their own draft invisible to the
 * token, and every JSON reply checked against the OpenAPI document. Then: a
 * YAML run queued, claimed, read back with its output; a version's run with
 * inline rules (the request's snapshot), saved rules (the database's) and
 * none; the sample stored as the caller's test file and counted; the
 * sample's 1 MiB and the body's 8 MiB; the browser's runs list without YAML
 * runs; and no log line or audit row holding the text, the sample or a
 * rule.
 *
 * Tokens are built at run time by addApiToken and never printed: `call`
 * runs its canary (a boolean) on every reply before any comparison of it.
 */

const opamp = useFakeOpampServer();
const tester = useFakeOtelcolTesting();
const evaluator = useFakeOttlEvaluator();

const P = "/api/public/v1";
const ROUTE = {
  queue: `${P}/test-runs`,
  run: `${P}/test-runs/:runId`,
  output: `${P}/test-runs/:runId/output`,
} as const;

type Route = (typeof ROUTE)[keyof typeof ROUTE];

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** Markers no log line or audit row may hold (configuration text). */
const YAML_MARKER = "yaml-marker-7f3e";
const SAMPLE_MARKER = "sample-marker-2b9c";
const RULE_NAME_MARKER = "rule-name-marker-5d10";
const CONDITION_MARKER = "condition-marker-c4a1";
const SAVED_RULE_MARKER = "saved-rule-marker-90be";

/** A text with two pipelines; its comment carries a marker. */
const YAML = [
  `# ${YAML_MARKER}`,
  "receivers:",
  "  otlp:",
  "exporters:",
  "  debug:",
  "service:",
  "  pipelines:",
  "    logs/app:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

/** The sample, which the fake tester echoes as the run's output. */
const SAMPLE = `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"${SAMPLE_MARKER}"}}]}]}]}`;

/** A text rule that passes on the sample's output; its name carries a marker. */
const TEXT_RULE = { kind: "contains_text", target: "output", pattern: SAMPLE_MARKER, name: `Rule ${RULE_NAME_MARKER}` };
/** An OTTL rule the evaluator checks; its condition carries a marker. */
const OTTL_RULE = {
  kind: "ottl",
  target: "output",
  ottl: { context: "log", quantifier: "all", condition: `attributes["k"] != "${CONDITION_MARKER}"` },
};

type Run = Selectable<TestRunsTable>;

/** A log that records every line of the dispatcher's, to check none holds a text, a sample or a rule. */
function recordingLog(): TestRunDispatcherLog & { lines: Array<{ details: Record<string, unknown>; message: string }> } {
  const lines: Array<{ details: Record<string, unknown>; message: string }> = [];
  return {
    lines,
    warn: (details, message) => lines.push({ details, message }),
    error: (details, message) => lines.push({ details, message }),
  };
}

interface CallOptions {
  runId?: string;
  payload?: unknown;
  /** Another server than the default one (a test's own limits). */
  on?: FastifyInstance;
  /** X-Telflo-Org, for a personal token. */
  organizationId?: string;
}

describe("the public test runs routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let root: string;
  let store: IFileStore;
  let signal: TestRunQueueSignal;
  let passwordHash: string;
  let server: FastifyInstance;
  const servers: FastifyInstance[] = [];
  const dispatchers: TestRunDispatcher[] = [];
  let logLines: string[] = [];
  let dispatcherLog: ReturnType<typeof recordingLog>;

  async function serverWith(
    rateLimits: RateLimits = TEST_RATE_LIMITS,
    organizationVariables: IOrganizationVariables = UNCALLED_TESTING.organizationVariables,
  ): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    let built: FastifyInstance;
    try {
      built = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: store,
        testing: { ...UNCALLED_TESTING, tester: tester.client, ottlEvaluator: evaluator.client, queued: signal, organizationVariables },
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
    root = await mkdtemp(join(tmpdir(), "telflo-public-test-runs-"));
    store = await createFileStore({ kind: "local", root });
    signal = createTestRunQueueSignal();
    passwordHash = await hashPassword(PASSWORD);
    server = await serverWith();
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await db.destroy();
    await ownerDb.destroy();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    logLines = [];
    dispatcherLog = recordingLog();
    tester.fake.setHealth("ready");
    tester.fake.takeRequests();
    evaluator.fake.takeRequests();
  });

  afterEach(async () => {
    for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
    tester.fake.releaseHeld();
    expect(tester.fake.takeViolations()).toEqual([]);
    expect(evaluator.fake.takeViolations()).toEqual([]);
    // The text, the sample and the rules are configuration text. No
    // log line (the server's, the dispatcher's) and no audit row holds one.
    const logged = logLines.join("\n") + JSON.stringify(dispatcherLog.lines);
    const audited = JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().execute());
    for (const marker of [YAML_MARKER, SAMPLE_MARKER, RULE_NAME_MARKER, CONDITION_MARKER, SAVED_RULE_MARKER, "fake-ottl-evaluator"]) {
      expect(logged.includes(marker)).toBe(false);
      expect(audited.includes(marker)).toBe(false);
    }
  });

  /** Whether `text` holds the token, its body without tf_, its hash or its prefix. */
  const holdsToken = (text: string, token: string) =>
    [token.slice(3), apiTokenHash(token), token.slice(0, 11)].some((needle) => text.includes(needle));

  /** An admin person (who can sign in) of a new group organization, and its service account with a read and a write token. */
  const organization = async () => {
    const at = new Date(Date.now() - 60_000);
    const admin = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
    const account = async () => {
      const { user } = await addServiceAccount(ownerDb, { organizationId: group.id, createdAt: at });
      const tokenOf = async (access: "read" | "write") =>
        (await addApiToken(ownerDb, { organizationId: group.id, serviceAccountUserId: user.id, created_at: at, access })).token;
      return { userId: user.id, read: await tokenOf("read"), write: await tokenOf("write") };
    };
    const first = await account();
    return {
      id: group.id,
      adminId: admin.user.id,
      adminEmail: admin.user.email,
      accountUserId: first.userId,
      read: first.read,
      write: first.write,
      /** A second service account of the same organization: another member. */
      another: account,
    };
  };
  type Organization = Awaited<ReturnType<typeof organization>>;

  /** A configuration made by `createdBy` with its version 1 holding YAML, published or a draft. */
  const configurationOf = async (organizationId: string, createdBy: string, options: { published?: boolean } = {}) => {
    const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: createdBy });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      version_number: 1,
      yaml_content: YAML,
      created_by_user_id: createdBy,
      ...(options.published === true && { publishedAt: new Date(), publishedByUserId: createdBy }),
    });
    return { organizationId, configurationId: configuration.id, versionId: version.id };
  };
  type Target = Awaited<ReturnType<typeof configurationOf>>;

  /** A request to `route` with `token`; the reply's canary first, then a JSON reply checked against the OpenAPI document. */
  const call = async (method: "GET" | "POST", route: Route, token: string, options: CallOptions = {}) => {
    const url = route.replace(":runId", encodeURIComponent(options.runId ?? ""));
    const response = await (options.on ?? server).inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(typeof options.payload === "string" && { "content-type": "application/json" }),
        ...(options.organizationId !== undefined && { "x-telflo-org": options.organizationId }),
      },
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
    expect(holdsToken(response.body, token)).toBe(false);
    const isJson = String(response.headers["content-type"] ?? "").startsWith("application/json");
    const body: unknown = isJson ? response.json() : undefined;
    expect(validatePublicReply(method, route, response.statusCode, body).errors).toEqual([]);
    return response;
  };

  const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string) => {
    expect(response.statusCode).toBe(statusCode);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
  };

  /** A YAML run's body, with one text rule unless `overrides` says otherwise (`rules: undefined` for none). */
  const yamlBody = (overrides: Record<string, unknown> = {}) => ({
    yaml: YAML,
    sample: SAMPLE,
    signal: "logs",
    pipeline: "logs/app",
    rules: [TEXT_RULE],
    ...overrides,
  });
  const versionBody = (target: Target, overrides: Record<string, unknown> = {}) => ({
    configurationId: target.configurationId,
    versionNumber: 1,
    sample: SAMPLE,
    signal: "logs",
    pipeline: "logs/app",
    rules: [TEXT_RULE],
    ...overrides,
  });

  /** Queues a run: its id. */
  const queued = async (token: string, payload: unknown, on?: FastifyInstance, organizationId?: string): Promise<string> => {
    const response = await call("POST", ROUTE.queue, token, {
      payload,
      ...(on === undefined ? {} : { on }),
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{ id: string; status: string }>();
    expect(body.status).toBe("queued");
    return body.id;
  };

  const row = (id: string): Promise<Run> => ownerDb.selectFrom("test_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  const testFiles = () => ownerDb.selectFrom("test_input_files").selectAll().execute();

  /** Every file under the FileStore's folder of `organizationId`'s runs (none when there is no folder). */
  const runFilesOf = async (organizationId: string): Promise<string[]> => {
    try {
      const entries = await readdir(join(root, "organizations", organizationId, "test-runs"), { recursive: true, withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  /** A run's own copy of its input, as text. */
  const runInput = async (organizationId: string, runId: string): Promise<string> => {
    const opened = await store.read({ kind: "test-run", organizationId, runId, name: "input" });
    if (!opened.found) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  };

  /** Claims and carries every waiting run to its end, as the dispatcher's own tests do. */
  const runAll = async () => {
    const dispatcher = createTestRunDispatcher({
      db,
      fileStore: store,
      tester: tester.client,
      evaluator: evaluator.client,
      organizationVariables: UNCALLED_TESTING.organizationVariables,
      queued: signal,
      runsPerTester: 4,
      log: dispatcherLog,
    });
    dispatchers.push(dispatcher);
    await dispatcher.tick();
    await dispatcher.settled();
  };

  const validateRequests = () => evaluator.fake.takeRequests().filter((request) => request.operation === "validate");

  describe("a YAML run", () => {
    it("queues, is claimed by the dispatcher, reads back with its output; a service account's sample goes once the run holds its copy; its audit row names its source and file", async () => {
      const org = await organization();
      const runId = await queued(org.write, yamlBody());

      const stored = await row(runId);
      const { distribution, version } = await catalogueDefaults(ownerDb);
      expect(stored).toMatchObject({
        organization_id: org.id,
        configuration_id: null,
        configuration_version_id: null,
        queued_by_user_id: org.accountUserId,
        status: "queued",
        target_pipeline: "logs/app",
        signal: "logs",
        duration_seconds: 5,
        collector_distribution: distribution,
        collector_version: version,
        input_name: "api-sample.json",
        input_size_bytes: Buffer.byteLength(SAMPLE),
        validation_pipeline_id: null,
      });
      expect(stored.yaml === YAML).toBe(true);
      expect(stored.validation_rules).toEqual([
        { id: expect.any(String), position: 1, kind: "contains_text", target: "output", pattern: SAMPLE_MARKER, ottl: null, name: `Rule ${RULE_NAME_MARKER}`, description: "" },
      ]);
      // The sample was the caller's test file; a service account's goes
      // once the run holds its own copy.
      expect(await testFiles()).toEqual([]);
      expect((await runInput(org.id, runId)) === SAMPLE).toBe(true);
      const audit = await ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "test_run.queued").execute();
      expect(audit).toMatchObject([
        { actor_user_id: org.accountUserId, organization_id: org.id, subject_type: "test_run", subject_id: runId, metadata: { source: "yaml", inputFileId: expect.any(String) } },
      ]);
      const inputFileId = (audit[0]!.metadata as { inputFileId: string }).inputFileId;
      expect((await store.read({ kind: "test-input", organizationId: org.id, userId: org.accountUserId, fileId: inputFileId })).found).toBe(false);

      const waiting = await call("GET", ROUTE.run, org.read, { runId });
      expect(waiting.statusCode).toBe(200);
      expect(waiting.headers["cache-control"]).toBe("no-store");
      expect(waiting.json()).toEqual({
        id: runId,
        status: "queued",
        success: null,
        signal: "logs",
        pipeline: "logs/app",
        durationMs: null,
        collectorVersion: version,
        distribution,
        validationResults: null,
        mutations: null,
        compatibility: null,
        errorMessage: null,
        createdAt: stored.queued_at.toISOString(),
      });
      expectRefusal(await call("GET", ROUTE.output, org.read, { runId }), 404, "test_run_output_not_found");

      await runAll();
      const ended = await call("GET", ROUTE.run, org.read, { runId });
      expect(ended.statusCode).toBe(200);
      const run = ended.json<{ status: string; success: boolean; durationMs: number | null; validationResults: Array<{ id: string; passed: boolean }> }>();
      expect(run).toMatchObject({ status: "succeeded", success: true });
      expect(run.durationMs).toEqual(expect.any(Number));
      expect(run.validationResults).toEqual([expect.objectContaining({ id: stored.validation_rules[0] && (stored.validation_rules[0] as { id: string }).id, passed: true })]);

      const output = await call("GET", ROUTE.output, org.read, { runId });
      expect(output.statusCode).toBe(200);
      expect(output.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(output.headers["x-content-type-options"]).toBe("nosniff");
      expect(output.headers["cache-control"]).toBe("no-store");
      expect(output.body === SAMPLE).toBe(true);
    });

    it("takes the named distribution and collector version, and refuses an unknown or retired one before anything is stored", async () => {
      const org = await organization();
      const { distribution, version } = await catalogueDefaults(ownerDb);
      const runId = await queued(org.write, yamlBody({ distribution, collectorVersion: version, durationSeconds: 7 }));
      expect(await row(runId)).toMatchObject({ collector_distribution: distribution, collector_version: version, duration_seconds: 7 });

      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ distribution: "no-such-distribution" }) }), 400, "collector_distribution_unknown");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ collectorVersion: "0.0.1" }) }), 400, "collector_version_unknown");
      // A retired version, added for this test alone (the catalog is shared, so it goes again).
      const retired = "0.0.2";
      await ownerDb
        .insertInto("collector_versions")
        .values({
          distribution,
          version: retired,
          label: `v${retired}`,
          description: null,
          released_at: "2020-01-01",
          is_default: false,
          deprecated: true,
          deprecated_note: "Retired fixture.",
          container_image: `example/${distribution}:${retired}`,
          otelcol_contrib_version: null,
          supported_components: null,
          otelcol_contrib: "{}",
          opamp_supervisor: "{}",
        })
        .execute();
      try {
        expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ collectorVersion: retired }) }), 400, "collector_version_retired");
      } finally {
        await ownerDb.deleteFrom("collector_versions").where("distribution", "=", distribution).where("version", "=", retired).execute();
      }
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toHaveLength(1);
    });

    it("a named distribution with no default takes a named version, and is 400 collector_distribution_unknown without one", async () => {
      const org = await organization();
      const noDefault = "no-default-build";
      const offered = "0.0.3";
      await ownerDb
        .insertInto("collector_distributions")
        .values({ id: noDefault, label: "No Default Build", description: null, icon: null, sort_order: 99, is_default: false })
        .execute();
      try {
        await ownerDb
          .insertInto("collector_versions")
          .values({
            distribution: noDefault,
            version: offered,
            label: `v${offered}`,
            description: null,
            released_at: "2026-01-01",
            is_default: false,
            deprecated: false,
            deprecated_note: null,
            container_image: `example/${noDefault}:${offered}`,
            otelcol_contrib_version: "0.162.0",
            supported_components: null,
            otelcol_contrib: "{}",
            opamp_supervisor: "{}",
          })
          .execute();
        expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ distribution: noDefault }) }), 400, "collector_distribution_unknown");
        const runId = await queued(org.write, yamlBody({ distribution: noDefault, collectorVersion: offered }));
        expect(await row(runId)).toMatchObject({ collector_distribution: noDefault, collector_version: offered });
      } finally {
        await ownerDb.deleteFrom("test_runs").where("collector_distribution", "=", noDefault).execute();
        await ownerDb.deleteFrom("collector_versions").where("distribution", "=", noDefault).execute();
        await ownerDb.deleteFrom("collector_distributions").where("id", "=", noDefault).execute();
      }
    });

    it("a person's sample stays in their My Files: a personal token's run", async () => {
      const org = await organization();
      const { token } = await addPersonalApiToken(ownerDb, { userId: org.adminId, access: "write" });
      const runId = await queued(token, yamlBody(), undefined, org.id);
      expect(await row(runId)).toMatchObject({ queued_by_user_id: org.adminId, configuration_id: null });
      const files = await testFiles();
      expect(files).toMatchObject([
        { organization_id: org.id, owner_user_id: org.adminId, file_name: "api-sample.json", content_type: "application/json", size_bytes: Buffer.byteLength(SAMPLE) },
      ]);
      const audit = await ownerDb.selectFrom("audit_events").select("metadata").where("action", "=", "test_run.queued").executeTakeFirstOrThrow();
      expect(audit.metadata).toEqual({ source: "yaml", inputFileId: files[0]!.id });
      expect((await store.read({ kind: "test-input", organizationId: org.id, userId: org.adminId, fileId: files[0]!.id })).found).toBe(true);
    });

    it("is its creator's alone: another member's token and another organization's answer 404; a malformed id 404", async () => {
      const org = await organization();
      const runId = await queued(org.write, yamlBody());
      const teammate = await org.another();
      const other = await organization();
      for (const token of [teammate.read, other.read]) {
        expectRefusal(await call("GET", ROUTE.run, token, { runId }), 404, "test_run_not_found");
        expectRefusal(await call("GET", ROUTE.output, token, { runId }), 404, "test_run_not_found");
      }
      expectRefusal(await call("GET", ROUTE.run, org.read, { runId: "not-a-uuid" }), 404, "test_run_not_found");
      expectRefusal(await call("GET", ROUTE.output, org.read, { runId: randomUUID() }), 404, "test_run_not_found");
    });

    it("refuses a pipeline the text doesn't have (422, fixed words), a pipeline of another signal, both sources, and useSavedRules on a text", async () => {
      const org = await organization();
      const missing = await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ pipeline: "logs/missing-pipeline-name" }) });
      expectRefusal(missing, 422, "configuration_invalid");
      expect(missing.body.includes("missing-pipeline-name")).toBe(false);
      expect(missing.json<{ error: { details: unknown } }>().error.details).toEqual({
        errors: [{ message: "The configuration has no pipeline of this name.", componentPath: "service.pipelines" }],
      });
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ yaml: "receivers: [" }) }), 422, "configuration_invalid");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ pipeline: "traces" }) }), 400, "invalid_request");
      const target = await configurationOf(org.id, org.accountUserId);
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: { ...versionBody(target), yaml: YAML } }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: undefined, useSavedRules: true }) }), 400, "invalid_request");
      // Neither rules nor useSavedRules.
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: undefined }) }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [TEXT_RULE], useSavedRules: true }) }), 400, "invalid_request");
      expect(await testFiles()).toEqual([]);
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
    });
  });

  describe("a version's run", () => {
    /** The account's own draft, with a saved validation pipeline for logs/app holding one rule. */
    const withSavedRule = async (org: Organization) => {
      const target = await configurationOf(org.id, org.accountUserId);
      const ids = { organizationId: org.id, configurationId: target.configurationId, configurationVersionId: target.versionId };
      const pipeline = await addValidationPipeline(ownerDb, { ...ids, pipeline_name: "logs/app", signal: "logs", created_by_user_id: org.accountUserId });
      const saved = await addValidationRule(ownerDb, {
        ...ids,
        validationPipelineId: pipeline.id,
        kind: "contains_text",
        target: "output",
        pattern: SAVED_RULE_MARKER,
        created_by_user_id: org.accountUserId,
      });
      return { target, pipelineId: pipeline.id, savedRuleId: saved.id };
    };

    it("with inline rules: the snapshot is the request's checked rules with fresh ids, not the saved ones; each OTTL or regex rule checked once", async () => {
      const org = await organization();
      const { target, savedRuleId } = await withSavedRule(org);
      const runId = await queued(org.write, versionBody(target, { rules: [TEXT_RULE, OTTL_RULE] }));
      const stored = await row(runId);
      expect(stored).toMatchObject({
        configuration_id: target.configurationId,
        configuration_version_id: target.versionId,
        validation_pipeline_id: null,
        input_name: "api-sample.json",
      });
      expect(stored.yaml === YAML).toBe(true);
      const rules = stored.validation_rules as Array<{ id: string }>;
      expect(rules).toEqual([
        { id: expect.any(String), position: 1, kind: "contains_text", target: "output", pattern: SAMPLE_MARKER, ottl: null, name: `Rule ${RULE_NAME_MARKER}`, description: "" },
        { id: expect.any(String), position: 2, kind: "ottl", target: "output", pattern: null, ottl: OTTL_RULE.ottl, name: "", description: "" },
      ]);
      expect(rules.some((rule) => rule.id === savedRuleId)).toBe(false);
      expect(new Set(rules.map((rule) => rule.id)).size).toBe(2);
      // The text rule needs no check; the OTTL rule one.
      expect(validateRequests()).toHaveLength(1);
      const audit = await ownerDb.selectFrom("audit_events").select("metadata").where("action", "=", "test_run.queued").executeTakeFirstOrThrow();
      expect(audit.metadata).toEqual({
        configurationId: target.configurationId,
        versionId: target.versionId,
        inputFileId: expect.any(String),
      });

      await runAll();
      const ended = (await call("GET", ROUTE.run, org.read, { runId })).json<{ status: string; validationResults: Array<{ id: string }> }>();
      expect(ended.status).toBe("succeeded");
      expect(ended.validationResults.map((result) => result.id)).toEqual(rules.map((rule) => rule.id));
    });

    it("with useSavedRules: the database's snapshot (the saved pipeline and its rules); with neither: 400", async () => {
      const org = await organization();
      const { target, pipelineId, savedRuleId } = await withSavedRule(org);
      const saved = await row(await queued(org.write, versionBody(target, { rules: undefined, useSavedRules: true })));
      expect(saved.validation_pipeline_id).toBe(pipelineId);
      expect(saved.validation_rules).toMatchObject([{ id: savedRuleId, position: 1, kind: "contains_text", pattern: SAVED_RULE_MARKER }]);
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: versionBody(target, { rules: undefined }) }), 400, "invalid_request");
      expect(validateRequests()).toEqual([]);
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toHaveLength(1);
    });

    it("useSavedRules on a pipeline with no saved rules is 422 in fixed words, before anything is stored or spent", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, testFileUploadsPerUser: { max: 1, windowMs: 60_000 } });
      const org = await organization();
      const { target } = await withSavedRule(org);
      const traces = { rules: undefined, useSavedRules: true, signal: "traces", pipeline: "traces" };
      const refused = await call("POST", ROUTE.queue, org.write, { payload: versionBody(target, traces), on: limited });
      expectRefusal(refused, 422, "configuration_invalid");
      expect(refused.json<{ error: { details: unknown } }>().error.details).toEqual({
        errors: [{ message: "The version has no saved validation rules for this pipeline.", componentPath: null }],
      });
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
      // No upload spent: the one allowed still queues.
      await queued(org.write, versionBody(target, { rules: undefined, useSavedRules: true }), limited);
    });

    it("useSavedRules whose rules are deleted between the pre-check and the insert is 422: no run, no sample, no run files", async () => {
      const org = await organization();
      const { target, pipelineId } = await withSavedRule(org);
      // The version's text references an organization variable, so the queue
      // reads them (step 7), after its step 3 and before its step 9's insert:
      // that read deletes the pipeline's rules, as a person in the
      // Validation tab could at that moment.
      await ownerDb
        .updateTable("configuration_versions")
        .set({ yaml_content: YAML.replace("  debug:\n", "  debug:\n    verbosity: ${org:LEVEL}\n") })
        .where("id", "=", target.versionId)
        .execute();
      let reads = 0;
      const deletingRules: IOrganizationVariables = {
        async read() {
          reads += 1;
          await ownerDb.deleteFrom("validation_rules").where("validation_pipeline_id", "=", pipelineId).execute();
          return { kind: "none" };
        },
      };
      const racing = await serverWith(TEST_RATE_LIMITS, deletingRules);
      const refused = await call("POST", ROUTE.queue, org.write, {
        payload: versionBody(target, { rules: undefined, useSavedRules: true }),
        on: racing,
      });
      expect(reads).toBe(1);
      expectRefusal(refused, 422, "configuration_invalid");
      expect(refused.json<{ error: { details: unknown } }>().error.details).toEqual({
        errors: [{ message: "The version has no saved validation rules for this pipeline.", componentPath: null }],
      });
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
      expect(await ownerDb.selectFrom("audit_events").select("id").where("action", "=", "test_run.queued").execute()).toEqual([]);
      expect(await testFiles()).toEqual([]);
      expect(await runFilesOf(org.id)).toEqual([]);
    });

    it("takes the version's pin unless collectorVersion names another; refuses a distribution that isn't its configuration's", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.accountUserId);
      const pin = await ownerDb.selectFrom("configuration_versions").select(["collector_version"]).where("id", "=", target.versionId).executeTakeFirstOrThrow();
      expect((await row(await queued(org.write, versionBody(target)))).collector_version).toBe(pin.collector_version);
      // The precheck reads a version's pin as the queue does.
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: versionBody(target, { distribution: "another-distribution" }) }), 400, "invalid_request");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: versionBody(target, { collectorVersion: "0.0.1" }) }), 400, "collector_version_unknown");
    });

    it("another organization's configuration, a malformed id, a number it has no version of, and another person's draft answer the configurations' 404s", async () => {
      const org = await organization();
      const other = await organization();
      const theirs = await configurationOf(other.id, other.accountUserId, { published: true });
      const personsDraft = await configurationOf(org.id, org.adminId);
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: versionBody(theirs) }), 404, "configuration_not_found");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: versionBody(personsDraft) }), 404, "configuration_not_found");
      expectRefusal(
        await call("POST", ROUTE.queue, org.write, { payload: { ...versionBody(personsDraft), configurationId: "not-a-uuid" } }),
        404,
        "configuration_not_found",
      );
      const own = await configurationOf(org.id, org.accountUserId);
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: versionBody(own, { versionNumber: 9 }) }), 404, "configuration_version_not_found");
      expect(await testFiles()).toEqual([]);
    });

    it("a teammate's run on a published configuration is visible; a person's run of their own draft is invisible to the token", async () => {
      const org = await organization();
      const published = await configurationOf(org.id, org.adminId, { published: true });
      const draft = await configurationOf(org.id, org.adminId);
      const onPublished = await addTestRun(ownerDb, {
        organizationId: org.id,
        configurationId: published.configurationId,
        configurationVersionId: published.versionId,
        queuedByUserId: org.adminId,
      });
      const onDraft = await addTestRun(ownerDb, {
        organizationId: org.id,
        configurationId: draft.configurationId,
        configurationVersionId: draft.versionId,
        queuedByUserId: org.adminId,
      });
      const personsYamlRun = await addTestRun(ownerDb, {
        organizationId: org.id,
        configurationId: null,
        configurationVersionId: null,
        queuedByUserId: org.adminId,
      });
      expect((await call("GET", ROUTE.run, org.read, { runId: onPublished.id })).statusCode).toBe(200);
      expectRefusal(await call("GET", ROUTE.run, org.read, { runId: onDraft.id }), 404, "test_run_not_found");
      expectRefusal(await call("GET", ROUTE.run, org.read, { runId: personsYamlRun.id }), 404, "test_run_not_found");
    });
  });

  describe("access, the sample and the limits", () => {
    it("a read token can't queue (403 insufficient_access, nothing stored) and can read", async () => {
      const org = await organization();
      expectRefusal(await call("POST", ROUTE.queue, org.read, { payload: yamlBody() }), 403, "insufficient_access");
      expect(await testFiles()).toEqual([]);
      const runId = await queued(org.write, yamlBody());
      expect((await call("GET", ROUTE.run, org.read, { runId })).statusCode).toBe(200);
    });

    it("the sample is at most 1 MiB once decoded (413 payload_too_large, nothing stored); the body up to 8 MiB, so an escaped 1 MiB sample passes", async () => {
      const org = await organization();
      for (const sample of ["a".repeat(PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES + 1), "é".repeat(PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES / 2 + 1)]) {
        const refused = await call("POST", ROUTE.queue, org.write, { payload: JSON.stringify(yamlBody({ sample })) });
        expectRefusal(refused, 413, "payload_too_large");
        expect(refused.json<{ error: { message: string } }>().error.message).toBe("The sample is over 1 MiB.");
      }
      expect(await testFiles()).toEqual([]);
      // Exactly 1 MiB, and 1 MiB of a control character (about 6 MiB of JSON escapes).
      await queued(org.write, JSON.stringify(yamlBody({ sample: "a".repeat(PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES) })));
      const escaped = JSON.stringify(yamlBody({ sample: "\u0001".repeat(PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES) }));
      expect(escaped.length).toBeGreaterThan(6 * 1024 * 1024);
      await queued(org.write, escaped);
      expect((await ownerDb.selectFrom("test_runs").select("input_size_bytes").execute()).map((run) => run.input_size_bytes)).toEqual([
        PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES,
        PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES,
      ]);
      // Over 8 MiB, the body itself.
      const tooBig = JSON.stringify(yamlBody({ sample: "\u0001".repeat(1_500_000) }));
      expect(tooBig.length).toBeGreaterThan(8 * 1024 * 1024);
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: tooBig }), 413, "payload_too_large");
    });

    it("the sample counts in the caller's test file uploads (testFileUploadsPerUser), before anything is stored", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, testFileUploadsPerUser: { max: 1, windowMs: 60_000 } });
      const org = await organization();
      await queued(org.write, yamlBody(), limited);
      const refused = await call("POST", ROUTE.queue, org.write, { payload: yamlBody(), on: limited });
      expectRefusal(refused, 429, "rate_limited");
      expect(refused.headers["retry-after"]).toEqual(expect.any(String));
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toHaveLength(1);
    });

    it("an unknown pin spends no upload: it is refused before the sample is stored", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, testFileUploadsPerUser: { max: 1, windowMs: 60_000 } });
      const org = await organization();
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ collectorVersion: "0.0.1" }), on: limited }), 400, "collector_version_unknown");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ distribution: "no-such-distribution" }), on: limited }), 400, "collector_distribution_unknown");
      await queued(org.write, yamlBody(), limited);
    });

    it("counts in the caller's test runs a minute (testRunsPerUser) and refuses past it, the sample removed", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, testRunsPerUser: { max: 1, windowMs: 60_000 } });
      const org = await organization();
      await queued(org.write, yamlBody(), limited);
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody(), on: limited }), 429, "test_run_rate_limited");
      expect(await testFiles()).toEqual([]);
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toHaveLength(1);
    });

    /*
     * A refused run spends nothing. The minute is admitted before a rule
     * check or an upload, and a full queue is the pre-check's, so a run
     * refused by either leaves both for the next run. Proved by that next
     * run, whose own check and upload are the last ones left.
     */
    it("a run refused by the runs minute spends no rule check and no upload: the minute comes before both", async () => {
      // The clock only, so the minute's window can end while the checks' and the uploads' (ten minutes) go on.
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      try {
        const limited = await serverWith({
          ...TEST_RATE_LIMITS,
          testRunsPerUser: { max: 1, windowMs: 60_000 },
          validationRuleChecksPerUser: { max: 2, windowMs: 600_000 },
          testFileUploadsPerUser: { max: 2, windowMs: 600_000 },
        });
        const org = await organization();
        await queued(org.write, yamlBody({ rules: [OTTL_RULE] }), limited);
        expect(validateRequests()).toHaveLength(1);
        const refused = await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [OTTL_RULE] }), on: limited });
        expectRefusal(refused, 429, "test_run_rate_limited");
        expect(refused.headers["retry-after"]).toEqual(expect.any(String));
        expect(validateRequests()).toEqual([]);
        expect(await testFiles()).toEqual([]);
        expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toHaveLength(1);
        // The minute's window over: the second check and the second upload are still there.
        vi.setSystemTime(Date.now() + 61_000);
        await queued(org.write, yamlBody({ rules: [OTTL_RULE] }), limited);
        expect(validateRequests()).toHaveLength(1);
        expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a run refused by a full queue (TEST_RUNS_WAITING_MAXIMUM_PER_USER waiting) spends no minute, rule check or upload: the pre-check refuses it", async () => {
      const limited = await serverWith({
        ...TEST_RATE_LIMITS,
        testRunsPerUser: { max: 1, windowMs: 60_000 },
        validationRuleChecksPerUser: { max: 1, windowMs: 60_000 },
        testFileUploadsPerUser: { max: 1, windowMs: 60_000 },
      });
      const org = await organization();
      for (let index = 0; index < TEST_RUNS_WAITING_MAXIMUM_PER_USER; index += 1) {
        await addTestRun(ownerDb, { organizationId: org.id, configurationId: null, configurationVersionId: null, queuedByUserId: org.accountUserId });
      }
      const target = await configurationOf(org.id, org.adminId, { published: true });
      for (const payload of [yamlBody({ rules: [OTTL_RULE] }), versionBody(target, { rules: [OTTL_RULE] })]) {
        expectRefusal(await call("POST", ROUTE.queue, org.write, { payload, on: limited }), 429, "test_run_queue_full");
      }
      expect(validateRequests()).toEqual([]);
      expect(await testFiles()).toEqual([]);
      // The queue drained: the run is queued with the one minute, check and upload there are.
      await ownerDb.deleteFrom("test_runs").execute();
      await queued(org.write, yamlBody({ rules: [OTTL_RULE] }), limited);
      expect(validateRequests()).toHaveLength(1);
    });

    it("an inline rule refused after the minute was admitted gives the minute back", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, testRunsPerUser: { max: 1, windowMs: 60_000 } });
      const org = await organization();
      const tautology = { ...OTTL_RULE, ottl: { context: "log", quantifier: "all", condition: "true" } };
      const invalid = { kind: "contains_regex", target: "output", pattern: fakeOttlEvaluatorMarker("invalid") };
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [tautology] }), on: limited }), 400, "validation_rule_invalid");
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [invalid] }), on: limited }), 400, "validation_rule_invalid");
      expect(await testFiles()).toEqual([]);
      await queued(org.write, yamlBody(), limited);
    });
  });

  describe("inline rules' checks", () => {
    it("refuses an OTTL context the signal doesn't have and a condition that can't fail before any check; the evaluator's refusal with the rule's index", async () => {
      const org = await organization();
      const span = { ...OTTL_RULE, ottl: { ...OTTL_RULE.ottl, context: "span" } };
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [OTTL_RULE, span] }) }), 400, "invalid_request");
      const tautology = { ...OTTL_RULE, ottl: { context: "log", quantifier: "all", condition: "true" } };
      const refused = await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [OTTL_RULE, tautology] }) });
      expectRefusal(refused, 400, "validation_rule_invalid");
      expect(refused.json<{ error: { message: string; details: { ruleIndex: number } } }>().error).toMatchObject({
        message: PUBLIC_VALIDATION_RULE_INVALID_MESSAGE,
        details: { ruleIndex: 1 },
      });
      expect(validateRequests()).toEqual([]);

      const invalid = { kind: "contains_regex", target: "output", pattern: fakeOttlEvaluatorMarker("invalid") };
      const byEvaluator = await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [OTTL_RULE, invalid] }) });
      expectRefusal(byEvaluator, 400, "validation_rule_invalid");
      expect(byEvaluator.json<{ error: { message: string; details: { ruleIndex: number } } }>().error).toMatchObject({
        message: PUBLIC_VALIDATION_RULE_INVALID_MESSAGE,
        details: { ruleIndex: 1 },
      });
      expect(validateRequests()).toHaveLength(2);
      expect(await testFiles()).toEqual([]);
    });

    it("reserves a run's checks all at once in validationRuleChecksPerUser: 2 needed with 1 left is 429, the evaluator not asked, nothing queued", async () => {
      const limited = await serverWith({ ...TEST_RATE_LIMITS, validationRuleChecksPerUser: { max: 3, windowMs: 60_000 } });
      const org = await organization();
      await queued(org.write, yamlBody({ rules: [OTTL_RULE, TEXT_RULE, OTTL_RULE] }), limited);
      expect(validateRequests()).toHaveLength(2);
      const refused = await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [OTTL_RULE, OTTL_RULE] }), on: limited });
      expectRefusal(refused, 429, "validation_rule_rate_limited");
      expect(refused.headers["retry-after"]).toEqual(expect.any(String));
      expect(validateRequests()).toEqual([]);
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toHaveLength(1);
      // The one left is still there: a run needing one check passes.
      await queued(org.write, yamlBody({ rules: [OTTL_RULE] }), limited);
      expect(validateRequests()).toHaveLength(1);
    });

    it("the evaluator unreachable or known down is 503 rules_unavailable, nothing kept", async () => {
      const org = await organization();

      const unavailable = { kind: "contains_regex", target: "output", pattern: fakeOttlEvaluatorMarker("unavailable") };
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [unavailable] }) }), 503, "rules_unavailable");
      expect(validateRequests()).toHaveLength(1);
      // Known down (the shared row): refused before anything is stored or checked.
      await ownerDb.updateTable("ottl_evaluator_state").set({ down_since: new Date() }).execute();
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [TEXT_RULE, OTTL_RULE] }) }), 503, "rules_unavailable");
      expect(validateRequests()).toEqual([]);
      expect(await testFiles()).toEqual([]);
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
    });

    it("the tester down spends no rule check and no upload: refused before both", async () => {
      const limited = await serverWith({
        ...TEST_RATE_LIMITS,
        validationRuleChecksPerUser: { max: 1, windowMs: 60_000 },
        testFileUploadsPerUser: { max: 1, windowMs: 60_000 },
      });
      const org = await organization();
      await ownerDb.updateTable("otelcol_testing_state").set({ down_since: new Date() }).execute();
      expectRefusal(await call("POST", ROUTE.queue, org.write, { payload: yamlBody({ rules: [OTTL_RULE] }), on: limited }), 503, "testing_unavailable");
      expect(validateRequests()).toEqual([]);
      await ownerDb.updateTable("otelcol_testing_state").set({ down_since: null }).execute();
      await queued(org.write, yamlBody({ rules: [OTTL_RULE] }), limited);
      expect(validateRequests()).toHaveLength(1);
    });
  });

  describe("the browser never shows a YAML run", () => {
    it("a person's version list and run read leave out their YAML run; the repository's find and list never answer one, findYamlRun its creator's only", async () => {
      const org = await organization();
      const target = await configurationOf(org.id, org.adminId);
      const versionRun = await addTestRun(ownerDb, {
        organizationId: org.id,
        configurationId: target.configurationId,
        configurationVersionId: target.versionId,
        queuedByUserId: org.adminId,
      });
      const yamlRun = await addTestRun(ownerDb, { organizationId: org.id, configurationId: null, configurationVersionId: null, queuedByUserId: org.adminId });

      const signedIn = await server.inject({ method: "POST", url: "/api/v1/auth/sessions", headers: csrfHeaders, payload: { email: org.adminEmail, password: PASSWORD } });
      expect(signedIn.statusCode).toBe(200);
      const cookie = (response: LightMyRequestResponse) => {
        const header = response.headers["set-cookie"];
        const line = (Array.isArray(header) ? header : [header ?? ""]).find((each) => each.startsWith("telflo_access="))!;
        return line.slice("telflo_access=".length, line.indexOf(";"));
      };
      const switched = await server.inject({
        method: "PUT",
        url: "/api/v1/auth/sessions/current/organization",
        headers: csrfHeaders,
        cookies: { telflo_access: cookie(signedIn) },
        payload: { organizationId: org.id },
      });
      expect(switched.statusCode).toBe(200);
      const runsPath = `/api/v1/organizations/${org.id}/configurations/${target.configurationId}/versions/${target.versionId}/test-runs`;
      // A no-op when the sign-in already landed there: no new cookie, the sign-in's token stands.
      const access = switched.headers["set-cookie"] === undefined ? cookie(signedIn) : cookie(switched);
      const browse = (url: string) => server.inject({ method: "GET", url, headers: csrfHeaders, cookies: { telflo_access: access } });
      const listed = await browse(runsPath);
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ runs: Array<{ id: string }> }>().runs.map((run) => run.id)).toEqual([versionRun.id]);
      expect((await browse(`${runsPath}/${yamlRun.id}`)).statusCode).toBe(404);

      const asPerson = { userId: org.adminId, organizationId: org.id, role: "admin" as const };
      await withAuthContext(db, asPerson, async (transaction) => {
        const runs = createTestRunRepository(transaction, asPerson);
        expect(await runs.find(yamlRun.id)).toBeUndefined();
        expect((await runs.listForVersion(target.configurationId, target.versionId, 100)).map((run) => run.id)).toEqual([versionRun.id]);
        expect((await runs.findYamlRun(yamlRun.id))?.id).toBe(yamlRun.id);
        expect(await runs.findYamlRun(versionRun.id)).toBeUndefined();
      });
      const asAccount = { userId: org.accountUserId, organizationId: org.id, role: "contributor" as const };
      await withAuthContext(db, asAccount, async (transaction) => {
        expect(await createTestRunRepository(transaction, asAccount).findYamlRun(yamlRun.id)).toBeUndefined();
      });
    });
  });

  describe("the OpenAPI document's request is the contract's", () => {
    it("QueueTestRunRequest accepts and refuses each body as PublicQueueTestRunRequestSchema does", () => {
      const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
      const schemas = publicApiDocument().components.schemas ?? {};
      const rewritten = JSON.parse(JSON.stringify(schemas).replaceAll("#/components/schemas/", "#/$defs/")) as Record<string, object>;
      const validate = ajv.compile({ $defs: rewritten, $ref: "#/$defs/QueueTestRunRequest" });
      const version = { configurationId: randomUUID(), versionNumber: 1, sample: "", signal: "logs", pipeline: "logs", useSavedRules: true };
      const text = { yaml: "a: 1\n", sample: "{}", signal: "traces", pipeline: "traces/x", rules: [TEXT_RULE] };
      /** A version with neither rules nor useSavedRules. */
      const bare = { configurationId: version.configurationId, versionNumber: 1, sample: "", signal: "logs", pipeline: "logs" };
      const bodies: unknown[] = [
        version,
        text,
        bare,
        { ...bare, useSavedRules: false },
        { yaml: "a: 1\n", sample: "{}", signal: "traces", pipeline: "traces/x" },
        { yaml: "a: 1\n", sample: "{}", signal: "traces", pipeline: "traces/x", useSavedRules: false },
        { ...bare, rules: [TEXT_RULE], durationSeconds: 60 },
        { ...version, useSavedRules: true },
        { ...version, useSavedRules: false, rules: [OTTL_RULE] },
        { ...text, useSavedRules: false },
        { ...text, useSavedRules: true },
        { ...version, useSavedRules: true, rules: [TEXT_RULE] },
        { ...version, yaml: "a: 1\n" },
        { sample: "", signal: "logs", pipeline: "logs" },
        { ...text, versionNumber: 1 },
        { ...text, configurationId: randomUUID() },
        { configurationId: randomUUID(), sample: "", signal: "logs", pipeline: "logs" },
        { ...text, yaml: "" },
        { ...text, yaml: "a\u0000" },
        { ...text, yaml: "a\uD800b" },
        { ...text, yaml: "a".repeat(262_145) },
        { ...text, rules: [] },
        { ...text, rules: Array(21).fill(TEXT_RULE) },
        { ...text, durationSeconds: 0 },
        { ...text, durationSeconds: 61 },
        { ...text, durationSeconds: 1.5 },
        { ...version, versionNumber: 0 },
        { ...version, versionNumber: 1_000_000_000 },
        { ...text, collectorVersion: "latest" },
        { ...text, distribution: "Otelcol" },
        { ...text, pipeline: "" },
        { ...text, pipeline: "p".repeat(201) },
        { ...text, signal: "profiles" },
        { ...text, extra: 1 },
        { ...text, sample: undefined },
      ];
      // The pipeline's signal is the contract's alone (a JSON schema can't compare two strings).
      const disagreements = bodies.flatMap((body, index) => (validate(body) === PublicQueueTestRunRequestSchema.safeParse(body).success ? [] : [index]));
      expect(disagreements).toEqual([]);
    });
  });
});
