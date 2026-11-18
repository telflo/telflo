import { useState } from "react";

/**
 * A number that changes each time `open` turns true, for a dialog to key its
 * contents by, so that each opening is a new session: a field holding its
 * value afresh, no earlier refusal, and no "Saving…" or "Deleting..." left
 * over from a write that outlived the last opening (an organization switch
 * closes a dialog mid-write; the write's late answer is dropped, and the
 * next opening must not inherit its state). Counted during render, React's
 * pattern for state that follows a prop, so the new session is the first one
 * rendered open.
 */
export function useOpeningKey(open: boolean): number {
  const [opening, setOpening] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpening((count) => count + 1);
  }
  return opening;
}
