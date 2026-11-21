import { useCallback } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { deleteCurrentSession, suspendSessionEndedHandler, whenRequestsInFlightSettle } from "~/lib/api-client.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { signedOutInThisBrowser } from "~/lib/signed-out.js";
import { forgetVariableGroupNames } from "~/lib/variable-group-display.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";

/** What the sidebar and the terms dialog say when logging out fails. */
export const LOGOUT_FAILED_MESSAGE = "Failed to log out";

/**
 * The longest Logout keeps the session-ended handler suspended waiting for
 * the requests in flight at its sign-out. The client sets no
 * timeout, so a read that never answers would otherwise keep it suspended
 * for the tab's life, and a session that ended later, after signing in
 * again, would go unnoticed. Generous: a stray answer slower than this is
 * not Logout's to absorb.
 */
export const LOGOUT_RELEASE_HANG_GUARD_MS = 30_000;

/**
 * Calls `release` once every request in flight now has settled, or once the
 * hang guard has passed, whichever comes first; the guard's timer goes when
 * the requests settle first.
 */
function releaseWhenRequestsInFlightSettle(release: () => void): void {
  const guard = setTimeout(release, LOGOUT_RELEASE_HANG_GUARD_MS);
  void whenRequestsInFlightSettle().then(() => {
    clearTimeout(guard);
    release();
  });
}

/**
 * Ends the signed-in session through `revoke` and forgets it in this
 * browser: Logout's clean-up, shared by Logout and Settings › Account's
 * "Sign out everywhere". Resolves false, leaving the session and the
 * stores intact, when `revoke` fails; else true, with everything below
 * done. The caller says so and moves on (Logout's toast and `/login`, or
 * Sign out everywhere's). The remembered theme stays (`lib/theme.ts`):
 * the auth screens keep showing it.
 *
 * A failed sign-out leaves the session and the store intact. A successful one
 * clears the store, and resets PostHog so the next person on this browser
 * isn't taken for this user.
 *
 * It also forgets the editor's configuration and text. The sidebar refuses
 * Logout while the editor is dirty, but the terms dialog's Cancel signs out
 * regardless: the unsaved text is lost, and the editor's navigation guard,
 * which would otherwise hold the way to `/login` over a session that is gone,
 * has nothing left to guard.
 *
 * The session-ended handler is suspended from the sign-out until every
 * request in flight when it succeeded has settled, as the accept page
 * suspends it. A read the page sent before the session was revoked can
 * answer 401 after it, or its refresh be refused; without this, the
 * handler's hard load of `/login?redirectTo=<path>` would replace Logout's
 * `/login` and its toast. Requests made after that don't count, so the next
 * session that ends, after signing in again, goes to `/login?redirectTo=…`
 * as before. A request that never settles doesn't hold it for longer than
 * LOGOUT_RELEASE_HANG_GUARD_MS. A failed sign-out releases it at once: the
 * session is still there, and a 401 from then on means it really ended.
 */
export async function signOutWith(revoke: () => Promise<unknown>): Promise<boolean> {
  const release = suspendSessionEndedHandler();
  let signedOut = false;
  try {
    await revoke();
    signedOut = true;
  } catch {
    return false;
  } finally {
    if (signedOut) releaseWhenRequestsInFlightSettle(release);
    else release();
  }
  useUserStore.getState().clear();
  useEditorStore.getState().reset();
  // The person's test files' names and heads, and the suites' and
  // definitions' names and descriptions, and the validation pipelines' names
  // and their rules' text.
  useTestingStore.getState().reset();
  useTestSuitesStore.getState().reset();
  useValidationPipelinesStore.getState().reset();
  // The organization's variables' names and descriptions for the $ picker, and a read of them in flight.
  forgetOrgVariableNames();
  // The variable groups' names the fleet screens show, and a read of them in flight.
  forgetVariableGroupNames();
  // PostHog reset, and the staged playground edit removed.
  signedOutInThisBrowser();
  return true;
}

/**
 * Logging out of this browser's session, shared by the sidebar's Logout and
 * the terms dialog's Cancel: `signOutWith` the session's own logout. A
 * failed logout resolves false so the caller can say so where the user is
 * looking: the sidebar toasts, and the modal terms dialog shows it inside
 * itself. A successful one confirms, goes to `/login`, and resolves true.
 */
export function useLogout(): () => Promise<boolean> {
  const navigate = useNavigate();
  return useCallback(async () => {
    if (!(await signOutWith(deleteCurrentSession))) return false;
    toast.success("Logged out successfully");
    navigate("/login");
    return true;
  }, [navigate]);
}
