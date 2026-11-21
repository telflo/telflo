import pg from "pg";
import { PLATFORM_CONNECTION_OPTIONS } from "./database-schema.js";
import {
  readCollectorCatalogueFiles,
  validateCollectorCatalogue,
  type CatalogueFile,
} from "./collector-catalogue/catalogue.js";
import { runMigrationStep } from "./migrations.js";

/**
 * The test suite's own database, kept apart from the development one.
 *
 * Integration tests `truncateAll` before each test, so running them against
 * the database the dev servers use deletes the developer's accounts. Tests
 * therefore always run against a database whose name ends in `_test`, reached
 * two ways: as the API's login role, from
 * `TELFLO_TEST_DATABASE_URL` when set, otherwise `TELFLO_DATABASE_URL` with
 * `_test` appended to its database name (`telflo_platform` becomes `telflo_platform_test`); and
 * as the tables' owner, the same way from `TELFLO_TEST_MIGRATION_DATABASE_URL`
 * or `TELFLO_MIGRATION_DATABASE_URL`.
 *
 * Wired in two places: the vitest globalSetup (vitest.global-setup.ts at the
 * workspace root) creates and migrates it once per run, and the shared setup
 * file (vitest.setup.ts) points every test process's TELFLO_DATABASE_URL and
 * TELFLO_MIGRATION_DATABASE_URL at it.
 */

const TEST_DATABASE_SUFFIX = "_test";

/**
 * The timeout of every `afterAll` or test that drops a throwaway database.
 * DROP DATABASE forces an immediate checkpoint, which fsyncs every relation
 * file written since the last one, and each `truncateAll` gives every table,
 * index and TOAST table it empties a new file: so a drop pays for every
 * truncate the run made since its last checkpoint, not its own file's alone.
 * Measured 2026-10-28 (Postgres 18 in Docker on macOS, about 0.15 ms a file):
 * validation.integration.test.ts's drop fsynced 20,747 files (3 s) run alone,
 * 234,928 (34 s, past the 30 s it had) 38th in the full run. A
 * checkpoint_timeout (5 minutes) of the run's truncates keeps it well below
 * two minutes.
 */
export const THROWAWAY_DATABASE_DROP_TIMEOUT = 120_000;

/**
 * The mark of a catalog row a test adds for itself: a
 * fixture distribution or version carries it as its `description`, and is
 * removed by its test. TEST ONLY: never a description of the committed
 * catalog's. A run cut short (killed mid-file) leaves its fixtures behind,
 * and the catalog's sync refuses a row the files don't list
 * (CollectorCatalogueRemovalError), so prepareTestDatabase, which the
 * global setup runs, removes every marked row first: only on a `_test`
 * database, and never an unmarked row, which the sync still refuses.
 * Re-exported by `@telflo/db/testing`.
 */
export const TEST_CATALOGUE_FIXTURE_NOTE = "A test's own catalogue fixture: removed before every test run's catalogue sync.";

/**
 * Removes the catalog rows a test marked as its own fixtures
 * (TEST_CATALOGUE_FIXTURE_NOTE), versions before distributions (a version
 * names its distribution), and every version of a marked distribution. A
 * database whose catalog tables don't exist yet (a new one) has none.
 */
