/*
 * A `telflo test` spec file (D27 decisions 11 and 27, Preflight ruling 6):
 * the older Telflo CLI's YAML as it is, its rules converted to the
 * platform's OTTL rule `{ kind: "ottl", target: "output", name?, ottl:
 * { context, quantifier, condition?, expression?, count? } }` and checked
 * first as the API would (`CreateValidationRuleRequestSchema` and
 * `OTTL_CONTEXTS_BY_SIGNAL`), so a bad rule is exit 2 naming its index and
 * field before anything is sent.
 *
 * The constants are the contracts' own, copied (the CLI imports nothing from
 * a workspace at run time); each has a drift test importing the contracts.
 *
 * A spec's sample and rules are configuration text (Q168): no message here
 * quotes them, nor a key or a path the file names; a YAML error names its
 * line and column only.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { EXIT, ExitError } from "./output.js";

export const TEST_SIGNALS = ["traces", "metrics", "logs"] as const;
export type TestSignal = (typeof TEST_SIGNALS)[number];

/** The seven OTTL contexts, and which each signal allows (the evaluator's table). */
export const RULE_CONTEXTS = ["log", "span", "spanevent", "metric", "datapoint", "resource", "scope"] as const;
export const RULE_CONTEXTS_BY_SIGNAL: Readonly<Record<TestSignal, readonly string[]>> = {
  logs: ["log", "resource", "scope"],
  traces: ["span", "spanevent", "resource", "scope"],
  metrics: ["metric", "datapoint", "resource", "scope"],
};
export const RULE_QUANTIFIERS = ["all", "any", "none", "count", "distinct"] as const;
export const RULE_COUNT_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "between"] as const;
/** A count's largest value: Postgres's `integer`. */
export const RULE_COUNT_MAXIMUM = 2_147_483_647;
/** A rule's name, trimmed: at most this many code points. */
export const RULE_NAME_MAXIMUM_LENGTH = 200;
/** A condition's or an expression's most bytes of UTF-8. */
export const RULE_TEXT_MAXIMUM_BYTES = 8_192;
/** A run's inline rules: 1 to 20. */
export const TEST_RULES_MAXIMUM = 20;
/** The sample's most bytes, UTF-8 (the API's decoded limit, 1 MiB). */
export const TEST_SAMPLE_MAXIMUM_BYTES = 1_048_576;
/** A pipeline's name: at most this many code points. */
export const TEST_PIPELINE_MAXIMUM_LENGTH = 200;
export const TEST_DURATION_MINIMUM_SECONDS = 1;
export const TEST_DURATION_MAXIMUM_SECONDS = 60;
export const TEST_DEFAULT_DURATION_SECONDS = 5;

/** The keys a spec's rule may have (the older CLI's). */
const RULE_KEYS = new Set(["name", "context", "quantifier", "condition", "expression", "count"]);
const COUNT_KEYS = new Set(["operator", "value", "value2"]);

/** Whitespace as the evaluator reads it (Go's `unicode.IsSpace`), as the contracts' `isBlankRuleText`. */
const ONLY_WHITESPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;
/** A lone surrogate, which Postgres can't store. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** A C0 control character but tab, line feed and carriage return (a pipeline's name can't hold one). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export interface RuleCount {
  operator: (typeof RULE_COUNT_OPERATORS)[number];
  value: number;
  value2?: number;
}

export interface RuleOttl {
  context: (typeof RULE_CONTEXTS)[number];
  quantifier: (typeof RULE_QUANTIFIERS)[number];
  condition?: string;
  expression?: string;
  count?: RuleCount;
}

/** A spec's rule as the platform takes it (`CreateValidationRuleRequest`, OTTL only). */
export interface TestRule {
  kind: "ottl";
  target: "output";
  name?: string;
  ottl: RuleOttl;
}

export interface TestSpec {
  /** The older CLI's pipeline display name: read, never sent (the platform's pipeline has none). */
  name?: string;
  signal: TestSignal;
  pipeline: string;
  duration: number;
  collectorVersion?: string;
  distribution?: string;
  sample: string;
  rules: TestRule[];
}

function fail(message: string): never {
  throw new ExitError(`test spec: ${message}`, EXIT.USAGE);
}

/** A rule's place, as the messages name it: `rules[0]`. */
export function rulePlace(index: number, field?: string): string {
  return field === undefined ? `rules[${index}]` : `rules[${index}].${field}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Code points, as Postgres's `char_length` counts (a surrogate pair is one). */
export function codePointLength(text: string): number {
  return [...text].length;
}

function hasUnstorableCharacter(text: string): boolean {
  return text.includes("\u0000") || LONE_SURROGATE.test(text);
}

/** A condition or an expression, as `ruleTextSchema` takes it: never trimmed, not blank, at most 8,192 bytes, storable. */
function ruleText(value: unknown, place: string): string {
  if (typeof value !== "string") fail(`${place} must be text.`);
  if (ONLY_WHITESPACE.test(value)) fail(`${place} is empty.`);
  if (hasUnstorableCharacter(value)) fail(`${place} can't contain U+0000 or a lone surrogate.`);
  if (Buffer.byteLength(value, "utf8") > RULE_TEXT_MAXIMUM_BYTES) fail(`${place} is longer than 8,192 bytes.`);
  return value;
}

