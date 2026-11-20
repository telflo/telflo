import { describe, expect, it } from "vitest";

import { rematch, type CardState } from "./card-keys.js";

/*
 * The cards' keys after a change the form didn't make: snapshots are letters
 * here, and each card is named by its first key, so a result says which card
 * each item's card is.
 */

const init = (snapshots: string[]): CardState => ({ keys: snapshots.map((_s, i) => i), snapshots, next: snapshots.length, own: false });
/** The state after the form's own change put `keys` over `snapshots`. */
const own = (state: CardState, keys: number[], snapshots: string[]): CardState => ({ ...state, keys, snapshots });

describe("rematch", () => {
  it.each([
    ["the first of two identical items edited: both keep their keys", init(["A", "A"]), ["A'", "A"], [0, 1]],
    ["the second of two identical items edited", init(["A", "A"]), ["A", "A'"], [0, 1]],
    ["an edit making an item read as the other", init(["A", "B"]), ["B", "B"], [0, 1]],
    ["a move of B to the top of [A, A, B] undone", own(init(["A", "A", "B"]), [2, 0, 1], ["B", "A", "A"]), ["A", "A", "B"], [0, 1, 2]],
    ["a move of B in [A, B, A, A] undone", own(init(["A", "B", "A", "A"]), [1, 0, 2, 3], ["B", "A", "A", "A"]), ["A", "B", "A", "A"], [0, 1, 2, 3]],
    ["the YAML box swaps two and edits a third", init(["A", "B", "C"]), ["B", "A", "C'"], [1, 0, 2]],
    ["the YAML box adds a duplicate", init(["A"]), ["A", "A"], [0, 1]],
    ["the YAML box inserts at the top", init(["A", "B"]), ["N", "A", "B"], [2, 0, 1]],
    ["a removal undone gives the restored item a fresh key", own(init(["A", "B", "C"]), [1, 2], ["B", "C"]), ["A", "B", "C"], [3, 1, 2]],
  ] as const)("%s", (_name, state, snapshots, keys) => {
    expect(rematch(state, snapshots).keys).toEqual(keys);
  });

  it("an edit and its undo, with two identical items, keep every key", () => {
    const edited = rematch(init(["A", "A"]), ["A'", "A"]);
    expect(rematch(edited, ["A", "A"]).keys).toEqual([0, 1]);
  });
});
