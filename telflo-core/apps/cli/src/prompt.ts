/*
 * Reading from the person at the terminal (D27 decision 19): the hidden
 * prompt for a token, a visible line for a choice, and one line from a
 * stdin that isn't a terminal.
 *
 * The hidden prompt puts the terminal in raw mode and echoes nothing (not
 * even a star). Enter ends it; Backspace removes a character; Ctrl-C and
 * Ctrl-D stop it. Every way out puts the terminal back as it was. Prompts go
 * to stderr, so stdout stays the command's output.
 */

import { EXIT, ExitError, getIo, writeErr } from "./output.js";

/** The longest token line the CLI reads: anything longer isn't a token. */
export const MAXIMUM_LINE_BYTES = 4096;

export const CANCELLED_MESSAGE = "Cancelled.";
export const NOTHING_ENTERED_MESSAGE = "Nothing was entered.";
export const LINE_TOO_LONG_MESSAGE = `The input is longer than ${MAXIMUM_LINE_BYTES} bytes.`;

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACES = new Set(["\u007f", "\b"]);

type Input = ReturnType<typeof getIo>["stdin"];

/** Whether the CLI's stdin is a terminal. */
export function stdinIsTerminal(): boolean {
  return getIo().stdin.isTTY === true;
}

/**
 * A hidden answer at the terminal: `question` on stderr, nothing echoed.
 * Ctrl-C is exit 3 ("Cancelled."), Ctrl-D before anything is typed exit 2;
 * either way the terminal is restored. `signal` closes the prompt from
 * outside (the browser flow answered first: decision 19), the terminal
 * restored and the promise refused as a Ctrl-C would be. `ignoreEmpty`: an
 * Enter with nothing typed (or only spaces) is ignored and the prompt keeps
 * waiting (the browser flow's, where the browser may still answer: an
 * empty Enter must not end the login); Ctrl-D and a closed stdin still end it.
 */
export function readHidden(question: string, options: { signal?: AbortSignal; ignoreEmpty?: boolean } = {}): Promise<string> {
  const stdin = getIo().stdin;
  const { signal, ignoreEmpty = false } = options;
  getIo().stderr(question);
  return new Promise<string>((resolve, reject) => {
    let typed = "";
    const raw = typeof stdin.setRawMode === "function";
    const finish = (outcome: () => void): void => {
      signal?.removeEventListener("abort", onAbort);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (raw) stdin.setRawMode?.(false);
      stdin.pause();
      getIo().stderr("\n");
      outcome();
    };
    const onEnd = (): void => finish(() => (typed === "" ? reject(new ExitError(NOTHING_ENTERED_MESSAGE, EXIT.USAGE)) : resolve(typed)));
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === CTRL_C) return finish(() => reject(new ExitError(CANCELLED_MESSAGE, EXIT.AUTH)));
        if ((character === "\r" || character === "\n") && ignoreEmpty && typed.trim() === "") {
          typed = "";
          continue;
        }
        if (character === "\r" || character === "\n" || character === CTRL_D) return onEnd();
        if (BACKSPACES.has(character)) typed = typed.slice(0, -1);
        else if (Buffer.byteLength(typed) < MAXIMUM_LINE_BYTES) typed += character;
      }
    };
    const onAbort = (): void => finish(() => reject(new ExitError(CANCELLED_MESSAGE, EXIT.AUTH)));
    if (raw) stdin.setRawMode?.(true);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.resume();
    if (signal?.aborted === true) onAbort();
  });
}

/** One line from `stdin` (a pipe, a file): at most 4 KiB, the newline dropped. Exit 2 for nothing or too much. */
export function readLine(stdin: Input = getIo().stdin): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const finish = (outcome: () => void): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      stdin.pause();
      outcome();
    };
    const settle = (): void => {
      const newline = buffered.indexOf(0x0a);
      const end = newline === -1 ? buffered.length : newline;
      if (end > MAXIMUM_LINE_BYTES) return finish(() => reject(new ExitError(LINE_TOO_LONG_MESSAGE, EXIT.USAGE)));
      const text = buffered.subarray(0, end).toString("utf8").replace(/\r$/, "");
      finish(() => (text.trim() === "" ? reject(new ExitError(NOTHING_ENTERED_MESSAGE, EXIT.USAGE)) : resolve(text)));
    };
    const onData = (chunk: Buffer | string): void => {
      buffered = Buffer.concat([buffered, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (buffered.includes(0x0a) || buffered.length > MAXIMUM_LINE_BYTES) settle();
    };
    const onEnd = (): void => settle();
    const onError = (): void => finish(() => reject(new ExitError(NOTHING_ENTERED_MESSAGE, EXIT.USAGE)));
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

/** A visible answer at the terminal (a number from a list): `question` on stderr. */
export async function ask(question: string): Promise<string> {
  writeErr(question);
  return readLine();
}
