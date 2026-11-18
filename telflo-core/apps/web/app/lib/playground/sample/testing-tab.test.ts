import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOttlContextOfSignal,
  TestDefinitionSchema,
  TestDefinitionsResponseSchema,
  TestFilesResponseSchema,
  TestRunDetailSchema,
  TestRunResponseSchema,
  TestRunsResponseSchema,
  TestSuiteSchema,
  TestSuitesResponseSchema,
  TestTemplateSchema,
  TestTemplatesResponseSchema,
  ValidationPipelineSchema,
  ValidationPipelinesResponseSchema,
  ValidationRuleSchema,
  ValidationRulesResponseSchema,
} from "@telflo/contracts";
import { ApiError } from "~/lib/api-client.js";
import { parse } from "~/lib/graph/parse.js";
import { CANONICAL_UUID } from "~/lib/ids.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { readsFor, SAMPLE_ORGANIZATION_ID, TESTING_READ_NAMES } from "~/lib/workspace-reads.js";
import { SAMPLE_CONFIGURATION_IDS, sampleConfigurations } from "./configurations.js";
import { SAMPLE_PINS } from "./types.js";
import { SAMPLE_TESTING_READS, sampleTesting, type SampleTesting } from "./testing-tab.js";

/*
 * The sample's Testing tab (D31-1 decisions 10, 12 and 31; Preflight
 * rulings 6 and 8): every object parses with its contracts schema and each
 * read's answer with its response schema; ids are fixed, lowercase and
 * stable; everything is the open draft's, its pipelines the text's, its
 * pins offered; and the reads answer from the sample, never calling the
 * API client. sample.test.ts searches the whole sample, this included, for
 * secret-shaped values.
 */

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ORG = SAMPLE_ORGANIZATION_ID;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every id the testing sample names. */
function idsOf(testing: SampleTesting): string[] {
  return [
    ...testing.templates.map((template) => template.id),
    ...testing.configurations.flatMap((configuration) => [
      ...configuration.runs.map((run) => run.detail.id),
      ...configuration.validationPipelines.map((pipeline) => pipeline.id),
      ...Object.values(configuration.rulesByPipeline).flatMap((rules) => rules.map((rule) => rule.id)),
      ...configuration.suites.map((suite) => suite.id),
      ...Object.values(configuration.definitionsBySuite).flatMap((definitions) => definitions.map((definition) => definition.id)),
    ]),
  ];
}

