import { matchPath, useBlocker } from "react-router";
import { toast } from "sonner";
import { flushHeldEdits } from "./held-edits.js";
import { selectIsDirty, useEditorStore } from "~/lib/stores/editor-store.js";
import type { SaveResult } from "./use-save-configuration.js";

/** The toast when "Save & Continue" couldn't save (D8 decision 15). */
export const SAVE_AND_CONTINUE_FAILED_MESSAGE = "Failed to save. Please try again.";

/**
 * The navigation guard (ADR 0018; D8 decision 15): while the editor
 * holds unsaved text, a navigation to another path in the app (a link, Back)
 * is held, and the page shows the Unsaved Changes dialog; an edit a field
 * holds is written first, so it counts (ruling 36). A change of search
 * or hash alone isn't held, at an address naming the version the editor
 * holds (D10 Ruling 27; `sameAddressHolds`). Closing or reloading the tab
 * is `beforeunload`'s, on the page; a session that ends goes to sign in
 * regardless (a loader's redirect is never blocked).
 *
 * - Cancel stays, and lets the navigation go.
 * - "Discard Changes" puts the text back to what was last loaded or saved,
 *   so the editor is clean, and goes on.
 * - "Save & Continue" saves with `save` (the page's useSaveConfiguration)
 *   and goes on once the text is saved. When it isn't, it stays, with the
 *   text. A save that said why (a refusal with its own message: deleted,
 *   another organization, too large, a character that can't be saved, or
 *   the failure message) has said enough; one that said nothing (the
 *   terms dialog opened instead) gets "Failed to save. Please try
 *   again.", so exactly one message shows. One that didn't try, because the
 *   picker's create was under way (`busy`), failed at nothing: it stays,
 *   held, and says nothing (D10 Ruling 36).
 */
/** The editor's address with a version in it (D10 decision 9). */
const VERSION_ADDRESS = "/editor/:configurationId/:versionId";

/**
 * Whether a navigation to the address the page is on (a change of search or
 * hash alone, or another history entry there) leaves the editor holding what
 * that address names, so it needn't be held (D10 Ruling 27):
 * - an address with a version names that version: it passes only when the
 *   store holds it, in either case (an address may spell a UUID in upper
 *   case). It doesn't, for a while, after a create: `adoptCreatedVersion`
 *   runs before its push, so the store holds the created version while the
 *   committed address still names the source. The picker's choice of the
 *   source then is the same address, and the page fetches the source for it
 *   (another history entry; D10 Ruling 21), so it is judged as any other
 *   navigation, by the dirty check;
 * - an address without a version (`/editor/{id}`) names whichever version
 *   the page loaded for it, until its own replace lands: the page holds it
 *   and fetches nothing again (the page's `holdsAddress`), so a change of
 *   search or hash alone there passes, as before D10. Holding it would ask
 *   about unsaved text that nothing is about to touch.
 */
function sameAddressHolds(pathname: string): boolean {
  const versionId = matchPath(VERSION_ADDRESS, pathname)?.params.versionId;
  if (versionId === undefined) return true;
  const held = useEditorStore.getState().version?.id;
  return held !== undefined && held.toLowerCase() === versionId.toLowerCase();
}

export function useNavigationGuard(save: () => Promise<SaveResult>) {
  const isSaving = useEditorStore((state) => state.isSaving);

  // Read the flag from the store at evaluation time rather than closing over
  // the rendered value: a caller that makes the editor
  // clean and navigates in the same tick (Discard, below) would otherwise be
  // judged by the render before, and held.
  //
  // An edit a field holds (held-edits) is written first (ruling 36): the
  // store reads clean until it is, and a navigation that doesn't blur the
  // field (Back, a programmatic one) would lose it. The navigation hasn't
  // happened yet, so it is written into the configuration open now. A flush
  // that throws holds the navigation: what the field held couldn't be
  // written, and leaving would lose it without a word (throwing here would
  // break the router's navigation itself).
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname && sameAddressHolds(nextLocation.pathname)) return false;
    try {
      flushHeldEdits();
    } catch {
      return true;
    }
    return selectIsDirty(useEditorStore.getState());
  });

  const handleSaveAndProceed = async () => {
    // A save already under way when the navigation was held may have made
    // the editor clean since: there is nothing left to save.
    if (selectIsDirty(useEditorStore.getState())) {
      const result = await save();
      if (!result.saved) {
        // This dialog blocks navigation, so we can't "proceed and surface the
        // error on the next screen": the person stays, with the text, and the
        // blocker stays blocked.
        if (!("busy" in result) && !result.toasted) toast.error(SAVE_AND_CONTINUE_FAILED_MESSAGE);
        return;
      }
    }
    if (blocker.state === "blocked") {
      blocker.proceed();
    }
  };

  const handleDiscardAndProceed = () => {
    // Back to the saved text and layout; never typing, so manual edit mode
    // doesn't begin on the way out.
    useEditorStore.getState().discardChanges();
    if (blocker.state === "blocked") {
      blocker.proceed();
    }
  };

  const handleCancel = () => {
    // The dialog's buttons are disabled while saving, but Escape still
    // closes it: the navigation stays held until the save answers, and
    // "Save & Continue" then goes on or stays.
    if (useEditorStore.getState().isSaving) return;
    if (blocker.state === "blocked") {
      blocker.reset();
    }
  };

  return {
    isBlocked: blocker.state === "blocked",
    isSaving,
    handleSaveAndProceed,
    handleDiscardAndProceed,
    handleCancel,
  };
}
