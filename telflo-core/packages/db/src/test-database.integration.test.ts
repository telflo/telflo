import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb, createPool } from "./pool.js";
import {
  CollectorCatalogueError,
  readCollectorCatalogueFiles,
  validateCollectorCatalogue,
} from "./collector-catalogue/catalogue.js";
import { CollectorCatalogueRemovalError } from "./collector-catalogue/sync.js";
import { databaseName, prepareTestDatabase, TEST_CATALOGUE_FIXTURE_NOTE, THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import { openTestDatabases } from "./testing.js";
import type { TestDatabases } from "./testing.js";

describe("prepareTestDatabase", () => {
  let databases: TestDatabases;

  beforeAll(() => {
    databases = openTestDatabases();
  });

  afterAll(async () => {
    await databases.destroy();
  });

  it("this suite runs against the test database, never the development one, on both connections", async () => {
    for (const [db, variable] of [
      [databases.db, "TELFLO_DATABASE_URL"],
      [databases.ownerDb, "TELFLO_MIGRATION_DATABASE_URL"],
    ] as const) {
      const result = await sql<{ name: string }>`select current_database() as name`.execute(db);
      expect(result.rows[0]?.name).toMatch(/_test$/);
      expect(result.rows[0]?.name).toBe(databaseName(new URL(process.env[variable]!)));
    }
  });

  it("creates a missing database, applies every migration, syncs the committed collector catalogue and provisions the API's role, and is a no-op when run again", async () => {
    const name = `telflo_prepare_${randomUUID().replaceAll("-", "")}_test`;
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = `/${name}`;
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = `/${name}`;
    const migrations = readdirSync(fileURLToPath(new URL("../migrations", import.meta.url)))
      .filter((file) => file.endsWith(".js"))
      .map((file) => file.replace(/\.js$/, ""))
      .sort();

    try {
      await prepareTestDatabase(url.toString(), applicationUrl.toString());
      await prepareTestDatabase(url.toString(), applicationUrl.toString());

      const prepared = createDb(createPool(url.toString()));
      const asApplication = createDb(createPool(applicationUrl.toString()));
      try {
        const applied = await sql<{ name: string }>`select name from pgmigrations order by id`.execute(prepared);
        expect(applied.rows.map((row) => row.name)).toEqual(migrations);
        const users = await sql<{ count: number }>`select count(*)::int as count from users`.execute(asApplication);
        expect(users.rows[0]?.count).toBe(0);
        // The committed catalogue, every version of it, readable by the API's role (D13a Preflight ruling 9).
        const catalogue = validateCollectorCatalogue(await readCollectorCatalogueFiles());
        const versions = await asApplication
          .selectFrom("collector_versions")
          .select(["distribution", "version"])
          .orderBy("distribution")
          .orderBy("version")
          .execute();
        expect(versions).toEqual(
          catalogue
            .flatMap((distribution) => distribution.versions)
            .map((entry) => ({ distribution: entry.distribution, version: entry.version }))
            .sort((a, b) => a.distribution.localeCompare(b.distribution) || a.version.localeCompare(b.version)),
        );
      } finally {
        await prepared.destroy();
        await asApplication.destroy();
      }
    } finally {
      await sql`drop database if exists ${sql.id(name)}`.execute(databases.ownerDb);
    }
    // `drop database` waits for a checkpoint (wait event CheckpointDone), which
    // fsyncs every file the whole run has written since the last one: each
    // truncateAll gives every table and index a new file. Late in a full run
    // on Docker's VM disk that took over 3 s (D7 task 2), past vitest's 5 s
    // default with the rest of the test.
  }, THROWAWAY_DATABASE_DROP_TIMEOUT);

  it("refuses an invalid collector catalogue before it creates or migrates the database (D13a Ruling 38)", async () => {
    const name = `telflo_prepare_${randomUUID().replaceAll("-", "")}_test`;
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = `/${name}`;
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = `/${name}`;
    const invalid = [{ name: "otelcol-contrib.json", content: { distribution: "otelcol-contrib" } }];
    try {
      await expect(prepareTestDatabase(url.toString(), applicationUrl.toString(), invalid)).rejects.toThrow(
        CollectorCatalogueError,
      );
      const existing = await sql<{ count: number }>`
        select count(*)::int as count from pg_database where datname = ${name}
      `.execute(databases.ownerDb);
      expect(existing.rows[0]?.count).toBe(0);
    } finally {
      await sql`drop database if exists ${sql.id(name)}`.execute(databases.ownerDb);
    }
  }, THROWAWAY_DATABASE_DROP_TIMEOUT);

  it("removes the catalogue rows a test marked as its own before the sync, so a killed run's fixtures don't stop the next run; an unmarked row is still refused (D25 Ruling 179)", async () => {
    const ownerUrl = process.env.TELFLO_MIGRATION_DATABASE_URL!;
    const applicationUrl = process.env.TELFLO_DATABASE_URL!;
    const id = `prepare-fixture-${randomUUID().slice(0, 8)}`;
    const template = await databases.ownerDb
      .selectFrom("collector_versions")
      .selectAll()
      .where("distribution", "=", "otelcol-contrib")
      .where("is_default", "=", true)
      .executeTakeFirstOrThrow();
    const versionRow = (distribution: string, version: string, description: string | null) => ({
      ...template,
      distribution,
      version,
      label: `v${version}`,
      description,
      is_default: false,
      deprecated: true,
      deprecated_note: "Retired fixture.",
      supported_components: template.supported_components === null ? null : (JSON.stringify(template.supported_components) as never),
      otelcol_contrib: JSON.stringify(template.otelcol_contrib) as never,
      opamp_supervisor: JSON.stringify(template.opamp_supervisor) as never,
    });
    const leftovers = async () => ({
      distributions: await databases.ownerDb.selectFrom("collector_distributions").select("id").where("id", "=", id).execute(),
      versions: await databases.ownerDb
        .selectFrom("collector_versions")
        .select(["distribution", "version"])
        .where((where) => where.or([where("distribution", "=", id), where("version", "in", ["0.0.901", "0.0.902"])]))
        .execute(),
    });
    try {
      // A killed run's marked fixtures: a distribution with a version, an unmarked version of it, and a marked Contrib version.
      await databases.ownerDb
        .insertInto("collector_distributions")
        .values({ id, label: "Fixture", description: TEST_CATALOGUE_FIXTURE_NOTE, icon: null, sort_order: 99, is_default: false })
        .execute();
      await databases.ownerDb
        .insertInto("collector_versions")
        .values([versionRow(id, "1.0.0", TEST_CATALOGUE_FIXTURE_NOTE), versionRow(id, "1.0.1", null), versionRow("otelcol-contrib", "0.0.901", TEST_CATALOGUE_FIXTURE_NOTE)])
        .execute();

      await prepareTestDatabase(ownerUrl, applicationUrl);
      expect(await leftovers()).toEqual({ distributions: [], versions: [] });

      // A row without the mark is still the sync's to refuse, and stays.
      await databases.ownerDb.insertInto("collector_versions").values(versionRow("otelcol-contrib", "0.0.902", "Not a fixture.")).execute();
      await expect(prepareTestDatabase(ownerUrl, applicationUrl)).rejects.toThrow(CollectorCatalogueRemovalError);
      expect((await leftovers()).versions).toEqual([{ distribution: "otelcol-contrib", version: "0.0.902" }]);
    } finally {
      await databases.ownerDb.deleteFrom("collector_versions").where((where) => where.or([where("distribution", "=", id), where("version", "in", ["0.0.901", "0.0.902"])])).execute();
      await databases.ownerDb.deleteFrom("collector_distributions").where("id", "=", id).execute();
    }
  }, 30_000);

  it("refuses to prepare a database whose name does not end in _test", async () => {
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = "/telflo_platform";
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = "/telflo_platform";
    await expect(prepareTestDatabase(url.toString(), applicationUrl.toString())).rejects.toThrow(
      /Refusing to prepare "telflo_platform" as a test database/,
    );
  });

  it("refuses two URLs that name different databases", async () => {
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = "/telflo_one_test";
    const applicationUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    applicationUrl.pathname = "/telflo_other_test";
    await expect(prepareTestDatabase(url.toString(), applicationUrl.toString())).rejects.toThrow(
      /name different databases/,
    );
  });
});
