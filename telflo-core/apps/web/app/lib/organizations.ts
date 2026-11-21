import { useCallback } from "react";
import { useLocation, useNavigate, useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  ORGANIZATION_ERROR_CODES,
  type IdentityErrorCode,
  type OrganizationErrorCode,
  type SessionErrorCode,
} from "@telflo/contracts";
import { ApiError, switchOrganization } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";

/** The toast for a switch that failed. */
export const SWITCH_FAILED_MESSAGE = "Failed to switch organization";

const RATE_LIMITED: SessionErrorCode = "rate_limited";

/**
 * An invite to an address at the service accounts' domain. An identity code,
 * since registration answers it too; a code sits in one module's list only
 * (the contracts' clash tests), so it is named here.
 */
const EMAIL_RESERVED: IdentityErrorCode = "email_reserved";

/**
 * The organization error codes, the invitation mail limit's 429 and an
 * invite's reserved address.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  ...ORGANIZATION_ERROR_CODES,
  RATE_LIMITED,
  EMAIL_RESERVED,
]);

/**
 * What the user is told about a failed organization request. An API refusal
 * (one of the organization error codes, the invitation mail limit, or an
 * invite's reserved address) carries its own message, shown as is. Anything
 * else (no connection, a server error, a drifted response) gets the caller's
 * fallback.
 */
export function refusalMessage(error: unknown, fallback: string): string {
  return isRefusal(error) ? error.message : fallback;
}

/** Whether a failure is the API refusing, with one of those codes. */
export function isRefusal(error: unknown): error is ApiError {
  return error instanceof ApiError && REFUSAL_CODES.has(error.code);
}

/**
 * Switching the active organization, shared by the sidebar's popover and the
 * create dialog. While the switch is in flight the store's
 * `isSwitchingOrganization` makes the shell show a spinner in place of the
 * page.
 *
 * The switch completes first, so `/app` loads in the new organization: its navigation
 * (or, when already on `/app`, a revalidation) re-runs the layout's loader,
 * whose fresh `/me` names the new organization, and the layout re-seeds the
 * store from it. A failure toasts, with the API's refusal ("You are not an
 * active member of this organization") or "Failed to switch
 * organization", and stays where it was. The flag is
 * cleared either way. Resolves whether the switch succeeded.
 */
export function useSwitchOrganization(): (organizationId: string) => Promise<boolean> {
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const onApp = location.pathname === "/app" && location.search === "";
  const setSwitching = useUserStore((state) => state.setSwitchingOrganization);

  return useCallback(
    async (organizationId: string) => {
      setSwitching(true);
      try {
        await switchOrganization({ organizationId });
      } catch (error) {
        setSwitching(false);
        toast.error(refusalMessage(error, SWITCH_FAILED_MESSAGE));
        return false;
      }
      try {
        // Navigating to the page already shown would load nothing new.
        if (onApp) await revalidator.revalidate();
        else await navigate("/app");
      } finally {
        setSwitching(false);
      }
      return true;
    },
    [navigate, onApp, revalidator, setSwitching],
  );
}

/**
 * The refusals after which a page managing the active organization (the
 * Permissions page, and Settings' Edit and Delete dialogs) can't go on:
 * someone demoted the viewer meanwhile (`organization_admin_required`), or
 * the organization is no longer the session's active one
 * (`organization_not_found`, after a switch or a deletion in another tab).
 */
const MANAGEMENT_LOST_CODES: ReadonlySet<string> = new Set<OrganizationErrorCode>([
  "organization_admin_required",
  "organization_not_found",
]);

export function isManagementLost(error: unknown): error is ApiError {
  return error instanceof ApiError && MANAGEMENT_LOST_CODES.has(error.code);
}

/**
 * Leaves such a page after such a refusal: toasts its message and goes to
 * `/app`. None of these pages is `/app`, so the navigation re-runs the
 * signed-in layout's loader, whose fresh `/me` has the viewer's active
 * organization and role now, and the layout re-seeds the store from it: the
 * Permissions item, or the Edit button, goes when it no longer applies.
 */
export function useLeaveManagement(): (error: ApiError) => void {
  const navigate = useNavigate();
  return useCallback(
    (error: ApiError) => {
      toast.error(error.message);
      void navigate("/app");
    },
    [navigate],
  );
}
