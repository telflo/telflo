import { CST, Document, isAlias, isMap, isNode, isPair, isScalar, isSeq, parseDocument, visit } from "yaml";
import type { Alias, Node as YamlNode, Pair, Scalar, YAMLMap, YAMLSeq } from "yaml";

import { collectorReadsAsOther } from "./collector-scalars.js";
import { readTextModel } from "./model.js";
import type { Model, PipelineLists } from "./model.js";
import { COMPONENT_SECTIONS, isPlainObject, PARSE_OPTIONS } from "./parse.js";
import type { ParsedText } from "./parse.js";
import { nodeAt, stringKeysOnly } from "./value-view.js";

/*
 * Canvas changes are targeted edits of the text. The YAML text is the content:
 * a change on the canvas is written into it in place, and nothing else in it
 * moves.
 *
 * `editText(text, textModel, after)` compares the configuration the
 * text describes now (`textModel`, from `readTextModel`) with the one the
 * graph describes after the change (`after`, from `deriveModel`) and writes
 * only their differences, each one a splice into the source:
 * - a changed scalar goes through `CST.setScalarValue` on its own source
 *   token, so its quoting and its comment stay; a renamed key likewise;
 * - an entry is inserted or removed by its lines: its key's line, its
 *   value's lines, and comment lines indented inside it (never the comment
 *   lines above it, nor the next entry's);
 * - a changed list is replaced where it stands, in its own flow or block
 *   style, keeping the items (and their comments) that stay;
 * - only new fragments are printed: scalars by `yaml`'s own printer, laid
 *   out like their siblings (the text's indentation unit, its sequence
 *   indentation, its line ending).
 * The text is parsed again after every splice, and the document is never
 * printed whole: a reprint rewrites what the edit didn't touch (`0750`
 * becomes `750`, big integers lose digits, folded blocks are joined, CRLF
 * becomes LF).
 *
 * Aliases and merge keys: a changed value under a key a map gets
 * only from a merge is written after copying that key's whole value onto
 * the map; an alias on the path to a change, or as the whole value, is
 * replaced by a copy first; before an anchor's owner changes or goes, each
 * alias of it gets its own copy (a merge of it is expanded into the map's
 * own keys); a value with nothing in it becomes a mapping when a key is set
 * in it. Copies are taken from the source text, so they keep `0750` too.
 *
 * What can't be written as a splice fails loudly with a `TextEditError`
 * (a block value that would have to go inside a flow collection, an alias
 * used as a key, a block scalar with an indentation indicator to copy);
 * nothing ever falls back to printing the whole document. The result is
 * checked: its own model must be `after`, or the edit throws.
 *
 * A form's changes go through the same editor by key path:
 * `writeValues(text, base, changes)` sets, removes, moves or renames what each
 * path under `base` addresses, where a number is a list item. An item's field
 * is changed where it stands; an item is added, removed or moved by its own
 * lines (a move never reprints it: `replaceList` would turn `0750` into
 * `750`); a key is renamed in place; a missing key is added under the deepest
 * one that exists. Each change is checked as it reads back, and everything
 * outside `base` must read the same before and after.
 *
 * A new string with a line break is a literal block only when the block
 * carries it cleanly, and is written double-quoted otherwise (`"\n"`,
 * rather than a `|+` block that takes the blank lines after it, or a
 * refusal), and again double-quoted when its block doesn't read back as
 * written; a `plain` change writes numbers, booleans and one-line flow
 * collections as typed (`plainValue`).
 *
 * Errors never quote the text, a key or a value (the content is private).
 */

export class TextEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextEditError";
  }
}

/** A component renamed on the canvas (its instance name): keys, `receivers.otlp` → `receivers.otlp/2`. */
export interface ComponentRename {
  from: string;
  to: string;
}

export interface GraphChangeOptions {
  /** Renames to write in place (the key, and every pipeline list and `service.extensions` entry naming it). */
  renames?: readonly ComponentRename[];
  /** Check that the edited text describes `after` (default true). */
  verify?: boolean;
  /**
   * The text's document, when the caller has it (`parse(text).document`),
   * so it isn't parsed again. It must be the parse of `text` with
   * `PARSE_OPTIONS`; the edits never change it.
   */
  document?: ParsedText;
}

const PIPELINE_LISTS = ["receivers", "processors", "exporters"] as const;
type PipelineList = (typeof PIPELINE_LISTS)[number];

/** Top-level sections in their conventional order; a missing one is added before the first later one. */
const SECTION_ORDER: readonly string[] = [...COMPONENT_SECTIONS, "service"];

const MAXIMUM_ALIAS_COUNT = 100;
const MAXIMUM_FIXES = 1000;

/**
 * A key path under a component's (or telemetry's) value: mapping keys, and
 * numbers for list items (`["attributes", 2, "value"]`).
 */
export type ValuePath = readonly (string | number)[];

/**
 * One change a form makes:
 * - `value`: sets what `path` addresses; index `length` appends;
 * - `plain`: sets it to characters as they were typed, written verbatim once
 *   they read back alone, in a block and in a flow collection, as a number
 *   (`1e3`, `0x1F`, `0750`), a boolean (`True`), or a one-line flow mapping
 *   or sequence (`{"k": "v"}`, `[1, a]`) with no comment, anchor, alias or
 *   tag (`plainValue`), refused otherwise (the add operator's value, as
 *   typed; its own kind, so a mapping `{ plain: "5" }` set as a value is
 *   written as a mapping);
 * - `remove`: removes the key or the item, by its own lines;
 * - `moveTo`: moves list item `path` to that index, its lines as written;
 * - `renameTo`: renames the mapping key `path` in place; a clash is refused.
 */
export type ValueChange =
  | { path: ValuePath; value: unknown }
  | { path: ValuePath; plain: string }
  | { path: ValuePath; remove: true }
  | { path: ValuePath; moveTo: number }
  | { path: ValuePath; renameTo: string };

type Path = ValuePath;

/** A `plain` change's characters, checked, for the printers: written as they are. */
class PlainScalar {
  constructor(readonly source: string) {}

  /** Whether the characters are a flow mapping or sequence, which `yaml`'s scalar printer would quote. */
  get isCollection(): boolean {
    return this.source.startsWith("{") || this.source.startsWith("[");
  }
}

/**
 * A value's text, laid out for a key: `head` goes on the key's line after
 * `key: `; `lines` follow, indented relative to the key's column (a nested
 * mapping's lines already carry one indentation unit).
 */
interface Fragment {
  head: string;
  lines: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

type Ancestors = ReadonlyArray<Document | YamlNode | Pair>;

// ── Values ─────────────────────────────────────────────────────────────────

/**
 * Deep equality of values as the text's model reads them (NaN equals NaN),
 * with what YAML's own tags read as: a `!!timestamp`'s Date by its time, a
 * `!!binary`'s bytes, and a `!!set`'s Set or an `!!omap`'s Map by their
 * entries in the order the text gives them.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => valuesEqual(item, b[index]));
  }
  // By their tags, not `instanceof`: the yaml library's Buffer can be another realm's (a test's jsdom).
  const tag = builtinTag(a);
  if (tag !== undefined || builtinTag(b) !== undefined) {
    if (tag !== builtinTag(b)) return false;
    if (tag === "Date") return Object.is((a as Date).getTime(), (b as Date).getTime());
    if (tag === "Uint8Array") {
      const [x, y] = [a as Uint8Array, b as Uint8Array];
      return x.length === y.length && x.every((byte, index) => byte === y[index]);
    }
    return valuesEqual([...(a as Map<unknown, unknown> | Set<unknown>).entries()], [...(b as Map<unknown, unknown> | Set<unknown>).entries()]);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && valuesEqual(a[key], b[key]));
  }
  return false;
}

/** What a `!!timestamp`, `!!binary` (a Buffer too), `!!set` or `!!omap` reads as, by its tag; undefined for anything else. */
function builtinTag(value: unknown): "Date" | "Uint8Array" | "Map" | "Set" | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return tag === "Date" || tag === "Uint8Array" || tag === "Map" || tag === "Set" ? tag : undefined;
}

/** A value as the text can hold it: `undefined` keys dropped, `undefined` items `null`. */
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalized(item)));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = normalized(item);
    return out;
  }
  return value === undefined ? null : value;
}

/** The column after `indent` (spaces and tabs), a tab reaching the next multiple of 8. */
function columnAfter(indent: string): number {
  let column = 0;
  for (const char of indent) column = char === "\t" ? (Math.floor(column / 8) + 1) * 8 : column + 1;
  return column;
}

function listsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** The section and the name in a component key: `receivers`, `otlp/2`. */
export function splitKey(key: string): [string, string] {
  const dot = key.indexOf(".");
  if (dot === -1) throw new TextEditError("A component key has no section.");
  return [key.slice(0, dot), key.slice(dot + 1)];
}

/** Whether two models describe the same configuration (the undeclared set follows from the rest). */
export function modelsEqual(a: Model, b: Model): boolean {
  if (a.components.size !== b.components.size) return false;
  for (const [key, value] of a.components) {
    if (!b.components.has(key) || !valuesEqual(value, b.components.get(key))) return false;
  }
  if (a.pipelines.size !== b.pipelines.size) return false;
  for (const [name, lists] of a.pipelines) {
    const other = b.pipelines.get(name);
    if (!other || !PIPELINE_LISTS.every((list) => listsEqual(lists[list], other[list]))) return false;
  }
  return listsEqual(a.extensions, b.extensions);
}

/** A list edit's steps, in order: keep an old item, delete one, or insert a new value. */
export type Step = { kind: "keep"; index: number } | { kind: "delete"; index: number } | { kind: "insert"; value: unknown };

/** The work a list diff did: table cells built, and items diffed without a table. */
export interface ListDiffStats {
  cells: number;
  fallbackItems: number;
}

/** Past this many cells (2,000 × 2,000), the middle of a list diff is diffed without a table. */
const MAXIMUM_TABLE_CELLS = 4_000_000;

/** A value's identity for the diff: equal (`valuesEqual`) values get the same key. */
function valueKey(value: unknown): string {
  if (typeof value === "number") return Number.isNaN(value) ? "n:NaN" : `n:${value === 0 ? 0 : value}`;
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (Array.isArray(value)) return `a:[${value.map(valueKey).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `o:{${keys.map((key) => `${JSON.stringify(key)}:${valueKey(value[key])}`).join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

/** Exact LCS of the middles by a table: `(m + 1) × (n + 1)` cells. */
function tableSteps(a: readonly unknown[], b: readonly unknown[], offset: number, stats: ListDiffStats): Step[] {
  const columns = b.length + 1;
  const table = new Int32Array((a.length + 1) * columns);
  stats.cells += table.length;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * columns + j] = valuesEqual(a[i], b[j])
        ? table[(i + 1) * columns + j + 1]! + 1
        : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
    }
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && valuesEqual(a[i], b[j])) {
      steps.push({ kind: "keep", index: offset + i });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!)) {
      steps.push({ kind: "delete", index: offset + i });
      i++;
    } else {
      steps.push({ kind: "insert", value: b[j] });
      j++;
    }
  }
  return steps;
}

/**
 * The middles diffed without a table, in O(n log n): matched pairs are the
 * longest increasing run of new positions when the new items are unique (an
 * exact LCS then; a pipeline's names always are), else a greedy in-order
 * match (correct, not always minimal).
 */
function linearSteps(a: readonly unknown[], b: readonly unknown[], offset: number, stats: ListDiffStats): Step[] {
  stats.fallbackItems += a.length + b.length;
  const positions = new Map<string, number[]>();
  b.forEach((value, index) => {
    const key = valueKey(value);
    const list = positions.get(key);
    if (list) list.push(index);
    else positions.set(key, [index]);
  });
  const unique = [...positions.values()].every((list) => list.length === 1);

  const matches: Array<[number, number]> = [];
  if (unique) {
    // Longest strictly increasing subsequence of the new positions, in the old order.
    const targets = a.map((value) => positions.get(valueKey(value))?.[0] ?? -1);
    const tails: number[] = [];
    const previous = new Int32Array(a.length).fill(-1);
    for (let i = 0; i < a.length; i++) {
      const target = targets[i]!;
      if (target < 0) continue;
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (targets[tails[middle]!]! < target) low = middle + 1;
        else high = middle;
      }
      if (low > 0) previous[i] = tails[low - 1]!;
      tails[low] = i;
    }
    for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0; i = previous[i]!) {
      matches.push([i, targets[i]!]);
    }
    matches.reverse();
  } else {
    const next = new Map<string, number>();
    let j = 0;
    a.forEach((value, i) => {
      const key = valueKey(value);
      const list = positions.get(key);
      if (!list) return;
      let at = next.get(key) ?? 0;
      while (at < list.length && list[at]! < j) at++;
      next.set(key, at);
      if (at === list.length) return;
      matches.push([i, list[at]!]);
      next.set(key, at + 1);
      j = list[at]! + 1;
    });
  }

  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  for (const [matchA, matchB] of [...matches, [a.length, b.length] as [number, number]]) {
    for (; i < matchA; i++) steps.push({ kind: "delete", index: offset + i });
    for (; j < matchB; j++) steps.push({ kind: "insert", value: b[j] });
    if (matchA < a.length) steps.push({ kind: "keep", index: offset + matchA });
    i = matchA + 1;
    j = matchB + 1;
  }
  return steps;
}

/**
 * The steps from list `a` to list `b`, keeping as many items as it can. The
 * common prefix and suffix are kept without a table, so a one-item change
 * to a long list costs linear time; only the differing middle is diffed
 * (by a table when small, else without one).
 */
export function listSteps(
  a: readonly unknown[],
  b: readonly unknown[],
  stats: ListDiffStats = { cells: 0, fallbackItems: 0 },
): Step[] {
  let start = 0;
  while (start < a.length && start < b.length && valuesEqual(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && valuesEqual(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const steps: Step[] = [];
  for (let i = 0; i < start; i++) steps.push({ kind: "keep", index: i });
  if (middleA.length === 0) {
    for (const value of middleB) steps.push({ kind: "insert", value });
  } else if (middleB.length === 0) {
    for (let i = start; i < endA; i++) steps.push({ kind: "delete", index: i });
  } else if ((middleA.length + 1) * (middleB.length + 1) <= MAXIMUM_TABLE_CELLS) {
    steps.push(...tableSteps(middleA, middleB, start, stats));
  } else {
    steps.push(...linearSteps(middleA, middleB, start, stats));
  }
  for (let i = endA; i < a.length; i++) steps.push({ kind: "keep", index: i });
  return steps;
}

// ── Text helpers ───────────────────────────────────────────────────────────

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

function indentLine(line: string, by: number): string {
  return line === "" ? "" : " ".repeat(by) + line;
}

/** A line moved from indentation `from` to `to` (a blank line stays blank). */
function rebase(line: string, from: number, to: number): string {
  if (line.trim() === "") return "";
  const indent = indentOf(line);
  return " ".repeat(Math.max(0, indent - from + to)) + line.slice(indent);
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The comment in a stretch of text holding no scalar (after a value, or props): `# c`. */
function commentIn(segment: string): string {
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === "#" && (i === 0 || /\s/.test(segment[i - 1]!))) return segment.slice(i).trimEnd();
  }
  return "";
}

function detectEol(text: string): string {
  const newline = text.indexOf("\n");
  return newline > 0 && text[newline - 1] === "\r" ? "\r\n" : "\n";
}

/** A scalar's plain source: `42`, `true`, `null`, `.nan`, `-.inf`. */
function plainSource(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (!Number.isFinite(value)) return value > 0 ? ".inf" : "-.inf";
    return String(value);
  }
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "null";
}

function isScalarValue(value: unknown): boolean {
  return value === null || value instanceof PlainScalar || ["string", "number", "boolean", "bigint"].includes(typeof value);
}

const plainChecks = new Map<string, boolean>();

/** A block sequence token's items without its comment-only ones (`TextEditor.sourceItems`). */
const sourceItemsOf = new WeakMap<CST.BlockSequence, CST.BlockSequence["items"]>();

/** Whether `text` reads back as exactly that string when written plain in `context`. */
function plainSafe(text: string, context: "block" | "flow" | "key" | "flowKey"): boolean {
  // A control character (C0, DEL, C1) is never plain: `yaml` reads it, yaml.v3 refuses it.
  // eslint-disable-next-line no-control-regex
  if (text === "" || /[\x00-\x1f\x7f-\x9f]/.test(text) || text !== text.trim()) return false;
  // Characters the collector (yaml.v3) reads as another type are never a plain string: `1_000`, `2024-01-01`.
  if (collectorReadsAsOther(text)) return false;
  const cacheKey = `${context}\u0000${text}`;
  const cached = plainChecks.get(cacheKey);
  if (cached !== undefined) return cached;
  const probe = {
    block: `k: ${text}\n`,
    flow: `[${text}]\n`,
    key: `${text}: 1\n`,
    flowKey: `{${text}: 1}\n`,
  }[context];
  let safe = false;
  const document = parseDocument(probe, { prettyErrors: false });
  if (document.errors.length === 0) {
    const contents = document.contents;
    const only = isMap(contents) && contents.items.length === 1 ? contents.items[0] : undefined;
    if (context === "block") safe = isScalar(only?.value) && only.value.value === text;
    else if (context === "flow") {
      const item = isSeq(contents) && contents.items.length === 1 ? contents.items[0] : undefined;
      safe = isScalar(item) && item.value === text;
    } else safe = isScalar(only?.key) && only.key.value === text;
  }
  plainChecks.set(cacheKey, safe);
  return safe;
}

/**
 * Whether a literal block (`|`, `|-`) carries a string with a line break
 * cleanly: it has a line with something on it other than spaces and tabs,
 * and no line starts or ends with a space or a tab (the block would need
 * an indentation indicator, or keep invisible trailing spaces), and no
 * carriage return or other control character but a tab. Anything else is
 * written double-quoted.
 */
function blockCarries(value: string): boolean {
  // A carriage return or another control character (a tab inside a line aside) needs an escape.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value)) return false;
  const lines = value.replace(/\n$/, "").split("\n");
  return lines.some((line) => line.trim() !== "") && lines.every((line) => !/^[ \t]|[ \t]$/.test(line));
}

/**
 * DEL and the C1 controls (0x7f-0x9f) in a double-quoted scalar's source,
 * escaped (`\x7f`): JSON's and `yaml`'s printers leave them raw, which
 * yaml.v3 (the collector's reader) refuses. Nothing else in
 * the source changes: a raw one is never part of an escape.
 */
function escapeRaw(doubleQuoted: string): string {
  return doubleQuoted.replace(/[\x7f-\x9f]/g, (raw) => `\\x${raw.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** A string double-quoted: JSON's escapes, which YAML's double quotes read the same, and `escapeRaw`'s. */
function quoteDouble(value: string): string {
  return escapeRaw(JSON.stringify(value));
}

/** A key as a block mapping writes it. */
function keyText(key: string, flow: boolean): string {
  return plainSafe(key, flow ? "flowKey" : "key") ? key : quoteDouble(key);
}

/** A value on one line, inside a flow collection. */
function flowText(value: unknown): string {
  if (value instanceof PlainScalar) return value.source;
  if (Array.isArray(value)) return `[${value.map(flowText).join(", ")}]`;
  if (isPlainObject(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${keyText(key, true)}: ${flowText(item)}`)
      .join(", ")}}`;
  }
  if (typeof value === "string") return plainSafe(value, "flow") ? value : quoteDouble(value);
  return plainSource(value);
}

/** Why a key-less value can't be copied or placed. */
function notExpressible(what: string): never {
  throw new TextEditError(`This edit can't be written as a splice: ${what}.`);
}

