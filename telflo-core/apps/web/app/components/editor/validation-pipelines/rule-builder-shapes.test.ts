import type { ValidationRuleOttl } from "@telflo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildAttributeCondition,
  escapeOttlString,
  ottlDoubleLiteral,
  ottlIntegerLiteral,
  ottlStringLiteral,
  recognizeBuilderRule,
  recognizeBuilderShapes,
  recordContextForSignal,
  unescapeOttlString,
  type AttributeOperator,
} from "./rule-builder-shapes.js";

/*
 * The rule builder's shapes, in 11 tests: the types are the platform's
 * contracts'. The canonical shapes are load-bearing (the evaluator runs them,
 * and the editor's recognize-on-edit parses them back); the round-trip below
 * is the contract test for the second. The describes after "helpers" are the
 * platform's: recognizeBuilderRule's context check, and the literal writers
 * and unescape.
 */

function attrRule(operator: AttributeOperator, value: string, quantifier: ValidationRuleOttl["quantifier"] = "all"): ValidationRuleOttl {
  return {
    context: "log",
    condition: buildAttributeCondition("http.route", operator, value),
    quantifier,
  };
}

describe("buildAttributeCondition → recognizeBuilderShapes round-trip", () => {
  it("round-trips exists", () => {
    const rec = recognizeBuilderShapes(attrRule("exists", ""));
    expect(rec).toMatchObject({
      mode: "record_attribute",
      quantifier: "all",
      scope: "record",
      key: "http.route",
      operator: "exists",
    });
  });

  it("round-trips equals with escaping-sensitive values", () => {
    const rule = attrRule("equals", 'say "hi" \\ done', "none");
    const rec = recognizeBuilderShapes(rule);
    expect(rec).toMatchObject({
      mode: "record_attribute",
      operator: "equals",
      quantifier: "none",
      value: 'say "hi" \\ done',
    });
  });

  it("round-trips numeric comparisons", () => {
    for (const [op, symbol] of [
      ["gt", ">"],
      ["gte", ">="],
      ["lt", "<"],
      ["lte", "<="],
    ] as const) {
      const rule = attrRule(op, "42");
      expect(rule.condition).toContain(` ${symbol} 42`);
      const rec = recognizeBuilderShapes(rule);
      expect(rec).toMatchObject({
        mode: "record_attribute",
        operator: op,
        value: "42",
      });
    }
  });

  it("round-trips matches_regex with backslash patterns intact", () => {
    const rule = attrRule("matches_regex", "^web-pod-\\d+$", "any");
    const rec = recognizeBuilderShapes(rule);
    expect(rec).toMatchObject({
      mode: "record_attribute",
      operator: "matches_regex",
      value: "^web-pod-\\d+$",
    });
  });

  it("reopens contains as matches_regex with the escaped literal", () => {
    const rule = attrRule("contains", "a.b");
    // Regex-escaped so IsMatch degrades to substring match.
    expect(rule.condition).toContain('IsMatch(attributes["http.route"], "a\\\\.b")');
    const rec = recognizeBuilderShapes(rule);
    expect(rec).toMatchObject({ operator: "matches_regex", value: "a\\.b" });
  });

  it("recognizes the converted shapes byte for byte (two live rules)", () => {
    expect(
      recognizeBuilderShapes({
        context: "span",
        condition: 'attributes["demo.source"] != nil',
        quantifier: "all",
      }),
    ).toMatchObject({ mode: "record_attribute", key: "demo.source", operator: "exists" });
    expect(
      recognizeBuilderShapes({
        context: "log",
        condition: 'attributes["http.request.header.authorization"] == "REDACTED"',
        quantifier: "all",
      }),
    ).toMatchObject({ operator: "equals", value: "REDACTED" });
  });
});

