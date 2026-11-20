/**
 * An emailed link's single-use token, taken out of the address bar: the
 * password reset's, in its fragment (`/reset-password#token=…`), the email
 * confirmation's, in its query (`/verify-email?token=…`), and the
 * invitation's, in its fragment (`/accept-invitation#token=…`), whose page
 * did this first and now uses this too.
 *
 * Once the visitor accepts analytics, posthog-js records `location.href`
 * whole, and keeps the first one it saw for the person. So each page takes
 * its token out of the address bar when it mounts, before root's analytics
 * effect can start PostHog (a page's effects run before root's), and keeps
 * it in `sessionStorage`: a reload of the page still has it, as it did when
 * the token stayed in the address bar, and nothing else in the tab reads it.
 */

/** Where a link carries its token. */
export type TokenPlace = "fragment" | "query";

/** Tokens `sessionStorage` refused (storage disabled, say), kept for this page's life. */
const unstoredTokens = new Map<string, string>();

/**
 * The page's token, or null when there is none. A token in the address bar
 * is stored under `storageKey`, replacing any earlier one, and removed from
 * the address bar (`replaceState`, so no history entry keeps it; the
 * router's state is kept, so its idea of this entry is unchanged). A
 * fragment naming a token goes whole; from a query only the `token`
 * parameter goes. Without one, the token stored earlier in this tab is
 * returned. Safe to call again: the second call finds the address bar clean
 * and reads the stored token.
 *
 * Only ever called in a browser.
 */
export function takeAddressBarToken(place: TokenPlace, storageKey: string): string | null {
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(place === "fragment" ? hash.slice(1) : search);
  // Naming a token at all, even an empty one, is removed.
  if (!params.has("token")) return readStoredToken(storageKey);

  const token = params.get("token") || null;
  let rest: string;
  if (place === "fragment") {
    rest = search;
  } else {
    params.delete("token");
    const query = params.toString();
    rest = (query ? `?${query}` : "") + hash;
  }
  window.history.replaceState(window.history.state, "", pathname + rest);

  if (token === null) return readStoredToken(storageKey);
  try {
    window.sessionStorage.setItem(storageKey, token);
    unstoredTokens.delete(storageKey);
  } catch {
    unstoredTokens.set(storageKey, token);
  }
  return token;
}

function readStoredToken(storageKey: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey) ?? unstoredTokens.get(storageKey) ?? null;
  } catch {
    return unstoredTokens.get(storageKey) ?? null;
  }
}

/** Forgets the stored token, once it can never work again. */
export function clearStoredToken(storageKey: string): void {
  unstoredTokens.delete(storageKey);
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing was stored.
  }
}
