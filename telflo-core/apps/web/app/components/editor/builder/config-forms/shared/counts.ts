import type { ValueView } from "~/lib/graph/value-view.js";

/*
 * The counts the section headers show (a list's length, the set items'
 * count), read from the text (D9c Task 2).
 */

/** A list's length; 0 for anything that isn't a list. */
export function listLength(view: ValueView): number {
  return view.kind === "list" ? view.value.length : 0;
}

/** Whether a value counts as set: not unset, `false`, `0` or `""`. */
export function isTruthy(view: ValueView): boolean {
  if (view.kind === "absent") return false;
  if (view.kind !== "scalar") return true;
  return view.value !== false && view.value !== 0 && view.value !== "";
}