describe("count and distinct recognition", () => {
  it("recognizes the canonical count control", () => {
    expect(
      recognizeBuilderShapes({
        context: "datapoint",
        condition: "true",
        quantifier: "count",
        count: { operator: "gt", value: 0 },
      }),
    ).toEqual({ mode: "record_count", count: { operator: "gt", value: 0 } });
  });

  it("recognizes a bare-attribute distinct rule", () => {
    expect(
      recognizeBuilderShapes({
        context: "datapoint",
        quantifier: "distinct",
        expression: 'attributes["http.route"]',
        count: { operator: "lte", value: 50 },
      }),
    ).toMatchObject({ mode: "record_attribute", quantifier: "distinct", key: "http.route" });
  });

  it("leaves non-canonical rules to OTTL mode", () => {
    // Composed condition.
    expect(
      recognizeBuilderShapes({
        context: "log",
        condition: 'attributes["a"] != nil and attributes["b"] != nil',
        quantifier: "all",
      }),
    ).toBeNull();
    // Row-filtered distinct.
    expect(
      recognizeBuilderShapes({
        context: "datapoint",
        condition: 'metric.name == "x"',
        quantifier: "distinct",
        expression: 'attributes["route"]',
        count: { operator: "lte", value: 5 },
      }),
    ).toBeNull();
    // Concat expression distinct.
    expect(
      recognizeBuilderShapes({
        context: "datapoint",
        quantifier: "distinct",
        expression: 'Concat([attributes["a"], attributes["b"]], "|")',
        count: { operator: "lte", value: 5 },
      }),
    ).toBeNull();
    // ne-operator count total (the count builder has no "ne").
    expect(
      recognizeBuilderShapes({
        context: "log",
        condition: "true",
        quantifier: "count",
        count: { operator: "ne", value: 0 },
      }),
    ).toBeNull();
  });
});

describe("recognizeBuilderRule: a builder only on the context it saves", () => {
  it.each([
    [
      "a traces spanevent none-rule (the builder would save span)",
      "traces",
      { context: "spanevent", condition: 'attributes["zq"] != nil', quantifier: "none" },
    ],
    [
      "a metrics metric-context rule (the builder would save datapoint)",
      "metrics",
      { context: "metric", condition: 'attributes["zq"] == "x"', quantifier: "all" },
    ],
    [
      "a logs resource count rule (Record count would save log)",
      "logs",
      { context: "resource", condition: "true", quantifier: "count", count: { operator: "gte", value: 1 } },
    ],
    [
      "a distinct rule on another signal's record context",
      "logs",
      { context: "span", quantifier: "distinct", expression: 'attributes["zq"]', count: { operator: "lte", value: 5 } },
    ],
  ] as const)("leaves %s to OTTL mode, though its shape is a builder's", (_what, signal, ottl) => {
    expect(recognizeBuilderShapes(ottl)).not.toBeNull();
    expect(recognizeBuilderRule(ottl, signal)).toBeNull();
  });

  it.each([
    ["traces", "span"],
    ["logs", "log"],
    ["metrics", "datapoint"],
  ] as const)("recognizes Record count on the %s record context (%s)", (signal, context) => {
    const ottl: ValidationRuleOttl = { context, condition: "true", quantifier: "count", count: { operator: "gt", value: 0 } };
    expect(recognizeBuilderRule(ottl, signal)).toEqual({ mode: "record_count", count: { operator: "gt", value: 0 } });
  });

  it.each([
    ["traces", "span", "record"],
    ["traces", "resource", "resource"],
    ["metrics", "scope", "scope"],
    ["metrics", "datapoint", "record"],
  ] as const)("recognizes Record attribute on a %s pipeline's %s context (scope %s)", (signal, context, scope) => {
    const ottl: ValidationRuleOttl = { context, condition: buildAttributeCondition("zq", "exists", ""), quantifier: "all" };
    expect(recognizeBuilderRule(ottl, signal)).toMatchObject({ mode: "record_attribute", scope, key: "zq" });
  });
});

