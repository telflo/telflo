import pg from "pg";
import { PLATFORM_CONNECTION_OPTIONS } from "../database-schema.js";
import { validateCollectorCatalogue, type CatalogueDistribution, type CatalogueFile } from "./catalogue.js";

/*
 * The catalogue's sync: the migration step upserts the catalogue's files into
 * collector_distributions and collector_versions, after the migrations and
 * before the API's role is provisioned (runMigrationStep in ../migrations.ts,
 * which migrate.ts and prepareTestDatabase run). The step validates the files
 * before it migrates; the sync validates them again, as its own guard.
 *
 *   * It validates first: a catalogue that fails its validator is refused
 *     before anything is written.
 *   * Then one transaction, under an advisory lock, so two migration steps
 *     against one database (two test runs, two containers) take turns.
 *   * A row the files no longer list is refused, and the transaction rolls
 *     back: a version is never deleted, only deprecated (an existing pin
 *     still resolves), and a distribution is never deleted either.
 *   * The defaults move first: each table's one-default unique index is
 *     checked row by row, so an upsert that set the new default before it
 *     cleared the old one would be refused.
 *     Only a row whose default really changes is cleared.
 *   * Each upsert writes a row only when a value differs (`is distinct
 *     from`), so a second run writes no row at all: no new row version,
 *     no xmin changed. A distribution's renames (migration 1700000000025)
 *     are compared as jsonb, the list's order included.
 *
 * It runs as the tables' owner: the API's role may only read the catalogue
 * (migration 1700000000023).
 */

/**
 * The advisory lock the sync holds for its transaction, by the same
 * convention as the provisioning lock (application-role.ts).
 */
const SYNC_LOCK = "telflo.sync_collector_catalogue";

/**
 * What a sync wrote: how many rows of each table it inserted or changed,
 * each row counted once, a default cleared before its upsert included. Both
 * 0 when nothing changed.
 */
export interface CollectorCatalogueSyncResult {
  distributionsWritten: number;
  versionsWritten: number;
}

/**
 * Rows the database holds that the files no longer list. A sync that finds one
 * changes nothing. Its message says how to recover (catalog/README.md,
 * "Switching to a branch with an older catalogue"): the sync never tolerates
 * the gap itself.
 */
export class CollectorCatalogueRemovalError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `The collector catalogue no longer lists ${missing.join(", ")}, which the database holds. Nothing was ` +
        "changed: a distribution or a version is never removed from the catalogue, only deprecated, so an " +
        "existing pin still resolves. To recover, put each back in its file, a version kept with " +
        '"deprecated": true and a "deprecatedNote" saying why; never delete the row. On a test database ' +
        "(telflo_platform_test, telflo_platform_e2e_test), drop the database instead: its suite recreates it. This happens " +
        "after switching to a branch with an older catalogue; see catalog/README.md.",
    );
    this.name = "CollectorCatalogueRemovalError";
    this.missing = missing;
  }
}

/** The distributions' rows, as jsonb_to_recordset reads them. */
function distributionRows(distributions: readonly CatalogueDistribution[]) {
  return distributions.map((distribution) => ({
    id: distribution.distribution,
    label: distribution.label,
    description: distribution.description,
    icon: distribution.icon,
    sort_order: distribution.sortOrder,
    is_default: distribution.default,
    renamed_types: distribution.renamedTypes,
  }));
}

/**
 * The versions' rows, as jsonb_to_recordset reads them. A binary map left
 * out (a container-only distribution) is stored as `{}`; the jsonb columns
 * hold the file's own shape, `{ "linux_amd64": { "downloadUrl", "sha256" } }`.
 */
function versionRows(distributions: readonly CatalogueDistribution[]) {
  return distributions.flatMap((distribution) =>
    distribution.versions.map((entry) => ({
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
    })),
  );
}

const DISTRIBUTION_RECORD = `(id text, label text, description text, icon text, sort_order integer, is_default boolean,
  renamed_types jsonb)`;

const VERSION_RECORD = `(distribution text, version text, label text, description text, released_at date,
  is_default boolean, deprecated boolean, deprecated_note text, container_image text,
  otelcol_contrib_version text, supported_components jsonb, otelcol_contrib jsonb, opamp_supervisor jsonb)`;

/**
 * Writes the catalogue in `files` to the database `client` is connected to,
 * as the tables' owner, and reports how many rows it wrote. Validates
 * first, and throws `CollectorCatalogueError` having sent no query;
 * throws `CollectorCatalogueRemovalError` (after a rollback) when the files
 * leave out a row the database holds. `client` must not be in a
 * transaction: the sync is its own.
 */
