/*
 * The transform processor's own functions. The processor registers them on
 * top of OTTL's standard set; the evaluator knows only the standard set, so
 * a statement using one parses there as "undefined function", a false
 * error. A configuration's lint turns that error into a note: the item is
 * valid, its arguments unchecked.
 */

export const TRANSFORM_CUSTOM_FUNCTIONS: ReadonlySet<string> = new Set([
  "convert_sum_to_gauge",
  "convert_gauge_to_sum",
  "convert_summary_count_val_to_sum",
  "convert_summary_sum_val_to_sum",
  "convert_summary_quantile_val_to_gauge",
  "convert_exponential_histogram_to_histogram",
  "extract_count_metric",
  "extract_sum_metric",
  "copy_metric",
  "scale_metric",
  "aggregate_on_attributes",
  "aggregate_on_attribute_value",
]);

/** The parser's words for a function it doesn't know, as the evaluator passes them on. */
const UNDEFINED_FUNCTION = /undefined function "?([A-Za-z_][A-Za-z0-9_]*)"?/;

/** An item's verdict, as the lint answers it. */
export interface LintVerdict {
  valid: boolean;
  error: string | null;
  note: string | null;
}

/**
 * The verdict with a transform-only function's "undefined function" turned
 * into a note; any other verdict as it is.
 */
export function downgradeCustomFunction<Verdict extends LintVerdict>(verdict: Verdict): Verdict {
  if (verdict.valid || verdict.error === null) return verdict;
  const name = UNDEFINED_FUNCTION.exec(verdict.error)?.[1];
  if (name === undefined || !TRANSFORM_CUSTOM_FUNCTIONS.has(name)) return verdict;
  return {
    ...verdict,
    valid: true,
    error: null,
    note: `'${name}' is a transform-processor function the linter does not register; its arguments were not checked`,
  };
}
