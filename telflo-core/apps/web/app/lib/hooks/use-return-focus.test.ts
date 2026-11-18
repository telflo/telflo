import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useReturnFocus } from "./use-return-focus.js";

/*
 * useReturnFocus's orders the hosts can't fix in a test (D17b-1's last
 * reviews): Radix gives the focus back in a timeout after the dialog's
 * content unmounts (in a browser, after its exit animation), so a write's
 * reload usually renders its rows before the close's focus return; and a
 * read begun before the write (a poll's, or the person's "Load more" or
 * Refresh) may answer between the write and its reload. The host's calls
 * are made here in those orders. The numbers are the host's read counter:
 * the write is made with read 4 the latest begun, so its reload is read 5.
 */

/** A button in the document, as a row's would be. */
function button(name: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = name;
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useReturnFocus", () => {
  it("spends a write on rows from a read begun after it, rendered before the close's focus return: a later poll taking the row away never moves the focus", () => {
    const { result } = renderHook(() => useReturnFocus());
    const focus = result.current;
    const row = button("Edit collector-002");
    const fallback = button("collector-001");

    // The edit opened from the row; its save starts the reload, whose rows render (the row kept) before the close.
    act(() => focus.opened(row, () => fallback));
    act(() => focus.wrote(4));
    act(() => focus.rowsChanged(5));
    // The close's deferred focus return: back on the row.
    act(() => focus.returnFocus(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
    expect(document.activeElement).toBe(row);

    // The person blurs it; a poll then takes the row away.
    act(() => row.blur());
    row.remove();
    act(() => focus.rowsChanged(6));
    expect(document.activeElement).toBe(document.body);
  });

  it("still moves the focus on when the write's rows render after the close and take the row away (D14b Ruling 52)", () => {
    const { result } = renderHook(() => useReturnFocus());
    const focus = result.current;
    const row = button("Delete collector-002");
    const fallback = button("collector-001");

    act(() => focus.opened(row, () => fallback));
    act(() => focus.wrote(4));
    act(() => focus.returnFocus(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
    expect(document.activeElement).toBe(row);

    // The reload's rows lack the row: its button goes, the focus with it.
    row.remove();
    act(() => focus.rowsChanged(5));
    expect(document.activeElement).toBe(fallback);
  });

  // The review of 32f39ff: what counts is when the rows' read began, not who asked for it.
  it("leaves a write to its reload when rows from a read begun before it (a poll's, or the person's \"Load more\" or Refresh) render before the close: the reload taking the row away moves the focus on", () => {
    const { result } = renderHook(() => useReturnFocus());
    const focus = result.current;
    const row = button("Delete collector-002");
    const fallback = button("collector-001");

    // Read 4, begun before the delete, answers (the row kept) between the write and its reload.
    act(() => focus.opened(row, () => fallback));
    act(() => focus.wrote(4));
    act(() => focus.rowsChanged(4));
    act(() => focus.returnFocus(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
    expect(document.activeElement).toBe(row);

    // The reload, late, lacks the row.
    row.remove();
    act(() => focus.rowsChanged(5));
    expect(document.activeElement).toBe(fallback);
  });

  it("spends a write on rows from a read begun before it once the close has happened: the row gone with them, the focus moves on", () => {
    const { result } = renderHook(() => useReturnFocus());
    const focus = result.current;
    const row = button("Delete collector-002");
    const fallback = button("collector-001");

    act(() => focus.opened(row, () => fallback));
    act(() => focus.wrote(4));
    act(() => focus.returnFocus(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
    expect(document.activeElement).toBe(row);

    // Read 4's rows lack the row: the write is spent on them.
    row.remove();
    act(() => focus.rowsChanged(4));
    expect(document.activeElement).toBe(fallback);
  });

  it("never moves the focus after a close that made no write, whatever read's rows take the row away", () => {
    const { result } = renderHook(() => useReturnFocus());
    const focus = result.current;
    const row = button("Delete collector-002");
    const fallback = button("collector-001");

    // Escape: no write.
    act(() => focus.opened(row, () => fallback));
    act(() => focus.returnFocus(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
    expect(document.activeElement).toBe(row);

    // A Refresh begun after the close (read 5) lacks the row.
    row.remove();
    act(() => focus.rowsChanged(5));
    expect(document.activeElement).toBe(document.body);
  });

  it("forgets a write when a dialog opens anew: that dialog's close, with no write, never moves the focus", () => {
    const { result } = renderHook(() => useReturnFocus());
    const focus = result.current;
    const first = button("Edit collector-002");
    const second = button("collector-003");
    const fallback = button("collector-001");

    // A write whose reload never rendered rows (it failed); then the details opened and closed by Escape.
    act(() => focus.opened(first, () => fallback));
    act(() => focus.wrote(4));
    act(() => focus.returnFocus(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
    act(() => focus.opened(second, () => fallback));
    act(() => focus.returnFocus(new Event("focusScope.autoFocusOnUnmount", { cancelable: true })));
    expect(document.activeElement).toBe(second);

    // A poll (read 6) lacks the row.
    second.remove();
    act(() => focus.rowsChanged(6));
    expect(document.activeElement).toBe(document.body);
  });
});
