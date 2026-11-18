import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import pg from "pg";
import type { Database, TestRunsTable } from "./schema.js";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestInputFile,
  addTestRun,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type AddTestInputFileInput,
  type AddTestRunInput,
  type TestDatabases,
} from "./testing.js";

/*
 * Migration 1700000000028 (D14a decisions 1, 7 to 9, 11, 12, 20 and 27;
 * Preflight rulings 7 to 9): test files, test runs, the run guard trigger,
 * the tester's state and the dispatcher's functions. Its up, down and up
 * again are schema.integration.test.ts's ("the test runs migration …").
 * The cross-tenant suite covers both tables from the resource registry,
 * draft-privacy.integration.test.ts the runs' visibility within an
 * organization, and apps/api's test-run-functions.integration.test.ts the
 * dispatcher's functions refused from members' real contexts.
 *
 * The database context is set here with set_config, as context.ts sets it:
 * these tests are the database's own. The queue's turns and caps are
 * checked by what the functions return, never by time: every queued time
 * is chosen, in the past. The functions' own times (D14a Ruling 22) are
 * checked with two sessions: the dispatcher's transaction begins, another
 * session queues or claims and commits, then the dispatcher's function runs.
 */

/** A claimed run, as test_runs_claim returns it. */
interface ClaimedRun {
  run_id: string;
  organization_id: string;
  lease_id: string;
  lease_expires_at: Date;
  yaml: string;
  target_pipeline: string;
  signal: string;
  duration_seconds: number;
  collector_distribution: string;
  collector_version: string;
}

/** Whom a transaction acts as: a member (a user, an organization), the dispatcher, or nobody. */
interface Context {
  userId?: string;
  organizationId?: string;
  dispatcher?: boolean;
}

/** The message the reaper writes (D14a decision 29). */
const INTERRUPTED = "The run was interrupted. Run it again.";
/** The message the down rule writes (D14a decision 12). */
const UNAVAILABLE = "Testing is unavailable right now. Try again later.";

