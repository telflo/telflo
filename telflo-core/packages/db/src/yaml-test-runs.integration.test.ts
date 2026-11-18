import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { createDb, createPool } from "./pool.js";
import type { Database } from "./schema.js";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  addTestRun,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type AddTestRunInput,
  type TestDatabases,
} from "./testing.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import { PLATFORM_CONNECTION_OPTIONS, PLATFORM_MIGRATION_OPTIONS } from "./database-schema.js";

/*
 * Migration 1700000000040 (D25 decision 39, Q168; Preflight ruling 12): test
 * runs of a YAML with no configuration. Its own file (Preflight ruling 26):
 * on the latest schema, the together check, the select and insert policies
 * (a YAML run is its creator's alone, in its organization; the insert keeps
 * migration 028's other conditions) and the replaced claim (a waiting YAML
 * run of a deleted organization fails `organization_deleted` and is never
 * claimed; a live one is claimed); then up, down and up again on a
 * throwaway database: down restores migration 028's columns, check-less
 * table, policies, claim and comments exactly, deleting the YAML runs.
 *
 * The database context is set with set_config, as context.ts sets it, and
 * as test-runs.integration.test.ts does: these tests are the database's own.
 */

/** Migrations 1700000000000 to 1700000000039: the runner counts from _000. */
const THROUGH_039 = 40;

/** The claim's failure of a deleted organization's waiting YAML runs, as migration 040 inserts it in 028's source. */
const YAML_RUNS_FAILURE = `
      -- A waiting YAML run (no configuration: the join above never sees it)
      -- of a deleted organization fails here too, rather than runs (D25
      -- Preflight ruling 12). Its files stay.
      update platform.test_runs t
         set status = 'failed',
             finished_at = moment,
             error_code = 'organization_deleted',
             error_message = 'The organization was deleted before the run started.'
        from platform.organizations o
       where t.status = 'queued'
         and t.queued_at <= moment
         and t.configuration_id is null
         and o.id = t.organization_id
         and o.deleted_at is not null;`;

