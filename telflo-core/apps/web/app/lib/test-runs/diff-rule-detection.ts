import { utf8ByteLength, VALIDATION_RULE_TEXT_MAXIMUM_BYTES, type OttlQuantifier, type TestRunSignal } from "@telflo/contracts";

import { ottlDoubleLiteral, ottlIntegerLiteral, ottlStringLiteral } from "~/components/editor/validation-pipelines/rule-builder-shapes.js";
import { parseJsonText, type ParsedJsonText } from "~/lib/test-runs/json-format.js";

/*
 * Compare's "Create an OTTL rule" detection (D15b decisions 3 and 4; plan
 * Preflight rulings 8-10): the record attributes a run's pipeline added,
 * removed or changed, each written as the OTTL rule that asserts it:
 *
 * - record attributes only: each log record's, span's and metric data
 *   point's (every metric type), across every resource and scope; resource
 *   and scope attributes, span events and the body aren't read (decision 3);
 * - added: on no input record and on every output record → all
 *   `attributes["k"] != nil`; removed: on some input record and on no output
 *   record → none `attributes["k"] != nil`; changed: equal record counts,
 *   on every record of both sides, one value a side, the two different →
 *   all `attributes["k"] == <the output's value>`; nothing when either side
 *   has no records;
 * - the keys in order: the input's, as they first appear, then the
 *   output's others;
 * - the files are read document by document (`readInputDocuments`,
 *   `readOutputDocuments`): the tester's `{"records": […]}` output gives its
 *   documents, and an array or NDJSON input or output its own, so a run of
 *   several batches, and an NDJSON input, give their records. A line that
 *   doesn't parse, or text that is neither form, gives nothing, silently;
 * - one pass over the records, each key's count, first value and whether
 *   every value since was the same kept in a Map (Preflight ruling 9), never
 *   a filter over every record per key (40,000 records of unique keys would
 *   take about 213 s); a Map never mistakes `constructor`, `__proto__` or
 *   `toString` for keys every record holds, and never puts a key like "1"
 *   first;
 * - the key and the value are escaped as the builders escape them, control
 *   characters included (ottlStringLiteral), and numbers are valid OTTL: an
 *   integer exactly, from OTLP's decimal string, a double with its decimal
 *   point (Preflight ruling 10). A raw key (`x"] != nil or attributes["y`
 *   would give a condition testing `y`) is never written, nor a number by
 *   `String` (`NaN`, `1e+21`, 5.0 as `5`), nor an integer past 2^53 rounded
 *   by `Number`;
 * - a value is compared as OTTL compares it (v0.162.0's compare.go): numbers
 *   by value, an int and a double as the double the int converts to (an int
 *   5 and a double 5.0 are the same, so no "changed"; so are the int 2^53 + 1
 *   and the double 2^53), two ints exactly, other kinds never equal to each
 *   other. A key or value no literal can write (not well-formed UTF-16; NaN or
 *   ±Infinity; -9223372036854775808), or a condition past a rule's 8,192
 *   bytes, offers no chip (Ruling 24);
 * - an attribute holding an array, a kvlist, bytes or nothing is present
 *   (it counts for added and removed) with no value a "changed" chip could
 *   assert;
 * - a key twice in one record: the last value.
 *
 * Truncation isn't handled here: when the run's output or decoded input was
 * cut at 10 MiB (`outputTruncated`, `decodedInputTruncated`), the caller
 * doesn't detect at all and says why (Preflight ruling 8). The context of a
 * candidate's rule is the caller's too: the run's signal's record context
 * (recordContextForSignal; decision 6).
 */

/** What a candidate asserts the run's pipeline did to a record attribute. */
export type RuleCandidateKind = "added" | "removed" | "changed";

/** A rule Compare offers: the change it asserts, its key, and the OTTL rule's Require and Condition. */
export interface RuleCandidate {
  kind: RuleCandidateKind;
  key: string;
  quantifier: Extract<OttlQuantifier, "all" | "none">;
  condition: string;
}

/**
 * A record attribute's value, as OTTL compares it; null for one that is
 * present but no "changed" rule can assert (an array, a kvlist, bytes, an
 * empty value, or one that isn't valid OTLP).
 */
export type AttributeValue =
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: bigint }
  | { kind: "double"; value: number }
  | null;

/** An attribute change, before it is written as OTTL. */
export type AttributeChange =
  | { kind: "added" | "removed"; key: string }
  | { kind: "changed"; key: string; to: AttributeValue };

/**
 * The OTTL that asserts a change, as the rule editor's prefill (Preflight
 * ruling 10): added → all `attributes["k"] != nil`; removed → none, the same
 * condition; changed → all `attributes["k"] == <value>`. Null when the key
 * or the value can't be written, or the condition is past a rule's 8,192
 * bytes of UTF-8 (VALIDATION_RULE_TEXT_MAXIMUM_BYTES; Ruling 24), so no chip
 * opens an editor whose rule can't be saved.
 */
