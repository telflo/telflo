/**
 * A run of changes to one node within this many milliseconds is one undo
 * entry. `editor-store.ts` exports it; it is a module of its own, importing
 * nothing, so the browser tests (`e2e/support/forms-page.ts`) wait on the
 * editor's own value.
 */
export const HISTORY_THROTTLE_MS = 800;
