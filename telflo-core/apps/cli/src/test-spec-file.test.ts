import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  CreateValidationRuleRequestSchema,
  isOttlContextOfSignal,
  OTTL_CONTEXTS,
  OTTL_CONTEXTS_BY_SIGNAL,
  OTTL_COUNT_OPERATORS,
  OTTL_QUANTIFIERS,
  PUBLIC_TEST_RUN_DEFAULT_DURATION_SECONDS,
  PUBLIC_TEST_RUN_RULES_MAXIMUM,
  PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES,
  PUBLIC_VALIDATION_PIPELINE_RULES_MAXIMUM,
  TEST_RUN_DURATION_MAXIMUM_SECONDS,
  TEST_RUN_DURATION_MINIMUM_SECONDS,
  TEST_RUN_PIPELINE_MAXIMUM_LENGTH,
  TEST_RUN_SIGNALS,
  VALIDATION_RULE_COUNT_MAXIMUM,
  VALIDATION_RULE_NAME_MAXIMUM_LENGTH,
  VALIDATION_RULE_TEXT_MAXIMUM_BYTES,
  type TestRunSignal,
} from "@telflo/contracts";
import { EXIT, ExitError } from "./output.js";
import {
  convertRule,
  normalizeTestSpec,
  parseTestSpec,
  RULE_CONTEXTS,
  RULE_CONTEXTS_BY_SIGNAL,
  RULE_COUNT_MAXIMUM,
  RULE_COUNT_OPERATORS,
  RULE_NAME_MAXIMUM_LENGTH,
  RULE_QUANTIFIERS,
  RULE_TEXT_MAXIMUM_BYTES,
  TEST_DEFAULT_DURATION_SECONDS,
  TEST_DURATION_MAXIMUM_SECONDS,
  TEST_DURATION_MINIMUM_SECONDS,
  TEST_PIPELINE_MAXIMUM_LENGTH,
  TEST_RULES_MAXIMUM,
  TEST_SAMPLE_MAXIMUM_BYTES,
  TEST_SIGNALS,
  type TestSignal,
} from "./test-spec-file.js";

/*
 * A test spec (the older Telflo CLI's YAML) and its rules converted to the
 * platform's OTTL rule and checked as the API would: the older CLI's spec
 * tests where they still hold, and drift tests against @telflo/contracts.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "telflo-cli-spec-"));
  writeFileSync(join(dir, "sample.json"), '{"resourceLogs":[]}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BASE = `
signal: logs
pipeline: logs/in
sample: ./sample.json
rules:
  - name: total
    context: log
    quantifier: count
    condition: "true"
    count: { operator: eq, value: 10 }
`;

/** The ExitError a call throws: it must be a usage error. */
function usageError(call: () => unknown): ExitError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).exitCode).toBe(EXIT.USAGE);
    return error as ExitError;
  }
  throw new Error("expected a usage error");
}