export function candidatePrefill(change: AttributeChange): { quantifier: "all" | "none"; condition: string } | null {
  const key = ottlStringLiteral(change.key);
  if (key === null) return null;
  const path = `attributes[${key}]`;
  let prefill: { quantifier: "all" | "none"; condition: string };
  if (change.kind === "changed") {
    const literal = valueLiteral(change.to);
    if (literal === null) return null;
    prefill = { quantifier: "all", condition: `${path} == ${literal}` };
  } else {
    prefill = { quantifier: change.kind === "added" ? "all" : "none", condition: `${path} != nil` };
  }
  return utf8ByteLength(prefill.condition) > VALIDATION_RULE_TEXT_MAXIMUM_BYTES ? null : prefill;
}

function valueLiteral(value: AttributeValue): string | null {
  if (value === null) return null;
  switch (value.kind) {
    case "string":
      return ottlStringLiteral(value.value);
    case "bool":
      return value.value ? "true" : "false";
    case "int":
      return ottlIntegerLiteral(value.value);
    default:
      return ottlDoubleLiteral(value.value);
  }
}

// ---- Reading the files ----

/** A file's JSON documents, as read once (parseJsonText): one document, a JSON array's elements, or NDJSON's; none for neither. */
export function documentsOf(parsed: ParsedJsonText): unknown[] {
  if (parsed.format === "single") return Array.isArray(parsed.document) ? parsed.document : [parsed.document];
  return parsed.format === "ndjson" ? parsed.documents : [];
}

/**
 * The stored output's documents, as read once (Preflight ruling 8): the
 * tester's `{"records": […]}` (that one key) gives its elements; else one
 * document, a JSON array of them, or NDJSON's.
 */
export function outputDocumentsOf(parsed: ParsedJsonText): unknown[] {
  const documents = documentsOf(parsed);
  const [only] = documents;
  if (documents.length === 1 && isObject(only)) {
    const keys = Object.keys(only);
    const records = only.records;
    if (keys.length === 1 && keys[0] === "records" && Array.isArray(records)) return records;
  }
  return documents;
}

/** The decoded input's documents (Preflight ruling 8): one document, a JSON array of them, or NDJSON. */
export function readInputDocuments(text: string): unknown[] {
  return documentsOf(parseJsonText(text));
}

/**
 * The stored output's documents (Preflight ruling 8): the tester's
 * `{"records": […]}` (that one key) gives its elements; else one document,
 * a JSON array of them, or NDJSON.
 */
export function readOutputDocuments(text: string): unknown[] {
  return outputDocumentsOf(parseJsonText(text));
}

// ---- Walking the records ----

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A member of a JSON object, its own only (never `constructor` or `__proto__`'s inherited value). */
function member(object: JsonObject, name: string): unknown {
  return Object.hasOwn(object, name) ? object[name] : undefined;
}

function objectsIn(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

const RESOURCE_KEY: Record<TestRunSignal, string> = { metrics: "resourceMetrics", traces: "resourceSpans", logs: "resourceLogs" };
const SCOPE_KEY: Record<TestRunSignal, string> = { metrics: "scopeMetrics", traces: "scopeSpans", logs: "scopeLogs" };
const METRIC_TYPES = ["sum", "gauge", "histogram", "exponentialHistogram", "summary"] as const;

/** Calls `visit` with each record's `attributes` member, in document order. */
function walkRecords(documents: readonly unknown[], signal: TestRunSignal, visit: (attributes: unknown) => void): void {
  for (const document of documents) {
    if (!isObject(document)) continue;
    for (const resource of objectsIn(member(document, RESOURCE_KEY[signal]))) {
      for (const scope of objectsIn(member(resource, SCOPE_KEY[signal]))) {
        if (signal === "metrics") {
          for (const metric of objectsIn(member(scope, "metrics"))) {
            for (const type of METRIC_TYPES) {
              const data = member(metric, type);
              if (!isObject(data)) continue;
              for (const point of objectsIn(member(data, "dataPoints"))) visit(member(point, "attributes"));
            }
          }
        } else {
          const records = objectsIn(member(scope, signal === "traces" ? "spans" : "logRecords"));
          for (const record of records) visit(member(record, "attributes"));
        }
      }
    }
  }
}

const INTEGER_TEXT = /^-?\d+$/;
const NUMBER_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

/** An OTLP AnyValue as OTTL compares it, its members read in a fixed order. */
function readValue(raw: unknown): AttributeValue {
  if (!isObject(raw)) return null;
  if (Object.hasOwn(raw, "stringValue")) {
    const value = raw.stringValue;
    return typeof value === "string" ? { kind: "string", value } : null;
  }
  if (Object.hasOwn(raw, "intValue")) return readInt(raw.intValue);
  if (Object.hasOwn(raw, "doubleValue")) return readDouble(raw.doubleValue);
  if (Object.hasOwn(raw, "boolValue")) {
    const value = raw.boolValue;
    return typeof value === "boolean" ? { kind: "bool", value } : null;
  }
  return null;
}

/** OTLP/JSON's int64: a decimal string (exactly), or a JSON number only when it is exact (a safe integer). */
function readInt(raw: unknown): AttributeValue {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? { kind: "int", value: BigInt(raw) } : null;
  if (typeof raw !== "string" || !INTEGER_TEXT.test(raw)) return null;
  const value = BigInt(raw);
  return value >= INT64_MIN && value <= INT64_MAX ? { kind: "int", value } : null;
}

/** OTLP/JSON's double: a JSON number, or a string ("NaN", "Infinity", "-Infinity", or a number's text). */
function readDouble(raw: unknown): AttributeValue {
  if (typeof raw === "number") return { kind: "double", value: raw };
  if (typeof raw !== "string") return null;
  if (raw === "NaN") return { kind: "double", value: Number.NaN };
  if (raw === "Infinity") return { kind: "double", value: Number.POSITIVE_INFINITY };
  if (raw === "-Infinity") return { kind: "double", value: Number.NEGATIVE_INFINITY };
  return NUMBER_TEXT.test(raw) ? { kind: "double", value: Number(raw) } : null;
}

/**
 * Whether two values are the same, as OTTL's `==` (Preflight ruling 10;
 * Ruling 24): two ints exactly; an int and a double as compare.go's
 * `float64(int) == double`, the int rounded to the nearest double, ties to
 * even (`Number` of a BigInt rounds as Go's conversion does), so the int
 * 2^53 + 1 is the double 2^53; two doubles by value; other kinds never equal
 * each other. NaN is the same as NaN here: a side of NaNs is still one value,
 * and no literal can write it.
 */
function sameValue(a: AttributeValue, b: AttributeValue): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "int" && b.kind === "int") return a.value === b.value;
  if (a.kind === "double" && b.kind === "double") return a.value === b.value || (Number.isNaN(a.value) && Number.isNaN(b.value));
  if (a.kind === "int" && b.kind === "double") return Number(a.value) === b.value;
  if (a.kind === "double" && b.kind === "int") return a.value === Number(b.value);
  return a.kind === b.kind && a.value === b.value;
}

