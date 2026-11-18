import { useRef, useState, type KeyboardEvent } from "react";

import { useHeldEdit } from "./held-edits.js";
import { isSaveShortcut } from "./unsaved-guard.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * Typing held as an edit (D9b decision 2; Preflight rulings 12 and 24): the
 * form fields' text, and a list row's. What is typed is a draft; it is
 * written 300 ms after the last keystroke (as D9a's YAML box, Preflight
 * ruling 22), at once on blur, on Enter (where Enter commits), on Cmd/Ctrl+S
 * before the page saves, when a save, a navigation or the panel (a tab
 * change, its collapse or rail; Rulings 86 and 89: the Configuration tab
 * stays mounted while hidden) flushes every held edit, and when the field
 * goes (a section collapsing, another node selected). A draft is written only when it differs from what the field
 * shows, so blurring a field showing `0750` writes nothing.
 *
 * After a write the field shows the text again: what was written, or, when
 * the store refused it, what the text still holds. A draft never writes
 * into a configuration loaded after it began (D9a ruling 37), whose nodes
 * can have the same ids.
 */

/** How long after the last keystroke a field writes (Preflight ruling 22). */
export const FIELD_WRITE_DELAY_MS = 300;

export interface HeldText {
  /** What the field shows: the draft while there is one, else `shown`. */
  value: string;
  /** Whether a draft differs from what the text shows, or with `writeSame` is there at all (registered as held). */
  held: boolean;
  /** A keystroke: the draft becomes `value`, written after the pause. */
  change: (value: string) => void;
  /** Writes the draft now, if it differs from what's shown; drops it either way. */
  flush: () => void;
  /** Cmd/Ctrl+S flushes before the page's save sees the key; Enter too, when `enterCommits`. */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>, enterCommits?: boolean) => void;
}

/**
 * A field's typing over `shown` (what the text holds, as the field shows
 * it), written through `write` when it differs. With `pause: false` the
 * draft isn't written after the pause, only on blur, Enter, a flush or
 * unmount (a header's name, renamed once it is complete, as D9a's instance
 * name; D9b decision 4). `pause` may instead say which drafts the pause
 * writes: a held-row list's row emptied is removed only once it is left
 * (D9c Preflight ruling 8), not under the cursor. With `writeSame`, a draft
 * is written even when it reads as what is shown: the text holds another
 * type with those characters (docker_stats' `api_version` written as a
 * number, retyped to quote it; D9c Ruling 47). Only typing makes a draft, so
 * focusing and leaving still writes nothing.
 */
export function useHeldText(
  shown: string,
  write: (typed: string) => void,
  { pause = true, writeSame = false }: { pause?: boolean | ((typed: string) => boolean); writeSame?: boolean } = {},
): HeldText {
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  /** The load the draft began in. */
  const draftLoad = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const writeRef = useRef(write);
  writeRef.current = write;
  const writeSameRef = useRef(writeSame);
  writeSameRef.current = writeSame;

  const setDraft = (value: string | null) => {
    if (value !== null && draftRef.current === null) draftLoad.current = useEditorStore.getState().loadCount;
    draftRef.current = value;
    setDraftState(value);
  };

  const flush = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const typed = draftRef.current;
    if (typed === null) return;
    setDraft(null);
    if ((typed === shownRef.current && !writeSameRef.current) || useEditorStore.getState().loadCount !== draftLoad.current) return;
    writeRef.current(typed);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const held = draft !== null && (writeSame || draft !== shown);
  useHeldEdit(held, flush);

  return {
    value: draft ?? shown,
    held,
    change: (value) => {
      setDraft(value);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (typeof pause === "function" ? !pause(value) : !pause) return;
      timer.current = setTimeout(() => flushRef.current(), FIELD_WRITE_DELAY_MS);
    },
    flush,
    handleKeyDown: (event, enterCommits = true) => {
      // Written before the key reaches the page, whose save then has it.
      if (isSaveShortcut(event) || (enterCommits && event.key === "Enter")) flush();
    },
  };
}
