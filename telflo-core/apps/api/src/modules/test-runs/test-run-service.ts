import {
  TEST_FILE_HEAD_MAXIMUM_BYTES,
  TEST_RUN_YAML_MAXIMUM_LENGTH,
  TEST_RUNS_LIST_MAXIMUM,
  TEST_RUNS_WAITING_MAXIMUM_PER_USER,
  type QueueOneOffTestRunRequest,
  type QueueTestRunRequest,
  type TestRunFile,
  type TestRunSignal,
  type ValidationRuleSnapshot,
} from "@telflo/contracts";
import type { Readable } from "node:stream";
import { TEST_RUN_FILE_NAMES, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import type { PerUserLimiter } from "../../http/rate-limits.js";
import type { AppError } from "../../errors.js";
import {
  collectorDistributionUnknown,
  collectorVersionUnknown,
  configurationNotFound,
  configurationVersionNotFound,
} from "../configurations/errors.js";
import { lockAsMember } from "../configurations/service.js";
import type { Configuration } from "../configurations/repositories/configuration-repository.js";
import type { ConfigurationVersionSummary } from "../configurations/repositories/configuration-version-repository.js";
import { assertActiveOrganization, canonicalIdOf, type Actor } from "../organizations/service.js";
import { testDefinitionNotFound } from "../test-suites/errors.js";
import { testDefinitionInputKey } from "../test-suites/service.js";
import { testTemplateNotFound } from "../test-templates/errors.js";
import type { CopyPlaces } from "./copy-places.js";
import {
  collectorVersionRetired,
  filledInTooLongAtQueue,
  rulesUnavailableAtQueue,
  testFileNotFound,
  testingUnavailable,
  testRunFileNotFound,
  noSavedRules,
  testRunNotFound,
  testRunOutputNotFound,
  testRunQueueFull,
  testRunQueuingBusy,
  testRunRateLimited,
  variablesUnavailableAtQueue,
} from "./errors.js";
import { fillInRunText, type IOrganizationVariables } from "./organization-variables.js";
import type {
  AnyTestRun,
  TestRun,
  TestRunBreadcrumb,
  TestRunSummary,
  YamlTestRun,
} from "./repositories/test-run-repository.js";
import { firstBytes, testInputKey } from "./test-file-service.js";
import type { TestRunQueueSignal } from "./test-runs-dependencies.js";
import type { TestRunsTransaction, WithTestRunsTransaction } from "./transaction.js";

/*
 * The runs API.
 *
 * Queuing a run, in this order:
 *   1. the session, the terms (the routes' preHandlers), the active
 *      organization and the membership, re-read under the organization's
 *      lock; the configuration and its version, as the caller sees them
 *      (another member's draft and a deleted configuration are 404);
 *   2. the pin, with the configuration's distribution (findVersionState):
 *      unknown is 400 `collector_version_unknown`, deprecated 400
 *      `collector_version_retired`, before any limit;
 *   3. the source, read as the caller: their own file in this organization
 *      (`test_file_not_found` otherwise, admins included); a run they can see,
 *      re-read through row-level security, whose input is still on disk
 *      (`test_run_not_found` otherwise), its breadcrumb copied when it is a
 *      run of the path's configuration and version; a live template
 *      (`test_template_not_found` otherwise); or a definition of the path's
 *      version they can see, read through row-level security with its suite's
 *      name (`test_definition_not_found` otherwise), which gives the run its
 *      input, pipeline, signal, duration and breadcrumb; and whether the
 *      version's validation pipeline for that pipeline and signal has rules
 *      the caller can see;
 *   4. the tester's down state, from the row every API process shares
 *      (readOtelcolTestingDownSince): 503 `testing_unavailable` at once,
 *      nothing queued; then, for a run that would carry rules, the OTTL
 *      evaluator's (isOttlEvaluatorKnownDown): 503 `rules_unavailable`. A run
 *      without rules queues as before;
 *   5. 20 runs a minute per person, per organization: 429
 *      `test_run_rate_limited`. A run from a definition isn't counted: the
 *      source's kind decides it, as step 3's read set it, never a field of the
 *      request. An admission refused before the input is copied (a full queue,
 *      a text too long, an input that isn't there) is refunded; one whose copy
 *      began is spent, whatever follows;
 *   6. a place among the person's TEST_RUN_COPIES_IN_FLIGHT_PER_USER requests
 *      in flight in this organization, waiting for one first come first served
 *      (copy-places.ts): beyond TEST_RUN_COPIES_WAITING_PER_USER waiting, 429
 *      `test_run_rate_limited` with its own words. Held until the request
 *      ends, whatever it ends in; then at most 50 waiting for the person, in
 *      this organization, counted once the place is held
 *      (test_runs_waiting_for_context_user): 429 `test_run_queue_full`, a
 *      definition's run included;
 *   7. the organization's variables: for a text with a live `${org:NAME}`
 *      only, its values read from the opamp-server to refuse early,
 *      unreadable 503 `variables_unavailable`, too long once filled in
 *      (counted, never built) 400 `filled_in_too_long`. The text is stored
 *      as written: the dispatcher fills the values in again, as they are
 *      then, on the way to the tester (organization-variables.ts);
 *   8. the run's id (uuidv7), and the input copied into
 *      organizations/<org>/test-runs/<run>/input; a source whose bytes are
 *      gone is its own 404;
 *   9. one transaction: the membership, the configuration, its version and
 *      the pin re-checked, the person's queue in this organization locked
 *      and the cap counted again, then the queued row with its snapshot and
 *      breadcrumb, and the audit row `test_run.queued`, which names ids
 *      only. The definition or template isn't re-read: the copy is made,
 *      and the snapshot outlives them. The row's insert takes the rules'
 *      snapshot itself (the run repository's create): the rules as they are
 *      then, through row-level security, never from the request (its
 *      schemas are strict). A re-run takes the current rules, as it takes
 *      the current text;
 *  10. on any failure after the copy began, the run's files are removed
 *      (each of its three, as the FileStore removes by key);
 *  11. the dispatcher woken.
 *
 * A run's text, its input's name, a suite's and a definition's names and
 * the bytes reach no log line and no audit row.
 *
 * The public API shares steps 4 to 11 (`queuePrepared`):
 *   * a version's run through `queue` with `inlineRules`: the request's
 *     rules, checked by the public route as Save checks one and given fresh
 *     ids, are the run's snapshot instead of the database's, and decide
 *     whether it carries rules; `[]` is a run with none. Only the public
 *     route passes it; every other run keeps the database's snapshot;
 *   * a YAML run through `queueFromYaml`: no configuration, so steps 1 and 2
 *     are the membership and the pin (the distribution and version named,
 *     else the catalog's defaults: 400 `collector_distribution_unknown`,
 *     `collector_version_unknown`, `collector_version_retired`), step 3 the
 *     caller's own file (the sample the public route stored), and its rules
 *     always inline. Its audit row's metadata is
 *     `{ source: "yaml", inputFileId }`. It is its creator's alone (migration
 *     1700000000040's policies), and no run list shows it;
 *   * `find` and `openOutput` read a run by its id alone: a version's run
 *     the caller can see, or their own YAML run (404 `test_run_not_found`
 *     otherwise), and its output (404 `test_run_output_not_found` before
 *     there is one).
 *
 * The public route takes step 5's minute itself, after `precheckQueue` and
 * before it spends a rule check or an upload, and hands the admission to
 * `queue` (`options.admission`) or `queueFromYaml`, which don't admit
 * again. From then on the service owns it: any refusal before the copy
 * begins (steps 1 to 4 included) gives it back, as step 5's own admission
 * is.
 */

/** An admission that counts nothing: a definition's run's. Its refund is a no-op. */
const NOT_COUNTED = { isAdmitted: true, refund: () => undefined } as const;

/** Step 5's minute, admitted by the public route before it spent anything. Refunding twice gives back one. */
export interface RunAdmission {
  isAdmitted: true;
  refund: () => void;
}

/** Gives `admission` back when `work` refuses: a refusal before the copy began spends no minute. */
async function refundingOnRefusal<T>(admission: RunAdmission | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    admission?.refund();
    throw error;
  }
}

