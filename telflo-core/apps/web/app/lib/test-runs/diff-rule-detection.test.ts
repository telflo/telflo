// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestRunSignal } from "@telflo/contracts";
import { describe, expect, it } from "vitest";

import { recognizeBuilderRule, recordContextForSignal } from "~/components/editor/validation-pipelines/rule-builder-shapes.js";

import {
  candidatePrefill,
  detectRuleCandidates,
  detectRuleCandidatesInText,
  readInputDocuments,
  readOutputDocuments,
  type RuleCandidate,
} from "./diff-rule-detection.js";
import {
  COMPARE_PREFILLS_FIXTURE,
  COMPARE_PREFILLS_FIXTURE_PATH,
  COMPARE_PREFILLS_SCRIPT,
  comparePrefillRecords,
  serializedComparePrefillsFixture,
  type ComparePrefillsFixture,
} from "./compare-prefills-fixture.js";

/*
 * The first describe holds the 5 basic cases: the candidates are this
 * file's shape, kind, key and the rule's Require and Condition, as the rule
 * editor's prefill writes them. The rest are D15b's (Task 5; Preflight
 * rulings 8-10): the walks, the values, the files' forms, the order, the
 * load, the OTTL written, and the fixture the evaluator's Go suite checks.
 */

type Attributes = Record<string, unknown>;

/** An OTLP attribute list: a plain value is a stringValue, an object is the AnyValue itself. */
function attributeList(attributes: Attributes): Array<{ key: string; value: unknown }> {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: typeof value === "string" ? { stringValue: value } : value }));
}

/** One sum metric, a data point per record. */
const otlpWith = (perRecordAttrs: Attributes[]) => ({
  resourceMetrics: [
    {
      resource: { attributes: [] },
      scopeMetrics: [
        {
          scope: {},
          metrics: [{ name: "m", sum: { dataPoints: perRecordAttrs.map((attrs) => ({ attributes: attributeList(attrs) })) } }],
        },
      ],
    },
  ],
});

const logsWith = (perRecordAttrs: Attributes[]) => ({
  resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: {}, logRecords: perRecordAttrs.map((attrs) => ({ attributes: attributeList(attrs) })) }] }],
});

const spansWith = (perRecordAttrs: Attributes[]) => ({
  resourceSpans: [{ scopeSpans: [{ spans: perRecordAttrs.map((attrs) => ({ name: "s", attributes: attributeList(attrs) })) }] }],
});

/** The candidates over one input and one output document of logs. */
function logCandidates(input: Attributes[], output: Attributes[]): RuleCandidate[] {
  return detectRuleCandidates([logsWith(input)], [logsWith(output)], "logs");
}

const added = (key: string, condition: string): RuleCandidate => ({ kind: "added", key, quantifier: "all", condition });
const removed = (key: string, condition: string): RuleCandidate => ({ kind: "removed", key, quantifier: "none", condition });
const changed = (key: string, condition: string): RuleCandidate => ({ kind: "changed", key, quantifier: "all", condition });

describe("detectRuleCandidates: the 5 basic cases", () => {
  it("detects attribute_added_on_all when a key appears on every output and zero inputs", () => {
    const inp = JSON.stringify(otlpWith([{ "service.name": "x" }, { "service.name": "y" }]));
    const outp = JSON.stringify(
      otlpWith([
        { "service.name": "x", env: "prod" },
        { "service.name": "y", env: "prod" },
      ]),
    );
    expect(detectRuleCandidatesInText(inp, outp, "metrics")).toContainEqual(added("env", 'attributes["env"] != nil'));
  });

  it("detects attribute_removed_on_all", () => {
    const inp = JSON.stringify(otlpWith([{ password: "p1" }, { password: "p2" }]));
    const outp = JSON.stringify(otlpWith([{}, {}]));
    expect(detectRuleCandidatesInText(inp, outp, "metrics")).toContainEqual(removed("password", 'attributes["password"] != nil'));
  });

  it("detects attribute_modified with from/to when value changes uniformly", () => {
    const inp = JSON.stringify(otlpWith([{ tier: "free" }, { tier: "free" }]));
    const outp = JSON.stringify(otlpWith([{ tier: "paid" }, { tier: "paid" }]));
    expect(detectRuleCandidatesInText(inp, outp, "metrics")).toContainEqual(changed("tier", 'attributes["tier"] == "paid"'));
  });

  it("returns empty array when no diff-worthy attribute changes exist", () => {
    const inp = JSON.stringify(otlpWith([{ env: "prod" }]));
    const outp = JSON.stringify(otlpWith([{ env: "prod" }]));
    expect(detectRuleCandidatesInText(inp, outp, "metrics")).toEqual([]);
  });

  it("preserves numeric value types for attribute_modified", () => {
    // A regression guard: an intValue 5 is asserted as the
    // integer 5, never the string "5" (which the evaluator's int would
    // never equal).
    const otlpWithInt = (perRecord: Array<Record<string, number>>) =>
      otlpWith(perRecord.map((attrs) => Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, { intValue: String(value) }]))));
    const inp = JSON.stringify(otlpWithInt([{ retries: 3 }, { retries: 3 }]));
    const outp = JSON.stringify(otlpWithInt([{ retries: 5 }, { retries: 5 }]));
    expect(detectRuleCandidatesInText(inp, outp, "metrics")).toEqual([changed("retries", 'attributes["retries"] == 5')]);
  });
});

