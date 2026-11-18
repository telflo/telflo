import { describe, expect, it } from "vitest";
import { isScalar, parseDocument, visit } from "yaml";

import { cloneModel, plainModel, read, touchableLines, untouchedLinesLost } from "../../test/text-edit-checks.js";
import { collectorReadsAsOther } from "./collector-scalars.js";
import { CORPUS } from "./corpus/corpus.js";
import { deriveModel } from "./model.js";
import type { Model, PipelineLists } from "./model.js";
import { isPlainObject } from "./parse.js";
import { isConfigTargetedConnectorName } from "./routing-connector.js";
import { editText, TextEditError, writeValues } from "./text-edits.js";
import type { ComponentRename, ValueChange } from "./text-edits.js";

/*
 * The text edits' property test (D9a Task 4): random sequences of graph
 * operations over every corpus text. Each operation is what a canvas action
 * does to the configuration the graph describes (add, remove, connect,
 * disconnect, rename, move between pipelines, add and delete pipelines,
 * edit a value, enable or disable an extension). After each one:
 * - the text reads back as the operations' model, exactly;
 * - the graph read from the text derives that model again (the round-trip
 *   invariant), whenever the text has pipelines;
 * - every line outside the change is kept, byte for byte, in order.
 * A reorder of a flow list spread over lines (`flow-spread.yaml`) may be
 * refused (D9d Ruling 34); the step then changes nothing.
 *
 * Seeded (mulberry32), so a failure names its file, seed and step, and
 * replays. No new dependency (fast-check isn't one of the app's).
 */

const SEEDS = [1, 7, 42];

/**
 * A write's text, or undefined when the editor refuses it as a reorder of a
 * flow sequence spread over lines (D9d Ruling 34): such a list can't be
 * reordered by splices, and the refusal changes nothing.
 */
function unlessReorderRefused(write: () => string): string | undefined {
  try {
    return write();
  } catch (error) {
    if (error instanceof TextEditError && error.message.includes("a reorder of a flow sequence spread over lines")) return undefined;
    throw error;
  }
}
const STEPS = 24;

type Random = () => number;

function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: Random, items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(random() * items.length)];
}

const SECTIONS = ["receivers", "processors", "exporters", "connectors", "extensions"] as const;
type Section = (typeof SECTIONS)[number];
const TYPES: Record<Section, readonly string[]> = {
  receivers: ["otlp", "filelog", "zipkin"],
  processors: ["batch", "attributes", "filter"],
  exporters: ["debug", "otlphttp", "file"],
  connectors: ["forward", "count"],
  extensions: ["health_check", "pprof"],
};
const SIDES = ["receivers", "processors", "exporters"] as const;
type Side = (typeof SIDES)[number];

const STRINGS = [
  "plain",
  "true",
  "0750",
  "1e3",
  "a: b",
  "# hash",
  "",
  "multi\nline",
  "trailing newline\n",
  "it's",
  "x,y",
  "[bracket]",
  "  leading",
  "é ü",
  "null",
  "~",
  "-dash",
  "*star",
  "&amp",
  "!bang",
  "0.0.0.0:4317",
  "${env:TOKEN}",
  // Strings to `yaml`, another type to the collector's yaml.v3 (Ruling 69): never written plain.
  "1_000",
  "2024-01-01",
  "0b101",
];

/**
 * The plain string scalars in `text` the collector would read as another
 * type (Ruling 69), as their characters: a write may keep the text's own,
 * never add one.
 */
function collectorMisreads(text: string): string[] {
  const found: string[] = [];
  visit(parseDocument(text, { merge: true }), {
    Scalar: (_key, scalar) => {
      if (isScalar(scalar) && scalar.type === "PLAIN" && typeof scalar.value === "string" && collectorReadsAsOther(scalar.value)) {
        found.push(scalar.value);
      }
    },
  });
  return found;
}

