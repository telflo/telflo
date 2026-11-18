import { describe, expect, it } from "vitest";
import { validationRuleFixture } from "~/test/validation-pipelines.js";
import { INPUT_LABELS, ruleDisplayName, ruleNameOrSummary, ruleTypeLabel, summarizeRule } from "./validation-display.js";

/*
 * The rules' display helpers: the five kinds' labels, with the target folded
 * in, and each OTTL quantifier's summary.
 */

describe("the labels", () => {
  it("name each kind, the target folded into the long form; an OTTL rule keeps the output's", () => {
    expect(ruleTypeLabel("contains_text", "output")).toBe("Output contains text");
    expect(ruleTypeLabel("not_contains_regex", "stderr")).toBe("Stderr does not contain regex");
    expect(ruleTypeLabel("ottl", "stderr")).toBe("OTTL condition assertion");
    expect(ruleTypeLabel("not_contains_text")).toBe("Output does not contain text");
    expect(INPUT_LABELS).toEqual({
      contains_text: "Input",
      not_contains_text: "Input",
      contains_regex: "Regex",
      not_contains_regex: "Regex",
      ottl: "Condition",
    });
  });
});

describe("the summaries", () => {
  const ottl = (condition: Parameters<typeof summarizeRule>[0]["ottl"]) =>
    validationRuleFixture({ kind: "ottl", pattern: null, ottl: condition, name: "" });

  it("give a text rule's pattern as it is, and each OTTL quantifier in its words", () => {
    expect(summarizeRule(validationRuleFixture({ pattern: "zq-secret" }))).toBe("zq-secret");
    expect(summarizeRule(ottl({ context: "log", quantifier: "all", condition: 'attributes["env"] == "prod"' }))).toBe(
      'all log: attributes["env"] == "prod"',
    );
    expect(summarizeRule(ottl({ context: "log", quantifier: "count", condition: "true", count: { operator: "gte", value: 1 } }))).toBe(
      "at least 1 log(s) where true",
    );
    expect(
      summarizeRule(ottl({ context: "span", quantifier: "count", condition: "true", count: { operator: "between", value: 1, value2: 5 } })),
    ).toBe("between 1 and 5 span(s) where true");
    expect(
      summarizeRule(
        ottl({ context: "datapoint", quantifier: "distinct", expression: 'attributes["route"]', count: { operator: "ne", value: 0 } }),
      ),
    ).toBe('not exactly 0 distinct attributes["route"]');
    expect(
      summarizeRule(
        ottl({
          context: "datapoint",
          quantifier: "distinct",
          expression: 'attributes["route"]',
          condition: 'metric.name == "x"',
          count: { operator: "lte", value: 50 },
        }),
      ),
    ).toBe('at most 50 distinct attributes["route"] where metric.name == "x"');
  });

  it("show a rule by its name when it has one, else its summary, after its verb", () => {
    expect(ruleDisplayName(validationRuleFixture())).toBe("Does not contain: zq-no-secrets");
    expect(ruleDisplayName(validationRuleFixture({ name: "  ", kind: "contains_regex", pattern: "^err" }))).toBe("Contains: ^err");
    expect(ruleNameOrSummary(ottl({ context: "log", quantifier: "none", condition: "true" }))).toBe("none log: true");
    expect(ruleDisplayName(ottl({ context: "log", quantifier: "none", condition: "true" }))).toBe("OTTL: none log: true");
  });
});