function countValue(value: unknown, place: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > RULE_COUNT_MAXIMUM) {
    fail(`${place} must be a whole number from 0 to ${RULE_COUNT_MAXIMUM}.`);
  }
  return value;
}

function ruleCount(value: unknown, index: number): RuleCount {
  const place = rulePlace(index, "count");
  if (!isRecord(value)) fail(`${place} must be a mapping of operator, value and (for between) value2.`);
  if (Object.keys(value).some((key) => !COUNT_KEYS.has(key))) fail(`${place} takes operator, value and value2 only.`);
  const operator = value.operator;
  if (typeof operator !== "string" || !(RULE_COUNT_OPERATORS as readonly string[]).includes(operator)) {
    fail(`${place}.operator must be one of ${RULE_COUNT_OPERATORS.join(", ")}.`);
  }
  const count: RuleCount = { operator: operator as RuleCount["operator"], value: countValue(value.value, `${place}.value`) };
  if (operator === "between") {
    if (value.value2 === undefined) fail(`${place}.value2 is needed for between.`);
    const value2 = countValue(value.value2, `${place}.value2`);
    if (value2 < count.value) fail(`${place}.value2 can't be less than value.`);
    count.value2 = value2;
  } else if (value.value2 !== undefined) {
    fail(`${place}.value2 is for between only.`);
  }
  return count;
}

/**
 * One spec rule as the platform's OTTL rule, checked as the API checks it
 * (Preflight ruling 6): the context one of the seven and allowed for the
 * signal; `condition` required but for `distinct` (its optional filter);
 * `expression` for `distinct` only; `count` for `count` and `distinct`
 * only; a name of at most 200 code points; no other key. Exit 2 names the
 * rule's index and field.
 */
export function convertRule(raw: unknown, index: number, signal: TestSignal): TestRule {
  if (!isRecord(raw)) fail(`${rulePlace(index)} must be a mapping.`);
  if (Object.keys(raw).some((key) => !RULE_KEYS.has(key))) {
    fail(`${rulePlace(index)} has a field a rule doesn't take (a rule takes ${[...RULE_KEYS].join(", ")}).`);
  }
  const context = raw.context;
  if (typeof context !== "string" || !(RULE_CONTEXTS as readonly string[]).includes(context)) {
    fail(`${rulePlace(index, "context")} must be one of ${RULE_CONTEXTS.join(", ")}.`);
  }
  const allowed = RULE_CONTEXTS_BY_SIGNAL[signal];
  if (!allowed.includes(context)) {
    fail(`${rulePlace(index, "context")} must be one of ${allowed.join(", ")} for a ${signal} pipeline.`);
  }
  const quantifier = raw.quantifier;
  if (typeof quantifier !== "string" || !(RULE_QUANTIFIERS as readonly string[]).includes(quantifier)) {
    fail(`${rulePlace(index, "quantifier")} must be one of ${RULE_QUANTIFIERS.join(", ")}.`);
  }
  const isDistinct = quantifier === "distinct";
  const takesCount = quantifier === "count" || isDistinct;
  const ottl: RuleOttl = { context: context as RuleOttl["context"], quantifier: quantifier as RuleOttl["quantifier"] };

  if (raw.condition !== undefined) ottl.condition = ruleText(raw.condition, rulePlace(index, "condition"));
  else if (!isDistinct) fail(`${rulePlace(index, "condition")} is needed (only distinct may leave it out).`);

  if (isDistinct) {
    if (raw.expression === undefined) fail(`${rulePlace(index, "expression")} is needed for distinct.`);
    ottl.expression = ruleText(raw.expression, rulePlace(index, "expression"));
  } else if (raw.expression !== undefined) {
    fail(`${rulePlace(index, "expression")} is for distinct only.`);
  }

  if (takesCount) {
    if (raw.count === undefined) fail(`${rulePlace(index, "count")} is needed for count and distinct.`);
    ottl.count = ruleCount(raw.count, index);
  } else if (raw.count !== undefined) {
    fail(`${rulePlace(index, "count")} is for count and distinct only.`);
  }

  const rule: TestRule = { kind: "ottl", target: "output", ottl };
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string") fail(`${rulePlace(index, "name")} must be text.`);
    const name = raw.name.trim();
    if (codePointLength(name) > RULE_NAME_MAXIMUM_LENGTH) fail(`${rulePlace(index, "name")} is longer than 200 characters.`);
    if (hasUnstorableCharacter(name)) fail(`${rulePlace(index, "name")} can't contain U+0000 or a lone surrogate.`);
    if (name !== "") rule.name = name;
  }
  return rule;
}