export async function syncCollectorCatalogue(
  client: pg.ClientBase,
  files: readonly CatalogueFile[],
): Promise<CollectorCatalogueSyncResult> {
  const distributions = validateCollectorCatalogue(files);
  const distributionsJson = JSON.stringify(distributionRows(distributions));
  const versionsJson = JSON.stringify(versionRows(distributions));

  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [SYNC_LOCK]);

    const missing = await client.query<{ row: string }>(
      `select 'distribution ' || d.id as row
         from collector_distributions d
        where d.id not in (select f.id from jsonb_to_recordset($1::jsonb) as f${DISTRIBUTION_RECORD})
       union all
       select 'version ' || v.distribution || ' ' || v.version as row
         from collector_versions v
        where (v.distribution, v.version) not in
              (select f.distribution, f.version from jsonb_to_recordset($2::jsonb) as f${VERSION_RECORD})
       order by row`,
      [distributionsJson, versionsJson],
    );
    if (missing.rows.length > 0) throw new CollectorCatalogueRemovalError(missing.rows.map((row) => row.row));

    // The defaults that move, cleared first.
    const clearedDistributions = await client.query<{ row: string }>(
      `update collector_distributions d set is_default = false
         from jsonb_to_recordset($1::jsonb) as f${DISTRIBUTION_RECORD}
        where f.id = d.id and d.is_default and not f.is_default
       returning d.id as row`,
      [distributionsJson],
    );
    const clearedVersions = await client.query<{ row: string }>(
      `update collector_versions v set is_default = false
         from jsonb_to_recordset($1::jsonb) as f${VERSION_RECORD}
        where f.distribution = v.distribution and f.version = v.version and v.is_default and not f.is_default
       returning v.distribution || ' ' || v.version as row`,
      [versionsJson],
    );

    const writtenDistributions = await client.query<{ row: string }>(
      `insert into collector_distributions as d (id, label, description, icon, sort_order, is_default, renamed_types)
       select id, label, description, icon, sort_order, is_default, renamed_types
         from jsonb_to_recordset($1::jsonb) as f${DISTRIBUTION_RECORD}
       on conflict (id) do update
          set label = excluded.label, description = excluded.description, icon = excluded.icon,
              sort_order = excluded.sort_order, is_default = excluded.is_default,
              renamed_types = excluded.renamed_types
        where (d.label, d.description, d.icon, d.sort_order, d.is_default, d.renamed_types)
              is distinct from (excluded.label, excluded.description, excluded.icon, excluded.sort_order,
                                excluded.is_default, excluded.renamed_types)
       returning d.id as row`,
      [distributionsJson],
    );
    const writtenVersions = await client.query<{ row: string }>(
      `insert into collector_versions as v
         (distribution, version, label, description, released_at, is_default, deprecated, deprecated_note,
          container_image, otelcol_contrib_version, supported_components, otelcol_contrib, opamp_supervisor)
       select distribution, version, label, description, released_at, is_default, deprecated, deprecated_note,
              container_image, otelcol_contrib_version, supported_components, otelcol_contrib, opamp_supervisor
         from jsonb_to_recordset($1::jsonb) as f${VERSION_RECORD}
       on conflict (distribution, version) do update
          set label = excluded.label, description = excluded.description, released_at = excluded.released_at,
              is_default = excluded.is_default, deprecated = excluded.deprecated,
              deprecated_note = excluded.deprecated_note, container_image = excluded.container_image,
              otelcol_contrib_version = excluded.otelcol_contrib_version,
              supported_components = excluded.supported_components, otelcol_contrib = excluded.otelcol_contrib,
              opamp_supervisor = excluded.opamp_supervisor
        where (v.label, v.description, v.released_at, v.is_default, v.deprecated, v.deprecated_note,
               v.container_image, v.otelcol_contrib_version, v.supported_components, v.otelcol_contrib,
               v.opamp_supervisor)
              is distinct from (excluded.label, excluded.description, excluded.released_at, excluded.is_default,
                                excluded.deprecated, excluded.deprecated_note, excluded.container_image,
                                excluded.otelcol_contrib_version, excluded.supported_components,
                                excluded.otelcol_contrib, excluded.opamp_supervisor)
       returning v.distribution || ' ' || v.version as row`,
      [versionsJson],
    );

    await client.query("commit");
    const distinctRows = (...results: Array<{ rows: Array<{ row: string }> }>) =>
      new Set(results.flatMap((result) => result.rows.map((row) => row.row))).size;
    return {
      distributionsWritten: distinctRows(clearedDistributions, writtenDistributions),
      versionsWritten: distinctRows(clearedVersions, writtenVersions),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * The migration step's sync: writes the catalogue in `files` (as
 * `readCollectorCatalogueFiles` read them) to the database `url` names,
 * connecting as the tables' owner. Used by runMigrationStep.
 */
export async function syncCollectorCatalogueAt(
  url: string,
  files: readonly CatalogueFile[],
): Promise<CollectorCatalogueSyncResult> {
  // Validated before connecting, so a malformed catalogue reaches no database.
  validateCollectorCatalogue(files);
  const client = new pg.Client({ connectionString: url, options: PLATFORM_CONNECTION_OPTIONS });
  await client.connect();
  try {
    return await syncCollectorCatalogue(client, files);
  } finally {
    await client.end();
  }
}
