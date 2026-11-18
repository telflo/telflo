/**
 * Where the site is served from, for canonical links, `og:url` and JSON-LD
 * (D4 decision 5): the same TELFLO_PUBLIC_WEB_URL
 * the API builds its email links from. Without a trailing slash, so a path
 * can be appended as is.
 *
 * Read at call time, not at import, as api-client.server.ts reads its URL.
 * Unset or "" (the E2E servers' and the tests' "unset"), it is undefined,
 * and pages leave out whatever needs it.
 */
export function publicWebUrl(): string | undefined {
  const value = process.env.TELFLO_PUBLIC_WEB_URL?.trim().replace(/\/+$/, "");
  return value || undefined;
}
