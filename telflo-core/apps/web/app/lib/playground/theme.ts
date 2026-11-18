import { useEffect } from "react";
import { ThemeSchema, type Theme } from "@telflo/contracts";
import { rememberTheme } from "~/lib/theme.js";

/*
 * The playground's theme (D31-1 decision 14, Ruling 277, Preflight ruling
 * 13). Its routes' `handle` is `{ theme: "remembered" }`, so root renders
 * the theme this browser was last told, as the auth screens do: the
 * remembered value, else the `telflo_theme` cookie, else the signed-out
 * default. The playground's toggle (Light, Dark, Navy) remembers its choice
 * (`rememberTheme`) and keeps it as one word in one localStorage key of the
 * playground's, read on the playground's pages on arrival. It never writes
 * the `telflo_theme` cookie, which is the API's, for signed-in people.
 * Nothing forces `dark`.
 */

/** The one key: one word, `light`, `dark` or `navy`. */
export const PLAYGROUND_THEME_KEY = "telflo-playground-theme";

/** The stored choice, or null when there is none, it isn't one of the three, or storage can't be read. */
export function readPlaygroundTheme(): Theme | null {
  try {
    const parsed = ThemeSchema.safeParse(window.localStorage.getItem(PLAYGROUND_THEME_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The toggle's choice: shown at once (root's `<html>` class follows the remembered value), and kept for the next visit. */
export function choosePlaygroundTheme(theme: Theme): void {
  rememberTheme(theme);
  try {
    window.localStorage.setItem(PLAYGROUND_THEME_KEY, theme);
  } catch {
    // Storage disabled: the choice lasts while the browser stays on the site.
  }
}

/** On a playground page's arrival, the stored choice becomes the remembered theme (an effect: never on the server). */
export function useStoredPlaygroundTheme(): void {
  useEffect(() => {
    const stored = readPlaygroundTheme();
    if (stored !== null) rememberTheme(stored);
  }, []);
}
