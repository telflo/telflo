import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { prepareTestDatabase, testDatabaseUrl, testMigrationDatabaseUrl } from "@telflo/db/test-database";
import { dropFailingInsertLeftovers, restoreRevokedGrantLeftovers } from "@telflo/db/testing";

// vitest globalSetup: creates the test database if it is missing, migrates it
// to the latest migration as the tables' owner, and provisions the API's login
// role, before any test worker starts. Tests never use the development
// database (see packages/db/src/test-database.ts).
//
// Declared in the globalSetup of every package whose tests touch the database
// (packages/db, apps/api), so a single-package run (`npm test -w @telflo/db`)
// prepares it too. vitest 2 runs each workspace project's globalSetup, in the
// main process, before any worker, so a root `npm test` would call this once
// per project; the promise below is kept on globalThis (shared by every
// project in that process) so the work happens once per run.
//
// This runs in vitest's main process, where vitest.setup.ts has not run, so
// it reads .env itself, without writing it into process.env: the workers
// inherit this process's environment, and vitest.setup.ts is the one place
// that decides what they see. Variables already in the environment win over
// .env, as with process.loadEnvFile.
//
// Once migrated, the database loses any withFailingInsert trigger a killed
// run left behind (withFailingInsert refuses one it finds, since it can't
// tell a leftover from a nested call), and gets back any grant a killed run
// had revoked for a moment.
//
// So run one suite at a time against a test database: a second vitest run
// starting beside one already running would drop that run's live
// withFailingInsert trigger mid-test (and its truncations would empty the
// other run's fixtures anyway).

const preparation = Symbol.for("telflo.testDatabasePreparation");
type WithPreparation = typeof globalThis & { [preparation]?: Promise<void> };

function workspaceEnv(): NodeJS.ProcessEnv {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), ".env");
  let fromFile: NodeJS.Dict<string> = {};
  try {
    fromFile = parseEnv(readFileSync(envPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { ...fromFile, ...process.env };
}

export async function setup(): Promise<void> {
  const shared = globalThis as WithPreparation;
  const env = workspaceEnv();
  const ownerUrl = testMigrationDatabaseUrl(env);
  shared[preparation] ??= prepareTestDatabase(ownerUrl, testDatabaseUrl(env))
    .then(() => dropFailingInsertLeftovers(ownerUrl))
    .then(() => restoreRevokedGrantLeftovers(ownerUrl));
  await shared[preparation];
}
