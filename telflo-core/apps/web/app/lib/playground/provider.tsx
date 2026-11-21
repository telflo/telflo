import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SignInToSaveDialog } from "~/components/playground/SignInToSaveDialog.js";
import { SignupPromptDialog } from "~/components/playground/SignupPromptDialog.js";
import { suspendSessionEndedHandler } from "~/lib/api-client.js";
import { usePageTheme } from "~/lib/theme.js";
import { PLAYGROUND_CATALOGUE } from "./catalogue.js";
import { PlaygroundContext, type LockedAction, type PlaygroundContextValue } from "./context.js";
import { sampleVisitor } from "./sample/types.js";
import { useStoredPlaygroundTheme } from "./theme.js";

/*
 * The playground's provider, around each of the playground's pages: the
 * shell's layout, the full-screen editor and the blank public editor. It gives
 * them:
 * - the sample's visitor (`useCurrentUser()` answers it first), its theme
 *   the one on screen (`usePageTheme`: the routes' handle remembers it), so
 *   `useAppTheme` and `useEditorPreferences` follow the playground's toggle;
 * - the lock (`useLockedAction`) and the one sign-up prompt it opens,
 *   which gives the focus back on its close to the opener the caller
 *   passed (`from`), else to what had the focus when the lock was called:
 *   Radix's dialog returns it only to a `DialogTrigger`, which the prompt
 *   has none of, and Safari and Firefox on macOS never focus a button a
 *   mouse presses, so callers pass their opener;
 * - "Sign in to save", which the Save action opens;
 * - the catalog the web was built with (`useCollectorDistributions`).
 * While it is mounted the session-ended handler is suspended, as
 * `/accept-invitation` does: no playground page calls a signed-in route, so
 * none can end a session, and a reader missed by the seam would fail its
 * request here rather than send the visitor to `/login`. On arrival the
 * stored theme word becomes the remembered theme.
 *
 * It needs a data router (the page's theme reads the matches).
 */
export function PlaygroundProvider({ children }: { children: ReactNode }) {
  const theme = usePageTheme();
  const [prompt, setPrompt] = useState<{ open: boolean; action?: string }>({ open: false });
  const [signInOpen, setSignInOpen] = useState(false);

  useStoredPlaygroundTheme();
  useEffect(() => suspendSessionEndedHandler(), []);

  // The opener the prompt's close gives the focus back to: the caller's, else what had the focus.
  const promptOpener = useRef<HTMLElement | null>(null);
  const lock = useCallback<LockedAction>((action, from) => {
    const active = document.activeElement;
    promptOpener.current = from ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    setPrompt({ open: true, action });
  }, []);
  const openSignInToSave = useCallback(() => setSignInOpen(true), []);
  const visitor = useMemo(() => sampleVisitor(theme), [theme]);
  const value = useMemo<PlaygroundContextValue>(
    () => ({ visitor, lock, catalogue: PLAYGROUND_CATALOGUE, openSignInToSave }),
    [visitor, lock, openSignInToSave],
  );

  return (
    <PlaygroundContext.Provider value={value}>
      {children}
      <SignupPromptDialog
        open={prompt.open}
        // Closing keeps the words, so the closing animation doesn't change its text.
        onOpenChange={(open) => setPrompt((current) => ({ ...current, open }))}
        action={prompt.action}
        onCloseAutoFocus={(event) => {
          const to = promptOpener.current;
          promptOpener.current = null;
          // Gone or disabled since (an opener inside a dialog that closed): Radix's own close, which focuses nothing.
          if (to === null || !to.isConnected || to.matches(":disabled")) return;
          event.preventDefault();
          to.focus();
        }}
      />
      <SignInToSaveDialog open={signInOpen} onOpenChange={setSignInOpen} />
    </PlaygroundContext.Provider>
  );
}
