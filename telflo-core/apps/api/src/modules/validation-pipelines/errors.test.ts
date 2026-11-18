import { describe, expect, it } from "vitest";
import { firstCodePoints, VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH, validationRuleInvalid } from "./errors.js";

// The evaluator's words as a refusal carries them (D15a Preflight ruling
// 20, Ruling 33): as it words them, cut to 1,000 code points.

describe("validationRuleInvalid", () => {
  it("answers 400 validation_rule_invalid with the first problem's words as they are, and every problem with its field", () => {
    const error = validationRuleInvalid([
      { field: "ottl.condition", message: 'OTTL syntax error: 1:22: unexpected token "<EOF>"' },
      { field: "ottl.expression", message: "The expression is empty." },
    ]);
    expect({ code: error.code, statusCode: error.statusCode, message: error.message, details: error.details }).toEqual({
      code: "validation_rule_invalid",
      statusCode: 400,
      message: 'OTTL syntax error: 1:22: unexpected token "<EOF>"',
      details: {
        problems: [
          { field: "ottl.condition", message: 'OTTL syntax error: 1:22: unexpected token "<EOF>"' },
          { field: "ottl.expression", message: "The expression is empty." },
        ],
      },
    });
  });

  it("cuts each message to 1,000 code points, never splitting a character outside the BMP", () => {
    expect(VALIDATION_RULE_PROBLEM_MAXIMUM_LENGTH).toBe(1_000);
    // 999 ASCII characters, then 🚀 (two UTF-16 units) as the 1,000th code point, then more.
    const long = `${"x".repeat(999)}🚀🚀tail`;
    const error = validationRuleInvalid([{ field: "pattern", message: long }]);
    expect(error.message).toBe(`${"x".repeat(999)}🚀`);
    expect([...error.message]).toHaveLength(1_000);
    expect((error.details as { problems: Array<{ message: string }> }).problems[0]!.message).toBe(error.message);
    // Exactly 1,000 is kept whole; shorter is untouched.
    expect(firstCodePoints("🚀".repeat(1_000), 1_000)).toBe("🚀".repeat(1_000));
    expect(firstCodePoints("short", 1_000)).toBe("short");
  });
});
