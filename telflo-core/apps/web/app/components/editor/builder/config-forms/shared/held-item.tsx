import { useMemo, useRef, useState, type ReactNode } from "react";

import { FormProvider, formSource, readLatest, useForm, type FormSource } from "../form-context.js";
import { HeldNotices, touches, underPrefix, useNotices, type Notice } from "./AdjustmentAlert.js";
import { flushHeldEdits } from "~/lib/editor/held-edits.js";
import type { ValueChange, ValuePath } from "~/lib/graph/text-edits.js";
import type { ValueView } from "~/lib/graph/value-view.js";
import { useEditorStore, type ValuesResult } from "~/lib/stores/editor-store.js";

/*
 * Held cards: `MultiValueField`'s held rows for a list of cards. Add holds
 * a card that isn't in the text; its first field typed writes the item,
 * `seed ∪ typed`, appended (or inserted at an index: set at the list's
 * length and moved there, in one write, so one undo entry), and the card
 * becomes the item's in place. An empty item (`{name: ""}`,
 * `{include: ""}`, `[]`) is never written at once: the collector refuses it
 * or reads it as something else.
 *
 * - `useHeldItem(listPath, { cards })` holds one card at a time. A form
 *   renders the held card at `at` (the list's end unless `hold` named an
 *   index, or a function of the list's items: `HeldAt`), keyed by
 *   `cards.next` (`useCardKeys`): once the item is written, the hook
 *   reports `cards.add()` and, for an insert, `cards.move(length, at)` in
 *   the same event, so the written item's card has the held card's key and
 *   its input keeps focus and caret.
 * - `ItemScope` gives a card's fields their source: the item's own in the
 *   text (as `FormScope`), or, for the held card, the held item's. Both are
 *   one `FormProvider`, so the card's elements stay the same when the item
 *   is written.
 * - The held source reads the seed with what was typed into it, and keeps
 *   the card's changes until the item is `ready` (by default: something
 *   was typed); then it writes the item in one change. A number typed as
 *   written (`plain`) is written plain under the item in that change.
 * - The held card belongs to its list's shape as it was when it was held: it
 *   is dropped when its list's length changes or the list stops being a list
 *   (absent is a list of none), by any write (an undo or redo, the YAML box,
 *   another item added or removed), or a configuration loads, and goes with
 *   the form (the Configuration tab is keyed by the load and the node).
 *   Anything else keeps it: an edit inside another item of its list, a write
 *   elsewhere in the component, and their undos (its index is worked out when
 *   it is written, so those can't misplace it). Removing it writes nothing. A
 *   held card stays until its own Remove; a held row (`DimensionListField`'s)
 *   left with nothing in it is dropped, as MultiValueField's held rows are
 *   (`empty`).
 * - Nothing empty is ever written: not `""`, `{}` or `[]`, nor an item
 *   whose fields are all empty.
 * - The adjustment messages from a write the held card keeps
 *   (metricstransform's Combine and Group) are held with it: toasted once,
 *   with the write that puts the card in the text, and never if it is dropped.
 *   `ItemScope` gives the card's fields that scope (`HeldNotices`); a held
 *   card inside another passes them to the outer one when it is written. A
 *   held message that names the paths its cascade adjusted is dropped when a
 *   later change in the card touches one of them: Combine's "Aggregation Type
 *   set to sum", then mean chosen, says nothing of sum when the card is
 *   written. A message is held once per message and adjusted paths: the same
 *   message from another cascade, adjusting other paths, is held beside it, so
 *   a later change dropping one leaves the other.
 * - Any scoped source inside a held card (a `FormScope`, an `ItemScope`, an
 *   `ExcludingScope`, a form-local one) must re-base its notices' paths
 *   onto the source it is under (`HeldNotices` with its `prefix`), so the
 *   paths a held message names are the card's.
 */

/** The same message for the same adjusted paths. */
function sameNotice(a: Notice, b: Notice): boolean {
  return a.message === b.message && JSON.stringify(a.adjusted) === JSON.stringify(b.adjusted);
}

/** A number typed as written (`plain`), kept in a held item until it is written plain under it. */
class PlainChars {
  constructor(readonly chars: string) {}
}

