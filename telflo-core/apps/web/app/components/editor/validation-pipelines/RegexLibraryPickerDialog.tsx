import type { TestRegex, ValidationPipeline, ValidationRuleKind } from "@telflo/contracts";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { ApiError, getTestRegexes } from "~/lib/api-client.js";
import { readFailure } from "~/lib/stores/test-suites-store.js";
import { abortAfter, RUNS_REQUEST_TIMEOUT_MS, type RunTarget } from "~/lib/stores/testing-store.js";
import { isAlreadyGone, useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/** What the picker says when the library can't be read, inline with Retry. */
export const TEST_REGEXES_LOAD_FAILED_MESSAGE = "Failed to load test regexes";

/** What a stop says when the API gave no words of its own. */
const ADD_FAILED_MESSAGE = "Failed to add validation rules";

type Match = "contains" | "not_contains";

/** The Category select's value for every category: the others are the category's place in the list, never its text. */
const ALL_CATEGORIES = "all";

const NO_ENTRIES: readonly TestRegex[] = [];

interface RegexLibraryPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the rules go on. */
  target: RunTarget;
  validationPipeline: ValidationPipeline;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): its opener's. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/**
 * A pick the API refused for itself (its pattern no longer checks, its
 * request unreadable): skipped, the rest still tried (Preflight ruling 5).
 * Only a 400 with one of those codes: the same code under any other status
 * (a 429's, a proxy's) stops the run (D15b final review side A, Nit 3).
 */
function isPickOwnRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 400 && (error.code === "validation_rule_invalid" || error.code === "invalid_request");
}

/**
 * What a stop says, in Preflight ruling 15's words: `saved` of `picked`
 * added, `held` never tried, and why. With no reason of its own (the API's
 * answer unreadable: the generic words), the line ends there rather than
 * saying "No rules were added: Failed to add validation rules" (Ruling 23).
 */
function stopLine(saved: number, picked: number, held: number, message: string): string {
  const reason = message === ADD_FAILED_MESSAGE ? "." : `: ${message}`;
  if (saved === 0) return `No rules were added${reason}`;
  const others = held === 1 ? "The other one wasn't added" : `The other ${held} weren't added`;
  return `Added ${saved} of ${picked} rules. ${others}${reason}`;
}