describe("helpers", () => {
  it("escape/unescape round-trips awkward strings", () => {
    for (const s of ["plain", 'with "quotes"', "back\\slash", '\\" mixed \\\\"']) {
      expect(unescapeOttlString(escapeOttlString(s))).toBe(s);
    }
  });

  it("maps signals to record contexts", () => {
    expect(recordContextForSignal("traces")).toBe("span");
    expect(recordContextForSignal("logs")).toBe("log");
    expect(recordContextForSignal("metrics")).toBe("datapoint");
    expect(recordContextForSignal(undefined)).toBe("datapoint");
  });
});

describe("ottlStringLiteral", () => {
  it.each([
    ["a plain string", "env", '"env"'],
    ["a backslash and a quote", 'say "hi" \\ done', '"say \\"hi\\" \\\\ done"'],
    ["a newline, a carriage return and a tab", "a\nb\rc\td", '"a\\nb\\rc\\td"'],
    ["backspace as \\u0008, never \\b", "\b", '"\\u0008"'],
    ["the other C0 controls", "\u0000\u0001\u001b\u001f", '"\\u0000\\u0001\\u001b\\u001f"'],
    ["DEL", "\u007f", '"\\u007f"'],
    ["the C1 controls", "\u0080\u0085\u009f", '"\\u0080\\u0085\\u009f"'],
    ["U+2028 and U+2029", "\u2028\u2029", '"\\u2028\\u2029"'],
    ["other Unicode as it is, a pair included", "ключ \u00a0✓ 🚀", '"ключ \u00a0✓ 🚀"'],
    ["the crafted key", 'x"] != nil or attributes["y', '"x\\"] != nil or attributes[\\"y"'],
  ])("writes %s", (_what, value, literal) => {
    expect(ottlStringLiteral(value)).toBe(literal);
  });

  it("writes hex in lowercase", () => {
    expect(ottlStringLiteral("\u001a\u009e")).toBe('"\\u001a\\u009e"');
  });

  it.each([
    ["a lone high surrogate", "a\ud800b"],
    ["a lone low surrogate", "\udc00"],
    ["a high surrogate at the end", "x\ud83d"],
    ["two high surrogates", "\ud83d\ud83d\ude80"],
  ])("writes nothing for %s (not well-formed UTF-16)", (_what, value) => {
    expect(ottlStringLiteral(value)).toBeNull();
  });

  it("is what the builders write", () => {
    expect(buildAttributeCondition("a\nb", "equals", "\u0001")).toBe('attributes["a\\nb"] == "\\u0001"');
    expect(escapeOttlString("\t\u2028")).toBe("\\t\\u2028");
  });
});

