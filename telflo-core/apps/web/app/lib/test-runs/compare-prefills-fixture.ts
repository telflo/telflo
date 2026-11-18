import { fileURLToPath } from "node:url";

import { detectRuleCandidates, type RuleCandidate } from "~/lib/test-runs/diff-rule-detection.js";

/*
 * The OTTL Compare's "Create an OTTL rule" writes, as the evaluator checks
 * it (D15b decision 4, Preflight ruling 10, Ruling 24): each case's key and
 * value run through detectRuleCandidates, committed as
 * `services/ottl-evaluator/internal/rules/testdata/compare-prefills.json`.
 * The evaluator's `compare_prefills_test.go` checks every condition in the
 * log, span and datapoint contexts and evaluates it: over the case's value
 * it passes (added, changed) or fails (removed); over each of `sameAs` (the
 * values detection takes for the same one, so offers no "changed") it
 * passes; over each of `differentFrom` it fails. The web's
 * `diff-rule-detection.test.ts` checks the committed file is what this
 * writes from the writer today, and detection's sameness against both lists.
 *
 * `npm run fixture:compare-prefills --workspace @telflo/web` writes it
 * (write-compare-prefills-fixture.ts). Pure: nothing here writes a file.
 */

/** The command that writes the fixture. */
export const COMPARE_PREFILLS_SCRIPT = "npm run fixture:compare-prefills --workspace @telflo/web";

/** Where the fixture is, from the repository's root. */
export const COMPARE_PREFILLS_FIXTURE = "services/ottl-evaluator/internal/rules/testdata/compare-prefills.json";

/** The repository's root (this file is telflo-core/apps/web/app/lib/test-runs/). */
const REPOSITORY_ROOT = new URL("../../../../../../", import.meta.url);

/** The fixture's absolute path. */
export const COMPARE_PREFILLS_FIXTURE_PATH = fileURLToPath(new URL(COMPARE_PREFILLS_FIXTURE, REPOSITORY_ROOT));

/** An OTLP/JSON AnyValue, as the fixture holds it. */
type AnyValue = Record<string, unknown>;

/** A case before it is written: the change, its key, and (for changed) the output's value. */
interface ComparePrefillSource {
  name: string;
  key: string;
  kind: RuleCandidate["kind"];
  value: AnyValue | null;
  sameAs?: AnyValue[];
  differentFrom?: AnyValue[];
}

/** One case of the fixture. */
export interface ComparePrefill {
  name: string;
  key: string;
  value: AnyValue | null;
  kind: RuleCandidate["kind"];
  quantifier: RuleCandidate["quantifier"];
  condition: string;
  sameAs: AnyValue[];
  differentFrom: AnyValue[];
}

export interface ComparePrefillsFixture {
  description: string;
  cases: ComparePrefill[];
}

/** Ruling 10's 7 keys, each with its name, the crafted one included. */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["a plain key", "env"],
  ["the crafted key", 'x"] != nil or attributes["y'],
  ["a newline", "a\nb"],
  ["a tab", "a\tb"],
  ["backspace, U+0001 and DEL", "\b\u0001\u007f"],
  ["a quote and a backslash", 'say "hi" \\ done'],
  ["Unicode", "ключ ✓ 🚀"],
];

/** Each key's 6 shapes: added, removed, and changed to each kind of value (a string, the key's own text). */
function keyCases(name: string, key: string): ComparePrefillSource[] {
  const changed = (what: string, value: AnyValue): ComparePrefillSource => ({ name: `${name}: changed to ${what}`, key, kind: "changed", value });
  return [
    { name: `${name}: added`, key, kind: "added", value: null },
    { name: `${name}: removed`, key, kind: "removed", value: null },
    changed("a string", { stringValue: key === "env" ? "prod" : key }),
    changed("an int", { intValue: "42" }),
    changed("a double", { doubleValue: 2.5 }),
    changed("a bool", { boolValue: true }),
  ];
}