// ── The editor ─────────────────────────────────────────────────────────────

interface AliasUse {
  alias: Alias;
  ancestors: Ancestors;
}

/** How many of `entries` have each key, those without one (undefined) left out. */
function tally<T>(entries: readonly T[], key: (entry: T) => string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const k = key(entry);
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Ranges sorted, the overlapping and touching ones joined. */
function mergedRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

class TextEditor {
  text: string;
  document!: ParsedText;
  readonly eol: string;
  readonly unit: number;
  readonly indentSeq: boolean;
  /** Every new string with a line break is double-quoted, never a block (`scalarFragment`). */
  quoteBreaks = false;
  private lineStarts: number[] = [];
  private aliasUses: AliasUse[] | undefined;

  constructor(text: string, document?: ParsedText) {
    this.text = text;
    this.eol = detectEol(text);
    if (document && document.errors.length === 0) this.useDocument(document);
    else this.reparse();
    const style = this.detectStyle();
    this.unit = style.unit;
    this.indentSeq = style.indentSeq;
  }

  // ── Parsing and splicing ──

  /**
   * Parses the text again after a splice. `yaml`'s own duplicate-key check
   * compares every key with every other (221 ms for a section of 6,000
   * components), so this parse checks keys itself, with a set per mapping.
   * An alias with no anchor before it (a list item moved above its anchor)
   * parses without an error, so it is looked for here too, in text order.
   */
  private reparse(): void {
    const document = parseDocument(this.text, { ...PARSE_OPTIONS, uniqueKeys: false }) as ParsedText;
    if (document.errors.length > 0) {
      throw new TextEditError(`An edit left text that doesn't read (${document.errors[0]!.code}).`);
    }
    const anchors = new Set<string>();
    const hasAliases = this.text.includes("*");
    const noteAnchor = (node: YamlNode) => {
      if (hasAliases && node.anchor) anchors.add(node.anchor);
    };
    visit(document, {
      Alias: (_key, alias) => {
        if (!anchors.has(alias.source)) throw new TextEditError("An edit left an alias before its anchor.");
      },
      Scalar: (_key, scalar) => noteAnchor(scalar),
      Seq: (_key, seq) => noteAnchor(seq),
      Map: (_key, map) => {
        noteAnchor(map);
        const seen = new Set<string>();
        for (const pair of map.items) {
          const value = isScalar(pair.key) ? pair.key.value : undefined;
          const key = value === undefined || typeof value === "symbol" ? undefined : `${typeof value}:${String(value)}`;
          if (key === undefined) continue;
          if (seen.has(key)) throw new TextEditError("An edit left a duplicate key.");
          seen.add(key);
        }
      },
    });
    this.useDocument(document);
  }

  private useDocument(document: ParsedText): void {
    this.document = document;
    this.aliasUses = undefined;
    this.lineStarts = [0];
    for (let i = 0; i < this.text.length; i++) if (this.text[i] === "\n") this.lineStarts.push(i + 1);
  }

  /** Applies non-overlapping splices, from the end back, then parses the text again. */
  apply(edits: readonly Edit[]): void {
    if (edits.length === 0) return;
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let text = this.text;
    let limit = Infinity;
    for (const edit of sorted) {
      if (edit.end > limit || edit.start > edit.end) throw new TextEditError("Two splices overlap.");
      text = text.slice(0, edit.start) + edit.text.replace(/\r?\n/g, this.eol) + text.slice(edit.end);
      limit = edit.start;
    }
    this.text = text;
    this.reparse();
  }

  /** The text and its parse as they are now, for `restore`. */
  save(): { text: string; document: ParsedText } {
    return { text: this.text, document: this.document };
  }

  /** Back to a text and parse `save` gave, dropping every splice since. */
  restore(saved: { text: string; document: ParsedText }): void {
    this.text = saved.text;
    this.useDocument(saved.document);
  }

  private detectStyle(): { unit: number; indentSeq: boolean } {
    let unit: number | undefined;
    let indentSeq: boolean | undefined;
    visit(this.document, {
      Pair: (_key, pair) => {
        const key = pair.key;
        const value = pair.value;
        if (!isNode(key) || !key.range || !isNode(value) || !value.range) return undefined;
        const keyColumn = indentOf(this.lineText(this.lineOf(key.range[0])));
        if (unit === undefined && isMap(value) && !value.flow && value.items.length > 0) {
          const step = this.column(value.range[0]) - keyColumn;
          if (step > 0) unit = step;
        }
        if (indentSeq === undefined && isSeq(value) && !value.flow && value.items.length > 0) {
          indentSeq = this.column(value.range[0]) > keyColumn;
        }
        return unit !== undefined && indentSeq !== undefined ? visit.BREAK : undefined;
      },
    });
    return { unit: unit ?? 2, indentSeq: indentSeq ?? true };
  }

  // ── Lines ──

  private get lineCount(): number {
    return this.lineStarts.length;
  }

  lineOf(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  lineStart(line: number): number {
    return this.lineStarts[line]!;
  }

  /** Where a line's content ends, before its line break. */
  lineContentEnd(line: number): number {
    if (line + 1 >= this.lineStarts.length) return this.text.length;
    let end = this.lineStarts[line + 1]! - 1;
    if (end > this.lineStarts[line]! && this.text[end - 1] === "\r") end--;
    return end;
  }

  lineText(line: number): string {
    return this.text.slice(this.lineStart(line), this.lineContentEnd(line));
  }

  column(offset: number): number {
    return offset - this.lineStart(this.lineOf(offset));
  }

  /**
   * The column a line's entry starts at: past its indentation and any `- `
   * indicators, so `      - key: a` gives the key's column, where the
   * item's other keys stand. Without a dash, the line's indentation.
   */
  private entryColumn(line: number): number {
    return /^ *(?:-[ \t]+)*/.exec(this.lineText(line))![0].length;
  }

  /** Whether a line's entry follows a `- ` indicator (the first key of a list item). */
  private dashed(line: number): boolean {
    return this.entryColumn(line) !== indentOf(this.lineText(line));
  }

  /** The line holding the last character before `end`. */
  private endLineOf(end: number): number {
    return this.lineOf(Math.max(end - 1, 0));
  }

  /** `line`, extended over the blank lines and the comment lines indented deeper than `column` that follow it. */
  private extendOverComments(line: number, column: number): number {
    let last = line;
    for (let next = line + 1; next < this.lineCount; next++) {
      const text = this.lineText(next);
      const trimmed = text.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("#") && indentOf(text) > column) {
        last = next;
        continue;
      }
      break;
    }
    return last;
  }

  /** The first of the comment lines directly above `line`, no deeper than `column`. */
  private attachedCommentsStart(line: number, column: number): number {
    let first = line;
    while (first > 0) {
      const above = this.lineText(first - 1);
      if (!above.trim().startsWith("#") || indentOf(above) > column) break;
      first--;
    }
    return first;
  }

  private deleteLines(first: number, last: number): Edit {
    if (last + 1 < this.lineCount) return { start: this.lineStart(first), end: this.lineStart(last + 1), text: "" };
    // The lines run to the end of a text with no final line break: take the break before them.
    const start = first > 0 ? this.lineContentEnd(first - 1) : 0;
    return { start, end: this.text.length, text: "" };
  }

  private insertAfterLine(line: number, lines: readonly string[]): Edit {
    if (line + 1 < this.lineCount) {
      const at = this.lineStart(line + 1);
      return { start: at, end: at, text: lines.join(this.eol) + this.eol };
    }
    const at = this.text.length;
    return { start: at, end: at, text: this.eol + lines.join(this.eol) };
  }

  private insertBeforeLine(line: number, lines: readonly string[]): Edit {
    const at = this.lineStart(line);
    return { start: at, end: at, text: lines.join(this.eol) + this.eol };
  }

  private appendToDocument(lines: readonly string[]): Edit {
    const at = this.text.length;
    if (at === 0 || this.text.endsWith("\n")) return { start: at, end: at, text: lines.join(this.eol) + this.eol };
    return { start: at, end: at, text: this.eol + lines.join(this.eol) };
  }

  // ── Nodes ──

  private rangeOf(node: YamlNode): [number, number] {
    const range = node.range;
    if (!range) throw new TextEditError("A node has no place in the text.");
    return [range[0], range[1]];
  }

  private isEmptyNode(node: unknown): boolean {
    if (!isNode(node)) return true;
    const [start, end] = this.rangeOf(node);
    return isScalar(node) && start === end;
  }

  private isBlockCollection(node: unknown): node is YAMLMap | YAMLSeq {
    return (isMap(node) || isSeq(node)) && !node.flow;
  }

  private isBlockScalar(node: unknown): boolean {
    return isScalar(node) && node.srcToken?.type === "block-scalar";
  }

  /**
   * Whether an empty flow collection (`[]`, `{}`) at `path` takes its first
   * entry in block style: not inside a flow collection (block can't go
   * there), with no anchor or tag to keep, and on one line. Anything else
   * keeps its own flow style.
   */
  private opensAsBlock(path: Path, node: YAMLMap | YAMLSeq): boolean {
    if (!node.flow || node.items.length > 0 || path.length === 0 || node.anchor || node.tag) return false;
    const parent = this.valueAt(path.slice(0, -1));
    if ((isMap(parent) || isSeq(parent)) && parent.flow) return false;
    const [start] = this.rangeOf(node);
    return this.lineOf(start) === this.endLineOf(this.contentEnd(node));
  }

  /** Where a node's content ends: its last character, ignoring the comments after it. */
  contentEnd(node: YamlNode): number {
    if (this.isBlockCollection(node)) {
      const items = node.items;
      const last = items[items.length - 1];
      if (last === undefined) return this.rangeOf(node)[0];
      if (isPair(last)) return this.pairContentEnd(last);
      if (this.isEmptyNode(last)) return this.dashOffset(node as YAMLSeq, items.length - 1) + 1;
      return this.contentEnd(last as YamlNode);
    }
    return this.rangeOf(node)[1];
  }

  private colonEnd(pair: Pair): number {
    const indicator = pair.srcToken?.sep?.find((token) => token.type === "map-value-ind");
    if (!indicator) return notExpressible("a key without a colon");
    return indicator.offset + 1;
  }

  private pairContentEnd(pair: Pair): number {
    return this.isEmptyNode(pair.value) ? this.colonEnd(pair) : this.contentEnd(pair.value as YamlNode);
  }

  private keyOffset(pair: Pair): number {
    if (!isScalar(pair.key)) return notExpressible("a complex key");
    return this.rangeOf(pair.key)[0];
  }

  /**
   * The line a block mapping's entry starts on; only list indicators (the
   * first key of an item, `- key: a`) and its key's props may precede the
   * key there.
   */
  private pairStartLine(pair: Pair): number {
    const offset = this.keyOffset(pair);
    const line = this.lineOf(offset);
    if (!/^[ \t]*(?:-[ \t]+)*(?:[&!]\S*[ \t]+)*$/.test(this.text.slice(this.lineStart(line), offset))) {
      return notExpressible("an entry that doesn't start its line");
    }
    return line;
  }

  /**
   * An entry's own lines: its key's line, its value's, and comments indented
   * inside it. The first key of a list item shares its line with the dash:
   * `pairSplice` removes it without the dash.
   */
  private pairRegion(pair: Pair): [number, number] {
    const first = this.pairStartLine(pair);
    return [first, this.extendOverComments(this.endLineOf(this.pairContentEnd(pair)), this.entryColumn(first))];
  }

  /**
   * The splice removing an entry of a block mapping holding others: its
   * lines, or, for an item's first key (on the dash's line), everything
   * from it to the next key, so `- key: a⏎  value: b` becomes `- value: b`.
   */
  private pairRemoval(map: YAMLMap, pair: Pair): Edit {
    const [first, last] = this.pairRegion(pair);
    if (!this.dashed(first)) return this.deleteLines(first, last);
    const next = map.items[map.items.indexOf(pair) + 1];
    if (!next) return notExpressible("an item's only key removed as a line");
    const nextLine = this.pairStartLine(next);
    return {
      start: this.lineStart(first) + this.entryColumn(first),
      end: this.lineStart(nextLine) + indentOf(this.lineText(nextLine)),
      text: "",
    };
  }

  /**
   * A block sequence's source items, one for each of its items.
   * A comment at the dash column after the last item (`# - type: x`,
   * a commented-out item) is kept by the parser as an item of its own with
   * no dash and no value; it isn't one of the sequence's items, so it is
   * left out here. Its lines are no item's: removing or moving an item
   * leaves them where they are while other items remain, and an item
   * appended goes before them, as a mapping's appended key goes
   * before the comment lines after its last one, so an item never lands
   * under a comment that introduces what follows the list (a banner, the
   * next key's comment). Removing the only item rewrites the list as `[]`
   * (an emptied collection), and those lines go with it, as a mapping's
   * trailing comment does when its last key goes. A bare `-` or `- # c`
   * keeps its dash: it is an item.
   *
   * Filtered once per token (`sourceItemsOf`): a list's every item asks for
   * its dash, and filtering all of them each time made a change to a long
   * list quadratic. A token is never changed in place (a splice parses the
   * text again, into new tokens), so its filtered items stay its own.
   */
  private sourceItems(seq: YAMLSeq): CST.BlockSequence["items"] {
    const token = seq.srcToken;
    if (!token || token.type !== "block-seq") return notExpressible("a sequence without its source");
    let items = sourceItemsOf.get(token);
    if (!items) {
      items = token.items.filter((item) => !TextEditor.isCommentOnly(item));
      sourceItemsOf.set(token, items);
    }
    if (items.length !== seq.items.length) return notExpressible("a sequence without its source");
    return items;
  }

  /** A source item holding only comments and line breaks: no dash, no value. */
  private static isCommentOnly(item: CST.BlockSequence["items"][number]): boolean {
    return item.value === undefined && item.start.every((part) => part.type === "comment" || part.type === "newline" || part.type === "space");
  }

  private dashOffset(seq: YAMLSeq, index: number): number {
    const dash = this.sourceItems(seq)[index]!.start.find((part) => part.type === "seq-item-ind");
    if (!dash) return notExpressible("a sequence item without its dash");
    return dash.offset;
  }

  private itemRegion(seq: YAMLSeq, index: number): [number, number] {
    const dash = this.dashOffset(seq, index);
    const first = this.lineOf(dash);
    if (this.text.slice(this.lineStart(first), dash).trim() !== "") return notExpressible("items sharing a line");
    const item = seq.items[index];
    const end = this.isEmptyNode(item) ? dash + 1 : this.contentEnd(item as YamlNode);
    return [first, this.extendOverComments(this.endLineOf(end), this.column(dash))];
  }

  static keyOf(pair: Pair): string | undefined {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value === "symbol" || key.value === null) return undefined;
    return String(key.value);
  }

  static isMergePair(pair: Pair): boolean {
    return isScalar(pair.key) && typeof pair.key.value === "symbol";
  }

  ownPair(map: YAMLMap, key: string): Pair | undefined {
    return map.items.find((pair) => !TextEditor.isMergePair(pair) && TextEditor.keyOf(pair) === key);
  }

  private resolve(node: unknown): unknown {
    let current = node;
    for (let i = 0; isAlias(current); i++) {
      if (i > MAXIMUM_ALIAS_COUNT) notExpressible("an alias chain that never ends");
      current = current.resolve(this.document);
    }
    return current;
  }

  /** The mappings a map merges, in order of precedence. */
  private mergeSources(map: YAMLMap): YAMLMap[] {
    const sources: YAMLMap[] = [];
    for (const pair of map.items) {
      if (!TextEditor.isMergePair(pair)) continue;
      const value = pair.value;
      const items = isSeq(value) ? value.items : [value];
      for (const item of items) {
        const source = this.resolve(item);
        if (!isMap(source)) return notExpressible("a merge of something that isn't a mapping");
        sources.push(source);
      }
    }
    return sources;
  }

  /** The keys a map gets only from its merges, each with the pair that gives it. */
  private mergedPairs(map: YAMLMap): Array<{ key: string; pair: Pair }> {
    const seen = new Set<string>();
    for (const pair of map.items) {
      const key = TextEditor.isMergePair(pair) ? undefined : TextEditor.keyOf(pair);
      if (key !== undefined) seen.add(key);
    }
    const out: Array<{ key: string; pair: Pair }> = [];
    for (const source of this.mergeSources(map)) {
      const effective: Array<{ key: string; pair: Pair }> = [];
      for (const pair of source.items) {
        const key = TextEditor.isMergePair(pair) ? undefined : TextEditor.keyOf(pair);
        if (key !== undefined) effective.push({ key, pair });
      }
      effective.push(...this.mergedPairs(source));
      for (const entry of effective) {
        if (seen.has(entry.key)) continue;
        seen.add(entry.key);
        out.push(entry);
      }
    }
    return out;
  }

  private mergedPair(map: YAMLMap, key: string): Pair | undefined {
    return this.mergedPairs(map).find((entry) => entry.key === key)?.pair;
  }

  /** Whether a map's merges give `key`, whether or not the map also has it. */
  private mergeGives(map: YAMLMap, key: string): boolean {
    return this.mergeSources(map).some((source) => this.ownPair(source, key) !== undefined || this.mergeGives(source, key));
  }

  /** The root mapping, or null for a text with nothing in it. */
  private root(): YAMLMap | null {
    const contents = this.document.contents;
    if (contents === null) return null;
    if (!isMap(contents)) return notExpressible("a top level that isn't a mapping");
    return contents;
  }

  /** One step down a path: a mapping's own key, or a list's item by index; undefined when absent. */
  private step(node: unknown, segment: string | number): unknown {
    if (typeof segment === "number") return isSeq(node) ? node.items[segment] : undefined;
    return isMap(node) ? this.ownPair(node, segment)?.value : undefined;
  }

  /** The value at `path`, following only own keys and items (no alias, no merge on the way); undefined when absent. */
  valueAt(path: Path): unknown {
    let node: unknown = this.document.contents;
    for (const segment of path) {
      node = this.step(node, segment);
      if (node === undefined) return undefined;
    }
    return node;
  }

  /** How many of `path`'s segments lead somewhere, from the top. */
  private existingDepth(path: Path): number {
    let node: unknown = this.document.contents;
    for (let depth = 0; depth < path.length; depth++) {
      node = this.step(node, path[depth]!);
      if (node === undefined) return depth;
    }
    return path.length;
  }

  mapAt(path: Path): YAMLMap {
    const node = path.length === 0 ? this.root() : this.valueAt(path);
    if (!isMap(node)) return notExpressible("a path that doesn't lead to a mapping");
    return node;
  }

  seqAt(path: Path): YAMLSeq {
    const node = this.valueAt(path);
    if (!isSeq(node)) return notExpressible("a path that doesn't lead to a list");
    return node;
  }

  pairAt(path: Path): Pair {
    const key = path[path.length - 1];
    if (typeof key !== "string") return notExpressible("a list item where a key was expected");
    const pair = this.ownPair(this.mapAt(path.slice(0, -1)), key);
    if (!pair) return notExpressible("a key that isn't there");
    return pair;
  }

  hasOwnKey(path: Path): boolean {
    const parent = path.length === 1 ? this.document.contents : this.valueAt(path.slice(0, -1));
    return this.step(parent, path[path.length - 1]!) !== undefined;
  }

  // ── Printing new fragments ──

  /**
   * A scalar as `yaml` prints it, for a block context. A string with a line
   * break is a literal block (`|`, `|-`) only when the block carries it
   * cleanly (`blockCarries`), and double-quoted otherwise: a keep-chomping
   * `|+` takes the blank lines after it into the value, and a first line
   * with leading spaces needs an indentation indicator. With `quoteBreaks`
   * set (a write whose block didn't read back as written, tried again),
   * every such string is double-quoted.
   */
  private scalarFragment(value: unknown): Fragment {
    if (typeof value !== "string") return { head: plainSource(value), lines: [] };
    if (this.quoteBreaks && /[\r\n]/.test(value)) return { head: quoteDouble(value), lines: [] };
    // Printed as a key's value, so a block scalar's content is indented as it would be under a key.
    const printed = new Document({ x: value })
      .toString({ lineWidth: 0 })
      .replace(/\n$/, "")
      .split("\n");
    const head = printed[0]!.slice("x: ".length);
    // `yaml` prints plain what YAML 1.2 reads as a string; the collector's yaml.v3 may read it as another type.
    if (head === value && collectorReadsAsOther(value)) return { head: quoteDouble(value), lines: [] };
    if (printed.length === 1) return { head: head.startsWith('"') ? escapeRaw(head) : head, lines: [] };
    if (/^[|>]-?$/.test(head) && blockCarries(value)) {
      return { head, lines: printed.slice(1).map((line) => rebase(line, 2, this.unit)) };
    }
    return { head: quoteDouble(value), lines: [] };
  }

  /** A new value's fragment. `flowSeqs`: its lists are flow (`[a, b]`), as a pipeline's are. */
  fragment(value: unknown, options: { flow?: boolean; flowSeqs?: boolean } = {}): Fragment {
    if (options.flow || value instanceof PlainScalar) return { head: flowText(value), lines: [] };
    if (value === null) return { head: "", lines: [] };
    if (Array.isArray(value)) {
      if (value.length === 0) return { head: "[]", lines: [] };
      if (options.flowSeqs) return { head: flowText(value), lines: [] };
      const by = this.indentSeq ? this.unit : 0;
      return { head: "", lines: this.blockLines(value, options.flowSeqs ?? false).map((line) => indentLine(line, by)) };
    }
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) return { head: "{}", lines: [] };
      return {
        head: "",
        lines: this.blockLines(value, options.flowSeqs ?? false).map((line) => indentLine(line, this.unit)),
      };
    }
    return this.scalarFragment(value);
  }

  /** A non-empty mapping's or sequence's lines at column 0. */
  private blockLines(value: unknown, flowSeqs: boolean): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.itemLines(item, flowSeqs));
    }
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      TextEditor.pairLines(0, keyText(key, false), this.fragment(item, { flowSeqs })),
    );
  }

  /** A sequence item's lines at column 0: `- value`. */
  private itemLines(item: unknown, flowSeqs: boolean): string[] {
    const nested =
      (isPlainObject(item) && Object.keys(item).length > 0) || (Array.isArray(item) && item.length > 0 && !flowSeqs);
    if (nested) {
      const [first, ...rest] = this.blockLines(item, flowSeqs);
      return [`- ${first!}`, ...rest.map((line) => indentLine(line, 2))];
    }
    const fragment = item === null ? { head: "null", lines: [] } : this.fragment(item, { flowSeqs });
    return [`- ${fragment.head}`, ...fragment.lines.map((line) => indentLine(line, 2))];
  }

  static pairLines(column: number, key: string, fragment: Fragment): string[] {
    const first = `${" ".repeat(column)}${key}:${fragment.head === "" ? "" : ` ${fragment.head}`}`;
    return [first, ...fragment.lines.map((line) => indentLine(line, column))];
  }

  // ── Copies from the source ──

  /** The anchors inside a node (not its own, which sits before it). */
  private anchorsWithin(node: YamlNode): Array<{ start: number; end: number }> {
    const found: Array<{ start: number; end: number }> = [];
    const walk = (token: CST.Token | null | undefined): void => {
      if (!token) return;
      switch (token.type) {
        case "anchor":
          found.push({ start: token.offset, end: token.offset + token.source.length });
          return;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          if (token.type === "flow-collection") walk(token.start);
          for (const item of token.items) {
            item.start.forEach(walk);
            if ("key" in item) walk(item.key);
            if ("sep" in item) item.sep?.forEach(walk);
            walk(item.value);
          }
          if (token.type === "flow-collection") token.end.forEach(walk);
          return;
        case "block-scalar":
          token.props.forEach(walk);
          return;
        default:
          return;
      }
    };
    walk(node.srcToken as CST.Token | undefined);
    const [start] = this.rangeOf(node);
    return found.filter((anchor) => anchor.start >= start).sort((a, b) => a.start - b.start);
  }

  /** The text between `start` and `end`, without the anchors given (a copy mustn't re-bind them). */
  private sliceWithout(start: number, end: number, anchors: ReadonlyArray<{ start: number; end: number }>): string {
    let out = "";
    let at = start;
    for (const anchor of anchors) {
      if (anchor.start < at || anchor.end > end) continue;
      let cutStart = anchor.start;
      let cutEnd = anchor.end;
      let after = cutEnd;
      while (after < end && (this.text[after] === " " || this.text[after] === "\t")) after++;
      if (after >= end || this.text[after] === "\n" || this.text[after] === "\r") {
        while (cutStart > at && (this.text[cutStart - 1] === " " || this.text[cutStart - 1] === "\t")) cutStart--;
      } else {
        cutEnd = after;
      }
      out += this.text.slice(at, cutStart);
      at = cutEnd;
    }
    return out + this.text.slice(at, end);
  }

  /** Where a node's text starts, with its anchor and tag (`&x !!str a`), which its range leaves out. */
  private propsStart(node: YamlNode): number {
    let start = this.rangeOf(node)[0];
    if (!node.anchor && !node.tag) return start;
    for (let tokens = 0; tokens < 2; tokens++) {
      let end = start;
      while (end > 0 && /[ \t\r\n]/.test(this.text[end - 1]!)) end--;
      let from = end;
      while (from > 0 && !/[\s,[\]{}]/.test(this.text[from - 1]!)) from--;
      const token = this.text.slice(from, end);
      if (!token.startsWith("&") && !token.startsWith("!")) break;
      start = from;
    }
    return start;
  }

  /** An explicit tag before a scalar (`!!str `), kept on its copy. */
  private tagBefore(node: Scalar): string {
    if (!node.tag) return "";
    let end = this.rangeOf(node)[0];
    for (let tokens = 0; tokens < 2; tokens++) {
      while (end > 0 && (this.text[end - 1] === " " || this.text[end - 1] === "\t")) end--;
      let start = end;
      while (start > 0 && !/\s/.test(this.text[start - 1]!)) start--;
      const token = this.text.slice(start, end);
      if (token.startsWith("!")) return `${token} `;
      if (!token.startsWith("&")) return "";
      end = start;
    }
    return "";
  }

  /**
   * A copy of a node's value from the source text, for a key: anchors
   * dropped, aliases resolved at the top, everything else as written.
   */
  copyFragment(node: unknown, flow: boolean): Fragment {
    const target = this.resolve(node);
    if (!isNode(target)) return notExpressible("a copy of nothing");
    if (this.isEmptyNode(target)) return { head: flow ? "null" : "", lines: [] };
    const [start] = this.rangeOf(target);
    const end = this.contentEnd(target);
    const anchors = this.anchorsWithin(target);

    if (this.isBlockCollection(target)) {
      if (flow) return notExpressible("a block value copied into a flow collection");
      const first = this.lineOf(start);
      if (this.text.slice(this.lineStart(first), start).trim() !== "") {
        return notExpressible("a block value that doesn't start its line");
      }
      const raw = this.sliceWithout(this.lineStart(first), this.lineContentEnd(this.endLineOf(end)), anchors);
      const from = this.column(start);
      const to = isSeq(target) && !this.indentSeq ? 0 : this.unit;
      return { head: "", lines: splitLines(raw).map((line) => rebase(line, from, to)) };
    }

    const tag = isScalar(target) ? this.tagBefore(target) : "";
    if (this.isBlockScalar(target)) {
      if (flow) return notExpressible("a block scalar copied into a flow collection");
      const raw = this.sliceWithout(start, this.lineContentEnd(this.endLineOf(end)), anchors);
      const [header, ...content] = splitLines(raw);
      if (/\d/.test(header!.split("#")[0]!)) return notExpressible("a block scalar with an indentation indicator");
      const indents = content.filter((line) => line.trim() !== "").map(indentOf);
      const from = indents.length > 0 ? Math.min(...indents) : 0;
      return { head: `${tag}${header!.trim()}`, lines: content.map((line) => rebase(line, from, this.unit)) };
    }

    const [first, ...rest] = splitLines(this.sliceWithout(start, end, anchors));
    if (rest.length === 0) return { head: `${tag}${first!}`, lines: [] };
    if (flow) {
      if (rest.some((line) => line.trim() === "") || [first!, ...rest].some((line) => line.trimEnd().endsWith("\\"))) {
        return notExpressible("a multi-line scalar copied into a flow collection");
      }
      return { head: [`${tag}${first!}`, ...rest.map((line) => line.trim())].join(" "), lines: [] };
    }
    const indents = rest.filter((line) => line.trim() !== "").map(indentOf);
    const from = indents.length > 0 ? Math.min(...indents) : 0;
    return { head: `${tag}${first!}`, lines: rest.map((line) => rebase(line, from, this.unit)) };
  }

  // ── Anchors whose owner changes ──

  private aliases(): AliasUse[] {
    if (this.aliasUses) return this.aliasUses;
    const uses: AliasUse[] = [];
    if (!this.text.includes("*")) return (this.aliasUses = uses);
    visit(this.document, {
      Alias: (_key, alias, ancestors) => {
        uses.push({ alias, ancestors: [...ancestors] });
      },
    });
    this.aliasUses = uses;
    return uses;
  }

  /** The value nodes along a path (each key's value, each item), as far as it goes. */
  private chainOf(path: Path): YamlNode[] {
    const chain: YamlNode[] = [];
    let node: unknown = this.document.contents;
    for (const segment of path) {
      node = this.step(node, segment);
      if (!isNode(node)) break;
      chain.push(node);
    }
    return chain;
  }

  /**
   * Before a change at `path` (inside the value there, or replacing it),
   * each alias elsewhere of an anchor the change reaches gets its own copy,
   * so the anchor's other users keep their values.
   */
  protect(path: Path, mode: "inside" | "replace"): void {
    for (let fixes = 0; fixes < MAXIMUM_FIXES; fixes++) {
      if (this.aliases().length === 0) return;
      const chain = this.chainOf(path);
      const anchored = new Set<unknown>(chain.filter((node) => node.anchor));
      const replaced = mode === "replace" && chain.length === path.length ? chain[chain.length - 1] : undefined;
      if (replaced) {
        visit(replaced, {
          Node: (_key, node) => {
            if (node.anchor) anchored.add(node);
          },
        });
      }
      if (anchored.size === 0) return;
      const [replacedStart, replacedEnd] = replaced
        ? [this.rangeOf(replaced)[0], this.contentEnd(replaced)]
        : [Infinity, -Infinity];
      const use = this.aliases().find(({ alias }) => {
        const start = this.rangeOf(alias)[0];
        if (start >= replacedStart && start < replacedEnd) return false;
        return anchored.has(alias.resolve(this.document));
      });
      if (!use) return;
      this.copyAliasUse(use);
    }
    notExpressible("too many aliases to copy");
  }

  /** An alias becomes a copy of what it names; an alias merged into a map, that map's own keys. */
  private copyAliasUse({ alias, ancestors }: AliasUse): void {
    const parent = ancestors[ancestors.length - 1];
    if (isPair(parent)) {
      if (parent.key === alias) notExpressible("an alias used as a key");
      const map = ancestors[ancestors.length - 2];
      if (!isMap(map)) return notExpressible("an alias outside a mapping");
      if (TextEditor.isMergePair(parent)) {
        this.expandMerge(map, () => this.parentPairOf(ancestors.slice(0, -2)));
        return;
      }
      this.replacePairValue(map, parent, this.copyFragment(alias, map.flow ?? false));
      return;
    }
    if (isSeq(parent)) {
      const holder = ancestors[ancestors.length - 2];
      if (isPair(holder) && TextEditor.isMergePair(holder)) {
        const map = ancestors[ancestors.length - 3];
        if (!isMap(map)) return notExpressible("a merge outside a mapping");
        this.expandMerge(map, () => this.parentPairOf(ancestors.slice(0, -3)));
        return;
      }
      this.replaceSeqItem(parent, alias);
      return;
    }
    notExpressible("an alias in this position");
  }

  private parentPairOf(ancestors: Ancestors): { map: YAMLMap; pair: Pair } | undefined {
    const pair = ancestors[ancestors.length - 1];
    const map = ancestors[ancestors.length - 2];
    return isPair(pair) && isMap(map) ? { map, pair } : undefined;
  }

  private replaceSeqItem(seq: YAMLSeq, alias: Alias): void {
    this.replaceItem(seq, seq.items.indexOf(alias), this.copyFragment(alias, seq.flow ?? false));
  }

  /**
   * A list item's value replaced by `fragment` (laid out for a key, as
   * `fragment` and `copyFragment` make them) where it stands: its first line
   * after the dash, the rest at the item's column. A block scalar item is
   * replaced through its last line; anything after another item's value on
   * its line (a comment) stays.
   */
  private replaceItem(seq: YAMLSeq, index: number, fragment: Fragment): void {
    const item = seq.items[index];
    if (!isNode(item)) return notExpressible("a pair inside a sequence");
    const [start] = this.rangeOf(item);
    if (seq.flow) {
      if (fragment.lines.length > 0) notExpressible("a block value inside a flow sequence");
      this.apply([{ start, end: this.contentEnd(item), text: fragment.head === "" ? "null" : fragment.head }]);
      return;
    }
    const empty = this.isEmptyNode(item);
    const dash = empty ? this.dashOffset(seq, index) : -1;
    const itemColumn = empty ? this.column(dash) + 2 : this.column(start);
    const lines = fragment.lines;
    let placed: string[];
    if (lines.length === 0) {
      placed = [fragment.head];
    } else if (fragment.head !== "") {
      const indents = lines.filter((line) => line.trim() !== "").map(indentOf);
      const from = indents.length > 0 ? Math.min(...indents) : 0;
      placed = [fragment.head, ...lines.map((line) => rebase(line, from, itemColumn))];
    } else {
      const from = indentOf(lines[0]!);
      placed = [lines[0]!.trim(), ...lines.slice(1).map((line) => rebase(line, from, itemColumn))];
    }
    const text = placed.join(this.eol);
    if (empty) {
      // Nothing after the dash to replace: the value goes right after it, before any comment there.
      this.apply([{ start: dash + 1, end: dash + 1, text: ` ${text}` }]);
      return;
    }
    const end = this.isBlockScalar(item) ? this.lineContentEnd(this.endLineOf(this.contentEnd(item))) : this.contentEnd(item);
    this.apply([{ start, end, text }]);
  }

  /**
   * A map's merge (`<<: *x`) replaced by copies of the keys it gave the map,
   * where the merge stood; `except` is left out (a key being removed).
   */
  private expandMerge(map: YAMLMap, parentOf: () => { map: YAMLMap; pair: Pair } | undefined, except?: string): void {
    const merges = map.items.filter((pair) => TextEditor.isMergePair(pair));
    const merge = merges[0];
    if (!merge || merges.length > 1) return notExpressible("a mapping with more than one merge");
    const kept = this.mergedPairs(map).filter((entry) => entry.key !== except);
    const keySource = (pair: Pair) => {
      const [start, end] = this.rangeOf(pair.key as YamlNode);
      return this.text.slice(start, end);
    };

    if (map.flow) {
      const parts = kept.map(({ pair }) => `${keySource(pair)}: ${this.copyFragment(pair.value, true).head}`);
      if (parts.length === 0) {
        this.apply([this.flowPairRemoval(map, merge)]);
        return;
      }
      this.apply([{ start: this.keyOffset(merge), end: this.pairContentEnd(merge), text: parts.join(", ") }]);
      return;
    }

    const [first, last] = this.pairRegion(merge);
    const column = this.entryColumn(first);
    // A merge that is a list item's first key keeps the dash before it.
    const dashed = this.dashed(first);
    const lines = kept.flatMap(({ pair }) =>
      TextEditor.pairLines(column, keySource(pair), this.copyFragment(pair.value, false)),
    );
    if (lines.length > 0) {
      const start = this.lineStart(first) + (dashed ? column : 0);
      const text = (dashed ? [lines[0]!.slice(column), ...lines.slice(1)] : lines).join(this.eol);
      this.apply([{ start, end: this.lineContentEnd(last), text }]);
      return;
    }
    if (map.items.length === 1) {
      const parent = parentOf();
      if (parent) {
        this.replacePairValue(parent.map, parent.pair, { head: "{}", lines: [] });
        return;
      }
      if (dashed) {
        this.apply([{ start: this.lineStart(first) + column, end: this.lineContentEnd(last), text: "{}" }]);
        return;
      }
    }
    this.apply([this.pairRemoval(map, merge)]);
  }

  // ── The splices ──

  /** A pair's value replaced by `fragment`, keeping the key's line and its comment. */
  replacePairValue(map: YAMLMap, pair: Pair, fragment: Fragment): void {
    const colon = this.colonEnd(pair);
    const value = pair.value;
    const empty = this.isEmptyNode(value);

    if (map.flow) {
      if (fragment.lines.length > 0) notExpressible("a block value inside a flow mapping");
      const end = empty ? colon : this.contentEnd(value as YamlNode);
      this.apply([{ start: colon, end, text: ` ${fragment.head === "" ? "null" : fragment.head}` }]);
      return;
    }

    const keyLine = this.lineOf(colon - 1);
    // An item's first key (`- key:`) nests its value under the key, not the dash.
    const column = this.entryColumn(keyLine);
    const lines = fragment.lines.map((line) => indentLine(line, column));
    const head = fragment.head === "" ? "" : ` ${fragment.head}`;
    const tail = (comment: string) =>
      `${head}${comment === "" ? "" : ` ${comment}`}${lines.length > 0 ? this.eol + lines.join(this.eol) : ""}`;

    if (empty) {
      const end = this.lineContentEnd(keyLine);
      this.apply([{ start: colon, end, text: tail(commentIn(this.text.slice(colon, end))) }]);
      return;
    }

    const node = value as YamlNode;
    const [valueStart] = this.rangeOf(node);
    const valueEnd = this.contentEnd(node);
    if (this.lineOf(valueStart) === keyLine && !this.isBlockCollection(node)) {
      if (lines.length === 0 && !this.isBlockScalar(node)) {
        this.apply([{ start: colon, end: valueEnd, text: head }]);
        return;
      }
      const lastLine = this.endLineOf(valueEnd);
      const comment = this.isBlockScalar(node)
        ? commentIn(this.text.slice(valueStart, this.lineContentEnd(keyLine)))
        : commentIn(this.text.slice(valueEnd, this.lineContentEnd(lastLine)));
      this.apply([{ start: colon, end: this.lineContentEnd(lastLine), text: tail(comment) }]);
      return;
    }

    // A value on the lines below its key.
    const lastLine = this.extendOverComments(this.endLineOf(valueEnd), column);
    if (head === "" && lines.length > 0) {
      const start = this.lineStart(this.lineOf(valueStart));
      this.apply([{ start, end: this.lineContentEnd(lastLine), text: lines.join(this.eol) }]);
      return;
    }
    const comment = commentIn(this.text.slice(colon, this.lineContentEnd(keyLine)));
    this.apply([{ start: colon, end: this.lineContentEnd(lastLine), text: tail(comment) }]);
  }

  /** The value at `path` replaced where it stands: after its key, or as its list item. */
  replaceValueAt(path: Path, fragmentFor: (flow: boolean) => Fragment): void {
    const last = path[path.length - 1];
    if (typeof last === "number") {
      const seq = this.seqAt(path.slice(0, -1));
      this.replaceItem(seq, last, fragmentFor(seq.flow ?? false));
      return;
    }
    const map = this.mapAt(path.slice(0, -1));
    this.replacePairValue(map, this.pairAt(path), fragmentFor(map.flow ?? false));
  }

  /** The splice for a scalar changed in place, through its source token (its style and comment kept). */
  private scalarEdit(node: Scalar, value: unknown, context: "block" | "flow" | "key" | "flowKey"): Edit {
    const token = node.srcToken;
    if (!token || token.type === "block-scalar") return notExpressible("a scalar without a flow token");
    const before = CST.stringify(token);
    if (this.text.slice(token.offset, token.offset + before.length) !== before) {
      return notExpressible("a scalar whose token doesn't match the text");
    }
    let source: string;
    let type: Scalar.Type;
    if (value instanceof PlainScalar && value.isCollection) {
      // `yaml`'s printer would quote a flow collection's characters: they replace the scalar's own, its comment kept.
      if (token.type !== "scalar" && token.type !== "single-quoted-scalar" && token.type !== "double-quoted-scalar") {
        return notExpressible("a scalar without a flow token");
      }
      return { start: token.offset, end: token.offset + token.source.length, text: value.source };
    }
    if (token.type === "double-quoted-scalar" && typeof value === "string" && /[\r\n]/.test(value)) {
      // A double-quoted string stays double-quoted, its breaks escaped (`"a\nb"`), not turned into a block.
      return { start: token.offset, end: token.offset + token.source.length, text: quoteDouble(value) };
    }
    if (value instanceof PlainScalar) {
      source = value.source;
      type = "PLAIN";
    } else if (typeof value === "string") {
      source = value;
      // A tab or another control character (C0, DEL, C1) is escaped in double quotes (`"\t"`), which single quotes
      // can't do.
      // eslint-disable-next-line no-control-regex
      if (token.type === "single-quoted-scalar") type = /[\x00-\x1f\x7f-\x9f]/.test(value) ? "QUOTE_DOUBLE" : "QUOTE_SINGLE";
      else if (token.type === "double-quoted-scalar") type = "QUOTE_DOUBLE";
      else if (context === "block") {
        const printed = this.scalarFragment(value).head;
        type = printed === value ? "PLAIN" : printed.startsWith("'") ? "QUOTE_SINGLE" : "QUOTE_DOUBLE";
      } else type = plainSafe(value, context) ? "PLAIN" : "QUOTE_DOUBLE";
    } else {
      source = plainSource(value);
      type = "PLAIN";
    }
    const edited = structuredClone(token);
    CST.setScalarValue(edited, source, {
      type,
      inFlow: context === "flow" || context === "flowKey",
      implicitKey: context === "key" || context === "flowKey",
    });
    if (edited.type === "double-quoted-scalar") edited.source = escapeRaw(edited.source);
    return { start: token.offset, end: token.offset + before.length, text: CST.stringify(edited) };
  }

  private flowPairRemoval(map: YAMLMap, pair: Pair): Edit {
    const index = map.items.indexOf(pair);
    const next = map.items[index + 1];
    const previous = map.items[index - 1];
    if (next) return { start: this.keyOffset(pair), end: this.keyOffset(next), text: "" };
    if (previous) return { start: this.pairContentEnd(previous), end: this.pairContentEnd(pair), text: "" };
    return { start: this.keyOffset(pair), end: this.pairContentEnd(pair), text: "" };
  }

  /** A list replaced where it stands, in its own style, keeping the items that stay. */
  private replaceList(
    path: Path,
    seq: YAMLSeq,
    pair: Pair,
    map: YAMLMap,
    items: readonly unknown[],
    flowSeqs: boolean,
  ): void {
    const [start, end] = this.rangeOf(seq);
    if (items.length === 0) {
      // Spread over lines, as a form's removals leave it: `[]`, or a comment of the list's own kept.
      if (seq.flow && seq.items.length > 0 && this.spansLines(seq)) this.apply(this.flowRemovals(seq, new Set(seq.items.keys())));
      else if (seq.flow) this.apply([{ start, end, text: "[]" }]);
      else this.replacePairValue(map, pair, { head: "[]", lines: [] });
      return;
    }
    // An empty list's first items; a pipeline's lists (`flowSeqs`) stay flow, as they are written.
    if (!flowSeqs && this.opensAsBlock(path, seq)) {
      this.replacePairValue(map, pair, this.fragment(items));
      return;
    }
    const old = seq.items.map((item) => (isNode(item) ? item.toJS(this.document, { maxAliasCount: MAXIMUM_ALIAS_COUNT }) : null));
    const steps = listSteps(old, items);

    if (seq.flow && this.spansLines(seq)) {
      this.apply(seq.items.length > 0 ? this.flowListEdits(seq, old, steps) : [this.intoEmptyFlowLines(seq, items)]);
      return;
    }
    if (seq.flow) {
      const parts = steps.flatMap((step) => {
        if (step.kind === "delete") return [];
        if (step.kind === "insert") return [flowText(step.value)];
        const item = seq.items[step.index];
        if (!isNode(item)) return notExpressible("a pair inside a flow sequence");
        return [this.text.slice(this.rangeOf(item)[0], this.contentEnd(item))];
      });
      this.apply([{ start, end, text: `[${parts.join(", ")}]` }]);
      return;
    }

    const regions = seq.items.map((_item, index) => this.itemRegion(seq, index));
    const column = this.column(this.dashOffset(seq, 0));
    const out: string[] = [];
    const gap = (index: number) => {
      if (index === 0) return;
      for (let line = regions[index - 1]![1] + 1; line < regions[index]![0]; line++) out.push(this.lineText(line));
    };
    for (const step of steps) {
      if (step.kind === "insert") {
        out.push(...this.itemLines(step.value, flowSeqs).map((line) => indentLine(line, column)));
        continue;
      }
      gap(step.index);
      if (step.kind === "keep") {
        const [first, last] = regions[step.index]!;
        for (let line = first; line <= last; line++) out.push(this.lineText(line));
      }
    }
    const first = regions[0]![0];
    const last = regions[regions.length - 1]![1];
    this.apply([{ start: this.lineStart(first), end: this.lineContentEnd(last), text: out.join(this.eol) }]);
  }

  /*
   * A flow sequence spread over lines, such as
   *
   *     receivers: [
   *       otlp, # c1
   *       otlp/2 # c2
   *     ]
   *
   * is changed item by item rather than rebuilt on one line, which would
   * join its lines and lose its comments (a comment in a flow sequence
   * always ends a line, so "spread over lines" covers them). An item set is
   * changed where it stands (a scalar through its own token); an item
   * removed goes with its comma and its own comment lines (`flowRemovals`),
   * every item removed leaving `[]` or the bracket lines; new
   * items go before the next item kept, or `, x` after the last item's
   * content, so its comment and the closing bracket's line stay. Other
   * items' comments stay where they are. A change that can't be written
   * that way, a reorder (a value both removed and added), is refused.
   * One-line flow sequences are rebuilt as before.
   */

  /** Whether a flow collection's source holds a line break. */
  private spansLines(node: YamlNode): boolean {
    const [start, end] = this.rangeOf(node);
    return /[\r\n]/.test(this.text.slice(start, end));
  }

  /** The splices taking a flow sequence spread over lines from `old` through `steps`, item by item. */
  private flowListEdits(seq: YAMLSeq, old: readonly unknown[], steps: readonly Step[]): Edit[] {
    const nodes = seq.items.map((item) => (isNode(item) ? item : notExpressible("a pair inside a flow sequence")));
    const sets: Array<[number, unknown]> = [];
    const deleted = new Set<number>();
    const inserts: Array<{ before: number | undefined; values: unknown[] }> = [];
    let run: { deletes: number[]; inserts: unknown[] } = { deletes: [], inserts: [] };
    // Between two kept items, a deleted item and a new one in turn are a set; what's left is removed or inserted.
    const flush = (next: number | undefined) => {
      const paired = Math.min(run.deletes.length, run.inserts.length);
      for (let k = 0; k < paired; k++) sets.push([run.deletes[k]!, run.inserts[k]]);
      for (const index of run.deletes.slice(paired)) deleted.add(index);
      if (run.inserts.length > paired) inserts.push({ before: next, values: run.inserts.slice(paired) });
      run = { deletes: [], inserts: [] };
    };
    for (const step of steps) {
      if (step.kind === "keep") flush(step.index);
      else if (step.kind === "delete") run.deletes.push(step.index);
      else run.inserts.push(step.value);
    }
    flush(undefined);

    const added = [...sets.map(([, value]) => value), ...inserts.flatMap((insert) => insert.values)];
    const removed = [...sets.map(([index]) => old[index]), ...[...deleted].map((index) => old[index])];
    if (added.some((value) => removed.some((other) => valuesEqual(value, other)))) {
      return notExpressible("a reorder of a flow sequence spread over lines");
    }

    const edits: Edit[] = sets.map(([index, value]) => {
      const node = nodes[index]!;
      const end = this.contentEnd(node);
      if (this.changesInPlace(node, value)) {
        // Through its token, quoting kept; only up to its content's end, so `, x` can follow it and its comment stays.
        const edit = this.scalarEdit(node, value, "flow");
        const tail = this.text.slice(end, edit.end);
        if (edit.end === end) return edit;
        if (edit.end > end && edit.text.endsWith(tail)) return { start: edit.start, end, text: edit.text.slice(0, -tail.length) };
      }
      return { start: this.rangeOf(node)[0], end, text: flowText(value) };
    });
    edits.push(...this.flowRemovals(seq, deleted));
    let lastKept = -1;
    for (let index = 0; index < nodes.length; index++) if (!deleted.has(index)) lastKept = index;
    for (const { before, values } of inserts) {
      const text = values.map(flowText).join(", ");
      if (before !== undefined) {
        const at = this.propsStart(nodes[before]!);
        edits.push({ start: at, end: at, text: `${text}, ` });
      } else {
        const at = this.contentEnd(nodes[lastKept]!);
        edits.push({ start: at, end: at, text: `, ${text}` });
      }
    }
    return edits;
  }

  /**
   * The first items of an empty flow sequence spread over lines, such as
   * `[ # c` and `]` (what removing every item leaves when it has a comment):
   * on a line of their own right after the `[` line, before the comment
   * lines inside the brackets, so the comments stay and stay no item's
   * (`flowLeadLine`): removing the items gives back the text as it was. They
   * stand at the larger of the first comment line's indentation and a unit
   * past the `]`'s, by column (a tab to the next multiple of 8), in spaces:
   * a tab before the `]` or a comment isn't copied.
   */
  private intoEmptyFlowLines(seq: YAMLSeq, values: readonly unknown[]): Edit {
    const [open, after] = this.rangeOf(seq);
    const close = after - 1;
    const closeLine = this.lineOf(close);
    const before = this.text.slice(this.lineStart(closeLine), close);
    if (this.text[close] !== "]" || before.trim() !== "") return notExpressible("an empty flow sequence spread over lines");
    let column = columnAfter(before) + this.unit;
    for (let line = this.lineOf(open) + 1; line < closeLine; line++) {
      const text = this.lineText(line);
      if (text.trim() === "") continue;
      column = Math.max(column, columnAfter(/^[ \t]*/.exec(text)![0]));
      break;
    }
    const at = this.lineStart(this.lineOf(open) + 1);
    return { start: at, end: at, text: `${" ".repeat(column)}${values.map(flowText).join(", ")}\n` };
  }

  /**
   * The splices removing a flow sequence's `deleted` items, each with its
   * own comma. An item that starts its line and has nothing but a comment
   * after it on its last goes as whole lines, with the comment lines
   * directly above it (its own; the next item keeps its), so no blank line
   * is left. An item sharing its line goes as a slice: after another item,
   * from that one's comma (`a, x, b` gives `a, b`; `a, x # c` gives
   * `a # c`, the line's comment kept); first on its line, up to what
   * follows its comma (`[x, a` gives `[a`). The last item, without a comma
   * of its own, takes the comma of the last item kept (`a, # c` back to
   * `a # c`). Every item gone, the brackets with nothing but white space
   * between them are written `[]`; a comment there keeps the bracket lines.
   */
  private flowRemovals(seq: YAMLSeq, deleted: ReadonlySet<number>): Edit[] {
    const nodes = seq.items.map((item) => (isNode(item) ? item : notExpressible("a pair inside a flow sequence")));
    if (deleted.size === 0) return [];
    const [open, after] = this.rangeOf(seq);
    const close = after - 1;
    const commas = this.flowCommas(nodes, close);
    let lastKept = -1;
    for (let index = 0; index < nodes.length; index++) if (!deleted.has(index)) lastKept = index;

    const ranges: Array<[number, number]> = [];
    for (const index of deleted) ranges.push(...this.flowItemSpans(nodes, commas, open, index));
    const last = nodes.length - 1;
    if (lastKept !== -1 && lastKept < last && commas[last] === -1) ranges.push([commas[lastKept]!, commas[lastKept]! + 1]);

    const merged = mergedRanges(mergedRanges(ranges).map((range) => this.wholeLines(range)));
    if (lastKept === -1) {
      let inside = "";
      let from = open + 1;
      for (const [start, end] of merged) {
        inside += this.text.slice(from, start);
        from = end;
      }
      inside += this.text.slice(from, close);
      if (inside.trim() === "") return [{ start: open, end: close + 1, text: "[]" }];
    }
    return merged.map(([start, end]) => ({ start, end, text: "" }));
  }

  /**
   * A removal widened so it leaves no line of white space (its line's
   * break goes with it) and no trailing white space (the spaces before it
   * go when nothing follows it on its line).
   */
  private wholeLines([start, end]: [number, number]): [number, number] {
    if (end > start && this.text[end - 1] === "\n") return [start, end];
    const first = this.lineOf(start);
    const last = this.lineOf(end);
    if (this.text.slice(end, this.lineContentEnd(last)).trim() !== "") return [start, end];
    if (this.text.slice(this.lineStart(first), start).trim() === "" && last + 1 < this.lineCount) {
      return [this.lineStart(first), this.lineStart(last + 1)];
    }
    let from = start;
    while (from > this.lineStart(first) && (this.text[from - 1] === " " || this.text[from - 1] === "\t")) from--;
    return [from, this.lineContentEnd(last)];
  }

  /** The comma between `from` (an item's content end) and `to` (the next item or the closing bracket), past comments; -1 when none. */
  private flowComma(from: number, to: number): number {
    for (let i = from; i < to; i++) {
      // A `#` between items starts a comment, which runs to the line's end.
      if (this.text[i] === "#") while (i + 1 < to && this.text[i + 1] !== "\n") i++;
      else if (this.text[i] === ",") return i;
    }
    return -1;
  }

  /** Each flow sequence item's comma (`flowComma`), the last item's -1 when it has none; refused when another item's is missing. */
  private flowCommas(nodes: readonly YamlNode[], close: number): number[] {
    const commas = nodes.map((node, index) => this.flowComma(this.contentEnd(node), index + 1 < nodes.length ? this.propsStart(nodes[index + 1]!) : close));
    nodes.forEach((_node, index) => {
      if (index + 1 < nodes.length && commas[index] === -1) notExpressible("a flow sequence item without its comma");
    });
    return commas;
  }

  /**
   * The first of a flow sequence item's own comment lines: the comment
   * lines directly above it, below the line of the previous item's comma
   * (or of the `[`), so a quoted item's line that starts with `#` isn't
   * taken for one.
   */
  private flowLeadLine(nodes: readonly YamlNode[], commas: readonly number[], open: number, index: number): number {
    const line = this.lineOf(this.propsStart(nodes[index]!));
    const floor = this.lineOf(index > 0 ? commas[index - 1]! : open) + 1;
    let first = line;
    while (first > floor && this.lineText(first - 1).trim().startsWith("#")) first--;
    return first;
  }

  /** What removing a flow sequence's item `index` takes, with its comma (`flowRemovals`). */
  private flowItemSpans(nodes: readonly YamlNode[], commas: readonly number[], open: number, index: number): Array<[number, number]> {
    const node = nodes[index]!;
    const start = this.propsStart(node);
    const comma = commas[index]!;
    const after = comma === -1 ? this.contentEnd(node) : comma + 1;
    const line = this.lineOf(start);
    const startsLine = this.text.slice(this.lineStart(line), start).trim() === "";
    const endLine = this.lineOf(after);
    const rest = this.text.slice(after, this.lineContentEnd(endLine));
    const spans: Array<[number, number]> = [];
    if (startsLine) {
      // Its own comment lines: the comment lines directly above it, after the item or bracket before it.
      const first = this.flowLeadLine(nodes, commas, open, index);
      if (/^[ \t]*(?:#.*)?$/.test(rest)) return [[this.lineStart(first), this.lineStart(endLine + 1)]];
      if (first < line) spans.push([this.lineStart(first), this.lineStart(line)]);
    } else if (index > 0 && this.lineOf(commas[index - 1]!) === line) {
      // After another item on its line: from that one's comma, so the white space after this one's stays.
      spans.push([commas[index - 1]! + 1, after]);
      return spans;
    }
    // First on its line (or after the bracket): up to what follows, a comment keeping the space before it.
    let end = after;
    if (!/^[ \t]*#/.test(rest)) while (end < this.text.length && (this.text[end] === " " || this.text[end] === "\t")) end++;
    spans.push([start, comma === -1 ? after : end]);
    return spans;
  }

  // ── Paths ──

  /**
   * Makes every key on `path` the map's own and every value on it a real
   * mapping: a key the map has only from a merge gets a copy of its whole
   * value first, and an alias on the path (or as the value) becomes a copy.
   */
  prepare(path: Path): void {
    for (let fixes = 0; fixes < MAXIMUM_FIXES; fixes++) {
      if (!this.prepareStep(path)) return;
    }
    notExpressible("too many copies on one path");
  }

  private prepareStep(path: Path): boolean {
    let node: unknown = this.document.contents;
    const walked: Array<string | number> = [];
    for (const segment of path) {
      if (typeof segment === "number") {
        // A list item: an alias item becomes a copy; a merge inside an item is copied as in any mapping.
        const item = isSeq(node) ? node.items[segment] : undefined;
        if (item === undefined) return false;
        if (isAlias(item)) {
          this.replaceSeqItem(node as YAMLSeq, item);
          return true;
        }
        node = item;
        walked.push(segment);
        continue;
      }
      if (!isMap(node)) return false;
      const pair = this.ownPair(node, segment);
      if (!pair) {
        const merged = this.mergedPair(node, segment);
        if (!merged) return false;
        this.insertPair(walked, segment, (flow) => this.copyFragment(merged.value, flow), { protect: false });
        return true;
      }
      if (isAlias(pair.value)) {
        this.replacePairValue(node, pair, this.copyFragment(pair.value, node.flow ?? false));
        return true;
      }
      node = pair.value;
      walked.push(segment);
    }
    return false;
  }

  /**
   * A new key in the map at `mapPath`: at the end of a block mapping (or
   * before the first of `before` it has), or at the end of a flow one. An
   * empty one, `{}`, becomes a block mapping, or takes the pair
   * between its braces inside a flow collection. A value with nothing in it
   * becomes a mapping, styled as its parent is.
   */
  insertPair(
    mapPath: Path,
    key: string,
    fragmentFor: (flow: boolean) => Fragment,
    options: { before?: readonly string[]; protect?: boolean } = {},
  ): void {
    if (options.protect !== false) this.protect(mapPath, "inside");
    const container = mapPath.length === 0 ? this.document.contents : this.valueAt(mapPath);

    if (mapPath.length === 0 && container === null) {
      this.apply([this.appendToDocument(TextEditor.pairLines(0, keyText(key, false), fragmentFor(false)))]);
      return;
    }
    if (mapPath.length === 0 && (!isMap(container) || (container.flow && container.items.length === 0))) {
      return notExpressible("a top level that isn't a block mapping");
    }
    if (isMap(container) && container.flow && container.items.length === 0) {
      if (this.opensAsBlock(mapPath, container)) {
        const pairLines = TextEditor.pairLines(this.unit, keyText(key, false), fragmentFor(false));
        this.replaceValueAt(mapPath, () => ({ head: "", lines: pairLines }));
        return;
      }
      // Inside a flow collection, or anchored or tagged: the pair goes between its braces.
      const token = container.srcToken;
      const end = token?.type === "flow-collection" ? token.end.find((part) => part.type === "flow-map-end") : undefined;
      if (!end) return notExpressible("a flow mapping without its end");
      const fragment = fragmentFor(true);
      if (fragment.lines.length > 0) return notExpressible("a block value inside a flow mapping");
      this.apply([{ start: end.offset, end: end.offset, text: `${keyText(key, true)}: ${fragment.head || "null"}` }]);
      return;
    }
    if (!isMap(container)) {
      if (!(isScalar(container) && container.value === null)) {
        return notExpressible("a key set inside a value that isn't a mapping");
      }
      this.replaceValueAt(mapPath, (flow) =>
        flow
          ? { head: `{${keyText(key, true)}: ${fragmentFor(true).head || "null"}}`, lines: [] }
          : { head: "", lines: TextEditor.pairLines(this.unit, keyText(key, false), fragmentFor(false)) },
      );
      return;
    }
    if (container.flow) {
      const last = container.items[container.items.length - 1]!;
      const at = this.pairContentEnd(last);
      const value = fragmentFor(true).head || "null";
      this.apply([{ start: at, end: at, text: `, ${keyText(key, true)}: ${value}` }]);
      return;
    }

    // The first key's column: an item's keys stand after its dash (`- key: a`).
    const column = this.entryColumn(this.pairStartLine(container.items[0]!));
    const lines = TextEditor.pairLines(column, keyText(key, false), fragmentFor(false));
    const before = options.before
      ? container.items.find((pair) => {
          const name = TextEditor.isMergePair(pair) ? undefined : TextEditor.keyOf(pair);
          return name !== undefined && options.before!.includes(name);
        })
      : undefined;
    if (before) {
      this.apply([this.insertBeforeLine(this.attachedCommentsStart(this.pairStartLine(before), column), lines)]);
      return;
    }
    const [, last] = this.pairRegion(container.items[container.items.length - 1]!);
    this.apply([this.insertAfterLine(last, lines)]);
  }

  /** A key removed from the map at `mapPath`: its own lines; an emptied mapping becomes `{}` (a list item's too). */
  deleteOwnPair(mapPath: Path, key: string): void {
    const map = this.mapAt(mapPath);
    const pair = this.ownPair(map, key);
    if (!pair) return;
    if (map.flow) {
      this.apply([this.flowPairRemoval(map, pair)]);
      return;
    }
    if (map.items.length === 1 && mapPath.length > 0) {
      this.replaceValueAt(mapPath, () => ({ head: "{}", lines: [] }));
      return;
    }
    this.apply([this.pairRemoval(map, pair)]);
  }

  /** A key removed, whether the map holds it or gets it from a merge (then the merge is expanded without it). */
  deleteKey(mapPath: Path, key: string): void {
    this.prepare(mapPath);
    // A key the merge also gives would come back from it: the merge is expanded without it.
    if (this.mergeGives(this.mapAt(mapPath), key)) {
      this.protect(mapPath, "inside");
      const parentOf = () =>
        mapPath.length === 0 || typeof mapPath[mapPath.length - 1] === "number"
          ? undefined
          : { map: this.mapAt(mapPath.slice(0, -1)), pair: this.pairAt(mapPath) };
      this.expandMerge(this.mapAt(mapPath), parentOf, key);
    }
    if (this.ownPair(this.mapAt(mapPath), key)) {
      this.protect([...mapPath, key], "replace");
      this.deleteOwnPair(mapPath, key);
    }
  }

  /** Several keys removed from one map, their lines in one splice when they are all its own. */
  removeKeys(mapPath: Path, keys: readonly string[]): void {
    this.prepare(mapPath);
    for (const key of keys) this.protect([...mapPath, key], "replace");
    const map = this.mapAt(mapPath);
    const own = keys.map((key) => this.ownPair(map, key));
    if (map.flow || own.some((pair) => !pair) || map.items.some((pair) => TextEditor.isMergePair(pair))) {
      for (const key of keys) this.deleteKey(mapPath, key);
      return;
    }
    if (own.length === map.items.length && mapPath.length > 0) {
      this.replacePairValue(this.mapAt(mapPath.slice(0, -1)), this.pairAt(mapPath), { head: "{}", lines: [] });
      return;
    }
    const regions = own.map((pair) => this.pairRegion(pair!)).sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const region of regions) {
      const previous = merged[merged.length - 1];
      if (previous && region[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], region[1]);
      else merged.push([region[0], region[1]]);
    }
    this.apply(merged.map(([first, last]) => this.deleteLines(first, last)));
  }

  /** Whether `node` is a scalar `value` can replace through its own token, keeping its style and comment. */
  private changesInPlace(node: unknown, value: unknown): node is Scalar {
    return (
      isScalar(node) &&
      !this.isEmptyNode(node) &&
      !node.tag &&
      node.srcToken?.type !== "block-scalar" &&
      isScalarValue(value) &&
      // A string with a break replaces a scalar in place only where it stays double-quoted.
      !(typeof value === "string" && /[\r\n]/.test(value) && node.srcToken?.type !== "double-quoted-scalar")
    );
  }

  /** A key's value set: a scalar in place, a list item by item, anything else replaced whole. */
  setKey(mapPath: Path, key: string, value: unknown, options: { flowSeqs?: boolean } = {}): void {
    this.prepare(mapPath);
    const path = [...mapPath, key];
    const flowSeqs = options.flowSeqs ?? false;
    if (!this.ownPair(this.mapAt(mapPath), key)) {
      this.insertPair(mapPath, key, (flow) => this.fragment(value, { flow, flowSeqs }));
      return;
    }
    this.protect(path, "replace");
    const map = this.mapAt(mapPath);
    const pair = this.pairAt(path);
    const node = pair.value;
    const inFlow = map.flow ?? false;
    if (this.changesInPlace(node, value)) {
      this.apply([this.scalarEdit(node, value, inFlow ? "flow" : "block")]);
      return;
    }
    if (isSeq(node) && Array.isArray(value)) {
      this.replaceList(path, node, pair, map, value, flowSeqs);
      return;
    }
    this.replacePairValue(map, pair, this.fragment(value, { flow: inFlow, flowSeqs }));
  }

  /** A component's value changed leaf by leaf: maps key by key, anything else (lists whole) at its key. */
  applyValue(path: Path, before: unknown, after: unknown): void {
    if (valuesEqual(before, after)) return;
    if (isPlainObject(before) && isPlainObject(after)) {
      this.prepare(path);
      for (const key of Object.keys(before)) {
        if (!Object.prototype.hasOwnProperty.call(after, key)) this.deleteKey(path, key);
      }
      for (const [key, value] of Object.entries(after)) {
        if (Object.prototype.hasOwnProperty.call(before, key)) this.applyValue([...path, key], before[key], value);
        else this.setKey(path, key, value);
      }
      return;
    }
    this.setKey(path.slice(0, -1), path[path.length - 1] as string, after);
  }

  // ── Values by key path ──

  /**
   * The splice setting the scalar at `path` in place when nothing needs
   * copying or protecting first (own keys and items all the way, no alias,
   * no anchor on the way), so several can share one parse; undefined when
   * the change needs more.
   */
  scalarEditAt(path: Path, value: unknown): Edit | undefined {
    let node: unknown = this.document.contents;
    let flow = false;
    for (const segment of path) {
      if (!isNode(node) || isAlias(node) || node.anchor) return undefined;
      flow = (isMap(node) || isSeq(node)) && (node.flow ?? false);
      node = this.step(node, segment);
    }
    if (!this.changesInPlace(node, value) || node.anchor) return undefined;
    return this.scalarEdit(node, value, flow ? "flow" : "block");
  }

  /**
   * What `path` addresses set to `value`: a key as `setKey` sets it, an
   * item in place, index `length` appended, and a path that runs out
   * added from the deepest part that exists.
   */
  setValue(path: Path, value: unknown): void {
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1]!;
    this.prepare(parentPath);
    const depth = this.existingDepth(parentPath);
    if (depth < parentPath.length) {
      this.insertMissing(parentPath.slice(0, depth), path.slice(depth), value);
      return;
    }
    const parent = parentPath.length === 0 ? this.document.contents : this.valueAt(parentPath);
    if (typeof last === "number" && isSeq(parent)) this.setItem(parentPath, last, value);
    else if (typeof last === "string" && isMap(parent)) this.setKey(parentPath, last, value);
    else this.insertMissing(parentPath, [last], value);
  }

  /**
   * `rest` added under the value at `containerPath`, which lacks its first
   * segment: one new key (or item) holding the rest as nested mappings, and
   * lists where the rest has numbers (only index 0 of a new list). A value
   * with nothing in it (`otlp:`, `service:`, an empty text) becomes the
   * mapping or list the rest needs.
   */
  private insertMissing(containerPath: Path, rest: Path, value: unknown): void {
    const [first, ...inner] = rest;
    const nested = inner.reduceRight<unknown>((built, segment) => {
      if (typeof segment === "string") return { [segment]: built };
      return segment === 0 ? [built] : notExpressible("an item past the end of a new list");
    }, value);
    const container = containerPath.length === 0 ? this.document.contents : this.valueAt(containerPath);
    const nothing = containerPath.length > 0 && isScalar(container) && container.value === null;
    if (typeof first === "string") {
      if (!isMap(container) && !nothing && !(containerPath.length === 0 && container === null)) {
        return notExpressible("a key set inside a value that isn't a mapping");
      }
      this.insertPair(containerPath, first, (flow) => this.fragment(nested, { flow }));
      return;
    }
    if (isSeq(container)) {
      if (first !== container.items.length) return notExpressible("an item past the end of a list");
      this.appendItem(containerPath, nested);
      return;
    }
    if (!nothing || first !== 0) return notExpressible("an item set inside a value that isn't a list");
    this.protect(containerPath, "replace");
    this.replaceValueAt(containerPath, (flow) => this.fragment([nested], { flow }));
  }

  /** A list item set: a scalar in place, anything else by replacing the item's text; index `length` appends. */
  private setItem(seqPath: Path, index: number, value: unknown): void {
    const length = this.seqAt(seqPath).items.length;
    if (index === length) {
      this.appendItem(seqPath, value);
      return;
    }
    if (index > length) return notExpressible("an item past the end of a list");
    this.protect([...seqPath, index], "replace");
    const seq = this.seqAt(seqPath);
    const item = seq.items[index];
    const flow = seq.flow ?? false;
    if (this.changesInPlace(item, value)) {
      this.apply([this.scalarEdit(item, value, flow ? "flow" : "block")]);
      return;
    }
    this.replaceItem(seq, index, value === null ? { head: "null", lines: [] } : this.fragment(value, { flow }));
  }

  /**
   * A new last item: its lines after the last item's (at the dashes' column),
   * or `, x` in a flow list. An empty one, `[]`, becomes a block list,
   * or `[x]` inside a flow collection.
   */
  private appendItem(seqPath: Path, value: unknown): void {
    this.protect(seqPath, "inside");
    const seq = this.seqAt(seqPath);
    if (seq.flow) {
      const last = seq.items[seq.items.length - 1];
      if (last === undefined) {
        if (this.opensAsBlock(seqPath, seq)) {
          this.replaceValueAt(seqPath, () => this.fragment([value]));
          return;
        }
        if (this.spansLines(seq)) {
          this.apply([this.intoEmptyFlowLines(seq, [value])]);
          return;
        }
        const token = seq.srcToken;
        const end = token?.type === "flow-collection" ? token.end.find((part) => part.type === "flow-seq-end") : undefined;
        if (!end) return notExpressible("a flow sequence without its end");
        this.apply([{ start: end.offset, end: end.offset, text: flowText(value) }]);
        return;
      }
      if (!isNode(last)) return notExpressible("a pair inside a flow sequence");
      const at = this.contentEnd(last);
      this.apply([{ start: at, end: at, text: `, ${flowText(value)}` }]);
      return;
    }
    const column = this.column(this.dashOffset(seq, 0));
    // After the last item's own lines (its deeper comments), before the list's trailing comment lines.
    const [, lastLine] = this.itemRegion(seq, seq.items.length - 1);
    this.apply([this.insertAfterLine(lastLine, this.itemLines(value, false).map((line) => indentLine(line, column)))]);
  }

  /** What `path` addresses removed, by its own lines; nothing when it isn't there. */
  removeValue(path: Path): void {
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1]!;
    this.prepare(parentPath);
    if (this.existingDepth(parentPath) < parentPath.length) return;
    const parent = parentPath.length === 0 ? this.document.contents : this.valueAt(parentPath);
    if (typeof last === "number") {
      if (isSeq(parent) && last < parent.items.length) this.removeItem(parentPath, last);
    } else if (isMap(parent)) {
      this.deleteKey(parentPath, last);
    }
  }

  /**
   * A list item removed: its lines, or its flow slice with its comma; the
   * last item leaves `[]`. A flow item's slice starts at its anchor and tag,
   * so neither is left on the item after it.
   */
  private removeItem(seqPath: Path, index: number): void {
    this.protect([...seqPath, index], "replace");
    const seq = this.seqAt(seqPath);
    const item = seq.items[index];
    if (!isNode(item)) return notExpressible("a pair inside a sequence");
    if (seq.flow && this.spansLines(seq)) {
      // Spread over lines: the item goes with its comma and its own comments, the others' kept.
      this.apply(this.flowRemovals(seq, new Set([index])));
      return;
    }
    if (seq.items.length === 1) {
      // On one line, nothing but the item and a comma can be between the brackets (`[a,]` too).
      if (seq.flow) this.apply([{ start: this.rangeOf(seq)[0], end: this.rangeOf(seq)[1], text: "[]" }]);
      else this.replaceValueAt(seqPath, () => ({ head: "[]", lines: [] }));
      return;
    }
    if (seq.flow) {
      const next = seq.items[index + 1];
      const previous = seq.items[index - 1];
      if (next !== undefined && !isNode(next)) return notExpressible("a pair inside a sequence");
      if (next === undefined && !isNode(previous)) return notExpressible("a pair inside a sequence");
      this.apply([
        next
          ? { start: this.propsStart(item), end: this.propsStart(next), text: "" }
          : { start: this.contentEnd(previous as YamlNode), end: this.contentEnd(item), text: "" },
      ]);
      return;
    }
    const [first, last] = this.itemRegion(seq, index);
    this.apply([this.deleteLines(first, last)]);
  }

  /**
   * A list item's own text: its region's lines in a block list, with the
   * comment lines directly above it; its source slice in a flow list, with
   * its anchor and tag.
   */
  itemSource(seqPath: Path, index: number): string {
    const seq = this.seqAt(seqPath);
    const item = seq.items[index];
    if (!isNode(item)) return notExpressible("a pair inside a sequence");
    if (seq.flow) return this.text.slice(this.propsStart(item), this.contentEnd(item));
    const [first, last] = this.itemRegion(seq, index);
    const lines: string[] = [];
    for (let line = this.attachedCommentsStart(first, this.column(this.dashOffset(seq, index))); line <= last; line++) {
      lines.push(this.lineText(line));
    }
    return lines.join("\n");
  }

  /**
   * List item `from` moved to index `to`: its lines, with the comment lines
   * directly above it, cut and put back by the target's; in a one-line flow
   * list, the items' source slices (anchors and tags included) move between
   * the separators; in one spread over lines, the item with its comments
   * (`flowMoveEdits`). Nothing is reprinted, so the item keeps `0750`, its
   * quoting and its comments. The list's order changes, so an alias of the
   * list (or of what holds it) gets its own copy; the item's own anchors keep
   * their values, so only an alias of one the move would put before it (in an
   * item it moves down past) gets a copy. An alias moved above its anchor
   * fails the re-parse.
   */
  moveItem(seqPath: Path, from: number, to: number): void {
    const length = this.seqAt(seqPath).items.length;
    if (from >= length || to >= length) return notExpressible("a move past the end of a list");
    if (from === to) return;
    this.protect(seqPath, "inside");
    if (to > from) this.copyAliasesPassed(seqPath, from, to);
    const seq = this.seqAt(seqPath);
    if (seq.flow && this.spansLines(seq)) {
      // Every comment an item had stays its own, or the move is refused.
      const saved = this.save();
      const owners = this.flowCommentOwners(seq);
      this.apply(this.flowMoveEdits(seq, from, to));
      const after = this.flowCommentOwners(this.seqAt(seqPath));
      // As many of each comment as before, and as many of each with its item as before.
      const kept = (key: (entry: [string, string | null]) => string | undefined) => {
        const now = tally(after, key);
        return [...tally(owners, key)].every(([entry, count]) => (now.get(entry) ?? 0) >= count);
      };
      if (!kept(([comment]) => comment) || !kept(([comment, owner]) => (owner === null ? undefined : JSON.stringify([comment, owner])))) {
        this.restore(saved);
        notExpressible("a move of a commented item in a flow sequence spread over lines");
      }
      return;
    }
    if (seq.flow) {
      const slices = seq.items.map((item) => {
        if (!isNode(item)) return notExpressible("a pair inside a sequence");
        return { start: this.propsStart(item), end: this.contentEnd(item) };
      });
      const order = slices.map((_slice, index) => index);
      order.splice(to, 0, ...order.splice(from, 1));
      const edits: Edit[] = [];
      for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
        const source = slices[order[index]!]!;
        edits.push({ ...slices[index]!, text: this.text.slice(source.start, source.end) });
      }
      this.apply(edits);
      return;
    }
    const column = this.column(this.dashOffset(seq, from));
    const [itemFirst, last] = this.itemRegion(seq, from);
    const first = this.attachedCommentsStart(itemFirst, column);
    const lines: string[] = [];
    for (let line = first; line <= last; line++) lines.push(this.lineText(line));
    const [targetFirst, targetLast] = this.itemRegion(seq, to);
    const insert =
      to > from
        ? this.insertAfterLine(targetLast, lines)
        : this.insertBeforeLine(this.attachedCommentsStart(targetFirst, column), lines);
    this.apply([this.deleteLines(first, last), insert]);
  }

  /**
   * The comments between a flow sequence's items, each by its text with the
   * source of the item it belongs to: a comment line, the item it is a
   * comment line of (`flowLeadLine`); a comment after text on its line, the
   * first item ending on that line. Others (`[ # c`, a comment line apart)
   * belong to none, null. A move compares them as a multiset, so two
   * comments with the same text don't make it refuse. The items' end lines
   * and comment-line ranges are indexed once per call, so a long commented
   * list isn't scanned once per comment.
   */
  private flowCommentOwners(seq: YAMLSeq): Array<[string, string | null]> {
    const nodes = seq.items.map((item) => (isNode(item) ? item : notExpressible("a pair inside a sequence")));
    const [open, after] = this.rangeOf(seq);
    const commas = this.flowCommas(nodes, after - 1);
    const source = (node: YamlNode) => this.text.slice(this.propsStart(node), this.contentEnd(node));
    // The first item ending on each line, and, for each comment line of an item starting its line, that item.
    const endingOn = new Map<number, YamlNode>();
    const leadOf = new Map<number, YamlNode>();
    nodes.forEach((node, index) => {
      const endLine = this.endLineOf(this.contentEnd(node));
      if (!endingOn.has(endLine)) endingOn.set(endLine, node);
      const start = this.propsStart(node);
      const itemLine = this.lineOf(start);
      if (this.text.slice(this.lineStart(itemLine), start).trim() !== "") return;
      for (let line = this.flowLeadLine(nodes, commas, open, index); line < itemLine; line++) {
        if (!leadOf.has(line)) leadOf.set(line, node);
      }
    });
    const owners: Array<[string, string | null]> = [];
    const gaps: Array<[number, number]> = [];
    let from = open + 1;
    for (const node of nodes) {
      gaps.push([from, this.propsStart(node)]);
      from = this.contentEnd(node);
    }
    gaps.push([from, after - 1]);
    for (const [start, end] of gaps) {
      for (let i = start; i < end; i++) {
        if (this.text[i] !== "#") continue;
        const line = this.lineOf(i);
        const stop = Math.min(end, this.lineContentEnd(line));
        const text = this.text.slice(i, stop).trimEnd();
        const owner = this.text.slice(this.lineStart(line), i).trim() !== "" ? endingOn.get(line) : leadOf.get(line);
        owners.push([text, owner ? source(owner) : null]);
        i = stop;
      }
    }
    return owners;
  }

  /**
   * Item `from` of a flow sequence spread over lines moved to index `to`
   * with its own comments: it goes as `flowRemovals` takes it (its comment
   * lines, its comma, the comment after it on a line of its own), and comes
   * back before item `to`'s comment lines, moving up, or after item `to`'s
   * line, moving down, on a line of its own at that item's indentation (or
   * its own); next to an item sharing its line, it goes inline (`x, a`).
   * The commas follow the order: the item that ends up last has one only
   * when the old last did. An item with comments that can't have a line of
   * its own there, or with a comment before its comma, is refused.
   */
  private flowMoveEdits(seq: YAMLSeq, from: number, to: number): Edit[] {
    const nodes = seq.items.map((item) => (isNode(item) ? item : notExpressible("a pair inside a sequence")));
    const [open, after] = this.rangeOf(seq);
    const commas = this.flowCommas(nodes, after - 1);
    const last = nodes.length - 1;
    const refuse = () => notExpressible("a move of a commented item in a flow sequence spread over lines");
    const prefix = (node: YamlNode): string | undefined => {
      const start = this.propsStart(node);
      const before = this.text.slice(this.lineStart(this.lineOf(start)), start);
      return before.trim() === "" ? before : undefined;
    };
    const afterOf = (index: number) => (commas[index] === -1 ? this.contentEnd(nodes[index]!) : commas[index]! + 1);
    const restOf = (index: number) => this.text.slice(afterOf(index), this.lineContentEnd(this.lineOf(afterOf(index))));

    const moved = nodes[from]!;
    const start = this.propsStart(moved);
    const content = this.text.slice(start, this.contentEnd(moved));
    if (commas[from] !== -1 && this.text.slice(this.contentEnd(moved), commas[from]).includes("#")) return refuse();
    const own = prefix(moved);
    const leadLines: string[] = [];
    if (own !== undefined) {
      const line = this.lineOf(start);
      for (let first = this.flowLeadLine(nodes, commas, open, from); first < line; first++) leadLines.push(this.lineText(first));
    }
    // The comment after it is its own when no other item is before it on its line (the first item may follow the `[`).
    const rest = restOf(from);
    const trailing = (own !== undefined || from === 0) && /^[ \t]*#/.test(rest) ? rest.replace(/[ \t]+$/, "") : "";
    const commented = leadLines.length > 0 || trailing !== "";
    const lines = (indent: string, comma: boolean) => {
      const lead = leadLines.map((text) => (own !== undefined && text.startsWith(own) ? indent + text.slice(own.length) : text));
      return [...lead, `${indent}${content}${comma ? "," : ""}${trailing}`].map((text) => `${text}\n`).join("");
    };

    const edits = this.flowRemovals(seq, new Set([from]));
    // After the `[`, its removal leaves the comment, which goes with it.
    if (own === undefined && trailing !== "") edits.push({ start: afterOf(from), end: this.lineContentEnd(this.lineOf(afterOf(from))), text: "" });
    const target = nodes[to]!;
    const targetIndent = prefix(target);
    const bracketIndent = /^[ \t]*/.exec(this.lineText(this.lineOf(open)))![0];
    // The indentation of a new line for an item: an item's that starts its line, or a unit past the `[`'s line.
    const firstIndent = nodes.map(prefix).find((indent) => indent !== undefined) ?? bracketIndent + " ".repeat(this.unit);
    if (to < from) {
      if (targetIndent !== undefined) {
        const at = this.lineStart(this.flowLeadLine(nodes, commas, open, to));
        edits.push({ start: at, end: at, text: lines(targetIndent, true) });
      } else if (to === 0) {
        // The first item follows the `[`: this one takes its place there (its comment lines on lines of their own after
        // the `[`), and that one goes to the next line.
        const indent = own ?? firstIndent;
        const at = this.propsStart(target);
        if (leadLines.length === 0) edits.push({ start: at, end: at, text: `${content},${trailing}\n${indent}` });
        else edits.push({ start: open + 1, end: at, text: `\n${lines(indent, true)}${indent}` });
      } else if (commented) {
        return refuse();
      } else {
        const at = this.propsStart(target);
        edits.push({ start: at, end: at, text: `${content}, ` });
      }
      return edits;
    }
    // Moving down: after item `to`, the last item now when `to` was.
    const comma = to < last || commas[last] !== -1;
    const endLine = this.lineOf(afterOf(to));
    const indent = own ?? targetIndent ?? firstIndent;
    const closing = /^[ \t]*\]/.exec(restOf(to));
    if (/^[ \t]*(?:#.*)?$/.test(restOf(to)) && endLine + 1 < this.lineCount) {
      const at = this.lineStart(endLine + 1);
      edits.push({ start: at, end: at, text: lines(indent, comma) });
      if (commas[to] === -1) {
        const end = this.contentEnd(target);
        edits.push({ start: end, end, text: "," });
      }
    } else if (commented && to === last && closing) {
      // The `]` follows the last item on its line: this one goes on a line of its own, the `]` on the next, at the
      // indentation of the `[`'s line.
      const at = afterOf(to);
      const text = `${commas[to] === -1 ? "," : ""}\n${lines(indent, comma)}${bracketIndent}`;
      edits.push({ start: at, end: at + closing[0].length - 1, text });
    } else if (commented) {
      return refuse();
    } else if (commas[to] !== -1) {
      edits.push({ start: commas[to]! + 1, end: commas[to]! + 1, text: ` ${content},` });
    } else {
      const end = this.contentEnd(target);
      edits.push({ start: end, end, text: `, ${content}` });
    }
    return edits;
  }

  /**
   * Before item `from` moves down to `to`: each alias, in the items it
   * passes, of an anchor in it (its own or one inside it) gets its own copy,
   * since it would come before its anchor. Aliases anywhere else stay as
   * they are.
   */
  private copyAliasesPassed(seqPath: Path, from: number, to: number): void {
    for (let fixes = 0; fixes < MAXIMUM_FIXES; fixes++) {
      if (this.aliases().length === 0) return;
      const seq = this.seqAt(seqPath);
      const moved = seq.items[from];
      const first = seq.items[from + 1];
      const last = seq.items[to];
      if (!isNode(moved) || !isNode(first) || !isNode(last)) return notExpressible("a pair inside a sequence");
      const anchored = new Set<unknown>();
      visit(moved, {
        Node: (_key, node) => {
          if (node.anchor) anchored.add(node);
        },
      });
      if (anchored.size === 0) return;
      const start = this.rangeOf(first)[0];
      const end = this.contentEnd(last);
      const use = this.aliases().find(({ alias }) => {
        const at = this.rangeOf(alias)[0];
        return at >= start && at < end && anchored.has(alias.resolve(this.document));
      });
      if (!use) return;
      this.copyAliasUse(use);
    }
    notExpressible("too many aliases to copy");
  }

  /**
   * A mapping key renamed in place through its own token, as
   * `renameComponent` renames: its place, quoting style, comment and value
   * stay. A key the map has only from a merge is copied onto it first, and a
   * merge that also gives it is expanded without it (it would come back). A
   * name the map already has, its own or merged, is refused.
   */
  renameKey(mapPath: Path, from: string, to: string): void {
    this.prepare(mapPath);
    const map = this.mapAt(mapPath);
    if (!this.ownPair(map, from) && !this.mergedPair(map, from)) return notExpressible("a key that isn't there");
    if (from === to) return;
    if (this.ownPair(map, to) || this.mergedPair(map, to)) throw new TextEditError("A key with that name is already there.");
    this.protect(mapPath, "inside");
    const merged = this.mergedPair(this.mapAt(mapPath), from);
    if (!this.ownPair(this.mapAt(mapPath), from) && merged) {
      this.insertPair(mapPath, from, (flow) => this.copyFragment(merged.value, flow), { protect: false });
    }
    if (this.mergeGives(this.mapAt(mapPath), from)) {
      const parentOf = () =>
        mapPath.length === 0 || typeof mapPath[mapPath.length - 1] === "number"
          ? undefined
          : { map: this.mapAt(mapPath.slice(0, -1)), pair: this.pairAt(mapPath) };
      this.expandMerge(this.mapAt(mapPath), parentOf);
    }
    const fresh = this.mapAt(mapPath);
    const pair = this.ownPair(fresh, from);
    if (!pair || !isScalar(pair.key)) return notExpressible("a complex key");
    this.apply([this.scalarEdit(pair.key, to, fresh.flow ? "flowKey" : "key")]);
  }

  // ── Components, pipelines, extensions ──

  renameComponent(from: string, to: string, current: Model): void {
    const [section, oldName] = splitKey(from);
    const newName = splitKey(to)[1];
    this.prepare([section]);
    this.protect([section], "inside");
    const map = this.mapAt([section]);
    const pair = this.ownPair(map, oldName);
    if (!pair || !isScalar(pair.key)) return notExpressible("a component that isn't its section's own key");
    const edits = [this.scalarEdit(pair.key, newName, map.flow ? "flowKey" : "key")];

    const connectorNamed = current.components.has(`connectors.${oldName}`);
    const lists: readonly PipelineList[] =
      section === "receivers" || section === "exporters"
        ? connectorNamed
          ? []
          : [section]
        : section === "processors"
          ? ["processors"]
          : section === "connectors"
            ? ["receivers", "exporters"]
            : [];
    const renameIn = (seq: unknown) => {
      if (!isSeq(seq)) return;
      for (const item of seq.items) {
        if (isScalar(item) && item.value === oldName) edits.push(this.scalarEdit(item, newName, seq.flow ? "flow" : "block"));
      }
    };
    const pipelines = this.valueAt(["service", "pipelines"]);
    if (isMap(pipelines) && lists.length > 0) {
      for (const pipeline of pipelines.items) {
        if (!isMap(pipeline.value)) continue;
        for (const list of lists) renameIn(this.ownPair(pipeline.value, list)?.value);
      }
    }
    if (section === "extensions") renameIn(this.valueAt(["service", "extensions"]));
    this.apply(edits);
  }

  removeComponents(keys: readonly string[], after: Model): void {
    const bySection = new Map<string, string[]>();
    for (const key of keys) {
      const [section, name] = splitKey(key);
      bySection.set(section, [...(bySection.get(section) ?? []), name]);
    }
    for (const [section, names] of bySection) {
      const stays = [...after.components.keys()].some((key) => splitKey(key)[0] === section);
      if (!stays && this.hasOwnKey([section])) {
        // Nothing stays in the section: it goes.
        this.protect([section], "replace");
        this.deleteOwnPair([], section);
        continue;
      }
      this.removeKeys([section], names);
    }
  }

  addComponent(section: string, name: string, value: unknown): void {
    if (!this.hasOwnKey([section])) {
      const later = SECTION_ORDER.slice(SECTION_ORDER.indexOf(section) + 1);
      this.insertPair(
        [],
        section,
        () => ({ head: "", lines: TextEditor.pairLines(this.unit, keyText(name, false), this.fragment(value)) }),
        { before: later },
      );
      return;
    }
    this.prepare([section]);
    this.insertPair([section], name, (flow) => this.fragment(value, { flow }));
  }

  private static pipelineValue(lists: PipelineLists): Record<string, string[]> | null {
    const value: Record<string, string[]> = {};
    for (const list of PIPELINE_LISTS) if (lists[list].length > 0) value[list] = lists[list];
    return Object.keys(value).length > 0 ? value : null;
  }

  applyPipelines(current: Map<string, PipelineLists>, after: Map<string, PipelineLists>): void {
    const removed = [...current.keys()].filter((name) => !after.has(name));
    if (removed.length > 0) this.removeKeys(["service", "pipelines"], removed);

    for (const [name, lists] of after) {
      const before = current.get(name);
      if (!before) continue;
      PIPELINE_LISTS.forEach((list, index) => {
        if (listsEqual(before[list], lists[list])) return;
        const path = ["service", "pipelines", name];
        this.prepare(path.slice(0, -1));
        if (isMap(this.valueAt(path)) || isAlias(this.valueAt(path))) this.prepare(path);
        const pipeline = this.valueAt(path);
        if (isMap(pipeline) && this.ownPair(pipeline, list)) {
          this.setKey(path, list, lists[list], { flowSeqs: true });
        } else if (lists[list].length > 0) {
          this.insertPair(path, list, (flow) => this.fragment(lists[list], { flow, flowSeqs: true }), {
            before: PIPELINE_LISTS.slice(index + 1),
          });
        }
      });
    }

    for (const [name, lists] of after) {
      if (current.has(name)) continue;
      const value = TextEditor.pipelineValue(lists);
      const pipelineLines = () => TextEditor.pairLines(this.unit, keyText(name, false), this.fragment(value, { flowSeqs: true }));
      if (!this.hasOwnKey(["service"])) {
        this.insertPair([], "service", () => ({
          head: "",
          lines: TextEditor.pairLines(this.unit, "pipelines", { head: "", lines: pipelineLines() }),
        }));
      } else if (!this.hasOwnKey(["service", "pipelines"])) {
        this.prepare(["service"]);
        this.insertPair(["service"], "pipelines", () => ({ head: "", lines: pipelineLines() }));
      } else {
        this.prepare(["service", "pipelines"]);
        this.insertPair(["service", "pipelines"], name, (flow) => this.fragment(value, { flow, flowSeqs: true }));
      }
    }
  }

  applyExtensions(names: readonly string[]): void {
    if (!this.hasOwnKey(["service"])) {
      this.insertPair([], "service", () => ({
        head: "",
        lines: TextEditor.pairLines(this.unit, "extensions", this.fragment(names, { flowSeqs: true })),
      }));
      return;
    }
    this.prepare(["service"]);
    if (this.hasOwnKey(["service", "extensions"])) {
      this.setKey(["service"], "extensions", names, { flowSeqs: true });
      return;
    }
    this.insertPair(["service"], "extensions", (flow) => this.fragment(names, { flow, flowSeqs: true }), {
      before: ["pipelines"],
    });
  }

  // ── The YAML box ──

  /** The component's value as the text writes it, below or after its key, at column 0. */
  componentText(path: Path): string {
    const pair = this.pairAt(path);
    const colon = this.colonEnd(pair);
    const keyLine = this.lineOf(colon - 1);
    const column = indentOf(this.lineText(keyLine));
    const value = pair.value;
    const empty = this.isEmptyNode(value);
    const lastLine = this.extendOverComments(empty ? keyLine : this.endLineOf(this.contentEnd(value as YamlNode)), column);
    const dedent = (lines: string[]) => {
      const indents = lines.filter((line) => line.trim() !== "").map(indentOf);
      const from = indents.length > 0 ? Math.min(...indents) : 0;
      return lines.map((line) => rebase(line, from, 0));
    };
    const below = (first: number) => {
      const lines: string[] = [];
      for (let line = first; line <= lastLine; line++) lines.push(this.lineText(line));
      return lines;
    };
    if (!empty && this.lineOf(this.rangeOf(value as YamlNode)[0]) === keyLine) {
      const [first, ...rest] = splitLines(this.text.slice(this.rangeOf(value as YamlNode)[0], this.lineContentEnd(lastLine)));
      return [first!.trimEnd(), ...dedent(rest)].join("\n");
    }
    return dedent(below(keyLine + 1)).join("\n");
  }

  /** The component's value replaced by the box's text, comments and all, laid out under its key. */
  replaceWithBox(path: Path, boxText: string, boxIsFlowLine: boolean): void {
    const map = this.mapAt(path.slice(0, -1));
    const pair = this.pairAt(path);
    const lines = splitLines(boxText);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    const indents = lines.filter((line) => line.trim() !== "").map(indentOf);
    const from = indents.length > 0 ? Math.min(...indents) : 0;
    const box = lines.map((line) => rebase(line, from, 0));

    if (map.flow) {
      if (box.length > 1) notExpressible("a block value inside a flow mapping");
      this.replacePairValue(map, pair, { head: box[0]?.trim() ?? "", lines: [] });
      return;
    }
    const colon = this.colonEnd(pair);
    const keyLine = this.lineOf(colon - 1);
    const column = indentOf(this.lineText(keyLine));
    const value = pair.value;
    const empty = this.isEmptyNode(value);
    const inline = !empty && this.lineOf(this.rangeOf(value as YamlNode)[0]) === keyLine;
    const lastLine = this.extendOverComments(empty ? keyLine : this.endLineOf(this.contentEnd(value as YamlNode)), column);
    // What stays on the key's line: the props before an inline value, or everything after a block one.
    const rest = inline
      ? this.text.slice(colon, this.rangeOf(value as YamlNode)[0]).trimEnd()
      : this.text.slice(colon, this.lineContentEnd(keyLine)).trimEnd();
    let text: string;
    if (box.length === 0) {
      text = rest;
    } else if (boxIsFlowLine && box.length === 1) {
      const comment = commentIn(rest);
      const props = comment === "" ? rest : rest.slice(0, rest.lastIndexOf(comment)).trimEnd();
      text = `${props} ${box[0]!.trim()}${comment === "" ? "" : ` ${comment}`}`;
    } else {
      text = rest + this.eol + box.map((line) => indentLine(line, column + this.unit)).join(this.eol);
    }
    this.apply([{ start: colon, end: this.lineContentEnd(lastLine), text }]);
  }

  // ── The anchors a text defines ──

  anchorNames(outside?: YamlNode): Set<string> {
    const names = new Set<string>();
    const [start, end] = outside ? [this.rangeOf(outside)[0], this.contentEnd(outside)] : [Infinity, -Infinity];
    visit(this.document, {
      Node: (_key, node) => {
        if (!node.anchor || !node.range) return;
        if (node.range[0] >= start && node.range[0] < end) return;
        names.add(node.anchor);
      },
    });
    return names;
  }
}

