import { z } from "zod";
import { hasUnstorableCharacter } from "./configurations.js";
import {
  isPipelineOfSignal,
  TEST_FILE_NAME_MAXIMUM_LENGTH,
  TEST_RUN_PIPELINE_MAXIMUM_LENGTH,
  TEST_RUN_SIGNALS,
  TestRunDurationSecondsSchema,
  TestRunPipelineSchema,
} from "./test-runs.js";

/*
 * The test suites and definitions endpoints, under
 * /api/v1/organizations/:organizationId/configurations/:configurationId/
 * versions/:versionId:
 *
 * - `GET /test-suites` (the version's suites, oldest first) and
 *   `POST /test-suites`; `PATCH` and `DELETE /test-suites/:suiteId`;
 * - `GET /test-suites/:suiteId/definitions` (oldest first) and
 *   `POST /test-suites/:suiteId/definitions`, whose input is copied from
 *   the caller's own test file (`inputFileId`) or a live template
 *   (`templateId`); `DELETE …/definitions/:definitionId`;
 * - `GET …/definitions/:definitionId/input/head`, the first
 *   TEST_FILE_HEAD_MAXIMUM_BYTES of the definition's input, as
 *   application/octet-stream (Play one's fixture-shape check).
 *
 * A definition is created and deleted, never edited. Suites and definitions
 * follow their configuration's visibility and may change on any version,
 * published or not.
 *
 * Names and descriptions are configuration text: they travel only
 * in these JSON bodies, never in a URL, a log line or an audit row. Their
 * bounds are migration 029's checks.
 */

/** A suite's name, after trimming: 1 to 200 characters (ck_test_suites_name_length). */
export const TEST_SUITE_NAME_MAXIMUM_LENGTH = 200;

/** A suite's description, after trimming: at most 2,000 characters; `''` is none. */
export const TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH = 2_000;

/** A definition's name, after trimming: 1 to 200 characters (ck_test_definitions_name_length). */
export const TEST_DEFINITION_NAME_MAXIMUM_LENGTH = 200;

/** A definition's description, after trimming: at most 2,000 characters; `''` is none. */
export const TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH = 2_000;

/** How many suites a version may have. */
export const TEST_SUITES_PER_VERSION_MAXIMUM = 100;

/** How many definitions a suite may have. */
export const TEST_DEFINITIONS_PER_SUITE_MAXIMUM = 100;

/** The words, exactly, of 409 `test_suite_limit_reached`. */
export const TEST_SUITE_LIMIT_MESSAGE = `A version can have at most ${TEST_SUITES_PER_VERSION_MAXIMUM} test suites.`;

/** The words, exactly, of 409 `test_definition_limit_reached`. */
export const TEST_DEFINITION_LIMIT_MESSAGE = `A test suite can have at most ${TEST_DEFINITIONS_PER_SUITE_MAXIMUM} test configurations.`;

/**
 * A name: trimmed, 1 to `maximum` characters, nothing Postgres can't store
 * exactly (U+0000, a lone surrogate). Also a template's (test-templates.ts).
 */
export function trimmedNameSchema(maximum: number) {
  return z
    .string()
    .trim()
    .min(1, "The name can't be empty.")
    .max(maximum)
    .refine((name) => !hasUnstorableCharacter(name), "The name can't contain U+0000 or a lone surrogate.");
}

/** A description: trimmed, at most `maximum` characters; `''` is none. Also a template's. */
export function trimmedDescriptionSchema(maximum: number) {
  return z
    .string()
    .trim()
    .max(maximum)
    .refine((text) => !hasUnstorableCharacter(text), "The description can't contain U+0000 or a lone surrogate.");
}

export const TestSuiteNameSchema = trimmedNameSchema(TEST_SUITE_NAME_MAXIMUM_LENGTH);

export const TestSuiteDescriptionSchema = trimmedDescriptionSchema(TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH);

export const TestDefinitionNameSchema = trimmedNameSchema(TEST_DEFINITION_NAME_MAXIMUM_LENGTH);

export const TestDefinitionDescriptionSchema = trimmedDescriptionSchema(TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH);

/**
 * `POST …/test-suites`: the suite editor dialog's fields. The
 * description may be left out (`''`). Strict: an unknown field is 400
 * `invalid_request`. A version's 101st is 409 `test_suite_limit_reached`.
 */
export const CreateTestSuiteRequestSchema = z
  .object({
    name: TestSuiteNameSchema,
    description: TestSuiteDescriptionSchema.default(""),
  })
  .strict();

