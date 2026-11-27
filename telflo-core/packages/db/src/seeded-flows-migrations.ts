/*
 * The migrations that seed flows, in order: 1700000000026 seeds 13,
 * 1700000000045 three more and 1700000000046 four more. Each exports `seededFlows`, its flows frozen in
 * their sort order, and `seededFlowsInsert`, their insert on conflict (slug)
 * do nothing, as its up runs it. Read in this order, their flows are every
 * seeded flow in the gallery's order: each migration's flows sort after
 * those of the ones before it (flows.integration.test.ts checks that, and
 * that no other migration exports `seededFlows`).
 *
 * Each module is reached by a dynamic import of a computed URL: a static
 * import would bring an untyped file outside `src` into the typecheck. Not
 * test support, so the fixture's script (write-seeded-flows-fixture.ts)
 * reads them here too; @telflo/db/testing hands them to the tests.
 */

/** The migrations that seed flows, by file name, in the order they run. */
export const SEEDED_FLOWS_MIGRATIONS = [
  "1700000000026_flows.js",
  "1700000000045_more_seeded_flows.js",
  "1700000000046_four_more_seeded_flows.js",
] as const;

/**
 * A seeded flow as its migration holds it: its row, pinned, in the flows
 * table's column names.
 */
export interface SeededFlow {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly source: "telflo" | "community";
  readonly author_name: string | null;
  readonly author_url: string | null;
  readonly signals: readonly string[];
  readonly tags: readonly string[];
  readonly yaml_content: string;
  readonly collector_distribution: string;
  readonly collector_version: string;
  readonly source_url: string | null;
  readonly published: boolean;
  readonly sort_order: number;
}

/** What every migration that seeds flows exports beside up and down. */
export interface SeededFlowsMigration {
  /** Its seeded flows, frozen, in their sort order. */
  readonly seededFlows: readonly SeededFlow[];
  /** Their insert, on conflict (slug) do nothing, as the migration runs it. */
  seededFlowsInsert(): string;
}

/** The URL of the migration module `file`. */
export function migrationUrl(file: string): string {
  return new URL(`../migrations/${file}`, import.meta.url).href;
}

/** Every migration that seeds flows, in the order they run. */
export async function loadSeededFlowsMigrations(): Promise<SeededFlowsMigration[]> {
  const migrations: SeededFlowsMigration[] = [];
  for (const file of SEEDED_FLOWS_MIGRATIONS) {
    migrations.push((await import(migrationUrl(file))) as SeededFlowsMigration);
  }
  return migrations;
}

/** Every seeded flow, in the gallery's order: each seeding migration's, in the order they run. */
export async function loadSeededFlows(): Promise<readonly SeededFlow[]> {
  return (await loadSeededFlowsMigrations()).flatMap((migration) => migration.seededFlows);
}
