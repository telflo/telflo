import { useEffect, useRef } from "react";

/**
 * What pauses polling: an open Radix Dialog or AlertDialog. A Radix Popover's
 * content is a `role="dialog"` too, so an open Popover pauses it as well: the
 * organization menu, say. That is deliberate (a refresh under it could reset
 * what the person is choosing), and it resumes on the first tick after the
 * Popover closes.
 */
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * Calls `callback` every `intervalMs` while the component is mounted and the
 * tab is visible (D17a decision 8, Preflight ruling 10).
 *
 * - **The callback must return its work's promise** (its request's, or the
 *   async function's own), never fire it and return at once: the in-flight
 *   guard awaits it, and a tick that comes while it is unsettled is skipped,
 *   so a slow network can't stack overlapping polls. A callback like
 *   `() => void loadPage(true)` settles at once and defeats the guard
 *   (five overlapping loads in five seconds), so the type asks for a
 *   promise. A rejection is ignored (the
 *   callback reports its own failures); the polling goes on.
 * - **The callback's identity doesn't matter**: the latest one is kept in a
 *   ref, and the interval depends on `intervalMs` alone, so a callback made
 *   afresh on every render neither restarts the interval nor delays the
 *   next tick.
 * - A tick is skipped while a modal dialog is open (`OPEN_DIALOG`: an open
 *   Popover too), so a refresh never re-renders a list beneath a dialog the
 *   person is using; the next tick after it closes runs.
 * - Hidden, the interval stops. Visible again, it ticks once at once (the
 *   rows were frozen while hidden) and then every `intervalMs`.
 *
 * Nothing runs during server rendering, where there is no document.
 */
export function useVisiblePolling(callback: () => Promise<unknown>, intervalMs: number): void {
  const latestCallback = useRef(callback);
  useEffect(() => {
    latestCallback.current = callback;
  });

  useEffect(() => {
    if (typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      if (document.querySelector(OPEN_DIALOG) !== null) return;
      inFlight = true;
      try {
        await latestCallback.current();
      } catch {
        // The callback reports its own failures; the polling goes on.
      } finally {
        inFlight = false;
      }
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // The rows were frozen while hidden: refresh now, not a full interval later.
        void tick();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [intervalMs]);
}
