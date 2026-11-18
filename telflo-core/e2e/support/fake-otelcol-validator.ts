import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  startFakeOtelcolValidator,
  type FakeOtelcolValidator,
} from "../../apps/api/src/testing/fake-otelcol-validator.js";

// The browser tests' collector validator (D13b decision 17, Preflight ruling
// 20): the OpenAPI-checked fake from apps/api/src/testing, which
// start-fake-otelcol-validator.ts runs as a Playwright web server. It checks
// every request the E2E API sends it, and every reply it sends, against
// services/otelcol-validator/openapi.yaml, and answers by the text, so tests
// running in parallel each get the answer their own text asks for: valid by
// default; invalid with an error per component whose type starts with
// `unknown_`; an env_var requirement per `${env:NAME}`; 503 when the text
// holds `# fake-otelcol-validator: unavailable`.
//
// As with the fake opamp-server (support/fake-opamp-server.ts), it runs in a
// process of its own, so each violation, as the fake sees it, is written to
// stderr and appended to a file, and global-setup.ts's teardown, which runs
// before the web servers stop, fails the run if the file holds any
// (assertNoFakeOtelcolValidatorViolations).
//
// A violation names an operation, a field or a path, never a value: the
// fake's messages carry no secret or text.

export interface E2eFakeOtelcolValidatorOptions {
  port: number;
  /** Emptied now; each violation is appended as one line. */
  violationsPath: string;
  /** Where each violation is also written as it is seen. Default process.stderr. */
  stderr?: { write(text: string): unknown };
}

/** Starts the fake on 127.0.0.1:`port`, recording each violation to `violationsPath` and `stderr`. */
export async function startE2eFakeOtelcolValidator(options: E2eFakeOtelcolValidatorOptions): Promise<FakeOtelcolValidator> {
  const { port, violationsPath } = options;
  const stderr = options.stderr ?? process.stderr;
  mkdirSync(dirname(violationsPath), { recursive: true });
  writeFileSync(violationsPath, "");
  return startFakeOtelcolValidator({
    port,
    onViolation(message) {
      // One violation per line, whatever the message holds.
      const line = message.replace(/\s+/g, " ");
      appendFileSync(violationsPath, `${line}\n`);
      stderr.write(`fake otelcol-validator: contract violation: ${line}\n`);
    },
  });
}

/**
 * Throws, listing them, if the fake recorded any violation, and if the file
 * is missing (the fake never started, or something else removed it).
 */
export function assertNoFakeOtelcolValidatorViolations(violationsPath: string): void {
  let text: string;
  try {
    text = readFileSync(violationsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The fake otelcol-validator's violations file is missing (${violationsPath}): did it start?`);
    }
    throw error;
  }
  const violations = text.split("\n").filter((line) => line !== "");
  if (violations.length > 0) {
    throw new Error(
      `The fake otelcol-validator saw ${violations.length} contract violation(s) from the E2E API:\n${violations.join("\n")}`,
    );
  }
}
