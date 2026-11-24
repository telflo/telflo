/*
 * What the CLI writes, and how it ends.
 *
 * Exit codes: 0 OK, 1 an API or network failure, 2 a usage error, 3 an
 * authentication or access refusal, 4 a check that found a problem
 * (invalid YAML, a lint failure, a failed test). Only fixed words
 * reach the terminal: an envelope's `message` (the API's own fixed words),
 * or the CLI's. Nothing prints a request, a header, a reply body or a token.
 */

import { ApiError } from "./api-error.js";

export const EXIT = { OK: 0, API: 1, USAGE: 2, AUTH: 3, FAILED: 4 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The `code` a `--json` error carries when no envelope gave one: the exit code's name. */
const EXIT_NAMES: Readonly<Record<ExitCode, string>> = {
  0: "ok",
  1: "api_error",
  2: "usage_error",
  3: "auth_error",
  4: "check_failed",
};

/** An ending the CLI chose: fixed words and an exit code. */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    /** A stable code for `--json` (an envelope's, or the CLI's own); the exit code's name when absent. */
    readonly code?: string,
    /** The HTTP status of the API's refusal this ending rewords, for `--json`'s `status`; null when absent. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "ExitError";
  }
}

/** Where the CLI reads and writes: the process's own streams, or a test's. */
export interface Io {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether stdout is a terminal (not a pipe or a file). */
  stdoutIsTty: () => boolean;
}

const PROCESS_IO: Io = {
  stdin: process.stdin,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  stdoutIsTty: () => process.stdout.isTTY === true,
};

/** Any write failure but a closed pipe: fixed words, never the error's own text. */
export const WRITE_FAILED_MESSAGE = "error: The CLI couldn't write its output.";

/** A stream the CLI writes to, as far as `guardOutputStreams` needs one. */
interface WritableStream {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  write(text: string): unknown;
  writable?: boolean;
}

/**
 * The bin's guard on its own stdout and stderr. A closed pipe
 * (EPIPE: `telflo config list | head -1`) ends the CLI quietly with exit 0:
 * the reader took what it wanted, which is no failure (a shell's `pipefail`
 * would report 141 as one). Any other write error prints fixed words on
 * stderr when it can, and exits 1. Node's own stack is never printed.
 */
export function guardOutputStreams(
  streams: { stdout: WritableStream; stderr: WritableStream } = { stdout: process.stdout, stderr: process.stderr },
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let failed = false;
  const onError = (stream: "stdout" | "stderr") => (error: NodeJS.ErrnoException) => {
    if (failed) return;
    failed = true;
    if (error.code === "EPIPE") return exit(EXIT.OK);
    if (stream === "stdout" && streams.stderr.writable !== false) {
      try {
        streams.stderr.write(`${WRITE_FAILED_MESSAGE}\n`);
      } catch {
        // stderr is gone too: the exit code says it.
      }
    }
    exit(EXIT.API);
  };
  streams.stdout.on("error", onError("stdout"));
  streams.stderr.on("error", onError("stderr"));
}

let io: Io = PROCESS_IO;
let jsonMode = false;

/** The streams in use. */
export function getIo(): Io {
  return io;
}

/** Replaces the streams (a test's), or puts the process's back with no argument. */
export function setIo(next?: Partial<Io>): void {
  io = { ...PROCESS_IO, ...next };
}

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

function line(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** One line (or block) on stdout. */
export function writeOut(text: string): void {
  io.stdout(line(text));
}

/** One line (or block) on stderr: notes, prompts, warnings. */
export function writeErr(text: string): void {
  io.stderr(line(text));
}

/**
 * A note on stderr (a warning, a wait, a flag that did nothing): the line
 * itself, or with `--json` one JSON object a line, `{ "note": "…" }`, so
 * stderr stays JSON only (the final error is `{ "error": … }`). Every note
 * goes through here; only a person's prompts at a terminal don't.
 */
export function writeNote(text: string): void {
  writeErr(jsonMode ? JSON.stringify({ note: withoutTokens(text) }) : text);
}

/** `data` as one JSON document on stdout with `--json`, else the human rendering. */
export function emit(data: unknown, human: () => string): void {
  writeOut(jsonMode ? JSON.stringify(data, null, 2) : human());
}

/** C0 controls (U+0000-U+001F), DEL (U+007F) and C1 controls (U+0080-U+009F). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
/** The same, but for the newline: an error's words may run over several lines. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * A server's string made safe for the terminal: every C0 and C1 control
 * character and DEL removed, so a name holding an escape sequence (ESC, BEL,
 * an OSC) can't drive the terminal. For every human line holding a server
 * string (token, organization, configuration names); JSON output needs none
 * (JSON escapes them).
 */
export function terminalText(text: string): string {
  return text.replace(CONTROL_CHARACTERS, "");
}

/** A text of several lines, each through `terminalText`, its newlines and tabs kept (YAML and Markdown indent with them). */
export function terminalLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("\t").map(terminalText).join("\t"))
    .join("\n");
}

