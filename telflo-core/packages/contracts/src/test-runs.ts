import { z } from "zod";
import { CollectorVersionNumberSchema } from "./collector-distributions.js";
import { hasUnstorableCharacter, hasYamlControlCharacter } from "./configurations.js";
import {
  codePointLength,
  TEST_RUN_PIPELINE_MAXIMUM_LENGTH,
  TEST_RUN_SIGNALS,
  TestRunPipelineSchema,
  type TestRunSignal,
} from "./test-run-pipelines.js";
import {
  VALIDATION_RULES_PER_PIPELINE_MAXIMUM,
  ValidationRuleResultSchema,
  ValidationRuleSnapshotSchema,
} from "./validation-rules.js";

// Moved to test-run-pipelines.ts so validation-rules.ts can use them
// without importing this file, which imports it (D15a Task 7): exported from
// here as before.
export { codePointLength, TEST_RUN_PIPELINE_MAXIMUM_LENGTH, TEST_RUN_SIGNALS, TestRunPipelineSchema, type TestRunSignal };

/*
 * The test files and test runs endpoints (D14a decisions 7, 8, 16, 18 to 20
 * and 28; Preflight rulings 10, 13 and 15), under
 * /api/v1/organizations/:organizationId:
 *
 * - `GET /test-files`, `POST /test-files` (an upload) and
 *   `POST /test-files/samples` (a pasted sample), both multipart/form-data
 *   with the parts `displayName`, `description` and `file`, in that order;
 *   `DELETE /test-files/:fileId`; `GET /test-files/:fileId/head`, the first
 *   TEST_FILE_HEAD_MAXIMUM_BYTES of the caller's own file, as
 *   application/octet-stream (D14a Ruling 43);
 * - under `/configurations/:configurationId/versions/:versionId`:
 *   `POST /test-runs` (queue one), `GET /test-runs` (the version's newest
 *   100), `GET /test-runs/:runId` and
 *   `GET /test-runs/:runId/files/:file` (`input`, `output` or
 *   `decoded-input`, streamed as application/octet-stream), and
 *   `GET /test-runs/:runId/files/input/head`, the first
 *   TEST_FILE_HEAD_MAXIMUM_BYTES of a visible run's input, as
 *   application/octet-stream (D14a Ruling 46).
 *
 * A test file's names, its description, a run's text, its logs and its
 * input's name are private text (ADR 0024): they travel only in these JSON
 * bodies, never in a URL, a log line or an audit row.
 *
 * Every string a response carries has a bound, but for the strings inside a
 * finding's `details`, which are unbounded here as in the tester's contract
 * (the whole answer is bounded by its 32 MiB). The results' bounds are the
 * tester's contract's (services/otelcol-testing/openapi.yaml) or tighter:
 * the dispatcher (Task 8) cuts what it stores to them, so a stored run
 * always serialises (D14a Ruling 24). They count code points, as the tester
 * (Python's `len`, JSON Schema's `maxLength`) and Postgres (`char_length`)
 * do, never UTF-16 units, as zod's `.max` does (D14a Ruling 39): a run whose
 * logs hold emoji would pass both and then fail its response, every time.
 */

/** An upload's most bytes: 10 MiB (decision 16), as the table's check says. */
export const TEST_FILE_MAXIMUM_BYTES = 10_485_760;

/** A pasted sample's most bytes: 1 MiB of UTF-8 (decision 16), counted as bytes. */
export const TEST_SAMPLE_MAXIMUM_BYTES = 1_048_576;

/** A test file's display name, after trimming: 1 to 200 characters (migration 028's check). */
export const TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH = 200;

/** A test file's own name (an upload's, or a sample's `name.json`): 1 to 255 characters, as a run's input name. */
export const TEST_FILE_NAME_MAXIMUM_LENGTH = 255;

/** A test file's description, after trimming: at most 2,000 characters; `''` is none. */
export const TEST_FILE_DESCRIPTION_MAXIMUM_LENGTH = 2_000;

