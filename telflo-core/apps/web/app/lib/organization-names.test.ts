import { describe, expect, it } from "vitest";
import { isEmailAddress, isNamedByEmail, organizationInSentence, organizationLabel } from "./organization-names.js";

// The one rule the invite dialog, the invitation page, the welcome callout
// and the delete dialog share (D36-1 Q262, Q264).

describe("isEmailAddress", () => {
  it("takes an address pattern: something, @, something, a dot, something, no spaces", () => {
    expect(["someone@example.com", "a@b.co"].map(isEmailAddress)).toEqual([true, true]);
    expect(["sam@example", "sam @example.com", "@example.com", "Sam's Lab", ""].map(isEmailAddress)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("isNamedByEmail", () => {
  it("is a personal workspace whose name is an email address only", () => {
    expect(isNamedByEmail("someone@example.com", "personal")).toBe(true);
    expect(isNamedByEmail("ops@example.com", "group")).toBe(false);
    expect(isNamedByEmail("Sam's Lab", "personal")).toBe(false);
    expect(isNamedByEmail("someone@example.com's workspace", "personal")).toBe(false);
  });
});

describe("organizationLabel (the invite dialog's \"the … organization\", Q262)", () => {
  it("adds 's to a personal workspace named by its email, and leaves any other name as it is", () => {
    expect(organizationLabel("someone@example.com", "personal")).toBe("someone@example.com's");
    expect(organizationLabel("ops@example.com", "group")).toBe("ops@example.com");
    expect(organizationLabel("Sam's Lab", "personal")).toBe("Sam's Lab");
  });
});

describe("organizationInSentence (Q264)", () => {
  it("says <email>'s organization for a personal workspace named by its email, and the name for any other", () => {
    expect(organizationInSentence("someone@example.com", "personal")).toBe("someone@example.com's organization");
    expect(organizationInSentence("ops@example.com", "group")).toBe("ops@example.com");
    expect(organizationInSentence("Acme", "group")).toBe("Acme");
    expect(organizationInSentence("Sam's Lab", "personal")).toBe("Sam's Lab");
    expect(organizationInSentence("sam@example", "personal")).toBe("sam@example");
  });
});