// ── The contract ───────────────────────────────────────────────────────────

/** An edited text, with its document and the model it describes, for the next edit to start from. */
export interface EditedText {
  text: string;
  /** The parse of `text`, as `PARSE_OPTIONS` reads it (duplicate keys checked). */
  document: ParsedText;
  /** `readTextModel(document)`. */
  model: Model;
}

/**
 * The text with the difference between `textModel` (the model the text
 * describes, `readTextModel`) and `after` (`deriveModel` of the graph after
 * the change) written into it, and nothing else, with the edited text's
 * document and its model, so the editor's store doesn't parse the text
 * again before the next change (a parse of a very large text costs about
 * 220 ms). Throws `TextEditError` when a difference can't be written as a
 * splice, or the result doesn't describe `after`.
 */
export function editText(text: string, textModel: Model, after: Model, options: GraphChangeOptions = {}): EditedText {
  const editor = new TextEditor(text, options.document);
  const target: Model = {
    components: new Map([...after.components].map(([key, value]) => [key, normalized(value)])),
    pipelines: after.pipelines,
    extensions: after.extensions,
    undeclared: after.undeclared,
  };
  let current = textModel;

  const renames = (options.renames ?? []).filter(
    ({ from, to }) =>
      from !== to &&
      splitKey(from)[0] === splitKey(to)[0] &&
      current.components.has(from) &&
      !current.components.has(to) &&
      target.components.has(to) &&
      !target.components.has(from),
  );
  if (renames.length > 0) {
    for (const { from, to } of renames) editor.renameComponent(from, to, current);
    current = readTextModel(editor.document);
  }

  const removed = [...current.components.keys()].filter((key) => !target.components.has(key));
  if (removed.length > 0) editor.removeComponents(removed, target);

  for (const [key, value] of target.components) {
    if (current.components.has(key)) editor.applyValue(splitKey(key), current.components.get(key), value);
  }

  for (const section of COMPONENT_SECTIONS) {
    for (const [key, value] of target.components) {
      const [keySection, name] = splitKey(key);
      if (keySection === section && !current.components.has(key)) editor.addComponent(section, name, value);
    }
  }

  editor.applyPipelines(current.pipelines, target.pipelines);
  if (!listsEqual(current.extensions, target.extensions)) editor.applyExtensions(target.extensions);

  const model = readTextModel(editor.document);
  if (options.verify !== false && !modelsEqual(model, target)) {
    throw new TextEditError("The edited text doesn't describe the change.");
  }
  return { text: editor.text, document: editor.document, model };
}