describe("Ana's run: env added, level changed (the deliverable's example)", () => {
  it("offers the changed level first (the input's keys first), then the added env, each with its condition", () => {
    const input = [{ level: "debug", msg: "a" }, { level: "debug", msg: "b" }];
    const output = [
      { level: "info", msg: "a", env: "prod" },
      { level: "info", msg: "b", env: "prod" },
    ];
    expect(logCandidates(input, output)).toEqual([changed("level", 'attributes["level"] == "info"'), added("env", 'attributes["env"] != nil')]);
  });
});

describe("the records walked: record attributes only", () => {
  it("walks log records across resources, scopes and documents", () => {
    const input = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [] }] }, { logRecords: [{ attributes: [] }] }] }, { scopeLogs: [{ logRecords: [{}] }] }] };
    const output = logsWith([{ k: "v" }, { k: "v" }, { k: "v" }]);
    expect(detectRuleCandidates([input], [output], "logs")).toEqual([added("k", 'attributes["k"] != nil')]);
  });

  it("walks spans", () => {
    expect(detectRuleCandidates([spansWith([{}, {}])], [spansWith([{ team: "core" }, { team: "core" }])], "traces")).toEqual([
      added("team", 'attributes["team"] != nil'),
    ]);
  });

  it("reads only the signal's own records", () => {
    // A logs document read as traces has no records: nothing is offered.
    expect(detectRuleCandidates([logsWith([{}])], [logsWith([{ k: "v" }])], "traces")).toEqual([]);
  });

  it.each(["sum", "gauge", "histogram", "exponentialHistogram", "summary"])("walks a %s metric's data points", (type) => {
    const metrics = (attrs: Attributes) => ({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "m", [type]: { dataPoints: [{ attributes: attributeList(attrs) }, { attributes: attributeList(attrs) }] } }] }] }],
    });
    expect(detectRuleCandidates([metrics({ a: "1" })], [metrics({ a: "2" })], "metrics")).toEqual([changed("a", 'attributes["a"] == "2"')]);
  });

  it("walks every metric type of one metric, and every metric", () => {
    const point = (attrs: Attributes) => ({ attributes: attributeList(attrs) });
    const doc = (attrs: Attributes, summaryAttrs: Attributes = attrs) => ({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                { name: "a", sum: { dataPoints: [point(attrs)] }, gauge: { dataPoints: [point(attrs)] } },
                { name: "b", histogram: { dataPoints: [point(attrs)] } },
                { name: "c", exponentialHistogram: { dataPoints: [point(attrs)] }, summary: { dataPoints: [point(summaryAttrs)] } },
              ],
            },
          ],
        },
      ],
    });
    // Five data points a side, the key on all of them: changed.
    expect(detectRuleCandidates([doc({ k: "x" })], [doc({ k: "y" })], "metrics")).toEqual([changed("k", 'attributes["k"] == "y"')]);
    // On four of five output points only: not added.
    expect(detectRuleCandidates([doc({})], [doc({ k: "y" }, {})], "metrics")).toEqual([]);
  });

  it("ignores resource and scope attributes, span events and the body", () => {
    const span = (attrs: Attributes, extra: Attributes) => ({
      resourceSpans: [
        {
          resource: { attributes: attributeList(extra) },
          scopeSpans: [
            {
              scope: { name: "s", attributes: attributeList(extra) },
              spans: [{ name: "s", attributes: attributeList(attrs), events: [{ name: "e", attributes: attributeList(extra) }] }],
            },
          ],
        },
      ],
    });
    expect(detectRuleCandidates([span({}, {})], [span({}, { "service.name": "x" })], "traces")).toEqual([]);
    const log = (body: unknown, extra: Attributes) => ({
      resourceLogs: [{ resource: { attributes: attributeList(extra) }, scopeLogs: [{ scope: { attributes: attributeList(extra) }, logRecords: [{ body, attributes: [] }] }] }],
    });
    expect(detectRuleCandidates([log({ stringValue: "a" }, {})], [log({ kvlistValue: { values: attributeList({ k: "v" }) } }, { r: "1" })], "logs")).toEqual(
      [],
    );
  });
});

