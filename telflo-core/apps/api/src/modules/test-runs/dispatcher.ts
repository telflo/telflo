import { sql, type Kysely } from "kysely";
import {
  TEST_FILE_MAXIMUM_BYTES,
  TEST_RUN_YAML_MAXIMUM_LENGTH,
  ValidationRuleSnapshotSchema,
  type ValidationRuleSnapshot,
} from "@telflo/contracts";
import { z } from "zod";
import type { Database, TestRunStatus } from "@telflo/db";
import { withDispatcherContext } from "../../database/context.js";
import { createThrottledWarning } from "../../database/throttled-warning.js";
import { errorFacts } from "../../error-facts.js";
import type { FileKey, IFileStore, TestRunFileName } from "../../file-store/file-store.js";
import {
  OTELCOL_TESTING_CLIENT_BASE_SECONDS,
  otelcolTestingRunTimeoutMs,
  type OtelcolTestingClient,
  type TestRunAnswer,
  type TestRunResult,
} from "../../otelcol-testing/client.js";
import type { TestRunSignal } from "../../otelcol-testing/schemas.js";
import {
  OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS,
  type EvaluateRulesResult,
  type OttlEvaluatorClient,
} from "../../ottl-evaluator/client.js";
import { fillInRunText, type IOrganizationVariables } from "./organization-variables.js";
import {
  answerResults,
  failureResults,
  TEST_RUN_FAILURES,
  unavailableFailure,
  validationResults,
  type TestRunFailure,
  type TestRunResults,
} from "./run-results.js";
import type { TestRunQueueSignal } from "./test-runs-dependencies.js";

/*
 * The test-run dispatcher: the API's first background loop. Every API process
 * runs one, started after the server listens and stopped on close
 * (background.ts), never by buildServer; they share the queue in Postgres.
 *
 * A tick, every second and whenever a run is queued or one of this
 * process's runs ends:
 *   1. in one READ COMMITTED transaction in the dispatcher's context, reads
 *      the tester's down row every process shares and, unless it says
 *      down, claims with test_runs_claim(N, 174): under an advisory
 *      lock, as many waiting runs as N leaves free beside every process's
 *      running runs, each slot to the oldest waiting run of the person with
 *      the fewest running (the SQL's turns), each marked running
 *      with a lease of 174 + d s (the lease, below). The claim commits
 *      before the tester is called.
 *   2. for each run claimed, outside any transaction: its input from the
 *      FileStore (the run's own copy); for a text with a live `${org:NAME}`,
 *      the organization's values read again and filled in, the run's stored
 *      text staying as written: unreadable, failed `variables_unavailable`;
 *      too long once filled in (counted before it is built), failed
 *      `filled_in_too_long`; then the lease's pre-send check, so the read's
 *      time counts against the lease; the tester's answer, on the filled-in
 *      text, then
 *      - an answer (succeeded, or failed: refused, collector_failed, …): the
 *        output and the decoded input written to the FileStore, then
 *        test_runs_finish with the lease and the results (run-results.ts).
 *        If the run is no longer this lease's (reaped meanwhile), finish
 *        answers false and the two files are removed. A succeeded answer's
 *        run first has its rules checked: its snapshot read with
 *        test_runs_rules under the lease (null: reaped, as above); none, and
 *        it succeeds as before, the evaluator never asked; else the
 *        evaluator checks the tester's output, the stored log and the
 *        rules, once the lease left covers 45 s, its call bounded by
 *        min(40 s, the lease left - 5 s), a busy answer tried once more
 *        after 1 s while the lease still covers it. Any rule failed:
 *        validation_failed, else succeeded, with the results. The evaluator
 *        unreachable, busy twice, answering wrongly, or too little lease
 *        left: failed, rules_unavailable, the answer's files, logs and
 *        timings kept. Stopped meanwhile: failed, interrupted, likewise. A
 *        failed answer (the tester's own failure) is never evaluated;
 *      - a refusal before anything ran (503 busy, starting, unavailable; a
 *        refused connection; a name that didn't resolve; the API stopping
 *        before it was sent): test_runs_release, back in the queue with its
 *        place. A release wakes nothing, and this process then waits before
 *        it claims again, 2 s doubling to 10 s while refusals go on, once per
 *        claim, so a refusing tester isn't sent the same run in a loop;
 *      - anything else (a timeout or a broken connection after it was sent,
 *        a version the tester lacks, an answer that can't be used): failed
 *        with a code and a fixed message. Such a run may have run, so it is
 *        never released: no run is ever sent twice.
 *
 * The lease, from the claim, d the run's duration, in seconds:
 *
 *     25        the send window: a run may still be sent this long after
 *               its claim (its input read, a slow claim)
 *   + 74 + d    the tester: the client's one timer over the run
 *   + 30        the files: the FileStore's writes of the answer's output
 *               and decoded input
 *   + 40        the OTTL evaluator: its client's one timer
 *   +  5        the margin: the rules' read, the finish
 *   = 174 + d
 *
 * A run sent at the window's very end, answered at the tester's full
 * timeout, its files taking their full 30 s, still has 40 + 5 = 45 s of
 * lease left: the evaluator is asked (it is only while 45 s are left) and
 * the run finished. So before a run is sent, the time since its claim (on
 * this process's monotonic clock) plus what it reserves, the tester's
 * 74 + d s, the files' 30 s, the evaluator's 40 s and the 5 s margin
 * (149 + d s), must fit in its lease: else its answer couldn't be stored
 * and checked, and it isn't sent. It can't know the run's rules before the
 * claim, so it always reserves the evaluator's time. It ends as
 * interrupted, or the reaper has ended it already. The reaper (reaper.ts)
 * fails what this never finishes.
 *
 * stop() stops claiming, waits for a claim in flight, aborts every call to
 * the tester (the tester kills their process groups when the connection
 * goes) and waits for each run to end: an aborted one is finished as
 * interrupted, with its lease; one claimed but not yet sent goes back to the
 * queue. What a hard exit cuts short, the reaper fails once its lease has
 * passed.
 *
 * Nothing here logs a text, an input, an output, a file's name, a rule, a
 * rule's result or an error's message: a log line names a run's id, an
 * error's name, code and syscall, and the evaluator's reason, status and
 * code.
 */

