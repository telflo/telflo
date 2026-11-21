import { describe, expect, it } from "vitest";
import {
  codePointLength,
  COLLECTOR_VERSION_RETIRED_MESSAGE,
  isPipelineOfSignal,
  lastExtensionOf,
  QueueDefinitionTestRunRequestSchema,
  QueueOneOffTestRunRequestSchema,
  QueueTestRunRequestSchema,
  TEST_FILE_CONTENT_TYPES,
  TEST_FILE_EXTENSIONS,
  TEST_FILE_HEAD_MAXIMUM_BYTES,
  TEST_FILE_MAXIMUM_BYTES,
  TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH,
  TEST_RUN_LOGS_MAXIMUM_LENGTH,
  TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH,
  TEST_RUN_PIPELINE_MAXIMUM_LENGTH,
  TEST_RUN_QUEUE_FULL_MESSAGE,
  TEST_RUN_QUEUING_BUSY_MESSAGE,
  TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE,
  TEST_RUN_YAML_MAXIMUM_LENGTH,
  TEST_RUNS_LIST_MAXIMUM,
  TEST_RUNS_PER_MINUTE_PER_USER,
  TEST_RUNS_WAITING_MAXIMUM_PER_USER,
  TEST_SAMPLE_MAXIMUM_BYTES,
  TestFileDescriptionSchema,
  TestFileDisplayNameSchema,
  testFileContentTypeOf,
  TestFileNameSchema,
  TestFileSchema,
  TESTING_ERROR_CODES,
  TESTING_UNAVAILABLE_MESSAGE,
  TestRunDetailSchema,
  TestRunSummarySchema,
  testSampleFileName,
} from "./test-runs.js";

const RUN_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const FILE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

describe("the limits", () => {
  it("are the uploads', the queue's, the list's and the tester's contract's", () => {
    expect(TEST_FILE_MAXIMUM_BYTES).toBe(10_485_760);
    // The head of a test file, and of a run's input.
    expect(TEST_FILE_HEAD_MAXIMUM_BYTES).toBe(65_536);
    expect(TEST_SAMPLE_MAXIMUM_BYTES).toBe(1_048_576);
    expect(TEST_RUNS_LIST_MAXIMUM).toBe(100);
    expect(TEST_RUNS_WAITING_MAXIMUM_PER_USER).toBe(50);
    expect(TEST_RUNS_PER_MINUTE_PER_USER).toBe(20);
    // services/otelcol-testing/openapi.yaml's maxLengths.
    expect(TEST_RUN_YAML_MAXIMUM_LENGTH).toBe(262_144);
    expect(TEST_RUN_PIPELINE_MAXIMUM_LENGTH).toBe(200);
    expect(TEST_RUN_MUTATED_YAML_MAXIMUM_LENGTH).toBe(1_048_576);
    expect(TEST_RUN_LOGS_MAXIMUM_LENGTH).toBe(262_144);
    expect(TEST_RUN_ERROR_MESSAGE_MAXIMUM_LENGTH).toBe(2_000);
  });

  it("have the testing endpoints' codes and their words", () => {
    expect(TESTING_ERROR_CODES).toEqual([
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
    ]);
    // The opamp-server's and the validator's sentence, with a run's own limit.
    expect(TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE).toBe(
      "The configuration with its organization variables filled in is over 262,144 characters.",
    );
    expect(TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE).toContain(TEST_RUN_YAML_MAXIMUM_LENGTH.toLocaleString("en-US"));
    expect(TESTING_UNAVAILABLE_MESSAGE).toBe("Testing is unavailable right now. Try again later.");
    expect(COLLECTOR_VERSION_RETIRED_MESSAGE).toBe("No longer offered. Pick a newer collector version.");
    // A Play all's toast quotes it.
    expect(TEST_RUN_QUEUE_FULL_MESSAGE).toBe("You have 50 test runs waiting already. Wait for some to finish.");
    // Too many waiting for a copy place, not the per-minute words.
    expect(TEST_RUN_QUEUING_BUSY_MESSAGE).toBe("Too many test runs being queued at once. Try again shortly.");
  });
});