describe("the values compared, as OTTL compares them", () => {
  it.each([
    ["a bool", { boolValue: false }, { boolValue: true }, "true"],
    ["an int", { intValue: "1" }, { intValue: "-2" }, "-2"],
    ["a double", { doubleValue: 1.5 }, { doubleValue: 2.5 }, "2.5"],
    ["an integral double, with its decimal point", { doubleValue: 1.5 }, { doubleValue: 5 }, "5.0"],
    ["a string after an int", { intValue: "5" }, { stringValue: "5" }, '"5"'],
    ["an int after a string", { stringValue: "5" }, { intValue: "5" }, "5"],
    ["a bool after a string", { stringValue: "true" }, { boolValue: true }, "true"],
    ["a double given as text", { doubleValue: 1 }, { doubleValue: "2.5" }, "2.5"],
  ])("offers changed for %s", (_what, from, to, literal) => {
    expect(logCandidates([{ k: from }], [{ k: to }])).toEqual([changed("k", `attributes["k"] == ${literal}`)]);
  });

  it.each([
    ["an int 5 and a double 5.0", { intValue: "5" }, { doubleValue: 5 }],
    ["a double 5.0 and an int 5", { doubleValue: 5 }, { intValue: "5" }],
    ["an int as text and as a JSON number", { intValue: "7" }, { intValue: 7 }],
    ["0 and -0", { doubleValue: 0 }, { doubleValue: -0 }],
    ["equal strings", { stringValue: "a" }, { stringValue: "a" }],
    ["equal bools", { boolValue: true }, { boolValue: true }],
  ])("offers nothing for %s: the same value", (_what, from, to) => {
    expect(logCandidates([{ k: from }], [{ k: to }])).toEqual([]);
  });

  it("compares an int past 2^53 exactly, and writes it exactly", () => {
    expect(logCandidates([{ k: { intValue: "9007199254740992" } }], [{ k: { intValue: "9007199254740993" } }])).toEqual([
      changed("k", 'attributes["k"] == 9007199254740993'),
    ]);
  });

  it("compares an int and a double as OTTL does, the int converted to a double (float64(int) == double)", () => {
    // OTTL v0.162.0's compare.go: the int 2^53 + 1 rounds (ties to even) to
    // the double 2^53, so `attributes["k"] == 9007199254740992.0` passes over
    // it: the same value, no "changed", either way round.
    expect(logCandidates([{ k: { doubleValue: 9007199254740992 } }], [{ k: { intValue: "9007199254740993" } }])).toEqual([]);
    expect(logCandidates([{ k: { intValue: "9007199254740993" } }], [{ k: { doubleValue: 9007199254740992 } }])).toEqual([]);
    // The largest int converts to 2^63.
    expect(logCandidates([{ k: { doubleValue: 2 ** 63 } }], [{ k: { intValue: "9223372036854775807" } }])).toEqual([]);
    // 2^53 + 2 is a double of its own; two ints compare exactly.
    expect(logCandidates([{ k: { doubleValue: 9007199254740994 } }], [{ k: { intValue: "9007199254740993" } }])).toEqual([
      changed("k", 'attributes["k"] == 9007199254740993'),
    ]);
    expect(logCandidates([{ k: { intValue: "9007199254740992" } }], [{ k: { intValue: "9007199254740993" } }])).toEqual([
      changed("k", 'attributes["k"] == 9007199254740993'),
    ]);
    // A fractional double is no int.
    expect(logCandidates([{ k: { intValue: "5" } }], [{ k: { doubleValue: 5.5 } }])).toEqual([changed("k", 'attributes["k"] == 5.5')]);
    // Nor is an int a fractional double, the other way round (the double
    // against the int converted, Ruling 27).
    expect(logCandidates([{ k: { doubleValue: 5.5 } }], [{ k: { intValue: "5" } }])).toEqual([changed("k", 'attributes["k"] == 5')]);
  });

  it.each([
    ["the largest int", "9223372036854775807", "9223372036854775807"],
    ["the smallest int OTTL parses", "-9223372036854775807", "-9223372036854775807"],
  ])("writes %s", (_what, value, literal) => {
    expect(logCandidates([{ k: "x" }], [{ k: { intValue: value } }])).toEqual([changed("k", `attributes["k"] == ${literal}`)]);
  });

  it.each([
    ["-9223372036854775808, which OTTL can't parse", { intValue: "-9223372036854775808" }],
    ["an int past int64", { intValue: "9223372036854775808" }],
    ["an unsafe JSON number int (already rounded)", JSON.parse('{"intValue": 9007199254740993}') as unknown],
    ["a fractional int", { intValue: 1.5 }],
    ["NaN", { doubleValue: "NaN" }],
    ["Infinity", { doubleValue: "Infinity" }],
    ["-Infinity", { doubleValue: "-Infinity" }],
    ["a double that isn't a number", { doubleValue: "abc" }],
    ["a string that isn't well-formed UTF-16", { stringValue: "a\ud800" }],
    ["a stringValue that isn't a string", { stringValue: 5 }],
    ["an array", { arrayValue: { values: [{ stringValue: "a" }] } }],
    ["a kvlist", { kvlistValue: { values: [] } }],
    ["bytes", { bytesValue: "AQI=" }],
    ["an empty value", {}],
  ])("offers no changed chip for %s", (_what, to) => {
    expect(logCandidates([{ k: "x" }], [{ k: to }])).toEqual([]);
  });

  it("counts a key with no writable value as present: added and removed", () => {
    for (const value of [{ arrayValue: { values: [] } }, { kvlistValue: {} }, { bytesValue: "" }, {}]) {
      expect(logCandidates([{}], [{ k: value }])).toEqual([added("k", 'attributes["k"] != nil')]);
      expect(logCandidates([{ k: value }], [{}])).toEqual([removed("k", 'attributes["k"] != nil')]);
      // A changed chip needs a value on the input side too.
      expect(logCandidates([{ k: value }], [{ k: "x" }])).toEqual([]);
    }
    // An attribute with no value member at all.
    expect(detectRuleCandidates([logsWith([{}])], [{ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [{ key: "k" }] }] }] }] }], "logs")).toEqual([
      added("k", 'attributes["k"] != nil'),
    ]);
  });
});