/** How often the dispatcher claims, besides being woken. */
export const TEST_RUN_DISPATCH_INTERVAL_MS = 1_000;

/** The send window: how long after its claim a run may still be sent (the lease, above). */
export const TEST_RUN_SEND_WINDOW_SECONDS = 25;

/** The FileStore's writes of an answer's two files. */
export const TEST_RUN_FILES_SECONDS = 30;

/** The margin left in a lease beyond the calls: the rules' read and the finish. */
const LEASE_MARGIN_MS = 5_000;

/** The lease left before the evaluator is asked: its 40 s and the 5 s margin. */
export const TEST_RUN_EVALUATION_LEASE_MS = OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS + LEASE_MARGIN_MS;

/**
 * The lease's overhead over the run's duration (the lease, above): the send
 * window's 25 s, the client's 74 s, the files' 30 s, the evaluator's 40 s and
 * the 5 s margin, so a lease is 174 + d s.
 */
export const TEST_RUN_LEASE_OVERHEAD_SECONDS =
  TEST_RUN_SEND_WINDOW_SECONDS + OTELCOL_TESTING_CLIENT_BASE_SECONDS + TEST_RUN_FILES_SECONDS + TEST_RUN_EVALUATION_LEASE_MS / 1000;

/**
 * What a run reserves of its lease before it is sent: the tester's 74 + d s,
 * the files' 30 s, the evaluator's 40 s and the 5 s margin, 149 + d s. Its
 * lease less this is the send window.
 */
export function testRunPreSendReserveMs(durationSeconds: number): number {
  return otelcolTestingRunTimeoutMs(durationSeconds) + TEST_RUN_FILES_SECONDS * 1000 + TEST_RUN_EVALUATION_LEASE_MS;
}

/** The wait before a busy evaluator is asked once more. */
export const TEST_RUN_EVALUATOR_RETRY_MS = 1_000;

