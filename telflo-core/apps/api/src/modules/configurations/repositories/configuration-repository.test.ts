import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./configuration-repository.js";

describe("escapeLikePattern", () => {
  it("leaves text without a pattern character as it is", () => {
    expect(escapeLikePattern("Gateway prod")).toBe("Gateway prod");
    expect(escapeLikePattern("")).toBe("");
  });

  it("escapes %, _ and \\ with a backslash", () => {
    expect(escapeLikePattern("%")).toBe("\\%");
    expect(escapeLikePattern("_")).toBe("\\_");
    expect(escapeLikePattern("\\")).toBe("\\\\");
  });

  it("escapes every occurrence, and a backslash before a pattern character separately from it", () => {
    expect(escapeLikePattern("100%_done\\%")).toBe("100\\%\\_done\\\\\\%");
    expect(escapeLikePattern("%%__")).toBe("\\%\\%\\_\\_");
  });

  it("leaves the other characters a pattern could mean something by alone: like has only % and _", () => {
    expect(escapeLikePattern("a*b?c[d].e'f")).toBe("a*b?c[d].e'f");
  });
});
