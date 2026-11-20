import type { ValidationRuleResult, ValidationRuleResultDetail, ValidationRuleSnapshot } from "@telflo/contracts";
import { Check, HelpCircle, Info, ShieldX, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import {
  INPUT_LABELS,
  ruleDisplayName,
  ruleNameOrSummary,
  ruleTypeLabel,
  summarizeRule,
} from "~/components/editor/validation-pipelines/validation-display.js";

/*
 * A run's rules and their results: the result icons, the grid, its rows, the
 * failure details and their dialog. One row per rule the run copied when it
 * was queued, in its order, each with its result; "Show test details" opens
 * the rule and why it failed.
 *
 * - a count line beside the grid's label, "1 of 2 rules passed" ("1 of 1
 *   rule passed");
 * - a rule's error message shows in its details (and in the row's
 *   tooltip), and so does its advisory (an `all` or `none` over
 *   zero records, a truncated output), a passed rule's or a failed one's; a
 *   failed rule with no error and no detail shows its advisory as the
 *   failure's reason (a not-contains regex that matched only empty text), else
 *   "This rule failed; the evaluator gave no further detail.": "Failure
 *   details" is never empty;
 * - a rule the evaluator's time limit cut off ("Not checked: …")
 *   shows as Failed, its words in the tooltip and the details, as the run's
 *   status and the count line treat it; there is no "Skipped" (a rule
 *   deliberately not run) or "Pending" (a result not yet written): every
 *   result here is final;
 * - a not-contains rule's matches name their record, not a line and column:
 *   in the output, the element of its records and the JSON path inside it
 *   ("record 2", `resourceLogs[0]…body`); in the collector's log, the line.
 *   "Found more than 100,000 …" when the count stopped;
 * - an OTTL rule's misses are labeled by its context ("log #3"), `any`'s
 *   included; "… did not" counts the records that didn't hold the
 *   condition, and "Showing the first n" compares with the evaluator's
 *   count of listed records;
 * - replay: the grid sits inside the results' `ph-no-capture` region, the
 *   dialog's content is `ph-no-capture` too; each row's "Show test
 *   details" is named by hidden text inside the block ("Show test details
 *   for rule 2: SSN guard", `aria-labelledby`); the icons are named Passed and Failed (`role="img"`);
 *   closing the details gives the focus back to the row's button, not to
 *   the page.
 */

const ICON_CLASS = "inline-flex items-center justify-center w-5 h-5 rounded-full";

/** The result icons: colored circles with plain glyphs, in the platform's tokens. */
function ResultIcon({ passed }: { passed: boolean }) {
  return passed ? (
    <span role="img" aria-label="Passed" className={`${ICON_CLASS} bg-ok-soft text-ok`}>
      <Check className="w-3 h-3" />
    </span>
  ) : (
    <span role="img" aria-label="Failed" className={`${ICON_CLASS} bg-fail-soft text-fail`}>
      <X className="w-3 h-3" />
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="tf-label">{label}</span>
      {value.includes("\n") ? (
        <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words rounded border border-border bg-muted/40 p-2">
          {value}
        </pre>
      ) : (
        <span className="text-[13px] text-foreground break-words">{value}</span>
      )}
    </div>
  );
}

const PRE_CLASS = "text-[11px] font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed";

const formatCount = (count: number) => count.toLocaleString("en-US");

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

type UnexpectedMatch = Extract<ValidationRuleResultDetail, { kind: "unexpected_match" }>;

/** Where a match is: "line 4" in the log; "record 2" and its JSON path in the output, or "outside every record". */
function MatchPlace({ record }: { record: UnexpectedMatch["matches"][number]["record"] }) {
  if ("line" in record) return <div className="tf-label mb-1">line {record.line}</div>;
  return (
    <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
      <span className="tf-label">{record.index === null ? "outside every record" : `record ${record.index}`}</span>
      {record.path !== "" && <span className="text-[11px] font-mono text-muted-foreground break-all">{record.path}</span>}
    </div>
  );
}

function UnexpectedMatchBody({ detail }: { detail: UnexpectedMatch }) {
  const shown = detail.matches.length;
  const total = detail.totalMatchCount;
  return (
    <>
      <p className="text-xs text-foreground">
        Found{" "}
        <span className="font-mono tabular-nums">{detail.moreMatches ? `more than ${formatCount(total)}` : formatCount(total)}</span>{" "}
        unexpected {plural(total, "match", "matches")} in {detail.source}.
        {(detail.moreMatches || shown < total) && ` Showing the first ${shown}.`}
      </p>
      <ul className="flex flex-col gap-2">
        {detail.matches.map((match, index) => (
          <li key={index} className="rounded border border-border bg-card p-2">
            <MatchPlace record={match.record} />
            <pre className={PRE_CLASS}>
              <span className="text-muted-foreground">{match.before}</span>
              <mark className="bg-fail-soft text-fail rounded px-0.5">
                {match.text}
                {match.textTruncated ? "…" : ""}
              </mark>
              <span className="text-muted-foreground">{match.after}</span>
            </pre>
          </li>
        ))}
      </ul>
    </>
  );
}

function RecordMismatchBody({ detail }: { detail: Extract<ValidationRuleResultDetail, { kind: "record_mismatch" }> }) {
  const { totalCount: total, matchedCount: matched, misses } = detail;
  return (
    <>
      <p className="text-xs text-foreground">
        <span className="font-mono tabular-nums">{formatCount(matched)}</span> of{" "}
        <span className="font-mono tabular-nums">{formatCount(total)}</span> {plural(total, "element", "elements")} matched;{" "}
        <span className="font-mono tabular-nums">{formatCount(total - matched)}</span> did not.
        {misses.length > 0 && misses.length < detail.missCount && ` Showing the first ${misses.length}.`}
      </p>
      {misses.length > 0 && (
        <ul className="flex flex-col gap-2">
          {misses.map((miss, index) => (
            <li key={index} className="rounded border border-border bg-card p-2">
              <div className="tf-label mb-1">
                {detail.context} #{miss.index}
              </div>
              <pre className={`${PRE_CLASS} text-foreground`}>{miss.reason}</pre>
              {miss.snippet !== "" && (
                <pre
                  className={`${PRE_CLASS} mt-1.5 max-h-40 overflow-auto text-muted-foreground rounded bg-muted/40 border border-border p-1.5`}
                >
                  {miss.snippet}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function DistinctMismatchBody({ detail }: { detail: Extract<ValidationRuleResultDetail, { kind: "distinct_mismatch" }> }) {
  const { distinctCount: distinct, matchedCount: evaluated, samples } = detail;
  return (
    <>
      <p className="text-xs text-foreground">
        <span className="font-mono tabular-nums">{formatCount(distinct)}</span> distinct {plural(distinct, "value", "values")}{" "}
        across <span className="font-mono tabular-nums">{formatCount(evaluated)}</span> {plural(evaluated, "record", "records")} —
        outside the rule's threshold.
        {samples.length > 0 && samples.length < distinct && ` Showing the first ${samples.length}.`}
      </p>
      {samples.length > 0 && (
        <ul className="flex flex-col gap-1">
          {samples.map((sample, index) => (
            <li key={index} className="rounded border border-border bg-card p-1.5">
              <pre className={`${PRE_CLASS} text-foreground`}>{sample}</pre>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FailureDetailBody({ detail }: { detail: ValidationRuleResultDetail }) {
  switch (detail.kind) {
    case "no_match":
      return (
        <p className="text-xs text-foreground">
          No match found in {detail.source} (<span className="font-mono tabular-nums">{formatCount(detail.searchedCharacters)}</span>{" "}
          chars searched).
        </p>
      );
    case "unexpected_match":
      return <UnexpectedMatchBody detail={detail} />;
    case "record_mismatch":
      return <RecordMismatchBody detail={detail} />;
    case "distinct_mismatch":
      return <DistinctMismatchBody detail={detail} />;
  }
}

/** A failed rule the evaluator gave no error, detail or advisory for: never an empty "Failure details". */
const NO_FAILURE_REASON_MESSAGE = "This rule failed; the evaluator gave no further detail.";

/** Whether a failed result's only reason is its advisory (no error, no detail): the advisory is shown as the failure's. */
const failsByAdvisoryOnly = (result: ValidationRuleResult) =>
  !result.passed && result.error === null && result.detail === null && result.advisory !== null;

/**
 * Why a failed rule failed, under "Failure details": its details by kind, or
 * its own error; with neither, its advisory (a not-contains regex whose only
 * matches were empty text), else NO_FAILURE_REASON_MESSAGE.
 */
function FailureDetailSection({ result }: { result: ValidationRuleResult }) {
  return (
    <div className="flex flex-col gap-2 min-w-0 rounded-md border border-border bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <ShieldX className="w-4 h-4 text-fail" />
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-fail">Failure details</span>
      </div>
      {result.error !== null && <pre className={`${PRE_CLASS} text-xs text-fail`}>{result.error}</pre>}
      {result.detail !== null && <FailureDetailBody detail={result.detail} />}
      {result.error === null && result.detail === null && (
        <p className="text-xs text-foreground whitespace-pre-wrap break-words">{result.advisory ?? NO_FAILURE_REASON_MESSAGE}</p>
      )}
    </div>
  );
}

/** A result's advisory: why a pass (or a failure) may mislead. */
function AdvisorySection({ advisory }: { advisory: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-warn/25 bg-warn-soft px-2.5 py-2">
      <Info className="w-4 h-4 mt-0.5 shrink-0 text-warn" />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="tf-label">Advisory</span>
        <p className="text-xs text-foreground whitespace-pre-wrap break-words">{advisory}</p>
      </div>
    </div>
  );
}

interface Checked {
  rule: ValidationRuleSnapshot;
  result: ValidationRuleResult;
}

/** "Validation test details": the rule as the run copied it, its advisory, and why it failed. */
function ResultDetailsDialog({
  checked,
  onClose,
  onCloseAutoFocus,
}: {
  checked: Checked | null;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  return (
    <Dialog open={checked !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-2xl max-h-[85vh] flex flex-col ph-no-capture"
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Validation test details</DialogTitle>
        </DialogHeader>
        {checked !== null && (
          <div className="flex-1 min-h-0 min-w-0 overflow-auto flex flex-col gap-4 pr-3">
            <DetailRow label="Name" value={ruleDisplayName(checked.rule)} />
            <DetailRow label="Condition" value={ruleTypeLabel(checked.rule.kind, checked.rule.target)} />
            <DetailRow label={INPUT_LABELS[checked.rule.kind]} value={summarizeRule(checked.rule)} />
            <DetailRow label="Description" value={checked.rule.description.trim() || "(no description)"} />
            {checked.result.advisory !== null && !failsByAdvisoryOnly(checked.result) && (
              <AdvisorySection advisory={checked.result.advisory} />
            )}
            {!checked.result.passed && <FailureDetailSection result={checked.result} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ValidationResultsProps {
  /** The rules the run copied when it was queued, in their order. */
  rules: readonly ValidationRuleSnapshot[];
  /** Their results, one per rule (by id). */
  results: readonly ValidationRuleResult[];
}

/** The Validation grid, its count line and the details dialog; nothing for a run without rules. */
export function ValidationResults({ rules, results }: ValidationResultsProps) {
  const [shown, setShown] = useState<Checked | null>(null);
  const idPrefix = useId();
  /** The "Show test details" pressed: the focus goes back to it as the dialog closes (it has no Dialog.Trigger to return to). */
  const opener = useRef<HTMLElement | null>(null);
  const byId = new Map(results.map((result) => [result.id, result]));
  const checked = rules.flatMap((rule) => {
    const result = byId.get(rule.id);
    return result === undefined ? [] : [{ rule, result }];
  });
  if (checked.length === 0) return null;
  const passed = checked.filter(({ result }) => result.passed).length;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span id={`${idPrefix}-label`} className="tf-label">
          Validation
        </span>
        <span className="text-xs text-muted-foreground">
          {passed} of {checked.length} {plural(checked.length, "rule", "rules")} passed
        </span>
      </div>
      <ul aria-labelledby={`${idPrefix}-label`} className="rounded-md border border-border bg-card divide-y divide-border">
        {checked.map(({ rule, result }, index) => {
          const nameId = `${idPrefix}-rule-${index}`;
          return (
            <li
              key={rule.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2"
              // The tooltip: the rule's error, inside the results' ph-no-capture block.
              title={result.error ?? undefined}
            >
              <ResultIcon passed={result.passed} />
              <span className="min-w-0 text-[13px] text-foreground truncate">{ruleDisplayName(rule)}</span>
              {/* The button's name: hidden text inside the results' ph-no-capture block, never an attribute. */}
              <span id={nameId} className="sr-only">
                Show test details for rule {index + 1}: {ruleNameOrSummary(rule)}
              </span>
              <button
                type="button"
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setShown({ rule, result });
                }}
                aria-labelledby={nameId}
                title="Show test details"
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
              >
                <HelpCircle className="w-4 h-4" />
              </button>
            </li>
          );
        })}
      </ul>
      <ResultDetailsDialog
        checked={shown}
        onClose={() => setShown(null)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      />
    </div>
  );
}