/** The first wait after a released run; it doubles while refusals go on. */
export const TEST_RUN_RELEASE_BACKOFF_MS = 2_000;

/** The longest wait after released runs. */
export const TEST_RUN_RELEASE_BACKOFF_MAXIMUM_MS = 10_000;

/** A run this process claimed: its snapshot, organization and lease. */
export interface ClaimedTestRun {
  id: string;
  organizationId: string;
  leaseId: string;
  leaseExpiresAt: Date;
  yaml: string;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
  distribution: string;
  version: string;
}

/** Where the dispatcher logs. A pino/Fastify logger fits. */
export interface TestRunDispatcherLog {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface TestRunDispatcherOptions {
  /** The API's own role. */
  db: Kysely<Database>;
  fileStore: IFileStore;
  tester: OtelcolTestingClient;
  /** The OTTL evaluator's client: a run's rules are checked with it once the tester answers. */
  evaluator: OttlEvaluatorClient;
  /** Where a run's organization variables come from: filled in before the tester. */
  organizationVariables: IOrganizationVariables;
  /** Woken when a run is queued in this process. */
  queued: TestRunQueueSignal;
  /** N, TELFLO_TEST_RUNS_PER_TESTER: at most this many running, across every process. */
  runsPerTester: number;
  log: TestRunDispatcherLog;
  /** TEST_RUN_DISPATCH_INTERVAL_MS by default. */
  intervalMs?: number;
  /**
   * performance.now by default: a monotonic clock, in milliseconds, for the
   * release backoff and the lease check. The wall clock is never compared
   * with the database's.
   */
  monotonicNow?: () => number;
  /**
   * Waits `ms` (the busy evaluator's 1 s), or less once `signal` aborts.
   * A timer by default; tests pass their own, moving their monotonic clock.
   */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface TestRunDispatcher {
  /** Ticks every interval and whenever woken, until stop(). */
  start(): void;
  /**
   * One claim now (while one is in flight, that one), resolving with how
   * many runs it claimed, once each has been started. The runs go on after
   * it resolves (settled()).
   */
  tick(): Promise<number>;
  /** Resolves once no claim is in flight and none of this process's runs is going. */
  settled(): Promise<void>;
  /** How many of this process's runs are going. */
  inFlight(): number;
  /** Stops claiming, aborts the runs going and resolves once each has ended. */
  stop(): Promise<void>;
}

interface ClaimedRow {
  run_id: string;
  organization_id: string;
  lease_id: string;
  lease_expires_at: Date;
  yaml: string;
  target_pipeline: string;
  signal: string;
  duration_seconds: number;
  collector_distribution: string;
  collector_version: string;
}

/**
 * Claims up to `slots` runs, less every process's running ones, unless the
 * shared row says the tester is down: then nothing. One READ COMMITTED
 * transaction in the dispatcher's context, committed before any run is
 * sent.
 */
export async function claimTestRuns(db: Kysely<Database>, slots: number): Promise<ClaimedTestRun[]> {
  return withDispatcherContext(db, async (transaction) => {
    const state = await transaction.selectFrom("otelcol_testing_state").select("down_since").executeTakeFirst();
    if (state?.down_since !== null && state?.down_since !== undefined) return [];
    const { rows } = await sql<ClaimedRow>`
      select * from test_runs_claim(${slots}::integer, ${TEST_RUN_LEASE_OVERHEAD_SECONDS}::integer)
    `.execute(transaction);
    return rows.map((row) => ({
      id: row.run_id,
      organizationId: row.organization_id,
      leaseId: row.lease_id,
      leaseExpiresAt: row.lease_expires_at,
      yaml: row.yaml,
      pipeline: row.target_pipeline,
      signal: row.signal as TestRunSignal,
      durationSeconds: Number(row.duration_seconds),
      distribution: row.collector_distribution,
      version: row.collector_version,
    }));
  });
}

/** The statuses test_runs_finish ends a run in (migration 1700000000030). */
export type FinishedTestRunStatus = Extract<TestRunStatus, "succeeded" | "failed" | "validation_failed">;

/** test_runs_finish: true when the run was still this lease's, and is now finished in `status`. */
export async function finishTestRun(
  db: Kysely<Database>,
  run: Pick<ClaimedTestRun, "id" | "leaseId">,
  status: FinishedTestRunStatus,
  results: TestRunResults,
): Promise<boolean> {
  return withDispatcherContext(db, async (transaction) => {
    // JSON as it is: numbers and booleans stay numbers and booleans.
    const { rows } = await sql<{ finished: boolean }>`
      select test_runs_finish(${run.id}::uuid, ${run.leaseId}::uuid, ${status}, ${JSON.stringify(results)}::jsonb) as finished
    `.execute(transaction);
    return rows[0]?.finished === true;
  });
}

/**
 * test_runs_rules: a running run's rules' snapshot while this lease holds it,
 * or null when it no longer does (reaped, or finished).
 */
export async function readTestRunRules(db: Kysely<Database>, run: Pick<ClaimedTestRun, "id" | "leaseId">): Promise<unknown[] | null> {
  return withDispatcherContext(db, async (transaction) => {
    const { rows } = await sql<{ rules: unknown[] | null }>`
      select test_runs_rules(${run.id}::uuid, ${run.leaseId}::uuid) as rules
    `.execute(transaction);
    return rows[0]?.rules ?? null;
  });
}

/** A run's snapshot, as the queue wrote it (the contracts' shape): at most 200 rules. */
const snapshotSchema = z.array(ValidationRuleSnapshotSchema).max(200);

/** Waits `ms`, or until `signal` aborts. */
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** test_runs_release: back in the queue, keeping its place. True when the run was still this lease's. */
export async function releaseTestRun(db: Kysely<Database>, run: Pick<ClaimedTestRun, "id" | "leaseId">): Promise<boolean> {
  return withDispatcherContext(db, async (transaction) => {
    const { rows } = await sql<{ released: boolean }>`
      select test_runs_release(${run.id}::uuid, ${run.leaseId}::uuid) as released
    `.execute(transaction);
    return rows[0]?.released === true;
  });
}

/** One of a run's files, in its organization's folder. */
function runFileKey(run: ClaimedTestRun, name: TestRunFileName): FileKey {
  return { kind: "test-run", organizationId: run.organizationId, runId: run.id, name };
}

/** One claim's runs: its number, and when it began on the monotonic clock. */
interface Batch {
  number: number;
  claimedAt: number;
}

/** How a run left this process's hands. */
type Outcome = "released" | "answered" | "ended";

/** A run going in this process. */
interface GoingRun {
  /** Aborts the call to the tester (stop()). */
  controller: AbortController;
  done: Promise<void>;
}

export function createTestRunDispatcher(options: TestRunDispatcherOptions): TestRunDispatcher {
  const { db, fileStore, tester, evaluator, organizationVariables, queued, runsPerTester, log } = options;
  const intervalMs = options.intervalMs ?? TEST_RUN_DISPATCH_INTERVAL_MS;
  const now = options.monotonicNow ?? (() => performance.now());
  const wait = options.wait ?? waitFor;
  /** The wait after the latest released batch; 0 once a run was answered otherwise. */
  let backoffMs = 0;
  /** No claim before this time (monotonic). */
  let claimAfter = Number.NEGATIVE_INFINITY;
  /** Each claim's number, so a batch's releases double the wait once. */
  let batches = 0;
  /** The batch whose release last doubled the wait. */
  let backedOffBatch = 0;
  const going = new Map<string, GoingRun>();
  let isStarted = false;
  let isStopping = false;
  let stopping: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let claiming: Promise<number> | undefined;
  /** A wake that came while a claim was in flight: claim again once it ends. */
  let isClaimWanted = false;
  // A claim fails every tick while the database is down: logged once, then
  // at most once a minute, and once when it claims again.
  const claimWarning = createThrottledWarning(log, {
    failed: "test runs could not be claimed; the next tick tries again",
    recovered: "test runs can be claimed again",
  });
  const settledWaiters = new Set<() => void>();

  function notifySettled(): void {
    if (claiming !== undefined || going.size > 0) return;
    for (const resolve of settledWaiters) resolve();
    settledWaiters.clear();
  }

  function wake(): void {
    if (!isStarted || isStopping) return;
    if (claiming !== undefined) {
      isClaimWanted = true;
      return;
    }
    void tick();
  }

  function tick(): Promise<number> {
    if (claiming !== undefined) return claiming;
    claiming = claimAndStart().finally(() => {
      claiming = undefined;
      notifySettled();
      if (isClaimWanted) {
        isClaimWanted = false;
        wake();
      }
    });
    return claiming;
  }

  async function claimAndStart(): Promise<number> {
    // No slot can be free while this process alone fills N.
    if (isStopping || going.size >= runsPerTester || now() < claimAfter) return 0;
    let claimed: ClaimedTestRun[];
    // Before the claim, so the lease (which starts during it) is never
    // thought longer than it is.
    const claimedAt = now();
    try {
      claimed = await claimTestRuns(db, runsPerTester);
    } catch (error) {
      claimWarning.failed({ err: errorFacts(error) });
      return 0;
    }
    claimWarning.succeeded();
    batches += 1;
    for (const run of claimed) begin(run, { number: batches, claimedAt });
    return claimed.length;
  }

  function begin(run: ClaimedTestRun, batch: Batch): void {
    const controller = new AbortController();
    // stop() began while this claim was in flight: it is never sent.
    if (isStopping) controller.abort();
    const entry: GoingRun = { controller, done: Promise.resolve() };
    going.set(run.id, entry);
    entry.done = carry(run, controller.signal, batch)
      .catch(async (error: unknown): Promise<Outcome> => {
        log.error({ runId: run.id, err: errorFacts(error) }, "a test run failed in the dispatcher");
        await endQuietly(run, TEST_RUN_FAILURES.internalError);
        return "ended";
      })
      .then((outcome) => {
        if (outcome === "released") {
          // Wait before claiming again: the run would be sent straight back.
          // Runs refused together (one batch) double the wait once; one
          // refused after an answer of the same batch reset the wait waits
          // the first step again rather than not at all.
          if (batch.number > backedOffBatch || backoffMs === 0) {
            backedOffBatch = batch.number;
            backoffMs = backoffMs === 0 ? TEST_RUN_RELEASE_BACKOFF_MS : Math.min(backoffMs * 2, TEST_RUN_RELEASE_BACKOFF_MAXIMUM_MS);
          }
          claimAfter = Math.max(claimAfter, now() + backoffMs);
        } else if (outcome === "answered") {
          backoffMs = 0;
          claimAfter = Number.NEGATIVE_INFINITY;
        }
        return outcome;
      })
      .finally(() => {
        if (going.get(run.id) === entry) going.delete(run.id);
        notifySettled();
      })
      .then((outcome) => {
        // A finish frees a slot: claim again (when started). A release
        // doesn't: the backoff's timer ticks claim once it has passed.
        if (outcome !== "released") wake();
      });
  }

  /** Finishes `run` as failed with `failure`, logging (never throwing) a database error. True when it did. */
  async function endQuietly(run: ClaimedTestRun, failure: TestRunFailure): Promise<boolean> {
    try {
      return await finishTestRun(db, run, "failed", failureResults(failure));
    } catch (error) {
      log.error({ runId: run.id, err: errorFacts(error) }, "a test run could not be finished; the reaper will fail it");
      return false;
    }
  }

  /** The run's own copy of its input, or undefined when it is missing, too large or can't be read. */
  async function readInput(run: ClaimedTestRun): Promise<Buffer | undefined> {
    let opened: Awaited<ReturnType<IFileStore["read"]>>;
    try {
      opened = await fileStore.read(runFileKey(run, "input"));
    } catch (error) {
      log.warn({ runId: run.id, err: errorFacts(error) }, "a test run's input could not be read");
      return undefined;
    }
    if (!opened.found) return undefined;
    const { stream } = opened;
    if (opened.sizeBytes > TEST_FILE_MAXIMUM_BYTES) {
      stream.destroy();
      return undefined;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        total += bytes.byteLength;
        if (total > TEST_FILE_MAXIMUM_BYTES) {
          stream.destroy();
          return undefined;
        }
        chunks.push(bytes);
      }
    } catch (error) {
      stream.destroy();
      log.warn({ runId: run.id, err: errorFacts(error) }, "a test run's input could not be read");
      return undefined;
    }
    return Buffer.concat(chunks, total);
  }

