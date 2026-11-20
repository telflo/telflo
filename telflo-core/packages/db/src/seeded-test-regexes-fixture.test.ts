import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SEEDED_TEST_REGEXES_FIXTURE,
  SEEDED_TEST_REGEXES_FIXTURE_PATH,
  SEEDED_TEST_REGEXES_SCRIPT,
  seededTestRegexesFixture,
  serializedSeededTestRegexesFixture,
  writeSeededTestRegexesFixture,
  type SeededTestRegexesFixture,
} from "./seeded-test-regexes-fixture.js";
import { loadTestRegexMigration } from "./testing.js";

/*
 * The regex library's seeded entries' fixture, which the evaluator's RE2
 * check and the web's REGEX_LIBRARY check read: the committed file is what
 * seeded-test-regexes-fixture.ts makes of migration 1700000000031's
 * `seededTestRegexes` today. This test reads it and never writes it (but
 * for a temporary directory's copy). No database.
 */

function committedFixture(): string {
  return readFileSync(SEEDED_TEST_REGEXES_FIXTURE_PATH, "utf8");
}

describe("the seeded test regexes' fixture", () => {
  it("is what the script writes from the migration's seededTestRegexes today", async () => {
    const { seededTestRegexes } = await loadTestRegexMigration();
    // Not toBe: a stale fixture's message names the script, not a 7 KB diff.
    expect(
      committedFixture() === serializedSeededTestRegexesFixture(seededTestRegexes),
      `${SEEDED_TEST_REGEXES_FIXTURE} is stale: migration 1700000000031's seededTestRegexes changed. Run \`${SEEDED_TEST_REGEXES_SCRIPT}\` and commit the file.`,
    ).toBe(true);
  });

  it("holds every seeded entry once, in the seed's order, each regex byte for byte", async () => {
    const { seededTestRegexes } = await loadTestRegexMigration();
    const fixture = JSON.parse(committedFixture()) as SeededTestRegexesFixture;
    expect(fixture.script).toBe(SEEDED_TEST_REGEXES_SCRIPT);
    expect(fixture.testRegexes.map((entry) => entry.name)).toEqual(seededTestRegexes.map((entry) => entry.name));
    expect(new Set(fixture.testRegexes.map((entry) => entry.name)).size).toBe(35);
    for (const [index, entry] of fixture.testRegexes.entries()) {
      const seeded = seededTestRegexes[index]!;
      expect(entry, entry.name).toEqual({ ...seeded });
      expect(Buffer.from(entry.regex, "utf8").equals(Buffer.from(seeded.regex, "utf8")), entry.name).toBe(true);
    }
  });

  it("is two-space JSON ending in one newline, the same text every time", () => {
    const rows = [{ name: "A \\d", category: "C", description: null, regex: "\\d+\\." }];
    const text = serializedSeededTestRegexesFixture(rows);
    expect(text).toBe(`${JSON.stringify(seededTestRegexesFixture(rows), null, 2)}\n`);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(serializedSeededTestRegexesFixture(rows)).toBe(text);
    expect(JSON.parse(text)).toEqual({
      description: expect.stringContaining("Generated: never edit by hand."),
      script: SEEDED_TEST_REGEXES_SCRIPT,
      testRegexes: [{ name: "A \\d", category: "C", description: null, regex: "\\d+\\." }],
    });
  });

  it("writes the serialized fixture to the path it is given", async () => {
    const { seededTestRegexes } = await loadTestRegexMigration();
    const directory = mkdtempSync(join(tmpdir(), "seeded-test-regexes-fixture-"));
    try {
      const path = join(directory, "seeded-test-regexes.json");
      const text = writeSeededTestRegexesFixture(seededTestRegexes, path);
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(text).toBe(serializedSeededTestRegexesFixture(seededTestRegexes));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("names the evaluator's rules package's testdata, from the repository's root", () => {
    expect(SEEDED_TEST_REGEXES_FIXTURE_PATH.endsWith(`/${SEEDED_TEST_REGEXES_FIXTURE}`)).toBe(true);
    expect(readFileSync(join(SEEDED_TEST_REGEXES_FIXTURE_PATH, "../../check.go"), "utf8")).toContain("package rules");
  });
});