describe("parseTestSpec (the older CLI's YAML)", () => {
  it("parses, inlines the sample and converts the rules to the platform's shape", () => {
    const spec = parseTestSpec(BASE, dir);
    expect(spec).toEqual({
      signal: "logs",
      pipeline: "logs/in",
      duration: 5,
      sample: '{"resourceLogs":[]}',
      rules: [{ kind: "ottl", target: "output", name: "total", ottl: { context: "log", quantifier: "count", condition: "true", count: { operator: "eq", value: 10 } } }],
    });
  });

  it("takes sample_text, the collector fields, a duration and the older CLI's pipeline name (read, never sent)", () => {
    const spec = parseTestSpec(
      `name: redaction checks\nduration: 9\ncollector_version: 0.147.0\ndistribution: otelcol-contrib\n${BASE.replace("sample: ./sample.json", 'sample_text: "{}"')}`,
      dir,
    );
    expect(spec).toMatchObject({ name: "redaction checks", duration: 9, collectorVersion: "0.147.0", distribution: "otelcol-contrib", sample: "{}" });
  });

  it("reads an absolute sample path", () => {
    expect(parseTestSpec(BASE.replace("./sample.json", join(dir, "sample.json")), "/").sample).toBe('{"resourceLogs":[]}');
  });

  it("refuses a bad signal, a pipeline of another signal, and a missing or overlong pipeline", () => {
    expect(usageError(() => parseTestSpec(BASE.replace("signal: logs", "signal: events"), dir)).message).toContain("signal");
    expect(usageError(() => parseTestSpec(BASE.replace("pipeline: logs/in", "pipeline: traces/in"), dir)).message).toContain(
      "a logs pipeline",
    );
    expect(usageError(() => parseTestSpec(BASE.replace("pipeline: logs/in", 'pipeline: "  "'), dir)).message).toContain("pipeline is needed");
    expect(usageError(() => parseTestSpec(BASE.replace("pipeline: logs/in", `pipeline: logs/${"p".repeat(200)}`), dir)).message).toContain(
      "longer than 200",
    );
    expect(usageError(() => parseTestSpec(BASE.replace("pipeline: logs/in", 'pipeline: "logs/a\\x01"'), dir)).message).toContain(
      "a pipeline's name",
    );
    // Its length in UTF-16 units, as the API's zod `.max(200)` counts: 5 + 98 astral characters is 201 units (103 code points).
    expect(usageError(() => parseTestSpec(BASE.replace("pipeline: logs/in", `pipeline: logs/${"😀".repeat(98)}`), dir)).message).toContain(
      "longer than 200",
    );
    expect(parseTestSpec(BASE.replace("pipeline: logs/in", `pipeline: logs/${"p".repeat(195)}`), dir).pipeline).toHaveLength(200);
    // `logs` alone is a logs pipeline.
    expect(parseTestSpec(BASE.replace("pipeline: logs/in", "pipeline: logs"), dir).pipeline).toBe("logs");
  });

  it("refuses an out-of-range or fractional duration", () => {
    for (const duration of ["90", "0", "1.5", '"5"']) {
      expect(usageError(() => parseTestSpec(`duration: ${duration}\n${BASE}`, dir)).message).toContain("duration");
    }
  });

  it("refuses an empty name", () => {
    expect(usageError(() => parseTestSpec(`name: ""\n${BASE}`, dir)).message).toContain("name");
  });

  it("refuses both or neither of sample and sample_text", () => {
    expect(usageError(() => parseTestSpec(`sample_text: "{}"\n${BASE}`, dir)).message).toContain("exactly one");
    expect(usageError(() => parseTestSpec(BASE.replace("sample: ./sample.json\n", ""), dir)).message).toContain("exactly one");
  });

  it("refuses a sample over 1 MiB (text or file) and a missing sample file, never naming the file", () => {
    const huge = "x".repeat(TEST_SAMPLE_MAXIMUM_BYTES + 1);
    expect(usageError(() => parseTestSpec(BASE.replace("sample: ./sample.json", `sample_text: "${huge}"`), dir)).message).toContain(
      "over 1 MiB",
    );
    writeFileSync(join(dir, "big.json"), huge);
    expect(usageError(() => parseTestSpec(BASE.replace("sample.json", "big.json"), dir)).message).toContain("over 1 MiB");
    const missing = usageError(() => parseTestSpec(BASE.replace("sample.json", "missing-marker.json"), dir));
    expect(missing.message).toBe("test spec: can't read the sample file.");
    // A folder can be stat-ed but not read.
    expect(usageError(() => parseTestSpec(BASE.replace("./sample.json", "."), dir)).message).toBe("test spec: can't read the sample file.");
  });

  it("a sample of exactly 1 MiB passes", () => {
    const exact = "x".repeat(TEST_SAMPLE_MAXIMUM_BYTES);
    expect(parseTestSpec(BASE.replace("sample: ./sample.json", `sample_text: "${exact}"`), dir).sample).toHaveLength(TEST_SAMPLE_MAXIMUM_BYTES);
  });

  it("requires 1 to 20 rules by default; --saved allows none, and still checks any given", () => {
    const noRules = BASE.split("rules:")[0]!;
    expect(usageError(() => parseTestSpec(noRules, dir)).message).toContain("rules must be a list");
    expect(parseTestSpec(noRules, dir, { allowMissingRules: true }).rules).toEqual([]);
    expect(usageError(() => parseTestSpec(BASE.replace("quantifier: count", "quantifier: some"), dir, { allowMissingRules: true })).message).toContain(
      "rules[0].quantifier",
    );
    expect(usageError(() => parseTestSpec(`${noRules}rules: []\n`, dir)).message).toContain("rules must be a list");
    expect(usageError(() => parseTestSpec(`${noRules}rules: {}\n`, dir)).message).toContain("rules must be a list");
    const rule = "  - { context: log, quantifier: any, condition: 'body != nil' }\n";
    expect(parseTestSpec(`${noRules}rules:\n${rule.repeat(20)}`, dir).rules).toHaveLength(20);
    expect(usageError(() => parseTestSpec(`${noRules}rules:\n${rule.repeat(21)}`, dir)).message).toContain("1 to 20");
  });

  it("reports invalid YAML by its line and column only, and a non-mapping", () => {
    const bad = usageError(() => parseTestSpec("a: [unclosed-marker", "."));
    expect(bad.message.startsWith("test spec: invalid YAML at line 1, column")).toBe(true);
    expect(bad.message.includes("unclosed-marker")).toBe(false);
    for (const text of ["just a string", "- a\n- b", "", "42"]) {
      expect(usageError(() => parseTestSpec(text, ".")).message).toBe("test spec: must be a YAML mapping.");
    }
  });

  it("the YAML library's warnings (an unknown tag) are never raised: nothing reaches stderr or process warnings", () => {
    const tagged = BASE.replace("pipeline: logs/in", "pipeline: !marker-tag logs/in");
    const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // The library does warn on it by default: the test would see a regression.
      parse(tagged);
      expect(warnings.mock.calls.length > 0).toBe(true);
      warnings.mockClear();
      expect(parseTestSpec(tagged, dir).pipeline).toBe("logs/in");
      expect(warnings.mock.calls.length).toBe(0);
      expect(stderr.mock.calls.length).toBe(0);
    } finally {
      warnings.mockRestore();
      stderr.mockRestore();
    }
  });

  it("normalizeTestSpec refuses a non-object", () => {
    for (const raw of [null, undefined, "text", 42, []]) {
      expect(usageError(() => normalizeTestSpec(raw, ".")).message).toBe("test spec: must be a YAML mapping.");
    }
  });
});

