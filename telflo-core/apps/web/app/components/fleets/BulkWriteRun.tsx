import { useCallback, useEffect, useRef, useState } from "react";
import type { Collector } from "@telflo/contracts";
import { useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { runPacedWrites, type PacedProgress, type PacedResult, type PacedWrites } from "~/lib/paced-writes.js";

/*
 * Bulk move's and bulk delete's run: `runPacedWrites` over the selected
 * collectors, one request at a time under `FLEET_WRITE_TIMEOUT_MS`, its
 * progress and its results, for one opening of a dialog (the dialogs key each
 * opening, `useOpeningKey`).
 *
 * - The run starts once per opening; a second start does nothing.
 * - The dialog closing (an organization switch closes it), unmounting, or
 *   another organization becoming active stops the run: the request in
 *   flight finishes, the rest aren't sent.
 * - Progress and results are applied only while the organization the run
 *   was sent in is current (`useStillCurrent`).
 *
 * The words: "Moving {i} of {n}…" / "Deleting {i} of {n}…", "(waiting {s}
 * seconds: too many requests)", "Stop" / "Stopping…", "Moved {k}" /
 * "Deleted {k}", and per collector not counted "Already deleted", "May or
 * may not have moved" ("…been deleted"), "Not attempted", or the refusal's
 * message. Names are text only, in the masked shell.
 */

export type BulkPhase = "confirm" | "running" | "done";

export interface BulkRun {
  phase: BulkPhase;
  /** Where the run is; null before it starts. */
  progress: PacedProgress | null;
  /** Stop was pressed: the run ends after the request in flight. */
  stopping: boolean;
  /** Every collector's result, in the selection's order, once the run ended. */
  results: PacedResult<Collector>[] | null;
  start: (
    write: (collector: Collector, signal: AbortSignal) => Promise<unknown>,
    options: { refusal: (error: unknown) => string; stopsOn?: (error: unknown) => boolean },
  ) => void;
  stop: () => void;
}

/** One opening's run over `collectors`; `onEnded` is told the results once it ends, for the organization it was sent in. */
export function useBulkRun(
  open: boolean,
  organizationId: string,
  collectors: readonly Collector[],
  onEnded: (results: PacedResult<Collector>[]) => void,
): BulkRun {
  const isStillCurrent = useStillCurrent(organizationId);
  const [phase, setPhase] = useState<BulkPhase>("confirm");
  const [progress, setProgress] = useState<PacedProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [results, setResults] = useState<PacedResult<Collector>[] | null>(null);
  const loopRef = useRef<PacedWrites<Collector> | null>(null);
  // The organization the run was sent in, once it starts.
  const sentInRef = useRef<string | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // Closed: the run stops after the request in flight. A second layer: a person can't close the dialog while it
  // runs, and an organization switch, which closes it, is stopped first by the organizationId effect below.
  useEffect(() => {
    if (!open) loopRef.current?.stop();
  }, [open]);
  // Another organization: the rest would be sent in one no longer shown.
  useEffect(() => {
    if (sentInRef.current !== null && sentInRef.current !== organizationId) loopRef.current?.stop();
  }, [organizationId]);
  // Unmounted (the tab gone with the route): the rest aren't sent.
  useEffect(
    () => () => {
      loopRef.current?.stop();
    },
    [],
  );

  const start = useCallback<BulkRun["start"]>(
    (write, { refusal, stopsOn }) => {
      if (loopRef.current !== null) return;
      const sentIn = organizationId;
      sentInRef.current = sentIn;
      setPhase("running");
      const loop = runPacedWrites(collectors, write, {
        timeoutMs: FLEET_WRITE_TIMEOUT_MS,
        refusal,
        ...(stopsOn === undefined ? {} : { stopsOn }),
        onProgress: (each) => {
          if (isStillCurrent(sentIn)) setProgress(each);
        },
      });
      loopRef.current = loop;
      void loop.results.then((ended) => {
        if (!isStillCurrent(sentIn)) return;
        setResults(ended);
        setPhase("done");
        onEndedRef.current(ended);
      });
    },
    [organizationId, collectors, isStillCurrent],
  );

  const stop = useCallback(() => {
    if (loopRef.current === null) return;
    setStopping(true);
    loopRef.current.stop();
  }, []);

  return { phase, progress, stopping, results, start, stop };
}

/** "Moving 3 of 40…", with "(waiting 5 seconds: too many requests)" while a 429 holds it. */
export function progressWords(verb: "Moving" | "Deleting", progress: PacedProgress): string {
  const doing = `${verb} ${progress.current} of ${progress.total}…`;
  if (progress.waitingSeconds === null) return doing;
  const seconds = progress.waitingSeconds;
  return `${doing} (waiting ${seconds} ${seconds === 1 ? "second" : "seconds"}: too many requests)`;
}

export const NOT_ATTEMPTED_WORDS = "Not attempted";
export const ALREADY_DELETED_WORDS = "Already deleted";

/** The run's progress line, for a screen reader too. */
export function BulkProgress({ verb, progress }: { verb: "Moving" | "Deleting"; progress: PacedProgress | null }) {
  return (
    <p role="status" className="flex items-center gap-2 text-[13px] text-foreground">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground"
      />
      {progress === null ? `${verb}…` : progressWords(verb, progress)}
    </p>
  );
}

interface BulkResultsProps {
  /** "Moved {k}" or "Deleted {k}". */
  summary: string;
  /** Each collector not counted, with its result's words. */
  others: Array<{ collector: Collector; words: string }>;
}

/** The run's end: how many were written, then each of the others with what became of it. */
export function BulkResults({ summary, others }: BulkResultsProps) {
  return (
    <div className="grid gap-2">
      <p role="status" className="text-[13px] font-medium text-foreground">
        {summary}
      </p>
      {others.length > 0 && (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border">
          {others.map(({ collector, words }) => (
            <li key={collector.id} className="flex items-start justify-between gap-3 px-3 py-2 text-[13px]">
              <span className="min-w-0 break-words font-medium text-foreground">{collector.name}</span>
              <span className="max-w-[60%] break-words text-right text-muted-foreground">{words}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
