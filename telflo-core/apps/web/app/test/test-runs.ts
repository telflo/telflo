import { TestRunSummarySchema, type TestFile, type TestRunDetail, type TestRunSummary } from "@telflo/contracts";
import { MEMBER_ID, MINE, VERSION_ID } from "./configurations.js";

/*
 * Test files and runs as the API answers them (D14a decision 28), for the
 * Testing tab's tests. Names carrying `zq-` are the private-text markers the
 * attribute scans look for (ADR 0024).
 */

/** A test file of the member's, uploaded at noon UTC; any field overridden. */
export function testFileFixture(overrides: Partial<TestFile> = {}): TestFile {
  return {
    id: "0199d000-0000-7000-8000-000000000001",
    displayName: "zq-app-logs",
    fileName: "zq-app-logs.json",
    description: "",
    contentType: "application/json",
    sizeBytes: 24,
    sha256: "0".repeat(64),
    createdAt: "2026-10-09T12:00:00.000Z",
    ...overrides,
  };
}

/** A run of MINE's version 1, queued by the member and waiting first in line; any field overridden. */
export function testRunFixture(overrides: Partial<TestRunDetail> = {}): TestRunDetail {
  return {
    id: "0199e000-0000-7000-8000-000000000001",
    status: "queued",
    queuedAt: "2026-10-09T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ahead: 0,
    pipeline: "logs",
    signal: "logs",
    durationSeconds: 5,
    collectorVersion: "0.162.0",
    queuedByUserId: MEMBER_ID,
    inputName: "zq-app-logs.json",
    errorCode: null,
    suiteId: null,
    suiteName: null,
    definitionId: null,
    definitionName: null,
    configurationId: MINE.id,
    versionId: VERSION_ID,
    sourceRunId: null,
    yaml: "receivers: {}\n",
    collectorDistribution: "otelcol-contrib",
    inputSizeBytes: 24,
    inputContentType: "application/json",
    strategy: null,
    kwokEnabled: null,
    mutatedYaml: null,
    mutations: null,
    compatibility: null,
    logs: null,
    timings: null,
    errorMessage: null,
    outputSizeBytes: null,
    outputTruncated: null,
    decodedInputSizeBytes: null,
    decodedInputTruncated: null,
    validationRules: [],
    validationResults: null,
    ...overrides,
  };
}

/** A run as the version's list carries it: exactly the summary's fields of `run`, from the contract's shape. */
export function testRunSummaryOf(run: TestRunDetail): TestRunSummary {
  const keys = Object.keys(TestRunSummarySchema.shape) as Array<keyof TestRunSummary>;
  return Object.fromEntries(keys.map((key) => [key, run[key]])) as TestRunSummary;
}
