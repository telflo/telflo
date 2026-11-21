import { SEEDED_FLOWS_FIXTURE_PATH, writeSeededFlowsFixture, type FixtureSourceFlow } from "./seeded-flows-fixture.js";

// `npm run fixture:seeded-flows --workspace @telflo/db`: writes the seeded
// flows' fixture (seeded-flows-fixture.ts says what it holds) from migration
// 1700000000026's `seededFlows`. Run by tsx, like migrate.ts. The migration
// is reached as @telflo/db/testing's loadFlowsMigration reaches it, by a
// dynamic import of a computed URL (a static one would bring an untyped file
// outside `src` into the typecheck); that loader is test support, which a
// file that isn't a test may not import (eslint.config.js).
const url = new URL("../migrations/1700000000026_flows.js", import.meta.url).href;
const { seededFlows } = (await import(url)) as { seededFlows: readonly FixtureSourceFlow[] };
const text = writeSeededFlowsFixture(seededFlows);
console.log(`Wrote ${SEEDED_FLOWS_FIXTURE_PATH} (${seededFlows.length} flows, ${text.length} characters).`);
