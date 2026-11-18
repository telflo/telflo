/*
 * Held edits as a test sees them (D9b decision 2; Ruling 77): the page has
 * no use for asking whether an edit is held, only for the unload guard it
 * arms, so tests ask that guard.
 */

/**
 * Whether a field holds an edit the store doesn't have yet: closing or
 * reloading the tab would ask (held-edits' `beforeunload` listener is
 * registered while any edit is held). Only held edits guard unload in the
 * tests that use this; the page's own guard (`unsaved-guard`) isn't rendered.
 */
export function hasHeldEdits(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