/**
 * "Add validation rules from regex library" (D15b decisions 1, 2, 10 and 12;
 * Preflight rulings 5, 15 and 17), opened from its card's "Add from regex
 * library" (`ValidationPipelineCard.tsx` lines 211-225, hosted at 238): its
 * title, Match ("Contains", "Does not Contain", the default), Category ("All
 * categories", then each category, sorted), the table (Name, Category), "No
 * regexes available." / "No regexes match this category.", "{n} selected",
 * Cancel and OK ("Adding…"), and "Added {n} validation rule(s)". Each pick is
 * one ordinary rule save (decision 1): its regex as a `contains_regex` or
 * `not_contains_regex` rule on the output, named after its entry, described
 * by its description, else its name.
 *
 * Differences (the Parity Notes):
 * - each row shows its description and its regex under its name (decision
 *   2), the regex in full, wrapped, never cut, and never only in a title;
 * - one labelled checkbox per row (`aria-labelledby` its name,
 *   `aria-describedby` its description, as AcceptTermsDialog's), its focus
 *   visible and its state announced (not three toggling buttons with the
 *   checkbox out of the tab order);
 * - the library is read each time the dialog opens, the latest read winning,
 *   aborted after 10 s as the Testing tab's reads; a failed read shows
 *   "Failed to load test regexes" inline with Retry (a refusal, a 4xx but
 *   408 and 429, in the API's words, as a card's failed read), not once per
 *   session with a toast;
 * - the picks are saved one at a time, in the library's order, those the
 *   Category filter hides included, through the store's `createRule`
 *   (placed, dropped or read again as D15a's saves are); a refusal every
 *   later pick would share (429, 503, the 200-rule cap, a pipeline, version
 *   or organization gone, the session, the network: Preflight ruling 5)
 *   stops the run: "Added 2 of 5 rules. The other 3 weren't added: …", or
 *   "No rules were added: …" (with no reason of the API's, "No rules were
 *   added."); a pick refused on its own (a 400 whose code is
 *   `validation_rule_invalid` or `invalid_request`) is named and skipped:
 *   "\"AWS Access Key\" wasn't added: …". Each line is an alert in the
 *   dialog, which stays open, the saved picks unticked and the others still
 *   ticked; only a run that saves every pick closes it and toasts; a stop
 *   whose own answer took the card, and the dialog, away (a pipeline a
 *   teammate deleted: the store drops it) is toasted in the same words, as
 *   the card's editor toasts it (D15a Ruling 57; D15b Ruling 32); only an
 *   "already gone" answer is (`isAlreadyGone`): any other refusal, or a
 *   save, answered once the dialog has gone says nothing and sends no
 *   further pick (Ruling 34). A run whose session ended (401) stops
 *   silently;
 * - Escape (or Cancel) mid-run closes the dialog and stops the run before
 *   its next pick; an answer for a session that has ended (closed, or opened
 *   again, or unmounted: the version or organization left) acts on nothing
 *   here, the store keeping what the API answered (D15a Ruling 56; D15b
 *   Ruling 23);
 * - OK is held while saving (`aria-disabled`, never `disabled`, so the focus
 *   stays on it, as D15a Rulings 57 and 58); after a run that stopped or
 *   skipped, the focus is on OK; after one that saved everything, back on
 *   "Add from regex library" (the card's `onCloseAutoFocus`);
 * - the dialog's content and the Category list sit in `ph-no-capture` (both
 *   portals, outside the panel's block); the Category select's values are
 *   "all" or a place in the list, never the category's text; no entry's
 *   text is in any attribute (ADR 0024); no `<form>`;
 * - kept: no search or select-all, no duplicate check, a
 *   rule's description falling back to the entry's name.
 */