/**
 * `GET /test-files/:fileId/head` (D14a Ruling 43): the first 64 KiB of the
 * caller's own file in this organization (the whole file when it is
 * smaller), streamed as application/octet-stream with `nosniff` and
 * `cache-control: no-store`, under no file name. Anyone else's file, or one
 * that isn't there, is 404 `test_file_not_found`.
 *
 * `GET …/test-runs/:runId/files/input/head` (D14a Ruling 46) answers the
 * same bound of a run's input, for any run the caller can see, as the
 * run's own file reads do: a run that isn't there or isn't theirs to see is
 * 404 `test_run_not_found` (or the configuration's or version's 404).
 */
export const TEST_FILE_HEAD_MAXIMUM_BYTES = 65_536;

/** A content type, as the table's check bounds it. The API sets it from TEST_FILE_CONTENT_TYPES only. */
export const TEST_FILE_CONTENT_TYPE_MAXIMUM_LENGTH = 255;

/** The most files `GET /test-files` lists, newest first. */
export const TEST_FILES_LIST_MAXIMUM = 1_000;

/**
 * The extensions a test file may have (decision 16), lower case, and the
 * content type each is stored with. The type comes from the name's last extension alone (Preflight
 * ruling 10): never the browser's MIME type, and never a sniff of the bytes
 * (UTF-16 holds NULs).
 */
export const TEST_FILE_CONTENT_TYPES = {
  json: "application/json",
  ndjson: "application/x-ndjson",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  txt: "text/plain",
  log: "text/plain",
} as const satisfies Record<string, string>;

export type TestFileExtension = keyof typeof TEST_FILE_CONTENT_TYPES;

export const TEST_FILE_EXTENSIONS = Object.keys(TEST_FILE_CONTENT_TYPES) as TestFileExtension[];

/**
 * The lower-cased last extension of `name` (the text after the last `.`, when
 * that dot is neither the first nor the last character), or undefined when
 * there is none.
 */
export function lastExtensionOf(name: string): string | undefined {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot >= name.length - 1) return undefined;
  return name.slice(lastDot + 1).toLowerCase();
}

/** The content type a test file named `name` is stored with, or undefined when its extension isn't one of the six. */
export function testFileContentTypeOf(name: string): string | undefined {
  const extension = lastExtensionOf(name);
  if (extension === undefined || !Object.hasOwn(TEST_FILE_CONTENT_TYPES, extension)) return undefined;
  return TEST_FILE_CONTENT_TYPES[extension as TestFileExtension];
}

/** A pasted sample's two formats (PasteSamplePanel's JSON and raw modes). */
export const TEST_SAMPLE_FORMATS = ["json", "text"] as const;

export type TestSampleFormat = (typeof TEST_SAMPLE_FORMATS)[number];

/**
 * A pasted sample's file name, as the paste panel names it:
 * the display name as it is when it already ends in an extension
 * (`/\.[a-z0-9]+$/i`), else the display name with `.json` (JSON) or `.log`
 * (raw text). The result's last extension must still be one of the six.
 */
export function testSampleFileName(displayName: string, format: TestSampleFormat): string {
  if (/\.[a-z0-9]+$/i.test(displayName)) return displayName;
  return `${displayName}${format === "json" ? ".json" : ".log"}`;
}

/**
 * A sample's file part's content type, which names its format:
 * `application/json` (JSON) or `text/plain` (raw). Any other is refused (400
 * `invalid_request`). Only the default extension depends on it; the stored
 * content type still comes from the final name (TEST_FILE_CONTENT_TYPES).
 */
export const TEST_SAMPLE_FORMAT_BY_PART_TYPE = {
  "application/json": "json",
  "text/plain": "text",
} as const satisfies Record<string, TestSampleFormat>;

/** The multipart parts of an upload and a sample, in the only order accepted (Preflight ruling 10). */
export const TEST_FILE_PART_NAMES = ["displayName", "description", "file"] as const;

/**
 * An upload's or a sample's `displayName` part: trimmed, 1 to 200
 * characters, with nothing Postgres can't store exactly (U+0000, a lone
 * surrogate).
 */