/**
 * Where a held card shows and its item goes: an index, or a function of the
 * list's items, worked out each render from the list as it is then and
 * again when the item is written, from the list as it is at the write. A
 * change that keeps the list's length but changes its items (the YAML box,
 * an undo) keeps the card, so a fixed index could be stale: transform's
 * group goes before the first flat statement of the list it is written
 * into.
 */
export type HeldAt = number | ((items: readonly unknown[]) => number);

/** `at` over the list's items (`view`'s; absent is none); undefined: the list's end. */
function resolveAt(at: HeldAt | undefined, view: ValueView): number | undefined {
  if (typeof at !== "function") return at;
  return at(view.kind === "list" ? view.value : []);
}

interface HeldState {
  /** Where the held card shows and its item goes; undefined: the list's end. */
  at: HeldAt | undefined;
  /** The held card's changes, in order, under the item. */
  changes: readonly ValueChange[];
  /** Its list's shape as it was held (`listShape`; undefined until the render after `hold`): a change drops it. */
  shape: number | null | undefined;
  /** The load when it was held: another drops it. */
  load: number;
  /**
   * The adjustment messages from changes the card kept, with the
   * paths they adjusted under the item: told when it is written, dropped
   * with it, or when a later change in the card touches a path.
   */
  notices: readonly Notice[];
}

export interface HeldItem {
  /** Whether a card is held. */
  held: boolean;
  /** Where the held card shows: `hold`'s index, or the list's length. */
  at: number;
  /**
   * Holds a card at `at` (the list's end by default), writing what fields
   * still hold first. A function is worked out from the list's items each
   * render and when the item is written.
   */
  hold: (at?: HeldAt) => void;
  /** Drops the held card, writing nothing (its Remove). */
  drop: () => void;
  /** Whether the held card holds nothing typed (a held row left so is dropped). */
  empty: () => boolean;
  /** Writes `seed ∪ typed` as the list's item at `at` (default the held card's), in one change; nothing when `typed` is empty. */
  write: (seed: unknown, typed: unknown, at?: HeldAt) => ValuesResult;
  /** The held card's source: reads `seed` with what was typed, and writes the item once it is `ready`. */
  source: (seed?: unknown) => FormSource;
  /**
   * The adjustment messages from a write made through the held card's
   * source: held with the card while it holds that write, told (as
   * the enclosing scope tells them: a toast) once the write put it in the text.
   */
  notice: (notices: readonly Notice[]) => void;
}

/** The keys' changes a held item's write reports (`useCardKeys`). */
export interface HeldItemCards {
  add: () => void;
  move: (from: number, to: number) => void;
}

const ABSENT: ValueView = { kind: "absent", value: undefined };

/**
 * A list's shape, what a held card or row belongs to: its length (absent:
 * none), or null when it isn't a list.
 */
export function listShape(view: ValueView): number | null {
  return view.kind === "list" ? view.value.length : view.kind === "absent" ? 0 : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof PlainChars);
}

/** `""`, null, `{}`, `[]`, or a mapping or list holding only those: nothing worth writing. */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.every(isEmptyValue);
  if (isPlainObject(value)) return Object.values(value).every(isEmptyValue);
  return false;
}

/**
 * `seed ∪ typed`: mappings merged key by key, in the seed's key order and then
 * typed's new keys (a seed key whose value is undefined only places a typed
 * key: metricstransform's `{include, match_type, action}`); anything else is
 * typed's, or the seed's when nothing was typed.
 */
export function mergeItem(seed: unknown, typed: unknown): unknown {
  if (isPlainObject(seed) && isPlainObject(typed)) {
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(seed)) {
      const value = key in typed ? mergeItem(seed[key], typed[key]) : seed[key];
      if (value !== undefined) merged[key] = value;
    }
    for (const key of Object.keys(typed)) if (!(key in seed) && typed[key] !== undefined) merged[key] = typed[key];
    return merged;
  }
  return typed === undefined ? seed : typed;
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clone(inner)]));
  return value;
}

