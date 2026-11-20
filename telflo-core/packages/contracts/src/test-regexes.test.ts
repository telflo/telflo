import { describe, expect, it } from "vitest";
import { CONFIGURATION_ERROR_CODES } from "./configurations.js";
import { FLEET_ERROR_CODES } from "./fleets.js";
import { FLOW_ERROR_CODES } from "./flows.js";
import { IDENTITY_ERROR_CODES } from "./identity.js";
import { ORGANIZATION_ERROR_CODES } from "./organizations.js";
import { SALES_INQUIRY_ERROR_CODES } from "./sales-inquiries.js";
import { OIDC_QUERY_ERROR_CODES, SESSION_ERROR_CODES } from "./sessions.js";
import { TESTING_ERROR_CODES } from "./test-runs.js";
import {
  CreateTestRegexRequestSchema,
  TEST_REGEX_CATEGORY_MAXIMUM_LENGTH,
  TEST_REGEX_DESCRIPTION_MAXIMUM_LENGTH,
  TEST_REGEX_ERROR_CODES,
  TEST_REGEX_NAME_MAXIMUM_LENGTH,
  TEST_REGEX_NAME_TAKEN_MESSAGE,
  TEST_REGEX_REGEX_MAXIMUM_BYTES,
  TestRegexesResponseSchema,
  TestRegexResponseSchema,
  TestRegexSchema,
  trimLibraryText,
  UpdateTestRegexRequestSchema,
} from "./test-regexes.js";
import { CreateValidationRuleRequestSchema, VALIDATION_RULES_ERROR_CODES } from "./validation-rules.js";

// The regex library's contracts: each schema's accepted and refused shapes,
// migration 031's bounds, whitespace as JavaScript and Go both count it (the
// table trims ASCII's only), and the error codes.

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a70";
const NOW = "2026-10-11T10:00:00.000Z";

/** Go's unicode.IsSpace, every one, and JavaScript's U+FEFF. */
const GO_SPACES = "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