export const TestFileDisplayNameSchema = z
  .string()
  .trim()
  .min(1, "The name can't be empty.")
  .max(TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH)
  .refine((name) => !hasUnstorableCharacter(name), "The name can't contain U+0000 or a lone surrogate.");

/** The `description` part: trimmed, at most 2,000 characters; `''` is none. */
export const TestFileDescriptionSchema = z
  .string()
  .trim()
  .max(TEST_FILE_DESCRIPTION_MAXIMUM_LENGTH)
  .refine((text) => !hasUnstorableCharacter(text), "The description can't contain U+0000 or a lone surrogate.");

/**
 * A file part's own name (an upload's), as busboy hands it over (without
 * any directory): 1 to 255 characters, nothing Postgres can't store.
 */
export const TestFileNameSchema = z
  .string()
  .min(1)
  .max(TEST_FILE_NAME_MAXIMUM_LENGTH)
  .refine((name) => !hasUnstorableCharacter(name), "The file name can't contain U+0000 or a lone surrogate.");

/** A test file, as its owner's list shows it (decision 7). Its names and description are private text. */
export const TestFileSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().max(TEST_FILE_DISPLAY_NAME_MAXIMUM_LENGTH),
    fileName: z.string().max(TEST_FILE_NAME_MAXIMUM_LENGTH),
    description: z.string().max(TEST_FILE_DESCRIPTION_MAXIMUM_LENGTH),
    contentType: z.string().max(TEST_FILE_CONTENT_TYPE_MAXIMUM_LENGTH),
    sizeBytes: z.number().int().min(0).max(TEST_FILE_MAXIMUM_BYTES),
    /** The bytes' SHA-256, lower-case hex. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().datetime(),
  })
  .strict();

export type TestFile = z.infer<typeof TestFileSchema>;

/** `GET /test-files`: the caller's own files in this organization, newest first, at most TEST_FILES_LIST_MAXIMUM. */
export const TestFilesResponseSchema = z.object({ files: z.array(TestFileSchema) }).strict();

export type TestFilesResponse = z.infer<typeof TestFilesResponseSchema>;

/** `POST /test-files` and `POST /test-files/samples`: 201 with the file saved. */
export const TestFileResponseSchema = z.object({ file: TestFileSchema }).strict();

export type TestFileResponse = z.infer<typeof TestFileResponseSchema>;

/** A run's duration: 1 to 60 seconds (decision 20). */
export const TEST_RUN_DURATION_MINIMUM_SECONDS = 1;
export const TEST_RUN_DURATION_MAXIMUM_SECONDS = 60;

/** A run's text: 1 to 262,144 characters, as the tester's request (and a version) allows. */
export const TEST_RUN_YAML_MAXIMUM_LENGTH = 262_144;

/** The text the collector ran, after the mutations: the tester's `mutatedYaml` bound, 1 MiB of characters. */
export const TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH = 1_048_576;

/** The collector's scrubbed logs: the tester's 256 KiB, as the table's check. */
export const TEST_RUN_LOGS_MAXIMUM_LENGTH = 262_144;

/** A failed run's message for the person. The dispatcher cuts a longer one before it stores it (Ruling 24). */
export const TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH = 2_000;

/** A mutation's or a compatibility finding's message. The dispatcher cuts a longer one. */
export const TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH = 4_096;

/** A compatibility finding's component (`processors/k8sattributes`). The dispatcher cuts a longer one. */
export const TEST_RUN_FINDING_COMPONENT_MAXIMUM_LENGTH = 1_024;

/** How many runs a version's list carries, newest first (Preflight ruling 15). */
export const TEST_RUNS_LIST_MAXIMUM = 100;

/** How many runs a person may have waiting in each organization (decision 19; D14b Preflight ruling 21). */
export const TEST_RUNS_WAITING_MAXIMUM_PER_USER = 50;

/** How many runs a person may queue a minute (decision 19). */
export const TEST_RUNS_PER_MINUTE_PER_USER = 20;

/**
 * Queued (with its place), Running, then Success or Error (decision 18), or
 * "Validation Failed" (D15a decision 3): the collector ran and at least one
 * of the run's rules failed.
 */
export const TEST_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "validation_failed"] as const;