describe("presence and counts", () => {
  it("offers added only when every output record has the key and no input record does", () => {
    expect(logCandidates([{}, {}], [{ k: "v" }, {}])).toEqual([]);
    expect(logCandidates([{ k: "v" }, {}], [{ k: "v" }, { k: "v" }])).toEqual([]);
    expect(logCandidates([{}, {}], [{ k: "v" }, { k: "w" }])).toEqual([added("k", 'attributes["k"] != nil')]);
  });

  it("offers removed when some input record has the key and no output record does", () => {
    expect(logCandidates([{ k: "v" }, {}, {}], [{}, {}, {}])).toEqual([removed("k", 'attributes["k"] != nil')]);
    expect(logCandidates([{ k: "v" }, { k: "v" }], [{ k: "v" }, {}])).toEqual([]);
  });

  it("offers no changed chip for unequal record counts", () => {
    expect(logCandidates([{ k: "a" }, { k: "a" }], [{ k: "b" }])).toEqual([]);
    expect(logCandidates([{ k: "a" }], [{ k: "b" }, { k: "b" }])).toEqual([]);
  });

  it("offers no changed chip for mixed values on either side", () => {
    expect(logCandidates([{ k: "a" }, { k: "b" }], [{ k: "c" }, { k: "c" }])).toEqual([]);
    expect(logCandidates([{ k: "a" }, { k: "a" }], [{ k: "c" }, { k: "d" }])).toEqual([]);
    expect(logCandidates([{ k: { intValue: "1" } }, { k: "1" }], [{ k: "c" }, { k: "c" }])).toEqual([]);
  });

  it("offers no changed chip unless the key is on every record of both sides", () => {
    expect(logCandidates([{ k: "a" }, {}], [{ k: "b" }, { k: "b" }])).toEqual([]);
    expect(logCandidates([{ k: "a" }, { k: "a" }], [{ k: "b" }, {}])).toEqual([]);
  });

  it("offers nothing when a side has no records", () => {
    expect(logCandidates([], [{ k: "v" }])).toEqual([]);
    expect(logCandidates([{ k: "v" }], [])).toEqual([]);
    expect(detectRuleCandidates([], [logsWith([{ k: "v" }])], "logs")).toEqual([]);
  });

  it("takes a key's last value when a record holds it twice, in its first place", () => {
    const record = (attributes: Array<[string, string]>) => ({
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: attributes.map(([key, value]) => ({ key, value: { stringValue: value } })) }] }] }],
    });
    expect(
      detectRuleCandidates(
        [record([["a", "1"], ["k", "x"], ["k", "y"]])],
        [record([["k", "z"], ["a", "2"], ["k", "y"]])],
        "logs",
      ),
    ).toEqual([changed("a", 'attributes["a"] == "2"')]);
    expect(detectRuleCandidates([record([["k", "x"], ["k", "y"]])], [record([["k", "z"]])], "logs")).toEqual([changed("k", 'attributes["k"] == "z"')]);
  });
});