function readSample(raw: Record<string, unknown>, specDir: string): string {
  const hasPath = typeof raw.sample === "string";
  const hasText = typeof raw.sample_text === "string";
  if (hasPath === hasText) fail("give exactly one of sample (a file) and sample_text.");
  if (hasText) {
    const text = raw.sample_text as string;
    if (Buffer.byteLength(text, "utf8") > TEST_SAMPLE_MAXIMUM_BYTES) fail("sample_text is over 1 MiB.");
    return text;
  }
  const path = raw.sample as string;
  const resolved = isAbsolute(path) ? path : join(specDir, path);
  let size: number;
  try {
    size = statSync(resolved).size;
  } catch {
    fail("can't read the sample file.");
  }
  if (size > TEST_SAMPLE_MAXIMUM_BYTES) fail("the sample file is over 1 MiB.");
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    fail("can't read the sample file.");
  }
}

/**
 * An already-parsed spec, checked, its sample read (a `sample:` path is
 * relative to `specDir`) and its rules converted. `allowMissingRules`
 * (`--saved`): no `rules` is no rules; any given are still checked.
 */
export function normalizeTestSpec(raw: unknown, specDir: string, options: { allowMissingRules?: boolean } = {}): TestSpec {
  if (!isRecord(raw)) fail("must be a YAML mapping.");

  const signal = raw.signal;
  if (typeof signal !== "string" || !(TEST_SIGNALS as readonly string[]).includes(signal)) {
    fail(`signal must be one of ${TEST_SIGNALS.join(", ")}.`);
  }
  if (typeof raw.pipeline !== "string" || raw.pipeline.trim() === "") fail("pipeline is needed (e.g. logs/in).");
  const pipeline = raw.pipeline.trim();
  // UTF-16 units, as the API's `TestRunPipelineSchema` (zod's `.max(200)`) counts them.
  if (pipeline.length > TEST_PIPELINE_MAXIMUM_LENGTH) fail("pipeline is longer than 200 characters.");
  if (hasUnstorableCharacter(pipeline) || CONTROL_CHARACTER.test(pipeline)) fail("pipeline must be a pipeline's name.");
  if (pipeline.split("/")[0] !== signal) fail(`pipeline must be a ${signal} pipeline (${signal} or ${signal}/<name>).`);

  const duration = raw.duration ?? TEST_DEFAULT_DURATION_SECONDS;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < TEST_DURATION_MINIMUM_SECONDS ||
    duration > TEST_DURATION_MAXIMUM_SECONDS
  ) {
    fail(`duration must be a whole number of seconds from ${TEST_DURATION_MINIMUM_SECONDS} to ${TEST_DURATION_MAXIMUM_SECONDS}.`);
  }

  let name: string | undefined;
  if (raw.name !== undefined) {
    const trimmed = typeof raw.name === "string" ? raw.name.trim() : "";
    if (trimmed === "" || codePointLength(trimmed) > 200) fail("name must be text of 1 to 200 characters.");
    name = trimmed;
  }

  const sample = readSample(raw, specDir);

  const rawRules = raw.rules === undefined && options.allowMissingRules === true ? [] : raw.rules;
  if (
    !Array.isArray(rawRules) ||
    rawRules.length > TEST_RULES_MAXIMUM ||
    (rawRules.length < 1 && options.allowMissingRules !== true)
  ) {
    fail(`rules must be a list of 1 to ${TEST_RULES_MAXIMUM} rules.`);
  }
  const rules = rawRules.map((rule: unknown, index) => convertRule(rule, index, signal as TestSignal));

  const spec: TestSpec = { signal: signal as TestSignal, pipeline, duration, sample, rules };
  if (name !== undefined) spec.name = name;
  if (typeof raw.collector_version === "string") spec.collectorVersion = raw.collector_version;
  if (typeof raw.distribution === "string") spec.distribution = raw.distribution;
  return spec;
}

/** A spec file's text, parsed and checked. A YAML error names its line and column only (never the text). */
export function parseTestSpec(source: string, specDir: string, options: { allowMissingRules?: boolean } = {}): TestSpec {
  let raw: unknown;
  try {
    // `logLevel: "error"`: the library's warnings (an unknown tag) go to process.emitWarning, quoting the
    // spec's source line; none is raised. Errors are thrown, and only their line and column are named.
    raw = parse(source, { logLevel: "error" });
  } catch (error) {
    const position = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;
    fail(position === undefined ? "invalid YAML." : `invalid YAML at line ${position.line}, column ${position.col}.`);
  }
  return normalizeTestSpec(raw, specDir, options);
}
