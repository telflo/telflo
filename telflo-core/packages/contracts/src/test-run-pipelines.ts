import { z } from "zod";
import { hasUnstorableCharacter, hasYamlControlCharacter } from "./configurations.js";

/*
 * A run's signal and pipeline, and the code-point count every bound here
 * uses (D14a Ruling 39). Here rather than in test-runs.ts, which exports
 * them as before, so validation-rules.ts can read them without importing
 * test-runs.ts: test-runs.ts imports validation-rules.ts for a run's rules
 * and results (D15a Task 7), and a cycle between them would fail at load.
 */

/** A pipeline's name, as the text names it (`logs`, `logs/app`): 1 to 200 characters, the tester's bound. */
export const TEST_RUN_PIPELINE_MAXIMUM_LENGTH = 200;

export const TEST_RUN_SIGNALS = ["traces", "metrics", "logs"] as const;

export type TestRunSignal = (typeof TEST_RUN_SIGNALS)[number];

/**
 * How many code points `text` holds (D14a Ruling 39): a surrogate pair is
 * one, as Python's `len` and Postgres's `char_length` count, where
 * `text.length` counts two. Counted without allocating.
 */
export function codePointLength(text: string): number {
  let pairs = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        pairs += 1;
        index += 1;
      }
    }
  }
  return text.length - pairs;
}

/**
 * A pipeline's name, as the text names it: `<signal>` or `<signal>/<name>`,
 * 1 to 200 characters, nothing Postgres can't store.
 */
export const TestRunPipelineSchema = z
  .string()
  .min(1)
  .max(TEST_RUN_PIPELINE_MAXIMUM_LENGTH)
  .refine((name) => !hasUnstorableCharacter(name) && !hasYamlControlCharacter(name), "Expected a pipeline's name.");
