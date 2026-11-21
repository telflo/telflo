import { describe, expect, it } from "vitest";
import { testRegexInvalid, testRegexNameTaken, testRegexNotFound } from "./errors.js";

// The regex library's refusals: the evaluator's words as they are, cut as a
// rule's, its problems placed under the entry's `regex`.

const parts = (error: ReturnType<typeof testRegexInvalid>) => ({
  code: error.code,
  statusCode: error.statusCode,
  message: error.message,
  details: error.details,
});

describe("testRegexInvalid", () => {
  it("answers 400 test_regex_invalid with the first problem's words, each problem's field `pattern` placed under `regex`", () => {
    const error = testRegexInvalid([
      { field: "pattern", message: "Invalid regex: missing closing ): `(abc`" },
      { field: "rule", message: "Something else." },
    ]);
    expect(parts(error)).toEqual({
      code: "test_regex_invalid",
      statusCode: 400,
      message: "Invalid regex: missing closing ): `(abc`",
      details: {
        problems: [
          { field: "regex", message: "Invalid regex: missing closing ): `(abc`" },
          { field: "rule", message: "Something else." },
        ],
      },
    });
  });

  it("cuts each message to 1,000 code points, never splitting a character outside the BMP", () => {
    const error = testRegexInvalid([{ field: "pattern", message: `${"x".repeat(999)}🚀🚀tail` }]);
    expect(error.message).toBe(`${"x".repeat(999)}🚀`);
    expect((error.details as { problems: Array<{ message: string }> }).problems[0]!.message).toBe(error.message);
  });

  it("has words of its own when the evaluator gives no problem", () => {
    expect(parts(testRegexInvalid([]))).toEqual({
      code: "test_regex_invalid",
      statusCode: 400,
      message: "The regex isn't valid.",
      details: { problems: [] },
    });
  });
});

describe("the other refusals", () => {
  it("are 404 test_regex_not_found and 409 test_regex_name_taken, in fixed words, naming no entry", () => {
    expect(parts(testRegexNotFound())).toEqual({
      code: "test_regex_not_found",
      statusCode: 404,
      message: "Test regex not found",
      details: undefined,
    });
    expect(parts(testRegexNameTaken())).toEqual({
      code: "test_regex_name_taken",
      statusCode: 409,
      message: "A regex with that name already exists.",
      details: undefined,
    });
  });
});