/**
 * Where a run comes from, as step 3's read found it: the bytes to copy, the
 * name the run takes, what it runs (a definition's own, else the
 * request's), its breadcrumb, and the ids its audit row names (exactly one
 * source). Only the read sets `kind`.
 */
type RunSource = {
  from: FileKey;
  name: string;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
  breadcrumb: TestRunBreadcrumb | null;
} & (
  | { kind: "file"; audit: { inputFileId: string } }
  | { kind: "rerun"; sourceRunId: string; audit: { sourceRunId: string } }
  | { kind: "template"; audit: { templateId: string } }
  | { kind: "definition"; audit: { definitionId: string; suiteId: string } }
);

/**
 * What steps 1 to 3 read, and what step 9 writes, for the shared steps 4 to
 * 11 (`queuePrepared`): a version's run's or a YAML run's.
 */
interface PreparedRun {
  /** Chosen at step 3 (nextId): the input is copied under it first. */
  runId: string;
  source: RunSource;
  /** Whether the run carries rules (step 4's evaluator check). */
  hasRules: boolean;
  /** The text as written: step 7 measures it, step 9 stores it. Never logged. */
  yaml: string;
  distribution: string;
  collectorVersion: string;
  /** Both null for a YAML run. */
  configurationId: string | null;
  versionId: string | null;
  /** The public route's rules; undefined for the database's snapshot. */
  inlineRules: readonly ValidationRuleSnapshot[] | undefined;
  /** The database's snapshot must hold a rule (QueueTestRunOptions.requireSavedRules). */
  requireSavedRules: boolean;
  /** The public route's minute: step 5 takes it instead of admitting one. Undefined: step 5 admits. */
  admission: RunAdmission | undefined;
  /** Step 9's re-check, first in its transaction: the membership under the organization's lock, and what step 1 and 2 read. */
  recheck: (transaction: TestRunsTransaction) => Promise<void>;
  /** The audit row's metadata: ids only. */
  auditMetadata: Record<string, string>;
}

