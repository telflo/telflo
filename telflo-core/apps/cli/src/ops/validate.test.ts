import { describe, expect, it } from "vitest";
import { ApiError } from "../api-error.js";
import { EXIT, ExitError } from "../output.js";
import { renderValidationErrors, rewordedError, validationErrorsOf } from "./validate.js";

/* The collector's errors as a 422 carries them (D27 decision 26), read defensively. */

describe("validationErrorsOf", () => {
  it("keeps each error's message and component path", () => {
    expect(
      validationErrorsOf({
        errors: [
          { message: "unknown receiver", componentPath: "receivers::nope" },
          { message: "no pipelines", componentPath: null },
        ],
      }),
    ).toEqual([
      { message: "unknown receiver", componentPath: "receivers::nope" },
      { message: "no pipelines", componentPath: null },
    ]);
  });

  it("leaves out anything that isn't an error, and answers none for any other details", () => {
    expect(validationErrorsOf({ errors: [null, 3, { componentPath: "x" }, { message: "kept", componentPath: 7 }] })).toEqual([
      { message: "kept", componentPath: null },
    ]);
    for (const details of [undefined, null, "text", { errors: "text" }, {}]) expect(validationErrorsOf(details)).toEqual([]);
  });
});

describe("rewordedError (Ruling 243)", () => {
  it("changes only the message: the exit code, the code and the status are endingOf's", () => {
    const words = (message: string): string => `Before: ${message}`;
    expect(rewordedError(new ApiError(401, "invalid_api_token", "Expired."), words)).toMatchObject({
      message: "Before: Expired. Run telflo login.",
      exitCode: EXIT.AUTH,
      code: "invalid_api_token",
      status: 401,
    });
    expect(rewordedError(new ApiError(503, null, "Unavailable."), words)).toMatchObject({ exitCode: EXIT.API, code: "api_error", status: 503 });
    const reworded = rewordedError(new ExitError("Couldn't reach x.", EXIT.API, "unreachable"), words);
    expect(reworded).toBeInstanceOf(ExitError);
    expect(reworded).toMatchObject({ message: "Before: Couldn't reach x.", exitCode: EXIT.API, code: "unreachable", status: undefined });
  });
});

describe("renderValidationErrors", () => {
  it("indents each error, its path after it", () => {
    expect(renderValidationErrors([{ message: "a", componentPath: "b" }, { message: "c", componentPath: null }])).toEqual(["  - a (b)", "  - c"]);
  });
});