// ── Values by key path ─────────────────────────────────────────────────────

/** A value as the whole document reads it, for the check that nothing outside `base` changed. */
function wholeValue(document: ParsedText): unknown {
  try {
    return document.toJS({ maxAliasCount: MAXIMUM_ALIAS_COUNT });
  } catch {
    throw new TextEditError("An edit left a value that doesn't resolve.");
  }
}

function nodeValue(document: ParsedText, node: unknown): unknown {
  return isNode(node) ? node.toJS(document, { maxAliasCount: MAXIMUM_ALIAS_COUNT }) : null;
}

function isPathSegment(segment: unknown): segment is string | number {
  return typeof segment === "string" || (Number.isSafeInteger(segment) && (segment as number) >= 0);
}

/**
 * The number characters read as, written plain in a block and in a flow
 * collection, when they are all one scalar (`1 # c` isn't). A form's
 * number field asks it which change to send: a number is a `plain`
 * change, anything else a string (`plainValue` gates the change).
 */
export function plainNumber(source: string): number | undefined {
  if (/[\r\n\t]/.test(source) || source !== source.trim() || source === "") return undefined;
  let read: number | undefined;
  for (const probe of [`k: ${source}\n`, `k: [${source}]\n`]) {
    const document = parseDocument(probe, { prettyErrors: false });
    const pair = isMap(document.contents) && document.contents.items.length === 1 ? document.contents.items[0] : undefined;
    const node = isSeq(pair?.value) && pair.value.items.length === 1 ? pair.value.items[0] : pair?.value;
    if (document.errors.length > 0 || !isScalar(node) || typeof node.value !== "number" || !node.range) return undefined;
    if (node.range[1] - node.range[0] !== source.length) return undefined;
    read = node.value;
  }
  return read;
}

