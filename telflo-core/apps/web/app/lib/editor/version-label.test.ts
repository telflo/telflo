import { describe, expect, it } from "vitest";
import { versionLabelText } from "./version-label.js";

describe("versionLabelText", () => {
  it("is the version's label", () => {
    expect(versionLabelText(3, "Add tail sampling")).toBe("Add tail sampling");
  });

  it('is "Version N" for an unnamed version', () => {
    expect(versionLabelText(1, null)).toBe("Version 1");
    expect(versionLabelText(12, null)).toBe("Version 12");
  });

  it('is "Version N" for a blank label, which the contract never answers', () => {
    expect(versionLabelText(2, "")).toBe("Version 2");
    expect(versionLabelText(2, "   ")).toBe("Version 2");
  });

  it('shows "main" as itself: it is no default label', () => {
    expect(versionLabelText(4, "main")).toBe("main");
  });
});
