import { TEST_FILE_EXTENSIONS, TEST_FILE_MAXIMUM_BYTES, TEST_SAMPLE_MAXIMUM_BYTES, lastExtensionOf } from "@telflo/contracts";
import { ApiError, isSessionEnded } from "~/lib/api-client.js";

/*
 * The Testing tab's own checks before a file is sent, and how a failure is
 * put to the person. The API checks the same and answers 413 and 415 with its
 * own words. An upload's size and any file's type say what the API's 413 and
 * 415 say, so the check and the API agree; a pasted sample's size keeps its
 * own words (the API's 413 for a sample says "The file is larger than 1
 * MiB.").
 */

/** A file picker's filter: the six extensions and their types (the upload panel's and the test template dialog's). */
export const TEST_FILE_ACCEPT =
  ".json,.ndjson,.yaml,.yml,.txt,.log,application/json,application/x-ndjson,application/ndjson,application/x-yaml,text/yaml,text/plain";

/** A held Play's title. */
export const HELD_TITLE = "Another run is in progress";

/** An upload past 10 MiB: the API's 413 words. */
export const FILE_TOO_LARGE_MESSAGE = "The file is larger than 10 MiB.";

/** A pasted sample past 1 MiB of UTF-8. */
export const SAMPLE_TOO_LARGE_MESSAGE = "Sample exceeds the 1MB limit";

/** A name whose last extension isn't one of the six: the API's 415 words. */
export const FILE_TYPE_UNSUPPORTED_MESSAGE = "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used.";

/** Whether `name`'s last extension is one of the six (the type is the name's, never sniffed). */
export function hasTestFileExtension(name: string): boolean {
  const extension = lastExtensionOf(name);
  return extension !== undefined && (TEST_FILE_EXTENSIONS as readonly string[]).includes(extension);
}

/** Why `file` can't be uploaded, or null when it can: its type, then its size. */
export function uploadRefusal(file: File): string | null {
  if (!hasTestFileExtension(file.name)) return FILE_TYPE_UNSUPPORTED_MESSAGE;
  if (file.size > TEST_FILE_MAXIMUM_BYTES) return FILE_TOO_LARGE_MESSAGE;
  return null;
}

/** Why a sample of `text`, saved as `fileName`, can't be saved, or null when it can: its type, then its size in UTF-8. */
export function sampleRefusal(text: string, fileName: string): string | null {
  if (!hasTestFileExtension(fileName)) return FILE_TYPE_UNSUPPORTED_MESSAGE;
  if (new TextEncoder().encode(text).length > TEST_SAMPLE_MAXIMUM_BYTES) return SAMPLE_TOO_LARGE_MESSAGE;
  return null;
}

/**
 * Codes whose message says nothing more than `fallback` would: a body the
 * client sent wrong, an answer it couldn't read.
 */
const UNHELPFUL_CODES = new Set(["invalid_request", "unexpected_response"]);

/**
 * What a failed request puts to the person: nothing when the session ended
 * (the session-ended handler is taking the browser to sign in); the API's
 * own words for its refusals (503 `testing_unavailable`, 429
 * `test_run_rate_limited` and `test_run_queue_full`, 400
 * `collector_version_retired` and `collector_version_unknown`, 413, 415, and
 * the rest), and an Error's own message; else `fallback`, the words for the
 * action.
 */
export function failureMessage(error: unknown, fallback: string): string | null {
  if (isSessionEnded(error)) return null;
  if (error instanceof ApiError) return UNHELPFUL_CODES.has(error.code) ? fallback : error.message;
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}
