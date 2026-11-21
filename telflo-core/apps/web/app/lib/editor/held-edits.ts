import { useEffect, useRef } from "react";

/*
 * Edits a field holds that the store doesn't have yet (the name field's and
 * the YAML box's among them): a name typed but not committed, a write
 * waiting for the typing's pause, one refused.
 *
 * A field holding one registers its `flush`, which writes what it holds (and
 * does nothing when it holds nothing). The page's save flushes every held edit
 * first, so Cmd/Ctrl+S (and the toolbar's Save) saves what the fields hold; a
 * navigation elsewhere in the app flushes them before it is judged, so the
 * page's Unsaved Changes dialog sees them; the panel flushes them before its
 * tab changes, it collapses or its rail expands it (the Configuration tab
 * stays mounted while hidden, so its fields don't go); a field flushes when it
 * goes (a section collapsing, another node selected); and while any edit is
 * held, closing or reloading the tab asks the browser's question, through one
 * `beforeunload` listener (the store reads clean until the edit is written, so
 * the page's own guard can't).
 */

const held = new Map<object, { current: () => void }>();

function handleBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = "";
}

function hold(token: object, flush: { current: () => void }) {
  if (held.size === 0) window.addEventListener("beforeunload", handleBeforeUnload);
  held.set(token, flush);
}

function release(token: object) {
  if (!held.delete(token)) return;
  if (held.size === 0) window.removeEventListener("beforeunload", handleBeforeUnload);
}

/**
 * Writes every held edit, now: before the page saves, and before a
 * navigation away is judged (use-navigation-guard). One field's flush
 * throwing doesn't stop the others': each is flushed, one that
 * threw is released (it would otherwise hold for good, keeping the unload
 * guard armed and failing every save's flush after), and the first error is
 * thrown once all have run. A flush that returns leaves its field to say
 * whether it still holds: written, it releases itself; refused, it holds.
 */
export function flushHeldEdits(): void {
  let failure: { error: unknown } | null = null;
  for (const [token, flush] of [...held]) {
    try {
      flush.current();
    } catch (error) {
      failure ??= { error };
      release(token);
    }
  }
  if (failure !== null) throw failure.error;
}

/**
 * Registers the field's `flush` while `isHeld` (it holds an edit the store
 * doesn't have), and flushes when the field unmounts. `flush` must do
 * nothing when there is nothing to write; the latest one given is used.
 */
export function useHeldEdit(isHeld: boolean, flush: () => void): void {
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    if (!isHeld) return;
    const token = {};
    hold(token, flushRef);
    return () => release(token);
  }, [isHeld]);

  // What the field still holds when it goes is written then.
  useEffect(() => () => flushRef.current(), []);
}
