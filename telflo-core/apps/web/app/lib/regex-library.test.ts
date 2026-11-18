// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findPattern, getPatternsByCategory, groupPatternsByCategory, REGEX_LIBRARY, tryFindPattern } from "./regex-library.js";

/*
 * The regex library's seeded entries (D15b decision 7, Preflight ruling 2):
 * `services/ottl-evaluator/internal/rules/testdata/seeded-test-regexes.json`,
 * which the db workspace writes from migration 1700000000031's
 * `seededTestRegexes` and whose staleness its suite checks
 * (packages/db/src/seeded-test-regexes-fixture.ts). Read by relative URL, as
 * app/test/seeded-flows.ts reads the flows': the web doesn't depend on
 * @telflo/db.
 */
const SEEDED_TEST_REGEXES = fileURLToPath(
  new URL("../../../../../services/ottl-evaluator/internal/rules/testdata/seeded-test-regexes.json", import.meta.url),
);

describe("the regex library", () => {
  it("finds a pattern by name, and throws on a name it lacks", () => {
    expect(findPattern("Generic Prefix").pattern).toBe("^prefix_.*");
    expect(findPattern("Temp Prefix").pattern).toBe("^temp_.*");
    expect(findPattern("URL Protocol + Domain + Path").pattern).toBe("^(?P<http_protocol>.*?)://(?P<http_domain>.*?)/");
    expect(() => findPattern("No Such Pattern")).toThrow('regex-library: no pattern named "No Such Pattern".');
    expect(tryFindPattern("No Such Pattern")).toBeUndefined();
    expect(tryFindPattern("API Routes")?.pattern).toBe("^/api/.*");
  });

  it("names each pattern once, and every pattern compiles (Go's named groups aside)", () => {
    const names = REGEX_LIBRARY.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(REGEX_LIBRARY).toHaveLength(35);
    for (const { pattern } of REGEX_LIBRARY) {
      expect(() => new RegExp(pattern.replaceAll("(?P<", "(?<"))).not.toThrow();
    }
  });

  it("groups by category, in the catalog's order", () => {
    expect(getPatternsByCategory("URL Routes").map((p) => p.name)).toEqual([
      "Admin/Internal Routes",
      "Health Check Routes",
      "API Routes",
    ]);
    const grouped = groupPatternsByCategory();
    expect(Object.keys(grouped)).toEqual([
      "PII / GDPR",
      "PCI",
      "PHI / HIPAA",
      "Secrets",
      "Keys",
      "URL Routes",
      "Value Extraction",
      "URL Parsing",
      "Log Parsing",
      "Attribute Key Prefixes",
      "Date Formats",
    ]);
    expect(grouped.Keys.map((p) => p.shortDescription)).toEqual(["API keys", "Auth tokens", "Passwords", "Secrets"]);
    expect(groupPatternsByCategory([findPattern("UUID")])).toEqual({ Secrets: [findPattern("UUID")] });
  });

  it("starts equal to the table's seed: every entry's name, category, description and pattern, in order (D15b decision 11)", () => {
    const { testRegexes } = JSON.parse(readFileSync(SEEDED_TEST_REGEXES, "utf8")) as {
      testRegexes: { name: string; category: string; description: string | null; regex: string }[];
    };
    expect(testRegexes).toHaveLength(35);
    expect(
      REGEX_LIBRARY.map(({ name, category, description, pattern }) => ({ name, category, description, regex: pattern })),
    ).toEqual(testRegexes);
  });
});