export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

/** How the tester fed the input (the tester's `strategy`). */
export const TEST_RUN_STRATEGIES = ["otlp", "filelog", "syslog"] as const;

export type TestRunStrategy = (typeof TEST_RUN_STRATEGIES)[number];

/** A run's files, as `GET …/test-runs/:runId/files/:file` names them. */
export const TEST_RUN_FILES = ["input", "output", "decoded-input"] as const;

export type TestRunFile = (typeof TEST_RUN_FILES)[number];

/** A string of at most `maximum` code points (codePointLength), the tester's and the table's measure. */
const atMostCodePoints = (maximum: number) =>
  z.string().refine((text) => codePointLength(text) <= maximum, {
    message: `String must contain at most ${maximum} character(s)`,
  });

/** A run's error code: lower-case words joined by underscores, at most 64 characters, as the table's check. */
const TestRunErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * A run's text: 1 to 262,144 characters, the tester's and the validator's
 * rules (Ruling 55 of D13b): no C0 control character but tab, line feed and
 * carriage return, and no lone surrogate.
 */
export const TestRunYamlSchema = z
  .string()
  .min(1)
  .max(TEST_RUN_YAML_MAXIMUM_LENGTH)
  .refine(
    (text) => !hasYamlControlCharacter(text),
    "The YAML can't contain a control character other than tab, line feed and carriage return.",
  )
  .refine((text) => !hasUnstorableCharacter(text), "The YAML can't contain a lone surrogate.");

/** A run's duration in whole seconds, 1 to 60 (decision 20): a queue request's and a definition's. */
export const TestRunDurationSecondsSchema = z
  .number()
  .int()
  .min(TEST_RUN_DURATION_MINIMUM_SECONDS)
  .max(TEST_RUN_DURATION_MAXIMUM_SECONDS);

/**
 * Whether a pipeline's name belongs to `signal`: its first part (`logs` of
 * `logs/app`) is the signal, as the tester reads it and migration 029's
 * ck_test_definitions_pipeline_signal checks a definition's.
 */
export function isPipelineOfSignal(pipeline: string, signal: string): boolean {
  return pipeline.split("/")[0] === signal;
}

/**
 * A run from a definition (D14b decision 7, Preflight ruling 9): the
 * definition names the input, the pipeline, the signal and the duration,
 * which the API reads (through row-level security, in the path's version);
 * the browser sends only the text and the pin. Strict: a definition's
 * request naming anything else fails, and fails the other branch too.
 */
export const QueueDefinitionTestRunRequestSchema = z
  .object({
    definitionId: z.string().uuid(),
    yaml: TestRunYamlSchema,
    collectorVersion: CollectorVersionNumberSchema,
  })
  .strict();

export type QueueDefinitionTestRunRequest = z.infer<typeof QueueDefinitionTestRunRequestSchema>;

/**
 * Every other run (D14a decision 28, D14b Preflight ruling 9): a run of
 * `yaml`'s `pipeline` at `collectorVersion`, for `durationSeconds`, fed by
 * exactly one of the caller's own test file (`inputFileId`), the input of a
 * run they can see (`sourceRunId`, a re-run) or a live test template
 * (`templateId`). The distribution is always the configuration's. The
 * pipeline's signal is its name's first part, and must be `signal`.
 */
export const QueueOneOffTestRunRequestSchema = z
  .object({
    inputFileId: z.string().uuid().optional(),
    sourceRunId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    pipeline: TestRunPipelineSchema,
    signal: z.enum(TEST_RUN_SIGNALS),
    durationSeconds: TestRunDurationSecondsSchema,
    yaml: TestRunYamlSchema,
    collectorVersion: CollectorVersionNumberSchema,
  })
  .strict()
  .refine(
    (request) =>
      [request.inputFileId, request.sourceRunId, request.templateId].filter((id) => id !== undefined).length === 1,
    { message: "Name exactly one of inputFileId, sourceRunId and templateId.", path: ["inputFileId"] },
  )
  .refine((request) => isPipelineOfSignal(request.pipeline, request.signal), {
    message: "The pipeline's signal must be the request's signal.",
    path: ["pipeline"],
  });