/**
 * A YAML run's pin, as `validateText` reads one: a named distribution must be
 * the catalog's (400 `collector_distribution_unknown`), whatever its
 * versions offer; the version named is taken as it is, and a default is needed
 * only when it is left out (the catalog's default distribution's, or the
 * named one's: 400 `collector_distribution_unknown` when it has none). Whether
 * the version is offered is assertPinOffered's.
 */
async function yamlRunPin(
  transaction: TestRunsTransaction,
  request: Pick<QueueYamlTestRunRequest, "distribution" | "collectorVersion">,
): Promise<{ distribution: string; collectorVersion: string }> {
  const named = request.distribution;
  if (named === undefined) {
    const defaults = await transaction.catalogue.findDefaults();
    return { distribution: defaults.distribution, collectorVersion: request.collectorVersion ?? defaults.version };
  }
  if (!(await transaction.catalogue.listOffered()).some((distribution) => distribution.id === named)) {
    throw collectorDistributionUnknown();
  }
  if (request.collectorVersion !== undefined) return { distribution: named, collectorVersion: request.collectorVersion };
  const pin = await transaction.catalogue.findDistributionDefault(named);
  if (pin === undefined) throw collectorDistributionUnknown();
  return { distribution: pin.distribution, collectorVersion: pin.version };
}

/** What a run of a file, a template or a re-run runs: the request's own. */
function runOf(request: QueueOneOffTestRunRequest): { pipeline: string; signal: TestRunSignal; durationSeconds: number } {
  return { pipeline: request.pipeline, signal: request.signal, durationSeconds: request.durationSeconds };
}

/** The 404 a source answers once its bytes are found gone at the copy: its own. */
function sourceNotFound(source: RunSource): AppError {
  switch (source.kind) {
    case "file":
      return testFileNotFound();
    case "rerun":
      return testRunNotFound();
    case "template":
      return testTemplateNotFound();
    case "definition":
      return testDefinitionNotFound();
  }
}

export interface TestRunServiceDependencies {
  withTransaction: WithTestRunsTransaction;
  fileStore: IFileStore;
  /** The person's 20 a minute in an organization (RateLimiters' testRunsPerUser). */
  limiter: PerUserLimiter;
  /** The person's queue requests in flight in an organization. */
  copyPlaces: CopyPlaces;
  /** When the tester went down, as the shared row has it; null while it is up (readOtelcolTestingDownSince). */
  readDownSince: () => Promise<Date | null>;
  /** Whether the OTTL evaluator is known down, as the shared row has it (isOttlEvaluatorKnownDown). */
  isRulesEvaluatorDown: () => Promise<boolean>;
  organizationVariables: IOrganizationVariables;
  queued: TestRunQueueSignal;
  log: { warn(details: Record<string, unknown>, message: string): void };
}

/** A run with its place in the queue: `ahead` for a waiting run the caller can see, null otherwise. */
export interface TestRunWithPlace<Run extends TestRunSummary = TestRun> {
  run: Run;
  ahead: number | null;
}

/** A run's file, open for streaming. The caller must consume or destroy the stream. */
export interface OpenedTestRunFile {
  sizeBytes: number;
  stream: Readable;
}

/** A version's run's options: only the public route passes any. */
export interface QueueTestRunOptions {
  /**
   * The run's rules, checked as Save checks one and given fresh ids, in
   * their order: its snapshot instead of the database's, `[]` for a run
   * with none. Left out, the database's.
   */
  inlineRules?: readonly ValidationRuleSnapshot[];
  /**
   * The public route's `useSavedRules`: the run must carry the database's
   * rules. None at step 3 is 422 `configuration_invalid` (noSavedRules)
   * before anything is copied; a snapshot found empty by step 9's insert (the
   * rules deleted since) is the same refusal, the transaction rolled back, so
   * no run is stored that checks nothing.
   */
  requireSavedRules?: true;
  /**
   * The public route's minute, admitted before it spent a rule check or
   * an upload: step 5 takes it and admits nothing more, and any refusal
   * before the copy gives it back.
   */
  admission?: RunAdmission;
}

/** The public API's YAML run, as its route has checked it. */
export interface QueueYamlTestRunRequest {
  /** The text, as written (a run's text's limits). Never logged. */
  yaml: string;
  /** Left out, the catalog's default distribution. */
  distribution?: string | undefined;
  /** Left out, the distribution's default version. */
  collectorVersion?: string | undefined;
  /** The caller's own test file: the sample the route stored. */
  inputFileId: string;
  pipeline: string;
  signal: TestRunSignal;
  durationSeconds: number;
  /** The rules, checked, with fresh ids, in their order; `[]` for none. */
  inlineRules: readonly ValidationRuleSnapshot[];
  /** The route's minute, as `QueueTestRunOptions.admission`: never admitted again. */
  admission: RunAdmission;
}