/** One side's view of one key: on how many records, its first value, and whether every value since was the same. */
interface KeySide {
  count: number;
  first: AttributeValue;
  uniform: boolean;
}

interface KeyStats {
  input: KeySide;
  output: KeySide;
}

function emptySide(): KeySide {
  return { count: 0, first: null, uniform: true };
}

/** A record's attributes, a key twice keeping its first place and its last value. */
function recordAttributes(raw: unknown): Map<string, AttributeValue> {
  const attributes = new Map<string, AttributeValue>();
  for (const item of objectsIn(raw)) {
    const key = member(item, "key");
    if (typeof key === "string") attributes.set(key, readValue(member(item, "value")));
  }
  return attributes;
}

/** Folds each record of one side into `stats`, in one pass; the side's record count. */
function tally(documents: readonly unknown[], signal: TestRunSignal, stats: Map<string, KeyStats>, side: "input" | "output"): number {
  let records = 0;
  walkRecords(documents, signal, (raw) => {
    records++;
    for (const [key, value] of recordAttributes(raw)) {
      let entry = stats.get(key);
      if (entry === undefined) {
        entry = { input: emptySide(), output: emptySide() };
        stats.set(key, entry);
      }
      const view = entry[side];
      view.count++;
      if (view.count === 1) view.first = value;
      else if (view.uniform && !sameValue(view.first, value)) view.uniform = false;
    }
  });
  return records;
}

/** The change a key shows, of the three cases; null for none. */
function changeOf(key: string, stats: KeyStats, inputRecords: number, outputRecords: number): AttributeChange | null {
  const { input, output } = stats;
  if (input.count === 0 && output.count === outputRecords) return { kind: "added", key };
  if (input.count > 0 && output.count === 0) return { kind: "removed", key };
  if (
    inputRecords === outputRecords &&
    input.count === inputRecords &&
    output.count === outputRecords &&
    input.uniform &&
    output.uniform &&
    input.first !== null &&
    output.first !== null &&
    !sameValue(input.first, output.first)
  ) {
    return { kind: "changed", key, to: output.first };
  }
  return null;
}

/**
 * The rules Compare offers for a run of `signal`, from its input's and its
 * output's documents (readInputDocuments, readOutputDocuments), in the
 * keys' order; each one's key and value written as OTTL.
 */
export function detectRuleCandidates(input: readonly unknown[], output: readonly unknown[], signal: TestRunSignal): RuleCandidate[] {
  const stats = new Map<string, KeyStats>();
  const inputRecords = tally(input, signal, stats, "input");
  const outputRecords = tally(output, signal, stats, "output");
  if (inputRecords === 0 || outputRecords === 0) return [];

  const candidates: RuleCandidate[] = [];
  for (const [key, entry] of stats) {
    const change = changeOf(key, entry, inputRecords, outputRecords);
    if (change === null) continue;
    const prefill = candidatePrefill(change);
    if (prefill !== null) candidates.push({ kind: change.kind, key, ...prefill });
  }
  return candidates;
}

/** detectRuleCandidates over the decoded input's and the stored output's text. */
export function detectRuleCandidatesInText(inputText: string, outputText: string, signal: TestRunSignal): RuleCandidate[] {
  return detectRuleCandidates(readInputDocuments(inputText), readOutputDocuments(outputText), signal);
}