describe("the order and the keys", () => {
  it("lists the input's keys as they first appear, then the output's others", () => {
    const input = [{ b: "1", removedLater: "x" }, { a: "1", b: "1" }];
    const output = [
      { z: "n", b: "2", a: "2" },
      { z: "n", b: "2", a: "2", "1": "new" },
    ];
    expect(logCandidates(input, output).map((c) => [c.kind, c.key])).toEqual([
      ["changed", "b"],
      ["removed", "removedLater"],
      ["added", "z"],
    ]);
    // A key like "1" keeps its place (a plain object would put it first).
    const ordered = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: ["b", "z", "1"].map((key) => ({ key, value: { stringValue: key } })) }] }] }] };
    expect(detectRuleCandidates([logsWith([{ b: "b" }])], [ordered], "logs").map((c) => c.key)).toEqual(["z", "1"]);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])("treats %s as any other key", (key) => {
    expect(logCandidates([{}], [{ [key]: "v" }])).toEqual([added(key, `attributes["${key}"] != nil`)]);
    expect(logCandidates([{ [key]: "v" }], [{}])).toEqual([removed(key, `attributes["${key}"] != nil`)]);
    expect(logCandidates([{ [key]: "a" }], [{ [key]: "b" }])).toEqual([changed(key, `attributes["${key}"] == "b"`)]);
    expect(logCandidates([{ other: "a" }], [{ other: "a" }])).toEqual([]);
  });

  it("reads a document's members as its own, never an inherited one", () => {
    const record = JSON.parse('{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[{"key":"__proto__","value":{"stringValue":"v"}}]}]}]}]}') as unknown;
    expect(detectRuleCandidates([logsWith([{}])], [record], "logs")).toEqual([added("__proto__", 'attributes["__proto__"] != nil')]);
  });
});

