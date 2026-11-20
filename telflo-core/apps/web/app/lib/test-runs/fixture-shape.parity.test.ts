// @vitest-environment node
// Node, as the seeded flows' tests run: under jsdom, Vite serves the corpus's
// `new URL(…, import.meta.url)` as an asset URL, not a file.

import { describe, expect, it } from "vitest";
import { fixtureShapeCorpus } from "~/test/fixture-shape-corpus.js";
import {
  detectFixtureShape,
  detectOtlpSignal,
  fixtureStrategyMismatchAdvisory,
  pickStrategyKind,
} from "./fixture-shape.js";

/*
 * Parity with the tester: the one corpus the tester's
 * `tests/test_fixture_shape_parity.py` reads
 * (`services/otelcol-testing/tests/fixtures/fixture-shape-corpus.json`,
 * through app/test/fixture-shape-corpus.ts). A drift in the shapes, the
 * messages or the strategy picking fails a row here and in pytest.
 *
 * The target_strategies section adds the run's target pipeline; the
 * tester's own pick_strategy narrows to it, and so does this module.
 */

const corpus = fixtureShapeCorpus();

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("fixture-shape parity with the tester's corpus", () => {
  describe("detection", () => {
    for (const testCase of corpus.detection) {
      it(testCase.name, () => {
        expect(detectFixtureShape(bytes(testCase.text))).toBe(testCase.expected);
      });
    }
  });

  describe("signals", () => {
    for (const testCase of corpus.signals) {
      it(testCase.name, () => {
        expect(detectOtlpSignal(bytes(testCase.text))).toBe(testCase.expected);
      });
    }
  });

  describe("advisories", () => {
    for (const testCase of corpus.advisories) {
      it(testCase.name, () => {
        const advisory = fixtureStrategyMismatchAdvisory(
          testCase.shape,
          testCase.strategy,
          testCase.signal_type,
          testCase.fixture_signal,
        );
        if (testCase.expected_id === null) {
          expect(advisory).toBeNull();
          return;
        }
        expect(advisory?.id).toBe(testCase.expected_id);
        // The exact words: the messages are duplicated across the two modules.
        expect(advisory?.message).toBe(testCase.expected_message);
      });
    }
  });

  describe("strategy kind", () => {
    for (const testCase of corpus.strategies) {
      it(testCase.name, () => {
        expect(pickStrategyKind(testCase.yaml, testCase.signal_type)).toBe(testCase.expected_kind);
      });
    }
  });

  describe("strategy kind with the target pipeline", () => {
    for (const testCase of corpus.target_strategies) {
      it(testCase.name, () => {
        expect(pickStrategyKind(testCase.yaml, testCase.signal_type, testCase.target_pipeline)).toBe(testCase.expected_kind);
      });
    }
  });

  it("reads cases that spell the receiver file_log, as well as filelog", () => {
    const spelled = [...corpus.strategies, ...corpus.target_strategies].filter((testCase) => /\bfile_log\b/.test(testCase.yaml));
    expect(spelled.length).toBe(6);
    expect(spelled.filter((testCase) => testCase.expected_kind === "filelog").length).toBe(4);
  });

  it("covers the corpus's every section, with the counts the tester's suite reads", () => {
    // The detection corpus, the four target cases, and file_log's
    // three strategy and three target cases.
    expect({
      detection: corpus.detection.length,
      signals: corpus.signals.length,
      advisories: corpus.advisories.length,
      strategies: corpus.strategies.length,
      target_strategies: corpus.target_strategies.length,
    }).toEqual({ detection: 13, signals: 8, advisories: 21, strategies: 9, target_strategies: 7 });
  });
});