/** A fixed time in the past, which every chosen queued time counts from. */
const T0 = new Date("2026-01-01T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

/** Whom a transaction acts as: a member (a user, an organization), the dispatcher, or nobody. */
interface Context {
  userId?: string;
  organizationId?: string;
  dispatcher?: boolean;
}

describe("YAML test runs (migration 1700000000040)", () => {
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

  /** The runs test_runs_claim marks running, by id. */
  const claim = async (slots: number) =>
    (
      await inContext({ dispatcher: true }, (transaction) =>
        sql<{ run_id: string }>`select run_id from test_runs_claim(${slots}::integer, 30)`.execute(transaction),
      )
    ).rows.map((row) => row.run_id);

  const runRow = (id: string) => ownerDb.selectFrom("test_runs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  /** The run ids `context` can select. */
  const visibleIds = (context: Context) =>
    inContext(context, async (transaction) =>
      (await sql<{ id: string }>`select id from test_runs order by id`.execute(transaction)).rows.map((row) => row.id),
    );

  /**
   * Group organization A: Ana, a contributor, who queues YAML runs, and Ben,
   * an admin. Ana is also in group organization B. Each keeps a personal
   * organization.
   */
  const world = async () => {
    const person = async () => (await createUserWithOrganization(ownerDb)).user.id;
    const ana = await person();
    const ben = await person();
    const { organization: a } = await addMembership(ownerDb, { userId: ben, role: "admin" });
    await addMembership(ownerDb, { userId: ana, organizationId: a.id, role: "contributor" });
    const { organization: b } = await addMembership(ownerDb, { userId: ana, role: "contributor" });
    return { ana, ben, a: a.id, b: b.id };
  };

  /** A YAML run (no configuration) of `userId` in `organizationId`, as the owner inserts it. */
  const yamlRun = (
    organizationId: string,
    userId: string | null,
    overrides: Partial<Omit<AddTestRunInput, "organizationId" | "configurationId" | "configurationVersionId">> = {},
  ) => addTestRun(ownerDb, { organizationId, configurationId: null, configurationVersionId: null, queuedByUserId: userId, ...overrides });

  /** A YAML run's columns, as the API's role inserts one in a member's context (queued_at and status left to the table). */
  const yamlRunColumns = async (organizationId: string, queuedByUserId: string) => {
    const pin = await catalogueDefaults(ownerDb);
    return {
      id: randomUUID(),
      organization_id: organizationId,
      configuration_id: null,
      configuration_version_id: null,
      queued_by_user_id: queuedByUserId,
      yaml: "receivers: {}\n",
      target_pipeline: "logs",
      signal: "logs" as const,
      duration_seconds: 5,
      collector_distribution: pin.distribution,
      collector_version: pin.version,
      input_name: "api-sample.json",
      input_size_bytes: 0,
    };
  };

  describe("on the latest schema", () => {
    it("a run names its configuration and its version, or neither (ck_test_runs_configuration_together)", async () => {
      const w = await world();
      const configuration = await addConfiguration(ownerDb, { organizationId: w.a, created_by_user_id: w.ana });
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: w.a,
        created_by_user_id: w.ana,
      });
      const yaml = await yamlRun(w.a, w.ana);
      expect(yaml).toMatchObject({ configuration_id: null, configuration_version_id: null, status: "queued" });
      for (const half of [
        { configurationId: configuration.id, configurationVersionId: null },
        { configurationId: null, configurationVersionId: version.id },
      ]) {
        await expect(
          addTestRun(ownerDb, { organizationId: w.a, queuedByUserId: w.ana, ...half }),
        ).rejects.toMatchObject({ code: "23514", constraint: "ck_test_runs_configuration_together" });
      }
    });

    it("a YAML run is its creator's alone: Ana sees hers in A; Ben, A's admin, doesn't; Ana in B doesn't; nobody without a context does", async () => {
      const w = await world();
      const anasInA = await yamlRun(w.a, w.ana);
      const bensInA = await yamlRun(w.a, w.ben);
      const anasInB = await yamlRun(w.b, w.ana);
      // A YAML run whose creator's account is gone is no one's.
      const orphan = await yamlRun(w.a, null);

      expect(await visibleIds({ userId: w.ana, organizationId: w.a })).toEqual([anasInA.id]);
      expect(await visibleIds({ userId: w.ben, organizationId: w.a })).toEqual([bensInA.id]);
      expect(await visibleIds({ userId: w.ana, organizationId: w.b })).toEqual([anasInB.id]);
      expect(await visibleIds({ organizationId: w.a })).toEqual([]);
      expect(await visibleIds({ userId: w.ana })).toEqual([]);
      expect((await runRow(orphan.id)).queued_by_user_id).toBeNull();
    });

    it("the API's role queues a YAML run only as the context's user, in the context's organization, queued at now(): 42501 otherwise", async () => {
      const w = await world();
      const own = await yamlRunColumns(w.a, w.ana);
      const inserted = await inContext({ userId: w.ana, organizationId: w.a }, (transaction) =>
        transaction.insertInto("test_runs").values(own).returning(["id", "status"]).executeTakeFirstOrThrow(),
      );
      expect(inserted).toEqual({ id: own.id, status: "queued" });

      // Another user's run, by Ben, A's admin.
      await expect(
        inContext({ userId: w.ben, organizationId: w.a }, async (transaction) =>
          transaction.insertInto("test_runs").values(await yamlRunColumns(w.a, w.ana)).execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // Ana's own, in another organization than the context's.
      await expect(
        inContext({ userId: w.ana, organizationId: w.a }, async (transaction) =>
          transaction.insertInto("test_runs").values(await yamlRunColumns(w.b, w.ana)).execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // Migration 028's other conditions hold: no backdating.
      const backdated = await yamlRunColumns(w.a, w.ana);
      await expect(
        inContext({ userId: w.ana, organizationId: w.a }, (transaction) =>
          sql`
            insert into test_runs
              (id, organization_id, queued_by_user_id, yaml, target_pipeline, signal, duration_seconds,
               collector_distribution, collector_version, input_name, input_size_bytes, queued_at)
            values (${backdated.id}::uuid, ${backdated.organization_id}::uuid, ${backdated.queued_by_user_id}::uuid,
                    ${backdated.yaml}, ${backdated.target_pipeline}, ${backdated.signal}, ${backdated.duration_seconds},
                    ${backdated.collector_distribution}, ${backdated.collector_version}, ${backdated.input_name},
                    ${backdated.input_size_bytes}, ${at(0)}::timestamptz)
          `.execute(transaction),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await ownerDb.selectFrom("test_runs").select("id").execute()).toEqual([{ id: own.id }]);
    });

    it("the claim fails a waiting YAML run of a deleted organization (organization_deleted) and never claims it; a live one is claimed", async () => {
      const w = await world();
      const doomed = await yamlRun(w.b, w.ana, { state: { queued_at: at(0) } });
      // A configuration's run in the same deleted organization keeps 028's failure.
      const configuration = await addConfiguration(ownerDb, { organizationId: w.b, created_by_user_id: w.ana });
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId: w.b,
        created_by_user_id: w.ana,
      });
      const versionRun = await addTestRun(ownerDb, {
        organizationId: w.b,
        configurationId: configuration.id,
        configurationVersionId: version.id,
        queuedByUserId: w.ana,
        state: { queued_at: at(1) },
      });
      const live = await yamlRun(w.a, w.ana, { state: { queued_at: at(2) } });
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", w.b).execute();

      expect(await claim(4)).toEqual([live.id]);
      expect(await runRow(live.id)).toMatchObject({ status: "running", lease_id: expect.any(String) });
      expect(await runRow(doomed.id)).toMatchObject({
        status: "failed",
        started_at: null,
        finished_at: expect.any(Date),
        lease_id: null,
        error_code: "organization_deleted",
        error_message: "The organization was deleted before the run started.",
      });
      expect(await runRow(versionRun.id)).toMatchObject({ status: "failed", error_code: "configuration_deleted" });
      // Failed, never claimed later.
      expect(await claim(4)).toEqual([]);
      expect((await runRow(doomed.id)).status).toBe("failed");
    });
  });

  describe("up, down and up again", () => {
    const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

    /** Runs `body` against a freshly created, unmigrated database, dropped afterwards whatever happens (schema.integration.test.ts's harness). */
    async function withThrowawayDatabase(
      body: (context: {
        throwaway: Kysely<Database>;
        migrate: (count: number) => Promise<unknown>;
        migrateDown: (count: number) => Promise<unknown>;
      }) => Promise<void>,
    ): Promise<void> {
      const serverUrl = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
      const throwawayName = `telflo_yaml_runs_${randomUUID().replaceAll("-", "")}_test`;
      const throwawayUrl = new URL(serverUrl);
      throwawayUrl.pathname = `/${throwawayName}`;
      await sql`create database ${sql.id(throwawayName)}`.execute(ownerDb);
      const throwaway = createDb(createPool(throwawayUrl.toString()));
      // One client per run, ended by us: the runner leaves an external client open (schema.integration.test.ts).
      const run = async (direction: "up" | "down", count: number) => {
        const migrationClient = new pg.Client({ connectionString: throwawayUrl.toString(), options: PLATFORM_CONNECTION_OPTIONS });
        await migrationClient.connect();
        try {
          return await runner({
            dbClient: migrationClient,
            dir: migrationsDirectory,
            direction,
            count,
            ...PLATFORM_MIGRATION_OPTIONS,
            log: () => {},
          });
        } finally {
          await migrationClient.end();
        }
      };
      try {
        await body({ throwaway, migrate: (count) => run("up", count), migrateDown: (count) => run("down", count) });
      } finally {
        await throwaway.destroy();
        await sql`drop database if exists ${sql.id(throwawayName)}`.execute(ownerDb);
      }
    }

    /** What migration 040 changes, as the catalogs hold it: columns, constraints, policies and the claim, with their comments and grants. */
    const facts = async (target: Kysely<Database>) => ({
      columns: (
        await sql<{ name: string; notNull: boolean; comment: string | null }>`
          select a.attname as name, a.attnotnull as "notNull", col_description(a.attrelid, a.attnum) as comment
            from pg_attribute a
           where a.attrelid = 'test_runs'::regclass and a.attnum > 0 and not a.attisdropped
           order by a.attnum`.execute(target)
      ).rows,
      constraints: (
        await sql<{ name: string; definition: string; comment: string | null }>`
          select c.conname as name, pg_get_constraintdef(c.oid) as definition,
                 obj_description(c.oid, 'pg_constraint') as comment
            from pg_constraint c
           where c.conrelid = 'test_runs'::regclass
           order by c.conname`.execute(target)
      ).rows,
      policies: (
        await sql<{ name: string; command: string; roles: string; using: string | null; check: string | null; comment: string | null }>`
          select p.polname as name, p.polcmd::text as command, p.polroles::regrole[]::text as roles,
                 pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check,
                 obj_description(p.oid, 'pg_policy') as comment
            from pg_policy p
           where p.polrelid = 'test_runs'::regclass
           order by p.polname`.execute(target)
      ).rows,
      claim: (
        await sql<{ definition: string; comment: string | null; grants: string | null; isDefiner: boolean }>`
          select pg_get_functiondef(p.oid) as definition, obj_description(p.oid, 'pg_proc') as comment,
                 p.proacl::text as grants, p.prosecdef as "isDefiner"
            from pg_proc p
           where p.oid = 'test_runs_claim(integer, integer)'::regprocedure`.execute(target)
      ).rows,
    });

    it(
      "makes both columns nullable with the together check, widens the two policies and replaces the claim; down deletes the YAML runs and restores migration 028's exactly; up again repeats it",
      async () => {
        await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
          await migrate(THROUGH_039);
          const before = await facts(throwaway);
          const ana = (await createUserWithOrganization(throwaway)).user.id;
          const { organization } = await addMembership(throwaway, { userId: ana });
          const configuration = await addConfiguration(throwaway, { organizationId: organization.id, created_by_user_id: ana });
          const version = await addConfigurationVersion(throwaway, {
            configurationId: configuration.id,
            organizationId: organization.id,
            created_by_user_id: ana,
          });
          const versionRun = await addTestRun(throwaway, {
            organizationId: organization.id,
            configurationId: configuration.id,
            configurationVersionId: version.id,
            queuedByUserId: ana,
          });
          // 039's table refuses a YAML run.
          await expect(
            addTestRun(throwaway, { organizationId: organization.id, configurationId: null, configurationVersionId: null, queuedByUserId: ana }),
          ).rejects.toMatchObject({ code: "23502" });

          await migrate(1);
          const after = await facts(throwaway);
          const column = (name: string) => after.columns.find((each) => each.name === name);
          expect(column("configuration_id")).toMatchObject({ notNull: false, comment: expect.stringContaining("YAML run") });
          expect(column("configuration_version_id")).toMatchObject({ notNull: false, comment: expect.stringContaining("YAML run") });
          expect(column("organization_id")).toMatchObject({ notNull: true, comment: expect.stringContaining("for a YAML run") });
          // Every other column as it was.
          const others = (of: typeof after) =>
            of.columns.filter((each) => !["organization_id", "configuration_id", "configuration_version_id"].includes(each.name));
          expect(others(after)).toEqual(others(before));
          // Postgres 18 names a column's NOT NULL in pg_constraint: the two go, nothing else changes.
          const notNulls = ["test_runs_configuration_id_not_null", "test_runs_configuration_version_id_not_null"];
          expect(before.constraints.filter((each) => notNulls.includes(each.name)).map((each) => each.name)).toEqual(notNulls);
          expect(after.constraints.filter((each) => each.name !== "ck_test_runs_configuration_together")).toEqual(
            before.constraints.filter((each) => !notNulls.includes(each.name)),
          );
          expect(after.constraints.find((each) => each.name === "ck_test_runs_configuration_together")).toMatchObject({
            definition: "CHECK (((configuration_id IS NULL) = (configuration_version_id IS NULL)))",
            comment: expect.stringContaining("YAML run"),
          });
          const policy = (all: typeof after.policies, name: string) => all.find((each) => each.name === name);
          // The update and delete policies are 028's.
          for (const name of ["test_runs_update", "test_runs_delete"]) {
            expect(policy(after.policies, name)).toEqual(policy(before.policies, name));
          }
          for (const name of ["test_runs_select", "test_runs_insert"]) {
            const widened = policy(after.policies, name)!;
            const original = policy(before.policies, name)!;
            expect(widened.roles).toBe(original.roles);
            expect(widened.command).toBe(original.command);
            expect(widened.comment).toContain("D25 decision 39");
            expect(`${widened.using ?? ""}${widened.check ?? ""}`).toContain("configuration_id IS NULL");
          }
          expect(policy(after.policies, "test_runs_insert")!.check).toContain("queued_at = now()");
          const [claimBefore] = before.claim;
          const [claimAfter] = after.claim;
          // 028's source with exactly the YAML runs' failure after the deleted configurations', nothing else.
          const afterDeletedConfigurations = "(c.deleted_at is not null or o.deleted_at is not null);";
          expect(claimBefore!.definition.split(afterDeletedConfigurations)).toHaveLength(2);
          expect(
            claimAfter!.definition ===
              claimBefore!.definition.replace(afterDeletedConfigurations, `${afterDeletedConfigurations}${YAML_RUNS_FAILURE}`),
          ).toBe(true);
          expect(claimAfter!.comment).toContain("organization_deleted");
          expect({ grants: claimAfter!.grants, isDefiner: claimAfter!.isDefiner }).toEqual({
            grants: claimBefore!.grants,
            isDefiner: true,
          });
          const yamlRun = await addTestRun(throwaway, {
            organizationId: organization.id,
            configurationId: null,
            configurationVersionId: null,
            queuedByUserId: ana,
          });
          const versionRunBefore = await throwaway.selectFrom("test_runs").selectAll().where("id", "=", versionRun.id).executeTakeFirstOrThrow();

          await migrateDown(1);
          expect(await facts(throwaway)).toEqual(before);
          expect(await throwaway.selectFrom("test_runs").selectAll().execute()).toEqual([versionRunBefore]);
          expect(yamlRun.id).not.toBe(versionRun.id);

          await migrate(1);
          expect(await facts(throwaway)).toEqual(after);
          expect(await throwaway.selectFrom("test_runs").selectAll().execute()).toEqual([versionRunBefore]);
        });
      },
      THROWAWAY_DATABASE_DROP_TIMEOUT,
    );
  });
});