describe("the OTTL written: the key and value escaped", () => {
  it("writes the crafted key so the condition tests that one key", () => {
    const key = 'x"] != nil or attributes["y';
    expect(logCandidates([{ x: "1", y: "2" }], [{ x: "1", y: "2", [key]: "v" }])).toEqual([
      added(key, 'attributes["x\\"] != nil or attributes[\\"y"] != nil'),
    ]);
    expect(logCandidates([{ [key]: "v" }], [{}])).toEqual([removed(key, 'attributes["x\\"] != nil or attributes[\\"y"] != nil')]);
  });

  it("writes a key with a newline as one key", () => {
    expect(logCandidates([{}], [{ "a\nb": "v" }])).toEqual([added("a\nb", 'attributes["a\\nb"] != nil')]);
  });

  it("escapes a changed string value", () => {
    expect(logCandidates([{ k: "x" }], [{ k: 'a"b\\c\nd\u0001 ' }])).toEqual([changed("k", 'attributes["k"] == "a\\"b\\\\c\\nd\\u0001\\u2028"')]);
  });

  it("offers no chip for a key that isn't well-formed UTF-16", () => {
    expect(logCandidates([{}], [{ "a\ud800": "v", ok: "v" }])).toEqual([added("ok", 'attributes["ok"] != nil')]);
  });

  it("writes each change with candidatePrefill", () => {
    expect(candidatePrefill({ kind: "added", key: "k" })).toEqual({ quantifier: "all", condition: 'attributes["k"] != nil' });
    expect(candidatePrefill({ kind: "removed", key: "k" })).toEqual({ quantifier: "none", condition: 'attributes["k"] != nil' });
    expect(candidatePrefill({ kind: "changed", key: "k", to: { kind: "double", value: 1e21 } })).toEqual({
      quantifier: "all",
      condition: 'attributes["k"] == 1000000000000000000000.0',
    });
    expect(candidatePrefill({ kind: "changed", key: "k", to: { kind: "double", value: Number.NaN } })).toBeNull();
    expect(candidatePrefill({ kind: "changed", key: "k", to: null })).toBeNull();
    expect(candidatePrefill({ kind: "added", key: "\udc00" })).toBeNull();
  });

  describe("no chip past a rule's 8,192 bytes (Ruling 24)", () => {
    // `attributes["` and `"] != nil` are 21 bytes: a key of 8,171 bytes as
    // written makes a condition of 8,192, the most a rule saves.
    const prefix = 'attributes["';
    const suffix = '"] != nil';
    const condition = (written: string) => `${prefix}${written}${suffix}`;
    const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

    it.each([
      // 8,171 a's: 8,192 bytes; 8,172: 8,193.
      ["a long key", "a", "a", 8_171],
      // Each U+0001 is written \u0001, 6 bytes: 1,361 make 8,187; 1,362, 8,193.
      ["a key of control characters", "\u0001", "\\u0001", 1_361],
      // UTF-8's bytes, not UTF-16's units: each 🚀 is 4 bytes (2 units): 2,042 make 8,189; 2,043, 8,193.
      ["a key of 4-byte characters", "🚀", "🚀", 2_042],
    ])("offers %s just under the bound, and nothing just over", (_what, unit, writtenUnit, most) => {
      const under = unit.repeat(most);
      const over = unit.repeat(most + 1);
      expect(utf8Bytes(condition(writtenUnit.repeat(most)))).toBeLessThanOrEqual(8_192);
      expect(utf8Bytes(condition(writtenUnit.repeat(most + 1)))).toBeGreaterThan(8_192);
      for (const kind of ["added", "removed"] as const) {
        expect(candidatePrefill({ kind, key: under })).toEqual({ quantifier: kind === "added" ? "all" : "none", condition: condition(writtenUnit.repeat(most)) });
        expect(candidatePrefill({ kind, key: over })).toBeNull();
      }
      expect(logCandidates([{}], [{ [under]: "v" }])).toEqual([added(under, condition(writtenUnit.repeat(most)))]);
      expect(logCandidates([{}], [{ [over]: "v", ok: "v" }])).toEqual([added("ok", 'attributes["ok"] != nil')]);
      expect(logCandidates([{ [over]: "v" }], [{}])).toEqual([]);
    });

    it("bounds a changed condition, its value included: 8,192 bytes exactly is offered", () => {
      // `attributes["k"] == "` and `"` are 21 bytes.
      const under = "v".repeat(8_171);
      expect(candidatePrefill({ kind: "changed", key: "k", to: { kind: "string", value: under } })).toEqual({
        quantifier: "all",
        condition: `attributes["k"] == "${under}"`,
      });
      expect(utf8Bytes(`attributes["k"] == "${under}"`)).toBe(8_192);
      expect(candidatePrefill({ kind: "changed", key: "k", to: { kind: "string", value: `${under}v` } })).toBeNull();
      expect(logCandidates([{ k: "x" }], [{ k: `${under}v` }])).toEqual([]);
      expect(logCandidates([{ k: "x" }], [{ k: under }])).toEqual([changed("k", `attributes["k"] == "${under}"`)]);
    });
  });

  it("reopens a saved prefill as it was written (a prefill saved and reopened)", () => {
    // The caller saves each on the run's signal's record context; reopening
    // goes through D15a's recognition with ruling 11's unescape.
    const signal: TestRunSignal = "logs";
    const [changedLevel, addedKey] = logCandidates([{ level: "debug" }], [{ level: "info", "a\nb\t\u0001": "v" }]);
    expect(addedKey?.condition).toBe('attributes["a\\nb\\t\\u0001"] != nil');
    for (const candidate of [changedLevel, addedKey]) {
      const ottl = { context: recordContextForSignal(signal), quantifier: candidate?.quantifier ?? "all", condition: candidate?.condition ?? "" };
      expect(recognizeBuilderRule(ottl, signal)).toMatchObject({ mode: "record_attribute", key: candidate?.key });
    }
    // A number's condition isn't a builder's shape: it reopens in OTTL mode, as written.
    const [number] = logCandidates([{ n: { intValue: "1" } }], [{ n: { intValue: "2" } }]);
    expect(recognizeBuilderRule({ context: "log", quantifier: "all", condition: number?.condition ?? "" }, signal)).toBeNull();
  });
});

