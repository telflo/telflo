import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addTestRun,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { createFileStore } from "../../file-store/create-file-store.js";
import type { IFileStore } from "../../file-store/file-store.js";
import { createCollectingRunner } from "../../http/after-response.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import type { OtelcolTestingHealthMonitor } from "../../otelcol-testing/health-monitor.js";
import type { OttlEvaluatorHealthMonitor } from "../../ottl-evaluator/health-monitor.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { fakeOtelcolTestingMarker } from "../../testing/fake-otelcol-testing.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_ORGANIZATION_VARIABLES, useFakeOtelcolTesting } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_OTTL_EVALUATOR } from "../../testing/ottl-evaluator.js";
import { registerTestRunBackground } from "./background.js";
import type { IOrganizationVariables } from "./organization-variables.js";
import { createTestRunQueueSignal, type TestingDependencies, type TestRunQueueSignal } from "./test-runs-dependencies.js";

/*
 * The test runs' one background starter. index.ts and e2e/start-api.ts run
 * it, after listen; buildServer never does, so no test's server runs a loop.
 * Closing the server stops the health monitors (the tester's, and the OTTL
 * evaluator's), the reaper and the dispatcher, which finishes the run it
 * aborts as interrupted.
 */

const opamp = useFakeOpampServer();
const tester = useFakeOtelcolTesting();

/** telflo-core, where index.ts's and e2e/start-api.ts's sources are read. */
const workspaceRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const source = (path: string) => readFileSync(join(workspaceRoot, path), "utf8");

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function* once(bytes: Buffer): AsyncGenerator<Buffer> {
  yield bytes;
}