/**
 * What a `plain` change's characters read as, or undefined when they
 * aren't written verbatim: they must read back, alone on one line in a
 * block and in a flow collection, as the same number, a boolean (any YAML
 * 1.2 core spelling: `true`, `True`, `TRUE`, …), or a flow mapping or
 * sequence (`{"k": "v"}`, `[1, a]`) with no anchor, alias or tag in it,
 * every key a string once per mapping (`stringKeysOnly`: `{1: a, "1": b}`
 * would read as one key), and nothing after it (`{} # c` isn't). A
 * string, a null or a block collection is written through `value`
 * instead. `NumberField` still asks `plainNumber`.
 *
 * A plain string inside a flow collection that the collector's yaml.v3 would
 * read as another type (`[2024-01-01]`, `{a: 1_000}`) is written
 * double-quoted, the rest as typed: `source` then says what is written
 * (`["2024-01-01"]`), which reads as the same value.
 */
export function plainValue(source: string): { value: unknown; source?: string } | undefined {
  if (/[\r\n\t]/.test(source) || source !== source.trim() || source === "") return undefined;
  const reads: unknown[] = [];
  for (const [probe, offset] of [
    [`k: ${source}\n`, 3],
    [`k: [${source}]\n`, 4],
  ] as const) {
    const document = parseDocument(probe, PARSE_OPTIONS);
    const pair = isMap(document.contents) && document.contents.items.length === 1 ? document.contents.items[0] : undefined;
    const node = offset === 4 ? (isSeq(pair?.value) && pair.value.items.length === 1 ? pair.value.items[0] : undefined) : pair?.value;
    if (document.errors.length > 0 || !isNode(node) || !node.range) return undefined;
    if (node.range[0] !== offset || node.range[1] - node.range[0] !== source.length) return undefined;
    if (isScalar(node)) {
      if (typeof node.value !== "number" && typeof node.value !== "boolean") return undefined;
    } else if (!((isMap(node) || isSeq(node)) && node.flow)) {
      return undefined;
    }
    let bound = false;
    visit(node, {
      Alias: () => {
        bound = true;
        return visit.BREAK;
      },
      Node: (_key, inner) => {
        if (!inner.anchor && !inner.tag) return undefined;
        bound = true;
        return visit.BREAK;
      },
    });
    if (bound || ((isMap(node) || isSeq(node)) && !stringKeysOnly(node))) return undefined;
    try {
      reads.push(node.toJS(document, { maxAliasCount: MAXIMUM_ALIAS_COUNT }));
    } catch {
      return undefined;
    }
  }
  if (!valuesEqual(reads[0], reads[1])) return undefined;
  const written = quoteMisread(source);
  return written === source ? { value: reads[0] } : { value: reads[0], source: written };
}

