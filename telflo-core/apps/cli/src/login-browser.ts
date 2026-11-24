/*
 * `telflo login`'s browser flow: the listener on `127.0.0.1`, the browser
 * opened on `<server>/cli-auth#state=…&port=…&host=…` (the URL printed too),
 * and the hidden prompt open beside them for a token pasted from the page's
 * fallback or the Account page. Whichever answers first wins; the other is
 * closed (the listener stopped, the prompt closed with the terminal restored).
 *
 * The listener's endings are fixed words, exit 3: Cancel on the page, five
 * minutes without an answer. The token itself is
 * checked by `login` (its shape, then `/whoami`) whichever way it came.
 */

import { hostname } from "node:os";
import { openBrowser } from "./browser.js";
import { cliAuthUrl, newState, startLoginListener, type ListenerOutcome, type LoginListener } from "./login-listener.js";
import { EXIT, ExitError, writeErr } from "./output.js";
import { readHidden } from "./prompt.js";

/** A host name with none of the allowed characters. */
export const UNKNOWN_HOST = "unknown-host";
/** The longest host name the page shows. */
export const HOST_MAXIMUM_LENGTH = 32;

export const BROWSER_WORDS = (url: string): string => `Approve this login in your browser. If it didn't open, go to:\n  ${url}`;
export const BROWSER_PASTE_PROMPT = "Or paste a token here: ";
export const DENIED_MESSAGE = "The login was cancelled in the browser.";
export const TIMED_OUT_MESSAGE = "Timed out waiting for the browser: run telflo login again, or telflo login --no-browser.";
export const LISTENER_STOPPED_MESSAGE = "The login listener stopped: run telflo login again.";

/**
 * The machine's name as the page shows it and the token's name holds it: its
 * `[A-Za-z0-9.-]` characters, cut to 32; `unknown-host` when none is left.
 */
export function cliHost(name: string): string {
  const kept = name.replace(/[^A-Za-z0-9.-]/g, "").slice(0, HOST_MAXIMUM_LENGTH);
  return kept === "" ? UNKNOWN_HOST : kept;
}

export interface BrowserFlowParts {
  /** Opens the browser (`openBrowser`). */
  open?: (url: string) => boolean;
  /** The machine's name (`os.hostname()`). */
  machineName?: () => string;
}

type Winner = { from: "browser"; outcome: ListenerOutcome } | { from: "prompt"; token: string };

function tokenOf(outcome: ListenerOutcome): string {
  switch (outcome.kind) {
    case "token":
      return outcome.token;
    case "denied":
      throw new ExitError(DENIED_MESSAGE, EXIT.AUTH);
    case "timeout":
      throw new ExitError(TIMED_OUT_MESSAGE, EXIT.AUTH);
    // `closed` is this flow's own close, after the race: never what it waits on.
    case "closed":
      throw new ExitError(LISTENER_STOPPED_MESSAGE, EXIT.AUTH);
  }
}

/** The token from the browser's handoff or the hidden prompt, whichever comes first. */
export async function browserLoginToken(server: string, parts: BrowserFlowParts = {}): Promise<string> {
  const state = newState();
  const listener: LoginListener = await startLoginListener({ origin: server, state });
  const prompt = new AbortController();
  try {
    const host = cliHost((parts.machineName ?? hostname)());
    const url = cliAuthUrl(server, { state, port: listener.port, host });
    writeErr(BROWSER_WORDS(url));
    (parts.open ?? openBrowser)(url);
    // An empty Enter is ignored: the browser may still answer.
    const pasted = readHidden(BROWSER_PASTE_PROMPT, { signal: prompt.signal, ignoreEmpty: true });
    // The loser's refusal (the prompt closed once the browser answered) is nobody's to handle.
    pasted.catch(() => undefined);
    const winner = await Promise.race<Winner>([
      listener.answer.then((outcome) => ({ from: "browser", outcome })),
      pasted.then((token) => ({ from: "prompt", token })),
    ]);
    return winner.from === "prompt" ? winner.token : tokenOf(winner.outcome);
  } finally {
    prompt.abort();
    listener.close();
  }
}
