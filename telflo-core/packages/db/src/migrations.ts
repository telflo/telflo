import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { provisionApplicationRole, type MigrationSettings } from "./application-role.js";
import { PLATFORM_CONNECTION_OPTIONS, PLATFORM_MIGRATION_OPTIONS, PLATFORM_SCHEMA } from "./database-schema.js";
import { validateCollectorCatalogue, type CatalogueFile } from "./collector-catalogue/catalogue.js";
import { syncCollectorCatalogueAt } from "./collector-catalogue/sync.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Applies every pending migration to the database named by `url`, which must
 * connect as the tables' owner. `log` receives node-pg-migrate's progress;
 * by default it is discarded.
 */
export async function migrateToLatest(url: string, log: (message: string) => void = () => {}): Promise<void> {
  // The runner gets a client we own and end ourselves. Given a URL instead,
  // node-pg-migrate's close() calls client.end() without awaiting it, leaving
  // a connection closing in the background.
  const client = new pg.Client({ connectionString: url, options: PLATFORM_CONNECTION_OPTIONS });
  await client.connect();
  try {
    // Every object, pgmigrations too, in the platform schema (created on the
    // first run, owned by this role), never public.
    await runner({
      dbClient: client,
      dir: migrationsDirectory,
      direction: "up",
      ...PLATFORM_MIGRATION_OPTIONS,
      log,
    });
    // The database's own default too, for a psql session or a tool that
    // connects without PLATFORM_CONNECTION_OPTIONS. The owner may set it.
    const { rows } = await client.query<{ name: string }>("select current_database() as name");
    await client.query(`alter database ${pg.escapeIdentifier(rows[0]!.name)} set search_path = ${PLATFORM_SCHEMA}`);
  } finally {
    await client.end();
  }
}

/**
 * The migration step, as `npm run db:migrate` (migrate.ts), compose's
 * migrate and prepareTestDatabase run it:
 *
 *   1. validates `catalogue`, the collector catalogue's files as read,
 *      before it touches the database, so an invalid catalogue fails having
 *      migrated nothing;
 *   2. applies every pending migration, as the tables' owner;
 *   3. syncs the catalogue into its tables, which validates it again and
 *      refuses, changing neither table, a catalogue that drops a row the
 *      database holds (the migrations stay applied);
 *   4. creates or resets the API's login role.
 *
 * `log` receives node-pg-migrate's progress and a line for each later
 * step; by default it is discarded.
 */
export async function runMigrationStep(
  settings: MigrationSettings,
  catalogue: readonly CatalogueFile[],
  log: (message: string) => void = () => {},
): Promise<void> {
  validateCollectorCatalogue(catalogue);
  await migrateToLatest(settings.migrationDatabaseUrl, log);
  const synced = await syncCollectorCatalogueAt(settings.migrationDatabaseUrl, catalogue);
  log(
    `Synced the collector catalogue: ${synced.distributionsWritten} distribution and ` +
      `${synced.versionsWritten} version rows written.`,
  );
  await provisionApplicationRole(settings.migrationDatabaseUrl, settings.applicationDatabaseUrl);
  log("Provisioned the API's database role.");
}