/**
 * A flow collection's characters with each plain string the collector
 * would read as another type (keys included) double-quoted, and
 * everything else as typed.
 */
function quoteMisread(source: string): string {
  const offset = "k: ".length;
  const document = parseDocument(`k: ${source}\n`, PARSE_OPTIONS);
  const spans: Array<{ start: number; end: number; value: string }> = [];
  visit(document, {
    Scalar: (_key, scalar) => {
      if (scalar.type !== "PLAIN" || typeof scalar.value !== "string" || !collectorReadsAsOther(scalar.value) || !scalar.range) {
        return undefined;
      }
      spans.push({ start: scalar.range[0] - offset, end: scalar.range[1] - offset, value: scalar.value });
      return undefined;
    },
  });
  let written = source;
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    written = written.slice(0, span.start) + quoteDouble(span.value) + written.slice(span.end);
  }
  return written;
}

function has(value: unknown, segment: string | number): boolean {
  if (typeof segment === "number") return Array.isArray(value) && segment < value.length;
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, segment);
}

function at(value: unknown, segment: string | number): unknown {
  return (value as Record<string | number, unknown>)[segment];
}

function without(value: unknown, segment: string | number): unknown {
  if (Array.isArray(value)) return value.filter((_item, index) => index !== segment);
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[segment];
  return copy;
}

