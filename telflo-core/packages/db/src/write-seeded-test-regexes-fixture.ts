import {
  SEEDED_TEST_REGEXES_FIXTURE_PATH,
  writeSeededTestRegexesFixture,
  type FixtureSourceTestRegex,
} from "./seeded-test-regexes-fixture.js";

// `npm run fixture:seeded-test-regexes --workspace @telflo/db`: writes the
// regex library's seeded entries' fixture (seeded-test-regexes-fixture.ts
// says what it holds) from migration 1700000000031's `seededTestRegexes`.
// Run by tsx, like migrate.ts. The migration is reached as
// @telflo/db/testing's loadTestRegexMigration reaches it, by a dynamic import
// of a computed URL (a static one would bring an untyped file outside `src`
// into the typecheck); that loader is test support, which a file that isn't
// a test may not import (eslint.config.js).
const url = new URL("../migrations/1700000000031_test_regex.js", import.meta.url).href;
const { seededTestRegexes } = (await import(url)) as { seededTestRegexes: readonly FixtureSourceTestRegex[] };
const text = writeSeededTestRegexesFixture(seededTestRegexes);
console.log(
  `Wrote ${SEEDED_TEST_REGEXES_FIXTURE_PATH} (${seededTestRegexes.length} entries, ${text.length} characters).`,
);
