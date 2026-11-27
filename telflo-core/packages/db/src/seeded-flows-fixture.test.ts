import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SEEDED_FLOWS_FIXTURE,
  SEEDED_FLOWS_FIXTURE_PATH,
  SEEDED_FLOWS_SCRIPT,
  seededFlowsFixture,
  serializedSeededFlowsFixture,
  writeSeededFlowsFixture,
  type SeededFlowsFixture,
} from "./seeded-flows-fixture.js";
import { loadSeededFlows } from "./testing.js";

/*
 * The seeded flows' fixture the validator's binary tests and the web's
 * schema tests read: the committed file is what seeded-flows-fixture.ts
 * makes of the seeding migrations' `seededFlows` (1700000000026's,
 * 1700000000045's and 1700000000046's) today. This test reads it and never writes it (but for
 * a temporary directory's copy).
 */

function committedFixture(): string {
  return readFileSync(SEEDED_FLOWS_FIXTURE_PATH, "utf8");
}

describe("the seeded flows' fixture", () => {
  it("is what the script writes from the migrations' seededFlows today", async () => {
    const seededFlows = await loadSeededFlows();
    // Not toBe: a stale fixture's message names the script, not a 55 KB diff.
    expect(
      committedFixture() === serializedSeededFlowsFixture(seededFlows),
      `${SEEDED_FLOWS_FIXTURE} is stale: a seeding migration's seededFlows changed. Run \`${SEEDED_FLOWS_SCRIPT}\` and commit the file.`,
    ).toBe(true);
  });

  it("holds every seeded flow once, in the seed's order, with its pin and its YAML byte for byte", async () => {
    const seededFlows = await loadSeededFlows();
    const fixture = JSON.parse(committedFixture()) as SeededFlowsFixture;
    expect(fixture.script).toBe(SEEDED_FLOWS_SCRIPT);
    expect(fixture.flows.map((flow) => flow.slug)).toEqual(seededFlows.map((flow) => flow.slug));
    expect(new Set(fixture.flows.map((flow) => flow.slug)).size).toBe(20);
    for (const [index, flow] of fixture.flows.entries()) {
      const seeded = seededFlows[index]!;
      expect(flow, flow.slug).toEqual({
        slug: seeded.slug,
        collectorDistribution: seeded.collector_distribution,
        collectorVersion: seeded.collector_version,
        yaml: seeded.yaml_content,
      });
    }
  });

  it("is two-space JSON ending in one newline, the same text every time", () => {
    const flows = [{ slug: "a-flow", collector_distribution: "otelcol-contrib", collector_version: "0.162.0", yaml_content: "receivers: {}\n" }];
    const text = serializedSeededFlowsFixture(flows);
    expect(text).toBe(`${JSON.stringify(seededFlowsFixture(flows), null, 2)}\n`);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(serializedSeededFlowsFixture(flows)).toBe(text);
    expect(JSON.parse(text)).toEqual({
      description: expect.stringContaining("Generated: never edit by hand."),
      script: SEEDED_FLOWS_SCRIPT,
      flows: [{ slug: "a-flow", collectorDistribution: "otelcol-contrib", collectorVersion: "0.162.0", yaml: "receivers: {}\n" }],
    });
  });

  it("writes the serialized fixture to the path it is given", async () => {
    const seededFlows = await loadSeededFlows();
    const directory = mkdtempSync(join(tmpdir(), "seeded-flows-fixture-"));
    try {
      const path = join(directory, "seeded-flows.json");
      const text = writeSeededFlowsFixture(seededFlows, path);
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(text).toBe(serializedSeededFlowsFixture(seededFlows));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("names the validator's fixtures directory, from the repository's root", () => {
    expect(SEEDED_FLOWS_FIXTURE_PATH.endsWith(`/${SEEDED_FLOWS_FIXTURE}`)).toBe(true);
    expect(readFileSync(join(SEEDED_FLOWS_FIXTURE_PATH, "../../../Dockerfile"), "utf8")).toContain("otelcol-validator");
  });
});
