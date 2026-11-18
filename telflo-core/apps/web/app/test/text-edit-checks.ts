import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from "yaml";
import type { Alias, Pair, YAMLMap } from "yaml";

import { readTextModel } from "../lib/graph/model.js";
import type { Model, PipelineLists } from "../lib/graph/model.js";
import { COMPONENT_SECTIONS, parse } from "../lib/graph/parse.js";
import type { ParsedText } from "../lib/graph/parse.js";
import type { Graph } from "../lib/graph/types.js";

/*
 * Checks the text-edit tests share (D9a Task 4): reading a text, copying a
 * model, a line diff, and an oracle for "every line outside the edit is
 * byte for byte the same" that doesn't use the editor's own idea of where
 * an entry ends.
 */

export interface ReadText {
  graph: Graph;
  document: ParsedText;
  model: Model;
}

export function read(text: string): ReadText {
  const result = parse(text);
  if (!result.ok) throw new Error(`The text doesn't parse: ${result.reason}`);
  return { graph: result.graph, document: result.document, model: readTextModel(result.document) };
}

function copyLists(lists: PipelineLists): PipelineLists {
  return { receivers: [...lists.receivers], processors: [...lists.processors], exporters: [...lists.exporters] };
}

export function cloneModel(model: Model): Model {
  return {
    components: new Map([...model.components].map(([key, value]) => [key, structuredClone(value)])),
    pipelines: new Map([...model.pipelines].map(([name, lists]) => [name, copyLists(lists)])),
    extensions: [...model.extensions],
    undeclared: new Set(model.undeclared),
  };
}

/** A model as plain data, so a failing comparison prints readably. */
export function plainModel(model: Model) {
  return {
    components: Object.fromEntries(model.components),
    pipelines: Object.fromEntries(model.pipelines),
    extensions: model.extensions,
  };
}

/** The lines `before` loses and `after` gains, in order (a longest-common-subsequence line diff). */
export function lineDiff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const columns = b.length + 1;
  const table = new Array<number>((a.length + 1) * columns).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * columns + j] =
        a[i] === b[j]
          ? table[(i + 1) * columns + j + 1]! + 1
          : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!)) {
      removed.push(a[i]!);
      i++;
    } else {
      added.push(b[j]!);
      j++;
    }
  }
  return { removed, added };
}

function plainLists(model: Model) {
  return [...model.pipelines].map(([name, lists]) => [name, lists.receivers, lists.processors, lists.exporters]);
}

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

type Segment = string | number;

function getIn(value: unknown, path: readonly Segment[]): unknown {
  return path.reduce<unknown>(
    (node, segment) => (node !== null && typeof node === "object" ? (node as Record<Segment, unknown>)[segment] : undefined),
    value,
  );
}

/** Whether `after` is `before` in another order. */
function reordered(before: readonly unknown[], after: readonly unknown[]): boolean {
  const sorted = (list: readonly unknown[]) => JSON.stringify(list.map((item) => JSON.stringify(item)).sort());
  return before.length === after.length && sorted(before) === sorted(after);
}

/**
 * The lines of `before` a change from `beforeModel` to `afterModel` may
 * touch: each changed, removed or renamed component's entry, a removed
 * section, each removed pipeline and changed list, `service.extensions`
 * when it changes, the keys of containers that were or become empty, a
 * changed flow mapping's line (it holds its entries on one line), and an
 * alias or merge whose anchor's owner changes (it may get a copy, ruling
 * 8): one whose anchor stands on those lines or holds them, unless the
 * change only reorders the list holding the anchored item, which keeps the
 * anchor's value (ruling 32; a copy an item moved past needs is on the
 * list's lines already). An entry's lines are found by indentation alone:
 * its key's line and every line after it that is blank or indented deeper
 * (or a sequence item at its column), and a flow collection's to its
 * closing bracket's. `written`: components a change was
 * written to, even when their value ends as it was (an item moved and moved
 * back).
 */
