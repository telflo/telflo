import { attachMonacoAriaHost } from "./use-aria-container.js";

/**
 * Where the app shell puts the one host for every Monaco's screen-reader
 * live region (D14a Ruling 48; use-aria-container.ts), in the root route,
 * which stays mounted.
 *
 * - `ph-no-capture`: replay records a placeholder for it (ADR 0024).
 * - `aria-live="off"` (Ruling 52): a Radix modal dialog hides every other
 *   child of `<body>` from assistive technology (aria-hidden's
 *   `hideOthers`), but keeps any element carrying `aria-live`, and doesn't
 *   look inside it. This wrapper announces nothing itself; the attribute
 *   only keeps it, and the regions Monaco puts in it, audible under a
 *   dialog. Without it, a dialog opened before any Monaco existed (the
 *   paste editor, a viewer, Compare, with the YAML tab never opened) hid
 *   the wrapper, and the dialog's own editor announced into a hidden node;
 *   with a region already there, the dialog hid Monaco's alert nodes.
 *
 * Empty on the server and the client alike; the host goes in after
 * hydration, by the callback ref.
 */
export function MonacoAriaHostSlot() {
  return <div className="ph-no-capture" aria-live="off" data-monaco-aria-host-slot="" ref={attachMonacoAriaHost} />;
}