function withAt(value: unknown, segment: string | number, item: unknown): unknown {
  if (Array.isArray(value)) return value.map((old, index) => (index === segment ? item : old));
  return { ...(value as Record<string, unknown>), [segment]: item };
}

/** Whether a value set holds a string with a line break anywhere in it. */
function holdsBreak(value: unknown): boolean {
  if (typeof value === "string") return /[\r\n]/.test(value);
  if (Array.isArray(value)) return value.some(holdsBreak);
  return isPlainObject(value) && Object.values(value).some(holdsBreak);
}

function isEmptyCollection(value: unknown): boolean {
  return (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);
}

/**
 * `before` and `after` (whole documents' values) with what's at `path`
 * taken out of both, and, where `before` hadn't the path, what `after`
 * gained there (the mappings created on the way to a missing `base`; a
 * `service:` with no value that became a mapping reads as before).
 */
function outsidePath(before: unknown, after: unknown, path: ValuePath): [unknown, unknown] {
  const [segment, ...rest] = path as [string | number, ...Array<string | number>];
  if (!has(before, segment)) {
    const trimmed = has(after, segment) ? without(after, segment) : after;
    return [before, before === null && isEmptyCollection(trimmed) ? null : trimmed];
  }
  if (rest.length === 0 || !has(after, segment)) {
    return [without(before, segment), has(after, segment) ? without(after, segment) : after];
  }
  const [innerBefore, innerAfter] = outsidePath(at(before, segment), at(after, segment), rest);
  return [withAt(before, segment, innerBefore), withAt(after, segment, innerAfter)];
}

