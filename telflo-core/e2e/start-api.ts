import { mkdirSync } from "node:fs";
import { assertApplicationRole, createDb, createPool } from "@telflo/db";
import { prepareTestDatabase } from "@telflo/db/test-database";
import { createFileStore } from "../apps/api/src/file-store/create-file-store.js";
import { createAfterResponseRunner } from "../apps/api/src/http/after-response.js";
import { TEST_RATE_LIMITS } from "../apps/api/src/http/rate-limits.js";
import { createMailer } from "../apps/api/src/mail/create-mailer.js";
import { warmUpSessionService } from "../apps/api/src/modules/sessions/service.js";
import { registerTestRunBackground } from "../apps/api/src/modules/test-runs/background.js";
import { opampOrganizationVariables } from "../apps/api/src/modules/test-runs/organization-variables.js";
import { createTestRunsDependencies } from "../apps/api/src/modules/test-runs/test-runs-dependencies.js";
import { checkInstallTemplates, createInstallTemplateLoader } from "../apps/api/src/install/templates.js";
import { createOpampServerClient } from "../apps/api/src/opamp-server/client.js";
import { createOtelcolValidatorClient } from "../apps/api/src/otelcol-validator/client.js";
import { buildServer } from "../apps/api/src/server.js";
import { loadSettings } from "../apps/api/src/settings.js";
import { createCountingRunner, E2E_AFTER_RESPONSE_PENDING_PATH } from "./support/after-response.js";

// The browser tests' API: apps/api/src/index.ts, with the test rate limits,
// its opamp-server client pointed at the fake (start-fake-opamp-server.ts,
// through e2eApiEnv's TELFLO_OPAMP_MANAGEMENT_*), and its collector
// validator's at the other fake (start-fake-otelcol-validator.ts, through
// TELFLO_OTELCOL_VALIDATOR_*). TELFLO_OTELCOL_TESTING_* name the fake tester
// (start-fake-otelcol-testing.ts): its `testing` dependency is the real one
// (createTestRunsDependencies), the server's file store (`fileStore`, shared
// by the routes and the test runs' background work) is on the e2e root, and
// it runs the test runs' background work as index.ts does (the same starter,
// after listen): the dispatcher sends the browsers' runs to the fake, N at
// once (TELFLO_TEST_RUNS_PER_TESTER, 16). TELFLO_OTTL_EVALUATOR_* name the
// fake OTTL evaluator (start-fake-ottl-evaluator.ts), which the same
// dependencies' client and health monitor reach. Every browser signs in many
// users from one address, which the production limits would refuse with 429.
// It lives under e2e/, never apps/api/src/, so it can never ship, and no
// setting loosens the limits. playwright.config.ts starts it with the E2E
// environment.
//
// It creates and migrates telflo_platform_e2e_test itself, and provisions the
// API's login role there, before it listens, rather than leaving that to
// global-setup.ts: Playwright starts the web servers before global setup runs,
// and waits for /health, which queries the database. On a machine without the
// database yet, that wait would never end. The name was checked to end in
// `_test` by e2eDatabaseUrl, and prepareTestDatabase refuses any other.
//
// TELFLO_MIGRATION_DATABASE_URL, the tables' owner, is read here and only
// here: e2eApiEnv passes it for this preparation, and the API itself, like
// the real one, connects as its own login role.
//
// Its after-response runner is the production one, counted
// (support/after-response.ts): E2E_AFTER_RESPONSE_PENDING_PATH, a route only
// this file adds, answers how many jobs are scheduled and not yet settled,
// and global-setup.ts's teardown waits for 0 before it reads the fake
// opamp-server's violations, so a job the last test set off is checked too.

const settings = loadSettings(process.env);
// Its file store's root, test-results/file-store (e2eApiEnv), which
// Playwright cleared with test-results/ before it started the web servers:
// made again here, before anything builds a store on it. The E2E API keeps
// its files on the local disk.
if (settings.fileStore.kind !== "local") {
  throw new Error("The E2E API keeps its files on the local disk: TELFLO_FILE_STORE must be local.");
}
mkdirSync(settings.fileStore.root, { recursive: true, mode: 0o700 });
// index.ts's start-up check of the install templates: the repository's set
// (e2eApiEnv), refused before anything starts.
const installTemplates = createInstallTemplateLoader(settings.install.templatesDirectory);
await checkInstallTemplates(installTemplates);
const ownerUrl = process.env.TELFLO_MIGRATION_DATABASE_URL;
if (!ownerUrl) throw new Error("The E2E API needs TELFLO_MIGRATION_DATABASE_URL; see e2e/support/environment.ts.");
await prepareTestDatabase(ownerUrl, settings.databaseUrl);
const db = createDb(createPool(settings.databaseUrl));
const mailer = createMailer(settings.mail);
const opampServer = createOpampServerClient(settings.opampServer);
const otelcolValidator = createOtelcolValidatorClient(settings.otelcolValidator);
// One file store for the whole server, on the root made above: the routes and
// the test runs' background work share it.
const fileStore = await createFileStore(settings.fileStore);
// The production collaborators, logging to the server's logger, which they
// read only when they log (after listen); a run's organization variables
// from the fake opamp-server, as index.ts reads them from the real one.
const testing = await createTestRunsDependencies({
  settings,
  db,
  organizationVariables: opampOrganizationVariables(opampServer),
  log: {
    error: (details, message) => server.log.error(details, message),
    warn: (details, message) => server.log.warn(details, message),
  },
});
// The production runner, logging to the server's logger: `server` is read
// when a job is scheduled, by a request, so always after it was built.
const afterResponse = createCountingRunner((task) => createAfterResponseRunner(server.log)(task));
const server = buildServer({
  settings,
  db,
  mailer,
  opampServer,
  otelcolValidator,
  fileStore,
  testing,
  installTemplates,
  rateLimits: TEST_RATE_LIMITS,
  runAfterResponse: afterResponse.run,
});
server.get(E2E_AFTER_RESPONSE_PENDING_PATH, async () => ({ pending: afterResponse.pending() }));
// index.ts's starter: the health monitor, the dispatcher and the reaper,
// stopped when the server closes, started once it listens.
const testRunBackground = registerTestRunBackground(server, { db, settings, fileStore, testing });

try {
  await assertApplicationRole(db);
  await warmUpSessionService();
  await server.listen({ port: settings.apiPort, host: "localhost" });
} catch (error) {
  server.log.error({ err: error }, "failed to start");
  process.exit(1);
}

testRunBackground.start();