/**
 * Stored YAML on stdout (`config pull`, `flows pull`): through
 * `terminalLines` when stdout is a terminal, so another member's text
 * holding an escape sequence (concealed text, an OSC 8 link, an OSC 52
 * clipboard write) can't drive the reader's terminal; byte for byte to a
 * pipe or a file, so a redirect is the version as saved.
 */
export function writeYaml(yaml: string): void {
  getIo().stdout(getIo().stdoutIsTty() ? terminalLines(yaml) : yaml);
}

/** A fixed-width table for human output: a header, a rule, then one line per row; every cell through `terminalText`. */
export function printTable(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly string[]): string {
  const cell = (value: unknown): string => (value === null || value === undefined ? "" : terminalText(String(value)));
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => cell(row[column]).length)));
  const render = (values: readonly string[]): string =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = [render(columns), render(widths.map((width) => "-".repeat(width)))];
  for (const row of rows) lines.push(render(columns.map((column) => cell(row[column]))));
  return lines.join("\n");
}

/** What an error ends as: fixed words, an exit code, a stable code and the HTTP status when there was one. */
export interface Ending {
  message: string;
  exitCode: ExitCode;
  code: string;
  status: number | null;
}

/** Ends a sentence with a full stop unless it has one. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The fixed words a 401 adds. */
const LOGIN_AGAIN = "Run telflo login.";
/** A read-only token on a write route (403 `insufficient_access`). */
export const READ_ONLY_TOKEN_MESSAGE = "This token is read-only: it can't make changes.";
/** Anything that is neither an ExitError nor an ApiError: never its own message, which could quote anything. */
export const UNEXPECTED_FAILURE_MESSAGE = "Something went wrong in the CLI.";

/**
 * How an error ends the CLI: 401 and 403 exit 3 (a 401 adds "Run telflo
 * login."; `insufficient_access` says the token is read-only), every other
 * API error 1; an ExitError keeps its own code. Any other error is fixed
 * words, exit 1: its message is never shown.
 */
export function endingOf(error: unknown): Ending {
  if (error instanceof ExitError) {
    return { message: error.message, exitCode: error.exitCode, code: error.code ?? EXIT_NAMES[error.exitCode], status: error.status ?? null };
  }
  if (error instanceof ApiError) {
    const status = error.status;
    const code = error.code ?? EXIT_NAMES[EXIT.API];
    if (status === 401) return { message: `${sentence(error.message)} ${LOGIN_AGAIN}`, exitCode: EXIT.AUTH, code, status };
    if (status === 403) {
      const message = error.code === "insufficient_access" ? READ_ONLY_TOKEN_MESSAGE : error.message;
      return { message, exitCode: EXIT.AUTH, code, status };
    }
    return { message: error.message, exitCode: EXIT.API, code, status };
  }
  return { message: UNEXPECTED_FAILURE_MESSAGE, exitCode: EXIT.API, code: EXIT_NAMES[EXIT.API], status: null };
}

/**
 * Writes an error's ending to stderr (`{ "error": { code, message, status } }`
 * with `--json`) and returns its exit code. Every message goes through
 * `withoutTokens` (an envelope quoting a bearer, an origin typed from a
 * token), and the human line loses its control characters.
 */
export function reportError(error: unknown): ExitCode {
  const ending = endingOf(error);
  const message = withoutTokens(ending.message);
  if (jsonMode) {
    writeErr(JSON.stringify({ error: { code: withoutTokens(ending.code), message, status: ending.status } }));
  } else {
    writeErr(`error: ${message.replace(CONTROL_CHARACTERS_BUT_NEWLINE, "")}`);
  }
  return ending.exitCode;
}

/** A `tf_` token anywhere in a text, replaced: for text the CLI didn't write itself (commander's own messages, every error). */
export function withoutTokens(text: string): string {
  return text.replace(/tf_[A-Za-z0-9_-]+/g, "tf_…");
}
