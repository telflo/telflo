import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type RawBuilder } from "kysely";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestRun,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext, withDispatcherContext, type DatabaseContext } from "../database/context.js";

/*
 * The test-run functions of migration 1700000000028 from the API's real
 * database contexts, and migration 1700000000030's. The dispatcher's functions
 * (claim, finish, the rules' read, release, reap, fail waiting, the tester's
 * and the evaluator's marks) work across organizations, as the tables' owner,
 * so each refuses (42501) any context but withDispatcherContext's: a member's
 * request, in organization A or B, can't reach them, even after setting the
 * dispatcher's setting itself, and changes nothing. "n ahead" answers a member
 * only for the runs they can see, so it tells organization B nothing of A's
 * queue, and a teammate nothing of another member's draft.
 *
 * The SQL's own behaviour (the turns, the cap, the lease) is
 * packages/db's test-runs.integration.test.ts's.
 */

describe("the test-run functions from the API's database contexts", () => {
  let databases: TestDatabases;
  /** The API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures and reading rows back. */
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

  /**
   * Organization A: Ana, the author of a draft and of a published
   * configuration, and Ben. Organization B: Cara and her published
   * configuration. Waiting runs on each configuration, Ben's running run
   * past its lease, and the tester down for eleven minutes: every
   * dispatcher function, let through, would change something.
   */
  const seed = async () => {
    const person = async () => (await createUserWithOrganization(ownerDb)).user.id;
    const [ana, ben, cara] = [await person(), await person(), await person()];
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
      return { organizationId, configurationId: row.id, configurationVersionId: version.id };
    };
    const draft = await configuration(a.id, ana, false);
    const published = await configuration(a.id, ana, true);
    const inB = await configuration(b.id, cara, true);
    const queuedAt = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, seconds));
    const draftRun = await addTestRun(ownerDb, { ...draft, queuedByUserId: ana, state: { queued_at: queuedAt(0) } });
    const publishedRun = await addTestRun(ownerDb, {
      ...published,
      queuedByUserId: ana,
      state: { queued_at: queuedAt(1) },
    });
    const bRun = await addTestRun(ownerDb, { ...inB, queuedByUserId: cara, state: { queued_at: queuedAt(2) } });
    const leaseId = randomUUID();
    const runningRun = await addTestRun(ownerDb, {
      ...published,
      queuedByUserId: ben,
      validation_rules: JSON.stringify([{ id: randomUUID(), kind: "contains_text", target: "output", pattern: "secret" }]),
      state: {
        queued_at: queuedAt(0),
        status: "running",
        started_at: queuedAt(3),
        lease_id: leaseId,
        lease_expires_at: queuedAt(30),
      },
    });
    await sql`update otelcol_testing_state set down_since = now() - interval '11 minutes'`.execute(ownerDb);
    await sql`update ottl_evaluator_state set down_since = now() - interval '11 minutes'`.execute(ownerDb);
    return {
      inA: { ana: { userId: ana, organizationId: a.id }, ben: { userId: ben, organizationId: a.id } },
      inB: { cara: { userId: cara, organizationId: b.id } },
      draftRun,
      publishedRun,
      bRun,
      runningRun,
      leaseId,
    };
  };
  type Seeded = Awaited<ReturnType<typeof seed>>;

  /** Every dispatcher function, called with arguments under which it would change something. */
  const dispatcherCalls = (seeded: Seeded): Array<[string, RawBuilder<unknown>]> => [
    ["test_runs_claim", sql`select * from test_runs_claim(4, 30)`],
    [
      "test_runs_finish",
      sql`select test_runs_finish(${seeded.runningRun.id}::uuid, ${seeded.leaseId}::uuid, 'succeeded', '{}'::jsonb)`,
    ],
    ["test_runs_rules", sql`select test_runs_rules(${seeded.runningRun.id}::uuid, ${seeded.leaseId}::uuid)`],
    ["test_runs_release", sql`select test_runs_release(${seeded.runningRun.id}::uuid, ${seeded.leaseId}::uuid)`],
    ["test_runs_reap", sql`select * from test_runs_reap('The run was interrupted. Run it again.')`],
    ["test_runs_fail_waiting", sql`select * from test_runs_fail_waiting('600 seconds', 'Testing is unavailable.')`],
    ["otelcol_testing_mark", sql`select otelcol_testing_mark(true)`],
    ["ottl_evaluator_mark", sql`select ottl_evaluator_mark(true)`],
  ];

  /** Every run and the tester's and the evaluator's states, as the owner reads them. */
  const everything = async () => ({
    runs: await ownerDb.selectFrom("test_runs").selectAll().orderBy("id").execute(),
    state: await ownerDb.selectFrom("otelcol_testing_state").selectAll().execute(),
    evaluatorState: await ownerDb.selectFrom("ottl_evaluator_state").selectAll().execute(),
  });

  it("refuses every dispatcher function (42501) from a member's context in organization A or B, even with the dispatcher's setting turned on in it, and changes nothing", async () => {
    const seeded = await seed();
    const before = await everything();
    const members: Array<[string, DatabaseContext]> = [
      ["Ana in A", seeded.inA.ana],
      ["Ben in A", seeded.inA.ben],
      ["Cara in B", seeded.inB.cara],
    ];
    for (const [name, call] of dispatcherCalls(seeded)) {
      for (const [who, context] of members) {
        for (const turnedOn of [false, true]) {
          await expect(
            withDatabaseContext(db, context, async (transaction) => {
              if (turnedOn) await sql`select set_config('telflo.dispatcher', 'on', true)`.execute(transaction);
              await call.execute(transaction);
            }),
            `${name}, ${who}${turnedOn ? ", the setting on" : ""}`,
          ).rejects.toMatchObject({ code: "42501", message: "only the test-run dispatcher may do this" });
        }
      }
    }
    expect(await everything()).toEqual(before);
  });

  it("lets withDispatcherContext reach each of them", async () => {
    const seeded = await seed();
    const reaped = await withDispatcherContext(db, async (transaction) =>
      (
        await sql<{ id: string }>`select id from test_runs_reap('The run was interrupted. Run it again.') as id`.execute(
          transaction,
        )
      ).rows.map((row) => row.id),
    );
    expect(reaped).toEqual([seeded.runningRun.id]);
    for (const [name, call] of dispatcherCalls(seeded)) {
      await expect(
        withDispatcherContext(db, (transaction) => call.execute(transaction)).then(() => "ran"),
        name,
      ).resolves.toBe("ran");
    }
  });

  it("answers n ahead nothing of another organization's runs, nor of another member's draft's", async () => {
    const seeded = await seed();
    const ids = [seeded.draftRun.id, seeded.publishedRun.id, seeded.bRun.id];
    const ahead = (context: DatabaseContext) =>
      withDatabaseContext(db, context, async (transaction) =>
        (
          await sql<{ run_id: string }>`select run_id from test_runs_ahead(${ids}::uuid[])`.execute(transaction)
        ).rows
          .map((row) => row.run_id)
          .sort(),
      );
    expect(await ahead(seeded.inA.ana)).toEqual([seeded.draftRun.id, seeded.publishedRun.id].sort());
    expect(await ahead(seeded.inA.ben)).toEqual([seeded.publishedRun.id]);
    expect(await ahead(seeded.inB.cara)).toEqual([seeded.bRun.id]);
  });

  it("counts only the context's own user's waiting runs, in the context's organization only", async () => {
    const seeded = await seed();
    const waiting = (context: DatabaseContext) =>
      withDatabaseContext(db, context, async (transaction) =>
        (await sql<{ count: number }>`select test_runs_waiting_for_context_user() as count`.execute(transaction))
          .rows[0]!.count,
      );
    expect(await waiting(seeded.inA.ana)).toBe(2);
    expect(await waiting(seeded.inA.ben)).toBe(0);
    expect(await waiting(seeded.inB.cara)).toBe(1);
    // Ana's two runs wait in A: a context naming B counts none of them, nor Cara's.
    expect(await waiting({ userId: seeded.inA.ana.userId, organizationId: seeded.inB.cara.organizationId })).toBe(0);
  });
});
