/*
 * The server the CLI talks to (D27 decision 12): `--server <url>` (on
 * `login` only), else `TELFLO_SERVER`, else the stored server. There is no
 * default server: with none of them, `telflo login` at a terminal asks for
 * the server's URL, and every other case is a usage error saying how to
 * name one. It is reduced to an origin; a path, query, fragment or user
 * part is refused. HTTPS only, except `http://localhost`, `http://127.0.0.0/8`
 * and `http://[::1]` on any port; there is no flag to allow another
 * plain-http server. The refusals are fixed words: the typed address is
 * never echoed (a user part could hold a password).
 */

import { EXIT, ExitError } from "./output.js";

export const SERVER_NOT_A_URL_MESSAGE = "The server must be a URL such as https://telflo.example.com.";
export const SERVER_NOT_AN_ORIGIN_MESSAGE =
  "The server must be an origin only (scheme, host and port), with no path, query, fragment or user name.";
export const SERVER_NOT_HTTPS_MESSAGE =
  "The server must use https://. Plain http:// is allowed only for localhost, 127.0.0.0/8 and [::1].";

/** Hosts plain `http` is allowed for: this machine only. */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  // The URL parser has already turned every IPv4 spelling (127.1, 0x7f.1, …) into dotted decimal.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The server's origin (`https://host[:port]`, default ports dropped), or
 * an ExitError (exit 2) in fixed words.
 */
export function serverOrigin(input: string): string {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ExitError(SERVER_NOT_A_URL_MESSAGE, EXIT.USAGE);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ExitError(SERVER_NOT_A_URL_MESSAGE, EXIT.USAGE);
  // The parser drops an empty `?` or `#`, so the text is checked as typed too.
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    /[?#@]/.test(text.slice(url.protocol.length + 2))
  ) {
    throw new ExitError(SERVER_NOT_AN_ORIGIN_MESSAGE, EXIT.USAGE);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) throw new ExitError(SERVER_NOT_HTTPS_MESSAGE, EXIT.USAGE);
  return url.origin;
}

/** An environment variable, an empty one counting as unset. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** No flag, no `TELFLO_SERVER`, no stored server: the usage error's fixed words. */
export const NO_SERVER_MESSAGE = "No Telflo server is set: pass --server <url> to telflo login, or set TELFLO_SERVER.";

/**
 * The server named for a command (decision 12), as an origin: the flag
 * (login only), else `TELFLO_SERVER`, else the stored server; undefined
 * when none names one. An empty variable counts as unset.
 */
export function namedServer(flag: string | undefined, env: NodeJS.ProcessEnv, stored: string | undefined): string | undefined {
  const named = flag ?? nonEmpty(env.TELFLO_SERVER) ?? stored;
  return named === undefined ? undefined : serverOrigin(named);
}

/** The server for a command, as `namedServer` answers it; none is exit 2 (`NO_SERVER_MESSAGE`). */
export function chooseServer(flag: string | undefined, env: NodeJS.ProcessEnv, stored: string | undefined): string {
  const server = namedServer(flag, env, stored);
  if (server === undefined) throw new ExitError(NO_SERVER_MESSAGE, EXIT.USAGE);
  return server;
}
