import { describe, expect, it } from "vitest";
import { CONFIGURATION_ERROR_CODES } from "./configurations.js";
import { FLOW_ERROR_CODES } from "./flows.js";
import { IDENTITY_ERROR_CODES } from "./identity.js";
import { ORGANIZATION_ERROR_CODES } from "./organizations.js";
import { SALES_INQUIRY_ERROR_CODES } from "./sales-inquiries.js";
import { OIDC_QUERY_ERROR_CODES, SESSION_ERROR_CODES } from "./sessions.js";
import { TEST_REGEX_ERROR_CODES } from "./test-regexes.js";
import { TESTING_ERROR_CODES } from "./test-runs.js";
import {
  CreateValidationPipelineRequestSchema,
  CreateValidationRuleRequestSchema,
  isBlankRuleText,
  isOttlContextOfSignal,
  OTTL_CONTEXTS,
  OTTL_CONTEXTS_BY_SIGNAL,
  RULES_UNAVAILABLE_AT_QUEUE_MESSAGE,
  RULES_UNAVAILABLE_AT_SAVE_MESSAGE,
  RULES_UNAVAILABLE_RUN_MESSAGE,
  ruleTextTooLongMessage,
  signalOfPipeline,
  trimRuleText,
  UpdateValidationRuleRequestSchema,
  VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER,
  VALIDATION_RULE_COUNT_MAXIMUM,
  VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH,
  VALIDATION_RULE_KINDS,
  VALIDATION_RULE_LIMIT_MESSAGE,
  VALIDATION_RULE_NAME_MAXIMUM_LENGTH,
  VALIDATION_RULE_TEXT_MAXIMUM_BYTES,
  VALIDATION_RULES_ERROR_CODES,
  VALIDATION_RULES_PER_PIPELINE_MAXIMUM,
  validationPipelineExistsMessage,
  ValidationPipelineResponseSchema,
  ValidationPipelineSchema,
  ValidationPipelinesResponseSchema,
  ValidationRuleResponseSchema,
  ValidationRuleResultSchema,
  ValidationRuleSchema,
  ValidationRuleSnapshotSchema,
  ValidationRulesResponseSchema,
} from "./validation-rules.js";

// The validation pipelines' and rules' contracts: each schema's accepted
// and refused shapes, the bounds migration 030's checks and the evaluator's
// contract set (bytes, not characters, for a pattern, condition or
// expression), and the error codes.

const RULE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";
const PIPELINE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a71";
const CONFIGURATION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a72";
const VERSION_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a73";
const USER_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a74";
const NOW = "2026-10-11T10:00:00.000Z";

