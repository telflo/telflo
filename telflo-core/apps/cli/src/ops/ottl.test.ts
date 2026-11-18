import { describe, expect, it } from "vitest";
import {
  OTTL_CONTEXTS as CONTRACT_CONTEXTS,
  PUBLIC_OTTL_LINT_EXPRESSION_MAXIMUM_LENGTH,
  PUBLIC_OTTL_LINT_KINDS,
  PUBLIC_OTTL_LINT_MAXIMUM_EXPRESSIONS,
} from "@telflo/contracts";
import { buildLintBody, MAXIMUM_EXPRESSION_LENGTH, MAXIMUM_EXPRESSIONS, OTTL_CONTEXTS, OTTL_KINDS, renderLint, splitExpressions } from "./ottl.js";

/* OTTL lint's body and rendering (D27 decision 26); the copied constants against the contract (Preflight ruling 23). */

describe("the copied constants (drift)", () => {
  it("are the contract's contexts and limit; every reply kind but condition and statement is a --kind", () => {
    expect([...OTTL_CONTEXTS].sort()).toEqual([...CONTRACT_CONTEXTS].sort());
    expect(MAXIMUM_EXPRESSIONS).toBe(PUBLIC_OTTL_LINT_MAXIMUM_EXPRESSIONS);
    expect(MAXIMUM_EXPRESSION_LENGTH).toBe(PUBLIC_OTTL_LINT_EXPRESSION_MAXIMUM_LENGTH);
    for (const kind of PUBLIC_OTTL_LINT_KINDS) expect((OTTL_KINDS as readonly string[]).includes(kind)).toBe(true);
  });
});

describe("buildLintBody", () => {
  it("sends exactly 200 expressions", () => {
    const expressions = Array.from({ length: 200 }, () => "true");
    expect(buildLintBody(null, { context: "log", expr: expressions })).toEqual({ context: "log", conditions: expressions });
  });

  it("sends an expression of exactly the longest length", () => {
    const longest = "x".repeat(MAXIMUM_EXPRESSION_LENGTH);
    expect(buildLintBody(null, { context: "log", expr: [longest] })).toEqual({ context: "log", conditions: [longest] });
  });

  it("takes --kind condition by default", () => {
    expect(buildLintBody("a\n", { context: "span" })).toEqual({ context: "span", conditions: ["a"] });
  });
});

describe("splitExpressions", () => {
  it("drops blank lines and comments, trims, and splits CRLF", () => {
    expect(splitExpressions("a\r\n\n# c\n  b  \n")).toEqual(["a", "b"]);
  });
});

describe("renderLint", () => {
  it("strips control characters from every reply string (Ruling 237)", () => {
    const e = "\u001b]8;;x\u0007";
    const text = renderLint({
      valid: false,
      ottlVersion: `v1${e}`,
      checked: 1,
      items: [{ kind: "condition", index: 0, input: `i${e}`, valid: false, error: `err${e}`, context: "log", location: `loc${e}`, note: `n${e}` }],
      skipped: [`s${e}`],
    });
    expect(text).toBe(
      ["FAIL loc]8;;x", "      i]8;;x", "      error: err]8;;x", "      note:  n]8;;x", "skip  s]8;;x", "1 of 1 expressions invalid (OTTL v1]8;;x)."].join("\n"),
    );
  });

  it("leaves the version out when the evaluator wasn't asked", () => {
    expect(
      renderLint({
        valid: true,
        ottlVersion: null,
        checked: 1,
        items: [{ kind: "valueExpression", index: 0, input: "body", valid: true, error: null, context: "log", location: null, note: null }],
        skipped: [],
      }),
    ).toBe("ok   valueExpression[0]\n      body\nAll 1 expressions parse.");
  });
});
