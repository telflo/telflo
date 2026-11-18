import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { withDispatcherContext } from "../database/context.js";
import { createThrottledWarning } from "../database/throttled-warning.js";
import { errorFacts } from "../error-facts.js";
import type { OtelcolTestingClient, TesterHealthResult } from "./client.js";

// The collector tester's health, as decision 12 and Preflight ruling 7 have
// it. Each API process runs one monitor: it asks the tester's health every
// 5 s, counts its own failed checks, and after each check reads the one row
// every process shares (otelcol_testing_state, migration 028), writing it
// through otelcol_testing_mark in the dispatcher's context only when the row
// disagrees with what this process saw. "Up wins" (D14a Ruling 38):
//
// - a check that succeeds clears the row whenever it says down, whoever
//   marked it: a down left behind by a process that has since died (or
//   whose last check failed as it stopped) ends at the next success of any
//   live process, not never;
// - the row is marked down only after this process's own second failed
//   check in a row (the row keeps the first process's time: down_since =
//   coalesce(down_since, now)), and again after its next failure if another
//   process's success cleared it meanwhile;
// - nothing else writes: a check whose row already says what it saw is not
//   written.
//
// While processes disagree (one reaches the tester, another doesn't), the
// row follows the latest check, and a success clears it at once.
//
// A 503 `version_unavailable` answers for one version, not the tester: it
// counts as a successful check (Preflight ruling 13). A read or a write that
// fails is logged (the first, then at most one a minute while they last, and
// one line when it works again: Ruling 40); the view keeps its old state and
// the next check tries again. A read that fails falls back on the view: the
// write happens when the view would change.
//
// Queuing (Task 7) and the dispatcher (Task 8) read the shared row
// (readOtelcolTestingDownSince), not only their own process's view
// (Ruling 24): another process may have seen the tester go down first.
//
// Nothing here logs the secret, a text, an input or an output: it holds
// none of them.
//
// The monitor itself is a service's, not the tester's alone
// (createServiceHealthMonitor): the OTTL evaluator runs a second one, over
// its own shared row (ottl-evaluator/health-monitor.ts; D15a Preflight
// ruling 23), with its own words in the log.

/** How long a monitor waits between checks (decision 12; D15a Preflight ruling 23 for the evaluator's). */
export const SERVICE_HEALTH_INTERVAL_MS = 5_000;

/** How many failed checks in a row count a service down (decision 12; D15a Preflight ruling 23). */
export const SERVICE_DOWN_AFTER_FAILURES = 2;

/** How long the monitor waits between checks (decision 12). */
export const OTELCOL_TESTING_HEALTH_INTERVAL_MS = SERVICE_HEALTH_INTERVAL_MS;

/** How many failed checks in a row count the tester down (decision 12). */
export const OTELCOL_TESTING_DOWN_AFTER_FAILURES = SERVICE_DOWN_AFTER_FAILURES;

/** What this process has seen of a service and of its shared row. */
export interface ServiceHealthView {
  /** `unknown` until its first check has read or written the row; then what the row says. */
  state: "unknown" | "up" | "down";
  /** This process's failed checks in a row; 0 after a success. */
  consecutiveFailures: number;
  /** While `down`: when the shared row says the service went down (maybe another process's time). */
  downSince: Date | null;
}

/** What this process has seen of the tester and of the shared row. */
export type OtelcolTestingHealthView = ServiceHealthView;