describe("the number writers", () => {
  it.each([
    [0n, "0"],
    [-1n, "-1"],
    [9007199254740993n, "9007199254740993"],
    [9223372036854775807n, "9223372036854775807"],
    [-9223372036854775807n, "-9223372036854775807"],
  ])("writes the integer %s exactly", (value, literal) => {
    expect(ottlIntegerLiteral(value)).toBe(literal);
  });

  it.each([-9223372036854775808n, 9223372036854775808n, -9223372036854775809n])("writes nothing for the integer %s", (value) => {
    expect(ottlIntegerLiteral(value)).toBeNull();
  });

  it.each([
    [5, "5.0"],
    [-0, "0.0"],
    [0, "0.0"],
    [-5, "-5.0"],
    [0.1, "0.1"],
    [-2.5, "-2.5"],
    [123456789.125, "123456789.125"],
    [999999999999999900000, "999999999999999900000.0"],
    [1e21, "1000000000000000000000.0"],
    [1.5e300, `15${"0".repeat(299)}.0`],
    [1e-7, "0.0000001"],
    [-1.25e-7, "-0.000000125"],
    [5e-324, `0.${"0".repeat(323)}5`],
  ])("writes the double %s with its decimal point", (value, literal) => {
    expect(ottlDoubleLiteral(value)).toBe(literal);
    expect(Number(literal)).toBe(value === 0 ? 0 : value);
  });

  it("writes the largest double in 311 characters, reading back as itself", () => {
    const literal = ottlDoubleLiteral(Number.MAX_VALUE);
    expect(literal).toHaveLength(311);
    expect(literal).toMatch(/^\d+\.0$/);
    expect(Number(literal)).toBe(Number.MAX_VALUE);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("writes nothing for %s", (value) => {
    expect(ottlDoubleLiteral(value)).toBeNull();
  });
});

describe("unescapeOttlString: exactly the writer's escapes", () => {
  it.each([
    ["\\\\", "a backslash"],
    ['\\"', "a quote"],
    ["\\n", "a newline"],
    ["\\r", "a carriage return"],
    ["\\t", "a tab"],
    ["\\u0001", "a \\uXXXX control"],
  ])("decodes %s (%s)", (escape, _what) => {
    const decoded = unescapeOttlString(`a${escape}b`);
    expect(decoded).not.toBeNull();
    expect(escapeOttlString(decoded ?? "")).toBe(`a${escape}b`);
  });

  it("decodes \\uXXXX in either case", () => {
    expect(unescapeOttlString("\\u00e9\\u00E9\\u2028")).toBe("éé\u2028");
  });

  it.each([
    ["each of the writer's escapes, as a key and a value", "a\\b\"c\nd\re\tf\u0001g\u0085h\u2029", "v\n\\\t\""],
    ["backspace and DEL", "\b\u0001\u007f", "\u0000"],
    ["Unicode", "ключ ✓ 🚀", "🚀"],
  ])("round-trips %s through the builder", (_what, key, value) => {
    for (const operator of ["exists", "equals", "matches_regex"] as const) {
      const condition = buildAttributeCondition(key, operator, value);
      const recognized = recognizeBuilderShapes({ context: "log", condition, quantifier: "all" });
      expect(recognized).toMatchObject({ mode: "record_attribute", key, operator });
      if (operator !== "exists") expect(recognized).toMatchObject({ value });
      if (recognized?.mode === "record_attribute") {
        expect(buildAttributeCondition(recognized.key, recognized.operator, recognized.value)).toBe(condition);
      }
    }
    const distinct = recognizeBuilderShapes({
      context: "log",
      quantifier: "distinct",
      expression: `attributes["${escapeOttlString(key)}"]`,
      count: { operator: "lte", value: 5 },
    });
    expect(distinct).toMatchObject({ key });
  });

  it.each([
    ["\\b"],
    ["\\f"],
    ["\\a"],
    ["\\v"],
    ["\\x41"],
    ["\\101"],
    ["\\U0001F600"],
    ["\\/"],
    ["\\'"],
    ["\\u12"],
    ["\\ud800"],
  ])("answers null for %s, so the rule opens in OTTL mode as written", (escape) => {
    expect(unescapeOttlString(`a${escape}b`)).toBeNull();
    for (const condition of [
      `attributes["a${escape}b"] != nil`,
      `attributes["k"] == "a${escape}b"`,
      `attributes["k"] != nil and IsMatch(attributes["k"], "a${escape}b")`,
      `attributes["a${escape}b"] != nil and attributes["a${escape}b"] > 5`,
    ]) {
      expect(recognizeBuilderShapes({ context: "log", condition, quantifier: "all" })).toBeNull();
    }
    expect(
      recognizeBuilderShapes({ context: "log", quantifier: "distinct", expression: `attributes["a${escape}b"]`, count: { operator: "lte", value: 5 } }),
    ).toBeNull();
  });

  it("reopens a saved attributes[\"a\\nb\"] != nil with the key it saved (not anb)", () => {
    expect(recognizeBuilderRule({ context: "log", condition: 'attributes["a\\nb"] != nil', quantifier: "all" }, "logs")).toMatchObject({
      key: "a\nb",
    });
  });
});
