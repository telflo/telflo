import {
  RULES_UNAVAILABLE_RUN_MESSAGE,
  TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH,
  TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE,
  TEST_RUN_FINDING_COMPONENT_MAXIMUM_LENGTH,
  TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH,
  TEST_RUN_LOGS_MAXIMUM_LENGTH,
  TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH,
  VARIABLES_UNAVAILABLE_RUN_MESSAGE,
} from "@telflo/contracts";
import type { TesterUnavailableReason, TestRunAnswer } from "../../otelcol-testing/client.js";
import type { TestRunErrorCode } from "../../otelcol-testing/schemas.js";
import type { OttlEvaluatorResult } from "../../ottl-evaluator/schemas.js";

/*
 * What the dispatcher stores on a finished run (D14a decision 1; Preflight
 * ruling 7; Rulings 24 and 36): the `p_results` object test_runs_finish
 * takes, whose keys name the run's result columns (migration 028).
 *
 * - A tester's answer is stored as it came, with every string cut to the
 *   contract's bounds (@telflo/contracts' test-runs.ts: the text it ran
 *   1 MiB, the logs 256 KiB, a finding's message 4,096 and its component
 *   1,024, an error's message 2,000), counted in code points as the
 *   contract, the tester and the table all count them (D14a Ruling 39),
 *   never splitting a pair. A NUL or a lone surrogate, which Postgres can't
 *   store in text or jsonb, becomes U+FFFD.
 *   Numbers and booleans stay JSON numbers and booleans (Ruling 24).
 * - Every other ending is a failure with a code and a fixed message, built
 *   here from the outcome alone, never from an error's own text: a Node or
 *   a fetch error can name a path or quote the request, and a stored message
 *   is shown to whoever can see the run. The only value in one is a
 *   collector version, which the catalogue's foreign key holds to
 *   `major.minor.patch`.
 */

/** The result columns test_runs_finish fills, as JSON. */
export interface TestRunResults {
  strategy?: string | null;
  kwok_enabled?: boolean | null;
  mutated_yaml?: string | null;
  mutations?: unknown[] | null;
  compatibility?: unknown[] | null;
  logs?: string | null;
  timings?: Record<string, number | null> | null;
  output_size_bytes?: number | null;
  output_truncated?: boolean | null;
  decoded_input_size_bytes?: number | null;
  decoded_input_truncated?: boolean | null;
  error_code: string | null;
  error_message: string | null;
  /**
   * The rules' results (migration 1700000000030, D15a decision 15): one per
   * rule of the run's snapshot, in its order, each with a string id and a
   * boolean passed (D15a Ruling 32). Left out (null) when the rules weren't
   * checked.
   */
  validation_results?: unknown[] | null;
}

/** A failure the dispatcher stores: an error code (the table's format) and a fixed message for the person. */
export interface TestRunFailure {
  code: string;
  message: string;
}