/** Where the monitor logs a change or a failed write. A pino/Fastify logger fits. */
export interface ServiceHealthLog {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export type OtelcolTestingHealthLog = ServiceHealthLog;

/** The lines a service's monitor logs: its going down, and its shared row's failed and recovered reads and writes. */
export interface ServiceHealthMessages {
  down: string;
  writeFailed: string;
  writeRecovered: string;
  readFailed: string;
  readRecovered: string;
}

/** The tester's words (Ruling 40). */
const OTELCOL_TESTING_HEALTH_MESSAGES: ServiceHealthMessages = {
  down: "the collector tester is down: testing refuses new runs until it answers",
  writeFailed: "the collector tester's health could not be written; the next check tries again",
  writeRecovered: "the collector tester's health can be written again",
  readFailed: "the collector tester's shared health could not be read; the next check tries again",
  readRecovered: "the collector tester's shared health can be read again",
};

export interface ServiceHealthMonitorOptions<Result extends { kind: string }> {
  /**
   * One health check; never throws (a client's `health`). An answer of kind
   * `down` is a failed check; any other kind answered (the tester's
   * `version_unavailable` included) is a success.
   */
  check: (options: { signal: AbortSignal }) => Promise<Result>;
  /** Writes a change to the shared row and answers its down_since. */
  mark: (isUp: boolean) => Promise<Date | null>;
  /** Date.now by default: the clock of the database warnings' minute. */
  now?: () => number;
  /** Reads the shared row's down_since, null while it is up. */
  read: () => Promise<Date | null>;
  /** SERVICE_HEALTH_INTERVAL_MS by default. */
  intervalMs?: number;
  log?: ServiceHealthLog;
  /** What it logs. */
  messages: ServiceHealthMessages;
}

export interface OtelcolTestingHealthMonitorOptions {
  /** One health check; never throws (the client's `health`). */
  check: (options: { signal: AbortSignal }) => Promise<TesterHealthResult>;
  /** Writes a change to the shared row and answers its down_since (markOtelcolTesting). */
  mark: (isUp: boolean) => Promise<Date | null>;
  /** Date.now by default: the clock of the database warnings' minute. */
  now?: () => number;
  /** Reads the shared row's down_since, null while it is up (readOtelcolTestingDownSince). */
  read: () => Promise<Date | null>;
  /** OTELCOL_TESTING_HEALTH_INTERVAL_MS by default. */
  intervalMs?: number;
  log?: OtelcolTestingHealthLog;
}

export interface ServiceHealthMonitor {
  /** Checks at once, then SERVICE_HEALTH_INTERVAL_MS after each check ends, until stop(). */
  start(): void;
  /** Stops the checks, aborting one in flight, and resolves once it has ended. */
  stop(): Promise<void>;
  /** One check, and its write if it changes the view. While one is in flight, that one. */
  checkOnce(): Promise<void>;
  /** This process's view: a copy. */
  view(): ServiceHealthView;
}

export type OtelcolTestingHealthMonitor = ServiceHealthMonitor;

/** The tester's monitor: createServiceHealthMonitor with the tester's words. */
export function createOtelcolTestingHealthMonitor(options: OtelcolTestingHealthMonitorOptions): OtelcolTestingHealthMonitor {
  return createServiceHealthMonitor({ ...options, messages: OTELCOL_TESTING_HEALTH_MESSAGES });
}

/**
 * A service's health monitor: the rules this module's comment gives (down
 * after SERVICE_DOWN_AFTER_FAILURES failed checks in a row, up at the first
 * success, up wins, a write only when the shared row disagrees).
 */
export function createServiceHealthMonitor<Result extends { kind: string }>(
  options: ServiceHealthMonitorOptions<Result>,
): ServiceHealthMonitor {
  const intervalMs = options.intervalMs ?? SERVICE_HEALTH_INTERVAL_MS;
  const log = options.log;
  const { messages } = options;
  let state: ServiceHealthView["state"] = "unknown";
  let consecutiveFailures = 0;
  let downSince: Date | null = null;
  let inFlight: Promise<void> | undefined;
  let inFlightController: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isRunning = false;
  /** Which start() the timer belongs to, so a check a stop() outlived never schedules another loop. */
  let generation = 0;
  const quiet = { warn: (details: Record<string, unknown>, message: string) => log?.warn(details, message) };
  const clock = options.now === undefined ? {} : { now: options.now };
  const writeWarning = createThrottledWarning(quiet, {
    failed: messages.writeFailed,
    recovered: messages.writeRecovered,
    ...clock,
  });
  const readWarning = createThrottledWarning(quiet, {
    failed: messages.readFailed,
    recovered: messages.readRecovered,
    ...clock,
  });

  async function write(isUp: boolean): Promise<void> {
    let since: Date | null;
    try {
      since = await options.mark(isUp);
    } catch (error) {
      writeWarning.failed({ err: errorFacts(error), up: isUp });
      return;
    }
    writeWarning.succeeded();
    state = isUp ? "up" : "down";
    downSince = isUp ? null : since;
    if (!isUp) log?.warn({ consecutiveFailures }, messages.down);
  }

  /** The row as it is now: `undefined` when it can't be read (logged), and the view decides alone. */
  async function readRow(): Promise<{ downSince: Date | null } | undefined> {
    let downSince: Date | null;
    try {
      downSince = await options.read();
    } catch (error) {
      readWarning.failed({ err: errorFacts(error) });
      return undefined;
    }
    readWarning.succeeded();
    return { downSince };
  }

  /** Takes the row as this process's view, without writing it. */
  function follow(row: { downSince: Date | null }): void {
    state = row.downSince === null ? "up" : "down";
    downSince = row.downSince;
  }

  async function checkAndWrite(controller: AbortController): Promise<void> {
    let isUp: boolean;
    try {
      isUp = (await options.check({ signal: controller.signal })).kind !== "down";
    } catch {
      // The client never throws; anything else that does is a failed check.
      isUp = false;
    }
    // A check stop() cut short says nothing about the service.
    if (controller.signal.aborted) return;
    consecutiveFailures = isUp ? 0 : consecutiveFailures + 1;
    // One failure is not enough to say anything (decision 12): the row is
    // left as it is, and not even read.
    if (!isUp && consecutiveFailures < SERVICE_DOWN_AFTER_FAILURES) return;
    const row = await readRow();
    if (row === undefined) {
      if (state !== (isUp ? "up" : "down")) await write(isUp);
      return;
    }
    if ((row.downSince === null) === isUp) {
      follow(row);
      return;
    }
    await write(isUp);
  }

  function checkOnce(): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    const controller = new AbortController();
    inFlightController = controller;
    inFlight = checkAndWrite(controller).finally(() => {
      inFlight = undefined;
      inFlightController = undefined;
    });
    return inFlight;
  }

