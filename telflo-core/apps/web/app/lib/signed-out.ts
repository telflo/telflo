import { signedOutLocally } from "~/lib/analytics.js";
import { clearStagedEdit } from "~/lib/playground/staged-edit-key.js";

/**
 * What this browser forgets when its person signs out, whichever way the
 * session ended: the one place every client-side sign-out goes through.
 * - `signOutWith` (`lib/use-logout.ts`): the sidebar's Logout, the terms
 *   dialog's Cancel, Settings' "Sign out everywhere";
 * - the invitation page's own sign-out (AcceptInvitation's mismatch card);
 * - a session the server ended (the API client's session-ended path: a 401
 *   `unauthenticated`, or a refused refresh), once per ended session,
 *   suspended or not: the next person on this browser is the risk either
 *   way (Ruling 317).
 *
 * It removes the visitor's staged playground edit (D31-1 decision 4, Q211:
 * signing out removes it) and resets PostHog so the next person isn't taken
 * for this one (`signedOutLocally`, D4 decision 8, Ruling 14). The stores'
 * own clean-up stays with `signOutWith`.
 */
export function signedOutInThisBrowser(): void {
  clearStagedEdit();
  signedOutLocally();
}
