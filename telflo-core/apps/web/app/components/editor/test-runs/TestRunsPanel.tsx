import type { TestRunSummary } from "@telflo/contracts";
import { FlaskConical, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useLockedAction } from "~/lib/playground/context.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { formatDateTime } from "~/lib/format.js";
import { HELD_TITLE } from "~/lib/test-runs/messages.js";
import { StatusBadge } from "./run-status.js";
import { TestRunResults } from "./TestRunResults.js";

interface TestRunsPanelProps {
  /** Re-runs a run against the current text, with the ↺ pressed: the focus goes back to it when nothing is queued. */
  onRerun: (run: TestRunSummary, opener: HTMLElement) => void;
  /** Holds ↺, as Play is held. */
  disableRerun: boolean;
  /** Changes with each request to focus the selected run's row (a run just queued). */
  focusRequest?: number;
  /** Whether a request to focus the selected row waits: true once per request, which the list serves, or drops, the first time it renders after it. */
  takeFocus?: () => boolean;
}

/** A centred message under the toolbar, the empty states. */
function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-2">{children}</div>
    </div>
  );
}

/**
 * The version's runs and the selected run's results (the toolbar is in
 * TestingTab). The list over the results, flex-[2] over flex-[3]; the runs are
 * the store's, polled while any is queued or running.
 *
 * Differences:
 * - the list is everyone's runs that the person can see, a teammate's
 *   included, refreshed while any is in flight; the "Created" time is when
 *   the run was queued;
 * - a waiting run's badge says its place: "Queued (n ahead)";
 * - a run from a suite's definition carries the "Suite › Configuration"
 *   breadcrumb under its time; its names are text, under the app's `ph-mask`;
 * - a held ↺ is titled "Another run is in progress", as held Plays are;
 * - ↺ shows on every run, since each keeps its own input, a file id or
 *   not; it is held while Play is;
 * - once the polling stops on failures, "Failed to refresh test runs" with
 *   Retry, never a single toast and a silent stop after 60 s; a
 *   failed first read says "Failed to load test runs" at once, and a refusal
 *   the API's own words, each with Retry;
 * - each row's accessible name is its own text: the time, the "Suite ›
 *   Configuration" breadcrumb when it has one, and the status;
 * - the rule editor Compare's chip opens gives the focus to the
 *   selected row as it closes when the run's Compare link isn't there
 *   (`focusFallback`, as ValidationPipelineCard's); while it shows, a
 *   request to focus the selected row (a Play all's first run) is dropped,
 *   the focus left in the editor;
 * - in the playground, ↺ opens the sign-up prompt at its button
 *   (`useLockedAction`); the runs are the sample's.
 */
export function TestRunsPanel({ onRerun, disableRerun, focusRequest = 0, takeFocus }: TestRunsPanelProps) {
  const locked = useLockedAction();
  const versionId = useEditorStore((state) => state.version?.id ?? null);
  const runsForVersion = useTestingStore((state) => state.runsVersionId === versionId);
  const runs = useTestingStore((state) => state.runs);
  const runsLoading = useTestingStore((state) => state.runsLoading);
  const runsError = useTestingStore((state) => state.runsError);
  const selectedRunId = useTestingStore((state) => state.selectedRunId);
  const selectRun = useTestingStore((state) => state.selectRun);
  const retryRuns = useTestingStore((state) => state.retryRuns);

  const listed = runsForVersion ? runs : [];
  const selectedRun = listed.find((run) => run.id === selectedRunId) ?? null;
  const listRef = useRef<HTMLUListElement>(null);
  /** Whether the rule editor Compare's chip opened shows (TestRunResults says): no focus request is served under it. */
  const ruleEditorShown = useRef(false);
  const ruleEditorShownChanged = useCallback((shown: boolean) => {
    ruleEditorShown.current = shown;
  }, []);

  // A run just queued, selected: its row takes the focus (the Tests subtab
  // mounts it after a Play from Suites), never left on the held Play and
  // lost. The request is served the first time the list renders after it, or
  // dropped when no selected row shows then, so it can't pull the focus to a
  // row later. Dropped, too, while Compare's rule editor shows (a Play all's
  // first run selected under it): the row behind the modal would take the
  // focus only for Radix to pull it back into the editor, selecting what was
  // typed in its field.
  useEffect(() => {
    if (takeFocus?.() !== true || ruleEditorShown.current) return;
    listRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus();
  }, [focusRequest, selectedRun, takeFocus]);

  const refreshFailed = runsForVersion && runsError !== null && (
    <div className="flex items-center justify-between gap-2 rounded-md border border-fail/25 bg-fail-soft px-3 py-1.5" role="alert">
      <span className="text-[13px] text-fail">{runsError}</span>
      <button
        type="button"
        onClick={retryRuns}
        className="h-7 px-2.5 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
      >
        Retry
      </button>
    </div>
  );

  if (versionId === null) {
    return (
      <Placeholder>
        <FlaskConical className="w-5 h-5 text-muted-foreground mx-auto" />
        <p className="text-[13px] text-muted-foreground">Load a configuration version to see test runs.</p>
      </Placeholder>
    );
  }

  if (listed.length === 0) {
    return (
      <>
        {refreshFailed}
        {runsLoading || !runsForVersion ? (
          <Placeholder>
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" role="status" aria-label="Loading test runs" />
          </Placeholder>
        ) : runsError === null ? (
          <Placeholder>
            <FlaskConical className="w-5 h-5 text-muted-foreground mx-auto" />
            <p className="text-[13px] text-muted-foreground">No test runs yet for this version.</p>
          </Placeholder>
        ) : null}
      </>
    );
  }

  return (
    <>
      {refreshFailed}
      <div className="flex-[2] min-h-0 rounded-md border border-border bg-card overflow-auto">
        <div className="sticky top-0 z-10 grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2 bg-muted/90 backdrop-blur-sm border-b border-border font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          <span>Created</span>
          <span>Status</span>
        </div>
        <ul ref={listRef} className="divide-y divide-border">
          {listed.map((run) => {
            const isSelected = selectedRunId === run.id;
            return (
              // The ↺ button is the row's sibling, overlaying its right
              // padding: interactive content inside a button is invalid.
              <li key={run.id} className="relative">
                <button
                  type="button"
                  onClick={() => selectRun(run.id)}
                  aria-pressed={isSelected}
                  className={`w-full grid grid-cols-[1fr_auto] items-center gap-4 py-2 pl-4 pr-12 text-left border-l-2 transition-colors focus-visible:outline-none ${
                    isSelected ? "bg-accent border-l-brand" : "border-l-transparent hover:bg-accent/50"
                  }`}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-mono text-xs tabular-nums text-foreground truncate">{formatDateTime(run.queuedAt)}</span>
                    {run.suiteName !== null && run.definitionName !== null && (
                      <span className="text-[11px] text-muted-foreground truncate">
                        {run.suiteName} › {run.definitionName}
                      </span>
                    )}
                  </div>
                  <StatusBadge run={run} />
                </button>
                <button
                  type="button"
                  onClick={(event) => (locked ? locked("run a test against your config", event.currentTarget) : onRerun(run, event.currentTarget))}
                  disabled={disableRerun}
                  title={disableRerun ? HELD_TITLE : "Re-run this test against the current YAML"}
                  aria-label="Re-run test"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex-[3] min-h-0">
        <TestRunResults
          run={selectedRun}
          focusFallback={() => listRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]') ?? null}
          onRuleEditorShown={ruleEditorShownChanged}
        />
      </div>
    </>
  );
}
