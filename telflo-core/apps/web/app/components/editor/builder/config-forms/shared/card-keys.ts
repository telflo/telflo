import { useState } from "react";

/*
 * The cards of a sortable list keep their local state (expanded, a held
 * row, a field's typing) with their item, not their position (D9c
 * Preflight ruling 25). k8sobjects'
 * objects (Task 2), k8sattributes' rules, labels and annotations (Task 3)
 * and the operator cards (Task 5) key their cards by these keys, never by
 * a value (decision 10).
 *
 * Each key remembers its item as it last read (a snapshot of its value).
 * - The form's own add, remove and move say what they did: the keys are
 *   moved, dropped or added with the item, and take the items' new
 *   snapshots. This holds when an item's typing is written just before it
 *   moves (a move writes held edits first), which no snapshot could match.
 * - Any other change to the list (an undo or redo, the YAML box, another
 *   field of the card) is matched by snapshot (D9c Rulings 35, 55 and 65):
 *   the old and new snapshots are aligned by a longest common subsequence
 *   (as the text edits' `listSteps` aligns a list), a common prefix and
 *   suffix first, ties broken toward the same index, and each aligned item
 *   keeps its key. So with two identical items, the one not edited keeps
 *   its key, and the edited one keeps its own (Ruling 55: had the other's
 *   key matched it, React would move the focused card, and its typing, onto
 *   the other item). An item the alignment leaves out then takes the first
 *   unused key whose snapshot it equals (an item moved past others: undoing
 *   a move of `B` in `[A, A, B]` gives every card back its key); an item
 *   none equals, while the list keeps its length, takes the key at its own
 *   position if that is unused (a card's own field edited in place); any
 *   other item gets a fresh key, so its card starts afresh, as a new card
 *   of its list starts (collapsed for the Kubernetes cards, expanded for an
 *   operator's), with no held row, never another card's state.
 *
 * Batching: the form's write to the store and the key change it makes land
 * in one render (React batches every update in one event or task under
 * `createRoot`, the store's subscription included). Were they rendered
 * apart, the store's change would be matched by snapshot first (the right
 * cards for a move or a remove, but a moved card whose typing was just
 * written would get a fresh key), and the own change would then apply to
 * keys already matched, moving or dropping the wrong ones.
 */

export interface CardState {
  keys: readonly number[];
  /** Each key's item, as it last read. */
  snapshots: readonly string[];
  next: number;
  /** The form's own change is pending: the keys follow it rather than a match. */
  own: boolean;
}

/** An item's value as a comparable snapshot. */
function snapshotOf(item: unknown): string {
  return JSON.stringify(item, (_key, value: unknown) => (typeof value === "bigint" ? `${value}n` : value)) ?? "";
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Which old index each new snapshot aligns with, by a longest common
 * subsequence (Ruling 65): the common prefix and suffix, then a table over
 * the middle, ties broken toward the same index.
 */
function align(old: readonly string[], now: readonly string[]): (number | undefined)[] {
  const matched: (number | undefined)[] = now.map(() => undefined);
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) {
    matched[start] = start;
    start++;
  }
  let endOld = old.length;
  let endNow = now.length;
  while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) {
    endOld--;
    endNow--;
    matched[endNow] = endOld;
  }
  // lengths[i][j]: the common subsequence's length of old[i..endOld) and now[j..endNow).
  const rows = endOld - start + 1;
  const columns = endNow - start + 1;
  const lengths = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
  for (let i = rows - 2; i >= 0; i--) {
    for (let j = columns - 2; j >= 0; j--) {
      lengths[i]![j] =
        old[start + i] === now[start + j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows - 1 && j < columns - 1) {
    if (old[start + i] === now[start + j]) {
      matched[start + j] = start + i;
      i++;
      j++;
    } else {
      const skipOld = lengths[i + 1]![j]!;
      const skipNow = lengths[i]![j + 1]!;
      // A tie steps whichever side is behind, toward the same index.
      if (skipOld > skipNow || (skipOld === skipNow && i < j)) i++;
      else j++;
    }
  }
  return matched;
}

/** The keys for `snapshots`, matched against the keys' last snapshots (Rulings 35, 55 and 65). Exported for its tests. */
export function rematch(state: CardState, snapshots: readonly string[]): CardState {
  const aligned = align(state.snapshots, snapshots);
  const used = new Set<number>(aligned.filter((at): at is number => at !== undefined));
  const keys: (number | undefined)[] = aligned.map((at, position) => {
    if (at !== undefined) return state.keys[at];
    const moved = state.snapshots.findIndex((previous, index) => !used.has(index) && previous === snapshots[position]);
    if (moved === -1) return undefined;
    used.add(moved);
    return state.keys[moved];
  });
  if (snapshots.length === state.keys.length) {
    keys.forEach((key, index) => {
      if (key === undefined && !used.has(index)) {
        used.add(index);
        keys[index] = state.keys[index];
      }
    });
  }
  let next = state.next;
  return { keys: keys.map((key) => key ?? next++), snapshots, next, own: false };
}

/**
 * The cards' own keys for `items` (the list's values, in order), and the
 * form's own changes to report once each is written: `add` (an item
 * appended), `remove(index)`, `move(from, to)`. `next` is the key `add`
 * gives: a held card (journald's held match, D9c Task 8) takes it, so it
 * is the same card once its item is written.
 */
export function useCardKeys(items: readonly unknown[]) {
  const snapshots = items.map(snapshotOf);
  const [state, setState] = useState<CardState>(() => ({
    keys: snapshots.map((_s, index) => index),
    snapshots,
    next: snapshots.length,
    own: false,
  }));
  let current = state;
  if (state.own || !sameList(state.snapshots, snapshots)) {
    current =
      state.own && state.keys.length === snapshots.length ? { ...state, snapshots, own: false } : rematch(state, snapshots);
    setState(current);
  }
  return {
    keys: current.keys,
    next: current.next,
    add: () => setState((s) => ({ ...s, keys: [...s.keys, s.next], next: s.next + 1, own: true })),
    remove: (index: number) => setState((s) => ({ ...s, keys: s.keys.filter((_k, i) => i !== index), own: true })),
    move: (from: number, to: number) =>
      setState((s) => {
        const keys = [...s.keys];
        const [moved] = keys.splice(from, 1);
        keys.splice(to, 0, moved!);
        return { ...s, keys, own: true };
      }),
  };
}

/** An array index to JavaScript: a canonical integer string below 2^32 - 1, which objects order first. */
function isArrayIndex(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 4294967295;
}

/**
 * Where the key at `index` of a mapping's keys (`Object.keys` of its value,
 * in that order) lands once renamed to `to` (D9c Ruling 79): a mapping's
 * keys are read in the text's order, but JavaScript lists integer-like keys
 * first, ascending, so a rename to `5` moves the row to the top. The form
 * reports the rename as a move (`useCardKeys`' `move`), so the row keeps
 * its key, and its input its focus, wherever it lands.
 */
export function renamedIndex(names: readonly string[], index: number, to: string): number {
  const renamed = names.map((name, at) => (at === index ? to : name));
  const ordered = [
    ...renamed.filter(isArrayIndex).sort((a, b) => Number(a) - Number(b)),
    ...renamed.filter((name) => !isArrayIndex(name)),
  ];
  return ordered.indexOf(to);
}
