import { cliAuthUrl, newState, startLoginListener, type ListenerOutcome } from "../../apps/cli/src/login-listener.js";

// `/cli-auth`'s browser tests (D27 decision 35; Preflight ruling 17): the
// CLI's own listener, started from the spec (node's side), and the page's
// address as the CLI opens it. The listener imports only node's built-ins,
// so e2e/tsconfig.json lists its file. What it receives is a token: specs
// check it with boolean canaries only.

export interface StartedListener {
  port: number;
  state: string;
  /** The listener's answer: the token handed over, Cancel's denial, or its end. */
  answer: Promise<ListenerOutcome>;
  close(): void;
}

/** The CLI's listener on 127.0.0.1, answering only `serverOrigin`, with a fresh state. */
export async function startListener(serverOrigin: string): Promise<StartedListener> {
  const state = newState();
  const listener = await startLoginListener({ origin: serverOrigin, state });
  return { port: listener.port, state, answer: listener.answer, close: () => listener.close() };
}

/** The page's path with the listener's parameters in its fragment, as `telflo login` opens it. */
export function cliAuthPath(state: string, port: number, host: string): string {
  return cliAuthUrl("", { state, port, host });
}
