import type { OttlContext, OttlQuantifier, TestRunSignal, ValidationRuleCount, ValidationRuleOttl } from "@telflo/contracts";

/*
 * The canonical OTTL shapes the rule editor's builder modes (Record count,
 * Record attribute) save, and their recognition when a rule is edited, so a
 * builder's rule reopens in its builder, byte for byte.
 *
 * These exact strings are load-bearing two ways here: the ottl-evaluator runs
 * them, and recognizeBuilderShapes parses them back into the builder's
 * fields. Change them only in lockstep.
 *
 * The types are the platform's contracts' (`ValidationRuleOttl`,
 * `ValidationRuleCount`); the builder's scope and operator are this file's
 * own; the editor recognizes a rule through recognizeBuilderRule, which also
 * checks its context.
 *
 * The string escaping is ottlStringLiteral's. Escaping only `\` and `"` would
 * put a control character into the literal raw, and writing numbers with
 * `String` would give `NaN`, `1e+21`, a double 5.0 as `5`; Compare's prefill
 * writes its values with this file's number writers. An unescape turning every
 * `\x` into `x` would reopen a builder's `attributes["a\nb"]` with the key
 * `anb`, and a plain Save would rewrite the condition: unescapeOttlString
 * decodes exactly the escapes the writer writes, and recognition answers null
 * (OTTL mode, the rule as written) on any other.
 */

/** Where the attribute builder looks: the resource's, the scope's, or each record's attributes. */
export type AttributeScope = "resource" | "scope" | "record";

/** The attribute builder's comparisons. */
export type AttributeOperator = "exists" | "equals" | "contains" | "matches_regex" | "gt" | "gte" | "lt" | "lte";

/*
 * What an OTTL string literal escapes: `\`, `"`, and every character that
 * is invisible or breaks a line: the C0 controls, DEL, the C1 controls
 * (U+0080-U+009F), and U+2028 and U+2029. OTTL unquotes as Go does
 * (strconv.UnquoteChar), so `\n`, `\r`, `\t` and `\uXXXX` all read back as
 * the character. Backspace is `\u0008`, never `\b`: the evaluator refuses a
 * single-escaped `\b` in OTTL (pkg/ottlassert/escapes.go).
 */
function ottlEscaped(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0x5c || code === 0x22;
}

