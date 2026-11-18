import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely, type Selectable } from "kysely";
import {
  codePointLength,
  TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH,
  TEST_RUN_FINDING_COMPONENT_MAXIMUM_LENGTH,
  TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH,
  TEST_RUN_LOGS_MAXIMUM_LENGTH,
  TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH,
  TEST_RUN_YAML_MAXIMUM_LENGTH,
  TESTING_UNAVAILABLE_MESSAGE,
} from "@telflo/contracts";
import type { Database, TestRunsTable } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addTestRun,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { createFileStore } from "../../file-store/create-file-store.js";
import type { FileKey, IFileStore } from "../../file-store/file-store.js";
import { createOtelcolTestingClient, type OtelcolTestingClient, type TestRunAnswer } from "../../otelcol-testing/client.js";
import { fakeOtelcolTestingMarker, type FakeOtelcolTestingFault, type FakeOtelcolTestingMarker } from "../../testing/fake-otelcol-testing.js";
import { UNCALLED_ORGANIZATION_VARIABLES, useFakeOtelcolTesting } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTTL_EVALUATOR } from "../../testing/ottl-evaluator.js";
import type { OttlEvaluatorClient } from "../../ottl-evaluator/client.js";
import {
  createTestRunDispatcher,
  finishTestRun,
  TEST_RUN_RELEASE_BACKOFF_MAXIMUM_MS,
  TEST_RUN_RELEASE_BACKOFF_MS,
  TEST_RUN_DISPATCH_INTERVAL_MS,
  TEST_RUN_LEASE_OVERHEAD_SECONDS,
  type TestRunDispatcher,
  type TestRunDispatcherLog,
} from "./dispatcher.js";
import type { IOrganizationVariables, OrganizationVariablesRead } from "./organization-variables.js";
import { createTestRunReaper } from "./reaper.js";
import { failureResults, TEST_RUN_FAILURES } from "./run-results.js";
import { createTestRunQueueSignal, type TestRunQueueSignal } from "./test-runs-dependencies.js";

/*
 * D14a Task 8: the dispatcher and the reaper (decisions 1, 11, 12, 18 and
 * 29; Preflight rulings 2, 7 and 8; Rulings 22 to 24 and 36), against
 * Postgres as the API's own role, a real FileStore on a temporary
 * directory, and the OpenAPI-checked fake tester. Runs are put in the queue
 * by the owner's fixture (addTestRun) at chosen times, their inputs written
 * to the store as the queue's service writes them. Every wait is on a
 * condition (a tick's claim, the fake's held runs, settled()), never a
 * clock: `slow` runs are held by the fake until the test releases them.
 */

const tester = useFakeOtelcolTesting();

const TEN_MIB = 10 * 1024 * 1024;
/** A marker the run's text holds: it must never reach a stored error or a log line. */
const TEXT_MARKER = "text-marker-8d2c";
/** A marker a stored rule holds: it must never reach a log line (ADR 0024). */
const STORED_RULE_MARKER = "stored-rule-marker-5e9a";
/** Before every run's queued time: runs are queued in the past, in order. */
const BASE_TIME = Date.now() - 3_600_000;

type Run = Selectable<TestRunsTable>;

interface Person {
  userId: string;
  organizationId: string;
  configurationId: string;
  versionId: string;
}

/** A log that records every line, to check none holds a text, a path or a name. */
function recordingLog(): TestRunDispatcherLog & { lines: Array<{ details: Record<string, unknown>; message: string }> } {
  const lines: Array<{ details: Record<string, unknown>; message: string }> = [];
  return {
    lines,
    warn: (details, message) => lines.push({ details, message }),
    error: (details, message) => lines.push({ details, message }),
  };
}

/** Resolves once `check` holds, looking again after each turn of the event loop's timers. The test's timeout is the guard. */
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The port of a server that just closed: nothing listens there. */
async function closedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function* once(bytes: Buffer): AsyncGenerator<Buffer> {
  yield bytes;
}

