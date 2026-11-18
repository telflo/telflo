import type { SessionBrowser, SessionSystem } from "@telflo/contracts";

/**
 * How much of a user agent the parser reads: every token it looks for sits
 * well inside it, and a longer string costs no more (Preflight ruling 17).
 */
export const USER_AGENT_PARSED_LENGTH = 512;

/** A family and the fixed tokens that name it, any one of which is enough. */
type Rule<Family> = readonly [family: Family, tokens: readonly string[]];

/**
 * Checked in order, first match wins (D21 decision 40). Edge and Opera, and
 * the Chromium family's others, carry `Chrome/` too, so they come before
 * Chrome; Chrome and Firefox on iOS, and every Chromium, carry `Safari/`, so
 * Safari comes last and needs `Version/` as well (below). `Edge/` is
 * legacy (EdgeHTML) Edge; `OPT/` (Opera Touch) and `OPiOS/` (Opera Mini) are
 * Opera on iOS, whose strings would otherwise read as Safari.
 */
const BROWSER_RULES: readonly Rule<SessionBrowser | "safari_candidate">[] = [
  ["edge", ["Edg/", "EdgA/", "EdgiOS/", "Edge/"]],
  ["opera", ["OPR/", "OPT/", "OPiOS/"]],
  ["other", ["SamsungBrowser/", "YaBrowser/", "Vivaldi/", "UCBrowser/"]],
  ["chrome", ["Chrome/", "CriOS/"]],
  ["firefox", ["Firefox/", "FxiOS/"]],
  ["safari_candidate", ["Safari/"]],
];

/**
 * Checked in order, first match wins. iOS's strings say "like Mac OS X",
 * Android's say "Linux" and ChromeOS's "X11", so each comes before the one
 * it would otherwise be mistaken for. iPadOS 13 and later sends a Mac's
 * string by default, and reads as macOS: by design, the browser says so.
 */
const SYSTEM_RULES: readonly Rule<SessionSystem>[] = [
  ["ios", ["iPhone", "iPad", "iPod"]],
  ["android", ["Android"]],
  ["chromeos", ["CrOS"]],
  ["windows", ["Windows"]],
  ["macos", ["Macintosh", "Mac OS X"]],
  ["linux", ["Linux"]],
];

function firstMatch<Family>(text: string, rules: readonly Rule<Family>[]): Family | undefined {
  for (const [family, tokens] of rules) {
    if (tokens.some((token) => text.includes(token))) return family;
  }
  return undefined;
}

/**
 * A session's user agent as the two families the sessions list shows (D21
 * decision 40): our own table of fixed tokens, plain substring tests on the
 * first 512 characters, so nothing can backtrack whatever the string. No
 * dependency: ua-parser-js v2 is AGPL (ADR 0019). Anything unrecognised,
 * no user agent included, is `other`. The raw string never leaves the API
 * and is never logged: only these two words do.
 */
export function parseUserAgent(userAgent: string | null): { browser: SessionBrowser; os: SessionSystem } {
  const text = (userAgent ?? "").slice(0, USER_AGENT_PARSED_LENGTH);
  const browser = firstMatch(text, BROWSER_RULES);
  return {
    browser:
      browser === "safari_candidate" ? (text.includes("Version/") ? "safari" : "other") : (browser ?? "other"),
    os: firstMatch(text, SYSTEM_RULES) ?? "other",
  };
}
