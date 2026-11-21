import { createContext, useContext } from "react";
import type { CollectorDistribution } from "@telflo/contracts";
import type { StoredCurrentUser } from "~/lib/stores/user-store.js";

/*
 * The playground's context. `PlaygroundProvider` (./PlaygroundProvider.tsx)
 * gives it to the playground's pages: the shell's, the full-screen editor and
 * the blank public editor. Outside them it is null, and every hook here
 * answers what a signed-in page always had: no visitor, no lock, no static
 * catalog.
 *
 * This module holds no component and imports nothing heavy, so the
 * signed-in hooks that read it (`useCurrentUser`, `useAppTheme`,
 * `useEditorPreferences`, `useCollectorDistributions`) stay as light as
 * they were.
 */

export interface PlaygroundContextValue {
  /**
   * The sample workspace's visitor, in `/me`'s shape: the sample's
   * organization (`SAMPLE_ORGANIZATION_ID`), its preferences the theme on
   * screen and the defaults. `useCurrentUser()` answers it first, so a
   * signed-in visitor's real organization never reaches a reused reader.
   */
  visitor: StoredCurrentUser;
  /**
   * Opens the sign-up prompt, "To {words}, create a free account."
   * (`useLockedAction`); its close gives the focus back to `from`, the
   * control that opened it.
   */
  lock: LockedAction;
  /**
   * The collector catalog as the web was built with it: what
   * `useCollectorDistributions()` answers here, so no catalog request is
   * made.
   */
  catalogue: CollectorDistribution[];
  /** Opens "Sign in to save" (the Save action's second step; `useStagePlaygroundSave`). */
  openSignInToSave: () => void;
}

/**
 * The lock's function: `words` complete the prompt's sentence; `from` is the
 * opener the focus goes back to when the prompt closes (the button pressed,
 * `event.currentTarget`, or the opener's ref when it is gone by then).
 */
export type LockedAction = (words: string, from?: HTMLElement | null) => void;

export const PlaygroundContext = createContext<PlaygroundContextValue | null>(null);

/** The playground's context, or null outside the playground. */
export function usePlayground(): PlaygroundContextValue | null {
  return useContext(PlaygroundContext);
}

/** The sample's visitor inside the playground; null everywhere else. */
export function usePlaygroundVisitor(): StoredCurrentUser | null {
  return useContext(PlaygroundContext)?.visitor ?? null;
}

/**
 * The lock: outside the playground null, so the action runs as always;
 * inside, a function that opens the one sign-up prompt with the action's
 * words ("To {words}, create a free account."). Every locked control asks at
 * its button, passing itself as the opener the prompt's close gives the focus
 * back to:
 *
 *   const locked = useLockedAction();
 *   onClick={(event) => (locked ? locked("delete a configuration", event.currentTarget) : openDelete())}
 *
 * The opener is given explicitly because Safari, and Firefox on macOS,
 * never focus a button a mouse presses. The words are fixed text, never a
 * name or anything typed.
 */
export function useLockedAction(): LockedAction | null {
  return useContext(PlaygroundContext)?.lock ?? null;
}
