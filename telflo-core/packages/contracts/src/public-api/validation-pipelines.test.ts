import { describe, expect, it } from "vitest";
import {
  PublicReplaceValidationRulesRequestSchema,
  PublicValidationPipelineNameSchema,
  PublicValidationPipelineSchema,
} from "./validation-pipelines.js";

/* The public validation pipelines' shapes (D25 routes 13-14, decision 32, Preflight ruling 8). */

const TEXT_RULE = { kind: "contains_text", target: "output", pattern: "x" };

describe("PublicReplaceValidationRulesRequestSchema", () => {
  it("takes a signal and 1 to 20 rules in the platform's shape, the name and description defaulted", () => {
    const parsed = PublicReplaceValidationRulesRequestSchema.parse({ signal: "logs", rules: [TEXT_RULE] });
    expect(parsed).toEqual({ signal: "logs", rules: [{ ...TEXT_RULE, name: "", description: "" }] });
    expect(PublicReplaceValidationRulesRequestSchema.safeParse({ signal: "logs", rules: Array(20).fill(TEXT_RULE) }).success).toBe(true);
  });

  it("refuses no rules, 21, an unknown signal, a `name` for the pipeline, an unknown field and a rule of the wrong shape", () => {
    for (const body of [
      { signal: "logs", rules: [] },
      { signal: "logs", rules: Array(21).fill(TEXT_RULE) },
      { signal: "profiles", rules: [TEXT_RULE] },
      { signal: "logs", rules: [TEXT_RULE], name: "API tests" },
      { signal: "logs", rules: [{ ...TEXT_RULE, extra: 1 }] },
      { signal: "logs", rules: [{ kind: "ottl", target: "output", pattern: "x" }] },
      { rules: [TEXT_RULE] },
    ]) {
      expect(PublicReplaceValidationRulesRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("PublicValidationPipelineNameSchema", () => {
  it("takes 1 to 200 characters, a / included, and nothing Postgres can't store", () => {
    expect(PublicValidationPipelineNameSchema.safeParse("traces/otlp").success).toBe(true);
    expect(PublicValidationPipelineNameSchema.safeParse(`logs/${"a".repeat(195)}`).success).toBe(true);
    expect(PublicValidationPipelineNameSchema.safeParse(`logs/${"a".repeat(196)}`).success).toBe(false);
    expect(PublicValidationPipelineNameSchema.safeParse("").success).toBe(false);
    expect(PublicValidationPipelineNameSchema.safeParse("logs/\u0000").success).toBe(false);
  });
});

describe("PublicValidationPipelineSchema", () => {
  const pipeline = {
    id: "0192f1a0-0000-7000-8000-000000000001",
    configurationId: "0192f1a0-0000-7000-8000-000000000002",
    versionId: "0192f1a0-0000-7000-8000-000000000003",
    versionNumber: 1,
    pipeline: "traces/otlp",
    signal: "traces",
    createdByUserId: null,
    createdAt: "2026-10-24T00:00:00.000Z",
    rules: [],
  };

  it("takes the platform's pipeline with its version's number and rules", () => {
    expect(PublicValidationPipelineSchema.safeParse(pipeline).success).toBe(true);
  });

  it("refuses a signal that isn't the name's first part, and a rule without isApiOwned", () => {
    expect(PublicValidationPipelineSchema.safeParse({ ...pipeline, signal: "logs" }).success).toBe(false);
    const rule = {
      id: "0192f1a0-0000-7000-8000-000000000004",
      validationPipelineId: pipeline.id,
      position: 1,
      kind: "contains_text",
      target: "output",
      pattern: "x",
      ottl: null,
      name: "",
      description: "",
      createdByUserId: null,
      createdAt: pipeline.createdAt,
      updatedAt: pipeline.createdAt,
    };
    expect(PublicValidationPipelineSchema.safeParse({ ...pipeline, rules: [{ ...rule, isApiOwned: true }] }).success).toBe(true);
    expect(PublicValidationPipelineSchema.safeParse({ ...pipeline, rules: [rule] }).success).toBe(false);
  });
});