describe("the files read", () => {
  const input = logsWith([{ level: "debug" }]);
  const output = logsWith([{ level: "info" }]);
  const level = [changed("level", 'attributes["level"] == "info"')];

  it("reads one document, perhaps pretty-printed", () => {
    expect(detectRuleCandidatesInText(JSON.stringify(input, null, 2), JSON.stringify(output, null, 2), "logs")).toEqual(level);
  });

  it("reads the tester's {\"records\": […]} output as its documents", () => {
    const wrapped = JSON.stringify({ records: [logsWith([{ level: "info" }]), logsWith([{ level: "info" }])] });
    expect(readOutputDocuments(wrapped)).toHaveLength(2);
    expect(detectRuleCandidatesInText(JSON.stringify(logsWith([{ level: "debug" }, { level: "debug" }])), wrapped, "logs")).toEqual(level);
  });

  it("reads the wrapper only as that one key", () => {
    expect(readOutputDocuments(JSON.stringify({ records: [output], other: 1 }))).toHaveLength(1);
    expect(readOutputDocuments(JSON.stringify({ records: {} }))).toHaveLength(1);
    // The input has no wrapper.
    expect(readInputDocuments(JSON.stringify({ records: [input, input] }))).toHaveLength(1);
  });

  it("reads a JSON array of documents on either side", () => {
    const inputs = JSON.stringify([logsWith([{ level: "debug" }]), logsWith([{ level: "debug" }])]);
    const outputs = JSON.stringify([logsWith([{ level: "info" }]), logsWith([{ level: "info" }])]);
    expect(readInputDocuments(inputs)).toHaveLength(2);
    expect(detectRuleCandidatesInText(inputs, outputs, "logs")).toEqual(level);
  });

  it("reads NDJSON document by document on either side, blank lines skipped", () => {
    const inputs = `${JSON.stringify(logsWith([{ level: "debug" }]))}\n\n${JSON.stringify(logsWith([{ level: "debug" }]))}\n`;
    const outputs = `${JSON.stringify(logsWith([{ level: "info" }]))}\r\n${JSON.stringify(logsWith([{ level: "info" }]))}`;
    expect(readInputDocuments(inputs)).toHaveLength(2);
    expect(readOutputDocuments(outputs)).toHaveLength(2);
    expect(detectRuleCandidatesInText(inputs, outputs, "logs")).toEqual(level);
  });

  it("reads nothing from NDJSON with one bad line", () => {
    const inputs = `${JSON.stringify(input)}\n{"resourceLogs": [\n${JSON.stringify(input)}`;
    expect(readInputDocuments(inputs)).toEqual([]);
    expect(detectRuleCandidatesInText(inputs, JSON.stringify(output), "logs")).toEqual([]);
    expect(detectRuleCandidatesInText(JSON.stringify(input), `${JSON.stringify(output)}\nnot json`, "logs")).toEqual([]);
  });

  it("reads nothing from invalid JSON, or an empty file", () => {
    expect(detectRuleCandidatesInText("{not json", JSON.stringify(output), "logs")).toEqual([]);
    expect(detectRuleCandidatesInText(JSON.stringify(input), '{"resourceLogs": [', "logs")).toEqual([]);
    expect(detectRuleCandidatesInText("", JSON.stringify(output), "logs")).toEqual([]);
    expect(readOutputDocuments("  \n ")).toEqual([]);
    expect(detectRuleCandidatesInText("5", '"text"', "logs")).toEqual([]);
  });
});

/** A turn of the event loop's timers: lets a timer already due, such as the test's timeout, fire first. */
const nextTimerTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the load", () => {
  // One pass (Preflight ruling 9, Ruling 24): per-key filtering (even with a
  // Map per record, each key filtering every record) is quadratic: at 100,000
  // records it ran far past the suite's testTimeout (216.7 s in Ruling 24's
  // probe), so it times out here. The suite's testTimeout is the only bound,
  // made to hold for synchronous work: the test yields before it, so vitest's
  // timeout is already running, and yields to the timers after it, so a
  // timeout that fell due during the work fails the test.
  it("detects 100,000 records of unique keys in one pass (the suite's testTimeout the only bound)", async () => {
    const records = 100_000;
    const input = { resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: records }, (_, i) => ({ attributes: [{ key: `key.${i}`, value: { stringValue: "v" } }] })) }] }] };
    const output = { resourceLogs: [{ scopeLogs: [{ logRecords: Array.from({ length: records }, () => ({ attributes: [] })) }] }] };
    await Promise.resolve();
    const candidates = detectRuleCandidates([input], [output], "logs");
    await nextTimerTurn();
    expect(candidates).toHaveLength(records);
    expect(candidates[0]).toEqual(removed("key.0", 'attributes["key.0"] != nil'));
    expect(candidates[records - 1]?.key).toBe(`key.${records - 1}`);
  });
});

/*
 * The writer's cases, checked by the evaluator (Preflight ruling 10, Ruling
 * 24): `services/ottl-evaluator/internal/rules/testdata/compare-prefills.json`,
 * written by compare-prefills-fixture.ts from this writer, whose every
 * condition compare_prefills_test.go validates in the log, span and
 * datapoint contexts and evaluates, over the case's value, its sameAs and
 * its differentFrom. Read, never written, here.
 */
