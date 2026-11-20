import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type Fleet } from "@telflo/contracts";
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
import { ApiError, isSessionEnded, REQUEST_ABORTED, updateFleet } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";

/*
 * "Archive fleet" and "Unarchive fleet": an AlertDialog in the delete dialog's
 * markup (`DeleteConfirmationDialog.tsx`), with words that say what the server
 * does: an archived fleet's collectors are refused (403) from their next poll,
 * within the token cache's 10 seconds, and its tokens can't be rotated. Each
 * is a PATCH of the fleet's `status`, with the `DeleteConfigurationDialog`
 * pattern for a write under way:
 *
 * - "Archive" / "Archiving…", "Unarchive" / "Unarchiving…". While it is under
 *   way Cancel is disabled and Escape does nothing (an AlertDialog has no X
 *   and ignores outside clicks); the action keeps the dialog open
 *   (`preventDefault`) until the API answers.
 * - Success closes and reloads (`onChanged`): the list re-reads its pages,
 *   the fleet's page its fleet, whose badge then says so.
 * - Refusals toast. An outcome the API leaves unknown (a 503
 *   `fleets_unavailable`, a 5xx, no connection, a reply that doesn't parse)
 *   toasts and closes and reloads, as the change may have been made; the
 *   request carries the 30 s hang guard, whose abort toasts the 503's words
 *   and does the same. A 404 `fleet_not_found` toasts the API's message,
 *   closes and reloads. Any other refusal (a 429, say) toasts and stays open.
 * - A 404 `organization_not_found` or a 403 `terms_acceptance_required`
 *   closes and revalidates the layout, with no message; a session ended is
 *   silent. An answer after the dialog unmounted, or for an organization no
 *   longer active, does nothing (`useStillCurrent`).
 * - Each opening is a new session (`useOpeningKey`): a write an
 *   organization switch closed the dialog on leaves no "working" state for
 *   the next opening, and its late answer does nothing.
 * The label is text only, in the masked shell; no attribute holds it.
 */

export const UPDATE_FAILED_MESSAGE = "Failed to update fleet";

/** Which way the dialog changes the fleet's status. */
export type FleetStatusAction = "archive" | "unarchive";

const WORDS: Record<FleetStatusAction, { title: string; action: string; working: string }> = {
  archive: { title: "Archive fleet", action: "Archive", working: "Archiving…" },
  unarchive: { title: "Unarchive fleet", action: "Unarchive", working: "Unarchiving…" },
};

export interface ArchiveFleetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fleet: Pick<Fleet, "id" | "label"> | null;
  action: FleetStatusAction;
  organizationId: string;
  /** After the change, or an answer that leaves it unknown, or a 404 for the fleet: the list reloads, or the page reads the fleet again. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the page gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: nothing of an earlier one's write (a switch closed it mid-write) carries over. */
export function ArchiveFleetDialog(props: ArchiveFleetDialogProps) {
  const opening = useOpeningKey(props.open);
  return <ArchiveFleetSession key={opening} {...props} />;
}

function ArchiveFleetSession({ open, onOpenChange, fleet, action, organizationId, onChanged, onCloseAutoFocus }: ArchiveFleetDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const [working, setWorking] = useState(false);
  const workingRef = useRef(false);
  const words = WORDS[action];

  const close = () => {
    if (!workingRef.current) onOpenChange(false);
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    if (isSessionEnded(failure)) return;
    if (failure instanceof ApiError && failure.code === REQUEST_ABORTED) {
      toast.error(FLEETS_UNAVAILABLE_MESSAGE);
    } else {
      toast.error(fleetRefusalMessage(failure, UPDATE_FAILED_MESSAGE));
    }
    // It may have been made, or the fleet is gone: the list or the page shows which.
    if (isUnknownOutcome(failure) || isFleetGone(failure)) {
      onOpenChange(false);
      onChanged();
    }
  };

  const change = async () => {
    if (fleet === null || workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await updateFleet(sentIn, fleet.id, { status: action === "archive" ? "archived" : "active" }, { signal: guard.signal });
    } catch (failure) {
      workingRef.current = false;
      setWorking(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    workingRef.current = false;
    setWorking(false);
    if (!isStillCurrent(sentIn)) return;
    onOpenChange(false);
    onChanged();
  };

  const label = <span className="font-medium text-foreground">{fleet?.label}</span>;
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
          if (working) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{words.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {action === "archive" ? (
              <>
                Archive {label}? Its collectors will be refused (403) from their next poll (allow about 10 seconds more), and
                its tokens can't be rotated. You can unarchive it at any time.
              </>
            ) : (
              <>Unarchive {label}? Its collectors can connect again, and its tokens can be rotated.</>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog open while the change runs; it closes itself when the API answers.
              event.preventDefault();
              void change();
            }}
            disabled={working}
          >
            {working ? words.working : words.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