/** A fixed time in the past, which every chosen queued time counts from. */
const T0 = new Date("2026-01-01T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("test runs and test files (migration 1700000000028)", () => {
  let databases: TestDatabases;
  /** The API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** Runs `work` as the API's role in `context`, set as context.ts sets it, in one transaction. */
  const inContext = <Result>(context: Context, work: (transaction: Transaction<Database>) => Promise<Result>) =>
    db.transaction().execute(async (transaction) => {
      await sql`
        select set_config('telflo.user_id', ${context.userId ?? ""}, true),
               set_config('telflo.organization_id', ${context.organizationId ?? ""}, true),
               set_config('telflo.dispatcher', ${context.dispatcher === true ? "on" : ""}, true)
      `.execute(transaction);
      return work(transaction);
    });
  const asDispatcher = <Result>(work: (transaction: Transaction<Database>) => Promise<Result>) =>
    inContext({ dispatcher: true }, work);

  const claim = async (slots: number, overhead = 30) =>
    (
      await asDispatcher((transaction) =>
        sql<ClaimedRun>`select * from test_runs_claim(${slots}::integer, ${overhead}::integer)`.execute(transaction),
      )
    ).rows;
  /** test_runs_finish with the run's final status (migration 1700000000030 replaced 028's boolean). */
  const finish = async (runId: string, leaseId: string, status: string, results: Record<string, unknown> = {}) =>
    (
      await asDispatcher((transaction) =>
        sql<{ done: boolean }>`
          select test_runs_finish(${runId}::uuid, ${leaseId}::uuid, ${status}, ${JSON.stringify(results)}::jsonb) as done
        `.execute(transaction),
      )
    ).rows[0]!.done;
  const release = async (runId: string, leaseId: string) =>
    (
      await asDispatcher((transaction) =>
        sql<{ done: boolean }>`select test_runs_release(${runId}::uuid, ${leaseId}::uuid) as done`.execute(transaction),
      )
    ).rows[0]!.done;
  const reap = async (message = INTERRUPTED) =>
    (
      await asDispatcher((transaction) =>
        sql<{ id: string }>`select id from test_runs_reap(${message}) as id`.execute(transaction),
      )
    ).rows.map((row) => row.id);
  const failWaiting = async (downFor: string, message = UNAVAILABLE) =>
    (
      await asDispatcher((transaction) =>
        sql<{ id: string }>`select id from test_runs_fail_waiting(${downFor}::interval, ${message}) as id`.execute(
          transaction,
        ),
      )
    ).rows.map((row) => row.id);
  const mark = async (up: boolean) =>
    (
      await asDispatcher((transaction) =>
        sql<{ since: Date | null }>`select otelcol_testing_mark(${up}) as since`.execute(transaction),
      )
    ).rows[0]!.since;
  /** "n ahead" for `runIds`, as `context` asks it, by run id. */
  const ahead = async (context: Context, runIds: string[]) =>
    Object.fromEntries(
      (
        await inContext(context, (transaction) =>
          sql<{ run_id: string; ahead: number }>`select * from test_runs_ahead(${runIds}::uuid[])`.execute(transaction),
        )
      ).rows.map((row) => [row.run_id, row.ahead]),
    );
  const waitingForContextUser = async (context: Context) =>
    (
      await inContext(context, (transaction) =>
        sql<{ count: number }>`select test_runs_waiting_for_context_user() as count`.execute(transaction),
      )
    ).rows[0]!.count;

  /** A run as the owner reads it back. */
  const runRow = (id: string) => ownerDb.selectFrom("test_runs").selectAll().where("id", "=", id).executeTakeFirst();

  /**
   * Two group organizations. A: Ana (who authored a draft, D, and a
   * published configuration, P) and Ben; B: Cara, with her published
   * configuration Q. Each keeps their personal organization.
   */
  const world = async () => {
    const person = async () => (await createUserWithOrganization(ownerDb)).user.id;
    const ana = await person();
    const ben = await person();
    const cara = await person();
    const { organization: a } = await addMembership(ownerDb, { userId: ana });
    await addMembership(ownerDb, { userId: ben, organizationId: a.id, role: "contributor" });
    const { organization: b } = await addMembership(ownerDb, { userId: cara });
    const configuration = async (organizationId: string, authorId: string, published: boolean) => {
      const row = await addConfiguration(ownerDb, { organizationId, created_by_user_id: authorId });
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: row.id,
        organizationId,
        created_by_user_id: authorId,
        ...(published ? { publishedAt: new Date() } : {}),
      });
      return { configurationId: row.id, versionId: version.id, organizationId };
    };
    return {
      ana,
      ben,
      cara,
      a: a.id,
      b: b.id,
      draft: await configuration(a.id, ana, false),
      published: await configuration(a.id, ana, true),
      inB: await configuration(b.id, cara, true),
    };
  };
  type World = Awaited<ReturnType<typeof world>>;
  type Target = World["draft"];

  /** Adds a run on `target` queued by `userId`, as the owner. */
  const queue = (
    target: Target,
    userId: string | null,
    overrides: Partial<Omit<AddTestRunInput, "organizationId" | "configurationId" | "configurationVersionId">> = {},
  ) =>
    addTestRun(ownerDb, {
      organizationId: target.organizationId,
      configurationId: target.configurationId,
      configurationVersionId: target.versionId,
      queuedByUserId: userId,
      ...overrides,
    });

  /** Inserts a run as the API's role in `context`, with raw SQL so any column can be named. */
  const insertAsMember = (context: Context, target: Target, extra: Record<string, unknown> = {}) =>
    inContext(context, (transaction) =>
      transaction
        .insertInto("test_runs")
        .values({
          organization_id: target.organizationId,
          configuration_id: target.configurationId,
          configuration_version_id: target.versionId,
          queued_by_user_id: context.userId ?? null,
          yaml: "receivers: {}\n",
          target_pipeline: "logs",
          signal: "logs",
          duration_seconds: 5,
          collector_distribution: "otelcol-contrib",
          collector_version: sql`(select version from collector_versions where is_default)`,
          input_name: "input.json",
          input_size_bytes: 0,
          ...extra,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow(),
    );

  describe("constraints, as the owner", () => {
    it("stores a queued run with its snapshot, queued now by the database's clock, a uuidv7 id and no results", async () => {
      const w = await world();
      const { rows } = await sql<{ now: Date }>`select now() as now`.execute(ownerDb);
      const run = await queue(w.published, w.ana);
      expect(run).toMatchObject({
        status: "queued",
        started_at: null,
        finished_at: null,
        lease_id: null,
        lease_expires_at: null,
        queued_by_user_id: w.ana,
        source_run_id: null,
        error_code: null,
        mutations: null,
        output_size_bytes: null,
      });
      expect(run.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(run.queued_at.getTime()).toBeGreaterThanOrEqual(rows[0]!.now.getTime() - 1);
    });

    it("refuses a duration outside 1 to 60 seconds (ck_test_runs_duration_seconds), and takes 1 and 60", async () => {
      const w = await world();
      for (const duration_seconds of [0, 61, -1]) {
        await expect(queue(w.published, w.ana, { duration_seconds })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_test_runs_duration_seconds",
        });
      }
      for (const duration_seconds of [1, 60]) {
        expect((await queue(w.published, w.ana, { duration_seconds })).duration_seconds).toBe(duration_seconds);
      }
    });

    it("refuses a status or a signal outside its list (ck_test_runs_status, ck_test_runs_signal)", async () => {
      const w = await world();
      // An unknown status breaks ck_test_runs_state as well, which names the statuses too; either answers.
      await expect(
        queue(w.published, w.ana, { state: { status: "cancelled" as never } }),
      ).rejects.toMatchObject({ code: "23514", constraint: expect.stringMatching(/^ck_test_runs_stat(us|e)$/) });
      await expect(queue(w.published, w.ana, { signal: "profiles" as never })).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_test_runs_signal",
      });
    });

    it("refuses a text over 262,144 characters (ck_test_runs_yaml_length), and takes 262,144", async () => {
      const w = await world();
      await expect(queue(w.published, w.ana, { yaml: "x".repeat(262_145) })).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_test_runs_yaml_length",
      });
      expect((await queue(w.published, w.ana, { yaml: "x".repeat(262_144) })).yaml).toHaveLength(262_144);
    });

    it("refuses an input, an output or a decoded input over 10,485,760 bytes or below 0, and a size without its truncation", async () => {
      const w = await world();
      for (const input_size_bytes of [10_485_761, -1]) {
        await expect(queue(w.published, w.ana, { input_size_bytes })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_test_runs_input_size_bytes",
        });
      }
      expect((await queue(w.published, w.ana, { input_size_bytes: 10_485_760 })).input_size_bytes).toBe(10_485_760);
      const finished = { status: "succeeded" as const, queued_at: at(0), started_at: at(1), finished_at: at(2) };
      const withResults = (results: Record<string, unknown>) =>
        queue(w.published, w.ana, { state: finished, ...(results as object) });
      await expect(withResults({ output_size_bytes: 10_485_761, output_truncated: true })).rejects.toMatchObject({
        constraint: "ck_test_runs_output_size_bytes",
      });
      await expect(
        withResults({ decoded_input_size_bytes: -1, decoded_input_truncated: false }),
      ).rejects.toMatchObject({ constraint: "ck_test_runs_decoded_input_size_bytes" });
      await expect(withResults({ output_size_bytes: 10 })).rejects.toMatchObject({
        constraint: "ck_test_runs_output_truncated",
      });
      await expect(withResults({ decoded_input_truncated: true })).rejects.toMatchObject({
        constraint: "ck_test_runs_decoded_input_truncated",
      });
      expect(
        await withResults({
          output_size_bytes: 10_485_760,
          output_truncated: true,
          decoded_input_size_bytes: 0,
          decoded_input_truncated: false,
        }),
      ).toMatchObject({ output_size_bytes: 10_485_760, decoded_input_truncated: false });
    });

    it("ties the times and the lease to the status (ck_test_runs_state) and keeps the times in order", async () => {
      const w = await world();
      const lease = { lease_id: randomUUID(), lease_expires_at: at(100) };
      const refused = [
        { status: "queued" as const, started_at: at(1) },
        { status: "queued" as const, ...lease },
        { status: "running" as const, started_at: at(1) },
        { status: "running" as const, ...lease },
        { status: "succeeded" as const, started_at: at(1) },
        { status: "failed" as const, finished_at: at(2), ...lease, started_at: at(1) },
      ];
      for (const state of refused) {
        await expect(queue(w.published, w.ana, { state: { queued_at: at(0), ...state } })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_test_runs_state",
        });
      }
      await expect(
        queue(w.published, w.ana, { state: { queued_at: at(5), status: "running", started_at: at(1), ...lease } }),
      ).rejects.toMatchObject({ constraint: "ck_test_runs_times_ordered" });
      await expect(
        queue(w.published, w.ana, { state: { queued_at: at(0), status: "failed", started_at: at(5), finished_at: at(1) } }),
      ).rejects.toMatchObject({ constraint: "ck_test_runs_times_ordered" });
      // Failed while waiting: finished, never started.
      expect(
        await queue(w.published, w.ana, { state: { queued_at: at(0), status: "failed", finished_at: at(1) } }),
      ).toMatchObject({ status: "failed", started_at: null });
    });

    it("refuses results on a queued or running run (ck_test_runs_results_only_when_finished), and a mutations list that isn't an array", async () => {
      const w = await world();
      const running = { status: "running" as const, started_at: at(1), lease_id: randomUUID(), lease_expires_at: at(9) };
      for (const state of [{ status: "queued" as const }, running]) {
        for (const result of [{ error_code: "interrupted" }, { logs: "" }, { kwok_enabled: false }]) {
          await expect(
            queue(w.published, w.ana, { state: { queued_at: at(0), ...state }, ...(result as object) }),
          ).rejects.toMatchObject({ code: "23514", constraint: "ck_test_runs_results_only_when_finished" });
        }
      }
      await expect(
        queue(w.published, w.ana, {
          state: { queued_at: at(0), status: "failed", finished_at: at(1) },
          ...({ mutations: JSON.stringify({ id: "R-001" }) } as object),
        }),
      ).rejects.toMatchObject({ constraint: "ck_test_runs_result_shapes" });
    });

    it("refuses a test file over 10 MiB, a SHA-256 of another length, and an empty or untrimmed display name", async () => {
      const w = await world();
      const file = (overrides: Partial<AddTestInputFileInput>) =>
        addTestInputFile(ownerDb, { organizationId: w.a, ownerUserId: w.ana, ...overrides });
      await expect(file({ size_bytes: 10_485_761 })).rejects.toMatchObject({
        constraint: "ck_test_input_files_size_bytes",
      });
      await expect(file({ sha256: Buffer.alloc(31) })).rejects.toMatchObject({
        constraint: "ck_test_input_files_sha256_length",
      });
      await expect(file({ display_name: "" })).rejects.toMatchObject({
        constraint: "ck_test_input_files_display_name_length",
      });
      await expect(file({ display_name: " app logs" })).rejects.toMatchObject({
        constraint: "ck_test_input_files_display_name_trimmed",
      });
      expect(await file({ size_bytes: 10_485_760 })).toMatchObject({ size_bytes: 10_485_760, description: "" });
    });

    it("refuses a run naming another organization's configuration, or a version of another configuration (23503)", async () => {
      const w = await world();
      // Both keys naming the configuration refuse it; whichever Postgres checks first answers.
      await expect(queue({ ...w.published, organizationId: w.b }, w.cara)).rejects.toMatchObject({
        code: "23503",
        constraint: expect.stringMatching(/^fk_test_runs_configuration(_version)?$/),
      });
      await expect(
        queue({ ...w.published, versionId: w.draft.versionId }, w.ana),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_test_runs_configuration_version" });
      await expect(
        queue(w.published, w.ana, { collector_distribution: "otelcol-contrib", collector_version: "0.0.1" }),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_test_runs_collector_version" });
    });

    it("refuses a run pinned to a distribution other than its configuration's (23503, fk_test_runs_configuration_distribution)", async () => {
      const w = await world();
      // Another distribution exists only in this rolled-back transaction: the catalogue is never changed in telflo_platform_test.
      const rollback = new Error("rollback");
      await expect(
        ownerDb.transaction().execute(async (transaction) => {
          await sql`
            insert into collector_distributions (id, label, sort_order, is_default)
            values ('otelcol-other', 'Other', 99, false)
          `.execute(transaction);
          await sql`
            insert into collector_versions (distribution, version, label, released_at, is_default, deprecated,
                                            container_image, otelcol_contrib, opamp_supervisor)
            select 'otelcol-other', version, label, released_at, false, false, container_image, otelcol_contrib,
                   opamp_supervisor
              from collector_versions where is_default and distribution = 'otelcol-contrib'
          `.execute(transaction);
          const { version } = await transaction
            .selectFrom("collector_versions")
            .select("version")
            .where("distribution", "=", "otelcol-other")
            .executeTakeFirstOrThrow();
          await expect(
            addTestRun(transaction, {
              organizationId: w.a,
              configurationId: w.published.configurationId,
              configurationVersionId: w.published.versionId,
              queuedByUserId: w.ana,
              collector_distribution: "otelcol-other",
              collector_version: version,
            }),
          ).rejects.toMatchObject({ code: "23503", constraint: "fk_test_runs_configuration_distribution" });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });

    it("keeps a hard-deleted account's runs, with no person, and takes its test files", async () => {
      const w = await world();
      const run = await queue(w.published, w.ben, { state: { queued_at: at(0), status: "failed", finished_at: at(1) } });
      const waiting = await queue(w.published, w.ben);
      await addTestInputFile(ownerDb, { organizationId: w.a, ownerUserId: w.ben });
      const anasFile = await addTestInputFile(ownerDb, { organizationId: w.a, ownerUserId: w.ana });

      await ownerDb.deleteFrom("users").where("id", "=", w.ben).execute();

      expect(await runRow(run.id)).toEqual({ ...run, queued_by_user_id: null });
      expect(await runRow(waiting.id)).toEqual({ ...waiting, queued_by_user_id: null });
      const files = await ownerDb.selectFrom("test_input_files").select("id").execute();
      expect(files).toEqual([{ id: anasFile.id }]);
    });

    it("goes with its organization when the organization is hard-deleted, runs and files alike, and leaves others'", async () => {
      const w = await world();
      const doomed = await queue(w.published, w.ana);
      const doomedFile = await addTestInputFile(ownerDb, { organizationId: w.a, ownerUserId: w.ana });
      const kept = await queue(w.inB, w.cara);

      await ownerDb.deleteFrom("organizations").where("id", "=", w.a).execute();

      expect(await runRow(doomed.id)).toBeUndefined();
      expect(await ownerDb.selectFrom("test_input_files").select("id").where("id", "=", doomedFile.id).execute()).toEqual(
        [],
      );
      expect(await runRow(kept.id)).toEqual(kept);
    });
  });

  describe("the guard trigger, for every role (here the owner, past row-level security)", () => {
    /** Updates the run as the owner. */
    const change = (id: string, values: Record<string, unknown>) =>
      ownerDb
        .updateTable("test_runs")
        .set(values as never)
        .where("id", "=", id)
        .execute();

    it("refuses a change to each column of the snapshot (P0001, naming only the run), and to the person but to null", async () => {
      const w = await world();
      const run = await queue(w.published, w.ana);
      const changes: Record<string, unknown> = {
        id: randomUUID(),
        organization_id: w.b,
        configuration_id: w.draft.configurationId,
        configuration_version_id: w.draft.versionId,
        source_run_id: randomUUID(),
        yaml: "changed",
        target_pipeline: "traces",
        signal: "traces",
        duration_seconds: 6,
        collector_distribution: "otelcol-other",
        collector_version: "0.0.1",
        input_name: "other.json",
        input_size_bytes: 1,
        queued_at: at(0),
        queued_by_user_id: w.ben,
      };
      for (const [column, value] of Object.entries(changes)) {
        await expect(change(run.id, { [column]: value }), column).rejects.toMatchObject({
          code: "P0001",
          message: `test run ${run.id} keeps its snapshot`,
        });
      }
      expect(await runRow(run.id)).toEqual(run);

      await change(run.id, { queued_by_user_id: null });
      expect(await runRow(run.id)).toEqual({ ...run, queued_by_user_id: null });
    });

    it("lets a status go only queued → running or failed and running → succeeded, failed, validation_failed or queued", async () => {
      const w = await world();
      const lease = () => ({ lease_id: randomUUID(), lease_expires_at: at(100) });
      /** Every run here carries one rule, this one. */
      const ruleId = randomUUID();
      /**
       * A finished run's rules' results, as ck_test_runs_validation_outcome
       * wants them for its status (migration 1700000000030): every run here
       * carries one rule, which passed on a succeeded run and failed on a
       * validation_failed one.
       */
      const outcome = (status: Selectable<TestRunsTable>["status"]) =>
        status === "succeeded"
          ? JSON.stringify([{ id: ruleId, passed: true }])
          : status === "validation_failed"
            ? JSON.stringify([{ id: ruleId, passed: false }])
            : null;
      /** A run in `status`, as the table's checks want it. */
      const inState = (status: Selectable<TestRunsTable>["status"]) =>
        queue(w.published, w.ana, {
          validation_rules: JSON.stringify([{ id: ruleId, kind: "contains_text", target: "output", pattern: "x" }]),
          state:
            status === "queued"
              ? { queued_at: at(0) }
              : status === "running"
                ? { queued_at: at(0), status, started_at: at(1), ...lease() }
                : { queued_at: at(0), status, started_at: at(1), finished_at: at(2), validation_results: outcome(status) },
        });
      /** The columns a move to `status` sets, consistent with ck_test_runs_state and ck_test_runs_validation_outcome. */
      const into = (status: Selectable<TestRunsTable>["status"]) =>
        status === "queued"
          ? { status, started_at: null, finished_at: null, lease_id: null, lease_expires_at: null }
          : status === "running"
            ? { status, started_at: at(1), finished_at: null, ...lease() }
            : {
                status,
                started_at: at(1),
                finished_at: at(2),
                lease_id: null,
                lease_expires_at: null,
                validation_results: outcome(status),
              };
      const statuses = ["queued", "running", "succeeded", "failed", "validation_failed"] as const;
      const allowed = new Set([
        "queued→running",
        "queued→failed",
        "running→succeeded",
        "running→failed",
        "running→validation_failed",
        "running→queued",
      ]);
      for (const from of statuses) {
        for (const to of statuses) {
          if (from === to) continue;
          const run = await inState(from);
          const move = change(run.id, into(to));
          if (allowed.has(`${from}→${to}`)) {
            await expect(move.then(() => "allowed"), `${from}→${to}`).resolves.toBe("allowed");
          } else {
            await expect(move, `${from}→${to}`).rejects.toMatchObject({
              code: "P0001",
              message: `test run ${run.id} can't go from ${from} to ${to}`,
            });
          }
        }
      }
    });

    it("refuses any change of a run that keeps its status: a running run's lease, a finished run's results; but lets its person become null", async () => {
      const w = await world();
      const running = await queue(w.published, w.ana, {
        state: { queued_at: at(0), status: "running", started_at: at(1), lease_id: randomUUID(), lease_expires_at: at(9) },
      });
      await expect(change(running.id, { lease_id: randomUUID() })).rejects.toMatchObject({
        code: "P0001",
        message: `test run ${running.id} changes only with its status`,
      });
      await expect(change(running.id, { lease_expires_at: at(500) })).rejects.toMatchObject({ code: "P0001" });
      const finished = await queue(w.published, w.ana, {
        state: { queued_at: at(0), status: "succeeded", started_at: at(1), finished_at: at(2) },
        ...({ logs: "ok" } as object),
      });
      for (const values of [{ logs: "rewritten" }, { finished_at: at(3) }, { error_code: "late" }]) {
        await expect(change(finished.id, values)).rejects.toMatchObject({ code: "P0001" });
      }
      await change(finished.id, { queued_by_user_id: null });
      expect(await runRow(finished.id)).toEqual({ ...finished, queued_by_user_id: null });
    });
  });

  describe("row-level security, as the application role", () => {
    it("shows a test file to its owner only, in its own organization: not a teammate, not another organization", async () => {
      const w = await world();
      const file = await addTestInputFile(ownerDb, { organizationId: w.a, ownerUserId: w.ana });
      const visible = (context: Context) =>
        inContext(context, async (transaction) =>
          (await sql<{ id: string }>`select id from test_input_files`.execute(transaction)).rows.map((row) => row.id),
        );
      expect(await visible({ userId: w.ana, organizationId: w.a })).toEqual([file.id]);
      expect(await visible({ userId: w.ben, organizationId: w.a })).toEqual([]);
      expect(await visible({ userId: w.cara, organizationId: w.b })).toEqual([]);
      // Ana herself, acting in another organization, doesn't see it either.
      expect(await visible({ userId: w.ana, organizationId: w.b })).toEqual([]);
      expect(await visible({})).toEqual([]);
    });

    it("adds a test file only as the context's user in the context's organization (42501 otherwise)", async () => {
      const w = await world();
      const insert = (context: Context, ownerUserId: string, organizationId: string) =>
        inContext(context, (transaction) =>
          transaction
            .insertInto("test_input_files")
            .values({
              organization_id: organizationId,
              owner_user_id: ownerUserId,
              display_name: "app logs",
              file_name: "app-logs.json",
              content_type: "application/json",
              size_bytes: 3,
              sha256: Buffer.alloc(32),
            })
            .returning("id")
            .executeTakeFirstOrThrow(),
        );
      await expect(insert({ userId: w.ben, organizationId: w.a }, w.ana, w.a)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(insert({ userId: w.cara, organizationId: w.b }, w.cara, w.a)).rejects.toMatchObject({
        code: "42501",
      });
      expect(await insert({ userId: w.ana, organizationId: w.a }, w.ana, w.a)).toEqual({ id: expect.any(String) });
    });

    it("updates no test file, its owner's included, and deletes only the owner's own", async () => {
      const w = await world();
      const file = await addTestInputFile(ownerDb, { organizationId: w.a, ownerUserId: w.ana });
      const run = (context: Context, statement: "update" | "delete") =>
        inContext(context, (transaction) =>
          (statement === "update"
            ? sql`update test_input_files set display_name = 'renamed'`
            : sql`delete from test_input_files`
          ).execute(transaction),
        );
      expect((await run({ userId: w.ana, organizationId: w.a }, "update")).numAffectedRows).toBe(0n);
      expect((await run({ userId: w.ben, organizationId: w.a }, "delete")).numAffectedRows).toBe(0n);
      expect((await run({ userId: w.cara, organizationId: w.b }, "delete")).numAffectedRows).toBe(0n);
      expect(await ownerDb.selectFrom("test_input_files").selectAll().execute()).toEqual([file]);
      expect((await run({ userId: w.ana, organizationId: w.a }, "delete")).numAffectedRows).toBe(1n);
    });

    it("lets a member queue a run on a configuration they can see, as themselves, queued, at now()", async () => {
      const w = await world();
      const inserted = await insertAsMember({ userId: w.ben, organizationId: w.a }, w.published);
      expect(await runRow(inserted.id)).toMatchObject({ status: "queued", queued_by_user_id: w.ben });
      await insertAsMember({ userId: w.ana, organizationId: w.a }, w.draft);
    });

    it("refuses a run queued as someone else, on another member's draft, in another organization, not queued, or backdated (42501), and one with results (23514)", async () => {
      const w = await world();
      const ben = { userId: w.ben, organizationId: w.a };
      await expect(insertAsMember(ben, w.published, { queued_by_user_id: w.ana })).rejects.toMatchObject({
        code: "42501",
      });
      await expect(insertAsMember(ben, w.draft)).rejects.toMatchObject({ code: "42501" });
      await expect(insertAsMember({ userId: w.cara, organizationId: w.b }, w.published)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        insertAsMember(ben, w.published, {
          status: "running",
          started_at: sql`now()`,
          lease_id: randomUUID(),
          lease_expires_at: sql`now() + interval '1 minute'`,
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        insertAsMember(ben, w.published, { queued_at: sql`now() - interval '1 minute'` }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(insertAsMember(ben, w.published, { error_code: "slipped_in" })).rejects.toMatchObject({
        code: "23514",
        constraint: "ck_test_runs_results_only_when_finished",
      });
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([]);
    });

    it("updates and deletes no run, its own author's included", async () => {
      const w = await world();
      const run = await queue(w.draft, w.ana);
      const result = await inContext({ userId: w.ana, organizationId: w.a }, async (transaction) => ({
        visible: (await sql`select id from test_runs`.execute(transaction)).rows,
        updated: await sql`update test_runs set status = 'failed', finished_at = now()`.execute(transaction),
        deleted: await sql`delete from test_runs`.execute(transaction),
      }));
      expect(result.visible).toEqual([{ id: run.id }]);
      expect(result.updated.numAffectedRows).toBe(0n);
      expect(result.deleted.numAffectedRows).toBe(0n);
      expect(await runRow(run.id)).toEqual(run);
    });
  });

  describe("the dispatcher's functions", () => {
    const dispatcherCalls: Array<[string, ReturnType<typeof sql>]> = [
      ["test_runs_claim", sql`select * from test_runs_claim(4, 30)`],
      ["test_runs_finish", sql`select test_runs_finish(${randomUUID()}::uuid, ${randomUUID()}::uuid, 'succeeded', '{}')`],
      ["test_runs_release", sql`select test_runs_release(${randomUUID()}::uuid, ${randomUUID()}::uuid)`],
      ["test_runs_reap", sql`select * from test_runs_reap('x')`],
      ["test_runs_fail_waiting", sql`select * from test_runs_fail_waiting('1 second', 'x')`],
      ["otelcol_testing_mark", sql`select otelcol_testing_mark(false)`],
    ];

    it("refuse (42501) without the dispatcher's context: with none, and with the setting on beside a user or an organization", async () => {
      const w = await world();
      const contexts: Context[] = [
        {},
        { dispatcher: true, userId: w.ana },
        { dispatcher: true, organizationId: w.a },
        { dispatcher: true, userId: w.ana, organizationId: w.a },
      ];
      for (const [name, call] of dispatcherCalls) {
        for (const context of contexts) {
          await expect(
            inContext(context, (transaction) => call.execute(transaction)).then(() => "ran"),
            `${name} in ${JSON.stringify(context)}`,
          ).rejects.toMatchObject({ code: "42501", message: "only the test-run dispatcher may do this" });
        }
        // The dispatcher's own context reaches it.
        await asDispatcher((transaction) => call.execute(transaction));
      }
      // The helper itself is no one's to call.
      await expect(
        asDispatcher((transaction) => sql`select test_runs_require_dispatcher()`.execute(transaction)),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("claims in Q17's turns: Ana's ten runs, Ben's one and Cara's two (organization B), four slots: ana0, ben0, cara0, ana1, and n ahead counts in that order", async () => {
      const w = await world();
      const anas: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        anas.push((await queue(w.published, w.ana, { state: { queued_at: at(index) } })).id);
      }
      const ben0 = (await queue(w.published, w.ben, { state: { queued_at: at(10) } })).id;
      const caras = [
        (await queue(w.inB, w.cara, { state: { queued_at: at(11) } })).id,
        (await queue(w.inB, w.cara, { state: { queued_at: at(12) } })).id,
      ];
      const all = [...anas, ben0, ...caras];
      const inA = { userId: w.ana, organizationId: w.a };
      const inB = { userId: w.cara, organizationId: w.b };

      // Before: turn 0 is ana0, ben0, cara0 (oldest first); turn 1 ana1, cara1; then Ana's alone.
      expect(await ahead(inA, all)).toEqual({
        [anas[0]!]: 0,
        [ben0]: 1,
        [anas[1]!]: 3,
        ...Object.fromEntries(anas.slice(2).map((id, index) => [id, 5 + index])),
      });
      expect(await ahead(inB, all)).toEqual({ [caras[0]!]: 2, [caras[1]!]: 4 });

      const claimed = await claim(4);
      expect(claimed.map((run) => run.run_id).sort()).toEqual([anas[0]!, ben0, caras[0]!, anas[1]!].sort());

      // After: Ana has two running, Ben and Cara one each.
      expect(await ahead(inA, all)).toEqual(Object.fromEntries(anas.slice(2).map((id, index) => [id, 1 + index])));
      expect(await ahead(inB, all)).toEqual({ [caras[1]!]: 0 });
      // Every slot is taken: nothing more is claimed.
      expect(await claim(4)).toEqual([]);
      // A fifth slot goes to Cara's next run, whose turn (1) comes before Ana's next (2).
      expect((await claim(5)).map((run) => run.run_id)).toEqual([caras[1]!]);
    });

    it("returns each claimed run's snapshot, organization and lease, expiring after its duration plus the overhead, and marks it running", async () => {
      const w = await world();
      const run = await queue(w.inB, w.cara, { duration_seconds: 7, yaml: "receivers: {otlp: {}}\n", target_pipeline: "logs/app" });
      const [claimed] = await claim(1, 104);
      expect(claimed).toEqual({
        run_id: run.id,
        organization_id: w.b,
        lease_id: expect.any(String),
        lease_expires_at: expect.any(Date),
        yaml: "receivers: {otlp: {}}\n",
        target_pipeline: "logs/app",
        signal: "logs",
        duration_seconds: 7,
        collector_distribution: run.collector_distribution,
        collector_version: run.collector_version,
      });
      const row = (await runRow(run.id))!;
      expect(row).toMatchObject({ status: "running", lease_id: claimed!.lease_id });
      expect(row.lease_expires_at!.getTime() - row.started_at!.getTime()).toBe((7 + 104) * 1000);
      await expect(claim(-1)).rejects.toMatchObject({ code: "22023" });
    });

    it("never runs more than its slots across two claims at once: the second waits for the first's commit, then takes none, even of a run queued between them", async () => {
      const w = await world();
      for (let index = 0; index < 6; index += 1) await queue(w.published, w.ana, { state: { queued_at: at(index) } });
      const session = async () => {
        const client = new pg.Client({ connectionString: process.env.TELFLO_DATABASE_URL });
        await client.connect();
        await client.query("begin");
        await client.query("select set_config('telflo.dispatcher', 'on', true)");
        return client;
      };
      const first = await session();
      const second = await session();
      try {
        const firstClaim = await first.query("select run_id from test_runs_claim(4, 30)");
        expect(firstClaim.rowCount).toBe(4);
        // Ben queues while the first claim is uncommitted: a second claim reading the queue before that commit
        // would rank his run among Ana's still-waiting ones, find it unlocked, and take a fifth slot.
        await queue(w.published, w.ben, { state: { queued_at: at(10) } });
        const secondPid = (await second.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
        let settled = false;
        const secondClaim = second.query("select run_id from test_runs_claim(4, 30)").finally(() => {
          settled = true;
        });
        // Until the second claim waits on the advisory lock, or has already finished without it (a condition,
        // not a time).
        for (;;) {
          if (settled) break;
          const { rows } = await sql<{ waiting: number }>`
            select count(*)::int as waiting from pg_locks
             where pid = ${secondPid} and locktype = 'advisory' and not granted
          `.execute(ownerDb);
          if (rows[0]!.waiting > 0) break;
        }
        await first.query("commit");
        expect((await secondClaim).rowCount).toBe(0);
        await second.query("commit");
      } finally {
        await first.end();
        await second.end();
      }
      const running = await ownerDb.selectFrom("test_runs").select("id").where("status", "=", "running").execute();
      expect(running).toHaveLength(4);
    });

    it("fails, rather than runs, a waiting run whose configuration or organization is deleted (configuration_deleted), and keeps it", async () => {
      const w = await world();
      const deletedConfiguration = await queue(w.draft, w.ana, { state: { queued_at: at(0) } });
      const deletedOrganization = await queue(w.inB, w.cara, { state: { queued_at: at(1) } });
      const live = await queue(w.published, w.ben, { state: { queued_at: at(2) } });
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", w.draft.configurationId).execute();
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", w.b).execute();

      expect((await claim(4)).map((run) => run.run_id)).toEqual([live.id]);
      for (const run of [deletedConfiguration, deletedOrganization]) {
        expect(await runRow(run.id)).toMatchObject({
          status: "failed",
          started_at: null,
          finished_at: expect.any(Date),
          error_code: "configuration_deleted",
          error_message: "The configuration was deleted before the run started.",
        });
      }
    });

    it("finishes a running run only with its lease, once, storing its results; and refuses results naming another column", async () => {
      const w = await world();
      await queue(w.published, w.ana, { state: { queued_at: at(0) } });
      await queue(w.published, w.ben, { state: { queued_at: at(1) } });
      const [first, second] = await claim(2);
      const results = {
        strategy: "otlp",
        kwok_enabled: false,
        mutated_yaml: "receivers: {}\n",
        mutations: [{ id: "R-001", severity: "info", message: "m", details: {} }],
        compatibility: [],
        logs: "[replay] 1 of 1 sent",
        timings: { totalMs: 1200 },
        output_size_bytes: 42,
        output_truncated: false,
        decoded_input_size_bytes: 40,
        decoded_input_truncated: false,
      };
      const before = await runRow(first!.run_id);
      expect(await finish(first!.run_id, randomUUID(), "succeeded", results)).toBe(false);
      expect(await runRow(first!.run_id)).toEqual(before);
      expect(await finish(first!.run_id, first!.lease_id, "succeeded", results)).toBe(true);
      expect(await runRow(first!.run_id)).toMatchObject({
        ...results,
        status: "succeeded",
        lease_id: null,
        lease_expires_at: null,
        finished_at: expect.any(Date),
        error_code: null,
      });
      expect(await finish(first!.run_id, first!.lease_id, "failed")).toBe(false);

      await expect(finish(second!.run_id, second!.lease_id, "succeeded", { output: "x" })).rejects.toMatchObject({
        code: "22023",
      });
      expect(
        await finish(second!.run_id, second!.lease_id, "failed", {
          error_code: "collector_failed",
          error_message: "The collector didn't start.",
          mutations: null,
        }),
      ).toBe(true);
      expect(await runRow(second!.run_id)).toMatchObject({
        status: "failed",
        error_code: "collector_failed",
        error_message: "The collector didn't start.",
        mutations: null,
        output_size_bytes: null,
      });
    });

    it("releases a running run only with its lease, back to the queue with its queued time, and claims it first again", async () => {
      const w = await world();
      const older = await queue(w.published, w.ana, { state: { queued_at: at(0) } });
      await queue(w.published, w.ana, { state: { queued_at: at(1) } });
      const [claimed] = await claim(1);
      expect(claimed!.run_id).toBe(older.id);
      expect(await release(older.id, randomUUID())).toBe(false);
      expect(await release(older.id, claimed!.lease_id)).toBe(true);
      expect(await runRow(older.id)).toEqual(older);
      expect(await release(older.id, claimed!.lease_id)).toBe(false);
      expect((await claim(1)).map((run) => run.run_id)).toEqual([older.id]);
    });

    it("reaps the running runs past their lease, on the database's clock, with interrupted and the message, and leaves the others", async () => {
      const w = await world();
      const expired = await queue(w.published, w.ana, {
        state: { queued_at: at(0), status: "running", started_at: at(1), lease_id: randomUUID(), lease_expires_at: at(60) },
      });
      const live = await queue(w.published, w.ben, {
        state: {
          queued_at: at(0),
          status: "running",
          started_at: at(1),
          lease_id: randomUUID(),
          lease_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const waiting = await queue(w.inB, w.cara, { state: { queued_at: at(0) } });

      expect(await reap()).toEqual([expired.id]);
      expect(await runRow(expired.id)).toMatchObject({
        status: "failed",
        lease_id: null,
        lease_expires_at: null,
        finished_at: expect.any(Date),
        error_code: "interrupted",
        error_message: INTERRUPTED,
      });
      expect(await runRow(live.id)).toEqual(live);
      expect(await runRow(waiting.id)).toEqual(waiting);
      expect(await reap()).toEqual([]);
      await expect(reap(" ")).rejects.toMatchObject({ code: "22023" });
    });

    it("fails the waiting runs, in every organization, only once the tester has been down longer than the limit; never a running run", async () => {
      const w = await world();
      const waitingInA = await queue(w.published, w.ana, { state: { queued_at: at(0) } });
      const waitingInB = await queue(w.inB, w.cara, { state: { queued_at: at(1) } });
      const running = await queue(w.published, w.ben, {
        state: { queued_at: at(0), status: "running", started_at: at(1), lease_id: randomUUID(), lease_expires_at: at(500) },
      });

      // Up: nothing.
      expect(await failWaiting("1 second")).toEqual([]);
      // Down since just now: not yet past ten minutes.
      expect(await mark(false)).toEqual(expect.any(Date));
      expect(await failWaiting("600 seconds")).toEqual([]);
      expect((await runRow(waitingInA.id))!.status).toBe("queued");
      // Down for eleven minutes (moved back as the owner, as no clock is waited on).
      await sql`update otelcol_testing_state set down_since = now() - interval '11 minutes'`.execute(ownerDb);
      expect((await failWaiting("600 seconds")).sort()).toEqual([waitingInA.id, waitingInB.id].sort());
      for (const run of [waitingInA, waitingInB]) {
        expect(await runRow(run.id)).toMatchObject({
          status: "failed",
          started_at: null,
          error_code: "testing_unavailable",
          error_message: UNAVAILABLE,
        });
      }
      expect(await runRow(running.id)).toEqual(running);
    });

    it("marks the tester down at the first time it was counted down, keeps that time, and clears it when up", async () => {
      const first = await mark(false);
      expect(first).toEqual(expect.any(Date));
      expect(await mark(false)).toEqual(first);
      expect(await ownerDb.selectFrom("otelcol_testing_state").selectAll().execute()).toEqual([
        { id: true, down_since: first },
      ]);
      expect(await mark(true)).toBeNull();
      expect(await mark(true)).toBeNull();
    });
  });

  describe("the dispatcher's times: the clock after its locks, never the transaction's start (D14a Ruling 22)", () => {
    /**
     * A dispatcher's transaction on its own connection, begun now and left
     * open while other sessions commit, with its start (now()) as text, so
     * comparisons keep Postgres's microseconds.
     */
    const beginDispatcher = async (isolation = "read committed") => {
      const client = new pg.Client({ connectionString: process.env.TELFLO_DATABASE_URL });
      await client.connect();
      await client.query(`begin isolation level ${isolation}`);
      await client.query("select set_config('telflo.dispatcher', 'on', true)");
      const { rows } = await client.query<{ began: string }>("select now()::text as began");
      return { client, began: rows[0]!.began };
    };
    /** Runs `work` with a dispatcher's transaction begun first, then ends its connection. */
    const withOpenDispatcher = async <Result>(
      work: (dispatcher: Awaited<ReturnType<typeof beginDispatcher>>) => Promise<Result>,
      isolation?: string,
    ) => {
      const dispatcher = await beginDispatcher(isolation);
      try {
        return await work(dispatcher);
      } finally {
        await dispatcher.client.end();
      }
    };
    /** Whether `column` of the run is later than `began` (the precondition: the run came after the transaction). */
    const laterThan = async (id: string, column: "queued_at" | "started_at", began: string) =>
      (
        await sql<{ later: boolean }>`
          select ${sql.ref(column)} > ${began}::timestamptz as later from test_runs where id = ${id}
        `.execute(ownerDb)
      ).rows[0]!.later;
    /** The run's times compared in the database: started after queued, finished after both. */
    const ordered = async (id: string) =>
      (
        await sql<{ started: boolean | null; finished: boolean | null }>`
          select started_at >= queued_at as started,
                 finished_at >= coalesce(started_at, queued_at) as finished
            from test_runs where id = ${id}
        `.execute(ownerDb)
      ).rows[0]!;

    it("claims a run queued and committed after the claim's transaction began, and starts it after it was queued", async () => {
      const w = await world();
      await withOpenDispatcher(async (dispatcher) => {
        const run = await queue(w.published, w.ana);
        expect(await laterThan(run.id, "queued_at", dispatcher.began)).toBe(true);

        const claimed = await dispatcher.client.query<{ run_id: string }>("select run_id from test_runs_claim(4, 30)");
        expect(claimed.rows.map((row) => row.run_id)).toEqual([run.id]);
        await dispatcher.client.query("commit");

        expect(await ordered(run.id)).toEqual({ started: true, finished: null });
        const row = (await runRow(run.id))!;
        expect(row.lease_expires_at!.getTime() - row.started_at!.getTime()).toBe((5 + 30) * 1000);
      });
    });

    it("fails a run on a deleted configuration, queued after the claim's transaction began, finished after it was queued", async () => {
      const w = await world();
      await withOpenDispatcher(async (dispatcher) => {
        const run = await queue(w.draft, w.ana);
        await ownerDb
          .updateTable("configurations")
          .set({ deleted_at: new Date() })
          .where("id", "=", w.draft.configurationId)
          .execute();
        expect(await laterThan(run.id, "queued_at", dispatcher.began)).toBe(true);

        expect((await dispatcher.client.query("select run_id from test_runs_claim(4, 30)")).rows).toEqual([]);
        await dispatcher.client.query("commit");

        expect(await runRow(run.id)).toMatchObject({ status: "failed", error_code: "configuration_deleted" });
        expect(await ordered(run.id)).toEqual({ started: null, finished: true });
      });
    });

    it("fails a waiting run queued after fail_waiting's transaction began, finished after it was queued", async () => {
      const w = await world();
      await sql`update otelcol_testing_state set down_since = now() - interval '11 minutes'`.execute(ownerDb);
      await withOpenDispatcher(async (dispatcher) => {
        const run = await queue(w.published, w.ana);
        expect(await laterThan(run.id, "queued_at", dispatcher.began)).toBe(true);

        const failed = await dispatcher.client.query<{ id: string }>(
          `select id from test_runs_fail_waiting('600 seconds', $1) as id`,
          [UNAVAILABLE],
        );
        expect(failed.rows.map((row) => row.id)).toEqual([run.id]);
        await dispatcher.client.query("commit");

        expect(await runRow(run.id)).toMatchObject({ status: "failed", error_code: "testing_unavailable" });
        expect(await ordered(run.id)).toEqual({ started: null, finished: true });
      });
    });

    it("finishes a run claimed after the finish's transaction began, finished after it started", async () => {
      const w = await world();
      await queue(w.published, w.ana, { state: { queued_at: at(0) } });
      await withOpenDispatcher(async (dispatcher) => {
        const [claimed] = await claim(1);
        expect(await laterThan(claimed!.run_id, "started_at", dispatcher.began)).toBe(true);

        const finished = await dispatcher.client.query<{ done: boolean }>(
          "select test_runs_finish($1::uuid, $2::uuid, 'succeeded', '{}'::jsonb) as done",
          [claimed!.run_id, claimed!.lease_id],
        );
        expect(finished.rows[0]!.done).toBe(true);
        await dispatcher.client.query("commit");

        expect(await ordered(claimed!.run_id)).toEqual({ started: true, finished: true });
      });
    });

    it("reaps a run claimed after the reaper's transaction began, once its lease is past, finished after it started", async () => {
      const w = await world();
      await queue(w.published, w.ana, { duration_seconds: 1, state: { queued_at: at(0) } });
      await withOpenDispatcher(async (dispatcher) => {
        // The shortest lease there is: one second, no overhead.
        const [claimed] = await claim(1, 0);
        expect(await laterThan(claimed!.run_id, "started_at", dispatcher.began)).toBe(true);
        // Until the database's clock is past the lease (a condition; the lease can't be shorter than a second).
        for (;;) {
          const { rows } = await sql<{ past: boolean }>`
            select clock_timestamp() > lease_expires_at as past from test_runs where id = ${claimed!.run_id}
          `.execute(ownerDb);
          if (rows[0]!.past) break;
          await sql`select pg_sleep(0.05)`.execute(ownerDb);
        }

        const reaped = await dispatcher.client.query<{ id: string }>("select id from test_runs_reap($1) as id", [
          INTERRUPTED,
        ]);
        expect(reaped.rows.map((row) => row.id)).toEqual([claimed!.run_id]);
        await dispatcher.client.query("commit");

        expect(await runRow(claimed!.run_id)).toMatchObject({ status: "failed", error_code: "interrupted" });
        expect(await ordered(claimed!.run_id)).toEqual({ started: true, finished: true });
      });
    });

    it("refuses to claim (25000) under REPEATABLE READ or SERIALIZABLE, whose one snapshot would miscount the running runs, and claims nothing", async () => {
      const w = await world();
      const run = await queue(w.published, w.ana, { state: { queued_at: at(0) } });
      for (const isolation of ["repeatable read", "serializable"]) {
        await withOpenDispatcher(async (dispatcher) => {
          await expect(dispatcher.client.query("select run_id from test_runs_claim(4, 30)"), isolation).rejects.toMatchObject({
            code: "25000",
            message: "the claim runs only under read committed",
          });
          await dispatcher.client.query("rollback");
        }, isolation);
      }
      expect(await runRow(run.id)).toEqual(run);
      expect((await claim(4)).map((claimed) => claimed.run_id)).toEqual([run.id]);
    });

    it("refuses to fail waiting runs (22023) for a zero or negative interval, and fails none", async () => {
      const w = await world();
      const run = await queue(w.published, w.ana, { state: { queued_at: at(0) } });
      await sql`update otelcol_testing_state set down_since = now() - interval '11 minutes'`.execute(ownerDb);
      for (const downFor of ["0 seconds", "-1 minute", "1 mon -40 days"]) {
        await expect(failWaiting(downFor), downFor).rejects.toMatchObject({ code: "22023" });
      }
      expect(await runRow(run.id)).toEqual(run);
    });
  });

  describe("the members' functions", () => {
    it("answers n ahead only for waiting runs the context's user can see in the context's organization", async () => {
      const w = await world();
      const draftRun = await queue(w.draft, w.ana, { state: { queued_at: at(0) } });
      const publishedRun = await queue(w.published, w.ana, { state: { queued_at: at(1) } });
      const bRun = await queue(w.inB, w.cara, { state: { queued_at: at(2) } });
      const finished = await queue(w.published, w.ben, {
        state: { queued_at: at(0), status: "failed", finished_at: at(1) },
      });
      const ids = [draftRun.id, publishedRun.id, bRun.id, finished.id, randomUUID()];

      // The queue: the draft's run (Ana's turn 0), Cara's (her turn 0, queued later), the published one (Ana's turn 1).
      expect(await ahead({ userId: w.ana, organizationId: w.a }, ids)).toEqual({ [draftRun.id]: 0, [publishedRun.id]: 2 });
      // Ben: not Ana's draft's run; the published configuration's, counting the two ahead of it.
      expect(await ahead({ userId: w.ben, organizationId: w.a }, ids)).toEqual({ [publishedRun.id]: 2 });
      expect(await ahead({ userId: w.cara, organizationId: w.b }, ids)).toEqual({ [bRun.id]: 1 });
      // A context naming no organization, or none at all, gets nothing.
      expect(await ahead({ userId: w.ana }, ids)).toEqual({});
      expect(await ahead({}, ids)).toEqual({});
    });

    it("counts the context's user's waiting runs in the context's organization only (migration 1700000000029, D14b Preflight ruling 21), and nothing else", async () => {
      const w = await world();
      const personal = await ownerDb
        .selectFrom("organizations")
        .select("id")
        .where("owner_user_id", "=", w.ana)
        .executeTakeFirstOrThrow();
      const inPersonal = await addConfiguration(ownerDb, { organizationId: personal.id, created_by_user_id: w.ana });
      const inPersonalVersion = await addConfigurationVersion(ownerDb, {
        configurationId: inPersonal.id,
        organizationId: personal.id,
      });
      await queue(w.published, w.ana);
      await queue(w.draft, w.ana);
      await queue(
        { organizationId: personal.id, configurationId: inPersonal.id, versionId: inPersonalVersion.id },
        w.ana,
      );
      await queue(w.published, w.ana, {
        state: { queued_at: at(0), status: "running", started_at: at(1), lease_id: randomUUID(), lease_expires_at: at(9) },
      });
      await queue(w.published, w.ana, { state: { queued_at: at(0), status: "failed", finished_at: at(1) } });
      await queue(w.published, w.ben);

      // Ana's two in A and her one in her personal organization count apart: the cap is per person, per organization.
      expect(await waitingForContextUser({ userId: w.ana, organizationId: w.a })).toBe(2);
      expect(await waitingForContextUser({ userId: w.ana, organizationId: personal.id })).toBe(1);
      expect(await waitingForContextUser({ userId: w.ana, organizationId: w.b })).toBe(0);
      expect(await waitingForContextUser({ userId: w.ben, organizationId: w.a })).toBe(1);
      expect(await waitingForContextUser({ userId: w.cara, organizationId: w.b })).toBe(0);
      expect(await waitingForContextUser({ organizationId: w.a })).toBe(0);
      expect(await waitingForContextUser({ userId: w.ana })).toBe(0);
    });
  });
});
