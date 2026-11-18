import { useCallback, useEffect, useRef } from "react";
import { abortAfter } from "~/lib/abort-after.js";

/** A read's answer, or its failure. */
export type ReadAnswer<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

/**
 * Runs one read of a dialog's opening under its own hang guard (the hook's
 * `timeoutMs`); resolves with its answer or its failure, or null once the
 * opening is over (the dialog closed or unmounted meanwhile), whose answer
 * nothing takes.
 */
export type OpeningRead = <Value>(run: (signal: AbortSignal) => Promise<Value>) => Promise<ReadAnswer<Value> | null>;

/**
 * The reads of one opening of a dialog that reads while it is open (D17b-1
 * Preflight ruling 11; D17a's pattern): each read has its own hang guard
 * (`abortAfter(timeoutMs)`, a fake timer in tests), and every read still
 * under way is aborted when `open` turns false or the component unmounts,
 * its answer dropped. Keyed per opening (`useOpeningKey`) by its caller, so
 * a read of an earlier opening never reaches a later one. A read asked for
 * while closed doesn't start. A read started before the effects last ran
 * again (StrictMode's first run, whose cleanup aborted it) is dropped too,
 * its failure never shown: the second run starts its own.
 */
export function useOpeningReads(open: boolean, timeoutMs: number): OpeningRead {
  const openRef = useRef(open);
  const guards = useRef(new Set<ReturnType<typeof abortAfter>>());
  // Moved on each cleanup: a read started before it belongs to a run that is over.
  const epoch = useRef(0);

  useEffect(() => {
    openRef.current = open;
    const underWay = guards.current;
    return () => {
      openRef.current = false;
      epoch.current += 1;
      for (const guard of underWay) guard.abort();
      underWay.clear();
    };
  }, [open]);

  return useCallback(
    async <Value>(run: (signal: AbortSignal) => Promise<Value>): Promise<ReadAnswer<Value> | null> => {
      if (!openRef.current) return null;
      const startedIn = epoch.current;
      const guard = abortAfter(timeoutMs);
      guards.current.add(guard);
      let answer: ReadAnswer<Value>;
      try {
        answer = { ok: true, value: await run(guard.signal) };
      } catch (error) {
        answer = { ok: false, error };
      } finally {
        guard.clear();
        guards.current.delete(guard);
      }
      return openRef.current && epoch.current === startedIn ? answer : null;
    },
    [timeoutMs],
  );
}
