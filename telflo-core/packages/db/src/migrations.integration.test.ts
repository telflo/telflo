import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { CollectorCatalogueError, readCollectorCatalogueFiles } from "./collector-catalogue/catalogue.js";
import { runMigrationStep } from "./migrations.js";
import { createDb, createPool } from "./pool.js";
import type { Database } from "./schema.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import { openTestDatabases, type TestDatabases } from "./testing.js";

/*
 * The migration step (`npm run db:migrate`, migrate, prepareTestDatabase)
 * validates the collector catalogue before it touches the database, on a
 * throwaway database that is never migrated: a fixture catalogue, never the
 * committed one, is refused.
 */

/** Creating and dropping a database waits for a checkpoint. */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

describe("the migration step", () => {
  let databases: TestDatabases;
  let throwawayName: string;
  let throwawayUrl: string;
  let throwaway: Kysely<Database> | undefined;

  beforeAll(async () => {
    databases = openTestDatabases();
    throwawayName = `telflo_migration_step_${randomUUID().replaceAll("-", "")}_test`;
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = `/${throwawayName}`;
    throwawayUrl = url.toString();
    await sql`create database ${sql.id(throwawayName)}`.execute(databases.ownerDb);
  }, THROWAWAY_DATABASE_TIMEOUT);

  afterAll(async () => {
    await throwaway?.destroy();
    await sql`drop database if exists ${sql.id(throwawayName)}`.execute(databases.ownerDb);
    await databases.destroy();
  }, THROWAWAY_DATABASE_DROP_TIMEOUT);

  it("refuses an invalid catalogue before it migrates: the database is left as it was, with no table at all", async () => {
    const [committed] = await readCollectorCatalogueFiles();
    const content = structuredClone(committed!.content) as { versions: Array<{ releasedAt: string }> };
    content.versions[0]!.releasedAt = "2026-02-30";
    const invalid = [{ name: committed!.name, content }];
    // The API's login role is the test run's own: a refused step never reaches provisioning.
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = `/${throwawayName}`;

    const step = runMigrationStep(
      { migrationDatabaseUrl: throwawayUrl, applicationDatabaseUrl: applicationUrl.toString() },
      invalid,
    );
    await expect(step).rejects.toThrow(CollectorCatalogueError);
    await expect(step).rejects.toThrow(/is not a real YYYY-MM-DD date/);

    throwaway = createDb(createPool(throwawayUrl));
    const tables = await sql<{ name: string }>`
      select table_name as name from information_schema.tables where table_schema = 'platform'
    `.execute(throwaway);
    expect(tables.rows).toEqual([]);
  });
});
