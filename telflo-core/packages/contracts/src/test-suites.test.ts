import { describe, expect, it } from "vitest";
import {
  CreateTestDefinitionRequestSchema,
  CreateTestSuiteRequestSchema,
  TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_DEFINITION_LIMIT_MESSAGE,
  TEST_DEFINITION_NAME_MAXIMUM_LENGTH,
  TEST_DEFINITIONS_PER_SUITE_MAXIMUM,
  TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_SUITE_LIMIT_MESSAGE,
  TEST_SUITE_NAME_MAXIMUM_LENGTH,
  TEST_SUITES_PER_VERSION_MAXIMUM,
  TestDefinitionResponseSchema,
  TestDefinitionSchema,
  TestDefinitionsResponseSchema,
  TestSuiteNameSchema,
  TestSuiteResponseSchema,
  TestSuiteSchema,
  TestSuitesResponseSchema,
  UpdateTestSuiteRequestSchema,
} from "./test-suites.js";
import { TestRunSummarySchema } from "./test-runs.js";

const SUITE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";
const CONFIGURATION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61";
const VERSION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62";
const USER_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a63";
const FILE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a64";
const TEMPLATE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a65";
const DEFINITION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a66";

describe("the limits", () => {
  it("are migration 029's bounds and the caps, with their words", () => {
    expect(TEST_SUITE_NAME_MAXIMUM_LENGTH).toBe(200);
    expect(TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH).toBe(2_000);
    expect(TEST_DEFINITION_NAME_MAXIMUM_LENGTH).toBe(200);
    expect(TEST_DEFINITION_DESCRIPTION_MAXIMUM_LENGTH).toBe(2_000);
    expect(TEST_SUITES_PER_VERSION_MAXIMUM).toBe(100);
    expect(TEST_DEFINITIONS_PER_SUITE_MAXIMUM).toBe(100);
    expect(TEST_SUITE_LIMIT_MESSAGE).toBe("A version can have at most 100 test suites.");
    expect(TEST_DEFINITION_LIMIT_MESSAGE).toBe("A test suite can have at most 100 test configurations.");
  });

  it("bound a run's breadcrumb too: test-runs.ts's own 200 (it can't import these) is the suites' and the definitions'", () => {
    const summary = {
      id: DEFINITION_ID,
      status: "queued",
      queuedAt: "2026-10-09T12:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      ahead: 0,
      pipeline: "logs",
      signal: "logs",
      durationSeconds: 5,
      collectorVersion: "0.162.0",
      queuedByUserId: USER_ID,
      inputName: "app-logs.json",
      errorCode: null,
      suiteId: SUITE_ID,
      suiteName: "s".repeat(TEST_SUITE_NAME_MAXIMUM_LENGTH),
      definitionId: DEFINITION_ID,
      definitionName: "d".repeat(TEST_DEFINITION_NAME_MAXIMUM_LENGTH),
    };
    expect(TestRunSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      TestRunSummarySchema.safeParse({ ...summary, suiteName: "s".repeat(TEST_SUITE_NAME_MAXIMUM_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      TestRunSummarySchema.safeParse({ ...summary, definitionName: "d".repeat(TEST_DEFINITION_NAME_MAXIMUM_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});

describe("a suite's requests", () => {
  it("trims the name to 1 to 200 characters, refusing what Postgres can't store", () => {
    expect(TestSuiteNameSchema.parse("  Smoke tests  ")).toBe("Smoke tests");
    expect(TestSuiteNameSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(TestSuiteNameSchema.safeParse("a".repeat(201)).success).toBe(false);
    expect(TestSuiteNameSchema.safeParse(` ${"a".repeat(200)} `).success).toBe(true);
    expect(TestSuiteNameSchema.safeParse("   ").success).toBe(false);
    expect(TestSuiteNameSchema.safeParse("a\u0000b").success).toBe(false);
    expect(TestSuiteNameSchema.safeParse("a\ud800b").success).toBe(false);
  });

  it("creates with a name, the description trimmed and '' when left out", () => {
    expect(CreateTestSuiteRequestSchema.parse({ name: " Smoke tests " })).toEqual({ name: "Smoke tests", description: "" });
    expect(CreateTestSuiteRequestSchema.parse({ name: "Smoke", description: "  Checks logs.  " })).toEqual({
      name: "Smoke",
      description: "Checks logs.",
    });
    expect(CreateTestSuiteRequestSchema.safeParse({ name: "Smoke", description: "d".repeat(2_000) }).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no name", {}],
    ["a blank name", { name: "  " }],
    ["a 201-character name", { name: "n".repeat(201) }],
    ["a 2,001-character description", { name: "Smoke", description: "d".repeat(2_001) }],
    ["a description with U+0000", { name: "Smoke", description: "a\u0000" }],
    ["a null description", { name: "Smoke", description: null }],
    ["an unknown field", { name: "Smoke", versionId: VERSION_ID }],
  ])("refuses a create with %s", (_label, body) => {
    expect(CreateTestSuiteRequestSchema.safeParse(body).success).toBe(false);
  });

  it("updates the name, the description or both; a field left out stays", () => {
    expect(UpdateTestSuiteRequestSchema.parse({ name: " Renamed " })).toEqual({ name: "Renamed" });
    expect(UpdateTestSuiteRequestSchema.parse({ description: "" })).toEqual({ description: "" });
    expect(UpdateTestSuiteRequestSchema.parse({ name: "R", description: "D" })).toEqual({ name: "R", description: "D" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a blank name", { name: " " }],
    ["a 201-character name", { name: "n".repeat(201) }],
    ["a 2,001-character description", { description: "d".repeat(2_001) }],
    ["an unknown field", { createdByUserId: USER_ID }],
  ])("refuses an update with %s", (_label, body) => {
    expect(UpdateTestSuiteRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("a definition's create request", () => {
  const valid = {
    inputFileId: FILE_ID,
    name: "Logs only",
    description: "",
    pipeline: "logs/app",
    signal: "logs",
    durationSeconds: 5,
  };
  const { inputFileId: _file, ...noInput } = valid;

  it("accepts the caller's file or a template, exactly one, trimming the name and defaulting the description", () => {
    expect(CreateTestDefinitionRequestSchema.parse(valid)).toEqual(valid);
    expect(CreateTestDefinitionRequestSchema.parse({ ...noInput, templateId: TEMPLATE_ID })).toEqual({
      ...noInput,
      templateId: TEMPLATE_ID,
    });
    const { description: _description, ...noDescription } = valid;
    expect(CreateTestDefinitionRequestSchema.parse({ ...noDescription, name: "  Logs only " })).toEqual(valid);
    expect(CreateTestDefinitionRequestSchema.safeParse({ ...valid, durationSeconds: 1 }).success).toBe(true);
    expect(CreateTestDefinitionRequestSchema.safeParse({ ...valid, durationSeconds: 60 }).success).toBe(true);
    expect(CreateTestDefinitionRequestSchema.safeParse({ ...valid, pipeline: "logs" }).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["both a file and a template", { templateId: TEMPLATE_ID }],
    ["no input", { inputFileId: undefined }],
    ["a run as its input", { inputFileId: undefined, sourceRunId: FILE_ID }],
    ["a definition as its input", { inputFileId: undefined, definitionId: DEFINITION_ID }],
    ["a malformed file id", { inputFileId: "not-a-uuid" }],
    ["a malformed template id", { inputFileId: undefined, templateId: "x" }],
    ["no name", { name: undefined }],
    ["a blank name", { name: "   " }],
    ["a 201-character name", { name: "n".repeat(201) }],
    ["a 2,001-character description", { description: "d".repeat(2_001) }],
    ["a pipeline of another signal", { pipeline: "traces/app" }],
    ["a pipeline whose first part only starts with the signal", { pipeline: "logsx" }],
    ["an unknown signal", { signal: "profiles", pipeline: "profiles" }],
    ["an empty pipeline", { pipeline: "" }],
    ["a 201-character pipeline", { pipeline: `logs/${"p".repeat(196)}` }],
    ["no duration (no default, as the table's)", { durationSeconds: undefined }],
    ["a duration of 0", { durationSeconds: 0 }],
    ["a duration of 61", { durationSeconds: 61 }],
    ["a fractional duration", { durationSeconds: 2.5 }],
    ["an unknown field", { yaml: "receivers: {}\n" }],
  ])("refuses %s", (_label, overrides) => {
    expect(CreateTestDefinitionRequestSchema.safeParse({ ...valid, ...overrides }).success).toBe(false);
  });
});

describe("the responses", () => {
  const suite = {
    id: SUITE_ID,
    configurationId: CONFIGURATION_ID,
    versionId: VERSION_ID,
    name: "Smoke tests",
    description: "",
    createdByUserId: USER_ID,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
  };
  const definition = {
    id: DEFINITION_ID,
    suiteId: SUITE_ID,
    name: "Logs only",
    description: "Checks the app's logs.",
    pipeline: "logs",
    signal: "logs",
    durationSeconds: 5,
    inputName: "app-logs.json",
    createdByUserId: null,
    createdAt: "2026-10-10T12:00:00.000Z",
  };

  it("carry a suite and a definition, alone and in lists", () => {
    expect(TestSuiteResponseSchema.parse({ suite })).toEqual({ suite });
    expect(TestSuitesResponseSchema.parse({ suites: [suite] })).toEqual({ suites: [suite] });
    expect(TestDefinitionResponseSchema.parse({ definition })).toEqual({ definition });
    expect(TestDefinitionsResponseSchema.parse({ definitions: [definition] })).toEqual({ definitions: [definition] });
    expect(TestSuiteSchema.safeParse({ ...suite, createdByUserId: null }).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a name over its bound", { name: "n".repeat(201) }],
    ["a description over its bound", { description: "d".repeat(2_001) }],
    ["a missing creator", { createdByUserId: undefined }],
    ["an unknown field", { organizationId: USER_ID }],
  ])("refuse a suite with %s", (_label, overrides) => {
    expect(TestSuiteSchema.safeParse({ ...suite, ...overrides }).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a name over its bound", { name: "n".repeat(201) }],
    ["an input name over its bound", { inputName: "f".repeat(256) }],
    ["a duration of 61", { durationSeconds: 61 }],
    ["an unknown signal", { signal: "profiles" }],
    ["the input's id (never exposed)", { inputId: FILE_ID }],
  ])("refuse a definition with %s", (_label, overrides) => {
    expect(TestDefinitionSchema.safeParse({ ...definition, ...overrides }).success).toBe(false);
  });
});
