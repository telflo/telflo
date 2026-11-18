import { describe, expect, it } from "vitest";
import { PublicQueueTestRunRequestSchema, PublicTestRunSchema } from "./test-runs.js";

/* The public test runs' shapes (D25 routes 26-28, decisions 40 and 43). */

const TEXT_RULE = { kind: "contains_text", target: "output", pattern: "x" };
const YAML = "receivers: {}\n";
const VERSION = { configurationId: "0190a0f0-0000-7000-8000-000000000001", versionNumber: 2 };
const RUN = { sample: "{}", signal: "logs", pipeline: "logs/app" };

describe("PublicQueueTestRunRequestSchema", () => {
  it("takes a version or a text, the duration defaulted to 5 and useSavedRules to false; rules or useSavedRules", () => {
    expect(PublicQueueTestRunRequestSchema.parse({ ...VERSION, ...RUN, useSavedRules: true })).toEqual({
      ...VERSION,
      ...RUN,
      durationSeconds: 5,
      useSavedRules: true,
    });
    expect(PublicQueueTestRunRequestSchema.parse({ yaml: YAML, ...RUN, rules: [TEXT_RULE] })).toEqual({
      yaml: YAML,
      ...RUN,
      durationSeconds: 5,
      useSavedRules: false,
      rules: [{ ...TEXT_RULE, name: "", description: "" }],
    });
    for (const body of [
      { ...VERSION, ...RUN, useSavedRules: true, durationSeconds: 60, collectorVersion: "0.1.2", distribution: "otelcol-contrib" },
      { ...VERSION, ...RUN, rules: Array(20).fill(TEXT_RULE), durationSeconds: 1 },
      { yaml: YAML, ...RUN, sample: "", useSavedRules: false, rules: [TEXT_RULE] },
    ]) {
      expect(PublicQueueTestRunRequestSchema.safeParse(body).success).toBe(true);
    }
  });

  it("refuses both sources or neither, half a version, rules with useSavedRules or neither, useSavedRules on a text, a pipeline of another signal, and the limits", () => {
    for (const body of [
      { ...VERSION, ...RUN },
      { yaml: YAML, ...RUN },
      { ...VERSION, ...RUN, useSavedRules: false },
      { ...VERSION, yaml: YAML, ...RUN, rules: [TEXT_RULE] },
      { ...RUN, rules: [TEXT_RULE] },
      { configurationId: VERSION.configurationId, ...RUN, rules: [TEXT_RULE] },
      { versionNumber: 1, ...RUN, rules: [TEXT_RULE] },
      { configurationId: VERSION.configurationId, yaml: YAML, ...RUN, rules: [TEXT_RULE] },
      { ...VERSION, ...RUN, rules: [TEXT_RULE], useSavedRules: true },
      { yaml: YAML, ...RUN, useSavedRules: true },
      { yaml: YAML, ...RUN, rules: [TEXT_RULE], pipeline: "traces/app" },
      { yaml: YAML, ...RUN, rules: [] },
      { yaml: YAML, ...RUN, rules: Array(21).fill(TEXT_RULE) },
      { yaml: YAML, ...RUN, rules: [TEXT_RULE], durationSeconds: 0 },
      { yaml: YAML, ...RUN, rules: [TEXT_RULE], durationSeconds: 61 },
      { ...VERSION, ...RUN, rules: [TEXT_RULE], versionNumber: 0 },
      { yaml: "", ...RUN, rules: [TEXT_RULE] },
      { yaml: YAML, ...RUN, rules: [TEXT_RULE], sample: undefined },
      { yaml: YAML, ...RUN, rules: [TEXT_RULE], collectorVersion: "latest" },
      { yaml: YAML, ...RUN, rules: [TEXT_RULE], distribution: "Otelcol" },
      { yaml: YAML, ...RUN, rules: [TEXT_RULE], target_pipeline: "logs/app" },
    ]) {
      expect(PublicQueueTestRunRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("PublicTestRunSchema", () => {
  it("is strict: a run's fields only", () => {
    const run = {
      id: "0190a0f0-0000-7000-8000-000000000002",
      status: "queued",
      success: null,
      signal: "logs",
      pipeline: "logs/app",
      durationMs: null,
      collectorVersion: "0.1.2",
      distribution: "otelcol-contrib",
      validationResults: null,
      mutations: null,
      compatibility: null,
      errorMessage: null,
      createdAt: "2026-10-24T10:00:00.000Z",
    };
    expect(PublicTestRunSchema.safeParse(run).success).toBe(true);
    expect(PublicTestRunSchema.safeParse({ ...run, yaml: YAML }).success).toBe(false);
  });
});
