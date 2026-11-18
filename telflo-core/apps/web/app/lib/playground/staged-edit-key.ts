/*
 * The staged playground edit's one storage key and its removal (D31-1
 * decision 36), apart from the rest of the staged-edit module so that the
 * sign-out clean-up (`lib/signed-out.ts`), which the API client reaches,
 * removes it without importing what staging and reading need (the create
 * helper, which imports the API client). `staged-edit.ts` re-exports both.
 */

/** The one key. */
export const STAGED_EDIT_KEY = "telflo-playground-staged-edit";

/** Removes the staged edit, if any. */
export function clearStagedEdit(): void {
  try {
    window.localStorage.removeItem(STAGED_EDIT_KEY);
  } catch {
    // Storage disabled: nothing was kept there.
  }
}
