import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationSettings } from "./application-role.js";
import { readCollectorCatalogueFiles } from "./collector-catalogue/catalogue.js";
import { runMigrationStep } from "./migrations.js";

// `npm run db:migrate` (and compose's migrate): reads the collector
// catalog's files and validates them before it touches the database, so an
// invalid catalog exits non-zero having migrated nothing; then applies
// pending migrations as the tables' owner, syncs the catalog into its tables
// (a catalog that drops a row the database holds exits non-zero with both
// tables unchanged), and creates or resets the API's login role. See
// runMigrationStep. In development tsx runs this file; the API image runs its
// compiled dist/migrate.js.
//
// Loads telflo-core/.env itself, as settings.ts does for the API. A missing
// file is normal where the environment is injected (the container stack).
try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const settings = migrationSettings(process.env);
await runMigrationStep(settings, await readCollectorCatalogueFiles(), (message) => console.log(message));
