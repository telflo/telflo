import { describe, expect, it } from "vitest";
import { downgradeCustomFunction, TRANSFORM_CUSTOM_FUNCTIONS } from "./custom-functions.js";

/*
 * The transform processor's own functions turned into notes, against the
 * evaluator's words for an unknown function (the evaluator's Go test pins
 * them: `undefined function "convert_sum_to_gauge"`).
 */

const verdict = (valid: boolean, error: string | null) => ({ valid, error, note: null as string | null, input: "kept" });

describe("downgradeCustomFunction", () => {
  it("turns a transform-only function's undefined-function error into a note, the item valid", () => {
    expect(downgradeCustomFunction(verdict(false, 'OTTL syntax error: undefined function "convert_sum_to_gauge"'))).toEqual({
      valid: true,
      error: null,
      note: "'convert_sum_to_gauge' is a transform-processor function the linter does not register; its arguments were not checked",
      input: "kept",
    });
    expect(downgradeCustomFunction(verdict(false, "undefined function extract_count_metric")).valid).toBe(true);
  });

  it("keeps every other verdict as it is: a standard function's error, another error, a valid item", () => {
    for (const each of [
      verdict(false, 'OTTL syntax error: undefined function "not_a_function"'),
      verdict(false, "OTTL syntax error: condition has invalid syntax at 1:11"),
      verdict(true, null),
      verdict(false, null),
    ]) {
      expect(downgradeCustomFunction(each)).toBe(each);
    }
  });

  it("knows the processor's twelve", () => {
    expect([...TRANSFORM_CUSTOM_FUNCTIONS].sort()).toEqual(
      [
        "aggregate_on_attribute_value",
        "aggregate_on_attributes",
        "convert_exponential_histogram_to_histogram",
        "convert_gauge_to_sum",
        "convert_sum_to_gauge",
        "convert_summary_count_val_to_sum",
        "convert_summary_quantile_val_to_gauge",
        "convert_summary_sum_val_to_sum",
        "copy_metric",
        "extract_count_metric",
        "extract_sum_metric",
        "scale_metric",
      ].sort(),
    );
  });
});
