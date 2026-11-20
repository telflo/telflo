import { z } from "zod";
import { CollectorDistributionIdSchema, CollectorVersionNumberSchema } from "../collector-distributions.js";
import { TEST_RUN_SIGNALS, TestRunPipelineSchema } from "../test-run-pipelines.js";
import {
  isPipelineOfSignal,
  TEST_RUN_STATUSES,
  TEST_SAMPLE_MAXIMUM_BYTES,
  TestRunCompatibilityIssueSchema,
  TestRunDurationSecondsSchema,
  TestRunMutationSchema,
  TestRunYamlSchema,
} from "../test-runs.js";
import {
  CreateValidationRuleRequestSchema,
  VALIDATION_RULES_PER_PIPELINE_MAXIMUM,
  ValidationRuleResultSchema,
} from "../validation-rules.js";

/*
 * The public surface's request and response shapes for test runs (routes
 * 26–28): strict Zod schemas, camelCase, reusing the platform's contracts
 * where they already hold a field (a run's text, pipeline, signal and
 * duration; the collector version's and the distribution's formats; the rule
 * shape; a run's results).
 *
 * A rule is the platform's (`kind`, `target`, `pattern` or `ottl`, `name`,
 * `description`). Statuses are the platform's (`queued`, `running`,
 * `succeeded`, `failed`, `validation_failed`); the collector's stderr is not
 * answered.
 */

/** At most this many inline rules in one run. */
export const PUBLIC_TEST_RUN_RULES_MAXIMUM = 20;

/** A run's duration when the request names none. */
export const PUBLIC_TEST_RUN_DEFAULT_DURATION_SECONDS = 5;

/**
 * The sample's most bytes once decoded, UTF-8: a pasted sample's limit. Over
 * it, 413 `payload_too_large`.
 */
export const PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES = TEST_SAMPLE_MAXIMUM_BYTES;

/** The sample's file name in the caller's test files. */
export const PUBLIC_TEST_RUN_SAMPLE_FILE_NAME = "api-sample.json";

/** A sample over PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES (413 `payload_too_large`): fixed words. */
export const PUBLIC_TEST_RUN_SAMPLE_TOO_LARGE_MESSAGE = "The sample is over 1 MiB.";

/**
 * A version's run's `distribution` that isn't its configuration's (400
 * `invalid_request`, its issue at `distribution`): a version's run uses its
 * configuration's distribution.
 */
export const PUBLIC_TEST_RUN_DISTRIBUTION_MISMATCH_MESSAGE = "A version's run uses its configuration's distribution.";

/**
 * A text the run can't take (422 `configuration_invalid`, its one error at
 * `service.pipelines`): its `service.pipelines` has no `pipeline`. Fixed
 * words: never the name, nor the names the text has.
 */
export const PUBLIC_TEST_RUN_PIPELINE_NOT_IN_CONFIGURATION_MESSAGE = "The configuration has no pipeline of this name.";

/**
 * A version's run with `useSavedRules` whose version has no saved rules for
 * its pipeline and signal (422 `configuration_invalid`, its one error at the
 * root). Fixed words: never the name.
 */
export const PUBLIC_TEST_RUN_NO_SAVED_RULES_MESSAGE = "The version has no saved validation rules for this pipeline.";

/**
 * A version whose text a run can't take (422 `configuration_invalid`, its
 * one error at the text's root): empty, over a run's 262,144 characters, or
 * holding a control character.
 */
export const PUBLIC_TEST_RUN_TEXT_NOT_RUNNABLE_MESSAGE = "The version's YAML can't be run.";

/**
 * `POST /test-runs`: exactly one source, the version
 * `{ configurationId, versionNumber }` or the text `{ yaml }`; the sample (at
 * most 1 MiB decoded, checked by the route: 413); the signal and the
 * pipeline, whose first part is the signal; the duration (1–60, 5); the
 * collector version and distribution (a version's pin and its configuration's
 * distribution by default, the catalog's defaults for a text); and exactly
 * one of `rules` (1–20) and `useSavedRules: true` (a version's run only).
 * Strict.
 */
export const PublicQueueTestRunRequestSchema = z
  .object({
    configurationId: z.string().optional(),
    versionNumber: z.number().int().min(1).max(999_999_999).optional(),
    yaml: TestRunYamlSchema.optional(),
    sample: z.string(),
    signal: z.enum(TEST_RUN_SIGNALS),
    pipeline: TestRunPipelineSchema,
    durationSeconds: TestRunDurationSecondsSchema.default(PUBLIC_TEST_RUN_DEFAULT_DURATION_SECONDS),
    collectorVersion: CollectorVersionNumberSchema.optional(),
    distribution: CollectorDistributionIdSchema.optional(),
    rules: z.array(CreateValidationRuleRequestSchema).min(1).max(PUBLIC_TEST_RUN_RULES_MAXIMUM).optional(),
    useSavedRules: z.boolean().default(false),
  })
  .strict()
  .superRefine((request, context) => {
    const issue = (message: string, path: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    const namesVersion = request.configurationId !== undefined || request.versionNumber !== undefined;
    const isVersion = request.configurationId !== undefined && request.versionNumber !== undefined;
    if (request.yaml !== undefined ? namesVersion : !isVersion) {
      issue("Send either configurationId and versionNumber, or yaml.", "yaml");
    }
    if (request.rules !== undefined && request.useSavedRules) issue("Send rules or useSavedRules, not both.", "useSavedRules");
    if (request.rules === undefined && !request.useSavedRules) issue("Send rules or useSavedRules.", "rules");
    if (request.useSavedRules && request.yaml !== undefined) issue("useSavedRules needs a configuration's version.", "useSavedRules");
    if (!isPipelineOfSignal(request.pipeline, request.signal)) {
      issue("The pipeline's signal must be the request's signal.", "pipeline");
    }
  });

/** What a client sends: the duration and `useSavedRules` may be left out. */
export type PublicQueueTestRunRequest = z.input<typeof PublicQueueTestRunRequestSchema>;

/** `POST /test-runs` (202): the run's id; poll `GET /test-runs/{runId}`. */
export const PublicQueuedTestRunSchema = z.object({ id: z.string().uuid(), status: z.literal("queued") }).strict();

export type PublicQueuedTestRun = z.infer<typeof PublicQueuedTestRunSchema>;

/**
 * `GET /test-runs/{runId}`: a run, mapped one for one from the platform's.
 * `success` is null until it has ended, then whether it succeeded;
 * `durationMs` the tester's measure of the whole run, null until it has
 * one; `validationResults` one per rule in the rules' order, null until
 * checked (or for a run with none); `mutations` and `compatibility` the
 * tester's findings, null until it ran; `createdAt` when it was queued.
 */
export const PublicTestRunSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(TEST_RUN_STATUSES),
    success: z.boolean().nullable(),
    signal: z.enum(TEST_RUN_SIGNALS),
    pipeline: z.string(),
    durationMs: z.number().int().min(0).nullable(),
    collectorVersion: z.string(),
    distribution: z.string(),
    validationResults: z.array(ValidationRuleResultSchema).max(VALIDATION_RULES_PER_PIPELINE_MAXIMUM).nullable(),
    mutations: z.array(TestRunMutationSchema).nullable(),
    compatibility: z.array(TestRunCompatibilityIssueSchema).nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type PublicTestRun = z.infer<typeof PublicTestRunSchema>;
