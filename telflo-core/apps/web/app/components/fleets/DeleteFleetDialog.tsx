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
import { ApiError, deleteFleet, isSessionEnded, REQUEST_ABORTED } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";

/*
 * "Delete fleet": an AlertDialog with no typing to confirm, its
 * title and buttons ("Delete fleet", "Deleting..."). Differences:
 *
 * - The list says what the platform deletes: the fleet and its groups, its
 *   collectors and their error history, its tokens (their collectors refused,
 *   401, from their next poll); published versions stay. No word of imports.
 * - Success toasts "Deleted fleet {label}" with no counts (the platform
 *   answers 204), then `onDeleted`: the list reloads, or the fleet's page
 *   goes to the list.
 * - Escape does nothing while the delete is under way; Cancel is disabled;
 *   the action keeps the dialog open (`preventDefault`) until the API
 *   answers. The list's and the page's polls pause while it is open (an open
 *   dialog pauses `useVisiblePolling`).
 * - A 404 `fleet_not_found` counts as deleted: its message toasted, closed,
 *   `onDeleted`.
 * - The API waits up to 25 s for the opamp-server, then answers 503
 *   `fleets_unavailable` while it finishes (a repeat meanwhile answers the
 *   same 503 at once): its message toasted ("reload before trying again"),
 *   closed, `onReload` (the list reloads, the page reads the fleet again,
 *   "Fleet not found" once the delete finished). Any other unknown outcome (a
 *   5xx, no connection, a reply that doesn't parse) does the same with its
 *   words or "Failed to delete fleet", and so does the request's 35 s hang
 *   guard (above the API's 25 s), whose abort toasts the 503's words.
 * - Any other refusal (a 429 `rate_limited`, say) toasts and stays open.
 * - A 404 `organization_not_found` or a 403 `terms_acceptance_required`
 *   closes and revalidates the layout, with no message; a session ended is
 *   silent. An answer after the dialog unmounted, or for an organization no
 *   longer active, does nothing (`useStillCurrent`).
 * - Each opening is a new session (`useOpeningKey`): a write an
 *   organization switch closed the dialog on leaves no "working" state for
 *   the next opening, and its late answer does nothing.
 * The label is text only, in the masked shell; no attribute holds it.
 */

export const DELETE_FLEET_FAILED_MESSAGE = "Failed to delete fleet";

/** The delete's hang guard: above the API's own 25 s wait for the opamp-server. */
export const FLEET_DELETE_TIMEOUT_MS = 35_000;

export interface DeleteFleetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fleet: Pick<Fleet, "id" | "label"> | null;
  organizationId: string;
  /** After the delete, or a 404 for the fleet: the list reloads, or the fleet's page goes to the list. */
  onDeleted: () => void;
  /** After an answer that leaves the delete unknown (a 503, the hang guard): the list reloads, or the page reads the fleet again. */
  onReload: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the page gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: nothing of an earlier one's write (a switch closed it mid-write) carries over. */
export function DeleteFleetDialog(props: DeleteFleetDialogProps) {
  const opening = useOpeningKey(props.open);
  return <DeleteFleetSession key={opening} {...props} />;
}

function DeleteFleetSession({ open, onOpenChange, fleet, organizationId, onDeleted, onReload, onCloseAutoFocus }: DeleteFleetDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const [isDeleting, setIsDeleting] = useState(false);
  const deletingRef = useRef(false);

  const close = () => {
    if (!deletingRef.current) onOpenChange(false);
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
      toast.error(fleetRefusalMessage(failure, DELETE_FLEET_FAILED_MESSAGE));
    }
    if (isFleetGone(failure)) {
      onOpenChange(false);
      onDeleted();
      return;
    }
    if (isUnknownOutcome(failure)) {
      onOpenChange(false);
      onReload();
    }
  };

  const handleDelete = async () => {
    if (fleet === null || deletingRef.current) return;
    deletingRef.current = true;
    setIsDeleting(true);
    const sentIn = organizationId;
    const deleted = fleet;
    const guard = abortAfter(FLEET_DELETE_TIMEOUT_MS);
    try {
      await deleteFleet(sentIn, deleted.id, { signal: guard.signal });
    } catch (failure) {
      deletingRef.current = false;
      setIsDeleting(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    deletingRef.current = false;
    setIsDeleting(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(`Deleted fleet ${deleted.label}`);
    onOpenChange(false);
    onDeleted();
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
          if (isDeleting) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete fleet</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                You are permanently deleting <span className="font-medium text-foreground">{fleet?.label}</span>. This
                action cannot be undone.
              </p>
              <p>The following will be removed:</p>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>The fleet and its groups</li>
                <li>All its collectors and their error history</li>
                <li>
                  All its tokens: collectors using them are refused (401) from their next poll (allow about 10 seconds
                  more)
                </li>
              </ul>
              <p className="pt-2">
                Published versions are <span className="font-medium">not</span> deleted: they stay with their
                configurations, under Configurations.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog open while the delete runs; it closes itself when the API answers.
              event.preventDefault();
              void handleDelete();
            }}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting..." : "Delete fleet"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