export type QueueOneOffTestRunRequest = z.infer<typeof QueueOneOffTestRunRequestSchema>;

/**
 * `POST …/versions/:versionId/test-runs` (D14a decision 28; D14b decision
 * 7, detail 19, Preflight ruling 9): queue a run from a definition, or from
 * a file, a run or a template. Exactly one of `definitionId`,
 * `inputFileId`, `sourceRunId` and `templateId`: both branches are strict,
 * so a request mixing them fails both (400 `invalid_request`). The text is
 * the raw text the editor holds: the API substitutes organization
 * variables (Preflight ruling 12).
 */
export const QueueTestRunRequestSchema = z.union([QueueDefinitionTestRunRequestSchema, QueueOneOffTestRunRequestSchema]);

export type QueueTestRunRequest = z.infer<typeof QueueTestRunRequestSchema>;

/**
 * A suite's or a definition's name as a run snapshots it: 1 to 200
 * characters (migration 029's ck_test_runs_test_suite_name and
 * ck_test_runs_test_definition_name). test-suites.ts imports from here, so
 * its TEST_SUITE_NAME_MAXIMUM_LENGTH and TEST_DEFINITION_NAME_MAXIMUM_LENGTH
 * can't be imported back; test-suites.test.ts checks they are this.
 */
const TEST_RUN_BREADCRUMB_NAME_MAXIMUM_LENGTH = 200;

/**
 * A run as a version's list shows it (Preflight ruling 15): no text, logs
 * or files. `ahead` is how many waiting runs, in every organization, start
 * before it under decision 11's turns, for a queued run; null otherwise.
 * `queuedByUserId` is null once that account is hard-deleted. `inputName`
 * is private text.
 *
 * The breadcrumb (D14b decision 11, Preflight ruling 20): a run from a
 * suite's definition, or a re-run of one, carries the suite's and the
 * definition's ids and names as they were when it was queued; every other
 * run has all four null. The names are configuration text.
 */
export const TestRunSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(TEST_RUN_STATUSES),
    queuedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    ahead: z.number().int().min(0).nullable(),
    pipeline: z.string().max(TEST_RUN_PIPELINE_MAXIMUM_LENGTH),
    signal: z.enum(TEST_RUN_SIGNALS),
    durationSeconds: TestRunDurationSecondsSchema,
    collectorVersion: z.string().max(64),
    queuedByUserId: z.string().uuid().nullable(),
    inputName: z.string().max(TEST_FILE_NAME_MAXIMUM_LENGTH),
    errorCode: TestRunErrorCodeSchema.nullable(),
    suiteId: z.string().uuid().nullable(),
    suiteName: z.string().max(TEST_RUN_BREADCRUMB_NAME_MAXIMUM_LENGTH).nullable(),
    definitionId: z.string().uuid().nullable(),
    definitionName: z.string().max(TEST_RUN_BREADCRUMB_NAME_MAXIMUM_LENGTH).nullable(),
  })
  .strict();

export type TestRunSummary = z.infer<typeof TestRunSummarySchema>;

/** `GET …/test-runs`: the version's runs the caller can see, newest first, at most TEST_RUNS_LIST_MAXIMUM. */
export const TestRunsResponseSchema = z.object({ runs: z.array(TestRunSummarySchema) }).strict();

export type TestRunsResponse = z.infer<typeof TestRunsResponseSchema>;

/** A sandbox mutation (R-*) or a fixture-shape advisory (F-*), as the tester reports it. */
export const TestRunMutationSchema = z
  .object({
    id: z.string().regex(/^[RF]-[0-9]{3}$/),
    severity: z.enum(["info", "caution", "warn"]),
    message: atMostCodePoints(TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH),
    details: z.record(z.unknown()),
  })
  .strict();

export type TestRunMutation = z.infer<typeof TestRunMutationSchema>;

