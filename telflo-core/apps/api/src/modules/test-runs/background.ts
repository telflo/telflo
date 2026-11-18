import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import type { IFileStore } from "../../file-store/file-store.js";
import type { AppSettings } from "../../settings.js";
import { createTestRunDispatcher, type TestRunDispatcher, type TestRunDispatcherLog } from "./dispatcher.js";
import { createTestRunReaper, type TestRunReaper } from "./reaper.js";
import type { TestingDependencies } from "./test-runs-dependencies.js";

/*
 * The test runs' background work (D14a decisions 12, 18 and 29; Preflight
 * rulings 7 and 17): the tester's health monitor, the OTTL evaluator's
 * (D15a Preflight ruling 23), the dispatcher and the reaper. The one
 * starter, shared by index.ts and e2e/start-api.ts; never run by
 * buildServer, so a test's server runs no loop.
 *
 *   const background = registerTestRunBackground(server, { db, settings, fileStore, testing });
 *   await server.listen(...);
 *   background.start();
 *
 * Registered before listen (Fastify takes no hook once it listens): closing
 * the server stops all four, the dispatcher first, so the runs it aborts
 * are finished while the database is still there. Started after listen.
 */

export interface TestRunBackground {
  /** Starts the two health monitors, the reaper and the dispatcher. Once. */
  start(): void;
  /** Stops all four; the server's close calls it. */
  stop(): Promise<void>;
  /** The dispatcher, for tests. */
  readonly dispatcher: TestRunDispatcher;
  /** The reaper, for tests. */
  readonly reaper: TestRunReaper;
}

export interface TestRunBackgroundDependencies {
  /** The API's own role. */
  db: Kysely<Database>;
  settings: Pick<AppSettings, "testRuns">;
  /** The server's own file store (ServerDependencies.fileStore, D23-2 decision 31): the dispatcher reads a run's input and writes its output there. */
  fileStore: IFileStore;
  testing: TestingDependencies;
  /** The server's logger by default. */
  log?: TestRunDispatcherLog;
}

export function registerTestRunBackground(server: FastifyInstance, dependencies: TestRunBackgroundDependencies): TestRunBackground {
  const { db, settings, fileStore, testing } = dependencies;
  const log: TestRunDispatcherLog = dependencies.log ?? {
    warn: (details, message) => server.log.warn(details, message),
    error: (details, message) => server.log.error(details, message),
  };
  const dispatcher = createTestRunDispatcher({
    db,
    fileStore,
    tester: testing.tester,
    evaluator: testing.ottlEvaluator,
    organizationVariables: testing.organizationVariables,
    queued: testing.queued,
    runsPerTester: settings.testRuns.runsPerTester,
    log,
  });
  const reaper = createTestRunReaper({ db, downFailAfterSeconds: settings.testRuns.downFailAfterSeconds, log });
  let isStarted = false;
  let stopping: Promise<void> | undefined;

  const background: TestRunBackground = {
    start() {
      if (isStarted || stopping !== undefined) return;
      isStarted = true;
      testing.health.start();
      testing.ottlEvaluatorHealth.start();
      reaper.start();
      dispatcher.start();
    },
    stop() {
      stopping ??= (async () => {
        await dispatcher.stop();
        await Promise.all([reaper.stop(), testing.health.stop(), testing.ottlEvaluatorHealth.stop()]);
      })();
      return stopping;
    },
    dispatcher,
    reaper,
  };
  server.addHook("onClose", async () => {
    await background.stop();
  });
  return background;
}