/** A path and message per issue, for a refusal's assertions. */
function issuesOf(result: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } }) {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

const ALL_RULE = { kind: "ottl", target: "output", ottl: { context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' } };

describe("the limits, the words and the codes", () => {
  it("are the rules' caps, migration 030's and the evaluator's contract's", () => {
    expect(VALIDATION_RULES_PER_PIPELINE_MAXIMUM).toBe(200);
    expect(VALIDATION_RULE_TEXT_MAXIMUM_BYTES).toBe(8_192);
    expect(VALIDATION_RULE_NAME_MAXIMUM_LENGTH).toBe(200);
    expect(VALIDATION_RULE_DESCRIPTION_MAXIMUM_LENGTH).toBe(2_000);
    expect(VALIDATION_RULE_COUNT_MAXIMUM).toBe(2_147_483_647);
    expect(VALIDATION_RULE_CHECKS_PER_MINUTE_PER_USER).toBe(30);
    expect(VALIDATION_RULE_KINDS).toEqual(["contains_text", "not_contains_text", "contains_regex", "not_contains_regex", "ottl"]);
  });

  it("the validation rules' codes, with their words exactly", () => {
    expect(VALIDATION_RULES_ERROR_CODES).toEqual([
      "validation_pipeline_not_found",
      "validation_rule_not_found",
      "validation_pipeline_exists",
      "validation_rule_limit_reached",
      "validation_rule_invalid",
      "rules_unavailable",
      "validation_rule_rate_limited",
    ]);
    expect(validationPipelineExistsMessage("logs/default")).toBe(
      'Pipeline "logs/default" already has a validation pipeline for this version.',
    );
    expect(VALIDATION_RULE_LIMIT_MESSAGE).toBe("A validation pipeline can have at most 200 rules.");
    expect(RULES_UNAVAILABLE_AT_SAVE_MESSAGE).toBe("Rules can't be checked right now. Try again shortly.");
    expect(RULES_UNAVAILABLE_AT_QUEUE_MESSAGE).toBe("Validation rules can't be checked right now. Try again later.");
    expect(RULES_UNAVAILABLE_RUN_MESSAGE).toBe("Validation rules couldn't be checked: the rule evaluator is unavailable.");
  });

  it("no code is another module's: validation_unavailable and validation_rate_limited stay the validator's", () => {
    const others = new Set<string>([
      ...CONFIGURATION_ERROR_CODES,
      ...TESTING_ERROR_CODES,
      ...IDENTITY_ERROR_CODES,
      ...ORGANIZATION_ERROR_CODES,
      ...FLOW_ERROR_CODES,
      ...TEST_REGEX_ERROR_CODES,
      ...SESSION_ERROR_CODES,
      ...OIDC_QUERY_ERROR_CODES,
      ...SALES_INQUIRY_ERROR_CODES,
    ]);
    expect(others.has("validation_unavailable")).toBe(true);
    expect(others.has("validation_rate_limited")).toBe(true);
    for (const code of VALIDATION_RULES_ERROR_CODES) expect(others.has(code)).toBe(false);
    // There is no cap on validation pipelines per version.
    expect(VALIDATION_RULES_ERROR_CODES).not.toContain("validation_pipeline_limit_reached");
  });
});

describe("the contexts each signal allows", () => {
  it("are the evaluator's table (pkg/ottlassert's signalContexts), drawn from the seven", () => {
    expect(OTTL_CONTEXTS_BY_SIGNAL).toEqual({
      logs: ["log", "resource", "scope"],
      traces: ["span", "spanevent", "resource", "scope"],
      metrics: ["metric", "datapoint", "resource", "scope"],
    });
    expect(OTTL_CONTEXTS).toEqual(["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"]);
    expect(new Set(Object.values(OTTL_CONTEXTS_BY_SIGNAL).flat())).toEqual(new Set(OTTL_CONTEXTS));
  });

  it("isOttlContextOfSignal answers the table", () => {
    expect(isOttlContextOfSignal("log", "logs")).toBe(true);
    expect(isOttlContextOfSignal("resource", "metrics")).toBe(true);
    expect(isOttlContextOfSignal("span", "logs")).toBe(false);
    expect(isOttlContextOfSignal("datapoint", "traces")).toBe(false);
    expect(isOttlContextOfSignal("nonsense", "logs")).toBe(false);
  });
});

describe("a validation pipeline", () => {
  it("is created by its YAML pipeline's name, whose first part is a signal", () => {
    for (const pipeline of ["logs", "logs/default", "traces/edge-1", "metrics/a/b"]) {
      expect(CreateValidationPipelineRequestSchema.parse({ pipeline })).toEqual({ pipeline });
    }
    expect(signalOfPipeline("logs/default")).toBe("logs");
    expect(signalOfPipeline("profiles/x")).toBeUndefined();
  });

  it("refuses a name without a signal, an empty or long one, and anything else in the body", () => {
    for (const body of [
      { pipeline: "profiles/x" },
      { pipeline: "log/default" },
      { pipeline: "" },
      { pipeline: `logs/${"a".repeat(196)}` },
      { pipeline: "logs\u0000" },
      { pipeline: "logs", signal: "logs" },
      {},
    ]) {
      expect(CreateValidationPipelineRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("answers with its pipeline and signal, which must agree; strictly", () => {
    const pipeline = {
      id: PIPELINE_ID,
      configurationId: CONFIGURATION_ID,
      versionId: VERSION_ID,
      pipeline: "logs/default",
      signal: "logs",
      createdByUserId: null,
      createdAt: NOW,
    };
    expect(ValidationPipelineResponseSchema.parse({ validationPipeline: pipeline })).toEqual({ validationPipeline: pipeline });
    expect(ValidationPipelinesResponseSchema.parse({ validationPipelines: [pipeline] }).validationPipelines).toHaveLength(1);
    expect(ValidationPipelineSchema.safeParse({ ...pipeline, signal: "traces" }).success).toBe(false);
    expect(ValidationPipelineSchema.safeParse({ ...pipeline, name: "" }).success).toBe(false);
    expect(ValidationPipelineSchema.safeParse({ ...pipeline, updatedAt: NOW }).success).toBe(false);
  });
});

describe("a rule's create request", () => {
  it("accepts each kind, with its own fields, and defaults the name and description to ''", () => {
    for (const kind of ["contains_text", "not_contains_text", "contains_regex", "not_contains_regex"] as const) {
      for (const target of ["output", "stderr"] as const) {
        expect(CreateValidationRuleRequestSchema.parse({ kind, target, pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" })).toEqual({
          kind,
          target,
          pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
          name: "",
          description: "",
        });
      }
    }
    expect(CreateValidationRuleRequestSchema.parse(ALL_RULE)).toEqual({ ...ALL_RULE, name: "", description: "" });
  });

  it("accepts each quantifier's shape: all, any, none take a condition; count a count too; distinct an expression and a count", () => {
    const shapes = [
      { context: "log", quantifier: "any", condition: "true" },
      { context: "resource", quantifier: "none", condition: 'attributes["x"] == nil' },
      { context: "log", quantifier: "count", condition: "true", count: { operator: "eq", value: 0 } },
      { context: "log", quantifier: "count", condition: "true", count: { operator: "between", value: 3, value2: 3 } },
      { context: "log", quantifier: "distinct", expression: 'attributes["pod"]', count: { operator: "lte", value: 10 } },
      { context: "log", quantifier: "distinct", condition: 'severity_text == "ERROR"', expression: "body", count: { operator: "gt", value: 2_147_483_647 } },
    ];
    for (const ottl of shapes) {
      expect(CreateValidationRuleRequestSchema.parse({ kind: "ottl", target: "output", ottl }).ottl).toEqual(ottl);
    }
  });

  it("keeps a pattern exactly as sent: never trimmed (a regex's spaces are part of it)", () => {
    expect(CreateValidationRuleRequestSchema.parse({ kind: "contains_regex", target: "output", pattern: " a b " }).pattern).toBe(" a b ");
  });

  it("counts a pattern's, a condition's and an expression's 8,192 in bytes, not characters", () => {
    const at = (pattern: string) => CreateValidationRuleRequestSchema.safeParse({ kind: "contains_text", target: "output", pattern });
    expect(at("a".repeat(8_192)).success).toBe(true);
    expect(issuesOf(at("a".repeat(8_193)))).toEqual([{ path: "pattern", message: "The pattern is longer than 8,192 bytes." }]);
    // 8,192 characters of two bytes each: 16,384 bytes, refused, as octet_length would.
    expect(issuesOf(at("é".repeat(8_192)))).toEqual([{ path: "pattern", message: "The pattern is longer than 8,192 bytes." }]);
    expect(at("é".repeat(4_096)).success).toBe(true);
    // 2,048 four-byte code points (4,096 UTF-16 units) are 8,192 bytes; one more is over.
    expect(at("😀".repeat(2_048)).success).toBe(true);
    expect(at("😀".repeat(2_048) + "a").success).toBe(false);

    const ottl = (field: "condition" | "expression", text: string) =>
      CreateValidationRuleRequestSchema.safeParse({
        kind: "ottl",
        target: "output",
        ottl: { context: "log", quantifier: "distinct", count: { operator: "eq", value: 1 }, expression: "body", [field]: text },
      });
    expect(ottl("condition", "é".repeat(4_096)).success).toBe(true);
    expect(issuesOf(ottl("condition", "é".repeat(8_192)))).toEqual([
      { path: "ottl.condition", message: "The condition is longer than 8,192 bytes." },
    ]);
    expect(issuesOf(ottl("expression", "é".repeat(4_097)))).toEqual([
      { path: "ottl.expression", message: "The expression is longer than 8,192 bytes." },
    ]);
  });

  it("refuses a blank pattern, condition or expression: whitespace as Go's unicode.IsSpace, no-break space included", () => {
    for (const blank of ["", " ", "\t\n", "\u00a0", "\u3000 \u2028"]) {
      expect(isBlankRuleText(blank)).toBe(true);
      expect(issuesOf(CreateValidationRuleRequestSchema.safeParse({ kind: "contains_text", target: "output", pattern: blank }))).toEqual([
        { path: "pattern", message: "The pattern is empty." },
      ]);
      expect(
        issuesOf(CreateValidationRuleRequestSchema.safeParse({ ...ALL_RULE, ottl: { ...ALL_RULE.ottl, condition: blank } })),
      ).toEqual([{ path: "ottl.condition", message: "The condition is empty." }]);
    }
    // A zero-width space isn't whitespace to Go, nor here.
    expect(isBlankRuleText("\u200b")).toBe(false);
  });

  it("trims exactly isBlankRuleText's whitespace (trimRuleText): U+0085 goes, U+FEFF stays, as Go's unicode.IsSpace", () => {
    const goSpaces = "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
    expect(isBlankRuleText(goSpaces)).toBe(true);
    expect(trimRuleText(goSpaces)).toBe("");
    expect(trimRuleText(`${goSpaces}zq a\u00a0b${goSpaces}`)).toBe("zq a\u00a0b");
    // JavaScript's trim keeps U+0085 and strips U+FEFF; Go's IsSpace is the other way round.
    expect(trimRuleText("\u0085zq\u0085")).toBe("zq");
    expect(isBlankRuleText("\ufeff")).toBe(false);
    expect(trimRuleText("\ufeff")).toBe("\ufeff");
    expect(trimRuleText(" \ufeffzq\ufeff ")).toBe("\ufeffzq\ufeff");
    // Neither a zero-width space nor U+180E (whitespace before Unicode 6.3) is.
    expect(trimRuleText("\u200bzq\u180e")).toBe("\u200bzq\u180e");
    expect(trimRuleText("")).toBe("");
    // Whatever it trims to is what the schema keeps: never blank unless isBlankRuleText says so.
    for (const text of ["\ufeff", "\u200b", " \u0085 ", "zq"]) {
      expect(trimRuleText(text) === "").toBe(isBlankRuleText(text));
    }
  });

  it("words a text past 8,192 bytes as the schema does (ruleTextTooLongMessage)", () => {
    expect(ruleTextTooLongMessage("pattern")).toBe("The pattern is longer than 8,192 bytes.");
    expect(ruleTextTooLongMessage("condition")).toBe("The condition is longer than 8,192 bytes.");
  });

  it("refuses what Postgres can't store exactly: U+0000, a lone surrogate", () => {
    for (const pattern of ["a\u0000b", "a\ud800b"]) {
      expect(CreateValidationRuleRequestSchema.safeParse({ kind: "contains_regex", target: "output", pattern }).success).toBe(false);
    }
    expect(CreateValidationRuleRequestSchema.safeParse({ ...ALL_RULE, name: "a\u0000" }).success).toBe(false);
  });

  it("refuses the kind's fields mixed up, as migration 030's checks do", () => {
    const cases: Array<[Record<string, unknown>, Array<{ path: string; message: string }>]> = [
      [{ ...ALL_RULE, target: "stderr" }, [{ path: "target", message: "An OTTL rule checks the output only." }]],
      [{ kind: "ottl", target: "output" }, [{ path: "ottl", message: "An OTTL rule needs its OTTL." }]],
      [{ ...ALL_RULE, pattern: "x" }, [{ path: "pattern", message: "Only a text or regex rule has a pattern." }]],
      [{ kind: "contains_text", target: "output" }, [{ path: "pattern", message: "A text or regex rule needs its pattern." }]],
      [{ kind: "contains_text", target: "output", pattern: "x", ottl: ALL_RULE.ottl }, [{ path: "ottl", message: "Only an OTTL rule has OTTL." }]],
    ];
    for (const [body, issues] of cases) expect(issuesOf(CreateValidationRuleRequestSchema.safeParse(body))).toEqual(issues);
  });

  it("refuses an OTTL shape its quantifier doesn't take", () => {
    const rule = (ottl: Record<string, unknown>) => CreateValidationRuleRequestSchema.safeParse({ kind: "ottl", target: "output", ottl });
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ context: "log", quantifier: "all" }, "ottl.condition", "The condition is empty."],
      [{ context: "log", quantifier: "any", condition: "true", expression: "body" }, "ottl.expression", "Only a distinct rule has an expression."],
      [{ context: "log", quantifier: "none", condition: "true", count: { operator: "eq", value: 1 } }, "ottl.count", "Only a count or distinct rule has a count."],
      [{ context: "log", quantifier: "count", condition: "true" }, "ottl.count", "A count or distinct rule needs a count."],
      [{ context: "log", quantifier: "distinct", count: { operator: "eq", value: 1 } }, "ottl.expression", "A distinct rule needs an expression."],
      [{ context: "log", quantifier: "distinct", expression: "body" }, "ottl.count", "A count or distinct rule needs a count."],
      [{ context: "log", quantifier: "count", condition: "true", count: { operator: "between", value: 2 } }, "ottl.count.value2", "Between needs a second value."],
      [
        { context: "log", quantifier: "count", condition: "true", count: { operator: "between", value: 5, value2: 4 } },
        "ottl.count.value2",
        "Between's second value can't be less than its first.",
      ],
      [{ context: "log", quantifier: "count", condition: "true", count: { operator: "eq", value: 2, value2: 3 } }, "ottl.count.value2", "Only between has a second value."],
    ];
    for (const [ottl, path, message] of cases) expect(issuesOf(rule(ottl))).toEqual([{ path, message }]);
  });

  it("refuses a count that isn't an integer from 0 to 2,147,483,647", () => {
    for (const count of [
      { operator: "eq", value: -1 },
      { operator: "eq", value: 2.5 },
      { operator: "eq", value: "2" },
      { operator: "eq", value: true },
      { operator: "eq", value: 2_147_483_648 },
      { operator: 5, value: 2 },
      { operator: "approximately", value: 2 },
      { operator: "between", value: 1, value2: "9" },
    ]) {
      expect(
        CreateValidationRuleRequestSchema.safeParse({ kind: "ottl", target: "output", ottl: { context: "log", quantifier: "count", condition: "true", count } })
          .success,
      ).toBe(false);
    }
  });

  it("refuses an unknown or retired kind, context, quantifier or target, null for an absent field, and an unknown field", () => {
    for (const body of [
      { kind: "json_path", target: "output", pattern: "$.x" },
      { kind: "contains_text", target: "stdout", pattern: "x" },
      { ...ALL_RULE, ottl: { ...ALL_RULE.ottl, context: "profile" } },
      { ...ALL_RULE, ottl: { ...ALL_RULE.ottl, quantifier: "sometimes" } },
      { ...ALL_RULE, ottl: { ...ALL_RULE.ottl, expression: null } },
      { ...ALL_RULE, pattern: null },
      { ...ALL_RULE, ottl: { ...ALL_RULE.ottl, statements: [] } },
      { ...ALL_RULE, position: 1 },
      { ...ALL_RULE, enabled: true },
    ]) {
      expect(CreateValidationRuleRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("trims the name and description, at most 200 and 2,000 characters (code points, as char_length counts)", () => {
    expect(CreateValidationRuleRequestSchema.parse({ ...ALL_RULE, name: "  SSN  ", description: " none " })).toMatchObject({
      name: "SSN",
      description: "none",
    });
    expect(CreateValidationRuleRequestSchema.safeParse({ ...ALL_RULE, name: "😀".repeat(200) }).success).toBe(true);
    expect(CreateValidationRuleRequestSchema.safeParse({ ...ALL_RULE, name: "a".repeat(201) }).success).toBe(false);
    expect(CreateValidationRuleRequestSchema.safeParse({ ...ALL_RULE, description: "a".repeat(2_000) }).success).toBe(true);
    expect(CreateValidationRuleRequestSchema.safeParse({ ...ALL_RULE, description: "a".repeat(2_001) }).success).toBe(false);
  });
});

describe("a rule's update request", () => {
  it("takes a name or a description alone", () => {
    expect(UpdateValidationRuleRequestSchema.parse({ name: " Renamed " })).toEqual({ name: "Renamed" });
    expect(UpdateValidationRuleRequestSchema.parse({ description: "" })).toEqual({ description: "" });
  });

  it("takes what the rule checks whole: its kind, target and the kind's fields, as a create", () => {
    expect(UpdateValidationRuleRequestSchema.parse({ kind: "contains_regex", target: "stderr", pattern: "ERROR" })).toEqual({
      kind: "contains_regex",
      target: "stderr",
      pattern: "ERROR",
    });
    expect(UpdateValidationRuleRequestSchema.parse({ ...ALL_RULE, name: "x" }).ottl).toEqual(ALL_RULE.ottl);
  });

  it("takes nothing to change ({}), as a suite's PATCH: the API answers the rule as it is", () => {
    expect(UpdateValidationRuleRequestSchema.parse({})).toEqual({});
  });

  it("refuses half of what the rule checks, and the kind's fields mixed up", () => {
    expect(issuesOf(UpdateValidationRuleRequestSchema.safeParse({ pattern: "x" }))).toEqual([
      { path: "kind", message: "What a rule checks needs its kind." },
      { path: "target", message: "What a rule checks needs its target." },
    ]);
    expect(issuesOf(UpdateValidationRuleRequestSchema.safeParse({ ottl: ALL_RULE.ottl, target: "output" }))).toEqual([
      { path: "kind", message: "What a rule checks needs its kind." },
    ]);
    expect(issuesOf(UpdateValidationRuleRequestSchema.safeParse({ kind: "ottl", target: "stderr", ottl: ALL_RULE.ottl }))).toEqual([
      { path: "target", message: "An OTTL rule checks the output only." },
    ]);
    expect(UpdateValidationRuleRequestSchema.safeParse({ name: "x", position: 2 }).success).toBe(false);
  });
});

const STORED_RULE = {
  id: RULE_ID,
  validationPipelineId: PIPELINE_ID,
  position: 1,
  kind: "contains_regex",
  target: "output",
  pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
  ottl: null,
  name: "",
  description: "",
  createdByUserId: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("a rule as the API answers it, and as a run snapshots it", () => {
  it("carries its pattern or its OTTL, the other null; strictly", () => {
    expect(ValidationRuleResponseSchema.parse({ rule: STORED_RULE })).toEqual({ rule: STORED_RULE });
    const ottlRule = { ...STORED_RULE, kind: "ottl", pattern: null, ottl: ALL_RULE.ottl };
    expect(ValidationRulesResponseSchema.parse({ rules: [STORED_RULE, ottlRule] }).rules).toHaveLength(2);
    for (const wrong of [
      { ...STORED_RULE, ottl: ALL_RULE.ottl },
      { ...STORED_RULE, pattern: null },
      { ...ottlRule, target: "stderr" },
      { ...STORED_RULE, position: 0 },
      { ...STORED_RULE, enabled: true },
    ]) {
      expect(ValidationRuleSchema.safeParse(wrong).success).toBe(false);
    }
    expect(ValidationRulesResponseSchema.safeParse({ rules: Array.from({ length: 201 }, () => STORED_RULE) }).success).toBe(false);
  });

  it("a snapshot is the rule without its pipeline, creator or times", () => {
    const { validationPipelineId: _pipeline, createdByUserId: _creator, createdAt: _created, updatedAt: _updated, ...snapshot } = STORED_RULE;
    expect(ValidationRuleSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(ValidationRuleSnapshotSchema.safeParse(STORED_RULE).success).toBe(false);
    expect(ValidationRuleSnapshotSchema.safeParse({ ...snapshot, kind: "ottl" }).success).toBe(false);
  });
});

describe("a rule's result", () => {
  const passed = { id: RULE_ID, passed: true, error: null, advisory: null, detail: null };

  it("accepts a pass, a pass with its advisory, an error, and each kind of failure's detail", () => {
    const results = [
      passed,
      { ...passed, advisory: "No log records in the output: all holds only because there was nothing to check." },
      { ...passed, passed: false, error: "OTTL syntax error: unexpected token" },
      { ...passed, passed: false, detail: { kind: "no_match", source: "stderr", searchedCharacters: 0 } },
      {
        ...passed,
        passed: false,
        detail: {
          kind: "unexpected_match",
          source: "output",
          totalMatchCount: 3,
          moreMatches: false,
          matches: [
            { text: "123-45-6789", textTruncated: false, before: '"ssn":"', after: '"', record: { index: 0, path: "resourceLogs[0]" } },
            { text: "x", textTruncated: false, before: "", after: "", record: { index: null, path: "" } },
            { text: "y", textTruncated: true, before: "", after: "", record: { line: 3 } },
          ],
        },
      },
      {
        ...passed,
        passed: false,
        detail: {
          kind: "record_mismatch",
          context: "log",
          totalCount: 10,
          matchedCount: 7,
          missCount: 3,
          misses: [{ index: 2, reason: "condition evaluated to false", snippet: "{}" }],
        },
      },
      { ...passed, passed: false, detail: { kind: "distinct_mismatch", totalCount: 4, matchedCount: 3, distinctCount: 12, samples: ["pod-a"] } },
      // A not-contains regex whose only matches were empty fails with no detail.
      { ...passed, passed: false },
    ];
    for (const result of results) expect(ValidationRuleResultSchema.parse(result)).toEqual(result);
  });

  it("passed is strictly a boolean: never the string or the number", () => {
    for (const value of ["false", "true", 0, 1, null]) {
      expect(ValidationRuleResultSchema.safeParse({ ...passed, passed: value }).success).toBe(false);
    }
  });

  it("refuses an error on a pass or beside a detail, a pass with a detail, and a field or kind it doesn't know", () => {
    const failure = { kind: "no_match", source: "output", searchedCharacters: 5 };
    for (const result of [
      { ...passed, error: "x" },
      { ...passed, passed: false, error: "x", detail: failure },
      { ...passed, detail: failure },
      { ...passed, error: "" },
      { ...passed, error: "x".repeat(4_097), passed: false },
      { ...passed, passed: false, detail: { ...failure, kind: "line_mismatch" } },
      { ...passed, passed: false, detail: { ...failure, line: 1 } },
      { ...passed, rule: "x" },
      { id: RULE_ID, passed: true, error: null, detail: null },
      {
        ...passed,
        passed: false,
        detail: { kind: "unexpected_match", source: "output", totalMatchCount: 1, moreMatches: false, matches: [] },
      },
      {
        ...passed,
        passed: false,
        detail: {
          kind: "unexpected_match",
          source: "output",
          totalMatchCount: 1,
          moreMatches: false,
          matches: [{ text: "x", textTruncated: false, before: "", after: "", record: { index: 0, path: "", line: 1 } }],
        },
      },
      { ...passed, passed: false, detail: { kind: "distinct_mismatch", totalCount: 1, matchedCount: 1, distinctCount: 6, samples: ["a", "b", "c", "d", "e", "f"] } },
    ]) {
      expect(ValidationRuleResultSchema.safeParse(result).success).toBe(false);
    }
  });
});
