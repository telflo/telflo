import { describe, expect, it } from "vitest";
import { findTautology, TAUTOLOGY_MAXIMUM_LENGTH } from "./tautology.js";

/*
 * The tautology check (D25 decision 33): its shapes, its words, and its
 * length bound.
 */

describe("findTautology, its cases", () => {
  it("test_find_tautology", () => {
    // The live incident: a nil-tautology saved as "resource remains present".
    const condition = 'resource.attributes["k8s.cluster.name"] == nil or resource.attributes["k8s.cluster.name"] != nil';
    expect(findTautology(condition, "any")).toContain("always true");
    expect(findTautology('attributes["a"] == attributes["a"]', "all")).toContain("always true");
    // 'true' stays legitimate as the total-count control and as an explicit
    // emptiness (none) or non-emptiness (any) check: those can fail.
    expect(findTautology("true", "count")).toBeNull();
    expect(findTautology("true", "any")).toBeNull();
    expect(findTautology("true", "none")).toBeNull();
    expect(findTautology("true", "all")).toContain("never fail");
    expect(findTautology("( true )", "all")).toContain("never fail");
    // Constant-false shapes: never-fail with none, never-pass otherwise.
    expect(findTautology('attributes["a"] != attributes["a"]', "none")).toContain("never fail");
    expect(findTautology("false", "all")).toContain("never pass");
    // Genuine conditions are untouched.
    expect(findTautology('attributes["a"] != nil and IsMatch(attributes["a"], "x")', "all")).toBeNull();
    expect(findTautology('body.string == "a or b"', "any")).toBeNull();
    expect(findTautology("a == nil or b != nil", "any")).toBeNull();
    expect(findTautology("a == nil or a == nil", "any")).toBeNull();
  });

  it("test_tautology_rejected and test_validate_rules_rejects_tautologies", () => {
    expect(findTautology("log.body == log.body", "all")).not.toBeNull();
    expect(findTautology("x == nil or x != nil", "any")).toContain("always true");
    expect(findTautology("true", "all")).toContain("never fail");
    expect(findTautology("true", "count")).toBeNull();
  });

  it("words each shape", () => {
    expect(findTautology("false", "none")).toBe(
      "condition 'false' with quantifier 'none' can never fail — assert the actual expected state, or use quantifier 'count' for a record-count control",
    );
    expect(findTautology("false", "any")).toBe("condition 'false' is always false with quantifier 'any' — the rule can never pass; assert the actual expected state");
    expect(findTautology("x != x", "all")).toContain("of the form 'X != X' is always false with quantifier 'all'");
    expect(findTautology("a  ==\n b   or a != b", "all")).toBe(
      "condition of the form 'X == Y or X != Y' is always true — the rule asserts nothing about the data, whatever its name claims. Assert the actual expected state; if you only mean 'records are present', use condition 'true' with quantifier 'count' (gte 1) and name the rule as a smoke check",
    );
  });
});

describe("findTautology's bound (the port's change; Ruling 168)", () => {
  it("looks only at a condition of at most 1,024 characters as written, before any normalizing", () => {
    expect(TAUTOLOGY_MAXIMUM_LENGTH).toBe(1_024);
    const side = "x".repeat(509);
    expect(`${side} == ${side}`).toHaveLength(1_022);
    expect(findTautology(`${side} == ${side}`, "all")).toContain("always true");
    const long = "y".repeat(511);
    expect(findTautology(`${long} == ${long}`, "all")).toBeNull();
    // Whitespace counts as written: the cap is on the text, not its normalized form.
    expect(findTautology(`(${" ".repeat(1_100)}true)`, "all")).toBeNull();
    expect(findTautology(`(${" ".repeat(900)}true)`, "all")).toContain("never fail");
  });

  it("never normalizes 8,192 characters of nested parentheses (quadratic): unchecked, by its size", () => {
    // 4,094 levels around `true`: normalized, this would be "never fail"; capped first, it is null.
    const nested = `${"(".repeat(4_094)}true${")".repeat(4_094)}`;
    expect(nested).toHaveLength(8_192);
    expect(findTautology(nested, "all")).toBeNull();
    // The same shape within the cap is normalized and found.
    expect(findTautology(`${"(".repeat(510)}true${")".repeat(510)}`, "all")).toContain("never fail");
  });

  it("answers a long adversarial condition unchecked (the backtracking it bounds)", () => {
    expect(findTautology("a == b or ".repeat(820), "any")).toBeNull();
  });
});
