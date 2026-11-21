import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type QuickDeployLink } from "@telflo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded, revokeQuickDeployLink } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";

/*
 * Revoke: an AlertDialog, "Revoke this install link?" with its words,
 * "Cancel" / "Revoke link" ("Revoking…") and the toast "Install link
 * revoked". Its details:
 *
 * - The words say what revoking does (further downloads refused at once,
 *   installed collectors unaffected, the link kept listed and never
 *   re-enabled).
 * - It stays open until the API answers; Escape does nothing meanwhile;
 *   Cancel is disabled; a double click sends once. The `POST` runs under the
 *   write hang guard.
 * - After the revoke the tab reloads (the row reads Revoked, its Extend and
 *   Revoke gone). A 404 (the link, or the fleet) toasts the API's words,
 *   closes and reloads; an unknown outcome toasts the 503's words, closes
 *   and reloads (a revoke is idempotent). Any other refusal (a 429 with its
 *   words) toasts and stays open, else "Failed to revoke the install link".
 *   The organization's or the terms' refusal closes and revalidates the
 *   layout; a session ended is silent. Each opening is a new session
 *   (`useOpeningKey`), its link a snapshot taken at the opening; an answer
 *   after it unmounted or for an organization no longer active does
 *   nothing.
 */

export const REVOKE_LINK_WORDS =
  'Revoking stops further downloads at once: a host that runs the command afterwards gets "revoked". Collectors already installed keep running. The link stays listed for the record and can\'t be re-enabled: make a new one instead.';
/** A Helm values link's addition: a downloaded file keeps the token. */
export const REVOKE_HELM_LINK_WORDS = "A values.yaml already downloaded still holds the fleet's default token.";
export const LINK_REVOKED_MESSAGE = "Install link revoked";
export const REVOKE_LINK_FAILED_MESSAGE = "Failed to revoke the install link";

export interface RevokeInstallLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row's link, as the opening found it. */
  link: QuickDeployLink | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** After the revoke, a 404, or an unknown outcome: the tab reloads. */
  onRevoked: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: nothing of an earlier one's revoke carries over. */
export function RevokeInstallLinkDialog(props: RevokeInstallLinkDialogProps) {
  const opening = useOpeningKey(props.open);
  return <RevokeLinkSession key={opening} {...props} />;
}

function RevokeLinkSession({ open, onOpenChange, link: opened, organizationId, fleetId, onRevoked, onCloseAutoFocus }: RevokeInstallLinkDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const [link] = useState(opened);
  const [isRevoking, setIsRevoking] = useState(false);
  const revokingRef = useRef(false);

  const close = () => {
    if (!revokingRef.current) onOpenChange(false);
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    if (isSessionEnded(failure)) return;
    if ((failure instanceof ApiError && failure.code === "quick_deploy_link_not_found") || isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, REVOKE_LINK_FAILED_MESSAGE));
      onOpenChange(false);
      onRevoked();
      return;
    }
    if (isUnknownOutcome(failure)) {
      toast.error(FLEETS_UNAVAILABLE_MESSAGE);
      onOpenChange(false);
      onRevoked();
      return;
    }
    toast.error(fleetRefusalMessage(failure, REVOKE_LINK_FAILED_MESSAGE));
  };

  const handleRevoke = async () => {
    if (link === null || revokingRef.current) return;
    revokingRef.current = true;
    setIsRevoking(true);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await revokeQuickDeployLink(sentIn, fleetId, link.id, { signal: guard.signal });
    } catch (failure) {
      revokingRef.current = false;
      setIsRevoking(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    revokingRef.current = false;
    setIsRevoking(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(LINK_REVOKED_MESSAGE);
    onOpenChange(false);
    onRevoked();
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (isRevoking) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this install link?</AlertDialogTitle>
          <AlertDialogDescription>
            {REVOKE_LINK_WORDS}
            {link?.choices.kind === "helm" ? ` ${REVOKE_HELM_LINK_WORDS}` : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog open while the revoke runs; it closes itself when the API answers.
              event.preventDefault();
              void handleRevoke();
            }}
            disabled={isRevoking || link === null}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isRevoking ? "Revoking…" : "Revoke link"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