describe("the test-run dispatcher", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let root: string;
  let store: IFileStore;
  let version: string;
  let log: ReturnType<typeof recordingLog>;
  let signal: TestRunQueueSignal;
  let queuedCount = 0;
  const dispatchers: TestRunDispatcher[] = [];
  const extraDatabases: TestDatabases[] = [];

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    ({ version } = await catalogueDefaults(ownerDb));
    root = await mkdtemp(join(tmpdir(), "telflo-dispatcher-"));
    store = await createFileStore({ kind: "local", root });
    log = recordingLog();
    signal = createTestRunQueueSignal();
    tester.fake.setHealth("ready");
    tester.fake.takeRequests();
  });

  afterEach(async () => {
    for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
    tester.fake.releaseHeld();
    for (const extra of extraDatabases.splice(0)) await extra.destroy();
    expect(tester.fake.takeViolations()).toEqual([]);
    // No log line holds the text, the store's root or any name.
    const logged = JSON.stringify(log.lines);
    expect(logged).not.toContain(TEXT_MARKER);
    expect(logged).not.toContain(root);
    await rm(root, { recursive: true, force: true });
  });

  /** A person with a configuration and a version in their own organization. */
  async function person(): Promise<Person> {
    const { user, organization } = await createUserWithOrganization(ownerDb);
    const configuration = await addConfiguration(ownerDb, { organizationId: organization.id, created_by_user_id: user.id });
    const configurationVersion = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: organization.id,
    });
    return {
      userId: user.id,
      organizationId: organization.id,
      configurationId: configuration.id,
      versionId: configurationVersion.id,
    };
  }

  function inputKey(organizationId: string, runId: string): FileKey {
    return { kind: "test-run", organizationId, runId, name: "input" };
  }

  /**
   * Queues a run for `who`, after every run queued before it, with its
   * input in the run's folder as the queue's service copies it.
   */
  async function queue(
    who: Person,
    options: {
      marker?: FakeOtelcolTestingMarker;
      input?: Buffer | null;
      yaml?: string;
      durationSeconds?: number;
      /** The rules' snapshot, as the queue would have written it; [] by default. */
      validationRules?: unknown[];
    } = {},
  ): Promise<string> {
    const yaml =
      options.yaml ?? `receivers: {}\n# ${TEXT_MARKER}\n${options.marker === undefined ? "" : `${fakeOtelcolTestingMarker(options.marker)}\n`}`;
    const input = options.input === undefined ? Buffer.from(`{"resourceLogs":[{"n":${queuedCount}}]}`) : options.input;
    const run = await addTestRun(ownerDb, {
      organizationId: who.organizationId,
      configurationId: who.configurationId,
      configurationVersionId: who.versionId,
      queuedByUserId: who.userId,
      yaml,
      duration_seconds: options.durationSeconds ?? 5,
      input_size_bytes: input?.byteLength ?? 0,
      ...(options.validationRules === undefined ? {} : { validation_rules: JSON.stringify(options.validationRules) }),
      state: { queued_at: new Date(BASE_TIME + queuedCount * 1000) },
    });
    queuedCount += 1;
    if (input !== null) await store.write(inputKey(who.organizationId, run.id), once(input), { maxBytes: TEN_MIB });
    return run.id;
  }

  function dispatcher(
    options: {
      runsPerTester?: number;
      db?: Kysely<Database>;
      tester?: OtelcolTestingClient;
      evaluator?: OttlEvaluatorClient;
      organizationVariables?: IOrganizationVariables;
      fileStore?: IFileStore;
      intervalMs?: number;
      monotonicNow?: () => number;
      wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ): TestRunDispatcher {
    const created = createTestRunDispatcher({
      db: options.db ?? db,
      fileStore: options.fileStore ?? store,
      tester: options.tester ?? tester.client,
      // A run without rules never asks the evaluator: by default it can't.
      evaluator: options.evaluator ?? UNCALLED_OTTL_EVALUATOR,
      // A run with no live ${org:NAME} never reads one: by default it can't.
      organizationVariables: options.organizationVariables ?? UNCALLED_ORGANIZATION_VARIABLES,
      queued: signal,
      runsPerTester: options.runsPerTester ?? 4,
      log,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
      ...(options.wait === undefined ? {} : { wait: options.wait }),
    });
    dispatchers.push(created);
    return created;
  }

  async function row(id: string): Promise<Run> {
    return ownerDb.selectFrom("test_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  }

  /** The runs the fake was sent since the last call, by id, in order. */
  function sent(): string[] {
    return tester.fake.takeRequests().map((request) => request.runId ?? "");
  }

  async function fileOf(organizationId: string, runId: string, name: "input" | "output" | "decoded-input"): Promise<Buffer | undefined> {
    const opened = await store.read({ kind: "test-run", organizationId, runId, name });
    if (!opened.found) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async function markDown(secondsAgo: number): Promise<void> {
    await sql`update otelcol_testing_state set down_since = now() - make_interval(secs => ${secondsAgo})`.execute(ownerDb);
  }

  it("ticks every second and leases a run for 174 + d s: the send window's 25, the tester's 74, 30 for the files, the evaluator's 40 and 5 (Preflight rulings 2 and 7; D15a Preflight ruling 11 and Ruling 41)", async () => {
    expect(TEST_RUN_DISPATCH_INTERVAL_MS).toBe(1_000);
    expect(TEST_RUN_LEASE_OVERHEAD_SECONDS).toBe(174);

    const ana = await person();
    const id = await queue(ana, { marker: "slow", durationSeconds: 7 });
    expect(await dispatcher().tick()).toBe(1);
    await tester.fake.waitForHeld(1);

    const claimed = await row(id);
    expect(claimed.status).toBe("running");
    expect(claimed.lease_expires_at!.getTime() - claimed.started_at!.getTime()).toBe((174 + 7) * 1000);
  });

  describe("Q17's turns and the cap of N (decision 11)", () => {
    it("takes turns between Ana's ten runs and Ben's one, N = 2: Ben's starts beside Ana's first, not after her tenth", async () => {
      const ana = await person();
      const ben = await person();
      const anas: string[] = [];
      for (let index = 0; index < 10; index += 1) anas.push(await queue(ana, { marker: "slow" }));
      const ben0 = await queue(ben, { marker: "slow" });
      const turns = dispatcher({ runsPerTester: 2 });

      const batches: string[][] = [];
      const runBatch = async (expected: number): Promise<void> => {
        expect(await turns.tick()).toBe(expected);
        await tester.fake.waitForHeld(expected);
        expect(tester.fake.heldCount()).toBe(expected);
        batches.push(sent().sort());
        expect(tester.fake.releaseHeld()).toBe(expected);
        await turns.settled();
      };

      await runBatch(2);
      // Ben queues again, after all of Ana's: his turn comes before her third.
      const ben1 = await queue(ben, { marker: "slow" });
      await runBatch(2);
      for (let remaining = 8; remaining > 0; remaining -= 2) await runBatch(Math.min(2, remaining));

      expect(batches).toEqual([
        [anas[0]!, ben0].sort(),
        [anas[1]!, ben1].sort(),
        [anas[2]!, anas[3]!].sort(),
        [anas[4]!, anas[5]!].sort(),
        [anas[6]!, anas[7]!].sort(),
        [anas[8]!, anas[9]!].sort(),
      ]);
      for (const id of [...anas, ben0, ben1]) expect((await row(id)).status).toBe("succeeded");
    });

    it("never runs more than N at once across two dispatchers on one database, and sends each run once", async () => {
      const second = openTestDatabases();
      extraDatabases.push(second);
      const people = [await person(), await person(), await person()];
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) ids.push(await queue(people[index % 3]!, { marker: "slow" }));
      const first = dispatcher({ runsPerTester: 2 });
      const other = dispatcher({ runsPerTester: 2, db: second.db });

      const allSent: string[] = [];
      for (let remaining = ids.length; remaining > 0; ) {
        const expected = Math.min(2, remaining);
        const claimed = await Promise.all([first.tick(), other.tick()]);
        expect(claimed[0] + claimed[1]).toBe(expected);
        await tester.fake.waitForHeld(expected);
        // Both again, while the slots are full: nothing more.
        expect(await Promise.all([first.tick(), other.tick()])).toEqual([0, 0]);
        const running = await ownerDb.selectFrom("test_runs").select("id").where("status", "=", "running").execute();
        expect(running).toHaveLength(expected);
        expect(tester.fake.heldCount()).toBe(expected);
        allSent.push(...sent());
        tester.fake.releaseHeld();
        await Promise.all([first.settled(), other.settled()]);
        remaining -= expected;
      }

      expect(allSent.sort()).toEqual([...ids].sort());
      for (const id of ids) expect((await row(id)).status).toBe("succeeded");
    });

    it("claims nothing while the shared row says the tester is down, and claims once it is up (Ruling 24)", async () => {
      const ana = await person();
      const id = await queue(ana);
      await markDown(1);
      const watching = dispatcher();

      expect(await watching.tick()).toBe(0);
      expect(sent()).toEqual([]);
      expect((await row(id)).status).toBe("queued");

      await sql`update otelcol_testing_state set down_since = null`.execute(ownerDb);
      expect(await watching.tick()).toBe(1);
      await watching.settled();
      expect((await row(id)).status).toBe("succeeded");
    });
  });

  describe("each answer, stored as the run's fields and files", () => {
    it("succeeded: the results as JSON numbers and booleans, the output and the decoded input in the run's folder", async () => {
      const ana = await person();
      const input = Buffer.from('{"resourceLogs":[{"marker":"input-marker"}]}');
      const id = await queue(ana, { input });
      const running = dispatcher();

      expect(await running.tick()).toBe(1);
      await running.settled();

      const stored = await row(id);
      expect(stored).toMatchObject({
        status: "succeeded",
        strategy: "otlp",
        kwok_enabled: false,
        mutated_yaml: stored.yaml,
        compatibility: [],
        output_size_bytes: input.byteLength,
        output_truncated: false,
        decoded_input_size_bytes: input.byteLength,
        decoded_input_truncated: false,
        error_code: null,
        error_message: null,
        lease_id: null,
        lease_expires_at: null,
      });
      expect(stored.mutations).toEqual([expect.objectContaining({ id: "R-001", severity: "info" })]);
      expect(stored.logs).toContain("[replay] 1 of 1 payloads sent");
      expect(stored.timings).toEqual({ totalMs: 5060, readyMs: 20, informerMs: null, replayMs: 10, holdMs: 5000, stopMs: 30 });
      expect(stored.finished_at).toBeInstanceOf(Date);
      const types = await sql<{ total: string; truncated: string; kwok: string }>`
        select jsonb_typeof(timings -> 'totalMs') as total,
               pg_typeof(output_truncated)::text as truncated,
               pg_typeof(kwok_enabled)::text as kwok
          from test_runs where id = ${id}
      `.execute(ownerDb);
      expect(types.rows[0]).toEqual({ total: "number", truncated: "boolean", kwok: "boolean" });

      expect(await fileOf(ana.organizationId, id, "output")).toEqual(input);
      expect(await fileOf(ana.organizationId, id, "decoded-input")).toEqual(input);
      expect(await fileOf(ana.organizationId, id, "input")).toEqual(input);
      // Sent once, as the contract asks: its text, its pin, its input.
      const requests = tester.fake.takeRequests();
      expect(requests).toEqual([
        expect.objectContaining({ runId: id, yaml: stored.yaml, pipeline: "logs", signal: "logs", durationSeconds: 5, version }),
      ]);
      expect(requests[0]!.input?.sizeBytes).toBe(input.byteLength);
    });

    it("failed, collector_failed: the error, the logs and the text it ran; no files", async () => {
      const ana = await person();
      const id = await queue(ana, { marker: "collector-failed" });
      const running = dispatcher();
      await running.tick();
      await running.settled();

      const stored = await row(id);
      expect(stored).toMatchObject({
        status: "failed",
        error_code: "collector_failed",
        error_message: "The collector exited before it was ready.",
        strategy: "otlp",
        mutated_yaml: stored.yaml,
        output_size_bytes: null,
        output_truncated: null,
        decoded_input_size_bytes: null,
        decoded_input_truncated: null,
      });
      expect(stored.logs).toContain("collector exited");
      expect(await fileOf(ana.organizationId, id, "output")).toBeUndefined();
      expect(await fileOf(ana.organizationId, id, "decoded-input")).toBeUndefined();
    });

    it("failed, refused: the C-0xx refusal among the compatibility findings, no collector started", async () => {
      const ana = await person();
      const id = await queue(ana, { marker: "refused" });
      const running = dispatcher();
      await running.tick();
      await running.settled();

      const stored = await row(id);
      expect(stored).toMatchObject({ status: "failed", error_code: "refused", strategy: null, mutated_yaml: null });
      expect(stored.compatibility).toEqual([
        expect.objectContaining({ id: "C-005", severity: "refuse", component: "processors::geoip" }),
      ]);
    });

    it("503 version_unavailable: failed, with a fixed message naming the version (Preflight ruling 13)", async () => {
      const ana = await person();
      const id = await queue(ana, { marker: "version-unavailable" });
      const running = dispatcher();
      await running.tick();
      await running.settled();

      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "version_unavailable",
        error_message: `Collector v${version} isn't installed in the tester. Pick another version or try again later.`,
        logs: null,
        mutations: null,
      });
      expect(sent()).toEqual([id]);
    });

    it.each<[string, FakeOtelcolTestingFault, string, (version: string) => string]>([
      ["409 version_retired", "version_retired", "version_retired", (v) => `Collector v${v} is no longer offered by the tester. Pick a newer collector version.`],
      ["400 version_unknown", "version_unknown", "version_unknown", (v) => `Collector v${v} isn't available in the tester. Pick another collector version.`],
    ])("%s from the tester: failed with its own code and words, never released (Rulings 50, 51)", async (_label, fault, code, message) => {
      const ana = await person();
      const id = await queue(ana);
      const running = dispatcher();
      tester.fake.nextFault(fault);
      await running.tick();
      await running.settled();

      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: code,
        error_message: message(version),
        logs: null,
        mutations: null,
      });
      expect(sent()).toEqual([id]);
      // The dispatcher logs nothing of its own: the client warns (client.test.ts).
      expect(log.lines).toEqual([]);
    });

    it.each<[string, FakeOtelcolTestingFault]>([
      ["busy", "tester_busy"],
      ["starting", "tester_starting"],
      ["unavailable", "tester_unavailable"],
    ])("503 %s: released, keeping its place, and sent again before a younger run", async (_label, fault) => {
      const ana = await person();
      const older = await queue(ana);
      const queuedAt = (await row(older)).queued_at;
      const younger = await queue(ana);
      let clock = 0;
      const releasing = dispatcher({ runsPerTester: 1, monotonicNow: () => clock });
      tester.fake.nextFault(fault);

      expect(await releasing.tick()).toBe(1);
      await releasing.settled();
      expect(await row(older)).toMatchObject({ status: "queued", queued_at: queuedAt, started_at: null, lease_id: null });

      // Once the release's wait (Ruling 41) has passed.
      clock += TEST_RUN_RELEASE_BACKOFF_MS;
      expect(await releasing.tick()).toBe(1);
      await releasing.settled();
      expect(sent()).toEqual([older, older]);
      expect((await row(older)).status).toBe("succeeded");
      expect((await row(younger)).status).toBe("queued");
    });

    it("a refused connection (nothing sent): released, keeping its place", async () => {
      const ana = await person();
      const id = await queue(ana);
      const down = createOtelcolTestingClient({ url: await closedUrl(), secret: tester.fake.secret });
      const releasing = dispatcher({ tester: down });

      expect(await releasing.tick()).toBe(1);
      await releasing.settled();
      expect(await row(id)).toMatchObject({ status: "queued", started_at: null });
    });

    it("a refusing tester isn't sent the run in a loop: a release wakes nothing, then claims wait 2 s, doubling to 10 s (Ruling 41)", async () => {
      expect([TEST_RUN_RELEASE_BACKOFF_MS, TEST_RUN_RELEASE_BACKOFF_MAXIMUM_MS]).toEqual([2_000, 10_000]);
      const ana = await person();
      const id = await queue(ana);
      // The dispatcher's monotonic clock, moved only by the test.
      let clock = 0;
      const closed = createOtelcolTestingClient({ url: await closedUrl(), secret: tester.fake.secret });
      let target: OtelcolTestingClient = closed;
      const sends: string[] = [];
      const counting: OtelcolTestingClient = {
        health: () => tester.client.health(),
        run: (request, options) => {
          sends.push(request.runId);
          return target.run(request, options);
        },
      };
      // Its timer never fires here: only wakes and these ticks claim.
      const backing = dispatcher({ tester: counting, monotonicNow: () => clock, intervalMs: 3_600_000 });
      backing.start();
      await eventually(() => sends.length === 1);
      await backing.settled();
      expect((await row(id)).status).toBe("queued");

      // Queued signals and ticks during the wait send nothing.
      for (let index = 0; index < 20; index += 1) {
        signal.notify();
        expect(await backing.tick()).toBe(0);
      }
      await backing.settled();
      expect(sends).toHaveLength(1);

      for (const wait of [2_000, 4_000, 8_000, 10_000, 10_000]) {
        clock += wait - 1;
        expect(await backing.tick()).toBe(0);
        clock += 1;
        expect(await backing.tick()).toBe(1);
        await backing.settled();
      }
      expect(sends).toHaveLength(6);
      expect((await row(id)).status).toBe("queued");

      // An answer resets the wait: the next release waits 2 s again.
      target = tester.client;
      clock += 10_000;
      expect(await backing.tick()).toBe(1);
      await backing.settled();
      expect((await row(id)).status).toBe("succeeded");
      const next = await queue(ana);
      target = closed;
      expect(await backing.tick()).toBe(1);
      await backing.settled();
      clock += 1_999;
      expect(await backing.tick()).toBe(0);
      clock += 1;
      expect(await backing.tick()).toBe(1);
      await backing.settled();

      // Stopping during a wait leaves the released run waiting, never interrupted.
      await backing.stop();
      expect(await row(next)).toMatchObject({ status: "queued", error_code: null });
    });

    it("runs refused together double the wait once: four released in one claim wait 2 s, then 4 s (Ruling 42)", async () => {
      const ana = await person();
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) ids.push(await queue(ana));
      let clock = 0;
      const closed = createOtelcolTestingClient({ url: await closedUrl(), secret: tester.fake.secret });
      const together = dispatcher({ tester: closed, runsPerTester: 4, monotonicNow: () => clock });

      expect(await together.tick()).toBe(4);
      await together.settled();
      for (const id of ids) expect((await row(id)).status).toBe("queued");
      clock += 1_999;
      expect(await together.tick()).toBe(0);
      clock += 1;
      expect(await together.tick()).toBe(4);
      await together.settled();
      clock += 3_999;
      expect(await together.tick()).toBe(0);
      clock += 1;
      expect(await together.tick()).toBe(4);
      await together.settled();
    });

    it("a release after an answer of the same claim reset the wait still waits 2 s (Ruling 45)", async () => {
      const ana = await person();
      const [first, second, third] = [await queue(ana), await queue(ana), await queue(ana)];
      const clock = 0;
      // The first is refused at once; the second is answered; the third is
      // refused once the second's answer has reset the wait.
      const ordered: OtelcolTestingClient = {
        health: () => tester.client.health(),
        run: async (request, options) => {
          if (request.runId === first) return { kind: "unavailable", reason: "busy", isReleasable: true };
          if (request.runId === second) return tester.client.run(request, options);
          await eventually(async () => (await row(second)).status === "succeeded");
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { kind: "unavailable", reason: "busy", isReleasable: true };
        },
      };
      const mixed = dispatcher({ tester: ordered, runsPerTester: 3, monotonicNow: () => clock });

      expect(await mixed.tick()).toBe(3);
      await mixed.settled();
      expect([(await row(first)).status, (await row(second)).status, (await row(third)).status]).toEqual(["queued", "succeeded", "queued"]);
      expect(sent()).toEqual([second]);
      // The third's release waits: nothing is claimed at once.
      expect(await mixed.tick()).toBe(0);
    });

    it("the lease check uses the time since the claim: a run is sent when the API's wall clock runs 60 s ahead (Ruling 42)", async () => {
      const ana = await person();
      const id = await queue(ana);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 60_000);
        const ahead = dispatcher();
        expect(await ahead.tick()).toBe(1);
        await ahead.settled();
      } finally {
        vi.useRealTimers();
      }
      expect(sent()).toEqual([id]);
      expect((await row(id)).status).toBe("succeeded");
    });

    it("a run is never sent once the time since its claim, plus 74 + d s, the files' 30 s, the evaluator's 40 s and 5 s, would pass its lease: it ends interrupted", async () => {
      const ana = await person();
      const id = await queue(ana);
      const other = await queue(ana);
      // Each dispatcher claims one run, and its input's read moves the
      // monotonic clock on: 25 s (the send window) for the first run's, 25 s
      // and 1 ms for the second's. 5 s of duration: a lease of 179 s. The
      // evaluator's 40 s is reserved for every run, rules or not (D15a
      // Preflight ruling 11 and Ruling 41).
      let clock = 0;
      const slowReads: IFileStore = {
        ...store,
        read: async (key) => {
          if (key.kind === "test-run") clock += 25_000;
          return store.read(key);
        },
      };
      const late = dispatcher({ runsPerTester: 1, fileStore: slowReads, monotonicNow: () => clock });
      // 25 s + 79 s (the client's 74 + d s) + 30 s + 40 s + 5 s = 179 s: still fits, sent.
      expect(await late.tick()).toBe(1);
      await late.settled();
      expect(sent()).toEqual([id]);
      clock = 0;
      // 25.001 s + 79 s + 30 s + 40 s + 5 s passes 179 s: never sent.
      const later = dispatcher({
        runsPerTester: 1,
        fileStore: { ...store, read: async (key) => ((clock += 25_001), store.read(key)) },
        monotonicNow: () => clock,
      });
      expect(await later.tick()).toBe(1);
      await later.settled();
      expect(sent()).toEqual([]);
      expect(await row(other)).toMatchObject({ status: "failed", error_code: "interrupted" });
    });

    it("a name that doesn't resolve (nothing sent, Ruling 36): released", async () => {
      const ana = await person();
      const id = await queue(ana);
      const unresolved: OtelcolTestingClient = {
        health: () => tester.client.health(),
        run: async () => ({ kind: "unavailable", reason: "name_not_resolved", isReleasable: true }),
      };
      const releasing = dispatcher({ tester: unresolved });
      await releasing.tick();
      await releasing.settled();
      expect((await row(id)).status).toBe("queued");
    });

    it("no answer in time, after the run was sent: failed, never released, never sent twice", async () => {
      const ana = await person();
      const id = await queue(ana, { marker: "slow" });
      // The client's timer firing once the run has reached the tester: the
      // fake holds it, the call is abandoned, and the client answers timeout.
      const timingOut: OtelcolTestingClient = {
        health: () => tester.client.health(),
        run: async (request) => {
          const abandon = new AbortController();
          const call = tester.client.run(request, { signal: abandon.signal });
          await tester.fake.waitForHeld(1);
          abandon.abort();
          await call;
          return { kind: "unavailable", reason: "timeout", isReleasable: false };
        },
      };
      const running = dispatcher({ tester: timingOut });

      expect(await running.tick()).toBe(1);
      await running.settled();
      // Later ticks find nothing to send: it was sent once.
      const later: number[] = [];
      for (let index = 0; index < 2; index += 1) {
        later.push(await running.tick());
        await running.settled();
      }
      expect(sent()).toEqual([id]);
      expect(later).toEqual([0, 0]);
      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "tester_timeout",
        error_message: "The tester didn't answer in time. Run it again.",
      });
    });

    it("a connection reset after the run was sent: failed (connection lost), never released, never sent twice", async () => {
      const ana = await person();
      const id = await queue(ana);
      // The fake resets before it reads the request, so it records none: count the sends here.
      const sends: string[] = [];
      const counting: OtelcolTestingClient = {
        health: () => tester.client.health(),
        run: (request, options) => {
          sends.push(request.runId);
          return tester.client.run(request, options);
        },
      };
      const running = dispatcher({ tester: counting });
      tester.fake.nextFault("reset");

      await running.tick();
      await running.settled();
      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "tester_connection_lost",
        error_message: "The connection to the tester was lost. Run it again.",
      });
      expect(await running.tick()).toBe(0);
      expect(await running.tick()).toBe(0);
      expect(sends).toEqual([id]);
    });

    it("a status the run's contract doesn't expect (500): failed, a fixed message", async () => {
      const ana = await person();
      const id = await queue(ana);
      const running = dispatcher();
      tester.fake.nextFault("error_500");

      await running.tick();
      await running.settled();
      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "tester_error",
        error_message: "The tester couldn't run this test. Try again later.",
      });
    });

    it("a run whose input is missing: failed, never sent", async () => {
      const ana = await person();
      const id = await queue(ana, { input: null });
      const running = dispatcher();
      await running.tick();
      await running.settled();

      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "input_unavailable",
        error_message: "The run's input couldn't be read.",
      });
      expect(sent()).toEqual([]);
    });
  });

  describe("what is stored", () => {
    /** A tester that answers `answer` for every run, with the run's own version. */
    function answering(answer: (request: { version: string }) => TestRunAnswer, kind: "succeeded" | "failed" = "succeeded"): OtelcolTestingClient {
      return {
        health: () => tester.client.health(),
        run: async (request) => {
          const built = answer(request);
          if (kind === "succeeded") return { kind: "succeeded", answer: built };
          return { kind: "failed", answer: built, error: built.error! };
        },
      };
    }

    function longAnswer(request: { version: string }): TestRunAnswer {
      return {
        status: "succeeded",
        strategy: "otlp",
        kwokEnabled: true,
        collectorVersion: request.version,
        // A NUL, then pairs: one code point more than the bound.
        logs: `\u0000${"😀".repeat(TEST_RUN_LOGS_MAXIMUM_LENGTH)}`,
        mutatedYaml: `${"y".repeat(TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH - 1)}😀tail`,
        mutations: [{ id: "R-001", severity: "info", message: "😀".repeat(5_000), details: { note: "a\u0000b", "k\uD800": ["x\uDC00"] } }],
        compatibility: [{ id: "C-001", severity: "advisory", component: "😀".repeat(2_000), message: "x".repeat(5_000), details: {} }],
        output: { base64: Buffer.from("output-bytes"), bytesOnDisk: 99_999_999, truncated: true },
        decodedInput: null,
        timings: { totalMs: 1, readyMs: 2, informerMs: null, replayMs: 3, holdMs: 4, stopMs: 5 },
      };
    }

    it("cuts every string to the contract's bounds in code points, a pair kept whole, and stores no NUL or lone surrogate (Rulings 24, 39)", async () => {
      const ana = await person();
      const id = await queue(ana);
      const running = dispatcher({ tester: answering(longAnswer) });
      await running.tick();
      await running.settled();

      const stored = await row(id);
      expect(stored.status).toBe("succeeded");
      // One code point more than the bound: the last emoji goes, whole.
      expect(codePointLength(stored.logs!)).toBe(TEST_RUN_LOGS_MAXIMUM_LENGTH);
      expect(stored.logs).toBe(`\uFFFD${"😀".repeat(TEST_RUN_LOGS_MAXIMUM_LENGTH - 1)}`);
      expect(codePointLength(stored.mutated_yaml!)).toBe(TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH);
      expect(stored.mutated_yaml!.endsWith("y😀")).toBe(true);
      // Postgres counts as the contract does.
      const counted = await sql<{ logs: number }>`select char_length(logs) as logs from test_runs where id = ${id}`.execute(ownerDb);
      expect(counted.rows[0]!.logs).toBe(TEST_RUN_LOGS_MAXIMUM_LENGTH);
      const [mutation] = stored.mutations as Array<{ message: string; details: Record<string, unknown> }>;
      expect(mutation!.message).toBe("😀".repeat(TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH));
      expect(mutation!.details).toEqual({ note: "a\uFFFDb", "k\uFFFD": ["x\uFFFD"] });
      const [issue] = stored.compatibility as Array<{ component: string; message: string }>;
      expect(issue!.component).toBe("😀".repeat(TEST_RUN_FINDING_COMPONENT_MAXIMUM_LENGTH));
      expect(issue!.message).toHaveLength(TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH);
      // The stored file's size, not the tester's bytesOnDisk.
      expect(stored).toMatchObject({ output_size_bytes: 12, output_truncated: true, kwok_enabled: true, decoded_input_size_bytes: null });
    });

    it("keeps logs of exactly 262,144 code points of emoji whole (Ruling 39)", async () => {
      const ana = await person();
      const id = await queue(ana);
      const logs = "😀".repeat(TEST_RUN_LOGS_MAXIMUM_LENGTH);
      const running = dispatcher({ tester: answering((request) => ({ ...longAnswer(request), logs })) });
      await running.tick();
      await running.settled();
      expect((await row(id)).logs).toBe(logs);
    });

    it("cuts a failed answer's error message to 2,000 characters", async () => {
      const ana = await person();
      const id = await queue(ana);
      const failing = answering(
        (request) => ({
          ...longAnswer(request),
          status: "failed",
          output: null,
          error: { code: "collector_failed", message: `\uDC00${"e".repeat(3_000)}` },
        }),
        "failed",
      );
      const running = dispatcher({ tester: failing });
      await running.tick();
      await running.settled();

      const stored = await row(id);
      expect(stored).toMatchObject({ status: "failed", error_code: "collector_failed", output_size_bytes: null });
      expect(stored.error_message).toHaveLength(TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH);
      expect(stored.error_message!.startsWith("\uFFFDe")).toBe(true);
    });

    describe("a stored error never holds a path or the text", () => {
      /** An error as Node's filesystem makes one: its message names the path, and here the text too. */
      const nodeError = (): Error =>
        Object.assign(new Error(`ENOENT: no such file or directory, open '${root}/organizations/${TEXT_MARKER}'`), {
          code: "ENOENT",
          syscall: "open",
          path: `${root}/organizations`,
        });

      async function expectFixedError(id: string, code: string, message: string): Promise<void> {
        const stored = await row(id);
        expect(stored).toMatchObject({ status: "failed", error_code: code, error_message: message });
        expect(stored.error_message).not.toContain(root);
        expect(stored.error_message).not.toContain(TEXT_MARKER);
        expect(stored.error_message).not.toContain("/");
      }

      it("the input can't be read: input_unavailable", async () => {
        const ana = await person();
        const id = await queue(ana);
        const failingStore: IFileStore = { ...store, read: async () => Promise.reject(nodeError()) };
        const running = dispatcher({ fileStore: failingStore });
        await running.tick();
        await running.settled();
        await expectFixedError(id, "input_unavailable", "The run's input couldn't be read.");
      });

      it("the answer's files can't be written: storage_failed, and nothing is left at their keys", async () => {
        const ana = await person();
        const id = await queue(ana);
        const removed: string[] = [];
        const failingStore: IFileStore = {
          ...store,
          read: (key) => store.read(key),
          write: async (key, content, options) => {
            if (key.kind === "test-run" && key.name === "decoded-input") throw nodeError();
            return store.write(key, content, options);
          },
          remove: async (key) => {
            if (key.kind === "test-run") removed.push(key.name);
            return store.remove(key);
          },
        };
        const running = dispatcher({ fileStore: failingStore });
        await running.tick();
        await running.settled();

        await expectFixedError(id, "storage_failed", "The run's results couldn't be saved. Run it again.");
        expect(removed.sort()).toEqual(["decoded-input", "output"]);
        expect(await fileOf(ana.organizationId, id, "output")).toBeUndefined();
      });

      it("the tester's client throws, quoting the text: internal_error", async () => {
        const ana = await person();
        const id = await queue(ana);
        const throwing: OtelcolTestingClient = {
          health: () => tester.client.health(),
          run: async (request) => {
            throw new Error(`could not send ${request.yaml} from ${root}`);
          },
        };
        const running = dispatcher({ tester: throwing });
        await running.tick();
        await running.settled();
        await expectFixedError(id, "internal_error", "Something went wrong running the test. Run it again.");
      });
    });
  });

  describe("the lease", () => {
    it("an answer for a run no longer this lease's is dropped, and its two files removed", async () => {
      const ana = await person();
      const id = await queue(ana);
      const writes: string[] = [];
      const removes: string[] = [];
      const recordingStore: IFileStore = {
        ...store,
        read: (key) => store.read(key),
        write: async (key, content, options) => {
          if (key.kind === "test-run") writes.push(key.name);
          return store.write(key, content, options);
        },
        remove: async (key) => {
          if (key.kind === "test-run") removes.push(key.name);
          return store.remove(key);
        },
      };
      // While the tester runs it, the run stops being this lease's: as the
      // reaper does once the lease has passed.
      const losing: OtelcolTestingClient = {
        health: () => tester.client.health(),
        run: async (request, options) => {
          const result = await tester.client.run(request, options);
          const { lease_id } = await ownerDb
            .selectFrom("test_runs")
            .select("lease_id")
            .where("id", "=", request.runId)
            .executeTakeFirstOrThrow();
          expect(await finishTestRun(db, { id: request.runId, leaseId: lease_id! }, "failed", failureResults(TEST_RUN_FAILURES.interrupted))).toBe(true);
          return result;
        },
      };
      const running = dispatcher({ tester: losing, fileStore: recordingStore });
      await running.tick();
      await running.settled();

      expect(await row(id)).toMatchObject({ status: "failed", error_code: "interrupted", output_size_bytes: null });
      expect(writes).toEqual(["output", "decoded-input"]);
      expect(removes.sort()).toEqual(["decoded-input", "output"]);
      expect(await fileOf(ana.organizationId, id, "output")).toBeUndefined();
      expect(await fileOf(ana.organizationId, id, "decoded-input")).toBeUndefined();
      expect(await fileOf(ana.organizationId, id, "input")).toBeDefined();
    });
  });

  describe("a finish that throws (Ruling 41)", () => {
    /**
     * The API's database, but one transaction after `arm()` throws: before
     * its work (nothing committed) or after it commits. `passing` go through
     * first: the rules' read (test_runs_rules, D15a) comes before the finish.
     */
    function throwingOnce(when: "before" | "after", passing = 1) {
      let isArmed = false;
      let toPass = passing;
      const thrown = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });
      const proxy = {
        transaction: () => {
          const real = db.transaction();
          return {
            setIsolationLevel: (level: Parameters<typeof real.setIsolationLevel>[0]) => {
              const builder = real.setIsolationLevel(level);
              return {
                execute: async (work: Parameters<typeof builder.execute>[0]) => {
                  if (!isArmed) return builder.execute(work);
                  if (toPass > 0) {
                    toPass -= 1;
                    return builder.execute(work);
                  }
                  isArmed = false;
                  if (when === "before") throw thrown;
                  await builder.execute(work);
                  throw thrown;
                },
              };
            },
          };
        },
      } as unknown as Kysely<Database>;
      return { proxy, arm: () => void (isArmed = true) };
    }

    /** The fake's answer, the database armed as it returns, so the finish is the next transaction. */
    function armingTester(arm: () => void): OtelcolTestingClient {
      return {
        health: () => tester.client.health(),
        run: async (request, options) => {
          const result = await tester.client.run(request, options);
          arm();
          return result;
        },
      };
    }

    it("thrown after it committed: the run stays succeeded, and its files are kept", async () => {
      const ana = await person();
      const input = Buffer.from('{"resourceLogs":[{"kept":true}]}');
      const id = await queue(ana, { input });
      const { proxy, arm } = throwingOnce("after");
      const running = dispatcher({ db: proxy, tester: armingTester(arm) });
      await running.tick();
      await running.settled();

      expect(await row(id)).toMatchObject({ status: "succeeded", output_size_bytes: input.byteLength, error_code: null });
      expect(await fileOf(ana.organizationId, id, "output")).toEqual(input);
      expect(await fileOf(ana.organizationId, id, "decoded-input")).toEqual(input);
    });

    it("thrown before it committed: the run fails as internal_error, and its files are removed", async () => {
      const ana = await person();
      const id = await queue(ana);
      const { proxy, arm } = throwingOnce("before");
      const running = dispatcher({ db: proxy, tester: armingTester(arm) });
      await running.tick();
      await running.settled();

      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "internal_error",
        error_message: "Something went wrong running the test. Run it again.",
        output_size_bytes: null,
      });
      expect(await fileOf(ana.organizationId, id, "output")).toBeUndefined();
      expect(await fileOf(ana.organizationId, id, "decoded-input")).toBeUndefined();
    });

    it("the rules' read (test_runs_rules) throwing: the run fails as internal_error, and its files are removed", async () => {
      const ana = await person();
      const id = await queue(ana);
      const { proxy, arm } = throwingOnce("before", 0);
      const running = dispatcher({ db: proxy, tester: armingTester(arm) });
      await running.tick();
      await running.settled();

      expect(await row(id)).toMatchObject({ status: "failed", error_code: "internal_error", output_size_bytes: null });
      expect(await fileOf(ana.organizationId, id, "output")).toBeUndefined();
      expect(await fileOf(ana.organizationId, id, "decoded-input")).toBeUndefined();
    });
  });

  describe("a rules' snapshot that can't be read (D15a Ruling 41)", () => {
    it("rules the contracts' snapshot schema refuses: the run fails as internal_error, its answer's files and logs kept, the evaluator never asked, no log line holding the stored rule", async () => {
      const ana = await person();
      const input = Buffer.from('{"resourceLogs":[{"unreadable":true}]}');
      // What the table's check takes (objects with a string id) but the
      // contracts' snapshot schema doesn't: no uuid, no position, no name.
      // Only the owner can write it, as here: the queue writes the
      // contract's shape (and an update is refused by the run's guard).
      const id = await queue(ana, {
        input,
        validationRules: [{ id: STORED_RULE_MARKER, kind: "contains_text", target: "output", pattern: `${STORED_RULE_MARKER}-pattern` }],
      });
      // The default evaluator (UNCALLED_OTTL_EVALUATOR) rejects if asked:
      // the run would fail too, but with another log line, which the
      // check below tells apart.
      const running = dispatcher();
      expect(await running.tick()).toBe(1);
      await running.settled();

      expect(sent()).toEqual([id]);
      const stored = await row(id);
      expect(stored).toMatchObject({
        status: "failed",
        error_code: "internal_error",
        error_message: "Something went wrong running the test. Run it again.",
        output_size_bytes: input.byteLength,
        decoded_input_size_bytes: input.byteLength,
        validation_results: null,
      });
      expect(stored.logs).toContain("[replay]");
      // The row names its files: they are kept.
      expect(await fileOf(ana.organizationId, id, "output")).toEqual(input);
      expect(await fileOf(ana.organizationId, id, "decoded-input")).toEqual(input);
      // One line, naming the run and the rules' count only.
      expect(log.lines).toEqual([{ details: { runId: id, rules: 1 }, message: "a test run's rules' snapshot can't be read" }]);
      expect(JSON.stringify(log.lines)).not.toContain(STORED_RULE_MARKER);
    });
  });

  describe("started, it is woken", () => {
    it("by a queued run and by a finish, not only by its timer", async () => {
      const ana = await person();
      const first = await queue(ana, { marker: "slow" });
      const second = await queue(ana, { marker: "slow" });
      // A timer that never fires during the test: only wakes claim.
      const woken = dispatcher({ runsPerTester: 1, intervalMs: 3_600_000 });
      woken.start();
      await tester.fake.waitForHeld(1);
      expect(sent()).toEqual([first]);

      // The finish of the first wakes the claim of the second.
      tester.fake.releaseHeld();
      await tester.fake.waitForHeld(1);
      expect(sent()).toEqual([second]);
      tester.fake.releaseHeld();
      await eventually(async () => (await row(second)).status === "succeeded");

      const third = await queue(ana);
      signal.notify();
      await eventually(async () => (await row(third)).status === "succeeded");
      expect(sent()).toEqual([third]);
    });
  });

  describe("organization variables, filled in before the tester (D20 decision 13; Preflight ruling 28)", () => {
    /** A value marker: it reaches the tester, and never a log line or a stored error. */
    const VALUE_MARKER = "value-marker-6b1e";

    /** A source answering `answer` at each read (its current value), counting the reads and the organizations. */
    function variables(answer: () => OrganizationVariablesRead | Promise<OrganizationVariablesRead>): IOrganizationVariables & {
      reads: string[];
    } {
      const reads: string[] = [];
      return {
        reads,
        read: async (organizationId) => {
          reads.push(organizationId);
          return answer();
        },
      };
    }

    const valuesOf = (entries: Record<string, string>): OrganizationVariablesRead => ({
      kind: "values",
      values: new Map(Object.entries(entries)),
    });

    const textWith = (reference: string) => `receivers: {}\n# ${TEXT_MARKER}\n# endpoint: ${reference}\n`;

    afterEach(() => {
      expect(JSON.stringify(log.lines)).not.toContain(VALUE_MARKER);
    });

    it("sends the tester the values filled in, a $ doubled; the run keeps its text as written, and the tester's mutatedYaml as returned", async () => {
      const ana = await person();
      const yaml = textWith("${org:ENDPOINT}");
      const id = await queue(ana, { yaml });
      const source = variables(() => valuesOf({ ENDPOINT: `https://${VALUE_MARKER}/a$b` }));

      const sending = dispatcher({ organizationVariables: source });
      await sending.tick();
      await sending.settled();

      const filled = textWith(`https://${VALUE_MARKER}/a$$b`);
      expect(tester.fake.takeRequests().map((request) => request.yaml)).toEqual([filled]);
      expect(source.reads).toEqual([ana.organizationId]);
      // The fake answers the text it ran as its mutatedYaml: what ran, kept.
      expect(await row(id)).toMatchObject({ status: "succeeded", yaml, mutated_yaml: filled });
    });

    it("reads nothing for a text with no live reference: an escaped one, the legacy form and a default's form are plain text", async () => {
      const ana = await person();
      const yaml = `${textWith("$${org:ENDPOINT}")}# $orgvar:ENDPOINT\n# \${org:ENDPOINT:-x}\n`;
      const id = await queue(ana, { yaml });
      const source = variables(() => valuesOf({ ENDPOINT: VALUE_MARKER }));

      const sending = dispatcher({ organizationVariables: source });
      await sending.tick();
      await sending.settled();

      expect(source.reads).toEqual([]);
      expect(tester.fake.takeRequests().map((request) => request.yaml)).toEqual([yaml]);
      expect((await row(id)).status).toBe("succeeded");
    });

    it("leaves a reference to an undefined name, or an organization the opamp-server doesn't hold, as written", async () => {
      const ana = await person();
      const yaml = textWith("${org:MISSING}");
      await queue(ana, { yaml });
      await queue(ana, { yaml });
      let answer: OrganizationVariablesRead = valuesOf({ OTHER: VALUE_MARKER });
      const sending = dispatcher({ runsPerTester: 1, organizationVariables: variables(() => answer) });
      await sending.tick();
      await sending.settled();
      answer = { kind: "none" };
      await sending.tick();
      await sending.settled();

      expect(tester.fake.takeRequests().map((request) => request.yaml)).toEqual([yaml, yaml]);
    });

    it("values that can't be read end the run variables_unavailable, with its fixed words, nothing sent", async () => {
      const ana = await person();
      const id = await queue(ana, { yaml: textWith("${org:ENDPOINT}") });

      const failing = dispatcher({ organizationVariables: variables(() => ({ kind: "unavailable", reason: "timeout" })) });
      await failing.tick();
      await failing.settled();

      expect(sent()).toEqual([]);
      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "variables_unavailable",
        error_message: "The organization's variables couldn't be reached. Run it again.",
        lease_id: null,
      });
      expect(log.lines).toEqual([
        { details: { runId: id, reason: "timeout" }, message: "a test run wasn't sent: the organization's variables couldn't be read" },
      ]);
    });

    it("a value grown since the queue, too long once filled in, ends the run filled_in_too_long, nothing sent; one exactly at the limit is sent", async () => {
      const ana = await person();
      const yaml = textWith("${org:LONG}");
      const id = await queue(ana, { yaml });
      // The room the value has, filled in with its $ doubled: half as many $.
      const room = TEST_RUN_YAML_MAXIMUM_LENGTH - (yaml.length - "${org:LONG}".length);
      expect(room % 2).toBe(0);
      // As if it grew after the queue: one $ more than fits.
      let value = "$".repeat(room / 2 + 1);
      const sending = dispatcher({ runsPerTester: 1, organizationVariables: variables(() => valuesOf({ LONG: value })) });
      await sending.tick();
      await sending.settled();
      expect(sent()).toEqual([]);
      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "filled_in_too_long",
        error_message: "The configuration with its organization variables filled in is over 262,144 characters.",
      });
      expect(log.lines).toEqual([
        { details: { runId: id }, message: "a test run wasn't sent: too long once its organization's variables are filled in" },
      ]);

      const fits = await queue(ana, { yaml });
      value = "$".repeat(room / 2);
      await sending.tick();
      await sending.settled();
      const [request] = tester.fake.takeRequests();
      expect(request?.yaml?.length).toBe(TEST_RUN_YAML_MAXIMUM_LENGTH);
      expect((await row(fits)).status).toBe("succeeded");
    });

    it("checks the lease's reserve after the read: a read that uses up the send window ends the run interrupted, unsent", async () => {
      const ana = await person();
      const late = await queue(ana, { yaml: textWith("${org:ENDPOINT}") });
      const onTime = await queue(ana, { yaml: textWith("${org:ENDPOINT}") });
      let clock = 0;
      // 5 s of duration: a lease of 179 s, of which 154 s is reserved, so
      // 25 s may pass between the claim and the send. The read takes them.
      let readMs = 25_001;
      const slowRead = variables(() => {
        clock += readMs;
        return valuesOf({ ENDPOINT: "x" });
      });
      const sending = dispatcher({ runsPerTester: 1, organizationVariables: slowRead, monotonicNow: () => clock });
      await sending.tick();
      await sending.settled();
      expect(sent()).toEqual([]);
      expect(await row(late)).toMatchObject({ status: "failed", error_code: "interrupted" });

      readMs = 25_000;
      await sending.tick();
      await sending.settled();
      expect(sent()).toEqual([onTime]);
      expect(slowRead.reads).toHaveLength(2);
    });

    it("a run the tester refused (released) fills in the values as they are at its next dispatch", async () => {
      const ana = await person();
      const id = await queue(ana, { yaml: textWith("${org:ENDPOINT}") });
      let value = "first";
      let clock = 0;
      const sending = dispatcher({ runsPerTester: 1, organizationVariables: variables(() => valuesOf({ ENDPOINT: value })), monotonicNow: () => clock });
      tester.fake.nextFault("tester_busy");
      await sending.tick();
      await sending.settled();
      expect((await row(id)).status).toBe("queued");

      value = "second";
      clock += TEST_RUN_RELEASE_BACKOFF_MS;
      await sending.tick();
      await sending.settled();
      expect(tester.fake.takeRequests().map((request) => request.yaml)).toEqual([textWith("first"), textWith("second")]);
      expect(await row(id)).toMatchObject({ status: "succeeded", yaml: textWith("${org:ENDPOINT}") });
    });

    /** A source whose read waits for `open()`, then moves `clock` by `ms` and answers `answer`. */
    function gatedVariables(answer: OrganizationVariablesRead, clock: { now: number }, ms: number) {
      let reachedRead = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        reachedRead = resolve;
      });
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const source = variables(async () => {
        reachedRead();
        await gate;
        clock.now += ms;
        return answer;
      });
      return { source, reached, open };
    }

    it("a run stopped during the read goes back to the queue unsent, though the read used up its send window, and its next dispatch reads the values again", async () => {
      const ana = await person();
      const id = await queue(ana, { yaml: textWith("${org:ENDPOINT}") });
      const clock = { now: 0 };
      // Past the reserve: were the stop not seen after the read, the
      // lease's check would end it interrupted.
      const gated = gatedVariables(valuesOf({ ENDPOINT: "old" }), clock, 25_001);
      const stopping = dispatcher({ organizationVariables: gated.source, monotonicNow: () => clock.now });
      expect(await stopping.tick()).toBe(1);
      await gated.reached;
      const stopped = stopping.stop();
      gated.open();
      await stopped;
      expect(await row(id)).toMatchObject({ status: "queued", error_code: null, lease_id: null });
      expect(sent()).toEqual([]);

      // Another process claims it: the values as they are now.
      const next = variables(() => valuesOf({ ENDPOINT: "new" }));
      const sending = dispatcher({ organizationVariables: next });
      await sending.tick();
      await sending.settled();
      expect(tester.fake.takeRequests().map((request) => request.yaml)).toEqual([textWith("new")]);
      expect(next.reads).toEqual([ana.organizationId]);
    });

    it.each<[string, OrganizationVariablesRead]>([
      ["values that can't be read", { kind: "unavailable", reason: "timeout" }],
      ["a text too long once filled in", valuesOf({ ENDPOINT: "x".repeat(TEST_RUN_YAML_MAXIMUM_LENGTH) })],
    ])("a run stopped during a read that answers %s goes back to the queue: nothing was sent, so nothing failed", async (_label, answer) => {
      const ana = await person();
      const id = await queue(ana, { yaml: textWith("${org:ENDPOINT}") });
      const gated = gatedVariables(answer, { now: 0 }, 0);
      const stopping = dispatcher({ organizationVariables: gated.source });
      expect(await stopping.tick()).toBe(1);
      await gated.reached;
      const stopped = stopping.stop();
      gated.open();
      await stopped;
      expect(await row(id)).toMatchObject({ status: "queued", error_code: null, lease_id: null });
      expect(sent()).toEqual([]);
      expect(log.lines).toEqual([]);
    });
  });

  describe("shutdown", () => {
    it("stops claiming, aborts the run in flight and finishes it as interrupted, with its lease", async () => {
      const ana = await person();
      const id = await queue(ana, { marker: "slow" });
      const stopping = dispatcher({ intervalMs: 3_600_000 });
      stopping.start();
      signal.notify();
      await tester.fake.waitForHeld(1);

      await stopping.stop();
      expect(stopping.inFlight()).toBe(0);
      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "interrupted",
        error_message: "The run was interrupted. Run it again.",
        lease_id: null,
      });
      // The tester saw the connection go (and kills the run's group).
      await eventually(() => tester.fake.heldCount() === 0);

      // Stopped: a queued run wakes nothing, and a tick claims nothing.
      const later = await queue(ana);
      signal.notify();
      expect(await stopping.tick()).toBe(0);
      expect((await row(later)).status).toBe("queued");
      expect(sent()).toEqual([id]);
    });

    it("a run claimed but not yet sent goes back to the queue", async () => {
      const ana = await person();
      const id = await queue(ana);
      let reachedRead = (): void => undefined;
      const reading = new Promise<void>((resolve) => {
        reachedRead = resolve;
      });
      let openRead = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        openRead = resolve;
      });
      const gatedStore: IFileStore = {
        ...store,
        read: async (key) => {
          reachedRead();
          await gate;
          return store.read(key);
        },
      };
      const stopping = dispatcher({ fileStore: gatedStore });
      expect(await stopping.tick()).toBe(1);
      await reading;

      const stopped = stopping.stop();
      openRead();
      await stopped;
      expect(await row(id)).toMatchObject({ status: "queued", started_at: null, lease_id: null });
      expect(sent()).toEqual([]);
    });
  });
});