async function removeTestCatalogueFixtures(ownerUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl, options: PLATFORM_CONNECTION_OPTIONS });
  await client.connect();
  try {
    const tables = await client.query<{ present: boolean }>(
      "select to_regclass('collector_versions') is not null and to_regclass('collector_distributions') is not null as present",
    );
    if (!tables.rows[0]?.present) return;
    await client.query("begin");
    await client.query(
      `delete from collector_versions
        where description = $1
           or distribution in (select id from collector_distributions where description = $1)`,
      [TEST_CATALOGUE_FIXTURE_NOTE],
    );
    await client.query("delete from collector_distributions where description = $1", [TEST_CATALOGUE_FIXTURE_NOTE]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Resolves the test database URL for the API's login role from `env`. Throws,
 * rather than returning a URL, if the result would name a database that does
 * not end in `_test`: the guard that keeps `truncateAll` off any database not
 * made for tests.
 *
 * Idempotent: a URL whose database already ends in `_test` is returned as it
 * is, so resolving twice (a worker that already points TELFLO_DATABASE_URL at
 * the test database) never produces `telflo_test_test`.
 */
export function testDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return resolveTestDatabaseUrl(env, "TELFLO_DATABASE_URL", "TELFLO_TEST_DATABASE_URL");
}

/**
 * The same, for the tables' owner: fixtures, truncation, test-only DDL and
 * migrations connect with it. Never given to a server under test.
 */
export function testMigrationDatabaseUrl(env: NodeJS.ProcessEnv): string {
  return resolveTestDatabaseUrl(env, "TELFLO_MIGRATION_DATABASE_URL", "TELFLO_TEST_MIGRATION_DATABASE_URL");
}

function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv, variable: string, testVariable: string): string {
  const explicit = env[testVariable];
  const source = explicit ? testVariable : variable;
  const raw = explicit || env[variable];
  if (!raw) {
    throw new Error(
      `Tests need ${variable} (or ${testVariable}) to find a Postgres server; ` +
        "copy .env.example to .env in telflo-core/.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`${source} is not a valid URL`, { cause: error });
  }

  const name = databaseName(url);
  if (!name) throw new Error(`${source} names no database: ${redact(url)}`);

  if (!explicit && !name.endsWith(TEST_DATABASE_SUFFIX)) {
    url.pathname = `/${encodeURIComponent(name + TEST_DATABASE_SUFFIX)}`;
  }

  const resolved = databaseName(url);
  if (!resolved.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to run tests against database "${resolved}" (from ${source}): ` +
        `the test database's name must end in "${TEST_DATABASE_SUFFIX}", because tests empty every table in it.`,
    );
  }
  return url.toString();
}

/** The database name in a postgres URL's path, decoded. */
export function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

function redact(url: URL): string {
  const copy = new URL(url);
  if (copy.password) copy.password = "***";
  return copy.toString();
}

/**
 * Validates the collector catalog, then creates the test database named
 * by `ownerUrl` if it does not exist and runs the migration step on it
 * (runMigrationStep): migrates it to the latest migration as the owner,
 * removes the catalog rows tests marked as their own fixtures
 * (TEST_CATALOGUE_FIXTURE_NOTE: a killed run's leftovers), syncs the
 * catalog into it, then provisions the login role `applicationUrl` names.
 * Both must name the same database. An invalid catalog fails before any
 * database is created or migrated. Safe to call when it already exists
 * and is current; safe against another run creating it, syncing or
 * provisioning at the same moment.
 *
 * `catalogue` is the committed catalog's files unless a test passes its
 * own.
 */
export async function prepareTestDatabase(
  ownerUrl: string,
  applicationUrl: string,
  catalogue?: readonly CatalogueFile[],
): Promise<void> {
  const target = new URL(ownerUrl);
  const name = databaseName(target);
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(`Refusing to prepare "${name}" as a test database: its name must end in "${TEST_DATABASE_SUFFIX}"`);
  }
  const applicationName = databaseName(new URL(applicationUrl));
  if (applicationName !== name) {
    throw new Error(
      `The test database's two URLs name different databases ("${name}" for the owner, "${applicationName}" for the API's role)`,
    );
  }

  const files = catalogue ?? (await readCollectorCatalogueFiles());
  validateCollectorCatalogue(files);

  // Creating a database needs a connection to some other database on the
  // same server; `postgres` exists on every server.
  const maintenanceUrl = new URL(target);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  try {
    const existing = await maintenance.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) {
      try {
        await maintenance.query(`create database ${pg.escapeIdentifier(name)}`);
      } catch (error) {
        // 42P04 duplicate_database: another run created it since the check.
        if ((error as { code?: string }).code !== "42P04") throw error;
      }
    }
  } finally {
    await maintenance.end();
  }

  // Before the sync, which refuses a row the files don't list: a killed run's marked fixtures.
  await removeTestCatalogueFixtures(target.toString());
  await runMigrationStep({ migrationDatabaseUrl: target.toString(), applicationDatabaseUrl: applicationUrl }, files);
}