export function touchableLines(
  before: string,
  beforeModel: Model,
  afterModel: Model,
  written: readonly string[] = [],
): Set<number> {
  const lines = before.split("\n");
  const starts: number[] = [0];
  for (let i = 0; i < before.length; i++) if (before[i] === "\n") starts.push(i + 1);
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1]! <= offset) line++;
    return line;
  };
  const touched = new Set<number>();
  const region = (keyLine: number) => {
    const indent = indentOf(lines[keyLine]!);
    let last = keyLine;
    for (let line = keyLine + 1; line < lines.length; line++) {
      const text = lines[line]!;
      if (text.trim() === "") continue;
      const depth = indentOf(text);
      if (depth > indent || (depth === indent && /^ *-( |$)/.test(text.replace(/\r$/, "")))) {
        last = line;
        continue;
      }
      break;
    }
    for (let line = keyLine; line <= last; line++) touched.add(line);
  };
  const keyLine = (pair: Pair) => lineOf((pair.key as { range: [number, number, number] }).range[0]);
  /** An entry's lines: its region, and a flow collection's lines to its closing bracket (one at the key's column too, D9d Ruling 38). */
  const entryRegion = (pair: Pair) => {
    region(keyLine(pair));
    const value = pair.value;
    if ((isMap(value) || isSeq(value)) && value.flow && value.range) {
      for (let line = keyLine(pair); line <= lineOf(Math.max(value.range[0], value.range[1] - 1)); line++) touched.add(line);
    }
  };
  const ownPair = (map: unknown, key: string): Pair | undefined =>
    isMap(map)
      ? (map as YAMLMap).items.find((pair) => isScalar(pair.key) && String(pair.key.value) === key)
      : undefined;

  const document = parseDocument(before, { merge: true, keepSourceTokens: true });
  const root = document.contents;

  for (const section of COMPONENT_SECTIONS) {
    const sectionPair = ownPair(root, section);
    if (!sectionPair) continue;
    const inSection = (model: Model) => [...model.components.keys()].filter((key) => key.startsWith(`${section}.`));
    const was = inSection(beforeModel);
    const is = inSection(afterModel);
    if (was.length === 0 || is.length === 0) touched.add(keyLine(sectionPair));
    if (was.length > 0 && is.length === 0) entryRegion(sectionPair);
    const map = sectionPair.value;
    if (!isMap(map)) continue;
    for (const pair of map.items) {
      if (!isScalar(pair.key)) continue;
      if (typeof pair.key.value === "symbol") {
        entryRegion(pair);
        continue;
      }
      const key = `${section}.${String(pair.key.value)}`;
      const after = afterModel.components.get(key);
      if (
        written.includes(key) ||
        !afterModel.components.has(key) ||
        JSON.stringify(after) !== JSON.stringify(beforeModel.components.get(key))
      ) {
        entryRegion(pair);
      }
    }
  }

  const servicePair = ownPair(root, "service");
  const pipelinesPair = ownPair(servicePair?.value, "pipelines");
  if (servicePair && (beforeModel.pipelines.size === 0 || afterModel.pipelines.size === 0)) {
    touched.add(keyLine(servicePair));
    if (pipelinesPair) touched.add(keyLine(pipelinesPair));
  }
  for (const [name, lists] of beforeModel.pipelines) {
    const pipelinePair = ownPair(pipelinesPair?.value, name);
    if (!pipelinePair) continue;
    const after = afterModel.pipelines.get(name);
    if (!after) {
      entryRegion(pipelinePair);
      continue;
    }
    for (const list of ["receivers", "processors", "exporters"] as const) {
      if (JSON.stringify(lists[list]) === JSON.stringify(after[list])) continue;
      const listPair = ownPair(pipelinePair.value, list);
      if (listPair) entryRegion(listPair);
      else touched.add(keyLine(pipelinePair));
    }
  }
  if (JSON.stringify(beforeModel.extensions) !== JSON.stringify(afterModel.extensions)) {
    const extensionsPair = ownPair(servicePair?.value, "extensions");
    if (extensionsPair) entryRegion(extensionsPair);
    if (servicePair) touched.add(keyLine(servicePair));
  }

  // A flow mapping holds several entries on one line: a change inside it may rewrite the line.
  const isFlow = (value: unknown) => isMap(value) && (value as YAMLMap).flow === true;
  for (const section of COMPONENT_SECTIONS) {
    const sectionPair = ownPair(root, section);
    const keys = new Set([...beforeModel.components.keys(), ...afterModel.components.keys()]);
    const changed = [...keys].some(
      (key) =>
        key.startsWith(`${section}.`) &&
        JSON.stringify(beforeModel.components.get(key)) !== JSON.stringify(afterModel.components.get(key)),
    );
    if (sectionPair && changed && isFlow(sectionPair.value)) entryRegion(sectionPair);
  }
  const serviceChanged =
    JSON.stringify(plainLists(beforeModel)) !== JSON.stringify(plainLists(afterModel)) ||
    JSON.stringify(beforeModel.extensions) !== JSON.stringify(afterModel.extensions);
  if (servicePair && serviceChanged && isFlow(servicePair.value)) entryRegion(servicePair);
  if (pipelinesPair && serviceChanged && isFlow(pipelinesPair.value)) entryRegion(pipelinesPair);

  // Where each value stands, to tell the component (and the list) an anchor is in.
  const paths = new Map<unknown, Segment[]>();
  const walk = (node: unknown, path: Segment[]) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value === "symbol" || !isNode(pair.value)) continue;
        const at = [...path, String(pair.key.value)];
        paths.set(pair.value, at);
        walk(pair.value, at);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => {
        if (!isNode(item)) return;
        paths.set(item, [...path, index]);
        walk(item, [...path, index]);
      });
    }
  };
  walk(root, []);

  const changedLines = new Set(touched);
  const onlyReordered = (path: Segment[]): boolean => {
    const [section, name, ...rest] = path;
    if (!COMPONENT_SECTIONS.includes(section as (typeof COMPONENT_SECTIONS)[number]) || name === undefined) return false;
    const key = `${String(section)}.${String(name)}`;
    if (!beforeModel.components.has(key) || !afterModel.components.has(key)) return false;
    const was = beforeModel.components.get(key);
    const is = afterModel.components.get(key);
    return rest.some((segment, index) => {
      if (typeof segment !== "number") return false;
      const listPath = rest.slice(0, index);
      const listWas = getIn(was, listPath);
      const listIs = getIn(is, listPath);
      return Array.isArray(listWas) && Array.isArray(listIs) && reordered(listWas, listIs);
    });
  };
  const mayBeCopied = (alias: Alias): boolean => {
    const anchor = alias.resolve(document);
    if (!anchor?.range) return false;
    const [start, end] = anchor.range;
    let reached = false;
    for (let line = lineOf(start); line <= lineOf(Math.max(start, end - 1)); line++) {
      if (changedLines.has(line)) reached = true;
    }
    if (!reached) return false;
    const path = paths.get(anchor);
    return path === undefined || !onlyReordered(path);
  };
  visit(document, {
    Alias: (_key, alias) => {
      if (alias.range && mayBeCopied(alias)) touched.add(lineOf(alias.range[0]));
    },
    Pair: (_key, pair) => {
      if (!isScalar(pair.key) || typeof pair.key.value !== "symbol") return;
      const merged = isSeq(pair.value) ? pair.value.items : [pair.value];
      if (merged.some((source) => isAlias(source) && mayBeCopied(source))) entryRegion(pair);
    },
  });
  return touched;
}

/**
 * The lines of `before` outside `touched` that `after` doesn't keep, in
 * order and byte for byte (empty when every one is kept).
 */
export function untouchedLinesLost(before: string, after: string, touched: ReadonlySet<number>): string[] {
  const kept = after.split("\n");
  const lost: string[] = [];
  let at = 0;
  before.split("\n").forEach((line, index) => {
    if (touched.has(index)) return;
    let found = at;
    while (found < kept.length && kept[found] !== line) found++;
    if (found === kept.length) lost.push(`${index + 1}: ${line}`);
    else at = found + 1;
  });
  return lost;
}
