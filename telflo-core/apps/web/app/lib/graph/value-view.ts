import { CST, isAlias, isMap, isNode, isScalar, isSeq, visit } from "yaml";
import type { YAMLMap, YAMLSeq } from "yaml";

import { collectorReadsAsOther } from "./collector-scalars.js";
import type { ParsedText } from "./parse.js";
import type { ValuePath } from "./text-edits.js";

/*
 * What a form shows (D9b decision 3; Preflight ruling 9): a value read from
 * the text's document, not from a copy of the config.
 *
 * `readValue(document, base, path)` takes no text: in manual edit mode the
 * store's text is what was typed while its document is still the last one
 * that read, and a source sliced from one by the other's offsets would be
 * wrong. A plain scalar that isn't a string carries the characters it was
 * written with (`srcToken.source`): `0750`, which the collector reads as
 * octal and `yaml` as 750, shows `0750`; `1e3` and `0x1F` likewise. A string
 * (plain, quoted or block) shows its value. An explicit null (`key:`, `~`,
 * `null`) is unset, as is a missing key. Aliases resolve to what they name,
 * and a key a mapping gets from a merge (`<<`) reads as the merge gives it:
 * its own keys first, then each merge's in order, as `mergedPairs` in the
 * text edits.
 *
 * A flow mapping or sequence written on one line, with no anchor, alias or
 * tag in it and only string keys (`{"k": "v"}`, `[1, a]`), carries its characters too (D9c
 * Preflight ruling 2): the add operator's value shows what was typed, and
 * the text edits' `plain` writes it back as typed. A block collection
 * carries none.
 *
 * A form reads a few dozen paths on each render. Each mapping's keys are
 * indexed once per document (a `WeakMap` keyed by the mapping node), so a
 * key in a section of 6,000 components isn't found by a scan each time.
 */

/** How many aliases a read may follow in a row, or resolve in a value (`yaml`'s default). */
const MAXIMUM_ALIAS_COUNT = 100;

/** A scalar's value as the core schema reads it. */
export type ScalarValue = string | number | boolean | bigint;

export type ValueView =
  | { kind: "absent"; value: undefined }
  | { kind: "scalar"; value: ScalarValue; source?: string }
  | { kind: "map"; value: Record<string, unknown>; source?: string }
  | { kind: "list"; value: unknown[]; source?: string };

const ABSENT: ValueView = { kind: "absent", value: undefined };

const indexes = new WeakMap<YAMLMap, Map<string, unknown>>();

function resolve(node: unknown, document: ParsedText): unknown {
  let current = node;
  for (let i = 0; isAlias(current); i++) {
    if (i > MAXIMUM_ALIAS_COUNT) return undefined;
    current = current.resolve(document);
  }
  return current;
}

/** A mapping's keys as it reads them, each with its value node: its own first, then each merge's in order. */
function entriesOf(map: YAMLMap, document: ParsedText, depth = 0): Map<string, unknown> {
  const cached = indexes.get(map);
  if (cached) return cached;
  const entries = new Map<string, unknown>();
  const merges: unknown[] = [];
  for (const pair of map.items) {
    if (!isScalar(pair.key)) continue;
    const key = pair.key.value;
    if (typeof key === "symbol") merges.push(pair.value);
    else if (key !== null && key !== undefined && !entries.has(String(key))) entries.set(String(key), pair.value);
  }
  // A merge of a merge of … is bounded like an alias chain (an alias can't name its own anchor).
  if (depth <= MAXIMUM_ALIAS_COUNT) {
    for (const merge of merges) {
      for (const item of isSeq(merge) ? merge.items : [merge]) {
        const source = resolve(item, document);
        if (!isMap(source)) continue;
        for (const [key, value] of entriesOf(source, document, depth + 1)) if (!entries.has(key)) entries.set(key, value);
      }
    }
  }
  indexes.set(map, entries);
  return entries;
}

/**
 * The node at `path` from the document's top, aliases resolved and merged
 * keys read as merged: undefined when a key or an item isn't there (null
 * for an empty text's top).
 */
