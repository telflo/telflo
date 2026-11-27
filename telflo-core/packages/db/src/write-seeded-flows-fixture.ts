import { SEEDED_FLOWS_FIXTURE_PATH, writeSeededFlowsFixture } from "./seeded-flows-fixture.js";
import { loadSeededFlows } from "./seeded-flows-migrations.js";

// `npm run fixture:seeded-flows --workspace @telflo/db`: writes the seeded
// flows' fixture (seeded-flows-fixture.ts says what it holds) from the
// `seededFlows` of every migration that seeds flows (1700000000026,
// 1700000000045 and 1700000000046). Run by tsx, like migrate.ts. The migrations are reached as
// @telflo/db/testing's loadSeededFlows reaches them
// (seeded-flows-migrations.ts, by a dynamic import of a computed URL, since
// a static one would bring an untyped file outside `src` into the
// typecheck); @telflo/db/testing itself is test support, which a file that
// isn't a test may not import (eslint.config.js).
const seededFlows = await loadSeededFlows();
const text = writeSeededFlowsFixture(seededFlows);
console.log(`Wrote ${SEEDED_FLOWS_FIXTURE_PATH} (${seededFlows.length} flows, ${text.length} characters).`);
