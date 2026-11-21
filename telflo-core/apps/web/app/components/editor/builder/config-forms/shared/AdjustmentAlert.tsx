import { createContext, useContext, useMemo, type ReactNode } from "react";
import { toast } from "sonner";

import type { ValuePath } from "~/lib/graph/text-edits.js";
import type { ValuesResult } from "~/lib/stores/editor-store.js";

/*
 * The adjustment notice: a control that also changed another setting, so
 * the collector would take the combination, says so in a toast, as the
 * editor's other changes do. The change is one write (one undo entry); a
 * write refused or changing nothing toasts nothing. Nothing shows inline:
 * the toast is the one notice.
 *
 * The toast reports a change to the text: inside a held card or row
 * (`useHeldItem`, whose `ItemScope` gives its fields a `HeldNotices`
 * scope), a write the held card keeps is no change to the text, so its
 * messages are held with the card and toasted when the card is written
 * (with that write, once), never if it is dropped. A message can name the
 * paths its cascade adjusted (`Notice`): a later change in the held card
 * touching one of them drops it (Combine's "set to sum", then Aggregation
 * Type mean chosen, says nothing of sum).
 *
 * The toast is text, never an attribute.
 */

/**
 * An adjustment message with the paths its cascade adjusted, under the source
 * the write was made through: held in a card, it is dropped when a later
 * change in the card touches one of them.
 */
export interface Notice {
  message: string;
  adjusted: readonly ValuePath[];
}

/** Where a write's notices go. */
export type Notices = (notices: readonly Notice[]) => void;

export interface Adjustments {
  /**
   * After a write that adjusted other settings: toasts `messages`, joined,
   * if the write was made. A message given as a `Notice` names the paths
   * its cascade adjusted; a plain one names none (a held card keeps it).
   */
  note: (messages: ReadonlyArray<string | Notice>, result: ValuesResult) => void;
}

/** Toasts the adjustment messages, joined, each once (a held card may hold one message for two paths). */
export function toastAdjustments(notices: readonly Notice[]): void {
  toast.info([...new Set(notices.map((notice) => notice.message))].join(" "));
}

/** Whether a change at `path` touches `adjusted`: one is the other or holds it. */
export function touches(path: ValuePath, adjusted: ValuePath): boolean {
  const length = Math.min(path.length, adjusted.length);
  for (let i = 0; i < length; i++) if (path[i] !== adjusted[i]) return false;
  return true;
}

/** `notices` with their paths under `prefix`: as the source a scope's own is under reads them. */
export function underPrefix(prefix: ValuePath, notices: readonly Notice[]): Notice[] {
  return notices.map((notice) => ({ ...notice, adjusted: notice.adjusted.map((path) => [...prefix, ...path]) }));
}

/** Where a write's messages go: the nearest held card's (held until it is written), or none (toasted). */
const HeldNoticesContext = createContext<Notices | null>(null);

/**
 * The scope of a held card's fields: their messages go to `hold` (the held
 * card's). Without `hold` (an item in the text, a `FormScope`) it passes
 * its parent's on, with the paths under `prefix` (where the scope's source
 * is under its parent's), so the element is the same either way and a
 * written card's fields keep their state.
 */
export function HeldNotices({
  hold,
  prefix,
  children,
}: {
  hold?: Notices | undefined;
  prefix?: ValuePath | undefined;
  children: ReactNode;
}) {
  const parent = useContext(HeldNoticesContext);
  const prefixKey = prefix !== undefined && prefix.length > 0 ? JSON.stringify(prefix) : undefined;
  const passed = useMemo<Notices | null>(() => {
    if (parent === null || prefixKey === undefined) return parent;
    const under = JSON.parse(prefixKey) as ValuePath;
    return (notices) => parent(underPrefix(under, notices));
  }, [parent, prefixKey]);
  return <HeldNoticesContext.Provider value={hold ?? passed}>{children}</HeldNoticesContext.Provider>;
}

/** Where messages go from here: the enclosing held card's, or a toast. */
export function useNotices(): Notices {
  return useContext(HeldNoticesContext) ?? toastAdjustments;
}

/** A form's adjustment notice: a toast per write made (held with a held card). It renders nothing and holds no state. */
export function useAdjustments(): Adjustments {
  const notices = useNotices();
  return {
    note: (messages, result) => {
      if (result !== "written") return;
      notices(messages.map((message) => (typeof message === "string" ? { message, adjusted: [] } : message)));
    },
  };
}
