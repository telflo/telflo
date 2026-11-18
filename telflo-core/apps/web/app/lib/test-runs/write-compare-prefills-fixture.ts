import { writeFileSync } from "node:fs";

import { COMPARE_PREFILLS_FIXTURE_PATH, comparePrefillsFixture, serializedComparePrefillsFixture } from "~/lib/test-runs/compare-prefills-fixture.js";

// `npm run fixture:compare-prefills --workspace @telflo/web`: writes the
// fixture of the OTTL Compare's "Create an OTTL rule" writes
// (compare-prefills-fixture.ts says what it holds) from diff-rule-detection.ts
// as it is today. Run by tsx (Ruling 24).
const fixture = comparePrefillsFixture();
const text = serializedComparePrefillsFixture(fixture);
writeFileSync(COMPARE_PREFILLS_FIXTURE_PATH, text);
console.log(`Wrote ${COMPARE_PREFILLS_FIXTURE_PATH} (${fixture.cases.length} cases, ${text.length} characters).`);
