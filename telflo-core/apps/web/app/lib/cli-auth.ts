/*
 * `/cli-auth`'s parts (D27 decisions 20-22; Preflight rulings 13-16): the
 * page's parameters read from its fragment, the token's name, the handoff
 * to the CLI's listener, and which addresses name the page (for LoginForm's
 * way back and for analytics' `blocked`).
 *
 * It imports nothing: analytics.ts imports it, and no module of the API
 * client's may join analytics' imports.
 *
 * The parameters travel in the fragment (`#state=…&port=…&host=…`), which no
 * access log, request log or `Referer` holds. The host is the person's
 * machine name: visible text inside `ph-no-capture` only. The state is the
 * listener's own check, never logged.
 */

/** The page's path (routes.ts). */
export const CLI_AUTH_PATH = "/cli-auth";

/** What the CLI's listener sent the browser here with (decision 20). */
export interface CliAuthParameters {
  /** 32 random bytes, base64url: 43 characters. */
  state: string;
  /** The listener's port on 127.0.0.1. */
  port: number;
  /** The machine's name, as the CLI cuts it: 1 to 32 of `[A-Za-z0-9.-]`. */
  host: string;
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PORT_PATTERN = /^[1-9][0-9]{3,4}$/;
const HOST_PATTERN = /^[A-Za-z0-9.-]{1,32}$/;
export const LISTENER_PORT_MINIMUM = 1024;
export const LISTENER_PORT_MAXIMUM = 65535;

/**
 * The parameters in `hash` (`location.hash`, its `#` or not), or null for
 * anything but exactly `state`, `port` and `host`, once each, each as the
 * CLI makes it.
 */
export function parseCliAuthFragment(hash: string): CliAuthParameters | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const names = [...params.keys()].sort();
  if (names.join(",") !== "host,port,state") return null;
  const state = params.get("state") ?? "";
  const port = params.get("port") ?? "";
  const host = params.get("host") ?? "";
  if (!STATE_PATTERN.test(state) || !PORT_PATTERN.test(port) || !HOST_PATTERN.test(host)) return null;
  const portNumber = Number(port);
  if (portNumber < LISTENER_PORT_MINIMUM || portNumber > LISTENER_PORT_MAXIMUM) return null;
  return { state, port: portNumber, host };
}

/** The start every CLI token for `host` has: what Approve revokes, exactly (decision 21). */
export function cliTokenNamePrefix(host: string): string {
  return `CLI — ${host} · `;
}

/** The new token's name: `CLI — <host> · <YYYY-MM-DD HH:MM:SS>`, UTC (at most 60 characters). */
export function cliTokenName(host: string, now: Date): string {
  return cliTokenNamePrefix(host) + now.toISOString().slice(0, 19).replace("T", " ");
}

/** How long the page waits on the listener before it shows the token to paste (Preflight ruling 11). */
export const HANDOFF_WAIT_MS = 60_000;

/** What the page posts to the listener: the token, or Cancel's answer. */
export type ListenerAnswer = { state: string; token: string } | { state: string; error: "denied" };

/**
 * Posts `answer` to the CLI's listener on `127.0.0.1:<port>`, with no
 * credentials (no cookie reaches it) and no referrer. Answers the reply's
 * status; refuses with the browser's `TypeError` when the request never got
 * an answer it may read (blocked, refused).
 */
export async function postToListener(port: number, answer: ListenerAnswer): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(answer),
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  return response.status;
}

/** `text` percent-decoded once; a malformed escape leaves it as spelt. */
function decodedOnce(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Whether a path is `path`, as React Router matches it: percent-decoded, case aside, a trailing slash or not. */
function isPath(pathname: string, path: string): boolean {
  return decodedOnce(pathname).replace(/\/+$/, "").toLowerCase() === path;
}

/** Whether `pathname` is this page's. */
export function isCliAuthPath(pathname: string): boolean {
  return isPath(pathname, CLI_AUTH_PATH);
}

/** Whether a `redirectTo` value names this page: its path, as spelt or decoded once or twice. */
export function namesCliAuth(redirectTo: string): boolean {
  const once = decodedOnce(redirectTo);
  return [redirectTo, once, decodedOnce(once)].some((spelling) => isCliAuthPath(spelling.split(/[?#]/, 1)[0] ?? ""));
}

/**
 * Whether a document's address is this page's, or `/login`'s with a
 * `redirectTo` naming it (Preflight ruling 14): PostHog never starts in
 * either, since posthog-js stores `location.href` before any `before_send`
 * and replay records the sign-in buttons' links.
 */
export function isCliAuthDocument(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (isCliAuthPath(url.pathname)) return true;
  if (!isPath(url.pathname, "/login")) return false;
  return url.search
    .slice(1)
    .split("&")
    .some((pair) => {
      const equals = pair.indexOf("=");
      const name = equals < 0 ? pair : pair.slice(0, equals);
      return decodedOnce(name).toLowerCase() === "redirectto" && equals >= 0 && namesCliAuth(pair.slice(equals + 1).replace(/\+/g, " "));
    });
}