  /** Removes the answer's two files, logging (never throwing) a failure. */
  async function removeAnswerFiles(run: ClaimedTestRun): Promise<void> {
    for (const name of ["output", "decoded-input"] as const) {
      try {
        await fileStore.remove(runFileKey(run, name));
      } catch (error) {
        log.warn({ runId: run.id, err: errorFacts(error) }, "a test run's file could not be removed");
      }
    }
  }

  async function writeAnswerFile(run: ClaimedTestRun, name: TestRunFileName, bytes: Buffer): Promise<number> {
    const written = await fileStore.write(
      runFileKey(run, name),
      (async function* () {
        yield bytes;
      })(),
      { maxBytes: TEST_FILE_MAXIMUM_BYTES },
    );
    return written.sizeBytes;
  }

  /** How much of `run`'s lease is left, on the monotonic clock since its claim. */
  function leaseLeftMs(run: ClaimedTestRun, batch: Batch): number {
    return (run.durationSeconds + TEST_RUN_LEASE_OVERHEAD_SECONDS) * 1000 - (now() - batch.claimedAt);
  }

  /**
   * The evaluator's answer for `rules`: asked only while the lease left
   * covers 45 s, its call bounded by min(40 s, the lease left - 5 s); a busy
   * answer asked once more after 1 s, if the lease still covers it.
   * `undefined` when it wasn't asked (too little lease left, or busy again).
   */
  async function evaluate(
    run: ClaimedTestRun,
    batch: Batch,
    signal: AbortSignal,
    request: Parameters<OttlEvaluatorClient["evaluate"]>[0],
  ): Promise<EvaluateRulesResult | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await wait(TEST_RUN_EVALUATOR_RETRY_MS, signal);
      if (signal.aborted) return { kind: "unavailable", reason: "not_sent" };
      const leftMs = leaseLeftMs(run, batch);
      if (leftMs < TEST_RUN_EVALUATION_LEASE_MS) {
        log.warn({ runId: run.id, attempt: attempt + 1 }, "a test run's rules weren't checked: too little of its lease was left");
        return undefined;
      }
      const result = await evaluator.evaluate(request, {
        signal,
        timeoutMs: Math.min(OTTL_EVALUATOR_EVALUATE_TIMEOUT_MS, leftMs - LEASE_MARGIN_MS),
      });
      if (result.kind !== "busy") return result;
      log.warn({ runId: run.id, attempt: attempt + 1 }, "the OTTL evaluator was busy");
    }
    return undefined;
  }

  /**
   * A succeeded answer's run, its files written: its rules checked. The status
   * and the results to finish it with, or null when the run is no longer this
   * lease's (reaped meanwhile).
   */
  async function checkRules(
    run: ClaimedTestRun,
    batch: Batch,
    signal: AbortSignal,
    answer: TestRunAnswer,
    results: TestRunResults,
  ): Promise<{ status: FinishedTestRunStatus; results: TestRunResults } | null> {
    const stored = await readTestRunRules(db, run);
    if (stored === null) return null;
    if (stored.length === 0) return { status: "succeeded", results };
    const snapshot = snapshotSchema.safeParse(stored);
    if (!snapshot.success) {
      // The queue wrote it; nothing of it is logged, only that it can't be read.
      log.error({ runId: run.id, rules: stored.length }, "a test run's rules' snapshot can't be read");
      return { status: "failed", results: { ...results, ...failureResults(TEST_RUN_FAILURES.internalError) } };
    }
    const rules: readonly ValidationRuleSnapshot[] = snapshot.data;
    const evaluated = await evaluate(run, batch, signal, {
      signal: run.signal,
      // The tester's output object, as it answered it but for bytesOnDisk.
      output: answer.output === null ? null : { base64: answer.output.base64, truncated: answer.output.truncated },
      // The log as the run stores it (at most 262,144 code points).
      log: results.logs ?? "",
      rules: rules.map((rule) => ({ id: rule.id, kind: rule.kind, target: rule.target, pattern: rule.pattern, ottl: rule.ottl })),
    });
    if (evaluated?.kind === "evaluated") {
      const isFailed = evaluated.results.some((result) => !result.passed);
      return {
        status: isFailed ? "validation_failed" : "succeeded",
        results: { ...results, validation_results: validationResults(evaluated.results) },
      };
    }
    // Stopped (stop()): interrupted, as a run the tester was running is.
    if (signal.aborted) return { status: "failed", results: { ...results, ...failureResults(TEST_RUN_FAILURES.interrupted) } };
    if (evaluated !== undefined && evaluated.kind === "unavailable") {
      log.warn(
        {
          runId: run.id,
          reason: evaluated.reason,
          ...(evaluated.status === undefined ? {} : { status: evaluated.status }),
          ...(evaluated.code === undefined ? {} : { code: evaluated.code }),
        },
        "a test run's rules couldn't be checked: the OTTL evaluator gave no answer",
      );
    }
    return { status: "failed", results: { ...results, ...failureResults(TEST_RUN_FAILURES.rulesUnavailable) } };
  }

  /** An answer: its files first, then its rules checked (a succeeded one's), then the row, only while the lease is this one's. */
  async function store(
    run: ClaimedTestRun,
    batch: Batch,
    signal: AbortSignal,
    result: Extract<TestRunResult, { kind: "succeeded" | "failed" }>,
  ): Promise<void> {
    const { answer } = result;
    let outputSizeBytes: number | null = null;
    let decodedInputSizeBytes: number | null = null;
    try {
      if (answer.output !== null) outputSizeBytes = await writeAnswerFile(run, "output", answer.output.base64);
      if (answer.decodedInput !== null) {
        decodedInputSizeBytes = await writeAnswerFile(run, "decoded-input", answer.decodedInput.base64);
      }
    } catch (error) {
      log.error({ runId: run.id, err: errorFacts(error) }, "a test run's results could not be written");
      // Any rejection may leave a file at its key (IFileStore.write).
      await removeAnswerFiles(run);
      await endQuietly(run, TEST_RUN_FAILURES.storageFailed);
      return;
    }
    const answered = answerResults(
      answer,
      { outputSizeBytes, decodedInputSizeBytes },
      result.kind === "failed" ? result.error : undefined,
    );
    let ending: { status: FinishedTestRunStatus; results: TestRunResults } | null;
    if (result.kind === "failed") {
      // The tester's own failure: no rules checked.
      ending = { status: "failed", results: answered };
    } else {
      try {
        ending = await checkRules(run, batch, signal, answer, answered);
      } catch (error) {
        // Reading the rules, asking the evaluator or readying its results to be stored.
        log.error({ runId: run.id, err: errorFacts(error) }, "a test run's rules could not be read or checked, or their results readied to store");
        // Nothing finished it: a failure does, and then the row names no file.
        if (await endQuietly(run, TEST_RUN_FAILURES.internalError)) await removeAnswerFiles(run);
        return;
      }
    }
    // Reaped meanwhile: the answer is no longer this run's, and its files go.
    if (ending === null) {
      await removeAnswerFiles(run);
      return;
    }
    let isFinished: boolean;
    try {
      isFinished = await finishTestRun(db, run, ending.status, ending.results);
    } catch (error) {
      log.error({ runId: run.id, err: errorFacts(error) }, "a test run could not be finished");
      // Whether that finish committed is unknown. A failure finishes the run
      // only if it didn't, and then the row names no file: they go.
      if (await endQuietly(run, TEST_RUN_FAILURES.internalError)) await removeAnswerFiles(run);
      return;
    }
    // Reaped meanwhile: the answer is no longer this run's, and its files go.
    if (!isFinished) await removeAnswerFiles(run);
  }

  /**
   * One run, from its claim to its end: `released` back to the queue,
   * `answered` by the tester (it ran, or refused for good), or `ended`
   * otherwise.
   */
  async function carry(run: ClaimedTestRun, signal: AbortSignal, batch: Batch): Promise<Outcome> {
    const input = await readInput(run);
    if (input === undefined) {
      await finishTestRun(db, run, "failed", failureResults(TEST_RUN_FAILURES.inputUnavailable));
      return "ended";
    }
    // Stopping, and nothing sent: back in the queue for another process.
    if (signal.aborted) {
      await releaseTestRun(db, run);
      return "released";
    }
    // The organization's values as they are now, filled in before the tester
    // (its cleanup runs on the filled-in text), read only
    // for a text that references one. The run's own text stays as written.
    // The read (the client's listVariables) takes no abort signal: stop()
    // waits for it, as it waits for readInput's, at most the client's own
    // timeout (DEFAULT_OPAMP_SERVER_TIMEOUT_MS, 5 s).
    const filled = await fillInRunText(organizationVariables, run.organizationId, run.yaml, {
      maximumLength: TEST_RUN_YAML_MAXIMUM_LENGTH,
      build: true,
    });
    // Stopped during the read, and nothing sent: back in the queue, whatever
    // the read answered (another process reads the values again).
    if (signal.aborted) {
      await releaseTestRun(db, run);
      return "released";
    }
    if (filled.kind === "unavailable") {
      log.warn({ runId: run.id, reason: filled.reason }, "a test run wasn't sent: the organization's variables couldn't be read");
      await finishTestRun(db, run, "failed", failureResults(TEST_RUN_FAILURES.variablesUnavailable));
      return "ended";
    }
    if (filled.kind === "too_long") {
      log.warn({ runId: run.id }, "a test run wasn't sent: too long once its organization's variables are filled in");
      await finishTestRun(db, run, "failed", failureResults(TEST_RUN_FAILURES.filledInTooLong));
      return "ended";
    }
    // Too little of the lease left for the answer to be stored and checked:
    // never sent. Measured as time elapsed since the claim, on this
    // process's monotonic clock, against the lease's own length: the
    // database's lease_expires_at is never compared with this process's
    // wall clock. The tester's, the files' and the evaluator's time and the
    // margin are reserved (the lease, above); the evaluator's always: the
    // run's rules aren't known before the claim. After the variables' read,
    // so its time counts.
    if (testRunPreSendReserveMs(run.durationSeconds) > leaseLeftMs(run, batch)) {
      await endQuietly(run, TEST_RUN_FAILURES.interrupted);
      return "ended";
    }
    const result = await tester.run(
      {
        runId: run.id,
        yaml: filled.text,
        pipeline: run.pipeline,
        signal: run.signal,
        durationSeconds: run.durationSeconds,
        distribution: run.distribution,
        version: run.version,
        input,
      },
      { signal },
    );
    if (result.kind !== "unavailable") {
      await store(run, batch, signal, result);
      return "answered";
    }
    // The tester ran nothing: its place kept.
    if (result.isReleasable) {
      await releaseTestRun(db, run);
      return "released";
    }
    await finishTestRun(db, run, "failed", failureResults(unavailableFailure(result.reason, run.version)));
    return "answered";
  }

  return {
    start() {
      if (isStarted || isStopping) return;
      isStarted = true;
      unsubscribe = queued.subscribe(wake);
      interval = setInterval(wake, intervalMs);
      interval.unref?.();
      wake();
    },
    tick,
    settled() {
      if (claiming === undefined && going.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => settledWaiters.add(resolve));
    },
    inFlight() {
      return going.size;
    },
    stop() {
      stopping ??= (async () => {
        isStopping = true;
        isStarted = false;
        if (interval !== undefined) clearInterval(interval);
        interval = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        // A claim in flight starts its runs (already aborted) before it ends.
        await claiming?.catch(() => 0);
        const runs = [...going.values()];
        for (const run of runs) run.controller.abort();
        await Promise.all(runs.map((run) => run.done));
      })();
      return stopping;
    },
  };
}