describe("the testing sample's shapes", () => {
  const testing = sampleTesting(NOW);

  it("holds the six templates and no files of the visitor's", () => {
    expect(testing.templates.map((template) => template.name)).toEqual([
      "Kubernetes pod logs",
      "Host metrics sample",
      "Checkout traces sample",
      "Browser session logs",
      "High cardinality traces",
      "Kubelet stats sample",
    ]);
    expect(testing.files).toEqual([]);
    for (const template of testing.templates) {
      expect(TestTemplateSchema.parse(template)).toEqual(template);
      expect(template.sizeBytes).toBe(testing.templateBytes[template.id]!.byteLength);
      expect(JSON.parse(new TextDecoder().decode(testing.templateBytes[template.id]))).toBeTruthy();
    }
  });

  it("parses every run, pipeline, rule, suite and definition with its schema", () => {
    for (const configuration of testing.configurations) {
      for (const { detail } of configuration.runs) expect(TestRunDetailSchema.parse(detail)).toEqual(detail);
      for (const pipeline of configuration.validationPipelines) expect(ValidationPipelineSchema.parse(pipeline)).toEqual(pipeline);
      for (const rules of Object.values(configuration.rulesByPipeline)) {
        for (const rule of rules) expect(ValidationRuleSchema.parse(rule)).toEqual(rule);
      }
      for (const suite of configuration.suites) expect(TestSuiteSchema.parse(suite)).toEqual(suite);
      for (const definitions of Object.values(configuration.definitionsBySuite)) {
        for (const definition of definitions) expect(TestDefinitionSchema.parse(definition)).toEqual(definition);
      }
    }
  });

  it("gives nine configurations runs, rules and suites, and the freshly imported one none", () => {
    const withTesting = testing.configurations.filter((configuration) => configuration.runs.length > 0);
    expect(withTesting).toHaveLength(9);
    const imported = testing.configurations.find((configuration) => configuration.configurationId === SAMPLE_CONFIGURATION_IDS.import)!;
    expect(imported).toMatchObject({ runs: [], validationPipelines: [], rulesByPipeline: {}, suites: [], definitionsBySuite: {} });
    for (const configuration of withTesting) {
      expect(configuration.validationPipelines).toHaveLength(1);
      expect(configuration.suites.length).toBeGreaterThan(0);
    }
    // Each outcome shows somewhere: passed, failed rules, and a run that failed.
    const statuses = new Set(testing.configurations.flatMap((configuration) => configuration.runs.map((run) => run.detail.status)));
    expect([...statuses].sort()).toEqual(["failed", "succeeded", "validation_failed"]);
  });

  it("has fixed lowercase ids, unique and the same on every rebuild", () => {
    const ids = idsOf(testing);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(CANONICAL_UUID);
      expect(id).toBe(id.toLowerCase());
    }
    expect(idsOf(sampleTesting(NOW + 3 * 60 * 60 * 1000))).toEqual(ids);
  });

  it("is the open draft's: its configuration, version, pin and pipelines", () => {
    const drafts = new Map(sampleConfigurations(NOW).map((sample) => [sample.configuration.id, sample.version]));
    for (const configuration of testing.configurations) {
      const draft = drafts.get(configuration.configurationId)!;
      expect(configuration.versionId).toBe(draft.id);
      const parsed = parse(draft.yamlContent);
      if (!parsed.ok) throw new Error("A sample's text doesn't parse");
      const pipelines = parsed.graph.pipelines.map((pipeline) => pipeline.name);
      for (const { detail } of configuration.runs) {
        expect(detail).toMatchObject({ configurationId: configuration.configurationId, versionId: draft.id });
        expect(detail.collectorVersion).toBe(draft.collectorVersion);
        expect(SAMPLE_PINS).toContain(detail.collectorVersion);
        expect(pipelines).toContain(detail.pipeline);
        expect(Date.parse(detail.queuedAt)).toBeLessThan(Date.parse(detail.startedAt!));
        expect(Date.parse(detail.startedAt!)).toBeLessThan(Date.parse(detail.finishedAt!));
        expect(Date.parse(detail.finishedAt!)).toBeLessThan(NOW);
      }
      for (const pipeline of configuration.validationPipelines) {
        expect(pipeline).toMatchObject({ configurationId: configuration.configurationId, versionId: draft.id });
        expect(pipelines).toContain(pipeline.pipeline);
        for (const rule of configuration.rulesByPipeline[pipeline.id]!) {
          expect(rule.validationPipelineId).toBe(pipeline.id);
          if (rule.ottl !== null) expect(isOttlContextOfSignal(rule.ottl.context, pipeline.signal)).toBe(true);
        }
      }
      for (const suite of configuration.suites) {
        expect(suite).toMatchObject({ configurationId: configuration.configurationId, versionId: draft.id });
        for (const definition of configuration.definitionsBySuite[suite.id]!) expect(pipelines).toContain(definition.pipeline);
      }
    }
  });

  it("gives each run the snapshot of its pipeline's rules, its results matched to them, and files that open", () => {
    const templates = new Map(testing.templates.map((template) => [template.fileName, template]));
    for (const configuration of testing.configurations) {
      const rules = new Map(Object.values(configuration.rulesByPipeline).flat().map((rule) => [rule.id, rule]));
      for (const { detail, files } of configuration.runs) {
        expect(detail.validationRules.length).toBeGreaterThan(0);
        for (const snapshot of detail.validationRules) expect(rules.get(snapshot.id)).toMatchObject(snapshot);
        expect(detail.validationResults === null).toBe(detail.status === "failed");
        if (detail.status === "validation_failed") expect(detail.validationResults!.some((result) => !result.passed)).toBe(true);
        if (detail.status === "succeeded") expect(detail.validationResults!.every((result) => result.passed)).toBe(true);
        const template = templates.get(detail.inputName)!;
        expect(files.input).toEqual(testing.templateBytes[template.id]);
        expect(detail.inputSizeBytes).toBe(files.input!.byteLength);
        expect(detail.decodedInputSizeBytes).toBe(files["decoded-input"]!.byteLength);
        expect(detail.outputSizeBytes).toBe(files.output?.byteLength ?? null);
        expect(detail.status === "failed").toBe(files.output === undefined);
      }
    }
  });
});

