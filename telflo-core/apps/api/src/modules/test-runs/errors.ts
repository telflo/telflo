import {
  COLLECTOR_VERSION_RETIRED_MESSAGE,
  RULES_UNAVAILABLE_AT_QUEUE_MESSAGE,
  PUBLIC_TEST_RUN_NO_SAVED_RULES_MESSAGE,
  CONFIGURATION_INVALID_MESSAGE,
  type ConfigurationErrorCode,
  TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE,
  TEST_RUN_OUTPUT_NOT_FOUND_MESSAGE,
  TEST_RUN_QUEUE_FULL_MESSAGE,
  TEST_RUN_QUEUING_BUSY_MESSAGE,
  TESTING_UNAVAILABLE_MESSAGE,
  VARIABLES_UNAVAILABLE_MESSAGE,
  type TestingErrorCode,
  type ValidationRulesErrorCode,
  type VariableErrorCode,
} from "@telflo/contracts";
import { AppError } from "../../errors.js";

/*
 * The testing endpoints' own refusals. The organization's
 * (`organization_not_found`) and the configurations'
 * (`configuration_not_found`, `configuration_version_not_found`,
 * `collector_version_unknown`) are those modules', so every endpoint answers
 * them alike. No message names a file, a name or the text.
 */

/**
 * A test file the caller can't use: unknown, another person's (their own file
 * only, admins included), another organization's, or an id that isn't a
 * canonical UUID, all alike.
 */
export function testFileNotFound(): AppError {
  return new AppError("test_file_not_found" satisfies TestingErrorCode, "Test file not found", 404);
}

/**
 * An upload over 10 MiB, or a sample over 1 MiB. Whatever was written of it
 * is removed first.
 */
export function testFileTooLarge(maximumBytes: number): AppError {
  const size = maximumBytes >= 1_048_576 ? `${maximumBytes / 1_048_576} MiB` : `${maximumBytes} bytes`;
  return new AppError(
    "test_file_too_large" satisfies TestingErrorCode,
    `The file is larger than ${size}.`,
    413,
  );
}

/**
 * A file whose name's last extension isn't one of the six, or a sample whose
 * final name isn't. Nothing is written. 415: the file's type is what is
 * refused.
 */
export function testFileTypeUnsupported(): AppError {
  return new AppError(
    "test_file_type_unsupported" satisfies TestingErrorCode,
    "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used.",
    415,
  );
}

/**
 * A run the caller can't see: unknown, another member's draft's, a deleted
 * configuration's, another organization's, another version's, or an id
 * that isn't a canonical UUID, all alike. Also a run's file it doesn't
 * have (no output, no decoded input), and a re-run's source whose input is
 * gone.
 */
export function testRunNotFound(): AppError {
  return new AppError("test_run_not_found" satisfies TestingErrorCode, "Test run not found", 404);
}

/** A run's file it never stored (no output, no decoded input): the run's own code, its own message. */
export function testRunFileNotFound(): AppError {
  return new AppError("test_run_not_found" satisfies TestingErrorCode, "This run has no such file.", 404);
}

/**
 * The public API's read of a run's output before there is one (still
 * waiting or running, or a run that stored none): 404
 * `test_run_output_not_found`, its own code, so a client polls on.
 */
export function testRunOutputNotFound(): AppError {
  return new AppError("test_run_output_not_found" satisfies TestingErrorCode, TEST_RUN_OUTPUT_NOT_FOUND_MESSAGE, 404);
}

/**
 * A public run with `useSavedRules` on a version with no saved rules for
 * its pipeline and signal. 422
 * `configuration_invalid`, its one error in fixed words, at the text's root:
 * no code of a request's own fits (`validation_pipeline_not_found` is a
 * path's 404).
 */
export function noSavedRules(): AppError {
  return new AppError("configuration_invalid" satisfies ConfigurationErrorCode, CONFIGURATION_INVALID_MESSAGE, 422, {
    errors: [{ message: PUBLIC_TEST_RUN_NO_SAVED_RULES_MESSAGE, componentPath: null }],
  });
}

/** The caller's 20 runs a minute are used up. `retryAfterSeconds` is when their window ends. */
export function testRunRateLimited(retryAfterSeconds: number): AppError {
  return new AppError(
    "test_run_rate_limited" satisfies TestingErrorCode,
    "Too many test runs in the last minute. Try again shortly.",
    429,
    undefined,
    { "retry-after": retryAfterSeconds },
  );
}

/**
 * TEST_RUN_COPIES_WAITING_PER_USER of the caller's queue requests already
 * wait for a copy place in this organization: the minute's code and a
 * retry-after, with words of its own, since a run from a definition isn't
 * counted against the minute.
 */
export function testRunQueuingBusy(retryAfterSeconds: number): AppError {
  return new AppError(
    "test_run_rate_limited" satisfies TestingErrorCode,
    TEST_RUN_QUEUING_BUSY_MESSAGE,
    429,
    undefined,
    { "retry-after": retryAfterSeconds },
  );
}

/**
 * The caller has TEST_RUNS_WAITING_MAXIMUM_PER_USER runs waiting already, in
 * this organization: the words a Play all's toast quotes.
 */
export function testRunQueueFull(): AppError {
  return new AppError("test_run_queue_full" satisfies TestingErrorCode, TEST_RUN_QUEUE_FULL_MESSAGE, 429);
}

/** The tester is counted down: refused at once, nothing queued. */
export function testingUnavailable(): AppError {
  return new AppError("testing_unavailable" satisfies TestingErrorCode, TESTING_UNAVAILABLE_MESSAGE, 503);
}

/**
 * A run that would carry rules, queued while the OTTL evaluator is known
 * down, in fixed words. A run without rules queues as before.
 */
export function rulesUnavailableAtQueue(): AppError {
  return new AppError("rules_unavailable" satisfies ValidationRulesErrorCode, RULES_UNAVAILABLE_AT_QUEUE_MESSAGE, 503);
}

/** A pin the catalogue has deprecated, in fixed words. */
export function collectorVersionRetired(): AppError {
  return new AppError("collector_version_retired" satisfies TestingErrorCode, COLLECTOR_VERSION_RETIRED_MESSAGE, 400);
}

/**
 * A multipart body that isn't the contract's: not multipart, the parts out
 * of order or missing, an extra part, a field over its size, an empty or
 * over-long name. The envelope's shared code and message, as a JSON body
 * that fails its schema gets; no details (they could echo a name).
 */
export function invalidUpload(): AppError {
  return new AppError("invalid_request", "The request was not valid.", 400);
}

/**
 * The organization's variables couldn't be read from the opamp-server when a
 * run whose text references one was queued: 503, nothing queued. The variables
 * routes' and Validate's words: never a name or a value.
 */
export function variablesUnavailableAtQueue(): AppError {
  return new AppError("variables_unavailable" satisfies VariableErrorCode, VARIABLES_UNAVAILABLE_MESSAGE, 503);
}

/**
 * A run whose text is too long once the organization's variables are filled
 * in (counted, never built): 400, nothing queued. Its own code and the
 * sentence the dispatcher's failure gives, not the shared
 * `invalid_request`: the request is well formed, the values make it too
 * long. Fixed words: never a name or a value.
 */
export function filledInTooLongAtQueue(): AppError {
  return new AppError("filled_in_too_long" satisfies TestingErrorCode, TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE, 400);
}
