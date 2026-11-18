import { sql, type Kysely } from "kysely";
import { TESTING_UNAVAILABLE_MESSAGE } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import { withDispatcherContext } from "../../database/context.js";
import { createThrottledWarning } from "../../database/throttled-warning.js";
import { OTELCOL_TESTING_HEALTH_INTERVAL_MS } from "../../otelcol-testing/health-monitor.js";
import { errorFacts } from "../../error-facts.js";
import type { TestRunDispatcherLog } from "./dispatcher.js";
import { TEST_RUN_FAILURES } from "./run-results.js";

/*
 * The reaper (D14a decisions 12 and 18; Preflight ruling 7): every API
 * process runs its two rules every 5 s, as often as the tester's health is
 * checked, each in its own transaction in the dispatcher's context.
 *
 * 1. test_runs_reap: a running run past its lease (174 + d s), on the
 *    database's clock, fails with `interrupted` and "The run was
 *    interrupted. Run it again.": an API that stopped mid-run, an answer
 *    lost. The run is never started again.
 * 2. test_runs_fail_waiting: once the shared row says the tester has been
 *    down longer than TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS (600 by
 *    default), every waiting run fails with `testing_unavailable` and
 *    "Testing is unavailable right now. Try again later." A run waiting
 *    behind a busy but working tester never fails here.
 *
 * Both functions are safe from several processes at once: each changes a
 * run only in the state it names. A run's files are kept (decision 9).
 */

/** How often the reaper's two rules run: with the health check (Preflight ruling 7). */
export const TEST_RUN_REAP_INTERVAL_MS = OTELCOL_TESTING_HEALTH_INTERVAL_MS;

export interface TestRunReaperOptions {
  /** The API's own role. */
  db: Kysely<Database>;
  /** TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS: positive. */
  downFailAfterSeconds: number;
  log: TestRunDispatcherLog;
  /** TEST_RUN_REAP_INTERVAL_MS by default. */
  intervalMs?: number;
}

/** What one pass changed: the runs' ids. */
export interface TestRunReaping {
  /** Running runs past their lease, now failed (interrupted). */
  reaped: string[];
  /** Waiting runs failed because the tester was down too long. */
  failedWaiting: string[];
}

export interface TestRunReaper {
  /** Runs both rules now, then every interval, until stop(). */
  start(): void;
  /** Both rules, once; a rule whose transaction fails is logged and changes nothing. */
  runOnce(): Promise<TestRunReaping>;
  /** Stops the timer and resolves once a pass in flight has ended. */
  stop(): Promise<void>;
}

/** test_runs_reap with the interrupted message: the runs it failed. */
export async function reapTestRuns(db: Kysely<Database>): Promise<string[]> {
  return withDispatcherContext(db, async (transaction) => {
    const { rows } = await sql<{ id: string }>`
      select test_runs_reap(${TEST_RUN_FAILURES.interrupted.message}) as id
    `.execute(transaction);
    return rows.map((row) => row.id);
  });
}

/** test_runs_fail_waiting after `downForSeconds` down: the runs it failed (none while the tester is up). */
export async function failWaitingTestRuns(db: Kysely<Database>, downForSeconds: number): Promise<string[]> {
  return withDispatcherContext(db, async (transaction) => {
    const { rows } = await sql<{ id: string }>`
      select test_runs_fail_waiting(make_interval(secs => ${downForSeconds}::integer), ${TESTING_UNAVAILABLE_MESSAGE}) as id
    `.execute(transaction);
    return rows.map((row) => row.id);
  });
}

export function createTestRunReaper(options: TestRunReaperOptions): TestRunReaper {
  const { db, downFailAfterSeconds, log } = options;
  const intervalMs = options.intervalMs ?? TEST_RUN_REAP_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isRunning = false;
  let pass: Promise<TestRunReaping> | undefined;
  // Every pass fails while the database is down: logged once, then at most
  // once a minute, and once when a pass succeeds again (Rulings 40, 42).
  // The warning counts passes: a pass whose rules fail is one failure,
  // naming each rule that failed.
  const warning = createThrottledWarning(log, {
    failed: "the test-run reaper's rules failed; the next pass tries again",
    recovered: "the test-run reaper's rules run again",
  });

  /** A rule's runs, or its error's facts when it failed. */
  async function rule(work: () => Promise<string[]>): Promise<{ ids: string[] } | { failure: Record<string, unknown> }> {
    try {
      return { ids: await work() };
    } catch (error) {
      return { failure: errorFacts(error) };
    }
  }

  function runOnce(): Promise<TestRunReaping> {
    pass ??= (async () => {
      const reaping = await rule(() => reapTestRuns(db));
      const failing = await rule(() => failWaitingTestRuns(db, downFailAfterSeconds));
      const failures: Record<string, unknown> = {};
      if ("failure" in reaping) failures.reap = reaping.failure;
      if ("failure" in failing) failures.fail_waiting = failing.failure;
      if (Object.keys(failures).length > 0) warning.failed({ rules: failures });
      else warning.succeeded();
      const reapedOrFailed = "ids" in reaping ? reaping.ids : undefined;
      const failedWaitingOrFailed = "ids" in failing ? failing.ids : undefined;
      const reaped = reapedOrFailed ?? [];
      const failedWaiting = failedWaitingOrFailed ?? [];
      if (reaped.length > 0) log.warn({ count: reaped.length }, "test runs past their lease were failed as interrupted");
      if (failedWaiting.length > 0) {
        log.warn({ count: failedWaiting.length }, "waiting test runs were failed: the tester has been down too long");
      }
      return { reaped, failedWaiting };
    })().finally(() => {
      pass = undefined;
    });
    return pass;
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().finally(() => {
        if (isRunning) schedule(intervalMs);
      });
    }, delayMs);
    timer.unref?.();
  }

  return {
    start() {
      if (isRunning) return;
      isRunning = true;
      schedule(0);
    },
    runOnce,
    async stop() {
      isRunning = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await pass?.catch(() => undefined);
    },
  };
}
