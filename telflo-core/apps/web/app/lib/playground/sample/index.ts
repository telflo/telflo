import { sampleConfigurations } from "./configurations.js";
import { sampleFleets } from "./fleets.js";
import { sampleTesting } from "./testing-tab.js";

/*
 * The sample workspace, "Acme Observability" (D31-1 decision 10): one
 * module per area, each rebuilt on every call with times relative to now
 * (Preflight ruling 6). `configurations` is Task 1's; `testing-tab` Task 2's;
 * `fleets` Task 3's. The reads that answer from it are in
 * `../sample-reads.ts`, behind `readsFor` (lib/workspace-reads.ts).
 */

export * from "./types.js";
export { SAMPLE_CONFIGURATION_IDS, sampleConfiguration, sampleConfigurations } from "./configurations.js";

/** The whole sample, for the checks that read all of it (sample.test.ts: its shapes, and no secret-shaped value). */
export function sampleWorkspace(now: number = Date.now()) {
  return {
    configurations: sampleConfigurations(now),
    testing: sampleTesting(now),
    fleets: sampleFleets(now),
  };
}