/** What the public route's pre-check looks at (`precheckQueue`). */
export interface QueuePrecheck {
  /** The pin, as a YAML run names it (a version's run names both: its configuration's distribution and its pin). */
  pin: Pick<QueueYamlTestRunRequest, "distribution" | "collectorVersion">;
  /** A version's run with `useSavedRules`: the version, and the pipeline and signal whose saved rules it runs. */
  savedRulesOf?: { configurationId: string; versionId: string; pipeline: string; signal: TestRunSignal };
  /** Whether the run carries rules. */
  hasRules: boolean;
}

export interface ITestRunService {
  /** Queues a run (the order above). Answers it with its place. */
  queue(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    request: QueueTestRunRequest,
    options?: QueueTestRunOptions,
  ): Promise<TestRunWithPlace>;
  /**
   * The public route's cheap refusals, before it stores a sample or spends a
   * rule check, all re-checked when the run is queued: the membership; for
   * `savedRulesOf`, the version as the caller sees it and its saved rules for
   * that pipeline and signal (422 `configuration_invalid` in fixed words when
   * it has none); the pin as a YAML run reads one (`yamlRunPin`, then unknown
   * 400 `collector_version_unknown`, retired 400 `collector_version_retired`);
   * the person's waiting runs in this organization (429 `test_run_queue_full`
   * at TEST_RUNS_WAITING_MAXIMUM_PER_USER); the tester's shared down state
   * (503 `testing_unavailable`); and, for a run with rules, the evaluator's
   * (503 `rules_unavailable`).
   */
  precheckQueue(actor: Actor, organizationId: string, check: QueuePrecheck): Promise<void>;
  /** Queues a YAML run: steps 1 to 3 its own, then the queue's 4 to 11. */
  queueFromYaml(actor: Actor, organizationId: string, request: QueueYamlTestRunRequest): Promise<YamlTestRun>;
  /**
   * A run by its id alone: a version's run the caller can see (their own
   * draft's, or a published configuration's), or their own YAML run; 404
   * `test_run_not_found` otherwise.
   */
  find(actor: Actor, organizationId: string, runId: string): Promise<AnyTestRun>;
  /**
   * `find`'s run's output, open for streaming: 404
   * `test_run_output_not_found` before it has one. The caller must consume
   * or destroy the stream.
   */
  openOutput(actor: Actor, organizationId: string, runId: string): Promise<OpenedTestRunFile>;
  /** The version's runs the caller can see, newest first, at most TEST_RUNS_LIST_MAXIMUM, each with its place. */
  list(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
  ): Promise<TestRunWithPlace<TestRunSummary>[]>;
  /** One of the version's runs the caller can see, in full. */
  get(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    runId: string,
  ): Promise<TestRunWithPlace>;
  /** One of a visible run's files: 404 `test_run_not_found` when the run is invisible or has no such file. */
  openFile(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    runId: string,
    file: TestRunFile,
  ): Promise<OpenedTestRunFile>;
  /**
   * The first TEST_FILE_HEAD_MAXIMUM_BYTES of a visible run's input, for the
   * fixture-shape check before a re-run: the same 404s as openFile's. The
   * caller must consume or destroy the stream.
   */
  openInputHead(
    actor: Actor,
    organizationId: string,
    configurationId: string,
    versionId: string,
    runId: string,
  ): Promise<OpenedTestRunFile>;
}

/** The FileStore's key of one of a run's files, in the caller's active organization. */
function runFileKey(organizationId: string, runId: string, name: TestRunFile): FileKey {
  return { kind: "test-run", organizationId, runId, name };
}

/** The path's ids, canonical, or the 404 each answers for a malformed one. */
function canonicalVersionPath(configurationId: string, versionId: string): { configurationId: string; versionId: string } {
  const configuration = canonicalIdOf(configurationId);
  if (configuration === undefined) throw configurationNotFound();
  const version = canonicalIdOf(versionId);
  if (version === undefined) throw configurationVersionNotFound();
  return { configurationId: configuration, versionId: version };
}

/**
 * The membership, re-read under the organization's lock, then the
 * configuration and its version as the caller sees them: 404
 * `configuration_not_found` for a configuration they can't see (another
 * member's draft, a deleted one), then `configuration_version_not_found`
 * for a version that isn't its own.
 */
async function visibleVersion(
  transaction: TestRunsTransaction,
  actor: Actor,
  configurationId: string,
  versionId: string,
): Promise<{ configuration: Configuration; version: ConfigurationVersionSummary }> {
  await lockAsMember(transaction, actor);
  const configuration = await transaction.configurations.find(configurationId);
  if (!configuration) throw configurationNotFound();
  const version = await transaction.versions.findSummary(configurationId, versionId);
  if (!version) throw configurationVersionNotFound();
  return { configuration, version };
}