/** `changes` applied to a copy of `base` (a mapping, a list or nothing), or null when one can't be. */
function applyChanges(base: unknown, changes: readonly ValueChange[]): { value: unknown } | null {
  const root = { value: clone(base) as unknown };
  for (const change of changes) {
    if ("moveTo" in change || "renameTo" in change) return null;
    let parent: Record<string | number, unknown> = root as Record<string | number, unknown>;
    let key: string | number = "value";
    let missing = false;
    for (const segment of change.path) {
      let next = parent[key];
      if (next === undefined || next === null) {
        // Removing under nothing removes nothing.
        if ("remove" in change) {
          missing = true;
          break;
        }
        next = typeof segment === "number" ? [] : {};
        parent[key] = next;
      }
      if (typeof segment === "number" ? !Array.isArray(next) : !isPlainObject(next)) return null;
      parent = next as Record<string | number, unknown>;
      key = segment;
    }
    if (missing) continue;
    if ("remove" in change) {
      if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
      else delete parent[key];
    } else {
      parent[key] = "plain" in change ? new PlainChars(change.plain) : clone(change.value);
    }
  }
  return root;
}

/** The item as written: plain numbers left as null for their own `plain` changes, which follow. */
function itemChanges(itemPath: ValuePath, item: unknown): ValueChange[] {
  const plains: ValueChange[] = [];
  const strip = (value: unknown, path: ValuePath): unknown => {
    if (value instanceof PlainChars) {
      plains.push({ path: [...itemPath, ...path], plain: value.chars });
      return null;
    }
    if (Array.isArray(value)) return value.map((inner, index) => strip(inner, [...path, index]));
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, inner]) => inner !== undefined)
          .map(([key, inner]) => [key, strip(inner, [...path, key])]),
      );
    }
    return value;
  };
  const value = strip(item, []);
  return [{ path: itemPath, value }, ...plains];
}

/** What a field shows at `path` in a held item. */
function viewOf(item: unknown, path: ValuePath): ValueView {
  let value = item;
  for (const segment of path) {
    if (typeof segment === "number" ? !Array.isArray(value) : !isPlainObject(value)) return ABSENT;
    value = (value as Record<string | number, unknown>)[segment];
  }
  if (value === undefined || value === null) return ABSENT;
  if (value instanceof PlainChars) return { kind: "scalar", value: value.chars, source: value.chars };
  if (Array.isArray(value)) return { kind: "list", value: clone(value) as unknown[] };
  if (isPlainObject(value)) return { kind: "map", value: clone(value) as Record<string, unknown> };
  return { kind: "scalar", value: value as string | number | boolean };
}

/**
 * A held card over the list at `listPath` (one at a time). `cards` are the
 * list's `useCardKeys`, told of the write; `ready` says when the held
 * card's item is complete enough to write (DimensionListField: once it has
 * a name), by default once anything is typed.
 */