/** The fixed failures (each message is the whole message stored). */
export const TEST_RUN_FAILURES = {
  /** The API stopped mid-run, or the reaper found the run past its lease (decision 18, Preflight ruling 7). */
  interrupted: { code: "interrupted", message: "The run was interrupted. Run it again." },
  /** No answer within the client's 74 + d s, after the run was sent: never released (Preflight ruling 7). */
  testerTimeout: { code: "tester_timeout", message: "The tester didn't answer in time. Run it again." },
  /** The connection broke off after the run was sent: never released. */
  testerConnectionLost: { code: "tester_connection_lost", message: "The connection to the tester was lost. Run it again." },
  /** A 401, a status the run's contract doesn't expect, a reply that can't be read: a deployment's to fix (logged by the client). */
  testerError: { code: "tester_error", message: "The tester couldn't run this test. Try again later." },
  /** The run's own copy of its input is missing, too large or unreadable. */
  inputUnavailable: { code: "input_unavailable", message: "The run's input couldn't be read." },
  /** The answer's files couldn't be written to the FileStore. */
  storageFailed: { code: "storage_failed", message: "The run's results couldn't be saved. Run it again." },
  /** Anything else that went wrong in the dispatcher. */
  internalError: { code: "internal_error", message: "Something went wrong running the test. Run it again." },
  /**
   * The OTTL evaluator couldn't check the run's rules (D15a decision 3):
   * unreachable, refused, busy twice, answered wrongly, or too little of the
   * lease left to ask it. The run ends Error with the tester's answer kept.
   */
  rulesUnavailable: { code: "rules_unavailable", message: RULES_UNAVAILABLE_RUN_MESSAGE },
  /**
   * The organization's variables couldn't be read when the run was about to
   * be sent (D20 decision 13; Preflight ruling 28): nothing was sent. The
   * queue's words with "Run it again" (Ruling 78).
   */
  variablesUnavailable: { code: "variables_unavailable", message: VARIABLES_UNAVAILABLE_RUN_MESSAGE },
  /**
   * With the values read at dispatch filled in, the text is longer than a
   * run's may be (the values changed since the queue): nothing was sent.
   * The queue's code and words (Ruling 78).
   */
  filledInTooLong: { code: "filled_in_too_long", message: TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE },
} as const satisfies Record<string, TestRunFailure>;

/** 503 `version_unavailable` (Preflight ruling 13): an offered version this tester doesn't hold. */
export function versionUnavailableFailure(collectorVersion: string): TestRunFailure {
  return {
    code: "version_unavailable",
    message: `Collector v${collectorVersion} isn't installed in the tester. Pick another version or try again later.`,
  };
}

/**
 * 409 `version_retired` from the tester (Ruling 50): its catalogue retires a
 * version the platform's still offers.
 */
export function versionRetiredFailure(collectorVersion: string): TestRunFailure {
  return {
    code: "version_retired",
    message: `Collector v${collectorVersion} is no longer offered by the tester. Pick a newer collector version.`,
  };
}

/**
 * 400 `version_unknown` from the tester (Ruling 51): its catalogue doesn't
 * list the version. Its own code: unlike `version_unavailable` (an offered
 * version missing from the image, which may come back), nothing in this
 * tester will run it, and its words don't say the version is retired.
 */
export function versionUnknownFailure(collectorVersion: string): TestRunFailure {
  return {
    code: "version_unknown",
    message: `Collector v${collectorVersion} isn't available in the tester. Pick another collector version.`,
  };
}

/**
 * The failure stored for a run the tester didn't answer and that may not be
 * released (`isReleasable` false): a timeout or a broken connection after it
 * was sent, the API shutting down, a version the tester lacks or no longer
 * offers, or what a deployment must fix.
 */
export function unavailableFailure(reason: TesterUnavailableReason, collectorVersion: string): TestRunFailure {
  switch (reason) {
    case "version_unavailable":
      return versionUnavailableFailure(collectorVersion);
    case "version_retired":
      return versionRetiredFailure(collectorVersion);
    case "version_unknown":
      return versionUnknownFailure(collectorVersion);
    case "timeout":
      return TEST_RUN_FAILURES.testerTimeout;
    case "network":
      return TEST_RUN_FAILURES.testerConnectionLost;
    case "aborted":
      return TEST_RUN_FAILURES.interrupted;
    default:
      // unauthorized, malformed_reply, oversized_reply, http_status,
      // invalid_request; and, were one ever not released, busy, starting,
      // tester_unavailable, connection_refused, name_not_resolved and not_sent.
      return TEST_RUN_FAILURES.testerError;
  }
}