/** A compatibility finding (C-*), as the tester reports it. */
export const TestRunCompatibilityIssueSchema = z
  .object({
    id: z.string().regex(/^C-[0-9]{3}$/),
    severity: z.enum(["refuse", "advisory"]),
    component: atMostCodePoints(TEST_RUN_FINDING_COMPONENT_MAXIMUM_LENGTH),
    message: atMostCodePoints(TEST_RUN_FINDING_MESSAGE_MAXIMUM_LENGTH),
    details: z.record(z.unknown()),
  })
  .strict();

export type TestRunCompatibilityIssue = z.infer<typeof TestRunCompatibilityIssueSchema>;

const milliseconds = z.number().int().min(0);

/** The run's phases in milliseconds, as the tester reports them; null for a phase it never reached. */
export const TestRunTimingsSchema = z
  .object({
    totalMs: milliseconds,
    readyMs: milliseconds.nullable(),
    informerMs: milliseconds.nullable(),
    replayMs: milliseconds.nullable(),
    holdMs: milliseconds.nullable(),
    stopMs: milliseconds.nullable(),
  })
  .strict();

export type TestRunTimings = z.infer<typeof TestRunTimingsSchema>;

/**
 * One run in full (decision 20's snapshot and decision 1's results):
 * the list's fields, then the snapshot (the text run, organization
 * variables substituted; the input's size and content type, the type from
 * its name's extension) and the results, null until the run has ended
 * (and a failed run's may be null too). `outputSizeBytes` and
 * `decodedInputSizeBytes` are null when the run stored no such file:
 * the file reads answer 404 for it. The text, the text it ran, the logs and
 * the input's name are private text.
 *
 * The rules (D15a decisions 14 and 15, detail 24, Preflight ruling 25):
 * `validationRules` is the snapshot the run took of its pipeline's rules
 * when it was queued, in position order (`[]` when it had none);
 * `validationResults` their results, one per rule in the same order and
 * with the same ids, once the evaluator checked them, else null (a run
 * still waiting or running, one without rules, one the tester failed, one
 * the evaluator couldn't check). Configuration text.
 */
export const TestRunDetailSchema = TestRunSummarySchema.extend({
  configurationId: z.string().uuid(),
  versionId: z.string().uuid(),
  sourceRunId: z.string().uuid().nullable(),
  yaml: z.string().max(TEST_RUN_YAML_MAXIMUM_LENGTH),
  collectorDistribution: z.string().max(64),
  inputSizeBytes: z.number().int().min(0).max(TEST_FILE_MAXIMUM_BYTES),
  inputContentType: z.string().max(TEST_FILE_CONTENT_TYPE_MAXIMUM_LENGTH),
  strategy: z.enum(TEST_RUN_STRATEGIES).nullable(),
  kwokEnabled: z.boolean().nullable(),
  mutatedYaml: atMostCodePoints(TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH).nullable(),
  mutations: z.array(TestRunMutationSchema).nullable(),
  compatibility: z.array(TestRunCompatibilityIssueSchema).nullable(),
  logs: atMostCodePoints(TEST_RUN_LOGS_MAXIMUM_LENGTH).nullable(),
  timings: TestRunTimingsSchema.nullable(),
  errorMessage: atMostCodePoints(TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH).nullable(),
  outputSizeBytes: z.number().int().min(0).max(TEST_FILE_MAXIMUM_BYTES).nullable(),
  outputTruncated: z.boolean().nullable(),
  decodedInputSizeBytes: z.number().int().min(0).max(TEST_FILE_MAXIMUM_BYTES).nullable(),
  decodedInputTruncated: z.boolean().nullable(),
  validationRules: z.array(ValidationRuleSnapshotSchema).max(VALIDATION_RULES_PER_PIPELINE_MAXIMUM),
  validationResults: z.array(ValidationRuleResultSchema).max(VALIDATION_RULES_PER_PIPELINE_MAXIMUM).nullable(),
})
  .strict()
  .refine(
    (run) =>
      run.validationResults === null ||
      (run.validationResults.length === run.validationRules.length &&
        run.validationResults.every((result, index) => result.id === run.validationRules[index]!.id)),
    { message: "One result per rule, in the rules' order.", path: ["validationResults"] },
  );

export type TestRunDetail = z.infer<typeof TestRunDetailSchema>;

