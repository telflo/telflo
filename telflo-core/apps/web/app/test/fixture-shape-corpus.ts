import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FixtureShape, StrategyKind } from "~/lib/test-runs/fixture-shape.js";

/*
 * The fixture-shape parity corpus as the web's parity test reads it (D14a
 * decision 17, Preflight ruling 18): the one copy,
 * `services/otelcol-testing/tests/fixtures/fixture-shape-corpus.json`, which
 * the tester's `tests/test_fixture_shape_parity.py` reads too, as
 * app/test/seeded-flows.ts reads the validator's fixture. Each section is
 * checked for its fields here, so a renamed key fails loudly instead of
 * passing over no cases.
 */

export interface DetectionCase {
  name: string;
  text: string;
  expected: FixtureShape;
}

export interface SignalCase {
  name: string;
  text: string;
  expected: string | null;
}

export interface AdvisoryCase {
  name: string;
  shape: FixtureShape;
  strategy: StrategyKind;
  signal_type?: string | null;
  fixture_signal?: string | null;
  expected_id: "F-001" | "F-002" | "F-003" | null;
  expected_message?: string;
}

export interface StrategyCase {
  name: string;
  yaml: string;
  signal_type: string;
  /** Only the target_strategies section's cases carry one (D14a Task 9). */
  target_pipeline?: string;
  expected_kind: StrategyKind;
}

export interface FixtureShapeCorpus {
  detection: DetectionCase[];
  signals: SignalCase[];
  advisories: AdvisoryCase[];
  strategies: StrategyCase[];
  target_strategies: StrategyCase[];
}

/** The corpus's path. */
const CORPUS = fileURLToPath(
  new URL("../../../../../services/otelcol-testing/tests/fixtures/fixture-shape-corpus.json", import.meta.url),
);

/** What each section's cases must carry, as strings (or null where the corpus allows it). */
const REQUIRED: Record<keyof FixtureShapeCorpus, readonly string[]> = {
  detection: ["name", "text", "expected"],
  signals: ["name", "text"],
  advisories: ["name", "shape", "strategy"],
  strategies: ["name", "yaml", "signal_type", "expected_kind"],
  target_strategies: ["name", "yaml", "signal_type", "target_pipeline", "expected_kind"],
};

/** The corpus, each section a non-empty list whose cases carry their fields; throws, naming the case, otherwise. */
export function fixtureShapeCorpus(): FixtureShapeCorpus {
  const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as Record<string, unknown>;
  for (const [section, fields] of Object.entries(REQUIRED)) {
    const cases = corpus[section];
    if (!Array.isArray(cases) || cases.length === 0) throw new Error(`The fixture-shape corpus has no ${section} cases.`);
    cases.forEach((value: unknown, index) => {
      const entry = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      const missing = fields.filter((field) => typeof entry[field] !== "string");
      if (missing.length > 0) throw new Error(`The corpus's ${section} case ${index} lacks ${missing.join(", ")}.`);
    });
  }
  return corpus as unknown as FixtureShapeCorpus;
}
