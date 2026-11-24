/*
 * Runs the CLI in process, its streams a test's: stdin a stream (a pipe, or a
 * "terminal" whose raw mode is recorded), stdout and stderr collected. Test
 * support only: never built or packed. What it collects may hold a token or a
 * bearer: tests check it with boolean canaries, never by printing it.
 */

import { PassThrough } from "node:stream";
import { run } from "../src/program.js";
import type { Io } from "../src/output.js";

export interface FakeStdin extends PassThrough {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => FakeStdin;
  /** Every raw-mode change, in order (a terminal's only). */
  rawModes: boolean[];
}

/** A stdin: a pipe by default, a terminal with `tty`. Nothing is written to it until the test does. */
export function fakeStdin(options: { tty?: boolean } = {}): FakeStdin {
  const stream = new PassThrough() as FakeStdin;
  stream.rawModes = [];
  if (options.tty === true) {
    stream.isTTY = true;
    stream.setRawMode = (mode: boolean) => {
      stream.rawModes.push(mode);
      return stream;
    };
  }
  return stream;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** A pipe's whole text (ended). */
  input?: string;
  /** A stdin the test drives itself (a terminal's keys). */
  stdin?: FakeStdin;
  /** stdout is a terminal (a pipe by default). */
  stdoutTty?: boolean;
}

/** `telflo <args…>` in process: its exit code and what it wrote. */
export async function runCli(args: readonly string[], options: RunOptions = {}): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const stdin = options.stdin ?? fakeStdin();
  if (options.stdin === undefined) stdin.end(options.input ?? "");
  const io: Partial<Io> = {
    stdin,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdoutIsTty: () => options.stdoutTty === true,
  };
  const code = await run(["node", "telflo", ...args], io);
  return { code, stdout, stderr };
}