  function schedule(delayMs: number, scheduledBy: number): void {
    timer = setTimeout(() => {
      timer = undefined;
      void checkOnce().finally(() => {
        if (isRunning && generation === scheduledBy) schedule(intervalMs, scheduledBy);
      });
    }, delayMs);
  }

  return {
    start() {
      if (isRunning) return;
      isRunning = true;
      generation += 1;
      schedule(0, generation);
    },
    async stop() {
      isRunning = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      inFlightController?.abort();
      await inFlight;
    },
    checkOnce,
    view() {
      return { state, consecutiveFailures, downSince };
    },
  };
}

/**
 * Writes the monitor's change to the shared row (otelcol_testing_mark, in
 * the dispatcher's context: it refuses any other) and answers down_since as
 * the row has it now: null once up; the first process's time once down.
 */
export async function markOtelcolTesting(db: Kysely<Database>, isUp: boolean): Promise<Date | null> {
  return withDispatcherContext(db, async (transaction) => {
    const { rows } = await sql<{ down_since: Date | null }>`
      select otelcol_testing_mark(${isUp}) as down_since
    `.execute(transaction);
    return rows[0]?.down_since ?? null;
  });
}

/**
 * When the tester went down, as every API process shares it (the row
 * otelcol_testing_state), or null while it is up. Global: it needs no
 * context, and the API's role may read it.
 */
export async function readOtelcolTestingDownSince(db: Kysely<Database>): Promise<Date | null> {
  const row = await db.selectFrom("otelcol_testing_state").select("down_since").executeTakeFirst();
  return row?.down_since ?? null;
}

/** The monitor the API runs (Task 8's starter starts it after listen): the client's health checks, the shared row. */
export function createOtelcolTestingHealth(dependencies: {
  client: OtelcolTestingClient;
  db: Kysely<Database>;
  log?: OtelcolTestingHealthLog;
}): OtelcolTestingHealthMonitor {
  const { client, db, log } = dependencies;
  return createOtelcolTestingHealthMonitor({
    check: (options) => client.health(options),
    mark: (isUp) => markOtelcolTesting(db, isUp),
    read: () => readOtelcolTestingDownSince(db),
    ...(log === undefined ? {} : { log }),
  });
}
