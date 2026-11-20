import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover.js";
import { useVisiblePolling } from "./use-visible-polling.js";

/*
 * The polling's basics, then its finer rules. Time is vitest's fake timers
 * throughout: `advanceTimersByTimeAsync` also flushes each tick's promise,
 * so the in-flight guard has settled between ticks.
 */

let visibility: DocumentVisibilityState = "visible";

/** The tab becoming visible or hidden, as the browser says so. */
function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A callback whose every call waits until the test settles it. */
function slowCallback() {
  const settles: Array<() => void> = [];
  const callback = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settles.push(resolve);
      }),
  );
  return { callback, settleAll: () => settles.splice(0).forEach((settle) => settle()) };
}

describe("useVisiblePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    // The document's own getter again.
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
    document.body.innerHTML = "";
  });

  // The basics.

  it("calls the callback on each interval while visible", async () => {
    const callback = vi.fn(() => Promise.resolve());
    renderHook(() => useVisiblePolling(callback, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("refreshes immediately when the tab becomes visible again", async () => {
    visibility = "hidden";
    const callback = vi.fn(() => Promise.resolve());
    renderHook(() => useVisiblePolling(callback, 1000));

    // Hidden on mount: no interval runs.
    await vi.advanceTimersByTimeAsync(3000);
    expect(callback).not.toHaveBeenCalled();

    // Returning to the tab refreshes at once, before the next tick,
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);

    // and the interval runs from there.
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("skips ticks while a modal dialog is open, and resumes when it closes", async () => {
    const callback = vi.fn(() => Promise.resolve());
    renderHook(() => useVisiblePolling(callback, 1000));

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);

    await vi.advanceTimersByTimeAsync(3000);
    expect(callback).not.toHaveBeenCalled();

    dialog.remove();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  // The finer rules.

  it("skips ticks while an alert dialog is open too", async () => {
    const callback = vi.fn(() => Promise.resolve());
    renderHook(() => useVisiblePolling(callback, 1000));

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    await vi.advanceTimersByTimeAsync(2000);
    expect(callback).not.toHaveBeenCalled();

    dialog.setAttribute("data-state", "closed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("is paused by an open Popover (the organization menu's), whose content is a dialog", async () => {
    const callback = vi.fn(() => Promise.resolve());
    renderHook(() => useVisiblePolling(callback, 1000));
    const { rerender } = render(
      <Popover open>
        <PopoverTrigger>Organization</PopoverTrigger>
        <PopoverContent>Switch organization</PopoverContent>
      </Popover>,
    );

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(callback).not.toHaveBeenCalled();

    rerender(
      <Popover open={false}>
        <PopoverTrigger>Organization</PopoverTrigger>
        <PopoverContent>Switch organization</PopoverContent>
      </Popover>,
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("never overlaps a slow poll: ticks while it is unsettled are skipped, and the next one after it runs", async () => {
    const { callback, settleAll } = slowCallback();
    renderHook(() => useVisiblePolling(callback, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);
    // Four more ticks while the first is still waiting: none calls again.
    await vi.advanceTimersByTimeAsync(4000);
    expect(callback).toHaveBeenCalledTimes(1);

    settleAll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a slow poll with the refresh on becoming visible", async () => {
    const { callback, settleAll } = slowCallback();
    renderHook(() => useVisiblePolling(callback, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);

    settleAll();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("goes on polling after a callback rejects", async () => {
    const callback = vi.fn(() => Promise.reject(new Error("the poll's own failure")));
    renderHook(() => useVisiblePolling(callback, 1000));

    await vi.advanceTimersByTimeAsync(3000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("doesn't restart the interval for a new callback identity, and calls the latest callback", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(({ callback }) => useVisiblePolling(callback, 1000), {
      initialProps: { callback: first },
    });

    await vi.advanceTimersByTimeAsync(600);
    rerender({ callback: second });
    // A restarted interval would wait until 1,600 ms; the original ticks at 1,000.
    await vi.advanceTimersByTimeAsync(400);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    // A fresh identity on every render changes nothing either.
    rerender({ callback: vi.fn(() => Promise.resolve()) });
    rerender({ callback: second });
    await vi.advanceTimersByTimeAsync(1000);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("stops while the tab is hidden", async () => {
    const callback = vi.fn(() => Promise.resolve());
    renderHook(() => useVisiblePolling(callback, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("stops on unmount", async () => {
    const callback = vi.fn(() => Promise.resolve());
    const { unmount } = renderHook(() => useVisiblePolling(callback, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    unmount();

    await vi.advanceTimersByTimeAsync(3000);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