describe("a test file's type", () => {
  it("allows six extensions, with their upload types", () => {
    expect(TEST_FILE_EXTENSIONS).toEqual(["json", "ndjson", "yaml", "yml", "txt", "log"]);
    expect(TEST_FILE_CONTENT_TYPES).toEqual({
      json: "application/json",
      ndjson: "application/x-ndjson",
      yaml: "application/x-yaml",
      yml: "application/x-yaml",
      txt: "text/plain",
      log: "text/plain",
    });
  });

  it.each([
    ["app.json", "json"],
    ["app.logs.NDJSON", "ndjson"],
    ["app", undefined],
    [".json", undefined],
    ["app.", undefined],
  ])("reads %s's last extension as %s", (name, extension) => {
    expect(lastExtensionOf(name)).toBe(extension);
  });

  it("types a name by its last extension only, refusing anything else", () => {
    expect(testFileContentTypeOf("events.YML")).toBe("application/x-yaml");
    expect(testFileContentTypeOf("events.json.gz")).toBeUndefined();
    expect(testFileContentTypeOf("events.csv")).toBeUndefined();
    expect(testFileContentTypeOf("toString.constructor")).toBeUndefined();
    expect(testFileContentTypeOf("a.__proto__")).toBeUndefined();
  });
});

describe("testSampleFileName (PasteSamplePanel's naming)", () => {
  it("adds .json or .log unless the name already ends in an extension", () => {
    expect(testSampleFileName("otlp sample", "json")).toBe("otlp sample.json");
    expect(testSampleFileName("app lines", "text")).toBe("app lines.log");
    expect(testSampleFileName("events.ndjson", "text")).toBe("events.ndjson");
    expect(testSampleFileName("events.CSV", "json")).toBe("events.CSV");
  });
});

