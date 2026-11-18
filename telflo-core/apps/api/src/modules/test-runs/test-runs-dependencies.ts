import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { createOtelcolTestingClient, type OtelcolTestingClient, type OtelcolTestingClientLog } from "../../otelcol-testing/client.js";
import {
  createOtelcolTestingHealth,
  type OtelcolTestingHealthLog,
  type OtelcolTestingHealthMonitor,
} from "../../otelcol-testing/health-monitor.js";
import { createOttlEvaluatorClient, type OttlEvaluatorClient, type OttlEvaluatorClientLog } from "../../ottl-evaluator/client.js";
import {
  createOttlEvaluatorHealth,
  type OttlEvaluatorHealthLog,
  type OttlEvaluatorHealthMonitor,
} from "../../ottl-evaluator/health-monitor.js";
import type { AppSettings } from "../../settings.js";
import type { CopyPlaces } from "./copy-places.js";
import type { IOrganizationVariables } from "./organization-variables.js";

/**
 * Tells whoever listens that a run was queued (D14a Preflight ruling 7's
 * in-process wake): the dispatcher (Task 8) subscribes and claims at once
 * rather than on its next tick. Until it does, nothing listens, and a
 * notification is a no-op.
 */
export interface TestRunQueueSignal {
  /** A run was queued and has committed. Never throws, never waits. */
  notify(): void;
  /** Calls `listener` on every notification until the returned function is called. */
  subscribe(listener: () => void): () => void;
}

export function createTestRunQueueSignal(): TestRunQueueSignal {
  const listeners = new Set<() => void>();
  return {
    notify() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A listener's failure is its own; queuing has already committed.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The test runs' collaborators (D14a Preflight ruling 17: one `testing`
 * dependency), built in index.ts and e2e/start-api.ts by
 * createTestRunsDependencies. Test servers not about test runs pass
 * UNCALLED_TESTING (apps/api/src/testing/otelcol-testing.ts), which fails a
 * test that reaches any of them.
 */
export interface TestingDependencies {
  /** The collector tester's client: the dispatcher (Task 8) sends runs with it. */
  tester: OtelcolTestingClient;
  /** The tester's health monitor (decision 12): Task 8's starter starts it after listen. */
  health: OtelcolTestingHealthMonitor;
  /** Woken when a run is queued; the dispatcher (Task 8) subscribes. */
  queued: TestRunQueueSignal;
  /**
   * The OTTL evaluator's client (D15a decisions 2 and 6): a rule's save is
   * checked with it, and the dispatcher has a run's rules evaluated with it.
   */
  ottlEvaluator: OttlEvaluatorClient;
  /**
   * The evaluator's health monitor (D15a Preflight ruling 23): the test
   * runs' background starter starts it beside the tester's. Queuing reads
   * the shared row it writes (isOttlEvaluatorKnownDown).
   */
  ottlEvaluatorHealth: OttlEvaluatorHealthMonitor;
  /**
   * Where a run's organization variables come from (D20 decision 38;
   * Preflight ruling 28): the queue reads them to refuse early, the
   * dispatcher to fill them in before the tester. Required, with no
   * fallback: an entry point that passes none doesn't type-check
   * (opampOrganizationVariables in production and the browser tests).
   */
  organizationVariables: IOrganizationVariables;
  /**
   * The queue's places for requests in flight (D14b Ruling 33). Left out,
   * the server makes its own (createCopyPlaces); a test passes one to watch
   * who holds and who waits.
   */
  copyPlaces?: CopyPlaces;
}

/**
 * The real collaborators from the settings: the tester's client and its
 * health monitor, and the OTTL evaluator's client and its health monitor,
 * each monitor writing its shared row; and the organization variables'
 * source the caller passes. The file store isn't one of them: it is the
 * server's own (ServerDependencies.fileStore, D23-2 decision 31), built by
 * the caller. Nothing is started: the background starter starts the
 * monitors and the dispatcher after listen.
 */
export async function createTestRunsDependencies(options: {
  settings: Pick<AppSettings, "otelcolTesting" | "ottlEvaluator">;
  db: Kysely<Database>;
  /** The organization variables' source: opampOrganizationVariables(the opamp-server's client). */
  organizationVariables: IOrganizationVariables;
  log?: OtelcolTestingClientLog & OtelcolTestingHealthLog & OttlEvaluatorClientLog & OttlEvaluatorHealthLog;
}): Promise<TestingDependencies> {
  const { settings, db, organizationVariables, log } = options;
  const tester = createOtelcolTestingClient({
    url: settings.otelcolTesting.url,
    secret: settings.otelcolTesting.secret,
    ...(log === undefined ? {} : { log }),
  });
  const health = createOtelcolTestingHealth({ client: tester, db, ...(log === undefined ? {} : { log }) });
  const ottlEvaluator = createOttlEvaluatorClient({
    url: settings.ottlEvaluator.url,
    secret: settings.ottlEvaluator.secret,
    ...(log === undefined ? {} : { log }),
  });
  const ottlEvaluatorHealth = createOttlEvaluatorHealth({ client: ottlEvaluator, db, ...(log === undefined ? {} : { log }) });
  return { tester, health, queued: createTestRunQueueSignal(), ottlEvaluator, ottlEvaluatorHealth, organizationVariables };
}