describe("the test runs' background starter", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let settings: AppSettings;
  let root: string;
  let store: IFileStore;
  let signal: TestRunQueueSignal;
  /** What the health monitors were asked: each start and stop, the evaluator's marked as such. */
  let monitorCalls: string[];
  let subscriptions: number;
  const servers: FastifyInstance[] = [];

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    settings = loadSettings(process.env);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    root = await mkdtemp(join(tmpdir(), "telflo-background-"));
    store = await createFileStore({ kind: "local", root });
    signal = createTestRunQueueSignal();
    monitorCalls = [];
    subscriptions = 0;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    tester.fake.releaseHeld();
    expect(tester.fake.takeViolations()).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  /**
   * The real collaborators but the monitors, which only record, the
   * evaluator, which no run here reaches, and the organization variables'
   * source, which a run without a live `${org:NAME}` never reads.
   */
  function testing(organizationVariables: IOrganizationVariables = UNCALLED_ORGANIZATION_VARIABLES): TestingDependencies {
    const health: OtelcolTestingHealthMonitor = {
      start: () => void monitorCalls.push("start"),
      stop: async () => void monitorCalls.push("stop"),
      checkOnce: async () => undefined,
      view: () => ({ state: "unknown", consecutiveFailures: 0, downSince: null }),
    };
    const ottlEvaluatorHealth: OttlEvaluatorHealthMonitor = {
      start: () => void monitorCalls.push("evaluator start"),
      stop: async () => void monitorCalls.push("evaluator stop"),
      checkOnce: async () => undefined,
      view: () => ({ state: "unknown", consecutiveFailures: 0, downSince: null }),
    };
    return {
      tester: tester.client,
      health,
      ottlEvaluator: UNCALLED_OTTL_EVALUATOR,
      ottlEvaluatorHealth,
      organizationVariables,
      queued: {
        notify: () => signal.notify(),
        subscribe: (listener) => {
          subscriptions += 1;
          return signal.subscribe(listener);
        },
      },
    };
  }

  function server(dependencies: TestingDependencies): FastifyInstance {
    const built = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: store,
      testing: dependencies,
      settings,
      db,
      mailer: createInMemoryMailer(),
      rateLimits: TEST_RATE_LIMITS,
      runAfterResponse: (task) => createCollectingRunner().run(task),
    });
    servers.push(built);
    return built;
  }

  async function queue(marker?: "slow", text = "receivers: {}\n"): Promise<string> {
    const { user, organization } = await createUserWithOrganization(ownerDb);
    const configuration = await addConfiguration(ownerDb, { organizationId: organization.id, created_by_user_id: user.id });
    const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId: organization.id });
    const run = await addTestRun(ownerDb, {
      organizationId: organization.id,
      configurationId: configuration.id,
      configurationVersionId: version.id,
      queuedByUserId: user.id,
      yaml: `${text}${marker === undefined ? "" : `${fakeOtelcolTestingMarker(marker)}\n`}`,
      input_size_bytes: 2,
      state: { queued_at: new Date(Date.now() - 60_000) },
    });
    await store.write({ kind: "test-run", organizationId: organization.id, runId: run.id, name: "input" }, once(Buffer.from("{}")), {
      maxBytes: 1024,
    });
    return run.id;
  }

  async function status(id: string): Promise<string> {
    const row = await ownerDb.selectFrom("test_runs").select("status").where("id", "=", id).executeTakeFirstOrThrow();
    return row.status;
  }

  it("buildServer runs no loop: a server built, ready and answering starts no monitor, subscribes nothing, sends nothing", async () => {
    const id = await queue();
    const built = server(testing());
    await built.ready();
    expect((await built.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    signal.notify();

    expect(monitorCalls).toEqual([]);
    expect(subscriptions).toBe(0);
    expect(tester.fake.takeRequests()).toEqual([]);
    expect(await status(id)).toBe("queued");
  });

  it("starts the monitors, the reaper and the dispatcher only when told, after listen; a queued run is then sent", async () => {
    const built = server(testing());
    const background = registerTestRunBackground(built, { db, settings, fileStore: store, testing: testing() });
    await built.listen({ port: 0, host: "127.0.0.1" });
    expect(monitorCalls).toEqual([]);

    background.start();
    background.start();
    expect(monitorCalls).toEqual(["start", "evaluator start"]);
    expect(subscriptions).toBe(1);

    const id = await queue();
    signal.notify();
    await eventually(async () => (await status(id)) === "succeeded");
  });

  it("hands the dispatcher the organization variables' source: the tester gets the values filled in, the run keeps its text", async () => {
    const reads: string[] = [];
    const variables: IOrganizationVariables = {
      read: (organizationId) => {
        reads.push(organizationId);
        return Promise.resolve({ kind: "values", values: new Map([["REGION", "eu$1"]]) });
      },
    };
    const built = server(testing(variables));
    const background = registerTestRunBackground(built, { db, settings, fileStore: store, testing: testing(variables) });
    await built.listen({ port: 0, host: "127.0.0.1" });
    tester.fake.takeRequests();
    background.start();
    const text = "receivers: {}\n# region: ${org:REGION}\n";
    const id = await queue(undefined, text);
    signal.notify();
    await eventually(async () => (await status(id)) === "succeeded");

    expect(tester.fake.takeRequests().map((request) => request.yaml)).toEqual(["receivers: {}\n# region: eu$$1\n"]);
    expect(reads).toHaveLength(1);
    const row = await ownerDb.selectFrom("test_runs").select("yaml").where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.yaml).toBe(text);
  });

  it("closing the server stops all four: the run in flight is finished as interrupted, and nothing is claimed after", async () => {
    const built = server(testing());
    const background = registerTestRunBackground(built, { db, settings, fileStore: store, testing: testing() });
    await built.listen({ port: 0, host: "127.0.0.1" });
    background.start();
    const id = await queue("slow");
    signal.notify();
    await tester.fake.waitForHeld(1);

    servers.splice(servers.indexOf(built), 1);
    await built.close();
    expect(monitorCalls).toEqual(["start", "evaluator start", "stop", "evaluator stop"]);
    const row = await ownerDb
      .selectFrom("test_runs")
      .select(["status", "error_code", "error_message"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "failed", error_code: "interrupted", error_message: "The run was interrupted. Run it again." });

    const later = await queue();
    signal.notify();
    expect(await background.dispatcher.tick()).toBe(0);
    expect(await status(later)).toBe("queued");
  });

  describe("its callers (source)", () => {
    const index = source("apps/api/src/index.ts");
    const e2e = source("e2e/start-api.ts");

    it.each([
      ["apps/api/src/index.ts", index],
      ["e2e/start-api.ts", e2e],
    ])("%s registers it before listen and starts it after", (_path, text) => {
      const registered = text.indexOf("registerTestRunBackground(server");
      const listened = text.indexOf("await server.listen(");
      const started = text.indexOf("testRunBackground.start()");
      expect(registered).toBeGreaterThan(-1);
      expect(listened).toBeGreaterThan(registered);
      expect(started).toBeGreaterThan(listened);
    });

    it("buildServer never names it, and nothing but the starter builds a dispatcher or a reaper", () => {
      expect(source("apps/api/src/server.ts")).not.toMatch(/registerTestRunBackground|createTestRunDispatcher|createTestRunReaper/);
      expect(source("apps/api/src/modules/test-runs/background.ts")).toMatch(/createTestRunDispatcher\(/);
      for (const path of ["apps/api/src/modules/test-runs/routes.ts", "apps/api/src/modules/test-runs/test-run-service.ts"]) {
        expect(source(path)).not.toMatch(/createTestRunDispatcher|createTestRunReaper|registerTestRunBackground/);
      }
    });

    it.each([
      ["apps/api/src/index.ts", index],
      ["e2e/start-api.ts", e2e],
    ])("%s reads a run's organization variables from its opamp-server client", (_path, text) => {
      // The dependency is required (the type checker refuses an entry point
      // that passes none): this pins which source it is.
      expect(text).toMatch(/createTestRunsDependencies\(\{[^}]*organizationVariables: opampOrganizationVariables\(opampServer\),/);
      expect(text).toMatch(/const opampServer = createOpampServerClient\(settings\.opampServer\);/);
    });

    it("index.ts shuts down on SIGTERM and SIGINT, closing the server", () => {
      expect(index).toMatch(/installShutdownHandlers\(/);
      expect(index).toMatch(/await server\.close\(\)/);
    });
  });
});
