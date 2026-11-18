import { assertApplicationRole, createDb, createPool } from "@telflo/db";
import { loadSettings } from "./settings.js";
import { buildServer } from "./server.js";
import { createFileStore } from "./file-store/create-file-store.js";
import type { IFileStore } from "./file-store/file-store.js";
import { createMailer } from "./mail/create-mailer.js";
import { warmUpSessionService } from "./modules/sessions/service.js";
import { registerTestRunBackground } from "./modules/test-runs/background.js";
import { opampOrganizationVariables } from "./modules/test-runs/organization-variables.js";
import { createTestRunsDependencies, type TestingDependencies } from "./modules/test-runs/test-runs-dependencies.js";
import { createOpampServerClient } from "./opamp-server/client.js";
import { createOtelcolValidatorClient } from "./otelcol-validator/client.js";
import { installShutdownHandlers } from "./shutdown.js";
import { checkInstallTemplates, createInstallTemplateLoader } from "./install/templates.js";

const settings = loadSettings(process.env);
const db = createDb(createPool(settings.databaseUrl));
const mailer = createMailer(settings.mail);
const opampServer = createOpampServerClient(settings.opampServer);
const otelcolValidator = createOtelcolValidatorClient(settings.otelcolValidator);

// The tester's client and its health monitor log through the server's
// logger, which they read only when they log: after listen, so always once
// `server` is built.
const testingLog = {
  error: (details: Record<string, unknown>, message: string) => server.log.error(details, message),
  warn: (details: Record<string, unknown>, message: string) => server.log.warn(details, message),
};
let fileStore: IFileStore;
let testing: TestingDependencies;
// The install templates (D17c-1 decision 36): both sets present, readable,
// within bounds, every placeholder known. A broken set refuses to start,
// naming the setting and the file, never its text.
const installTemplates = createInstallTemplateLoader(settings.install.templatesDirectory);
try {
  await checkInstallTemplates(installTemplates);
  // Refuses to start when the file store's root doesn't exist or can't be
  // written (D14a Preflight ruling 11), or when the S3 store's bucket can't
  // be written, tell a missing file or have a file removed (its startup
  // check, D23-1 decision 23), before the server (and its logger) exists.
  // One store for the whole server (D23-2 decision 31): the routes and the
  // test runs' background work share it.
  fileStore = await createFileStore(settings.fileStore);
  // The tester's client and its health monitor are built, not started: the
  // test runs' background starter starts the monitor, the dispatcher and the
  // reaper after listen.
  // A run's organization variables come from the opamp-server (D20
  // decision 38), read at queue and filled in at dispatch.
  testing = await createTestRunsDependencies({
    settings,
    db,
    organizationVariables: opampOrganizationVariables(opampServer),
    log: testingLog,
  });
} catch (error) {
  console.error("failed to start", error);
  process.exit(1);
}

const server = buildServer({ settings, db, mailer, opampServer, otelcolValidator, fileStore, testing, installTemplates });
// The test runs' background work (D14a decision 29): registered now, so the
// server's close stops it; started once the server listens.
const testRunBackground = registerTestRunBackground(server, { db, settings, fileStore, testing });

// SIGTERM and SIGINT close the server (its onClose stops the background
// work, finishing the runs it aborts), then the pool, then exit; a hard exit
// follows if that hangs (D14a Preflight ruling 7).
installShutdownHandlers({
  close: async () => {
    await server.close();
    await db.destroy();
  },
  exit: (code) => process.exit(code),
  log: server.log,
  signals: process,
});

try {
  // Refuses to start as a superuser, a BYPASSRLS role or the tables' owner,
  // which row-level security would never constrain (D5 decision 1).
  await assertApplicationRole(db);
  await warmUpSessionService();
  await server.listen({ port: settings.apiPort, host: "0.0.0.0" });
} catch (error) {
  server.log.error({ err: error }, "failed to start");
  process.exit(1);
}

testRunBackground.start();
