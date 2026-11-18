import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import pg from "pg";
import { migrateToLatest } from "../migrations.js";
import { createDb, createPool } from "../pool.js";
import type { Database } from "../schema.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "../test-database.js";
import { openTestDatabases, type TestDatabases } from "../testing.js";
import {
  CollectorCatalogueError,
  readCollectorCatalogueFiles,
  validateCollectorCatalogue,
  type CatalogueDistribution,
  type CatalogueFile,
} from "./catalogue.js";
import { CollectorCatalogueRemovalError, syncCollectorCatalogue } from "./sync.js";

/*
 * The sync (D13a decision 2, Preflight ruling 9), on a throwaway database
 * migrated to the latest migration: each test starts from an empty
 * catalogue and commits what it syncs, so no fixture catalogue ever reaches
 * telflo_platform_test.
 */

/** Creating and dropping a database waits for a checkpoint (D7 Ruling 15). */
const THROWAWAY_DATABASE_TIMEOUT = 30_000;

describe("the collector catalogue's sync", () => {
  let databases: TestDatabases;
  let throwawayName: string;
  let throwawayUrl: string;
  let throwaway: Kysely<Database>;
  let committed: CatalogueFile[];

  beforeAll(async () => {
    databases = openTestDatabases();
    throwawayName = `telflo_catalogue_sync_${randomUUID().replaceAll("-", "")}_test`;
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = `/${throwawayName}`;
    throwawayUrl = url.toString();
    await sql`create database ${sql.id(throwawayName)}`.execute(databases.ownerDb);
    await migrateToLatest(throwawayUrl);
    throwaway = createDb(createPool(throwawayUrl));
    committed = await readCollectorCatalogueFiles();
  }, THROWAWAY_DATABASE_TIMEOUT);

  afterAll(async () => {
    await throwaway?.destroy();
    await sql`drop database if exists ${sql.id(throwawayName)}`.execute(databases.ownerDb);
    await databases.destroy();
  }, THROWAWAY_DATABASE_DROP_TIMEOUT);

  // From empty: the database has no configuration, and the seeded flows
  // (migration 1700000000026) go first, so nothing references a row.
  beforeEach(async () => {
    await sql`delete from flows`.execute(throwaway);
    await sql`delete from collector_versions`.execute(throwaway);
    await sql`delete from collector_distributions`.execute(throwaway);
  });

  /** Syncs `files` on a client of its own, as the migration step does. */
  const sync = async (files: readonly CatalogueFile[]) => {
    const client = new pg.Client({ connectionString: throwawayUrl });
    await client.connect();
    try {
      return await syncCollectorCatalogue(client, files);
    } finally {
      await client.end();
    }
  };

  /** A deep copy of the committed catalogue's files, to change. */
  const copyOfCommitted = (): Array<{ name: string; content: CatalogueDistribution }> =>
    structuredClone(committed) as Array<{ name: string; content: CatalogueDistribution }>;

  /** `version`'s entry in a copy's Contrib file. */
  const versionIn = (files: Array<{ content: CatalogueDistribution }>, version: string) =>
    files[0]!.content.versions.find((entry) => entry.version === version)!;

  /** Every catalogue row, ordered, as the owner reads it. */
  const rows = async () => ({
    distributions: await throwaway.selectFrom("collector_distributions").selectAll().orderBy("id").execute(),
    versions: await throwaway
      .selectFrom("collector_versions")
      .selectAll()
      .orderBy("distribution")
      .orderBy("version")
      .execute(),
  });

  /** Every catalogue row's identity and row version (xmin, ctid): an update of any row changes both. */
  const rowVersions = async () =>
    (
      await sql<{ row: string }>`
        select 'd ' || id || ' ' || xmin::text || ' ' || ctid::text as row from collector_distributions
        union all
        select 'v ' || distribution || ' ' || version || ' ' || xmin::text || ' ' || ctid::text
          from collector_versions
        order by row
      `.execute(throwaway)
    ).rows.map((row) => row.row);

  /** The rows a catalogue's files make, as the tables hold them. */
  const expectedRows = (files: readonly CatalogueFile[]) => {
    const distributions = validateCollectorCatalogue(files);
    return {
      distributions: distributions
        .map((distribution) => ({
          id: distribution.distribution,
          label: distribution.label,
          description: distribution.description,
          icon: distribution.icon,
          sort_order: distribution.sortOrder,
          is_default: distribution.default,
          renamed_types: distribution.renamedTypes,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      versions: distributions
        .flatMap((distribution) => distribution.versions)
        .map((entry) => ({
          distribution: entry.distribution,
          version: entry.version,
          label: entry.label,
          description: entry.description,
          released_at: entry.releasedAt,
          is_default: entry.default,
          deprecated: entry.deprecated,
          deprecated_note: entry.deprecatedNote,
          container_image: entry.containerImage,
          otelcol_contrib_version: entry.otelcolContribVersion,
          supported_components: entry.supportedComponents,
          otelcol_contrib: entry.otelcolContrib ?? {},
          opamp_supervisor: entry.opampSupervisor ?? {},
        }))
        .sort((a, b) => a.distribution.localeCompare(b.distribution) || a.version.localeCompare(b.version)),
    };
  };

  it("from empty, writes every distribution and version of the committed catalogue, as its files hold them", async () => {
    const versionCount = (committed[0]!.content as CatalogueDistribution).versions.length;
    expect(await sync(committed)).toEqual({ distributionsWritten: 1, versionsWritten: versionCount });
    expect(await rows()).toEqual(expectedRows(committed));
    // released_at is the file's day, never shifted by a timezone.
    expect((await rows()).versions.find((row) => row.version === "0.162.0")).toMatchObject({
      released_at: "2026-09-29",
      is_default: true,
      description: "Current default.",
    });
  });

  it("writes each distribution's renames as its file lists them, in its order (D13b decision 6)", async () => {
    await sync(committed);
    const [contrib] = (await rows()).distributions;
    const file = committed[0]!.content as CatalogueDistribution;
    expect(file.renamedTypes.length).toBeGreaterThan(0);
    expect(contrib!.renamed_types).toEqual(file.renamedTypes);
    expect(contrib!.renamed_types).toContainEqual({
      kind: "receiver",
      name: "file_log",
      deprecatedName: "filelog",
      since: "0.149.0",
    });
  });

  it("a second run changes nothing: it reports no row written, and no row gets a new version (xmin and ctid unchanged)", async () => {
    await sync(committed);
    const before = await rowVersions();
    expect(before.length).toBeGreaterThan(1);

    expect(await sync(committed)).toEqual({ distributionsWritten: 0, versionsWritten: 0 });
    expect(await rowVersions()).toEqual(before);
  });

  it("applies a deprecation in the file to that version alone", async () => {
    await sync(committed);
    const before = await rowVersions();
    const files = copyOfCommitted();
    Object.assign(versionIn(files, "0.159.0"), { deprecated: true, deprecatedNote: "A known crash on start." });

    expect(await sync(files)).toEqual({ distributionsWritten: 0, versionsWritten: 1 });
    expect(await rows()).toEqual(expectedRows(files));
    const after = await rowVersions();
    expect(after.filter((row) => !before.includes(row))).toEqual([
      expect.stringMatching(/^v otelcol-contrib 0\.159\.0 /),
    ]);
  });

  it("applies a change to a distribution's renames, their order included, to that row alone, and then writes nothing", async () => {
    await sync(committed);
    const before = await rowVersions();
    const files = copyOfCommitted();
    files[0]!.content.renamedTypes = [...files[0]!.content.renamedTypes].reverse();

    expect(await sync(files)).toEqual({ distributionsWritten: 1, versionsWritten: 0 });
    expect(await rows()).toEqual(expectedRows(files));
    const after = await rowVersions();
    expect(after.filter((row) => !before.includes(row))).toEqual([expect.stringMatching(/^d otelcol-contrib /)]);
    expect(await sync(files)).toEqual({ distributionsWritten: 0, versionsWritten: 0 });

    files[0]!.content.renamedTypes = [];
    expect(await sync(files)).toEqual({ distributionsWritten: 1, versionsWritten: 0 });
    expect((await rows()).distributions[0]!.renamed_types).toEqual([]);
  });

  it("moves the default version, clearing the old one first, even when the old default is deprecated in the same run", async () => {
    await sync(committed);
    const files = copyOfCommitted();
    Object.assign(versionIn(files, "0.162.0"), {
      default: false,
      deprecated: true,
      deprecatedNote: "Withdrawn upstream.",
    });
    Object.assign(versionIn(files, "0.161.0"), { default: true });

    expect(await sync(files)).toEqual({ distributionsWritten: 0, versionsWritten: 2 });
    expect(await rows()).toEqual(expectedRows(files));
    const defaults = await throwaway
      .selectFrom("collector_versions")
      .select("version")
      .where("is_default", "=", true)
      .execute();
    expect(defaults).toEqual([{ version: "0.161.0" }]);
  });

  it("moves the default distribution, clearing the old one first", async () => {
    await sync(committed);
    const files: CatalogueFile[] = [
      ...copyOfCommitted().map((file) => ({ ...file, content: { ...file.content, default: false } })),
      {
        name: "fixture-distribution.json",
        content: {
          ...(committed[0]!.content as CatalogueDistribution),
          distribution: "fixture-distribution",
          label: "A fixture distribution",
          sortOrder: 1,
          default: true,
          versions: (committed[0]!.content as CatalogueDistribution).versions
            .filter((entry) => entry.version === "0.162.0")
            .map((entry) => ({
              ...entry,
              distribution: "fixture-distribution",
              otelcolContribVersion: "0.162.0",
            })),
        },
      },
    ];

    expect(await sync(files)).toEqual({ distributionsWritten: 2, versionsWritten: 1 });
    expect(await rows()).toEqual(expectedRows(files));
    expect(
      await throwaway.selectFrom("collector_distributions").select("id").where("is_default", "=", true).execute(),
    ).toEqual([{ id: "fixture-distribution" }]);
  });

  it("refuses a version or a distribution the files no longer list, and changes nothing, the rest of that run included", async () => {
    await sync(committed);
    const before = await rows();
    const versionsBefore = await rowVersions();

    const withoutVersion = copyOfCommitted();
    withoutVersion[0]!.content.versions = withoutVersion[0]!.content.versions.filter(
      (entry) => entry.version !== "0.147.0",
    );
    // A change the same run would otherwise make: rolled back with it.
    versionIn(withoutVersion, "0.161.0").description = "Changed in the refused run.";
    await expect(sync(withoutVersion)).rejects.toThrow(CollectorCatalogueRemovalError);
    await expect(sync(withoutVersion)).rejects.toMatchObject({ missing: ["version otelcol-contrib 0.147.0"] });
    // The message says how to recover (Ruling 38), with no tolerance in the sync.
    const refusal = sync(withoutVersion);
    await expect(refusal).rejects.toThrow(
      /no longer lists version otelcol-contrib 0\.147\.0, which the database holds\. Nothing was changed/,
    );
    await expect(refusal).rejects.toThrow(
      /To recover, put each back in its file, a version kept with "deprecated": true and a "deprecatedNote"/,
    );
    await expect(refusal).rejects.toThrow(
      /\(telflo_platform_test, telflo_platform_e2e_test\), drop the database instead: its suite recreates it\./,
    );
    await expect(refusal).rejects.toThrow(/see catalog\/README\.md\.$/);
    expect(await rows()).toEqual(before);
    expect(await rowVersions()).toEqual(versionsBefore);

    // A distribution the database holds and no file lists.
    await sql`
      insert into collector_distributions (id, label, description, icon, sort_order, is_default)
      values ('retired-distribution', 'Retired', null, null, 9, false)
    `.execute(throwaway);
    await expect(sync(committed)).rejects.toMatchObject({ missing: ["distribution retired-distribution"] });
  });

  it("refuses an invalid catalogue before it sends a single query, so it writes nothing", async () => {
    await sync(committed);
    const before = await rowVersions();
    const files = copyOfCommitted();
    versionIn(files, "0.160.0").otelcolContrib!.linux_amd64!.sha256 = "not-a-sha256";
    const queries: string[] = [];
    const client = new pg.Client({ connectionString: throwawayUrl });
    await client.connect();
    try {
      const recording = new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return (text: string, ...rest: unknown[]) => {
              queries.push(text);
              return (target.query as (...args: unknown[]) => unknown)(text, ...rest);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(syncCollectorCatalogue(recording, files)).rejects.toThrow(CollectorCatalogueError);
    } finally {
      await client.end();
    }
    expect(queries).toEqual([]);
    expect(await rowVersions()).toEqual(before);
  });
});