export function RegexLibraryPickerDialog({ open, onOpenChange, target, validationPipeline, onCloseAutoFocus }: RegexLibraryPickerDialogProps) {
  const id = useId();
  const [entries, setEntries] = useState<readonly TestRegex[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [match, setMatch] = useState<Match>("not_contains");
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  /** The last run's skips and stop, in its words: alerts until the next run or the dialog closes. */
  const [problems, setProblems] = useState<readonly string[]>([]);
  const okRef = useRef<HTMLButtonElement>(null);
  /**
   * The dialog's session: counted as it opens and closes. A run's answers
   * act only on the session that sent them (D15a Ruling 56): after Escape,
   * or once the dialog is open again, a late answer unticks, says and closes
   * nothing, and no further pick is sent.
   */
  const session = useRef(0);
  /** The reads sent: only the latest one's answer is shown. */
  const reads = useRef(0);
  /** The read under way, aborted as the dialog closes. */
  const readUnderWay = useRef<{ abort: () => void } | null>(null);

  const read = useCallback(async () => {
    const at = ++reads.current;
    readUnderWay.current?.abort();
    // A read that never answers ends after the hang guard, as a failure (D14b Ruling 50).
    const timeout = abortAfter(RUNS_REQUEST_TIMEOUT_MS);
    readUnderWay.current = timeout;
    setLoading(true);
    setLoadError(null);
    try {
      const { testRegexes } = await getTestRegexes({ signal: timeout.signal });
      if (at === reads.current) setEntries(testRegexes);
    } catch (error) {
      // Null when the session ended: the session-ended handler has the page (D12 Ruling 39).
      if (at === reads.current) setLoadError(readFailure(error, TEST_REGEXES_LOAD_FAILED_MESSAGE));
    } finally {
      timeout.clear();
      if (at === reads.current) {
        readUnderWay.current = null;
        setLoading(false);
      }
    }
  }, []);

  /** Whether the dialog is still there: false once it has gone with its card (Ruling 32). */
  const mounted = useRef(true);

  // Unmounted (the version or the organization left mid-run, the card gone): the session ends, so no further pick is sent
  // and nothing is said (Ruling 23). The session moves a microtask after the unmount, as RuleEditorDialog's (Rulings 26,
  // 28): the answer that itself took the card away (a "validation pipeline not found" the store drops the card for,
  // before it rethrows) still reaches its catch in this session, and says its stop as a toast (Ruling 32).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        session.current += 1;
      });
    };
  }, []);

  // Each opening starts afresh and reads the library again; closing ends the session and drops the read under way.
  useEffect(() => {
    session.current += 1;
    setMatch("not_contains");
    setCategoryFilter(ALL_CATEGORIES);
    setSelectedIds(new Set());
    setSubmitting(false);
    setProblems([]);
    setEntries(null);
    setLoadError(null);
    if (open) {
      void read();
      return;
    }
    reads.current += 1;
    readUnderWay.current?.abort();
    readUnderWay.current = null;
    setLoading(false);
  }, [open, read]);

  const testRegexes = entries ?? NO_ENTRIES;

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const entry of testRegexes) set.add(entry.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [testRegexes]);

  const shownCategory = categoryFilter === ALL_CATEGORIES ? null : (categories[Number(categoryFilter)] ?? null);

  const filteredRegexes = useMemo(
    () => (shownCategory === null ? testRegexes : testRegexes.filter((entry) => entry.category === shownCategory)),
    [testRegexes, shownCategory],
  );

  /** The ticked entries, in the library's order, those the filter hides included. */
  const picks = useMemo(() => testRegexes.filter((entry) => selectedIds.has(entry.id)), [testRegexes, selectedIds]);

  const setTicked = (entryId: string, ticked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (ticked) next.add(entryId);
      else next.delete(entryId);
      return next;
    });
  };

  const handleOk = async () => {
    if (submitting || picks.length === 0) return;
    const sent = session.current;
    const kind: ValidationRuleKind = match === "contains" ? "contains_regex" : "not_contains_regex";
    const run = picks;
    const skips: string[] = [];
    let saved = 0;
    setSubmitting(true);
    setProblems([]);
    for (const entry of run) {
      // Closed (Escape, Cancel), opened again since, or gone with its card: no further pick is sent (Ruling 34).
      if (session.current !== sent || !mounted.current) return;
      try {
        await useValidationPipelinesStore.getState().createRule(target, validationPipeline.id, {
          kind,
          target: "output",
          pattern: entry.regex,
          name: entry.name,
          description: entry.description ?? entry.name,
        });
        if (session.current !== sent || !mounted.current) return;
        saved += 1;
        setTicked(entry.id, false);
      } catch (error) {
        if (session.current !== sent) return;
        if (isPickOwnRefusal(error)) {
          // The API's words (the evaluator's can quote the regex): inside the dialog's ph-no-capture.
          skips.push(`"${entry.name}" wasn't added: ${error.message}`);
          setProblems([...skips]);
          continue;
        }
        // A refusal every later pick would share: the run stops here. A 401's session-ended handler has the page.
        const message = failureMessage(error, ADD_FAILED_MESSAGE);
        const held = run.length - saved - skips.length;
        if (!mounted.current) {
          // This answer took the dialog away with its card (a teammate deleted the pipeline: the store dropped it): its
          // stop, in the inline line's words, is a toast, as the card's editor's (D15a Ruling 57). The API's words: blocked.
          // Only an "already gone" answer can have done that; any other refusal met a dialog gone for another reason (the
          // version or the organization left) and says nothing (Rulings 23, 34).
          if (message !== null && isAlreadyGone(error)) {
            toast.error(stopLine(saved, run.length, held, message), { className: "ph-no-capture" });
          }
          return;
        }
        setProblems(message === null ? skips : [...skips, stopLine(saved, run.length, held, message)]);
        setSubmitting(false);
        okRef.current?.focus();
        return;
      }
    }
    setSubmitting(false);
    if (skips.length === 0) {
      toast.success(`Added ${run.length} validation rule${run.length === 1 ? "" : "s"}`);
      onOpenChange(false);
      return;
    }
    okRef.current?.focus();
  };

  const selectedCount = picks.length;
  const isLoading = entries === null && loadError === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl ph-no-capture"
        aria-describedby={undefined}
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DialogHeader>
          <DialogTitle>Add validation rules from regex library</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2 min-h-0">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-match`}>Match</Label>
              <Select value={match} onValueChange={(value) => setMatch(value as Match)} disabled={submitting}>
                <SelectTrigger id={`${id}-match`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="ph-no-capture">
                  <SelectItem value="contains">Contains</SelectItem>
                  <SelectItem value="not_contains">Does not Contain</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-category`}>Category</Label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter} disabled={submitting}>
                <SelectTrigger id={`${id}-category`}>
                  <SelectValue />
                </SelectTrigger>
                {/* The categories are configuration text: their list is blocked, and their values are places, never the text (ADR 0024). */}
                <SelectContent className="ph-no-capture">
                  <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                  {categories.map((category, index) => (
                    <SelectItem key={category} value={String(index)}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-md border border-border bg-card max-h-80 overflow-y-auto">
            <div className="sticky top-0 z-10 grid grid-cols-[auto_1fr_1fr] items-center gap-4 px-3 py-2 bg-muted/90 backdrop-blur-sm border-b border-border font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              <span className="w-4" aria-hidden />
              <span>Name</span>
              <span>Category</span>
            </div>
            {isLoading ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground" role="status" aria-label="Loading test regexes">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            ) : loadError !== null ? (
              <div className="flex items-center justify-between gap-2 px-3 py-3 text-xs">
                <span role="alert" className="text-fail">
                  {loadError}
                </span>
                <button
                  type="button"
                  onClick={() => void read()}
                  disabled={loading}
                  className="h-7 px-2 text-xs font-medium rounded-md border border-input bg-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                >
                  Retry
                </button>
              </div>
            ) : filteredRegexes.length === 0 ? (
              <p className="px-3 py-6 text-[13px] text-center text-muted-foreground">
                {testRegexes.length === 0 ? "No regexes available." : "No regexes match this category."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {filteredRegexes.map((entry) => {
                  // Ids from the entry's place in the library, never its text.
                  const rowId = `${id}-entry-${testRegexes.indexOf(entry)}`;
                  const isChecked = selectedIds.has(entry.id);
                  return (
                    <li
                      key={entry.id}
                      className={`grid grid-cols-[auto_1fr_1fr] items-start gap-4 px-3 py-2 transition-colors border-l-2 ${
                        isChecked ? "bg-accent border-l-brand" : "border-l-transparent hover:bg-accent/50"
                      }`}
                    >
                      <Checkbox
                        id={`${rowId}-checkbox`}
                        className="mt-0.5"
                        checked={isChecked}
                        onCheckedChange={(checked) => setTicked(entry.id, checked === true)}
                        disabled={submitting}
                        aria-labelledby={`${rowId}-name`}
                        {...(entry.description === null ? {} : { "aria-describedby": `${rowId}-description` })}
                      />
                      <div className="min-w-0 flex flex-col gap-1">
                        <label id={`${rowId}-name`} htmlFor={`${rowId}-checkbox`} className="cursor-pointer text-[13px] text-foreground break-words">
                          {entry.name}
                        </label>
                        {entry.description !== null && (
                          <p id={`${rowId}-description`} className="text-xs text-muted-foreground break-words">
                            {entry.description}
                          </p>
                        )}
                        <code className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">{entry.regex}</code>
                      </div>
                      <span className="min-w-0 text-[13px] text-muted-foreground break-words">{entry.category}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="text-xs text-muted-foreground" aria-live="polite">
            <span className="font-mono tabular-nums">{selectedCount}</span> selected
          </div>

          {problems.length > 0 && (
            <div className="flex flex-col gap-1">
              {problems.map((problem, index) => (
                <p key={index} role="alert" className="text-xs text-fail break-words">
                  {problem}
                </p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Cancel
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={() => void handleOk()}
            // Held while saving, never disabled: the focus stays on it (D15a Rulings 57 and 58).
            aria-disabled={submitting || undefined}
            disabled={!submitting && selectedCount === 0}
            className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-primary"
          >
            {submitting ? "Adding…" : "OK"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