export function useHeldItem(
  listPath: ValuePath,
  { cards, ready }: { cards?: HeldItemCards; ready?: (item: unknown) => boolean } = {},
): HeldItem {
  const form = useForm();
  // Where messages go once the card is written: the enclosing held card's, or a toast.
  const notices = useNotices();
  const load = useEditorStore((state) => state.loadCount);
  const [state, setState] = useState<HeldState | null>(null);
  // The latest state, for writes made before the next render (two fields of the held card left in turn).
  const stateRef = useRef<HeldState | null>(state);
  // Where the card's item went when it was written: a message from that write is told under it.
  const writtenAt = useRef(0);
  const view = form.read(listPath);
  const length = listShape(view);
  let current = state;
  if (current !== null && (current.load !== load || (current.shape !== undefined && current.shape !== length))) {
    // Its list's shape changed, or a configuration loaded: the held card goes, unwritten.
    current = null;
    setState(null);
  } else if (current !== null && current.shape === undefined) {
    // The render after `hold`: the list as it is once what fields held was written.
    current = { ...current, shape: length };
    setState(current);
  }
  stateRef.current = current;
  const update = (next: HeldState | null) => {
    stateRef.current = next;
    setState(next);
  };
  /**
   * Writes `item` as the list's item at `at` (its end by default): set at
   * the length, then moved, in one write. `at` is worked out from the list as
   * it is now. `held` are the card's messages to tell with it (by
   * default, all it holds).
   */
  const writeAt = (item: unknown, at: HeldAt | undefined, held = stateRef.current?.notices ?? []): ValuesResult => {
    if (isEmptyValue(item)) return "unchanged";
    // The list as the text holds it now: a write since this render (a flushed held edit) counted.
    const latest = readLatest(form, listPath);
    const end = latest.kind === "list" ? latest.value.length : latest.kind === "absent" ? 0 : null;
    if (end === null) return "refused";
    const index = resolveAt(at, latest);
    const itemPath = [...listPath, end];
    const changes = itemChanges(itemPath, item);
    const insert = index !== undefined && index < end;
    if (insert) changes.push({ path: itemPath, moveTo: index });
    const result = form.apply(changes);
    if (result === "written") {
      writtenAt.current = insert && index !== undefined ? index : end;
      // In the same event as the write: the written item's card has the held card's key.
      cards?.add();
      if (insert) cards?.move(end, index);
      update(null);
      // The card's held messages come with the write that puts it in the text.
      if (held.length > 0) notices(underPrefix([...listPath, writtenAt.current], held));
    }
    return result;
  };

  return {
    held: current !== null,
    at: resolveAt(current?.at, view) ?? length ?? 0,
    hold: (index) => {
      if (form.disabled || length === null) return;
      // What a field still holds is written first: the held card belongs to the text as it is then.
      flushHeldEdits();
      const previous = stateRef.current;
      if (previous !== null && previous.at === index) return;
      update({ at: index, changes: [], shape: undefined, load: useEditorStore.getState().loadCount, notices: [] });
    },
    drop: () => update(null),
    empty: () => {
      const held = stateRef.current;
      return held === null || isEmptyValue(applyChanges(undefined, held.changes)?.value);
    },
    write: (seed, typed, index) =>
      isEmptyValue(typed) ? "unchanged" : writeAt(mergeItem(seed, typed), index ?? stateRef.current?.at),
    source: (seed) => {
      const item = applyChanges(seed, current?.changes ?? [])?.value;
      return formSource(
        (path) => viewOf(item, path),
        (more) => {
          const held = stateRef.current;
          if (held === null) return "refused";
          const all = [...held.changes, ...more];
          const next = applyChanges(seed, all);
          const typed = applyChanges(undefined, all);
          if (next === null || typed === null) return "refused";
          // A message whose adjusted path these changes touch no longer says what the card holds.
          const kept = held.notices.filter((notice) => !notice.adjusted.some((path) => more.some((change) => touches(change.path, path))));
          if (!isEmptyValue(typed.value) && (ready ? ready(next.value) : true)) return writeAt(next.value, held.at, kept);
          // Not complete yet: the card keeps what was typed.
          update({ ...held, changes: all, notices: kept });
          return "written";
        },
        form.disabled,
      );
    },
    notice: (messages) => {
      const held = stateRef.current;
      // The write put the card in the text (or there is none): told now, under the item.
      if (held === null) {
        notices(underPrefix([...listPath, writtenAt.current], messages));
        return;
      }
      // Kept in the card: told when it is written. A message held already for the same paths isn't held twice.
      const more = messages.filter((notice) => !held.notices.some((kept) => sameNotice(kept, notice)));
      if (more.length > 0) update({ ...held, notices: [...held.notices, ...more] });
    },
  };
}

/**
 * A card's fields' source: list item `index` of `listPath` (as `FormScope`
 * binds one), or, with `held`, the held card's (`held.source(seed)`). One
 * element either way, so a held card's fields keep their state, focus and
 * caret once its item is written.
 */
export function ItemScope({
  listPath,
  index,
  held,
  seed,
  children,
}: {
  listPath: ValuePath;
  index: number;
  /** The held card's: its fields read and write the held item. */
  held?: HeldItem | undefined;
  /** What the held item starts with. */
  seed?: unknown;
  children: ReactNode;
}) {
  const form = useForm();
  const pathKey = JSON.stringify([...listPath, index]);
  const scoped = useMemo(() => {
    const prefix = JSON.parse(pathKey) as ValuePath;
    return formSource(
      (inner) => form.read([...prefix, ...inner]),
      (changes) => form.apply(changes.map((change) => ({ ...change, path: [...prefix, ...change.path] }))),
      form.disabled,
    );
  }, [form, pathKey]);
  return (
    <FormProvider form={held ? held.source(seed) : scoped}>
      <HeldNotices hold={held?.notice} prefix={held ? undefined : [...listPath, index]}>
        {children}
      </HeldNotices>
    </FormProvider>
  );
}