const COUNT = { operator: "gte", value: 1 };

describe("convertRule", () => {
  it("converts each quantifier's rule, a name trimmed, an empty name left out", () => {
    expect(convertRule({ name: "  each  ", context: "log", quantifier: "all", condition: "body != nil" }, 0, "logs")).toEqual({
      kind: "ottl",
      target: "output",
      name: "each",
      ottl: { context: "log", quantifier: "all", condition: "body != nil" },
    });
    expect(convertRule({ name: "  ", context: "span", quantifier: "count", condition: "true", count: COUNT }, 0, "traces")).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "span", quantifier: "count", condition: "true", count: COUNT },
    });
    expect(convertRule({ context: "datapoint", quantifier: "distinct", expression: "attributes[\"k\"]", count: { operator: "between", value: 1, value2: 3 } }, 0, "metrics")).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "datapoint", quantifier: "distinct", expression: "attributes[\"k\"]", count: { operator: "between", value: 1, value2: 3 } },
    });
    // distinct's condition is an optional filter.
    expect(convertRule({ context: "log", quantifier: "distinct", expression: "body", condition: "x != nil", count: COUNT }, 0, "logs").ottl.condition).toBe("x != nil");
  });

  /** Each case the older CLI's spec let through and the API refuses, with the place the message must name. */
  const REFUSED: Array<[string, Record<string, unknown>, string]> = [
    ["an unknown context", { context: "logs", quantifier: "all", condition: "c" }, "rules[3].context"],
    ["a context its signal lacks", { context: "span", quantifier: "all", condition: "c" }, "rules[3].context"],
    ["a missing context", { quantifier: "all", condition: "c" }, "rules[3].context"],
    ["an unknown quantifier", { context: "log", quantifier: "some", condition: "c" }, "rules[3].quantifier"],
    ["no condition (not distinct)", { context: "log", quantifier: "any" }, "rules[3].condition"],
    ["a blank condition", { context: "log", quantifier: "any", condition: "  \t" }, "rules[3].condition"],
    ["a condition that isn't text", { context: "log", quantifier: "any", condition: 5 }, "rules[3].condition"],
    ["a condition over 8,192 bytes", { context: "log", quantifier: "any", condition: "é".repeat(4097) }, "rules[3].condition"],
    ["a condition holding U+0000", { context: "log", quantifier: "any", condition: "a\u0000b" }, "rules[3].condition"],
    ["a condition holding a lone surrogate", { context: "log", quantifier: "any", condition: "a\ud800b" }, "rules[3].condition"],
    ["an expression on all", { context: "log", quantifier: "all", condition: "c", expression: "e" }, "rules[3].expression"],
    ["distinct without an expression", { context: "log", quantifier: "distinct", count: COUNT }, "rules[3].expression"],
    ["distinct without a count", { context: "log", quantifier: "distinct", expression: "e" }, "rules[3].count"],
    ["count without a count", { context: "log", quantifier: "count", condition: "c" }, "rules[3].count"],
    ["a count on any", { context: "log", quantifier: "any", condition: "c", count: COUNT }, "rules[3].count"],
    ["a count that isn't a mapping", { context: "log", quantifier: "count", condition: "c", count: 3 }, "rules[3].count"],
    ["an extra count key", { context: "log", quantifier: "count", condition: "c", count: { ...COUNT, extra: 1 } }, "rules[3].count"],
    ["operator ge", { context: "log", quantifier: "count", condition: "c", count: { operator: "ge", value: 1 } }, "rules[3].count.operator"],
    ["value -1", { context: "log", quantifier: "count", condition: "c", count: { operator: "eq", value: -1 } }, "rules[3].count.value"],
    ["value 1.5", { context: "log", quantifier: "count", condition: "c", count: { operator: "eq", value: 1.5 } }, "rules[3].count.value"],
    ["value past an integer", { context: "log", quantifier: "count", condition: "c", count: { operator: "eq", value: 2_147_483_648 } }, "rules[3].count.value"],
    ["value as text", { context: "log", quantifier: "count", condition: "c", count: { operator: "eq", value: "1" } }, "rules[3].count.value"],
    ["between without value2", { context: "log", quantifier: "count", condition: "c", count: { operator: "between", value: 1 } }, "rules[3].count.value2"],
    ["between with value2 below value", { context: "log", quantifier: "count", condition: "c", count: { operator: "between", value: 3, value2: 2 } }, "rules[3].count.value2"],
    ["value2 without between", { context: "log", quantifier: "count", condition: "c", count: { operator: "eq", value: 1, value2: 2 } }, "rules[3].count.value2"],
    ["a 201-character name", { name: "n".repeat(201), context: "log", quantifier: "any", condition: "c" }, "rules[3].name"],
    ["a name that isn't text", { name: 7, context: "log", quantifier: "any", condition: "c" }, "rules[3].name"],
    ["a name holding U+0000", { name: "a\u0000", context: "log", quantifier: "any", condition: "c" }, "rules[3].name"],
    ["another key", { context: "log", quantifier: "any", condition: "c", description: "d" }, "rules[3] has a field"],
  ];

  it.each(REFUSED)("refuses %s, naming the rule's index and field (exit 2)", (_case, raw, place) => {
    const error = usageError(() => convertRule(raw, 3, "logs"));
    expect(error.message.startsWith(`test spec: ${place}`)).toBe(true);
  });

  it("never quotes the rule's text or a key it doesn't know", () => {
    const marker = "quoted-marker-31ab";
    for (const raw of [
      { [marker]: 1, context: "log", quantifier: "any", condition: "c" },
      { context: marker, quantifier: "any", condition: "c" },
      { context: "log", quantifier: marker, condition: "c" },
      { context: "log", quantifier: "count", condition: marker, count: { operator: marker, value: 1 } },
      { name: marker.repeat(20), context: "log", quantifier: "any", condition: "c" },
    ]) {
      expect(usageError(() => convertRule(raw, 0, "logs")).message.includes(marker)).toBe(false);
    }
    expect(usageError(() => convertRule("not a mapping", 0, "logs")).message).toBe("test spec: rules[0] must be a mapping.");
  });

  it("a 200-code-point name of astral characters passes (code points, not UTF-16 units)", () => {
    expect(convertRule({ name: "😀".repeat(200), context: "log", quantifier: "any", condition: "c" }, 0, "logs").name).toHaveLength(400);
  });

  it("drift: every rule it converts the API's schema takes, and every case it refuses the API's schema or context check refuses", () => {
    const accepted: Array<[Record<string, unknown>, TestSignal]> = [
      [{ name: " each ", context: "log", quantifier: "all", condition: "body != nil" }, "logs"],
      [{ context: "resource", quantifier: "none", condition: "c" }, "logs"],
      [{ context: "spanevent", quantifier: "count", condition: "true", count: { operator: "lte", value: 2_147_483_647 } }, "traces"],
      [{ context: "metric", quantifier: "distinct", expression: "e", count: { operator: "between", value: 0, value2: 0 } }, "metrics"],
      [{ context: "scope", quantifier: "distinct", expression: "e", condition: "f", count: { operator: "ne", value: 0 } }, "metrics"],
      [{ name: "😀".repeat(200), context: "log", quantifier: "any", condition: "é".repeat(4096) }, "logs"],
    ];
    for (const [raw, signal] of accepted) {
      const rule = convertRule(raw, 0, signal);
      expect(CreateValidationRuleRequestSchema.safeParse(rule).success).toBe(true);
      expect(isOttlContextOfSignal(rule.ottl.context, signal)).toBe(true);
    }
    for (const [, raw] of REFUSED) {
      // The API's form of the case: the spec's fields under `ottl`, the name beside it.
      const { name, description, ...ottl } = raw;
      const request = {
        kind: "ottl",
        target: "output",
        ottl,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
      };
      const schemaRefuses = !CreateValidationRuleRequestSchema.safeParse(request).success;
      const contextRefuses = typeof ottl.context === "string" && !isOttlContextOfSignal(ottl.context, "logs");
      // The older CLI's `description` is the one key the platform's rule has but the spec's doesn't: refused by the CLI alone.
      expect(schemaRefuses || contextRefuses || description !== undefined).toBe(true);
    }
  });
});

