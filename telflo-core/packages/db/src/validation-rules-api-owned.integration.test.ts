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
  addValidationPipeline,
  addValidationRule,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "./testing.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import { PLATFORM_CONNECTION_OPTIONS, PLATFORM_MIGRATION_OPTIONS } from "./database-schema.js";

/*
 * Migration 1700000000039: validation_rules.is_api_owned, the mark of a rule
 * the public API's PUT wrote, which its next PUT replaces. Its own file: up,
 * down and up again on a throwaway database over existing rows; the column as
 * the latest schema has it; and the identity trigger leaving it out, so a
 * person's edit of a rule (the API's role, in the person's context, as the
 * Validation tab's PATCH writes) keeps the mark as it is.
 */

/** Migrations 1700000000000 to 1700000000038: the runner counts from _000. */
const THROUGH_038 = 39;

describe("validation_rules.is_api_owned (migration 1700000000039)", () => {
  let databases: TestDatabases;
  /** The API's own role, which row-level security and the trigger constrain. */
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

  /** A person's draft configuration in a group organization, its version 1, a logs pipeline on it. */
  const draftWithPipeline = async (target: Kysely<Database>) => {
    const person = (await createUserWithOrganization(target)).user.id;
    const { organization } = await addMembership(target, { userId: person });
    const configuration = await addConfiguration(target, { organizationId: organization.id, created_by_user_id: person });
    const version = await addConfigurationVersion(target, {
      configurationId: configuration.id,
      organizationId: organization.id,
      created_by_user_id: person,
    });
    const pipeline = await addValidationPipeline(target, {
      organizationId: organization.id,
      configurationId: configuration.id,
      configurationVersionId: version.id,
      created_by_user_id: person,
    });
    const ids = {
      organizationId: organization.id,
      configurationId: configuration.id,
      configurationVersionId: version.id,
      validationPipelineId: pipeline.id,
    };
    return { person, ids };
  };

  /** Runs `work` as the API's role in the person's context, set as context.ts sets it, in one transaction. */
  const asPerson = <Result>(
    context: { userId: string; organizationId: string },
    work: (transaction: Transaction<Database>) => Promise<Result>,
  ) =>
    db.transaction().execute(async (transaction) => {
      await sql`
        select set_config('telflo.user_id', ${context.userId}, true),
               set_config('telflo.organization_id', ${context.organizationId}, true)
      `.execute(transaction);
      return work(transaction);
    });

  const isApiOwnedOf = async (ruleId: string) =>
    (await ownerDb.selectFrom("validation_rules").select("is_api_owned").where("id", "=", ruleId).executeTakeFirstOrThrow())
      .is_api_owned;

  describe("on the latest schema", () => {
    it("is false unless the insert sets it, and refuses null", async () => {
      const { person, ids } = await draftWithPipeline(ownerDb);
      const plain = await addValidationRule(ownerDb, { ...ids, created_by_user_id: person });
      const owned = await addValidationRule(ownerDb, { ...ids, position: 2, created_by_user_id: person, is_api_owned: true });
      expect(plain.is_api_owned).toBe(false);
      expect(owned.is_api_owned).toBe(true);
      await expect(
        sql`update validation_rules set is_api_owned = null where id = ${plain.id}`.execute(ownerDb),
      ).rejects.toMatchObject({ code: "23502" });
    });

    it("keeps the mark through a person's edit of the rule's name, description and pattern, as the API's role", async () => {
      const { person, ids } = await draftWithPipeline(ownerDb);
      const owned = await addValidationRule(ownerDb, { ...ids, created_by_user_id: person, is_api_owned: true });
      const plain = await addValidationRule(ownerDb, { ...ids, position: 2, created_by_user_id: person });
      const context = { userId: person, organizationId: ids.organizationId };
      for (const rule of [owned, plain]) {
        const updated = await asPerson(context, (transaction) =>
          transaction
            .updateTable("validation_rules")
            .set({ name: "renamed", description: "redescribed", pattern: `edited-${randomUUID()}`, updated_at: new Date() })
            .where("id", "=", rule.id)
            .returning(["id"])
            .execute(),
        );
        expect(updated).toEqual([{ id: rule.id }]);
      }
      expect(await isApiOwnedOf(owned.id)).toBe(true);
      expect(await isApiOwnedOf(plain.id)).toBe(false);
    });

    it("is left out of the identity trigger: a change of the mark alone passes, as the API's role", async () => {
      const { person, ids } = await draftWithPipeline(ownerDb);
      const rule = await addValidationRule(ownerDb, { ...ids, created_by_user_id: person, is_api_owned: true });
      const context = { userId: person, organizationId: ids.organizationId };
      await asPerson(context, (transaction) =>
        transaction.updateTable("validation_rules").set({ is_api_owned: false }).where("id", "=", rule.id).execute(),
      );
      expect(await isApiOwnedOf(rule.id)).toBe(false);
      // The trigger still guards what it names: a rule keeps its place.
      await expect(
        asPerson(context, (transaction) =>
          transaction.updateTable("validation_rules").set({ position: 9 } as never).where("id", "=", rule.id).execute(),
        ),
      ).rejects.toMatchObject({ code: "P0001" });
    });
  });

  describe("up, down and up again over existing rows", () => {
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
      const throwawayName = `telflo_api_owned_${randomUUID().replaceAll("-", "")}_test`;
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

    it(
      "adds the column, commented, false on every existing rule; down drops it and keeps the rules; up again adds it back",
      async () => {
        await withThrowawayDatabase(async ({ throwaway, migrate, migrateDown }) => {
          /** validation_rules' columns, their types, defaults, nullability and comments. */
          const columns = async () =>
            (
              await sql<{ name: string; type: string; nullable: string; preset: string | null; comment: string | null }>`
                select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
                       case when a.attnotnull then 'no' else 'yes' end as nullable,
                       pg_get_expr(d.adbin, d.adrelid) as preset,
                       col_description(a.attrelid, a.attnum) as comment
                  from pg_attribute a
                  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                 where a.attrelid = 'validation_rules'::regclass and a.attnum > 0 and not a.attisdropped
                 order by a.attnum`.execute(throwaway)
            ).rows;
          /** The trigger's function, which 039 leaves as 030 made it. */
          const triggerFunction = async () =>
            (
              await sql<{ definition: string }>`
                select pg_get_functiondef('refuse_validation_rule_identity_change'::regproc) as definition`.execute(throwaway)
            ).rows[0]?.definition;
          /** Every rule's columns but the mark, by id. */
          const rules = async () =>
            (await sql<Record<string, unknown>>`select * from validation_rules order by id`.execute(throwaway)).rows.map(
              ({ is_api_owned: _mark, ...rest }) => rest,
            );

          await migrate(THROUGH_038);
          const columnsBefore = await columns();
          const triggerBefore = await triggerFunction();
          expect(columnsBefore.some((column) => column.name === "is_api_owned")).toBe(false);
          const { person, ids } = await draftWithPipeline(throwaway);
          // Inserted as 038's table has it: no is_api_owned column.
          for (const position of [1, 2]) {
            await sql`
              insert into validation_rules
                (organization_id, configuration_id, configuration_version_id, validation_pipeline_id, position,
                 kind, target, pattern, created_by_user_id, created_at, updated_at)
              values (${ids.organizationId}, ${ids.configurationId}, ${ids.configurationVersionId},
                      ${ids.validationPipelineId}, ${position}, 'contains_text', 'output', ${`pattern-${position}`},
                      ${person}, now(), now())`.execute(throwaway);
          }
          const rulesBefore = await rules();
          expect(rulesBefore).toHaveLength(2);

          await migrate(1);
          const columnsAfter = await columns();
          const added = columnsAfter.filter((column) => !columnsBefore.some((before) => before.name === column.name));
          expect(added.map(({ comment: _comment, ...column }) => column)).toEqual([
            { name: "is_api_owned", type: "boolean", nullable: "no", preset: "false" },
          ]);
          expect(added[0]?.comment).toMatch(/public API/);
          expect(columnsAfter.filter((column) => column.name !== "is_api_owned")).toEqual(columnsBefore);
          expect(await triggerFunction()).toBe(triggerBefore);
          expect(await rules()).toEqual(rulesBefore);
          const marks = await sql<{ is_api_owned: boolean }>`select is_api_owned from validation_rules`.execute(throwaway);
          expect(marks.rows.map((row) => row.is_api_owned)).toEqual([false, false]);
          await sql`update validation_rules set is_api_owned = true where position = 2`.execute(throwaway);

          await migrateDown(1);
          expect(await columns()).toEqual(columnsBefore);
          expect(await rules()).toEqual(rulesBefore);

          await migrate(1);
          expect(await columns()).toEqual(columnsAfter);
          expect(await rules()).toEqual(rulesBefore);
          const again = await sql<{ is_api_owned: boolean }>`select is_api_owned from validation_rules`.execute(throwaway);
          expect(again.rows.map((row) => row.is_api_owned)).toEqual([false, false]);
        });
      },
      THROWAWAY_DATABASE_DROP_TIMEOUT,
    );
  });
});
