import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The regex library's seeded entries as their two checks see them (as
 * seeded-flows-fixture.ts does for the flows): each entry's name, category, description and regex, from
 * migration 1700000000031's `seededTestRegexes`, committed as
 * `services/ottl-evaluator/internal/rules/testdata/seeded-test-regexes.json`.
 * The evaluator's `seeded_test_regexes_test.go` checks every pattern under
 * its RE2 (`Check`, for each signal, regex kind and target), and the web's
 * `regex-library.test.ts` pins `REGEX_LIBRARY` equal to it, in order, so
 * both check the migration's one copy of the text.
 *
 * `npm run fixture:seeded-test-regexes --workspace @telflo/db` writes it
 * (write-seeded-test-regexes-fixture.ts); `seeded-test-regexes-fixture.test.ts`
 * checks the committed file is what this produces from the migration today,
 * and never writes it. Pure: the entries come in as an argument, so nothing
 * here loads the migration (its loader is test support, @telflo/db/testing).
 */

/** The command that writes the fixture. */
export const SEEDED_TEST_REGEXES_SCRIPT = "npm run fixture:seeded-test-regexes --workspace @telflo/db";

/** Where the fixture is, from the repository's root. */
export const SEEDED_TEST_REGEXES_FIXTURE = "services/ottl-evaluator/internal/rules/testdata/seeded-test-regexes.json";

/** The repository's root (this file is telflo-core/packages/db/src/). */
const REPOSITORY_ROOT = new URL("../../../../", import.meta.url);

/** The fixture's absolute path. */
export const SEEDED_TEST_REGEXES_FIXTURE_PATH = fileURLToPath(new URL(SEEDED_TEST_REGEXES_FIXTURE, REPOSITORY_ROOT));

/** A seeded entry (the migration's `seededTestRegexes` row), which the fixture holds whole. */
export interface FixtureSourceTestRegex {
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly regex: string;
}

/** One entry of the fixture. */
export interface SeededTestRegexesFixtureEntry {
  name: string;
  category: string;
  description: string | null;
  regex: string;
}

export interface SeededTestRegexesFixture {
  description: string;
  script: string;
  testRegexes: SeededTestRegexesFixtureEntry[];
}

/** The fixture of `rows`, in their order (regex-library.ts's). */
export function seededTestRegexesFixture(rows: readonly FixtureSourceTestRegex[]): SeededTestRegexesFixture {
  return {
    description:
      "The regex library's seeded entries, from migration 1700000000031's seededTestRegexes. " +
      "Generated: never edit by hand.",
    script: SEEDED_TEST_REGEXES_SCRIPT,
    testRegexes: rows.map((row) => ({
      name: row.name,
      category: row.category,
      description: row.description,
      regex: row.regex,
    })),
  };
}

/** The fixture of `rows` as the committed file holds it: two-space JSON, ending in one newline. */
export function serializedSeededTestRegexesFixture(rows: readonly FixtureSourceTestRegex[]): string {
  return `${JSON.stringify(seededTestRegexesFixture(rows), null, 2)}\n`;
}

/** Writes the fixture of `rows` to `path` (the committed file by default), returning the text written. */
export function writeSeededTestRegexesFixture(
  rows: readonly FixtureSourceTestRegex[],
  path: string = SEEDED_TEST_REGEXES_FIXTURE_PATH,
): string {
  const text = serializedSeededTestRegexesFixture(rows);
  writeFileSync(path, text);
  return text;
}