const committedFixture = readFileSync(COMPARE_PREFILLS_FIXTURE_PATH, "utf8");
const fixture = JSON.parse(committedFixture) as ComparePrefillsFixture;

/** One log record holding `key` with `value`. */
const oneRecord = (key: string, value: unknown) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [{ key, value }] }] }] }] });

describe("the fixture the evaluator checks", () => {
  it("is what the script writes from the writer today", () => {
    // Not toBe: a stale fixture's message names the script, not a 22 KB diff.
    expect(
      committedFixture === serializedComparePrefillsFixture(),
      `${COMPARE_PREFILLS_FIXTURE} is stale: the writer (diff-rule-detection.ts) or the cases (compare-prefills-fixture.ts) changed. Run \`${COMPARE_PREFILLS_SCRIPT}\` and commit the file.`,
    ).toBe(true);
    expect(fixture.description).toContain(COMPARE_PREFILLS_SCRIPT);
  });

  it("is two-space JSON ending in one newline, -0 kept", () => {
    const text = serializedComparePrefillsFixture({ description: "d", cases: [] });
    expect(text).toBe('{\n  "description": "d",\n  "cases": []\n}\n');
    const zero = serializedComparePrefillsFixture({
      description: "d",
      cases: [{ name: "z", key: "n", value: { doubleValue: -0 }, kind: "changed", quantifier: "all", condition: "c", sameAs: [{ doubleValue: 0 }], differentFrom: [] }],
    });
    expect(zero).toContain('"doubleValue": -0\n');
    expect(zero).toContain('"doubleValue": 0\n');
    expect(Object.is((JSON.parse(zero) as ComparePrefillsFixture).cases[0]?.value?.doubleValue, -0)).toBe(true);
  });

  it("names the evaluator's rules package's testdata, from the repository's root", () => {
    expect(COMPARE_PREFILLS_FIXTURE_PATH.endsWith(`/${COMPARE_PREFILLS_FIXTURE}`)).toBe(true);
    expect(readFileSync(join(COMPARE_PREFILLS_FIXTURE_PATH, "../../check.go"), "utf8")).toContain("package rules");
  });

  it("holds ruling 10's 7 keys by 6 shapes, the crafted key's included, and the number cases", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(42);
    const crafted = fixture.cases.filter((c) => c.key === 'x"] != nil or attributes["y').map((c) => c.kind);
    expect(crafted).toEqual(expect.arrayContaining(["added", "removed", "changed"]));
    const kinds = new Set(fixture.cases.map((c) => (c.value === null ? c.kind : Object.keys(c.value)[0])));
    expect([...kinds].sort()).toEqual(["added", "boolValue", "doubleValue", "intValue", "removed", "stringValue"]);
    expect(fixture.cases.some((c) => Object.is(c.value?.doubleValue, -0))).toBe(true);
  });

  it("holds OTTL's int and double cases: the double 2^53 the int 2^53 + 1 equals (Ruling 24)", () => {
    const double = fixture.cases.find((c) => c.value?.doubleValue === 9007199254740992);
    expect(double?.sameAs).toContainEqual({ intValue: "9007199254740993" });
    const integer = fixture.cases.find((c) => c.value?.intValue === "9007199254740993");
    expect(integer?.sameAs).toContainEqual({ doubleValue: 9007199254740992 });
    expect(integer?.differentFrom).toContainEqual({ intValue: "9007199254740992" });
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("writes the fixture's condition: %s", (_name, c) => {
    const { input, output } = comparePrefillRecords(c);
    expect(detectRuleCandidates([input], [output], "logs")).toEqual([{ kind: c.kind, key: c.key, quantifier: c.quantifier, condition: c.condition }]);
  });

  // The evaluator passes each condition over its sameAs and fails it over
  // its differentFrom: detection agrees, offering no "changed" from a sameAs
  // to the case's value, and the case's own from a differentFrom.
  it.each(fixture.cases.filter((c) => c.sameAs.length + c.differentFrom.length > 0).map((c) => [c.name, c] as const))(
    "takes the same values as OTTL's ==: %s",
    (_name, c) => {
      for (const same of c.sameAs) {
        expect(detectRuleCandidates([oneRecord(c.key, same)], [oneRecord(c.key, c.value)], "logs"), JSON.stringify(same)).toEqual([]);
      }
      for (const other of c.differentFrom) {
        expect(detectRuleCandidates([oneRecord(c.key, other)], [oneRecord(c.key, c.value)], "logs"), JSON.stringify(other)).toEqual([
          { kind: c.kind, key: c.key, quantifier: c.quantifier, condition: c.condition },
        ]);
      }
    },
  );
});