describe("the testing sample's reads", () => {
  const gateway = () => sampleTesting().configurations.find((configuration) => configuration.configurationId === SAMPLE_CONFIGURATION_IDS.gateway)!;

  it("answer every testing read", () => {
    expect(Object.keys(SAMPLE_TESTING_READS).sort()).toEqual([...TESTING_READ_NAMES].sort());
  });

  it("answer the open draft's testing in the API's shapes, never calling the API client", async () => {
    const spies = spyOnTheClient();
    const reads = readsFor(ORG);
    const { configurationId, versionId, runs, validationPipelines, suites } = gateway();

    expect(TestTemplatesResponseSchema.parse(await reads.getTestTemplates()).templates).toHaveLength(6);
    expect(TestFilesResponseSchema.parse(await reads.getTestFiles(ORG)).files).toEqual([]);
    const listed = TestRunsResponseSchema.parse(await reads.getTestRuns(ORG, configurationId, versionId)).runs;
    expect(listed.map((run) => run.id)).toEqual(runs.map((run) => run.detail.id));
    const run = TestRunResponseSchema.parse(await reads.getTestRun(ORG, configurationId, versionId, listed[0]!.id)).run;
    expect(run.id).toBe(listed[0]!.id);
    const input = await reads.getTestRunFile(ORG, configurationId, versionId, run.id, "input");
    expect(input.byteLength).toBe(run.inputSizeBytes);
    const output = await reads.getTestRunFile(ORG, configurationId, versionId, run.id, "output");
    expect(output.byteLength).toBe(run.outputSizeBytes);
    const pipelines = ValidationPipelinesResponseSchema.parse(await reads.getValidationPipelines(ORG, configurationId, versionId));
    expect(pipelines.validationPipelines.map((pipeline) => pipeline.id)).toEqual(validationPipelines.map((pipeline) => pipeline.id));
    const rules = ValidationRulesResponseSchema.parse(
      await reads.getValidationRules(ORG, configurationId, versionId, validationPipelines[0]!.id),
    ).rules;
    expect(rules.map((rule) => rule.position)).toEqual([1, 2, 3, 4]);
    expect(TestSuitesResponseSchema.parse(await reads.getTestSuites(ORG, configurationId, versionId)).suites.map((suite) => suite.id)).toEqual(
      suites.map((suite) => suite.id),
    );
    const definitions = TestDefinitionsResponseSchema.parse(await reads.getTestDefinitions(ORG, configurationId, versionId, suites[0]!.id));
    expect(definitions.definitions.length).toBeGreaterThan(0);

    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  });

  it("read ids in either case, as the API does", async () => {
    const { configurationId, versionId, runs } = gateway();
    const answer = await SAMPLE_TESTING_READS.getTestRun(ORG, configurationId.toUpperCase(), versionId.toUpperCase(), runs[0]!.detail.id.toUpperCase());
    expect(answer.run.id).toBe(runs[0]!.detail.id);
  });

  it("give a copy of a file's bytes, so a reader's change never reaches the sample", async () => {
    const { configurationId, versionId, runs } = gateway();
    const first = await SAMPLE_TESTING_READS.getTestRunFile(ORG, configurationId, versionId, runs[0]!.detail.id, "input");
    first.fill(0);
    const again = await SAMPLE_TESTING_READS.getTestRunFile(ORG, configurationId, versionId, runs[0]!.detail.id, "input");
    expect(again.some((byte) => byte !== 0)).toBe(true);
  });

  it("answer empty lists for a version the sample holds no testing for (a blank configuration's)", async () => {
    const blank = "11111111-0000-4000-8000-0000000000b1";
    const draft = "33333333-0000-4000-8000-0000000000b1";
    await expect(SAMPLE_TESTING_READS.getTestRuns(ORG, blank, draft)).resolves.toEqual({ runs: [] });
    await expect(SAMPLE_TESTING_READS.getTestSuites(ORG, blank, draft)).resolves.toEqual({ suites: [] });
    await expect(SAMPLE_TESTING_READS.getValidationPipelines(ORG, blank, draft)).resolves.toEqual({ validationPipelines: [] });
  });

  it("answer the API's own not-found for an id the sample doesn't hold", async () => {
    const { configurationId, versionId, runs } = gateway();
    const unknown = "00000000-0000-4000-8000-000000000999";
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => "answered",
        (error: unknown) => (error instanceof ApiError ? `${error.status} ${error.code}` : "other"),
      );
    expect(await codeOf(SAMPLE_TESTING_READS.getTestRun(ORG, configurationId, versionId, unknown))).toBe("404 test_run_not_found");
    expect(await codeOf(SAMPLE_TESTING_READS.getTestFileHead(ORG, unknown))).toBe("404 test_file_not_found");
    expect(await codeOf(SAMPLE_TESTING_READS.getTestDefinitions(ORG, configurationId, versionId, unknown))).toBe("404 test_suite_not_found");
    expect(await codeOf(SAMPLE_TESTING_READS.getValidationRules(ORG, configurationId, versionId, unknown))).toBe(
      "404 validation_pipeline_not_found",
    );
    // The failed run has no output.
    const failed = runs.find((run) => run.detail.status === "failed")!.detail.id;
    expect(await codeOf(SAMPLE_TESTING_READS.getTestRunFile(ORG, configurationId, versionId, failed, "output"))).toBe("404 test_run_not_found");
  });
});