export function nodeAt(document: ParsedText, path: ValuePath): unknown {
  let node = resolve(document.contents, document);
  for (const segment of path) {
    if (typeof segment === "number") node = isSeq(node) ? node.items[segment] : undefined;
    else node = isMap(node) ? entriesOf(node, document).get(segment) : undefined;
    if (node === undefined) return undefined;
    node = resolve(node, document);
  }
  return node;
}

/**
 * Whether every mapping key in a node, at any depth, is a string written as
 * a plain or quoted scalar, once per mapping (D9c review): `{1: a, "1": b}`
 * reads as one key, `{true: 1}`, `{~: 1}`, `{[1]: 2}` and `[?]` have keys
 * that aren't strings, and a merge (`<<`) isn't a key. The text edits write
 * such characters as typed only when this holds, and a form shows them only
 * then.
 */
export function stringKeysOnly(node: YAMLMap | YAMLSeq): boolean {
  let only = true;
  const check = (map: YAMLMap) => {
    const seen = new Set<string>();
    for (const pair of map.items) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      if (typeof key !== "string" || seen.has(key)) {
        only = false;
        return;
      }
      seen.add(key);
    }
  };
  if (isMap(node)) check(node);
  visit(node, {
    Map: (_key, map) => {
      check(map);
      return only ? undefined : visit.BREAK;
    },
    Pair: (_key, pair) => {
      // A pair straight inside a sequence (`[a: 1]`, `[?]`) is a one-key mapping.
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") only = false;
      return only ? undefined : visit.BREAK;
    },
  });
  return only;
}

/** A one-line flow collection's characters, with nothing bound or tagged in it; undefined for anything else. */
function flowSource(node: YAMLMap | YAMLSeq): string | undefined {
  const token = node.srcToken;
  if (!node.flow || token?.type !== "flow-collection" || !node.range || token.offset !== node.range[0]) return undefined;
  const source = CST.stringify(token).slice(0, node.range[1] - node.range[0]);
  if (/[\r\n]/.test(source)) return undefined;
  let bound = false;
  visit(node, {
    Alias: () => {
      bound = true;
      return visit.BREAK;
    },
    Node: (_key, inner) => {
      // A plain string the collector reads as another type (Ruling 69) couldn't be written back as typed either.
      const other = isScalar(inner) && inner.type === "PLAIN" && typeof inner.value === "string" && collectorReadsAsOther(inner.value);
      if (!inner.anchor && !inner.tag && !other) return undefined;
      bound = true;
      return visit.BREAK;
    },
  });
  return bound || !stringKeysOnly(node) ? undefined : source;
}

/**
 * What a form shows at `path` under `base` (`["receivers", "otlp"]`,
 * `["service", "telemetry"]`): absent, a scalar (with the characters it was
 * written with when it is a plain non-string), a mapping or a list (their
 * values as the model reads them, and their characters when written as a
 * one-line flow collection).
 */
export function readValue(document: ParsedText, base: ValuePath, path: ValuePath): ValueView {
  const node = nodeAt(document, [...base, ...path]);
  if (isScalar(node)) {
    const value = node.value;
    if (value === null || value === undefined) return ABSENT;
    const shown: ScalarValue = ["string", "number", "boolean", "bigint"].includes(typeof value)
      ? (value as ScalarValue)
      : String(value);
    const token = node.srcToken;
    if (typeof shown === "string" || node.type !== "PLAIN" || token?.type !== "scalar") return { kind: "scalar", value: shown };
    return { kind: "scalar", value: shown, source: token.source };
  }
  if (!isNode(node) || (!isMap(node) && !isSeq(node))) return ABSENT;
  const value: unknown = node.toJS(document, { maxAliasCount: MAXIMUM_ALIAS_COUNT });
  const source = flowSource(node);
  const shown = source === undefined ? {} : { source };
  return isMap(node)
    ? { kind: "map", value: value as Record<string, unknown>, ...shown }
    : { kind: "list", value: value as unknown[], ...shown };
}