/** The number and string cases, on the key `n`. */
const VALUE_CASES: ReadonlyArray<Omit<ComparePrefillSource, "key" | "kind">> = [
  { name: "changed to the int 0", value: { intValue: "0" }, sameAs: [{ doubleValue: 0 }, { doubleValue: -0 }], differentFrom: [{ boolValue: false }, { stringValue: "0" }] },
  { name: "changed to the int -1", value: { intValue: "-1" }, sameAs: [{ doubleValue: -1 }] },
  {
    // OTTL compares an int and a double as float64(int) == double: the int
    // 2^53 + 1 rounds to the double 2^53 (ties to even). Two ints, exactly.
    name: "changed to an int past 2^53, exactly",
    value: { intValue: "9007199254740993" },
    sameAs: [{ doubleValue: 9007199254740992 }],
    differentFrom: [{ intValue: "9007199254740992" }, { intValue: "9007199254740994" }, { doubleValue: 9007199254740994 }],
  },
  {
    name: "changed to the double 2^53, which the ints 2^53 and 2^53 + 1 equal",
    value: { doubleValue: 9007199254740992 },
    sameAs: [{ intValue: "9007199254740992" }, { intValue: "9007199254740993" }],
    differentFrom: [{ intValue: "9007199254740994" }, { doubleValue: 9007199254740994 }],
  },
  {
    name: "changed to the largest int",
    value: { intValue: "9223372036854775807" },
    // float64(2^63 - 1) is 2^63.
    sameAs: [{ doubleValue: 2 ** 63 }],
    differentFrom: [{ intValue: "9223372036854775806" }],
  },
  { name: "changed to the smallest int OTTL writes", value: { intValue: "-9223372036854775807" }, differentFrom: [{ intValue: "-9223372036854775806" }] },
  { name: "changed to an int as a JSON number", value: { intValue: 7 }, sameAs: [{ intValue: "7" }, { doubleValue: 7 }] },
  { name: "changed to an integral double", value: { doubleValue: 5 }, sameAs: [{ intValue: "5" }], differentFrom: [{ stringValue: "5" }, { doubleValue: 5.5 }] },
  { name: "changed to negative zero", value: { doubleValue: -0 }, sameAs: [{ doubleValue: 0 }, { intValue: "0" }] },
  { name: "changed to the double 0.1", value: { doubleValue: 0.1 }, differentFrom: [{ stringValue: "0.1" }] },
  { name: "changed to the double -2.5", value: { doubleValue: -2.5 } },
  { name: "changed to a double with fractional digits", value: { doubleValue: 123456789.125 } },
  { name: "changed to the double 1e21", value: { doubleValue: 1e21 } },
  { name: "changed to the double 1.5e300", value: { doubleValue: 1.5e300 } },
  { name: "changed to the largest double", value: { doubleValue: 1.7976931348623157e308 } },
  { name: "changed to the double 1e-7", value: { doubleValue: 1e-7 } },
  { name: "changed to the double -1e-7", value: { doubleValue: -1e-7 } },
  { name: "changed to the smallest double", value: { doubleValue: 5e-324 }, differentFrom: [{ intValue: "0" }, { doubleValue: 0 }] },
  { name: "changed to the bool false", value: { boolValue: false }, differentFrom: [{ intValue: "0" }, { stringValue: "false" }] },
  { name: "changed to the empty string", value: { stringValue: "" } },
  { name: "changed to the string NaN", value: { stringValue: "NaN" } },
  {
    name: "changed to every escaped character",
    value: { stringValue: "\u0000\b\u001f\u007f\u0080\u0085\u009f  \r\n\t\"\\" },
  },
];

/** Every case, in the fixture's order: each key's 6 shapes, then the value cases. */
function comparePrefillSources(): ComparePrefillSource[] {
  return [...KEYS.flatMap(([name, key]) => keyCases(name, key)), ...VALUE_CASES.map((c) => ({ ...c, key: "n", kind: "changed" as const }))];
}

/** One log record holding `attributes`. */
function logDocument(attributes: unknown[]): unknown {
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes }] }] }] };
}

/**
 * The one record each side of a case: added, none on the input; removed,
 * none on the output; changed, the input's value a string no case holds.
 */
export function comparePrefillRecords(c: { key: string; kind: RuleCandidate["kind"]; value: AnyValue | null }): { input: unknown; output: unknown } {
  const present = c.value ?? { stringValue: "present" };
  const input = c.kind === "added" ? [] : [{ key: c.key, value: c.kind === "removed" ? present : { stringValue: "__before__" } }];
  const output = c.kind === "removed" ? [] : [{ key: c.key, value: present }];
  return { input: logDocument(input), output: logDocument(output) };
}

/** A case written by the writer: detectRuleCandidates over its records, which must offer just its own change. */
function writtenCase(source: ComparePrefillSource): ComparePrefill {
  const { input, output } = comparePrefillRecords(source);
  const candidates = detectRuleCandidates([input], [output], "logs");
  const [candidate] = candidates;
  if (candidates.length !== 1 || candidate === undefined || candidate.kind !== source.kind || candidate.key !== source.key) {
    throw new Error(`${source.name}: the writer offers ${candidates.length} candidates, not the case's own`);
  }
  return {
    name: source.name,
    key: source.key,
    value: source.value,
    kind: candidate.kind,
    quantifier: candidate.quantifier,
    condition: candidate.condition,
    sameAs: source.sameAs ?? [],
    differentFrom: source.differentFrom ?? [],
  };
}

/** The fixture, from the writer as it is today. */
export function comparePrefillsFixture(): ComparePrefillsFixture {
  return {
    description:
      'The OTTL Compare\'s "Create an OTTL rule" writes for an added, removed or changed record attribute (D15b decision 4, ' +
      "Preflight ruling 10, Ruling 24): each case's key, its value (an OTLP AnyValue; null for added and removed), the Require " +
      "and Condition written, and the values detection takes for the same as it (sameAs) and for others (differentFrom). " +
      "compare_prefills_test.go checks each condition in the log, span and datapoint contexts and evaluates it: it passes over " +
      "the value and each of sameAs, and fails over each of differentFrom. Generated by `" +
      COMPARE_PREFILLS_SCRIPT +
      "` (apps/web/app/lib/test-runs/write-compare-prefills-fixture.ts) from apps/web's diff-rule-detection.ts: never edit by hand.",
    cases: comparePrefillSources().map(writtenCase),
  };
}

/** JSON can't write -0 with JSON.stringify; the replacer marks it and the text is mended after. */
const NEGATIVE_ZERO = "__compare_prefills_negative_zero__";

/** The fixture as the committed file holds it: two-space JSON (-0 kept), ending in one newline. */
export function serializedComparePrefillsFixture(fixture: ComparePrefillsFixture = comparePrefillsFixture()): string {
  const text = JSON.stringify(fixture, (_key, value: unknown) => (Object.is(value, -0) ? NEGATIVE_ZERO : value), 2);
  return `${text.replaceAll(`"${NEGATIVE_ZERO}"`, "-0")}\n`;
}
