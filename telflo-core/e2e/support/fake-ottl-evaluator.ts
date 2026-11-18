import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startFakeOttlEvaluator, type FakeOttlEvaluator } from "../../apps/api/src/testing/fake-ottl-evaluator.js";

// The browser tests' OTTL evaluator (D15a Task 5, Preflight ruling 28): the
// OpenAPI-checked fake from apps/api/src/testing, which
// start-fake-ottl-evaluator.ts runs as a Playwright web server. It checks
// every request the E2E API sends it, and every reply it sends, against
// services/ottl-evaluator/openapi.yaml, and answers by the request, so tests
// running in parallel each get the answer their own rules ask for: a rule
// passes by default; a marker `fake-ottl-evaluator: <marker>` in its pattern
// or in an OTTL string literal makes it fail (`fail`), err (`error`), be
// refused at Save (`invalid`), or the whole request busy (`busy`) or
// unanswered (`unavailable`) (fakeOttlEvaluatorMarker).
//
// As with the fake tester (support/fake-otelcol-testing.ts), it runs in a
// process of its own, so each violation, as the fake sees it, is written to
// stderr and appended to a file, and global-setup.ts's teardown, which runs
// before the web servers stop, fails the run if the file holds any
// (assertNoFakeOttlEvaluatorViolations).
//
// A violation names an operation, a field or a path, never a value: the
// fake's messages carry no secret, rule or output.

export interface E2eFakeOttlEvaluatorOptions {
  port: number;
  /** Emptied now; each violation is appended as one line. */
  violationsPath: string;
  /** Where each violation is also written as it is seen. Default process.stderr. */
  stderr?: { write(text: string): unknown };
}

/** Starts the fake on 127.0.0.1:`port`, recording each violation to `violationsPath` and `stderr`. */
export async function startE2eFakeOttlEvaluator(options: E2eFakeOttlEvaluatorOptions): Promise<FakeOttlEvaluator> {
  const { port, violationsPath } = options;
  const stderr = options.stderr ?? process.stderr;
  mkdirSync(dirname(violationsPath), { recursive: true });
  writeFileSync(violationsPath, "");
  return startFakeOttlEvaluator({
    port,
    onViolation(message) {
      // One violation per line, whatever the message holds.
      const line = message.replace(/\s+/g, " ");
      appendFileSync(violationsPath, `${line}\n`);
      stderr.write(`fake ottl-evaluator: contract violation: ${line}\n`);
    },
  });
}

/**
 * Throws, listing them, if the fake recorded any violation, and if the file
 * is missing (the fake never started, or something else removed it).
 */
export function assertNoFakeOttlEvaluatorViolations(violationsPath: string): void {
  let text: string;
  try {
    text = readFileSync(violationsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The fake ottl-evaluator's violations file is missing (${violationsPath}): did it start?`);
    }
    throw error;
  }
  const violations = text.split("\n").filter((line) => line !== "");
  if (violations.length > 0) {
    throw new Error(
      `The fake ottl-evaluator saw ${violations.length} contract violation(s) from the E2E API:\n${violations.join("\n")}`,
    );
  }
}