describe("the test-run reaper", () => {
  let databases: TestDatabases;
  let ownerDb: Kysely<Database>;
  let db: Kysely<Database>;
  let who: Person;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    const { user, organization } = await createUserWithOrganization(ownerDb);
    const configuration = await addConfiguration(ownerDb, { organizationId: organization.id, created_by_user_id: user.id });
    const configurationVersion = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId: organization.id });
    who = { userId: user.id, organizationId: organization.id, configurationId: configuration.id, versionId: configurationVersion.id };
  });

  function reaper(downFailAfterSeconds = 600) {
    return createTestRunReaper({ db, downFailAfterSeconds, log: recordingLog() });
  }

  async function addRun(state: Parameters<typeof addTestRun>[1]["state"] = {}): Promise<string> {
    const run = await addTestRun(ownerDb, {
      organizationId: who.organizationId,
      configurationId: who.configurationId,
      configurationVersionId: who.versionId,
      queuedByUserId: who.userId,
      state,
    });
    return run.id;
  }

  /** A running run whose lease ends `secondsFromNow` from now (negative: past). */
  function running(secondsFromNow: number) {
    const now = Date.now();
    return {
      status: "running" as const,
      queued_at: new Date(now - 600_000),
      started_at: new Date(now - 300_000),
      lease_id: randomUUID(),
      lease_expires_at: new Date(now + secondsFromNow * 1000),
    };
  }

  async function row(id: string): Promise<Run> {
    return ownerDb.selectFrom("test_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  }

  it("fails a running run past its lease as interrupted, and nothing else (decision 18)", async () => {
    const past = await addRun(running(-1));
    const current = await addRun(running(60));
    const waiting = await addRun({ queued_at: new Date(Date.now() - 1_000) });

    expect(await reaper().runOnce()).toEqual({ reaped: [past], failedWaiting: [] });
    expect(await row(past)).toMatchObject({
      status: "failed",
      error_code: "interrupted",
      error_message: "The run was interrupted. Run it again.",
      lease_id: null,
    });
    expect((await row(current)).status).toBe("running");
    expect((await row(waiting)).status).toBe("queued");
  });

  it("fails every waiting run once the tester has been down longer than the limit, and never a running one (decision 12)", async () => {
    const waiting = [await addRun(), await addRun()];
    const current = await addRun(running(60));

    await sql`update otelcol_testing_state set down_since = null`.execute(ownerDb);
    expect(await reaper().runOnce()).toEqual({ reaped: [], failedWaiting: [] });

    // Down, but not for long enough: a waiting run waits.
    await sql`update otelcol_testing_state set down_since = now() - interval '599 seconds'`.execute(ownerDb);
    expect((await reaper().runOnce()).failedWaiting).toEqual([]);

    await sql`update otelcol_testing_state set down_since = now() - interval '601 seconds'`.execute(ownerDb);
    expect((await reaper().runOnce()).failedWaiting.sort()).toEqual([...waiting].sort());
    for (const id of waiting) {
      expect(await row(id)).toMatchObject({
        status: "failed",
        error_code: "testing_unavailable",
        error_message: TESTING_UNAVAILABLE_MESSAGE,
      });
    }
    expect(TESTING_UNAVAILABLE_MESSAGE).toBe("Testing is unavailable right now. Try again later.");
    expect((await row(current)).status).toBe("running");
  });

  it("takes the down limit from its setting", async () => {
    const id = await addRun();
    await sql`update otelcol_testing_state set down_since = now() - interval '11 seconds'`.execute(ownerDb);
    expect((await reaper(600).runOnce()).failedWaiting).toEqual([]);
    expect((await reaper(10).runOnce()).failedWaiting).toEqual([id]);
  });

  it("started, runs at once and stops cleanly", async () => {
    const past = await addRun(running(-1));
    const started = reaper();
    started.start();
    await eventually(async () => (await row(past)).status === "failed");
    await started.stop();
  });
});
