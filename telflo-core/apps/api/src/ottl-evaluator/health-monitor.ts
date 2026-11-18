import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { withDispatcherContext } from "../database/context.js";
import {
  createServiceHealthMonitor,
  SERVICE_DOWN_AFTER_FAILURES,
  SERVICE_HEALTH_INTERVAL_MS,
  type ServiceHealthLog,
  type ServiceHealthMessages,
  type ServiceHealthMonitor,
  type ServiceHealthView,
} from "../otelcol-testing/health-monitor.js";
import type { OttlEvaluatorClient, OttlEvaluatorHealthResult } from "./client.js";

// The OTTL evaluator's health (D15a decision 15, Preflight ruling 23): a
// second instance of the tester's monitor (createServiceHealthMonitor, with
// every rule the tester's has: down after two failed checks 5 s apart, up at
// the first success, up wins, a write only when the shared row disagrees),
// over its own shared row, ottl_evaluator_state (migration 030), written
// through ottl_evaluator_mark in the dispatcher's context.
//
// It only says whether the evaluator is known down: queuing (Task 7) refuses
// a run that would carry rules while it is (decision 15, 503
// `rules_unavailable`), reading the shared row (isOttlEvaluatorKnownDown), not
// this process's view, since another process may have seen it go down first.
// Unlike the tester's, nothing else follows from it: no waiting run fails,
// and a run without rules runs as before.
//
// Nothing here logs the secret, a rule, an output or a log: it holds none of
// them.

/** How long the monitor waits between checks: the tester's 5 s. */
export const OTTL_EVALUATOR_HEALTH_INTERVAL_MS = SERVICE_HEALTH_INTERVAL_MS;

/** How many failed checks in a row count the evaluator down: the tester's 2. */
export const OTTL_EVALUATOR_DOWN_AFTER_FAILURES = SERVICE_DOWN_AFTER_FAILURES;

export type OttlEvaluatorHealthMonitor = ServiceHealthMonitor;
export type OttlEvaluatorHealthView = ServiceHealthView;
export type OttlEvaluatorHealthLog = ServiceHealthLog;

/** The evaluator's words in the log. */
const OTTL_EVALUATOR_HEALTH_MESSAGES: ServiceHealthMessages = {
  down: "the OTTL evaluator is down: runs with validation rules are refused until it answers",
  writeFailed: "the OTTL evaluator's health could not be written; the next check tries again",
  writeRecovered: "the OTTL evaluator's health can be written again",
  readFailed: "the OTTL evaluator's shared health could not be read; the next check tries again",
  readRecovered: "the OTTL evaluator's shared health can be read again",
};

export interface OttlEvaluatorHealthMonitorOptions {
  /** One health check; never throws (the client's `health`). */
  check: (options: { signal: AbortSignal }) => Promise<OttlEvaluatorHealthResult>;
  /** Writes a change to the shared row and answers its down_since (markOttlEvaluator). */
  mark: (isUp: boolean) => Promise<Date | null>;
  /** Date.now by default: the clock of the database warnings' minute. */
  now?: () => number;
  /** Reads the shared row's down_since, null while it is up (readOttlEvaluatorDownSince). */
  read: () => Promise<Date | null>;
  /** OTTL_EVALUATOR_HEALTH_INTERVAL_MS by default. */
  intervalMs?: number;
  log?: OttlEvaluatorHealthLog;
}

export function createOttlEvaluatorHealthMonitor(options: OttlEvaluatorHealthMonitorOptions): OttlEvaluatorHealthMonitor {
  return createServiceHealthMonitor({ ...options, messages: OTTL_EVALUATOR_HEALTH_MESSAGES });
}

/**
 * Writes the monitor's change to the shared row (ottl_evaluator_mark, in the
 * dispatcher's context: it refuses any other) and answers down_since as the
 * row has it now: null once up; the first process's time once down.
 */
export async function markOttlEvaluator(db: Kysely<Database>, isUp: boolean): Promise<Date | null> {
  return withDispatcherContext(db, async (transaction) => {
    const { rows } = await sql<{ down_since: Date | null }>`
      select ottl_evaluator_mark(${isUp}) as down_since
    `.execute(transaction);
    return rows[0]?.down_since ?? null;
  });
}

/**
 * When the evaluator went down, as every API process shares it (the row
 * ottl_evaluator_state), or null while it is up. Global: it needs no
 * context, and the API's role may read it.
 */
export async function readOttlEvaluatorDownSince(db: Kysely<Database>): Promise<Date | null> {
  const row = await db.selectFrom("ottl_evaluator_state").select("down_since").executeTakeFirst();
  return row?.down_since ?? null;
}

/** Whether the evaluator is known down (decision 15): queuing refuses a run with rules while it is. */
export async function isOttlEvaluatorKnownDown(db: Kysely<Database>): Promise<boolean> {
  return (await readOttlEvaluatorDownSince(db)) !== null;
}

/** The monitor the API runs (the test runs' background starter starts it after listen): the client's health checks, the shared row. */
export function createOttlEvaluatorHealth(dependencies: {
  client: OttlEvaluatorClient;
  db: Kysely<Database>;
  log?: OttlEvaluatorHealthLog;
}): OttlEvaluatorHealthMonitor {
  const { client, db, log } = dependencies;
  return createOttlEvaluatorHealthMonitor({
    check: (options) => client.health(options),
    mark: (isUp) => markOttlEvaluator(db, isUp),
    read: () => readOttlEvaluatorDownSince(db),
    ...(log === undefined ? {} : { log }),
  });
}