/** What a client sends: `description` may be left out. */
export type CreateTestSuiteRequest = z.input<typeof CreateTestSuiteRequestSchema>;

/** `PATCH …/test-suites/:suiteId`: a rename, a new description, or both; a field left out stays as it is. */
export const UpdateTestSuiteRequestSchema = z
  .object({
    name: TestSuiteNameSchema.optional(),
    description: TestSuiteDescriptionSchema.optional(),
  })
  .strict();

export type UpdateTestSuiteRequest = z.infer<typeof UpdateTestSuiteRequestSchema>;

/**
 * A suite. `createdByUserId` is null once that account is hard-deleted. The
 * timestamps are ISO 8601, from the API's clock. Its name and description
 * are configuration text.
 */
export const TestSuiteSchema = z
  .object({
    id: z.string().uuid(),
    configurationId: z.string().uuid(),
    versionId: z.string().uuid(),
    name: z.string().max(TEST_SUITE_NAME_MAXIMUM_LENGTH),
    description: z.string().max(TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type TestSuite = z.infer<typeof TestSuiteSchema>;

/** `GET …/test-suites`: the version's suites the caller can see, oldest first, at most TEST_SUITES_PER_VERSION_MAXIMUM. */
export const TestSuitesResponseSchema = z.object({ suites: z.array(TestSuiteSchema) }).strict();

export type TestSuitesResponse = z.infer<typeof TestSuitesResponseSchema>;

/** `POST …/test-suites` (201) and `PATCH …/test-suites/:suiteId`: the suite. */
export const TestSuiteResponseSchema = z.object({ suite: TestSuiteSchema }).strict();

export type TestSuiteResponse = z.infer<typeof TestSuiteResponseSchema>;

/**
 * `POST …/test-suites/:suiteId/definitions`: a definition, its input copied
 * at once from exactly one of the caller's own test file in this
 * organization (`inputFileId`) or a live template (`templateId`). The
 * pipeline's signal is its name's first part, and must be `signal`
 * (migration 029's ck_test_definitions_pipeline_signal). The description
 * may be left out. Strict. A suite's 101st is 409
 * `test_definition_limit_reached`.
 */
export const CreateTestDefinitionRequestSchema = z
  .object({
    inputFileId: z.string().uuid().optional(),
    templateId: z.string().uuid().optional(),
    name: TestDefinitionNameSchema,
    description: TestDefinitionDescriptionSchema.default(""),
    pipeline: TestRunPipelineSchema,
    signal: z.enum(TEST_RUN_SIGNALS),
    durationSeconds: TestRunDurationSecondsSchema,
  })
  .strict()
  .refine((request) => (request.inputFileId === undefined) !== (request.templateId === undefined), {
    message: "Name exactly one of inputFileId and templateId.",
    path: ["inputFileId"],
  })
  .refine((request) => isPipelineOfSignal(request.pipeline, request.signal), {
    message: "The pipeline's signal must be the request's signal.",
    path: ["pipeline"],
  });

/** What a client sends: `description` may be left out. */
export type CreateTestDefinitionRequest = z.input<typeof CreateTestDefinitionRequestSchema>;

/**
 * A definition. `inputName` is its input's original file name
 * (a test file's or a template's, with its extension), as a run from it is
 * named. `createdByUserId` is null once that account is hard-deleted. Its
 * name, description and input name are configuration text.
 */
export const TestDefinitionSchema = z
  .object({
    id: z.string().uuid(),
    suiteId: z.string().uuid(),
    name: z.string().max(TEST_DEFINITION_NAME_MAXIMUM_LENGTH),
    description: z.string().max(TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH),
    pipeline: z.string().max(TEST_RUN_PIPELINE_MAXIMUM_LENGTH),
    signal: z.enum(TEST_RUN_SIGNALS),
    durationSeconds: TestRunDurationSecondsSchema,
    inputName: z.string().max(TEST_FILE_NAME_MAXIMUM_LENGTH),
    createdByUserId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type TestDefinition = z.infer<typeof TestDefinitionSchema>;

/** `GET …/definitions`: the suite's definitions, oldest first, at most TEST_DEFINITIONS_PER_SUITE_MAXIMUM. */
export const TestDefinitionsResponseSchema = z.object({ definitions: z.array(TestDefinitionSchema) }).strict();

export type TestDefinitionsResponse = z.infer<typeof TestDefinitionsResponseSchema>;

/** `POST …/definitions` (201): the definition. */
export const TestDefinitionResponseSchema = z.object({ definition: TestDefinitionSchema }).strict();

export type TestDefinitionResponse = z.infer<typeof TestDefinitionResponseSchema>;