/** The pin's refusals: the distribution is always the configuration's. */
async function assertPinOffered(
  transaction: TestRunsTransaction,
  distribution: string,
  collectorVersion: string,
): Promise<void> {
  const state = await transaction.catalogue.findVersionState(distribution, collectorVersion);
  if (state === "unknown") throw collectorVersionUnknown();
  if (state === "deprecated") throw collectorVersionRetired();
}

export function createTestRunService(deps: TestRunServiceDependencies): ITestRunService {
  const { withTransaction, fileStore, limiter, copyPlaces, readDownSince, isRulesEvaluatorDown, organizationVariables, queued, log } =
    deps;

  /** Removes each of a run's files, logging (never throwing) a failure: without its row the folder is unreachable. */
  async function removeRunFiles(organizationId: string, runId: string): Promise<void> {
    for (const name of TEST_RUN_FILE_NAMES) {
      try {
        await fileStore.remove(runFileKey(organizationId, runId, name));
      } catch (error) {
        const { code, syscall } = (error ?? {}) as { code?: unknown; syscall?: unknown };
        log.warn({ code, syscall }, "a test run's file could not be removed");
      }
    }
  }

  /** A run with its place: `ahead` for a waiting run whose place the caller can see (a YAML run has none: test_runs_ahead). */
  type PlacedRun = { run: AnyTestRun; ahead: number | null };

  async function withPlace<Run extends AnyTestRun>(
    transaction: TestRunsTransaction,
    run: Run,
  ): Promise<{ run: Run; ahead: number | null }> {
    if (run.status !== "queued") return { run, ahead: null };
    const ahead = await transaction.runs.aheadOf([run.id]);
    return { run, ahead: ahead.get(run.id) ?? null };
  }

  /**
   * Steps 4 to 11, shared by a version's run and a YAML run, once steps 1 to
   * 3 have read `prepared`.
   */
  async function queuePrepared(actor: Actor, organizationId: string, prepared: PreparedRun): Promise<PlacedRun> {
    const { runId, source, hasRules } = prepared;

    // 4. The shared row, not only this process's view.
    await refundingOnRefusal(prepared.admission, async () => {
      if ((await readDownSince()) !== null) throw testingUnavailable();
      // A run with rules can't be checked while the evaluator is known down;
      // one without rules queues as before.
      if (hasRules && (await isRulesEvaluatorDown())) throw rulesUnavailableAtQueue();
    });

    // 5. The person's minute in this organization. A run from a definition
    // isn't counted: the kind comes from step 3's server-side read, never
    // from the request. The public route's was admitted before it spent
    // anything.
    const admission =
      prepared.admission ?? (source.kind === "definition" ? NOT_COUNTED : limiter.admit(actor.context.userId, organizationId));
    if (!admission.isAdmitted) throw testRunRateLimited(admission.retryAfterSeconds);

    // A refusal before any byte is copied gives the minute back: too many
    // waiting for a place, a full queue at step 6, the variables unreadable or
    // the text too long once they are filled in, an input that isn't there to
    // copy. Once a copy has begun the admission is spent, whatever follows: a
    // failed copy, the re-check's full queue. A burst of counted runs can't
    // then copy more than 20 inputs a minute. A definition's admission counted
    // nothing to give back; its burst is bounded by the places instead: at
    // most TEST_RUN_COPIES_IN_FLIGHT_PER_USER requests hold one at once, and
    // each counts the waiting runs only once it holds it, so at a nearly full
    // queue at most that many copy before the one that fills it commits, and
    // every later one counts a full queue and copies nothing.
    let isCopying = false;
    let queuedRun: PlacedRun;
    try {
      // 6. A place (no transaction is open while it waits), then the person's
      // waiting runs in this organization: refused before 10 MiB is copied
      // for nothing.
      const place = await copyPlaces.take(actor.context.userId, organizationId);
      if (!place.isTaken) throw testRunQueuingBusy(place.retryAfterSeconds);
      try {
        const waiting = await withTransaction(actor.context, (transaction) => transaction.runs.waitingForCurrentUser());
        if (waiting >= TEST_RUNS_WAITING_MAXIMUM_PER_USER) throw testRunQueueFull();

        // 7. The organization's variables, read only for a text that
        // references one, and only to refuse early: measured, never built.
        const measured = await fillInRunText(organizationVariables, organizationId, prepared.yaml, {
          maximumLength: TEST_RUN_YAML_MAXIMUM_LENGTH,
          build: false,
        });
        if (measured.kind === "unavailable") {
          log.warn({ organizationId, reason: measured.reason }, "a test run wasn't queued: the organization's variables couldn't be read");
          throw variablesUnavailableAtQueue();
        }
        if (measured.kind === "too_long") throw filledInTooLongAtQueue();

        // 8. The input, copied into the run's own folder under its id.
        try {
          isCopying = true;
          const copied = await fileStore.copy(source.from, runFileKey(organizationId, runId, "input"));
          if (!copied.found) {
            // Nothing was there to copy, so nothing was.
            isCopying = false;
            throw sourceNotFound(source);
          }

          // 9. One transaction: re-check, then the row and its audit.
          queuedRun = await withTransaction(actor.context, async (transaction) => {
            await prepared.recheck(transaction);
            await transaction.runs.lockQueueForCurrentUser();
            if ((await transaction.runs.waitingForCurrentUser()) >= TEST_RUNS_WAITING_MAXIMUM_PER_USER) {
              throw testRunQueueFull();
            }
            const run = await transaction.runs.create({
              id: runId,
              configurationId: prepared.configurationId,
              versionId: prepared.versionId,
              sourceRunId: source.kind === "rerun" ? source.sourceRunId : null,
              // As written: never a filled-in copy.
              yaml: prepared.yaml,
              pipeline: source.pipeline,
              signal: source.signal,
              durationSeconds: source.durationSeconds,
              collectorDistribution: prepared.distribution,
              collectorVersion: prepared.collectorVersion,
              inputName: source.name,
              inputSizeBytes: copied.sizeBytes,
              breadcrumb: source.breadcrumb,
              // Only the public route's runs; left out, the database's snapshot.
              ...(prepared.inlineRules === undefined ? {} : { inlineRules: prepared.inlineRules }),
            });
            // The saved rules deleted since step 3: no run that checks nothing; the transaction rolls back.
            if (prepared.requireSavedRules && run.validationRules.length === 0) throw noSavedRules();
            await transaction.audit.record({
              action: "test_run.queued",
              actorUserId: actor.context.userId,
              actorEmail: actor.email,
              organizationId,
              subjectType: "test_run",
              subjectId: runId,
              // Ids only: never the text, the input's name, the
              // pipeline's, or a suite's or a definition's. Exactly one
              // source.
              metadata: prepared.auditMetadata,
              ipAddress: actor.ipAddress,
              userAgent: actor.userAgent,
            });
            return withPlace(transaction, run);
          });
        } catch (error) {
          // 10. Nothing committed: the run's files are unreachable, so they go.
          await removeRunFiles(organizationId, runId);
          throw error;
        }
      } finally {
        // Every end gives the place on: a refusal, a failed copy, a queued run, an exception.
        place.release();
      }
    } catch (error) {
      if (!isCopying) admission.refund();
      throw error;
    }

    // 11. Committed: the dispatcher may claim it at once.
    queued.notify();
    return queuedRun;
  }

  const service: ITestRunService = {
    async queue(actor, organizationId, configurationId, versionId, request, options = {}) {
      // Every id the request names, canonical: a malformed one is its
      // source's 404, as an unknown one is.
      const canonical = (id: string | undefined) => (id === undefined ? undefined : canonicalIdOf(id));
      const { inlineRules } = options;

      // 1–3, read in one transaction, committed before anything else; a
      // refusal gives the route's minute back.
      const { path, prepared } = await refundingOnRefusal(options.admission, async () => {
        assertActiveOrganization(actor, organizationId);
        const path = canonicalVersionPath(configurationId, versionId);
        const prepared = await withTransaction(actor.context, async (transaction) => {
          const { configuration } = await visibleVersion(transaction, actor, path.configurationId, path.versionId);
          const distribution = configuration.collectorDistribution;
          await assertPinOffered(transaction, distribution, request.collectorVersion);
          let source: RunSource;
          if ("definitionId" in request) {
            // A definition of the path's version, read as the caller through
            // row-level security.
            const id = canonical(request.definitionId);
            const definition =
              id === undefined ? undefined : await transaction.definitions.findForRun(path.configurationId, path.versionId, id);
            if (!definition) throw testDefinitionNotFound();
            source = {
              kind: "definition",
              from: testDefinitionInputKey(organizationId, definition.inputId),
              name: definition.inputName,
              breadcrumb: {
                suiteId: definition.suiteId,
                suiteName: definition.suiteName,
                definitionId: definition.id,
                definitionName: definition.name,
              },
              audit: { definitionId: definition.id, suiteId: definition.suiteId },
              pipeline: definition.pipeline,
              signal: definition.signal,
              durationSeconds: definition.durationSeconds,
            };
          } else if (request.inputFileId !== undefined) {
            const id = canonical(request.inputFileId);
            const file = id === undefined ? undefined : await transaction.files.findOwn(id);
            if (!file) throw testFileNotFound();
            source = {
              kind: "file",
              from: testInputKey(actor, file.id),
              name: file.fileName,
              ...runOf(request),
              breadcrumb: null,
              audit: { inputFileId: file.id },
            };
          } else if (request.templateId !== undefined) {
            // A live template: its bytes are copied into the run's folder, so
            // deleting it later breaks nothing.
            const id = canonical(request.templateId);
            const template = id === undefined ? undefined : await transaction.templates.findLive(id);
            if (!template) throw testTemplateNotFound();
            source = {
              kind: "template",
              from: { kind: "test-template", templateId: template.id },
              name: template.fileName,
              ...runOf(request),
              breadcrumb: null,
              audit: { templateId: template.id },
            };
          } else {
            // A re-run: the source is re-read here, as the caller, so
            // row-level security and the repository's own rule both decide
            // whether they may see it. Its breadcrumb travels with it, but
            // only from a run of the path's own configuration and version: a
            // draft's suite and definition names never reach another
            // configuration's or version's runs.
            const id = canonical(request.sourceRunId);
            const sourceRun = id === undefined ? undefined : await transaction.runs.find(id);
            if (!sourceRun) throw testRunNotFound();
            const isSameVersion = sourceRun.configurationId === path.configurationId && sourceRun.versionId === path.versionId;
            source = {
              kind: "rerun",
              from: runFileKey(organizationId, sourceRun.id, "input"),
              name: sourceRun.inputName,
              ...runOf(request),
              sourceRunId: sourceRun.id,
              breadcrumb:
                !isSameVersion ||
                sourceRun.suiteId === null ||
                sourceRun.suiteName === null ||
                sourceRun.definitionId === null ||
                sourceRun.definitionName === null
                  ? null
                  : {
                      suiteId: sourceRun.suiteId,
                      suiteName: sourceRun.suiteName,
                      definitionId: sourceRun.definitionId,
                      definitionName: sourceRun.definitionName,
                    },
              audit: { sourceRunId: sourceRun.id },
            };
          }
          // Whether the run would carry rules, as the caller sees them: the
          // insert at step 9 takes the snapshot. The public route's run
          // carries the rules it passes, and only those.
          const hasRules =
            inlineRules === undefined
              ? await transaction.runs.hasValidationRules(path.versionId, source.pipeline, source.signal)
              : inlineRules.length > 0;
          // useSavedRules with none: refused before anything is copied or counted.
          if (options.requireSavedRules === true && inlineRules === undefined && !hasRules) throw noSavedRules();
          return { distribution, source, hasRules, runId: await transaction.runs.nextId() };
        });
        return { path, prepared };
      });
      const placed = await queuePrepared(actor, organizationId, {
        ...prepared,
        yaml: request.yaml,
        collectorVersion: request.collectorVersion,
        configurationId: path.configurationId,
        versionId: path.versionId,
        inlineRules,
        requireSavedRules: options.requireSavedRules === true && inlineRules === undefined,
        admission: options.admission,
        async recheck(transaction) {
          const { configuration } = await visibleVersion(transaction, actor, path.configurationId, path.versionId);
          await assertPinOffered(transaction, configuration.collectorDistribution, request.collectorVersion);
        },
        auditMetadata: { configurationId: path.configurationId, versionId: path.versionId, ...prepared.source.audit },
      });
      const { run } = placed;
      // A version's run: its row names its configuration (the insert wrote it).
      if (run.configurationId === null) throw new Error("a version's run was stored without its configuration");
      return { run, ahead: placed.ahead };
    },

    async precheckQueue(actor, organizationId, check) {
      assertActiveOrganization(actor, organizationId);
      await withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        const saved = check.savedRulesOf;
        if (saved !== undefined) {
          const path = canonicalVersionPath(saved.configurationId, saved.versionId);
          await visibleVersion(transaction, actor, path.configurationId, path.versionId);
          if (!(await transaction.runs.hasValidationRules(path.versionId, saved.pipeline, saved.signal))) {
            throw noSavedRules();
          }
        }
        const pin = await yamlRunPin(transaction, check.pin);
        await assertPinOffered(transaction, pin.distribution, pin.collectorVersion);
        // A full queue before the route spends its minute, a rule check or an upload; step 9 counts it again.
        if ((await transaction.runs.waitingForCurrentUser()) >= TEST_RUNS_WAITING_MAXIMUM_PER_USER) throw testRunQueueFull();
      });
      if ((await readDownSince()) !== null) throw testingUnavailable();
      if (check.hasRules && (await isRulesEvaluatorDown())) throw rulesUnavailableAtQueue();
    },

    async queueFromYaml(actor, organizationId, request) {
      const fileId = canonicalIdOf(request.inputFileId);

      // 1–3, read in one transaction, committed before anything else: the
      // membership, the pin (the catalog's defaults for what isn't named),
      // and the caller's own file. A refusal gives the route's minute back.
      const prepared = await refundingOnRefusal(request.admission, () => {
        assertActiveOrganization(actor, organizationId);
        return withTransaction(actor.context, async (transaction) => {
          await lockAsMember(transaction, actor);
          const pin = await yamlRunPin(transaction, request);
          await assertPinOffered(transaction, pin.distribution, pin.collectorVersion);
          const file = fileId === undefined ? undefined : await transaction.files.findOwn(fileId);
          if (!file) throw testFileNotFound();
          const source: RunSource = {
            kind: "file",
            from: testInputKey(actor, file.id),
            name: file.fileName,
            pipeline: request.pipeline,
            signal: request.signal,
            durationSeconds: request.durationSeconds,
            breadcrumb: null,
            audit: { inputFileId: file.id },
          };
          return { ...pin, source, runId: await transaction.runs.nextId() };
        });
      });
      const placed = await queuePrepared(actor, organizationId, {
        ...prepared,
        hasRules: request.inlineRules.length > 0,
        yaml: request.yaml,
        configurationId: null,
        versionId: null,
        inlineRules: request.inlineRules,
        requireSavedRules: false,
        admission: request.admission,
        async recheck(transaction) {
          await lockAsMember(transaction, actor);
          await assertPinOffered(transaction, prepared.distribution, prepared.collectorVersion);
        },
        // Ids only, and where it came from: never the text or the sample.
        auditMetadata: { source: "yaml", inputFileId: prepared.source.audit.inputFileId },
      });
      const { run } = placed;
      if (run.configurationId !== null) throw new Error("a YAML run was stored with a configuration");
      return run;
    },

    async find(actor, organizationId, runId) {
      assertActiveOrganization(actor, organizationId);
      const id = canonicalIdOf(runId);
      if (id === undefined) throw testRunNotFound();
      return withTransaction(actor.context, async (transaction) => {
        await lockAsMember(transaction, actor);
        const run = (await transaction.runs.find(id)) ?? (await transaction.runs.findYamlRun(id));
        if (!run) throw testRunNotFound();
        return run;
      });
    },

    async openOutput(actor, organizationId, runId) {
      const run = await service.find(actor, organizationId, runId);
      // The dispatcher writes a run's files before it finishes the row: no output, no read.
      if (run.outputSizeBytes === null) throw testRunOutputNotFound();
      const opened = await fileStore.read(runFileKey(organizationId, run.id, "output"));
      if (!opened.found) throw testRunOutputNotFound();
      return { sizeBytes: opened.sizeBytes, stream: opened.stream };
    },

    async list(actor, organizationId, configurationId, versionId) {
      assertActiveOrganization(actor, organizationId);
      const path = canonicalVersionPath(configurationId, versionId);
      return withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, path.configurationId, path.versionId);
        const runs = await transaction.runs.listForVersion(path.configurationId, path.versionId, TEST_RUNS_LIST_MAXIMUM);
        const waitingIds = runs.filter((run) => run.status === "queued").map((run) => run.id);
        const ahead = await transaction.runs.aheadOf(waitingIds);
        return runs.map((run) => ({ run, ahead: run.status === "queued" ? (ahead.get(run.id) ?? null) : null }));
      });
    },

    async get(actor, organizationId, configurationId, versionId, runId) {
      assertActiveOrganization(actor, organizationId);
      const path = canonicalVersionPath(configurationId, versionId);
      const id = canonicalIdOf(runId);
      return withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, path.configurationId, path.versionId);
        const run = id === undefined ? undefined : await transaction.runs.findInVersion(path.configurationId, path.versionId, id);
        if (!run) throw testRunNotFound();
        return withPlace(transaction, run);
      });
    },

    async openInputHead(actor, organizationId, configurationId, versionId, runId) {
      const opened = await service.openFile(actor, organizationId, configurationId, versionId, runId, "input");
      return {
        sizeBytes: Math.min(opened.sizeBytes, TEST_FILE_HEAD_MAXIMUM_BYTES),
        stream: firstBytes(opened.stream, TEST_FILE_HEAD_MAXIMUM_BYTES),
      };
    },

    async openFile(actor, organizationId, configurationId, versionId, runId, file) {
      assertActiveOrganization(actor, organizationId);
      const path = canonicalVersionPath(configurationId, versionId);
      const id = canonicalIdOf(runId);
      const run = await withTransaction(actor.context, async (transaction) => {
        await visibleVersion(transaction, actor, path.configurationId, path.versionId);
        const found = id === undefined ? undefined : await transaction.runs.findInVersion(path.configurationId, path.versionId, id);
        if (!found) throw testRunNotFound();
        return found;
      });
      // A run's files are there exactly as its row says (the dispatcher
      // writes them before it finishes the row): no output, no read.
      if (file === "output" && run.outputSizeBytes === null) throw testRunFileNotFound();
      if (file === "decoded-input" && run.decodedInputSizeBytes === null) throw testRunFileNotFound();
      const opened = await fileStore.read(runFileKey(organizationId, run.id, file));
      if (!opened.found) throw testRunFileNotFound();
      return { sizeBytes: opened.sizeBytes, stream: opened.stream };
    },
  };
  return service;
}
