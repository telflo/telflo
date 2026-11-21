import { useCallback, useMemo, useRef } from "react";

/** Where focus goes when a dialog's opener is gone (its row deleted, its bar emptied): null for nowhere. */
export type FocusFallback = () => HTMLElement | null;

/** Whether focus can go to an element: still in the document, and not disabled. */
function canFocus(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && !element.matches(":disabled");
}

export interface ReturnFocus {
  /** A dialog opens from `from` (the button pressed), with `fallback` for when it's gone by the close. */
  opened: (from: HTMLElement | null, fallback: FocusFallback) => void;
  /**
   * The next close hands over to another dialog opened in its place (the
   * details' "Edit collector", the fleet type chosen): it leaves the focus
   * where the new dialog put it, and the opener is the new dialog's.
   */
  handOff: () => void;
  /** Every dialog's `onCloseAutoFocus`: back to the opener, else its fallback. */
  returnFocus: (event: Event) => void;
  /**
   * A write from the dialog opened last (or its unknown outcome) is reading
   * the rows again, before or after the close. `latestRead` is the number
   * of the host's latest read begun (its read counter: `useReadOrder`'s),
   * taken as the write's reload is about to begin: a read numbered above it
   * began after the write.
   */
  wrote: (latestRead: number) => void;
  /**
   * The host's rows rendered again, from the read numbered `rowsRead` (the
   * same counter; 0 with none shown): after a write (`wrote`), when the
   * element the focus went back to has gone with its row, taking the focus
   * with it, the focus goes to the fallback; never from where the person
   * has put it since, and never after a close that made no write (a read
   * dropping the row an Escape went back to leaves the focus alone: the
   * person may have put it elsewhere).
   *
   * What spends the write is when the rows' read began, never who asked for
   * it. Rows from a read begun after the write (its reload) spend it, a
   * close behind them or not: rows rendered before the close's deferred
   * focus return (a browser's usual order, Radix waiting out the exit
   * animation) leave nothing for a later read. Rows from a read begun
   * before the write (a poll's, or the person's own "Load more", Refresh,
   * search, filter, sort, Prev or Next) may hold the row the write removed
   * and land between the write and its reload: they spend it only once a
   * close has happened, so before the close it is left for the reload.
   */
  rowsChanged: (rowsRead: number) => void;
}

/**
 * Focus back to a dialog's opener as it closes: the dialogs here open without
 * a Radix `DialogTrigger`, so Radix's own close has nothing to focus and
 * leaves the focus on the body. Each `onCloseAutoFocus` prevents Radix's and
 * focuses the button that opened the dialog, else (its row deleted, the bar
 * gone, a button disabled meanwhile) the fallback named as it opened. A dialog
 * closed before its write's reload has answered gives the focus back to a row
 * that the reload then removes: `rowsChanged`, called once the rows have
 * rendered again, moves it on, only when the dialog made a write (`wrote`, the
 * host's reload after one): a poll is no write. Which rows spend the write
 * follows when their read began, after the write or before it, never who asked
 * for it (`rowsChanged`).
 */
export function useReturnFocus(): ReturnFocus {
  const opener = useRef<{ from: HTMLElement | null; fallback: FocusFallback } | null>(null);
  const handingOff = useRef(false);
  // Where the latest close put the focus, with its fallback, until a write's rows render.
  const returned = useRef<{ to: HTMLElement; fallback: FocusFallback } | null>(null);
  // The host's latest read begun when the dialog opened last made a write (`wrote`) whose rows haven't rendered yet; null for none.
  const writtenAfter = useRef<number | null>(null);

  const opened = useCallback((from: HTMLElement | null, fallback: FocusFallback) => {
    opener.current = { from, fallback };
    handingOff.current = false;
    returned.current = null;
    writtenAfter.current = null;
  }, []);

  const wrote = useCallback((latestRead: number) => {
    writtenAfter.current = latestRead;
  }, []);

  const handOff = useCallback(() => {
    handingOff.current = true;
  }, []);

  const returnFocus = useCallback((event: Event) => {
    event.preventDefault();
    if (handingOff.current) {
      handingOff.current = false;
      return;
    }
    const current = opener.current;
    opener.current = null;
    if (current === null) return;
    const to = canFocus(current.from) ? current.from : current.fallback();
    if (!canFocus(to)) return;
    to.focus();
    returned.current = { to, fallback: current.fallback };
  }, []);

  const rowsChanged = useCallback((rowsRead: number) => {
    const write = writtenAfter.current;
    // No write behind these rows: nothing to move, and nothing spent.
    if (write === null) return;
    // Rows from a read begun before the write, the close not yet made: they
    // may hold the row the write removed, landing ahead of its reload. The
    // write is left for the reload's rows.
    if (rowsRead <= write && returned.current === null) return;
    // Rows from a read begun after the write (its reload), or any rows once
    // the close has happened: the write is spent here, even with no close
    // yet (the reload rendered before the close's deferred focus return,
    // which then sees the row as it is), so a later read never acts on it.
    writtenAfter.current = null;
    const latest = returned.current;
    if (latest === null) return;
    returned.current = null;
    if (latest.to.isConnected) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const fallback = latest.fallback();
    if (canFocus(fallback)) fallback.focus();
  }, []);

  return useMemo(
    () => ({ opened, handOff, returnFocus, wrote, rowsChanged }),
    [opened, handOff, returnFocus, wrote, rowsChanged],
  );
}