/** The results of a run that ends with `failure` and nothing else. */
export function failureResults(failure: TestRunFailure): TestRunResults {
  return { error_code: failure.code, error_message: storableText(failure.message, TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH) };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** U+FFFD, what an unstorable character becomes. */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * `text` as Postgres can store it, in text and in jsonb: each NUL and each
 * lone surrogate becomes U+FFFD (one code point for one), then cut to at
 * most `maximum` code points (D14a Ruling 39: the contract's, the tester's
 * and the table's measure), a pair kept or dropped whole.
 */
export function storableText(text: string, maximum: number): string {
  const clean = text.replaceAll(String.fromCharCode(0), REPLACEMENT_CHARACTER).replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
  // Never more code points than units.
  if (clean.length <= maximum) return clean;
  let units = 0;
  for (let points = 0; points < maximum && units < clean.length; points += 1) {
    const unit = clean.charCodeAt(units);
    // Every high surrogate left is followed by its low one.
    units += unit >= 0xd800 && unit <= 0xdbff ? 2 : 1;
  }
  return clean.slice(0, units);
}

/** How deep a finding's `details` is kept; anything deeper becomes null (the tester's are one or two levels). */
const MAXIMUM_DETAILS_DEPTH = 32;

/** `value` (parsed JSON) with every string and key storable, uncut; null past MAXIMUM_DETAILS_DEPTH. */
function storableJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return storableText(value, Number.MAX_SAFE_INTEGER);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAXIMUM_DETAILS_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => storableJson(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[storableText(key, Number.MAX_SAFE_INTEGER)] = storableJson(item, depth + 1);
  }
  return copy;
}

/** The sizes of the answer's files as the FileStore wrote them, or null for a file the answer didn't carry. */
export interface StoredAnswerFiles {
  outputSizeBytes: number | null;
  decodedInputSizeBytes: number | null;
}

/**
 * The results of a run the tester ran (`succeeded`, or `failed` with its
 * `error`), its files already written. The files' sizes are the stored
 * files' own, never the tester's `bytesOnDisk` (which may pass 10 MiB when
 * the output was cut).
 */
export function answerResults(
  answer: TestRunAnswer,
  files: StoredAnswerFiles,
  error?: { code: TestRunErrorCode; message: string },
): TestRunResults {
  return {
    strategy: answer.strategy,
    kwok_enabled: answer.kwokEnabled,
    mutated_yaml: answer.mutatedYaml === null ? null : storableText(answer.mutatedYaml, TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH),
    mutations: answer.mutations.map((mutation) => ({
      id: mutation.id,
      severity: mutation.severity,
      message: storableText(mutation.message, TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH),
      details: storableJson(mutation.details),
    })),
    compatibility: answer.compatibility.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      component: storableText(issue.component, TEST_RUN_FINDING_COMPONENT_MAXIMUM_LENGTH),
      message: storableText(issue.message, TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH),
      details: storableJson(issue.details),
    })),
    logs: storableText(answer.logs, TEST_RUN_LOGS_MAXIMUM_LENGTH),
    timings: {
      totalMs: answer.timings.totalMs,
      readyMs: answer.timings.readyMs,
      informerMs: answer.timings.informerMs,
      replayMs: answer.timings.replayMs,
      holdMs: answer.timings.holdMs,
      stopMs: answer.timings.stopMs,
    },
    output_size_bytes: files.outputSizeBytes,
    output_truncated: files.outputSizeBytes === null ? null : (answer.output?.truncated ?? false),
    decoded_input_size_bytes: files.decodedInputSizeBytes,
    decoded_input_truncated: files.decodedInputSizeBytes === null ? null : (answer.decodedInput?.truncated ?? false),
    error_code: error === undefined ? null : error.code,
    error_message: error === undefined ? null : storableText(error.message, TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH),
  };
}

/**
 * The rules' results as the run stores them (D15a decision 15): the
 * evaluator's, already one per rule in the snapshot's order with its id (the
 * client matched them by id), each with exactly the contract's fields
 * (`id`, `passed`, `error`, `advisory`, `detail`), and every string
 * storable: a snippet of an output may hold a NUL, which jsonb can't.
 */
export function validationResults(results: readonly OttlEvaluatorResult[]): unknown[] {
  return results.map((result) => ({
    id: result.id,
    passed: result.passed,
    error: result.error === null ? null : storableText(result.error, Number.MAX_SAFE_INTEGER),
    advisory: result.advisory === null ? null : storableText(result.advisory, Number.MAX_SAFE_INTEGER),
    detail: storableJson(result.detail),
  }));
}