/** Whether `after` holds a plain string the collector misreads that `before` didn't hold as many times. */
function addedMisreads(before: string, after: string): string[] {
  const left = collectorMisreads(before);
  return collectorMisreads(after).filter((value) => {
    const at = left.indexOf(value);
    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}
const NUMBERS = [0, 1, -3, 2.5, 1e21, 4317, 0.1];
const KEYS = ["endpoint", "timeout", "tls", "x", "key with space", "a:b", "true", "1", "-k", "é", "nested"];

function randomValue(random: Random, depth: number): unknown {
  const roll = random();
  if (roll < 0.3) return pick(random, STRINGS);
  if (roll < 0.45) return pick(random, NUMBERS);
  if (roll < 0.52) return random() < 0.5;
  if (roll < 0.58) return null;
  if (depth <= 0 || roll < 0.64) return random() < 0.5 ? {} : [];
  if (roll < 0.85) {
    const value: Record<string, unknown> = {};
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) value[pick(random, KEYS)!] = randomValue(random, depth - 1);
    return value;
  }
  return Array.from({ length: Math.floor(random() * 3) }, () => randomValue(random, depth - 1));
}

/** A copy of `value` with one random change somewhere inside it. */
function mutate(random: Random, value: unknown, depth = 0): unknown {
  if (isPlainObject(value) && Object.keys(value).length > 0 && random() < 0.75) {
    const copy: Record<string, unknown> = { ...value };
    const key = pick(random, Object.keys(copy))!;
    const roll = random();
    if (roll < 0.25) delete copy[key];
    else if (roll < 0.45) copy[pick(random, KEYS)!] = randomValue(random, 1);
    else copy[key] = mutate(random, copy[key], depth + 1);
    return copy;
  }
  if (Array.isArray(value) && value.length > 0 && random() < 0.5) {
    const copy = [...value];
    const index = Math.floor(random() * copy.length);
    const roll = random();
    if (roll < 0.33) copy.splice(index, 1);
    else if (roll < 0.66) copy.splice(index, 0, randomValue(random, 1));
    else copy[index] = randomValue(random, 1);
    return copy;
  }
  return randomValue(random, Math.max(0, 2 - depth));
}

const sectionOf = (key: string) => key.slice(0, key.indexOf(".")) as Section;
const nameOf = (key: string) => key.slice(key.indexOf(".") + 1);

/** The component a list's entry names: a connector's when the connectors section declares it. */
function entryKey(model: Model, side: Side, name: string): string {
  if (side !== "processors" && model.components.has(`connectors.${name}`)) return `connectors.${name}`;
  return `${side}.${name}`;
}

function sidesOf(section: Section): Side[] {
  if (section === "connectors") return ["receivers", "exporters"];
  if (section === "extensions") return [];
  return [section];
}

function insertAt(random: Random, list: string[], name: string) {
  list.splice(Math.floor(random() * (list.length + 1)), 0, name);
}

/** One graph operation on `model`: its name, and the renames it made. */
function operate(random: Random, model: Model, counter: { next: number }): { name: string; renames: ComponentRename[] } {
  const pipelines = [...model.pipelines.entries()];
  const declared = [...model.components.keys()];
  const editable = declared.filter((key) => !isConfigTargetedConnectorName(nameOf(key)));
  const roll = Math.floor(random() * 10);

  switch (roll) {
    case 0: {
      const section = pick(random, SECTIONS)!;
      const name = `${pick(random, TYPES[section])!}/p${counter.next++}`;
      model.components.set(`${section}.${name}`, random() < 0.2 ? null : randomValue(random, 2));
      const target = pick(random, pipelines)?.[1];
      if (section === "extensions") {
        if (random() < 0.7) model.extensions.push(name);
      } else if (target && section === "connectors") {
        target.exporters.push(name);
        const other = pick(random, pipelines.filter(([, lists]) => lists !== target))?.[1];
        if (other) other.receivers.push(name);
      } else if (target && section === "processors") {
        insertAt(random, target.processors, name);
      } else if (target && random() < 0.8) {
        target[section as Side].push(name);
      }
      return { name: "add", renames: [] };
    }
    case 1: {
      const key = pick(random, declared);
      if (!key) return { name: "remove (nothing)", renames: [] };
      const section = sectionOf(key);
      const name = nameOf(key);
      for (const [, lists] of pipelines) {
        for (const side of sidesOf(section)) {
          lists[side] = lists[side].filter((entry) => entry !== name || entryKey(model, side, entry) !== key);
        }
      }
      if (section === "extensions") model.extensions = model.extensions.filter((entry) => entry !== name);
      model.components.delete(key);
      return { name: "remove", renames: [] };
    }
    case 2: {
      const key = pick(random, editable.filter((k) => sectionOf(k) !== "extensions"));
      const target = pick(random, pipelines)?.[1];
      if (!key || !target) return { name: "connect (nothing)", renames: [] };
      const name = nameOf(key);
      const side = pick(random, sidesOf(sectionOf(key)))!;
      if (entryKey(model, side, name) !== key || target[side].includes(name)) return { name: "connect (already)", renames: [] };
      if (sectionOf(key) === "connectors" && (target.receivers.includes(name) || target.exporters.includes(name))) {
        return { name: "connect (both sides)", renames: [] };
      }
      if (side === "processors") insertAt(random, target.processors, name);
      else target[side].push(name);
      return { name: "connect", renames: [] };
    }
    case 3:
    case 4: {
      const entry = pick(random, pipelines);
      const side = pick(random, SIDES.filter((s) => entry?.[1][s].some((name) => !isConfigTargetedConnectorName(name))));
      if (!entry || !side) return { name: "disconnect/move (nothing)", renames: [] };
      const lists = entry[1];
      const name = pick(random, lists[side].filter((n) => !isConfigTargetedConnectorName(n)))!;
      lists[side] = lists[side].filter((n) => n !== name);
      if (roll === 3) return { name: "disconnect", renames: [] };
      const to = pick(random, pipelines.filter(([pipeline]) => pipeline !== entry[0]))?.[1];
      const isConnector = model.components.has(`connectors.${name}`);
      if (to && !to[side].includes(name) && !(isConnector && (to.receivers.includes(name) || to.exporters.includes(name)))) {
        if (side === "processors") insertAt(random, to.processors, name);
        else to[side].push(name);
      }
      return { name: "move", renames: [] };
    }
    case 5: {
      const key = pick(random, declared);
      if (!key) return { name: "rename (nothing)", renames: [] };
      const section = sectionOf(key);
      const name = nameOf(key);
      const renamed = `${name.split("/")[0]!}/r${counter.next++}`;
      for (const [, lists] of pipelines) {
        for (const side of sidesOf(section)) {
          lists[side] = lists[side].map((entry) => (entry === name && entryKey(model, side, entry) === key ? renamed : entry));
        }
      }
      if (section === "extensions") model.extensions = model.extensions.map((entry) => (entry === name ? renamed : entry));
      model.components.set(`${section}.${renamed}`, model.components.get(key));
      model.components.delete(key);
      return { name: "rename", renames: [{ from: key, to: `${section}.${renamed}` }] };
    }
    case 6: {
      const signal = pick(random, ["traces", "metrics", "logs"])!;
      const lists: PipelineLists = { receivers: [], processors: [], exporters: [] };
      for (const side of SIDES) {
        const candidates = editable.filter((key) => sectionOf(key) === side).map(nameOf);
        for (let i = 0; i < 2; i++) {
          const name = pick(random, candidates);
          if (name && !lists[side].includes(name) && random() < 0.6) lists[side].push(name);
        }
      }
      model.pipelines.set(`${signal}/p${counter.next++}`, lists);
      return { name: "add pipeline", renames: [] };
    }
    case 7: {
      const entry = pick(random, pipelines);
      if (!entry) return { name: "delete pipeline (nothing)", renames: [] };
      model.pipelines.delete(entry[0]);
      return { name: "delete pipeline", renames: [] };
    }
    case 8: {
      const key = pick(random, editable);
      if (!key) return { name: "edit value (nothing)", renames: [] };
      model.components.set(key, mutate(random, model.components.get(key)));
      return { name: "edit value", renames: [] };
    }
    default: {
      const key = pick(random, declared.filter((k) => sectionOf(k) === "extensions"));
      if (!key) return { name: "toggle extension (nothing)", renames: [] };
      const name = nameOf(key);
      model.extensions = model.extensions.includes(name)
        ? model.extensions.filter((entry) => entry !== name)
        : [...model.extensions, name];
      return { name: "toggle extension", renames: [] };
    }
  }
}

describe("the text edits' property: random graph operations over the corpus", () => {
  const runs = CORPUS.flatMap((entry) => SEEDS.map((seed) => [entry.name, seed, entry.text] as const));

  it.each(runs)("%s, seed %i", (name, seed, initial) => {
    const random = mulberry32(seed);
    const counter = { next: 1 };
    let text = initial;
    const start = read(text);
    // What the canvas shows: an empty text's three default pipelines included.
    let model = deriveModel(start.graph, start.model);
    const history: string[] = [];

    for (let step = 1; step <= STEPS; step++) {
      const next = cloneModel(model);
      const operation = operate(random, next, counter);
      history.push(operation.name);
      const where = `${name}, seed ${seed}, step ${step} (${history.join(", ")})`;

      const before = read(text).model;
      const result = unlessReorderRefused(() => editText(text, before, next, { renames: operation.renames }).text);
      if (result === undefined) {
        history.push("refused");
        expect(plainModel(read(text).model), where).toEqual(plainModel(before));
        continue;
      }
      const back = read(result);
      expect(plainModel(back.model), where).toEqual(plainModel(next));
      if (back.model.pipelines.size > 0) {
        expect(plainModel(deriveModel(back.graph, back.model)), where).toEqual(plainModel(back.model));
      }
      expect(untouchedLinesLost(text, result, touchableLines(text, before, next)), where).toEqual([]);
      expect(addedMisreads(text, result), where).toEqual([]);

      text = result;
      model = back.model.pipelines.size > 0 ? back.model : deriveModel(back.graph, back.model);
    }
  });
});

/*
 * writeValues' property (D9b Task 1): random change lists a form could send
 * (set a leaf, set a value whole, add a key or a nested path, append, remove
 * a key or an item, move an item, rename a key, a number written as typed)
 * to a random component of every corpus text. After each write:
 * - the component reads back as the changes made it, exactly;
 * - every other component, pipeline and extension reads as before, and the
 *   graph read from the text derives the text's model again;
 * - every line outside the component (and the aliases and merges of
 *   anchors whose value it changed, which may have copies) is kept, byte
 *   for byte, in order.
 */

const VALUE_STEPS = 12;
const PLAIN_NUMBERS: Readonly<Record<string, number>> = { "1e3": 1000, "0x1F": 31, "0750": 750, "-3": -3, "1.5": 1.5 };

type Segment = string | number;

/** Every place in `value`, the value itself first, with what is there. */
function places(value: unknown, path: Segment[] = []): Array<{ path: Segment[]; value: unknown }> {
  const out = [{ path, value }];
  if (Array.isArray(value)) value.forEach((item, index) => out.push(...places(item, [...path, index])));
  else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) out.push(...places(item, [...path, key]));
  return out;
}