describe("the upload's fields", () => {
  it("trims the display name to 1 to 200 characters, refusing what Postgres can't store", () => {
    expect(TestFileDisplayNameSchema.parse("  App logs  ")).toBe("App logs");
    expect(TestFileDisplayNameSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(TestFileDisplayNameSchema.safeParse("a".repeat(201)).success).toBe(false);
    expect(TestFileDisplayNameSchema.safeParse("   ").success).toBe(false);
    expect(TestFileDisplayNameSchema.safeParse("a\u0000b").success).toBe(false);
    expect(TestFileDisplayNameSchema.safeParse("a\ud800b").success).toBe(false);
  });

  it("trims the description to at most 2,000 characters, '' allowed", () => {
    expect(TestFileDescriptionSchema.parse("  ")).toBe("");
    expect(TestFileDescriptionSchema.safeParse("d".repeat(2_000)).success).toBe(true);
    expect(TestFileDescriptionSchema.safeParse("d".repeat(2_001)).success).toBe(false);
  });

  it("takes a file name of 1 to 255 characters", () => {
    expect(TestFileNameSchema.safeParse("").success).toBe(false);
    expect(TestFileNameSchema.safeParse(`${"f".repeat(250)}.json`).success).toBe(true);
    expect(TestFileNameSchema.safeParse(`${"f".repeat(251)}.json`).success).toBe(false);
  });
});

describe("QueueTestRunRequestSchema", () => {
  const TEMPLATE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
  const DEFINITION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e";
  const valid = {
    inputFileId: FILE_ID,
    pipeline: "logs/app",
    signal: "logs",
    durationSeconds: 5,
    yaml: "receivers: {}\n",
    collectorVersion: "0.162.0",
  };
  const { inputFileId: _file, ...noInput } = valid;
  const definition = { definitionId: DEFINITION_ID, yaml: "receivers: {}\n", collectorVersion: "0.162.0" };

  it("accepts a run of the caller's file, a re-run of a run and a template's run, each through the one-off branch", () => {
    for (const request of [valid, { ...noInput, sourceRunId: RUN_ID }, { ...noInput, templateId: TEMPLATE_ID }]) {
      expect(QueueTestRunRequestSchema.parse(request)).toEqual(request);
      expect(QueueOneOffTestRunRequestSchema.safeParse(request).success).toBe(true);
      expect(QueueDefinitionTestRunRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("accepts a definition's run with only the text and the pin, through the definition branch", () => {
    expect(QueueTestRunRequestSchema.parse(definition)).toEqual(definition);
    expect(QueueDefinitionTestRunRequestSchema.safeParse(definition).success).toBe(true);
    expect(QueueOneOffTestRunRequestSchema.safeParse(definition).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["both a file and a run", { sourceRunId: RUN_ID }],
    ["both a file and a template", { templateId: TEMPLATE_ID }],
    ["a file, a run and a template", { sourceRunId: RUN_ID, templateId: TEMPLATE_ID }],
    ["no input", { inputFileId: undefined }],
    ["a malformed file id", { inputFileId: "not-a-uuid" }],
    ["a malformed template id", { inputFileId: undefined, templateId: "not-a-uuid" }],
    ["a pipeline of another signal", { pipeline: "metrics/app" }],
    ["a pipeline whose first part only starts with the signal", { pipeline: "logsx/app" }],
    ["an unknown signal", { signal: "profiles", pipeline: "profiles" }],
    ["an empty pipeline", { pipeline: "" }],
    ["a 201-character pipeline", { pipeline: `logs/${"p".repeat(196)}` }],
    ["a duration of 0", { durationSeconds: 0 }],
    ["a duration of 61", { durationSeconds: 61 }],
    ["a fractional duration", { durationSeconds: 1.5 }],
    ["empty text", { yaml: "" }],
    ["text over 262,144 characters", { yaml: "a".repeat(262_145) }],
    ["text with a control character", { yaml: "a: b\u0007\n" }],
    ["text with a lone surrogate", { yaml: "a: \ud800\n" }],
    ["a malformed collector version", { collectorVersion: "v0.162.0" }],
    ["an unknown field", { distribution: "otelcol-contrib" }],
    ["a definition mixed into a file's run", { definitionId: DEFINITION_ID }],
    ["a definition in place of the file, with the one-off fields", { inputFileId: undefined, definitionId: DEFINITION_ID }],
    // A run's rules are the database's snapshot, never a client's.
    ["its own rules", { validationRules: [] }],
    ["its own validation pipeline", { validationPipelineId: RUN_ID }],
  ])("refuses a one-off run with %s", (_label, overrides) => {
    expect(QueueTestRunRequestSchema.safeParse({ ...valid, ...overrides }).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no definition", { definitionId: undefined }],
    ["a malformed definition id", { definitionId: "not-a-uuid" }],
    ["no text", { yaml: undefined }],
    ["empty text", { yaml: "" }],
    ["text with a control character", { yaml: "a: b\u0007\n" }],
    ["no pin", { collectorVersion: undefined }],
    ["a malformed collector version", { collectorVersion: "v0.162.0" }],
    ["a pipeline (the definition names its own)", { pipeline: "logs" }],
    ["a signal", { signal: "logs" }],
    ["a duration", { durationSeconds: 5 }],
    ["a file as well", { inputFileId: FILE_ID }],
    ["a run as well", { sourceRunId: RUN_ID }],
    ["a template as well", { templateId: TEMPLATE_ID }],
    ["the one-off fields and a file as well", { inputFileId: FILE_ID, pipeline: "logs", signal: "logs", durationSeconds: 5 }],
    ["an unknown field", { suiteId: RUN_ID }],
    ["its own rules", { validationRules: [] }],
  ])("refuses a definition's run with %s", (_label, overrides) => {
    expect(QueueTestRunRequestSchema.safeParse({ ...definition, ...overrides }).success).toBe(false);
  });

  it("isPipelineOfSignal reads the pipeline name's first part", () => {
    expect(isPipelineOfSignal("logs", "logs")).toBe(true);
    expect(isPipelineOfSignal("logs/app", "logs")).toBe(true);
    expect(isPipelineOfSignal("logs/app/x", "logs")).toBe(true);
    expect(isPipelineOfSignal("traces/app", "logs")).toBe(false);
    expect(isPipelineOfSignal("logsx", "logs")).toBe(false);
    expect(isPipelineOfSignal("/logs", "logs")).toBe(false);
  });
});

describe("the responses", () => {
  const summary = {
    id: RUN_ID,
    status: "queued",
    queuedAt: "2026-10-09T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ahead: 2,
    pipeline: "logs",
    signal: "logs",
    durationSeconds: 5,
    collectorVersion: "0.162.0",
    queuedByUserId: FILE_ID,
    inputName: "app-logs.json",
    errorCode: null,
    suiteId: null,
    suiteName: null,
    definitionId: null,
    definitionName: null,
  };
  const detail = {
    ...summary,
    configurationId: RUN_ID,
    versionId: RUN_ID,
    sourceRunId: null,
    yaml: "receivers: {}\n",
    collectorDistribution: "otelcol-contrib",
    inputSizeBytes: 12,
    inputContentType: "application/json",
    strategy: "otlp",
    kwokEnabled: false,
    mutatedYaml: "receivers: {}\n",
    mutations: [{ id: "R-001", severity: "info", message: "Replaced.", details: {} }],
    compatibility: [{ id: "C-003", severity: "advisory", component: "processors/batch", message: "Slow.", details: {} }],
    logs: "[replay] 1 of 1 payloads sent\n",
    timings: { totalMs: 9000, readyMs: 400, informerMs: null, replayMs: 30, holdMs: 5000, stopMs: 60 },
    errorMessage: null,
    outputSizeBytes: 20,
    outputTruncated: false,
    decodedInputSizeBytes: null,
    decodedInputTruncated: null,
    validationRules: [],
    validationResults: null,
  };

  it("carry the list's row, and the run in full", () => {
    expect(TestRunSummarySchema.parse(summary)).toEqual(summary);
    expect(TestRunDetailSchema.parse(detail)).toEqual(detail);
    // The list row carries no text: the detail's fields are refused there.
    expect(TestRunSummarySchema.safeParse({ ...summary, yaml: "x" }).success).toBe(false);
  });

  it("carry a definition's run's breadcrumb: the suite's and the definition's ids and names", () => {
    const breadcrumb = { suiteId: FILE_ID, suiteName: "Smoke tests", definitionId: RUN_ID, definitionName: "Logs only" };
    expect(TestRunSummarySchema.parse({ ...summary, ...breadcrumb })).toEqual({ ...summary, ...breadcrumb });
    expect(TestRunDetailSchema.parse({ ...detail, ...breadcrumb })).toEqual({ ...detail, ...breadcrumb });
    // Every field is there, null or not: a run without one has all four null.
    const { suiteName: _suiteName, ...withoutName } = summary;
    expect(TestRunSummarySchema.safeParse(withoutName).success).toBe(false);
    expect(TestRunSummarySchema.safeParse({ ...summary, suiteName: "s".repeat(201) }).success).toBe(false);
    expect(TestRunSummarySchema.safeParse({ ...summary, definitionName: "d".repeat(201) }).success).toBe(false);
    expect(TestRunSummarySchema.safeParse({ ...summary, suiteId: "not-a-uuid" }).success).toBe(false);
  });

  describe("carry the run's rules and their results", () => {
    const RULE_ONE = "0199e000-0000-7000-8000-0000000000a1";
    const RULE_TWO = "0199e000-0000-7000-8000-0000000000a2";
    const rules = [
      { id: RULE_ONE, position: 1, kind: "contains_text", target: "output", pattern: "prod", ottl: null, name: "Has prod", description: "" },
      {
        id: RULE_TWO,
        position: 3,
        kind: "ottl",
        target: "output",
        pattern: null,
        ottl: { context: "log", quantifier: "all", condition: 'severity_text == "INFO"' },
        name: "",
        description: "",
      },
    ];
    const results = [
      { id: RULE_ONE, passed: true, error: null, advisory: null, detail: null },
      {
        id: RULE_TWO,
        passed: false,
        error: null,
        advisory: null,
        detail: {
          kind: "record_mismatch",
          context: "log",
          totalCount: 2,
          matchedCount: 1,
          missCount: 1,
          misses: [{ index: 1, reason: "condition evaluated to false", snippet: "{}" }],
        },
      },
    ];

    it("the snapshot in position order and one result per rule, by the rules' ids in their order", () => {
      const run = { ...detail, status: "validation_failed", validationRules: rules, validationResults: results };
      expect(TestRunDetailSchema.parse(run)).toEqual(run);
      expect(TestRunDetailSchema.parse({ ...detail, validationRules: rules })).toMatchObject({ validationResults: null });
    });

    it.each<[string, Record<string, unknown>]>([
      ["no rules field", { validationRules: undefined }],
      ["no results field", { validationResults: undefined }],
      ["a rule of the wrong shape", { validationRules: [{ ...rules[0], pattern: null }] }],
      ["a rule with an extra field", { validationRules: [{ ...rules[0], extra: 1 }] }],
      ["results not one per rule", { validationRules: rules, validationResults: [results[0]] }],
      ["results out of the rules' order", { validationRules: rules, validationResults: [results[1], results[0]] }],
      ["a result naming another rule", { validationRules: rules, validationResults: [results[0], { ...results[1], id: RUN_ID }] }],
      ["a passed that isn't a boolean", { validationRules: rules, validationResults: [{ ...results[0], passed: "true" }, results[1]] }],
      ["over 200 rules", { validationRules: Array.from({ length: 201 }, () => rules[0]) }],
    ])("refuse %s", (_label, overrides) => {
      expect(TestRunDetailSchema.safeParse({ ...detail, ...overrides }).success).toBe(false);
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["an error message over its bound", { errorMessage: "e".repeat(2_001) }],
    ["a text it ran over 1 MiB of characters", { mutatedYaml: "m".repeat(1_048_577) }],
    ["logs over 256 KiB", { logs: "l".repeat(262_145) }],
    ["an error code that isn't lower-case words", { errorCode: "Timed Out" }],
    ["an unknown strategy", { strategy: "kafka" }],
    ["a mutation message over its bound", { mutations: [{ id: "R-001", severity: "info", message: "m".repeat(4_097), details: {} }] }],
  ])("bound every string: %s is refused", (_label, overrides) => {
    expect(TestRunDetailSchema.safeParse({ ...detail, ...overrides }).success).toBe(false);
  });

  describe("count code points, as the tester and the table do, never UTF-16 units", () => {
    it("codePointLength counts a pair once and a lone surrogate once", () => {
      expect(codePointLength("")).toBe(0);
      expect(codePointLength("abc")).toBe(3);
      expect(codePointLength("😀😀")).toBe(2);
      expect(codePointLength("a\uD800b\uDC00")).toBe(4);
      expect(codePointLength("\uD800")).toBe(1);
    });

    it.each<[string, number, (value: string) => Record<string, unknown>]>([
      ["the logs", 262_144, (value) => ({ logs: value })],
      ["the text it ran", 1_048_576, (value) => ({ mutatedYaml: value })],
      ["an error message", 2_000, (value) => ({ errorMessage: value })],
      ["a mutation's message", 4_096, (value) => ({ mutations: [{ id: "R-001", severity: "info", message: value, details: {} }] })],
      [
        "a finding's message",
        4_096,
        (value) => ({ compatibility: [{ id: "C-003", severity: "advisory", component: "c", message: value, details: {} }] }),
      ],
      [
        "a finding's component",
        1_024,
        (value) => ({ compatibility: [{ id: "C-003", severity: "advisory", component: value, message: "m", details: {} }] }),
      ],
    ])("%s: %d emoji are taken, one more is refused", (_label, bound, field) => {
      expect(TestRunDetailSchema.safeParse({ ...detail, ...field("😀".repeat(bound)) }).success).toBe(true);
      expect(TestRunDetailSchema.safeParse({ ...detail, ...field("😀".repeat(bound + 1)) }).success).toBe(false);
    });
  });

  it("carry a test file with its hex SHA-256", () => {
    const file = {
      id: FILE_ID,
      displayName: "App logs",
      fileName: "app-logs.json",
      description: "",
      contentType: "application/json",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      createdAt: "2026-10-09T12:00:00.000Z",
    };
    expect(TestFileSchema.parse(file)).toEqual(file);
    expect(TestFileSchema.safeParse({ ...file, sha256: "A".repeat(64) }).success).toBe(false);
    expect(TestFileSchema.safeParse({ ...file, sizeBytes: TEST_FILE_MAXIMUM_BYTES + 1 }).success).toBe(false);
  });
});
