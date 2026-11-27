import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The seeded flows as the collector checks see them: each flow's slug, its
 * pin and its YAML, from the `seededFlows` of every migration that seeds
 * flows (1700000000026, 1700000000045 and 1700000000046,
 * seeded-flows-migrations.ts),
 * committed as `services/otelcol-validator/tests/fixtures/seeded-flows.json`.
 * The validator's binary tests run each flow's pin over it
 * (`tests/test_binary_flows.py`), and the web's schema tests read it
 * (`otelcol-schema.test.ts`, `otelcol-schema-warnings.test.ts`), so all of
 * them check the migrations' one copy of the text.
 *
 * `npm run fixture:seeded-flows --workspace @telflo/db` writes it
 * (write-seeded-flows-fixture.ts); `seeded-flows-fixture.test.ts` checks the
 * committed file is what this produces from the migration today, and never
 * writes it. Pure: the flows come in as an argument, so nothing here loads
 * the migrations (seeded-flows-migrations.ts does).
 */

/** The command that writes the fixture. */
export const SEEDED_FLOWS_SCRIPT = "npm run fixture:seeded-flows --workspace @telflo/db";

/** Where the fixture is, from the repository's root. */
export const SEEDED_FLOWS_FIXTURE = "services/otelcol-validator/tests/fixtures/seeded-flows.json";

/** The repository's root (this file is telflo-core/packages/db/src/). */
const REPOSITORY_ROOT = new URL("../../../../", import.meta.url);

/** The fixture's absolute path. */
export const SEEDED_FLOWS_FIXTURE_PATH = fileURLToPath(new URL(SEEDED_FLOWS_FIXTURE, REPOSITORY_ROOT));

/** The part of a seeded flow (a migration's `seededFlows` row) the fixture holds. */
export interface FixtureSourceFlow {
  readonly slug: string;
  readonly collector_distribution: string;
  readonly collector_version: string;
  readonly yaml_content: string;
}

/** One flow of the fixture. */
export interface SeededFlowsFixtureFlow {
  slug: string;
  collectorDistribution: string;
  collectorVersion: string;
  yaml: string;
}

export interface SeededFlowsFixture {
  description: string;
  script: string;
  flows: SeededFlowsFixtureFlow[];
}

/** The fixture of `flows`, in their order (the seed's sort order). */
export function seededFlowsFixture(flows: readonly FixtureSourceFlow[]): SeededFlowsFixture {
  return {
    description:
      "The seeded flows' slugs, pins and YAML, from the seededFlows of migrations 1700000000026, 1700000000045 and 1700000000046. " +
      "Generated: never edit by hand.",
    script: SEEDED_FLOWS_SCRIPT,
    flows: flows.map((flow) => ({
      slug: flow.slug,
      collectorDistribution: flow.collector_distribution,
      collectorVersion: flow.collector_version,
      yaml: flow.yaml_content,
    })),
  };
}

/** The fixture of `flows` as the committed file holds it: two-space JSON, ending in one newline. */
export function serializedSeededFlowsFixture(flows: readonly FixtureSourceFlow[]): string {
  return `${JSON.stringify(seededFlowsFixture(flows), null, 2)}\n`;
}

/** Writes the fixture of `flows` to `path` (the committed file by default), returning the text written. */
export function writeSeededFlowsFixture(flows: readonly FixtureSourceFlow[], path: string = SEEDED_FLOWS_FIXTURE_PATH): string {
  const text = serializedSeededFlowsFixture(flows);
  writeFileSync(path, text);
  return text;
}