/** A value a form could write: no list directly inside a list (`- - a` items share a line, which the editor refuses). */
function formValue(random: Random, depth: number, inList = false): unknown {
  const roll = random();
  if (roll < 0.35) return pick(random, STRINGS);
  if (roll < 0.5) return pick(random, NUMBERS);
  if (roll < 0.57) return random() < 0.5;
  if (roll < 0.62) return null;
  if (depth <= 0 || roll < 0.68) return inList || random() < 0.5 ? {} : [];
  if (roll < 0.88 || inList) {
    const value: Record<string, unknown> = {};
    for (let i = 1 + Math.floor(random() * 2); i > 0; i--) value[pick(random, KEYS)!] = formValue(random, depth - 1);
    return value;
  }
  return Array.from({ length: 1 + Math.floor(random() * 2) }, () => formValue(random, depth - 1, true));
}

function getIn(value: unknown, path: readonly Segment[]): unknown {
  return path.reduce<unknown>((node, segment) => (node as Record<Segment, unknown>)[segment], value);
}

/** `root` with `path` set to `value`, creating mappings (and lists, for numbers) on the way. */
function setIn(root: unknown, path: readonly Segment[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [segment, ...rest] = path as [Segment, ...Segment[]];
  const container = root === null || root === undefined ? (typeof segment === "number" ? [] : {}) : root;
  const copy: Record<Segment, unknown> | unknown[] = Array.isArray(container) ? [...container] : { ...(container as object) };
  (copy as Record<Segment, unknown>)[segment] = setIn((container as Record<Segment, unknown>)[segment], rest, value);
  return copy;
}

function updateIn(root: unknown, path: readonly Segment[], update: (value: unknown) => unknown): unknown {
  return setIn(root, path, update(getIn(root, path)));
}

/**
 * One change to the component's value `value`, and the value after it. A
 * change sets, removes, moves or renames something inside the value, never
 * the value itself (ruling 30).
 */
function randomValueChange(random: Random, value: unknown): { change: ValueChange; next: unknown } {
  const everywhere = places(value);
  const maps = everywhere.filter((place) => isPlainObject(place.value) || place.value === null);
  const all = everywhere.filter((place) => place.path.length > 0);
  const lists = everywhere.filter((place) => Array.isArray(place.value));
  const keyed = all.filter((place) => typeof place.path[place.path.length - 1] === "string");
  const items = all.filter((place) => typeof place.path[place.path.length - 1] === "number");
  const leaves = all.filter((place) => place.value === null || typeof place.value !== "object");
  const movable = lists.filter((place) => (place.value as unknown[]).length >= 2);
  // Lists of two or more are rare in random values: move one whenever there is one, often.
  const roll = movable.length > 0 && random() < 0.3 ? 4 : Math.floor(random() * 10);

  if (roll === 0 && leaves.length > 0) {
    const { path } = pick(random, leaves)!;
    const plain = pick(random, Object.keys(PLAIN_NUMBERS))!;
    return { change: { path, plain }, next: setIn(value, path, PLAIN_NUMBERS[plain]) };
  }
  if (roll === 1 && keyed.length > 0) {
    const place = pick(random, keyed)!;
    const parent = getIn(value, place.path.slice(0, -1)) as Record<string, unknown>;
    const name = pick(random, KEYS.filter((key) => !(key in parent)));
    if (name) {
      const from = place.path[place.path.length - 1] as string;
      const renamed = Object.fromEntries(Object.entries(parent).map(([key, item]) => [key === from ? name : key, item]));
      return { change: { path: place.path, renameTo: name }, next: setIn(value, place.path.slice(0, -1), renamed) };
    }
  }
  if (roll === 2 && keyed.length > 0) {
    const { path } = pick(random, keyed)!;
    return { change: { path, remove: true }, next: updateIn(value, path.slice(0, -1), (parent) => {
      const copy = { ...(parent as Record<string, unknown>) };
      delete copy[path[path.length - 1] as string];
      return copy;
    }) };
  }
  if (roll === 3 && items.length > 0) {
    const { path } = pick(random, items)!;
    const index = path[path.length - 1] as number;
    return { change: { path, remove: true }, next: updateIn(value, path.slice(0, -1), (list) => (list as unknown[]).filter((_item, i) => i !== index)) };
  }
  if (roll === 4) {
    const place = pick(random, movable);
    if (place) {
      const list = [...(place.value as unknown[])];
      const from = Math.floor(random() * list.length);
      const to = Math.floor(random() * list.length);
      list.splice(to, 0, ...list.splice(from, 1));
      return { change: { path: [...place.path, from], moveTo: to }, next: setIn(value, place.path, list) };
    }
  }
  if (roll === 5 && lists.length > 0) {
    const { path, value: list } = pick(random, lists)!;
    const item = formValue(random, 1, true);
    return { change: { path: [...path, (list as unknown[]).length], value: item }, next: setIn(value, [...path, (list as unknown[]).length], item) };
  }
  if (roll === 6 && maps.length > 0) {
    // A path that runs out: a new key holding nested mappings, or a new list.
    const { path } = pick(random, maps)!;
    const missing = [...path, `new${Math.floor(random() * 1000)}`, ...(random() < 0.5 ? ["nested"] : [0]), "leaf"];
    const leaf = formValue(random, 0);
    return { change: { path: missing, value: leaf }, next: setIn(value, missing, leaf) };
  }
  if (roll === 7 && maps.length > 0) {
    const { path } = pick(random, maps)!;
    const key = pick(random, KEYS)!;
    const item = formValue(random, 1);
    return { change: { path: [...path, key], value: item }, next: setIn(value, [...path, key], item) };
  }
  if (roll === 8 && all.length > 0) {
    const { path } = pick(random, all)!;
    const whole = formValue(random, 2, typeof path[path.length - 1] === "number");
    return { change: { path, value: whole }, next: setIn(value, path, whole) };
  }
  if (all.length === 0) {
    // Nothing inside the value yet (`otlp:`, `{}`): a key set in it.
    const key = pick(random, KEYS)!;
    const leaf = formValue(random, 0);
    return { change: { path: [key], value: leaf }, next: setIn(value, [key], leaf) };
  }
  const { path } = pick(random, leaves.length > 0 ? leaves : all)!;
  const leaf = formValue(random, 0, typeof path[path.length - 1] === "number");
  return { change: { path, value: leaf }, next: setIn(value, path, leaf) };
}

describe("writeValues' property: random change lists over the corpus", () => {
  const runs = CORPUS.flatMap((entry) => SEEDS.map((seed) => [entry.name, seed, entry.text] as const));

  it.each(runs)("%s, seed %i", (name, seed, initial) => {
    const random = mulberry32(seed);
    let text = initial;
    const history: string[] = [];

    for (let step = 1; step <= VALUE_STEPS; step++) {
      const before = read(text).model;
      const key = pick(random, [...before.components.keys()].filter((k) => !isConfigTargetedConnectorName(nameOf(k))));
      if (!key) break;
      let value = before.components.get(key);
      const changes: ValueChange[] = [];
      for (let count = 1 + Math.floor(random() * 3); count > 0; count--) {
        const { change, next } = randomValueChange(random, value);
        changes.push(change);
        value = next;
      }
      history.push(JSON.stringify(changes.map((change) => Object.keys(change).find((k) => k !== "path"))));
      const where = `${name}, seed ${seed}, step ${step} (${history.join(", ")})`;

      const result = unlessReorderRefused(() => writeValues(text, [sectionOf(key), nameOf(key)], changes).text);
      if (result === undefined) {
        history.push("refused");
        expect(plainModel(read(text).model), where).toEqual(plainModel(before));
        continue;
      }
      const back = read(result);
      const expected = cloneModel(before);
      expected.components.set(key, value);
      expect(plainModel(back.model), where).toEqual(plainModel(expected));
      if (back.model.pipelines.size > 0) {
        expect(plainModel(deriveModel(back.graph, back.model)), where).toEqual(plainModel(back.model));
      }
      expect(untouchedLinesLost(text, result, touchableLines(text, before, back.model, [key])), where).toEqual([]);
      expect(addedMisreads(text, result), where).toEqual([]);
      text = result;
    }
  });
});

/*
 * D9c Task 1 (Preflight rulings 1 and 2): over every corpus text, strings
 * with line breaks (the ones a literal block carries and the ones it
 * can't) and values written as typed (numbers, booleans, one-line flow
 * collections), each set as a new key of a component and in place of its
 * first scalar key. Each reads back as written, every other component,
 * pipeline and extension reads as before, and every line outside the
 * component is kept, byte for byte: the double quotes and the typed
 * values change nothing else.
 */

const BREAKS = ["\n", "\n\n", " \n", "\t", "a\n\n", "x\ny", "trailing newline\n", "  leading\nspace"];
const TYPED: Readonly<Record<string, unknown>> = { "1.0": 1, True: true, '{"k": "v"}': { k: "v" }, "[1, a]": [1, "a"], "{}": {} };
const COMPONENTS_PER_TEXT = 6;

describe("strings with line breaks and values written as typed, over the corpus", () => {
  // Its own time limit (D9c Rulings 54 and 80).
  it.each(CORPUS.map((entry) => [entry.name, entry.text] as const))("%s", (name, text) => {
    const before = read(text).model;
    const keys = [...before.components.keys()]
      .filter((key) => !isConfigTargetedConnectorName(nameOf(key)))
      .filter((key) => before.components.get(key) === null || isPlainObject(before.components.get(key)))
      .slice(0, COMPONENTS_PER_TEXT);
    for (const key of keys) {
      const value = before.components.get(key);
      const leaf = isPlainObject(value)
        ? Object.keys(value).find((k) => value[k] !== null && typeof value[k] !== "object")
        : undefined;
      const writes: Array<{ change: ValueChange[]; next: unknown }> = [];
      for (const typed of BREAKS) {
        const changes: ValueChange[] = [{ path: ["d9c_new"], value: typed }];
        if (leaf) changes.push({ path: [leaf], value: typed });
        writes.push({ change: changes, next: { ...(isPlainObject(value) ? value : {}), ...(leaf ? { [leaf]: typed } : {}), d9c_new: typed } });
      }
      for (const [typed, reads] of Object.entries(TYPED)) {
        const changes: ValueChange[] = [{ path: ["d9c_new"], plain: typed }];
        if (leaf) changes.push({ path: [leaf], plain: typed });
        writes.push({ change: changes, next: { ...(isPlainObject(value) ? value : {}), ...(leaf ? { [leaf]: reads } : {}), d9c_new: reads } });
      }
      for (const { change, next } of writes) {
        const where = `${name}, ${key}, ${JSON.stringify(change)}`;
        const result = writeValues(text, [sectionOf(key), nameOf(key)], change).text;
        const back = read(result);
        const expected = cloneModel(before);
        expected.components.set(key, next);
        expect(plainModel(back.model), where).toEqual(plainModel(expected));
        if (back.model.pipelines.size > 0) {
          expect(plainModel(deriveModel(back.graph, back.model)), where).toEqual(plainModel(back.model));
        }
        expect(untouchedLinesLost(text, result, touchableLines(text, before, back.model, [key])), where).toEqual([]);
        expect(addedMisreads(text, result), where).toEqual([]);
      }
    }
  }, 20_000);
});