/**
 * Whether the value at `base` (a component's) reads as before apart from
 * what's at the `edited` paths below it, so a splice that changes another
 * of its values (an anchor's alias re-bound by a moved item) is refused. A
 * `base` the text hadn't is new: its changes are each read back. The paths
 * are taken out last index first, so taking one out doesn't shift
 * another's; a list moved or with an item removed is taken out whole, so
 * the changes' paths, each read against the text the earlier ones left,
 * still name the same values in the text before.
 */
function onlyEditedChanged(before: unknown, after: unknown, base: ValuePath, edited: readonly ValuePath[]): boolean {
  let was = before;
  let now = after;
  for (const segment of base) {
    if (!has(was, segment)) return true;
    if (!has(now, segment)) return false;
    was = at(was, segment);
    now = at(now, segment);
  }
  const order = (a: ValuePath, b: ValuePath): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const [x, y] = [a[i]!, b[i]!];
      if (x === y) continue;
      if (typeof x === "number" && typeof y === "number") return y - x;
      return String(y) < String(x) ? -1 : 1;
    }
    return b.length - a.length;
  };
  for (const path of [...edited].sort(order)) [was, now] = outsidePath(was, now, path);
  return valuesEqual(was, now);
}

/**
 * The text with `changes` written under `base` (`["receivers", "otlp"]`,
 * `["service", "telemetry"]`), each at `[...base, ...change.path]`, in
 * order, each path read against the text the earlier changes left. Every
 * change is a splice through the editor, with its alias, merge and anchor
 * protection; consecutive changes of a scalar in place share one parse.
 * Each change is checked as it reads back (a set value as set, a removed
 * key absent, a list with the item gone or moved, the moved item's own
 * text unchanged, a renamed key's value under its new name), and the
 * whole document's value outside `base`, and the component's apart from
 * what the changes edit (`onlyEditedChanged`), must be the same before
 * and after; a remove, move or rename also leaves the component as before
 * apart from its own paths, compared across that change alone. Throws
 * `TextEditError` when a change can't be written as a splice, a path
 * leaves `base`, or a check fails; the text isn't touched then (the
 * caller keeps it).
 */
export function writeValues(
  text: string,
  base: ValuePath,
  changes: readonly ValueChange[],
  document?: ParsedText,
): EditedText {
  if (base.length === 0 || !base.every(isPathSegment)) throw new TextEditError("A change's base isn't a value path.");
  const editor = new TextEditor(text, document);
  const before = wholeValue(editor.document);
  const pending: Array<{ edit: Edit; check: () => void }> = [];
  const flush = () => {
    if (pending.length === 0) return;
    editor.apply(pending.map(({ edit }) => edit));
    for (const { check } of pending) check();
    pending.length = 0;
  };
  const refuse = (): never => {
    throw new TextEditError("A change's path leaves the value it edits.");
  };
  const listAt = (path: Path) => {
    const list = nodeValue(editor.document, nodeAt(editor.document, path));
    return Array.isArray(list) ? list : refuse();
  };
  // What the changes edit, below `base`: the rest of the component must read as before.
  const edited: ValuePath[] = [];
  // The component's value as the text now reads it, kept while the text is the same.
  let component: { text: string; value: unknown } | undefined;
  const componentValue = () => {
    if (component?.text !== editor.text) component = { text: editor.text, value: nodeValue(editor.document, nodeAt(editor.document, base)) };
    return component.value;
  };
  // A remove, move or rename changes nothing in the component but what's at its own paths, compared
  // before and after that change: a later change can't re-bind an alias inside a path an earlier one
  // edited, which the check of the whole write, those paths taken out, can't see.
  const onlyThisChanged = (was: unknown, paths: readonly ValuePath[]) => {
    if (!onlyEditedChanged(was, componentValue(), [], paths)) throw new TextEditError("A change reached a value outside the one it edits.");
  };

  for (const change of changes) {
    if (!Array.isArray(change.path) || !change.path.every(isPathSegment)) refuse();
    const path: Path = [...base, ...change.path];
    const parentPath = path.slice(0, -1);
    const last = path[path.length - 1]!;
    const readBack = (ok: boolean) => {
      if (!ok) throw new TextEditError("A change didn't read back as written.");
    };

    if ("remove" in change) {
      // Removing, moving or renaming what `base` itself is would change what holds it.
      if (change.path.length === 0) refuse();
      flush();
      // A list item's removal moves the items after it: the list is what it edits.
      const removed = typeof last === "number" ? change.path.slice(0, -1) : change.path;
      edited.push(removed);
      const was = componentValue();
      const parent = nodeValue(editor.document, nodeAt(editor.document, parentPath));
      editor.removeValue(path);
      const after = nodeValue(editor.document, nodeAt(editor.document, parentPath));
      readBack(typeof last === "number" ? !has(parent, last) || valuesEqual(after, without(parent, last)) : !has(after, last));
      onlyThisChanged(was, [removed]);
      continue;
    }

    if ("moveTo" in change) {
      if (change.path.length === 0 || typeof last !== "number" || !isPathSegment(change.moveTo)) refuse();
      flush();
      edited.push(change.path.slice(0, -1));
      const was = componentValue();
      const index = last as number;
      const list = listAt(parentPath);
      if (index >= list.length || change.moveTo >= list.length) refuse();
      editor.prepare(parentPath);
      const source = editor.itemSource(parentPath, index);
      editor.moveItem(parentPath, index, change.moveTo);
      const moved = [...list];
      moved.splice(change.moveTo, 0, ...moved.splice(index, 1));
      readBack(valuesEqual(listAt(parentPath), moved) && editor.itemSource(parentPath, change.moveTo) === source);
      onlyThisChanged(was, [change.path.slice(0, -1)]);
      continue;
    }

    if ("renameTo" in change) {
      if (change.path.length === 0 || typeof last !== "string" || typeof change.renameTo !== "string") refuse();
      flush();
      const renamed: ValuePath[] = [change.path, [...change.path.slice(0, -1), change.renameTo]];
      edited.push(...renamed);
      const was = componentValue();
      const parent = nodeValue(editor.document, nodeAt(editor.document, parentPath));
      editor.renameKey(parentPath, last as string, change.renameTo);
      const after = nodeValue(editor.document, nodeAt(editor.document, parentPath));
      readBack(
        has(parent, last) &&
          valuesEqual(after, { ...(without(parent, last) as Record<string, unknown>), [change.renameTo]: at(parent, last) }),
      );
      onlyThisChanged(was, renamed);
      continue;
    }

    // Setting what `base` itself is would reprint its whole value: a change sets what's inside it.
    if (change.path.length === 0) refuse();
    edited.push(change.path);
    let value: unknown;
    let expected: unknown;
    if ("plain" in change) {
      const read = typeof change.plain === "string" ? plainValue(change.plain) : undefined;
      if (read === undefined) {
        throw new TextEditError("A value written as typed doesn't read as a number, a boolean or a flow collection.");
      }
      value = new PlainScalar(read.source ?? change.plain);
      expected = read.value;
    } else if ("value" in change) {
      value = normalized(change.value);
      expected = value;
    } else {
      return refuse();
    }
    const check = () => {
      const node = nodeAt(editor.document, path);
      readBack(node !== undefined && valuesEqual(nodeValue(editor.document, node), expected));
    };
    let edit = editor.scalarEditAt(path, value);
    if (edit && pending.some((waiting) => waiting.edit.start === edit!.start)) {
      flush();
      edit = editor.scalarEditAt(path, value);
    }
    if (edit) {
      pending.push({ edit, check });
      continue;
    }
    flush();
    if (!holdsBreak(value)) {
      editor.setValue(path, value);
      check();
      continue;
    }
    // A string with a line break whose block didn't read back as written (a comment line indented into it)
    // is written again, double-quoted, rather than refused.
    const saved = editor.save();
    try {
      editor.setValue(path, value);
      check();
    } catch (error) {
      if (!(error instanceof TextEditError)) throw error;
      editor.restore(saved);
      editor.quoteBreaks = true;
      try {
        editor.setValue(path, value);
        check();
      } finally {
        editor.quoteBreaks = false;
      }
    }
  }
  flush();

  const after = wholeValue(editor.document);
  const [outsideBefore, outsideAfter] = outsidePath(before, after, base);
  if (!valuesEqual(outsideBefore, outsideAfter) || !onlyEditedChanged(before, after, base, edited)) {
    throw new TextEditError("A change reached a value outside the one it edits.");
  }
  return { text: editor.text, document: editor.document, model: readTextModel(editor.document) };
}

/**
 * The component's own text for the Configuration tab's YAML box: its value
 * below its key (or after it, when written on the key's line), comments
 * included, at column 0 with `\n` line endings. `document`, when the caller
 * has the text's parse, saves parsing it again.
 */
export function componentValueText(text: string, key: string, document?: ParsedText): string {
  return new TextEditor(text, document).componentText(splitKey(key));
}

/**
 * Why the YAML box wasn't written: it doesn't read as a mapping (or empty),
 * or it defines an anchor the text defines elsewhere, which would re-bind
 * the text's later aliases.
 */
export type BoxWriteRefusal = "unreadable" | "anchor-clash";

/** The YAML box's text read as a component's value: a mapping, or empty. Null when it doesn't read so. */
function readBox(boxText: string): { box: Document.Parsed; value: unknown } | null {
  const box = parseDocument(boxText, PARSE_OPTIONS);
  if (box.errors.length > 0) return null;
  if (box.contents !== null && !isMap(box.contents)) return null;
  try {
    return { box, value: box.toJS({ maxAliasCount: MAXIMUM_ALIAS_COUNT }) };
  } catch {
    return null;
  }
}

/**
 * Whether the YAML box's text reads as a component's value, a mapping or
 * empty: what `writeComponentValue` needs before it writes. While it doesn't,
 * the box says so and nothing is written.
 */
export function boxTextReads(boxText: string): boolean {
  return readBox(boxText) !== null;
}

/**
 * The component's value in the text replaced by what the YAML box holds,
 * comments included (the calls are debounced). `{ ok: false }`, with why, when
 * the box doesn't read as a mapping (or empty) or reuses an anchor name the
 * text defines elsewhere: nothing is written. An empty box leaves the
 * component with no value (`otlp:`). `document`, when the caller has the
 * text's parse, saves parsing it again; the edited text's document and model
 * are kept (as `editText` does), so the editor's store doesn't parse the text
 * again.
 */
export function writeComponentValue(
  text: string,
  key: string,
  boxText: string,
  document?: ParsedText,
): ({ ok: true } & EditedText) | { ok: false; reason: BoxWriteRefusal } {
  const read = readBox(boxText);
  if (!read) return { ok: false, reason: "unreadable" };
  const { box, value: boxValue } = read;
  const contents = box.contents;

  const editor = new TextEditor(text, document);
  const path = splitKey(key);
  editor.prepare(path.slice(0, -1));
  const old = editor.valueAt(path);
  // An anchor the box defines that the text defines elsewhere would re-bind the text's later aliases.
  const boxAnchors = new Set<string>();
  visit(box, {
    Node: (_key, node) => {
      if (node.anchor) boxAnchors.add(node.anchor);
    },
  });
  if (boxAnchors.size > 0) {
    const elsewhere = editor.anchorNames(isNode(old) ? old : undefined);
    if ([...boxAnchors].some((name) => elsewhere.has(name))) return { ok: false, reason: "anchor-clash" };
  }

  editor.protect(path, "replace");
  const flowLine = isMap(contents) && (contents.flow ?? false);
  editor.replaceWithBox(path, boxText, flowLine);

  const written = editor.valueAt(path);
  const value = isNode(written) ? written.toJS(editor.document, { maxAliasCount: MAXIMUM_ALIAS_COUNT }) : null;
  if (!valuesEqual(value, boxValue ?? null)) throw new TextEditError("The box's value didn't reach the text.");
  return { ok: true, text: editor.text, document: editor.document, model: readTextModel(editor.document) };
}