/** A path and message per issue, for a refusal's assertions. */
function issuesOf(result: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } }) {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

const valid = { name: "Email Address", category: "PII / GDPR", description: "Matches email addresses", regex: "[a-z]+@[a-z]+" };

describe("the limits, the words and the codes", () => {
  it("are migration 031's bounds, a rule's pattern's 8,192 bytes, and the name-taken words", () => {
    expect(TEST_REGEX_NAME_MAXIMUM_LENGTH).toBe(200);
    expect(TEST_REGEX_CATEGORY_MAXIMUM_LENGTH).toBe(100);
    expect(TEST_REGEX_DESCRIPTION_MAXIMUM_LENGTH).toBe(2_000);
    expect(TEST_REGEX_REGEX_MAXIMUM_BYTES).toBe(8_192);
    expect(TEST_REGEX_NAME_TAKEN_MESSAGE).toBe("A regex with that name already exists.");
  });

  it("the library's three codes, and none is another module's; the check's 429 and 503 are the rules'", () => {
    expect(TEST_REGEX_ERROR_CODES).toEqual(["test_regex_not_found", "test_regex_name_taken", "test_regex_invalid"]);
    const others = new Set<string>([
      ...CONFIGURATION_ERROR_CODES,
      ...TESTING_ERROR_CODES,
      ...IDENTITY_ERROR_CODES,
      ...ORGANIZATION_ERROR_CODES,
      ...FLOW_ERROR_CODES,
      ...FLEET_ERROR_CODES,
      ...VALIDATION_RULES_ERROR_CODES,
      ...SESSION_ERROR_CODES,
      ...OIDC_QUERY_ERROR_CODES,
      ...SALES_INQUIRY_ERROR_CODES,
    ]);
    for (const code of TEST_REGEX_ERROR_CODES) expect(others.has(code)).toBe(false);
    expect(VALIDATION_RULES_ERROR_CODES).toContain("rules_unavailable");
    expect(VALIDATION_RULES_ERROR_CODES).toContain("validation_rule_rate_limited");
    expect(IDENTITY_ERROR_CODES).toContain("product_admin_required");
  });
});

describe("a create (CreateTestRegexRequestSchema)", () => {
  it("accepts the dialog's fields, trimming the name, category and description; the description may be left out (null)", () => {
    expect(CreateTestRegexRequestSchema.parse(valid)).toEqual(valid);
    expect(
      CreateTestRegexRequestSchema.parse({ name: "  Email  ", category: "\tPII ", description: " Emails\n", regex: "a" }),
    ).toEqual({ name: "Email", category: "PII", description: "Emails", regex: "a" });
    expect(CreateTestRegexRequestSchema.parse({ name: "n", category: "c", regex: "r" })).toEqual({
      name: "n",
      category: "c",
      description: null,
      regex: "r",
    });
  });

  it("makes a description of '', only whitespace (Unicode's included) or null none (null): the table refuses ''", () => {
    for (const description of ["", "   ", "\u3000\u0085", GO_SPACES, "\ufeff ", null]) {
      expect(CreateTestRegexRequestSchema.parse({ ...valid, description }).description, JSON.stringify(description)).toBeNull();
    }
  });

  it("trims whitespace as JavaScript and Go both count it: U+0085 (which trim keeps) and U+FEFF (which Go keeps) go", () => {
    expect(
      CreateTestRegexRequestSchema.parse({
        ...valid,
        name: `${GO_SPACES}\ufeffEmail\u0085 \ufeff\u0085`,
        category: "\u0085PII\u00a0",
        description: "\u2028Emails\u0085",
      }),
    ).toMatchObject({ name: "Email", category: "PII", description: "Emails" });
    // Inside the text, whitespace stays.
    expect(CreateTestRegexRequestSchema.parse({ ...valid, name: "E\u0085mail \u00a0x" }).name).toBe("E\u0085mail \u00a0x");
  });

  it("exports the schemas' trim (trimLibraryText) for the web's dialog: one JavaScript trim then one of Go's isn't enough", () => {
    // U+0085 hides U+FEFF from trim, and U+FEFF hides the inner U+0085 from Go's: only trimming again empties it.
    expect(trimLibraryText("\u0085\ufeff\u0085")).toBe("");
    expect(trimLibraryText(`${GO_SPACES}\ufeffEmail\u0085 \ufeff\u0085`)).toBe("Email");
    expect(trimLibraryText("E\u0085mail \u00a0x")).toBe("E\u0085mail \u00a0x");
    expect(CreateTestRegexRequestSchema.safeParse({ ...valid, name: "\u0085\ufeff\u0085" }).success).toBe(false);
  });

  it("never trims the regex: its spaces are part of it, byte for byte", () => {
    for (const regex of [" a ", "\\d{3}-\\d{2}-\\d{4}", "a\u0085", "\ta\n", "\\bfoo\\b"]) {
      expect(CreateTestRegexRequestSchema.parse({ ...valid, regex }).regex).toBe(regex);
    }
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    ["a blank name", { name: "  " }, "name", "The name can't be empty."],
    ["a name of Unicode's whitespace only", { name: "\u0085\u3000\ufeff" }, "name", "The name can't be empty."],
    ["a 201-character name", { name: "n".repeat(201) }, "name", "String must contain at most 200 character(s)"],
    ["a name with U+0000", { name: "a\u0000" }, "name", "The name can't contain U+0000 or a lone surrogate."],
    ["a blank category", { category: "" }, "category", "The category can't be empty."],
    ["a category of Unicode's whitespace only", { category: "\u00a0\u0085" }, "category", "The category can't be empty."],
    ["a 101-character category", { category: "c".repeat(101) }, "category", "String must contain at most 100 character(s)"],
    ["a category with a lone surrogate", { category: "a\ud800" }, "category", "The category can't contain U+0000 or a lone surrogate."],
    ["a 2,001-character description", { description: "d".repeat(2_001) }, "description", "String must contain at most 2000 character(s)"],
    ["a description with U+0000", { description: "a\u0000b" }, "description", "The description can't contain U+0000 or a lone surrogate."],
    ["an empty regex", { regex: "" }, "regex", "The regex is empty."],
    ["a regex of Unicode's whitespace only", { regex: "\u0085\u3000 " }, "regex", "The regex is empty."],
    ["a regex of 8,193 bytes", { regex: "a".repeat(8_193) }, "regex", "The regex is longer than 8,192 bytes."],
    ["a regex of 4,097 two-byte characters (8,194 bytes)", { regex: "é".repeat(4_097) }, "regex", "The regex is longer than 8,192 bytes."],
    ["a regex with U+0000", { regex: "a\u0000" }, "regex", "The regex can't contain U+0000 or a lone surrogate."],
  ])("refuses %s", (_label, overrides, path, message) => {
    expect(issuesOf(CreateTestRegexRequestSchema.safeParse({ ...valid, ...overrides }))).toEqual([{ path, message }]);
  });

  it("accepts each field at its bound: 200, 100 and 2,000 characters, a regex of exactly 8,192 bytes", () => {
    const atBounds = {
      name: "n".repeat(200),
      category: "c".repeat(100),
      description: "d".repeat(2_000),
      regex: "é".repeat(4_096),
    };
    expect(CreateTestRegexRequestSchema.parse(atBounds)).toEqual(atBounds);
  });

  it("refuses a missing field, a field of another type and an unknown field (strict)", () => {
    for (const body of [
      { category: "c", regex: "r" },
      { name: "n", regex: "r" },
      { name: "n", category: "c" },
      { ...valid, regex: 7 },
      { ...valid, pattern: "r" },
      { ...valid, id: ID },
    ]) {
      expect(CreateTestRegexRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("takes every regex a regex rule takes as its pattern, and no other (ruleTextSchema)", () => {
    for (const regex of ["a", " a ", "", " ", "\u3000", "a".repeat(8_192), "a".repeat(8_193), "a\u0000", "a\udc00"]) {
      const asEntry = CreateTestRegexRequestSchema.safeParse({ ...valid, regex }).success;
      const asRule = CreateValidationRuleRequestSchema.safeParse({ kind: "contains_regex", target: "output", pattern: regex }).success;
      expect(asEntry, JSON.stringify(regex)).toBe(asRule);
    }
  });
});

describe("a change (UpdateTestRegexRequestSchema)", () => {
  it("takes any of the four fields, each as a create does; none at all ({}) is a change of nothing", () => {
    expect(UpdateTestRegexRequestSchema.parse({})).toEqual({});
    expect(UpdateTestRegexRequestSchema.parse({ name: " Renamed " })).toEqual({ name: "Renamed" });
    expect(UpdateTestRegexRequestSchema.parse({ category: "Secrets", regex: " x" })).toEqual({ category: "Secrets", regex: " x" });
  });

  it("removes the description with '', whitespace or null", () => {
    for (const description of ["", " \u0085 ", null]) {
      expect(UpdateTestRegexRequestSchema.parse({ description })).toEqual({ description: null });
    }
  });

  it("refuses what a create refuses, and an unknown field", () => {
    for (const body of [
      { name: "\u3000" },
      { category: " " },
      { regex: "" },
      { regex: "\u0085" },
      { name: "n".repeat(201) },
      { description: "d".repeat(2_001) },
      { regex: "a".repeat(8_193) },
      { createdAt: NOW },
      { name: null },
      { regex: null },
    ]) {
      expect(UpdateTestRegexRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("an entry (TestRegexSchema) and the bodies", () => {
  const entry = { id: ID, ...valid, createdAt: NOW, updatedAt: NOW };

  it("serialises a stored row: a null description, and bounds counted as the table counts them (code points, bytes)", () => {
    expect(TestRegexSchema.parse(entry)).toEqual(entry);
    expect(TestRegexSchema.parse({ ...entry, description: null }).description).toBeNull();
    // 200 characters outside the BMP: 400 UTF-16 units, 200 for char_length.
    expect(TestRegexSchema.safeParse({ ...entry, name: "😀".repeat(200) }).success).toBe(true);
    expect(TestRegexSchema.safeParse({ ...entry, name: "😀".repeat(201) }).success).toBe(false);
    expect(TestRegexSchema.safeParse({ ...entry, regex: "a".repeat(8_193) }).success).toBe(false);
    expect(TestRegexSchema.safeParse({ ...entry, extra: 1 }).success).toBe(false);
  });

  it("wraps the list as {testRegexes} and one entry as {testRegex}", () => {
    expect(TestRegexesResponseSchema.parse({ testRegexes: [entry] })).toEqual({ testRegexes: [entry] });
    expect(TestRegexResponseSchema.parse({ testRegex: entry })).toEqual({ testRegex: entry });
    expect(TestRegexesResponseSchema.safeParse({ regexes: [entry] }).success).toBe(false);
  });
});