function ottlEscape(code: number): string {
  switch (code) {
    case 0x5c:
      return "\\\\";
    case 0x22:
      return '\\"';
    case 0x0a:
      return "\\n";
    case 0x0d:
      return "\\r";
    case 0x09:
      return "\\t";
    default:
      return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

/** A lone surrogate: a UTF-16 code unit that isn't half of a pair. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether `value` is well-formed UTF-16 (no lone surrogate), so it can travel as UTF-8 to the evaluator unchanged. */
export function isWellFormedText(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/**
 * `value` escaped for the inside of an OTTL string literal (the builders'
 * keys and values). A lone surrogate stays as it is: no escape writes it
 * (OTTL refuses `\ud800`), so ottlStringLiteral, which Compare's prefill
 * writes with, answers null for it instead.
 */
export function escapeOttlString(value: string): string {
  let escaped = "";
  let from = 0;
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (!ottlEscaped(code)) continue;
    escaped += value.slice(from, at) + ottlEscape(code);
    from = at + 1;
  }
  return from === 0 ? value : escaped + value.slice(from);
}

/**
 * `value` as an OTTL string literal, quoted and escaped; null when it isn't
 * well-formed UTF-16, which no literal can carry.
 */
export function ottlStringLiteral(value: string): string | null {
  return isWellFormedText(value) ? `"${escapeOttlString(value)}"` : null;
}

/** The decodings unescapeOttlString knows, each the writer's own. */
const OTTL_UNESCAPED: Readonly<Record<string, string>> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" };

/**
 * The inside of an OTTL string literal decoded: exactly `\\`, `\"`, `\n`,
 * `\r`, `\t` and `\uXXXX`. Null on any other escape (`\b`, `\x41`, an octal,
 * …), which OTTL would read but the builder can't write back as it was, and
 * on a decoding that isn't well-formed UTF-16: recognition then answers
 * null, and the rule opens in OTTL mode as written.
 */
export function unescapeOttlString(value: string): string | null {
  let decoded = "";
  let from = 0;
  for (let at = value.indexOf("\\"); at !== -1; at = value.indexOf("\\", from)) {
    decoded += value.slice(from, at);
    const escaped = value[at + 1] ?? "";
    if (Object.hasOwn(OTTL_UNESCAPED, escaped)) {
      decoded += OTTL_UNESCAPED[escaped] ?? "";
      from = at + 2;
    } else if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(value.slice(at + 2, at + 6))) {
      decoded += String.fromCharCode(Number.parseInt(value.slice(at + 2, at + 6), 16));
      from = at + 6;
    } else {
      return null;
    }
  }
  decoded += value.slice(from);
  return isWellFormedText(decoded) ? decoded : null;
}

/** Escape regex metacharacters so IsMatch's unanchored regex match degrades to a plain substring match (the builder's "contains" operator). */
export function escapeRegexChars(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/** OTTL's largest integer; its parser reads `-9223372036854775808` as a minus and an integer one past it. */
const OTTL_INT_MAX = 9223372036854775807n;

/**
 * An integer as an OTTL literal: its digits, exactly, for anything from
 * -9223372036854775807 to 9223372036854775807; null otherwise
 * (-9223372036854775808 included, which OTTL can't parse).
 */
export function ottlIntegerLiteral(value: bigint): string | null {
  return value >= -OTTL_INT_MAX && value <= OTTL_INT_MAX ? value.toString() : null;
}

/**
 * A double as an OTTL literal, always with its decimal point so OTTL reads a
 * float: an integral value below 1e21 gets `.0` (`5.0`; -0 is `0.0`), any
 * other is `String(v)` with an exponent expanded to plain decimals (OTTL's
 * lexer reads neither `5e0` nor `1e21`), the shortest digits that read back
 * as `value`. Null for NaN and ±Infinity, which OTTL has no literal for.
 */
export function ottlDoubleLiteral(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return `${String(value)}.0`;
  const plain = plainDecimal(String(value));
  return plain.includes(".") ? plain : `${plain}.0`;
}

/** `String(number)`'s exponent form (`1.5e+300`, `1e-7`) as plain decimals; any other text as it is. */
function plainDecimal(text: string): string {
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const [, sign = "", first = "", rest = "", exponent = "0"] = match;
  const digits = first + rest;
  const point = 1 + Number(exponent);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Record-level OTTL context for a pipeline signal. */
export function recordContextForSignal(signal: TestRunSignal | undefined): OttlContext {
  if (signal === "traces") return "span";
  if (signal === "logs") return "log";
  return "datapoint";
}

/** Build the canonical attribute condition the Attribute builder emits. */
export function buildAttributeCondition(key: string, operator: AttributeOperator, value: string): string {
  const k = `attributes["${escapeOttlString(key)}"]`;
  switch (operator) {
    case "exists":
      return `${k} != nil`;
    case "equals":
      return `${k} == "${escapeOttlString(value)}"`;
    case "contains":
      return `${k} != nil and IsMatch(${k}, "${escapeOttlString(escapeRegexChars(value))}")`;
    case "matches_regex":
      return `${k} != nil and IsMatch(${k}, "${escapeOttlString(value)}")`;
    case "gt":
      return `${k} != nil and ${k} > ${Number(value)}`;
    case "gte":
      return `${k} != nil and ${k} >= ${Number(value)}`;
    case "lt":
      return `${k} != nil and ${k} < ${Number(value)}`;
    default:
      return `${k} != nil and ${k} <= ${Number(value)}`;
  }
}

const ATTR_KEY = String.raw`attributes\["((?:[^"\\]|\\.)*)"\]`;
const STRING_LIT = String.raw`"((?:[^"\\]|\\.)*)"`;
const RE_EXISTS = new RegExp(`^${ATTR_KEY} != nil$`);
const RE_EQUALS = new RegExp(`^${ATTR_KEY} == ${STRING_LIT}$`);
const RE_NUMERIC = new RegExp(String.raw`^${ATTR_KEY} != nil and ${ATTR_KEY} (>=|<=|>|<) (-?\d+(?:\.\d+)?)$`);
const RE_ISMATCH = new RegExp(String.raw`^${ATTR_KEY} != nil and IsMatch\(${ATTR_KEY}, ${STRING_LIT}\)$`);
const RE_BARE_ATTR = new RegExp(`^${ATTR_KEY}$`);

export type RecognizedBuilder =
  | { mode: "record_count"; count: ValidationRuleCount }
  | {
      mode: "record_attribute";
      quantifier: OttlQuantifier;
      scope: AttributeScope;
      key: string;
      operator: AttributeOperator;
      value: string;
      count?: ValidationRuleCount | undefined;
    };

function scopeFromContext(context: OttlContext): AttributeScope {
  if (context === "resource" || context === "scope") return context;
  return "record";
}

/**
 * Recognize an ottl rule whose payload matches a builder-canonical shape so
 * it reopens in the friendly form instead of the raw OTTL textarea. Anything
 * unrecognized (composed conditions, row-filtered distinct, ne-count record
 * totals) opens in OTTL mode — the builder is one-way sugar beyond its own
 * grammar. So does a key or value holding an escape the builder doesn't
 * write (unescapeOttlString's null).
 */
export function recognizeBuilderShapes(o: ValidationRuleOttl): RecognizedBuilder | null {
  const condition = (o.condition ?? "").trim();
  if (o.quantifier === "count" && condition === "true" && o.count && o.count.operator !== "ne" && !o.expression) {
    return { mode: "record_count", count: o.count };
  }
  if (o.quantifier === "distinct") {
    const m = RE_BARE_ATTR.exec((o.expression ?? "").trim());
    if (!m || condition || !o.count) return null;
    const key = unescapeOttlString(m[1] ?? "");
    if (key === null) return null;
    return {
      mode: "record_attribute",
      quantifier: "distinct",
      scope: scopeFromContext(o.context),
      key,
      operator: "exists",
      value: "",
      count: o.count,
    };
  }
  if (o.quantifier === "count" && !o.count) return null;
  let match = RE_EXISTS.exec(condition);
  if (match) {
    const key = unescapeOttlString(match[1] ?? "");
    if (key === null) return null;
    return {
      mode: "record_attribute",
      quantifier: o.quantifier,
      scope: scopeFromContext(o.context),
      key,
      operator: "exists",
      value: "",
      count: o.count,
    };
  }
  match = RE_EQUALS.exec(condition);
  if (match) {
    const key = unescapeOttlString(match[1] ?? "");
    const value = unescapeOttlString(match[2] ?? "");
    if (key === null || value === null) return null;
    return {
      mode: "record_attribute",
      quantifier: o.quantifier,
      scope: scopeFromContext(o.context),
      key,
      operator: "equals",
      value,
      count: o.count,
    };
  }
  match = RE_NUMERIC.exec(condition);
  if (match && match[1] === match[2]) {
    const op = match[3] === ">" ? "gt" : match[3] === ">=" ? "gte" : match[3] === "<" ? "lt" : "lte";
    const key = unescapeOttlString(match[1] ?? "");
    if (key === null) return null;
    return {
      mode: "record_attribute",
      quantifier: o.quantifier,
      scope: scopeFromContext(o.context),
      key,
      operator: op,
      value: match[4] ?? "",
      count: o.count,
    };
  }
  match = RE_ISMATCH.exec(condition);
  if (match && match[1] === match[2]) {
    // "contains" and "matches_regex" are indistinguishable after regex
    // escaping; reopen as matches_regex — semantically identical.
    const key = unescapeOttlString(match[1] ?? "");
    const value = unescapeOttlString(match[3] ?? "");
    if (key === null || value === null) return null;
    return {
      mode: "record_attribute",
      quantifier: o.quantifier,
      scope: scopeFromContext(o.context),
      key,
      operator: "matches_regex",
      value,
      count: o.count,
    };
  }
  return null;
}

/**
 * The context a recognized builder saves a rule on, on a `signal` pipeline:
 * Record count the signal's record context; Record attribute its scope's
 * (resource, scope), else the record context.
 */
function builderContext(recognized: RecognizedBuilder, signal: TestRunSignal): OttlContext {
  if (recognized.mode === "record_attribute" && recognized.scope !== "record") return recognized.scope;
  return recordContextForSignal(signal);
}

/**
 * recognizeBuilderShapes for a rule of a `signal` pipeline: a builder's shape
 * only when that builder would save the rule on its stored context, so a
 * rule's context never changes silently. Otherwise null, and the rule opens
 * in OTTL mode, its context kept: a traces `spanevent` rule, a metrics
 * `metric` one, a count of `resource`s. Otherwise the builder's Save would
 * rewrite the context (spanevent to span, metric to datapoint, resource to
 * the record context).
 */
export function recognizeBuilderRule(o: ValidationRuleOttl, signal: TestRunSignal): RecognizedBuilder | null {
  const recognized = recognizeBuilderShapes(o);
  return recognized !== null && builderContext(recognized, signal) === o.context ? recognized : null;
}