describe("drift: the CLI's copies of the contracts' constants", () => {
  it("signals, contexts by signal, quantifiers and count operators", () => {
    expect([...TEST_SIGNALS]).toEqual([...TEST_RUN_SIGNALS]);
    expect([...RULE_CONTEXTS]).toEqual([...OTTL_CONTEXTS]);
    expect(RULE_CONTEXTS_BY_SIGNAL).toEqual(OTTL_CONTEXTS_BY_SIGNAL);
    expect([...RULE_QUANTIFIERS]).toEqual([...OTTL_QUANTIFIERS]);
    expect([...RULE_COUNT_OPERATORS]).toEqual([...OTTL_COUNT_OPERATORS]);
    for (const signal of TEST_RUN_SIGNALS as readonly TestRunSignal[]) {
      for (const context of OTTL_CONTEXTS) {
        expect(RULE_CONTEXTS_BY_SIGNAL[signal as TestSignal].includes(context)).toBe(isOttlContextOfSignal(context, signal));
      }
    }
  });

  it("the limits: count, name, text, rules, sample, pipeline, duration", () => {
    expect(RULE_COUNT_MAXIMUM).toBe(VALIDATION_RULE_COUNT_MAXIMUM);
    expect(RULE_NAME_MAXIMUM_LENGTH).toBe(VALIDATION_RULE_NAME_MAXIMUM_LENGTH);
    expect(RULE_TEXT_MAXIMUM_BYTES).toBe(VALIDATION_RULE_TEXT_MAXIMUM_BYTES);
    expect(TEST_RULES_MAXIMUM).toBe(PUBLIC_TEST_RUN_RULES_MAXIMUM);
    expect(TEST_RULES_MAXIMUM).toBe(PUBLIC_VALIDATION_PIPELINE_RULES_MAXIMUM);
    expect(TEST_SAMPLE_MAXIMUM_BYTES).toBe(PUBLIC_TEST_RUN_SAMPLE_MAXIMUM_BYTES);
    expect(TEST_PIPELINE_MAXIMUM_LENGTH).toBe(TEST_RUN_PIPELINE_MAXIMUM_LENGTH);
    expect(TEST_DURATION_MINIMUM_SECONDS).toBe(TEST_RUN_DURATION_MINIMUM_SECONDS);
    expect(TEST_DURATION_MAXIMUM_SECONDS).toBe(TEST_RUN_DURATION_MAXIMUM_SECONDS);
    expect(TEST_DEFAULT_DURATION_SECONDS).toBe(PUBLIC_TEST_RUN_DEFAULT_DURATION_SECONDS);
  });
});