/** `POST …/test-runs` (201) and `GET …/test-runs/:runId`: the run in full. */
export const TestRunResponseSchema = z.object({ run: TestRunDetailSchema }).strict();

export type TestRunResponse = z.infer<typeof TestRunResponseSchema>;

/**
 * Decision 19's words, exactly: a person's 51st waiting run in one
 * organization (D14b Preflight ruling 21), 429 `test_run_queue_full`. A Play
 * all's refusals quote it (D14b Preflight ruling 15).
 */
export const TEST_RUN_QUEUE_FULL_MESSAGE = `You have ${TEST_RUNS_WAITING_MAXIMUM_PER_USER} test runs waiting already. Wait for some to finish.`;

/**
 * D14b Ruling 37's words, exactly: a queue request refused because
 * TEST_RUN_COPIES_WAITING_PER_USER requests already wait for a copy place
 * (D14b Ruling 33), 429 `test_run_rate_limited` with a retry-after. Not the
 * 20-a-minute words: a run from a definition isn't counted against those.
 */
export const TEST_RUN_QUEUING_BUSY_MESSAGE = "Too many test runs being queued at once. Try again shortly.";

/** Decision 12's words, exactly: queuing while the tester is down. */
export const TESTING_UNAVAILABLE_MESSAGE = "Testing is unavailable right now. Try again later.";

/** D13b's words for a retired pin (decision 14). */
export const COLLECTOR_VERSION_RETIRED_MESSAGE = "No longer offered. Pick a newer collector version.";

/**
 * A run whose text, with the organization's variables filled in (D20
 * decision 13), is longer than a run's text may be (TEST_RUN_YAML_MAXIMUM_
 * LENGTH, counted before it is built): at queue 400 `filled_in_too_long`,
 * nothing queued; at dispatch (the values changed since) the run ends
 * failed with the same code and words, nothing sent. The sentence is the
 * opamp-server's and the validator's ("The configuration with its
 * organization variables filled in is over 1 MiB.") with a run's own limit.
 */
export const TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE =
  "The configuration with its organization variables filled in is over 262,144 characters.";

/**
 * The testing endpoints' own codes (D14a decision 28; D14b detail 19 and
 * Preflight ruling 23). They also answer the organization's, the
 * configurations' (`configuration_not_found`,
 * `configuration_version_not_found`, `collector_version_unknown`), the
 * identity's (`product_admin_required` for a template write) and the
 * envelope's shared ones (`invalid_request`, `rate_limited` for uploads).
 * D14b's:
 * - `test_suite_not_found`, `test_definition_not_found` and
 *   `test_template_not_found` (404): one the caller can't see (another
 *   member's draft's, another version's, another organization's, a deleted
 *   template), or an id that isn't a canonical UUID, all alike;
 * - `test_suite_limit_reached` and `test_definition_limit_reached` (409):
 *   a version's 101st suite, a suite's 101st definition
 *   (TEST_SUITE_LIMIT_MESSAGE, TEST_DEFINITION_LIMIT_MESSAGE).
 * D20's: `filled_in_too_long` (400): a queued run's text too long once the
 * organization's variables are filled in (TEST_RUN_FILLED_IN_TOO_LONG_
 * MESSAGE); a run ended at its dispatch for it carries the same code.
 */
export const TESTING_ERROR_CODES = [
  "test_file_not_found",
  "test_file_too_large",
  "test_file_type_unsupported",
  "test_run_not_found",
  "test_run_rate_limited",
  "test_run_queue_full",
  "testing_unavailable",
  "collector_version_retired",
  "test_suite_not_found",
  "test_definition_not_found",
  "test_template_not_found",
  "test_suite_limit_reached",
  "test_definition_limit_reached",
  "filled_in_too_long",
  "test_run_output_not_found",
] as const;

export type TestingErrorCode = (typeof TESTING_ERROR_CODES)[number];

/** D25's (decision 43, Preflight ruling 7): `test_run_output_not_found` (404), a public run's output read before there is one. */
export const TEST_RUN_OUTPUT_NOT_FOUND_MESSAGE = "This run has no output.";
