import { useSyncExternalStore } from "react";
import { useMatches, useRouteLoaderData } from "react-router";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse, type Theme } from "@telflo/contracts";
import { usePlaygroundVisitor } from "~/lib/playground/context.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";

/**
 * The app's theme on every page. `<html>`'s class is in the server's HTML,
 * so there is no script and no flash: root's `Layout` picks the theme from
 * the matched routes (`usePageTheme`), and the Toaster takes the same.
 * Nothing here touches browser storage.
 */

/** The theme's class: Light no class, Dark `dark`, Navy `dark navy`. */
export function themeClassName(theme: Theme): string {
  switch (theme) {
    case "light":
      return "";
    case "dark":
      return "dark";
    case "navy":
      return "dark navy";
  }
}

/**
 * A route's `handle` that marks it as one of the seven auth screens: it
 * renders the theme this browser was last told (`pageTheme`'s third row).
 */
export type ThemeHandle = { theme: "remembered" };

function remembersTheme(handle: unknown): boolean {
  return typeof handle === "object" && handle !== null && (handle as Partial<ThemeHandle>).theme === "remembered";
}

// The remembered value: the theme the signed-in layout last rendered, kept
// for the auth screens after a client-side navigation (Logout's way to
// /login included). A module value on the client alone: it is written only
// from effects, never during a render, and a server render reads null
// (the server snapshot), so it never carries one request's theme into
// another's and never makes hydration differ from the server's HTML.
let remembered: Theme | null = null;
const listeners = new Set<() => void>();

/** Remembers `theme` for the auth screens. Call it from an effect; never on the server. */
export function rememberTheme(theme: Theme): void {
  if (typeof document === "undefined" || remembered === theme) return;
  remembered = theme;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The remembered theme, or null when there is none. Null during a server
 * render and during hydration too (the server snapshot): the null is what
 * keeps the hydrating render equal to the server's HTML, so it is
 * load-bearing, not a fallback.
 */
export function useRememberedTheme(): Theme | null {
  return useSyncExternalStore(
    subscribe,
    () => remembered,
    () => null,
  );
}

/**
 * The theme a signed-in page renders (`pageTheme`'s first row): the user
 * store's, once the store holds this user (Appearance's optimistic choice
 * included), else the stored theme from the layout's `/me`. The store is empty
 * on the server and while hydrating (it is seeded in an effect), so both
 * render the stored theme. Null when there is no signed-in user. Reads no
 * router hook.
 */
export function useSignedInTheme(currentUser: CurrentUserResponse | null): Theme | null {
  const userId = currentUser?.user.id;
  const fromStore = useUserStore((state) =>
    userId !== undefined && state.current?.user.id === userId ? state.current.preferences.theme : null,
  );
  return currentUser === null ? null : (fromStore ?? currentUser.preferences.theme);
}

/**
 * The signed-in theme for components that sit only under the signed-in layout
 * and render outside any router, such as every Monaco: the user store's, or
 * contracts' default before the store is seeded. Inside the playground, the
 * visitor's (the theme on screen), so Monaco follows the playground's toggle.
 * Reads no router hook.
 */
export function useAppTheme(): Theme {
  const visitor = usePlaygroundVisitor();
  const stored = useUserStore((state) => state.current?.preferences.theme ?? DEFAULT_USER_PREFERENCES.theme);
  return visitor?.preferences.theme ?? stored;
}

/** What `pageTheme`'s table reads, gathered by `usePageTheme`. */
export type PageThemeInputs = {
  /** The signed-in layout's status, when the page is under it and its loader answered. */
  layout: AppLayoutData["status"] | undefined;
  /** `useSignedInTheme`'s answer: null unless `layout` is `signed_in`. */
  signedIn: Theme | null;
  /** Whether a matched route's handle is `{ theme: "remembered" }`. */
  remembers: boolean;
  /** Root's loader's `telflo_theme` theme; undefined when root's loader didn't answer. */
  cookie: Theme | undefined;
  /** `useRememberedTheme`'s answer: null on the server and while hydrating. */
  remembered: Theme | null;
};

/**
 * The page's theme, by this table. The same inputs give the server's column
 * and the client's: on the server and while hydrating, the remembered value
 * is null and the store empty.
 *
 * - Under the signed-in layout, `signed_in`: the signed-in theme.
 * - Under it, `refresh_needed` (the blank placeholder): the cookie's, until
 *   the client loader's `/me` answers and the layout is `signed_in`.
 * - An auth screen: the remembered value, else the cookie's; an error
 *   thrown on it too, since its route is still matched.
 * - Anything else (a 404, a failed layout loader): `dark`.
 */
export function pageTheme({ layout, signedIn, remembers, cookie, remembered }: PageThemeInputs): Theme {
  if (layout === "signed_in" && signedIn !== null) return signedIn;
  if (layout === "refresh_needed") return cookie ?? DEFAULT_USER_PREFERENCES.theme;
  if (remembers) return remembered ?? cookie ?? DEFAULT_USER_PREFERENCES.theme;
  return "dark";
}

/** Root's loader data, as far as the theme reads it. */
type RootThemeData = { theme: Theme };

/**
 * The theme this page renders: root's `Layout` puts its class on `<html>`,
 * and the Toaster follows it. Reads the matches, root's loader data and the
 * signed-in layout's, all safe on the server, on the client and around the
 * error boundary. Only inside a data router.
 */
export function usePageTheme(): Theme {
  const matches = useMatches();
  const cookie = useRouteLoaderData<RootThemeData>("root")?.theme;
  const layoutData = useRouteLoaderData<AppLayoutData>("routes/app-layout");
  const signedIn = useSignedInTheme(layoutData?.status === "signed_in" ? layoutData.currentUser : null);
  const remembered = useRememberedTheme();
  return pageTheme({
    layout: layoutData?.status,
    signedIn,
    remembers: matches.some((match) => remembersTheme(match.handle)),
    cookie,
    remembered,
  });
}
