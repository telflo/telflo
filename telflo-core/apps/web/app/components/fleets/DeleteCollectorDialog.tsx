import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type Collector, type CollectorGroup, type FleetType } from "@telflo/contracts";
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
import { ApiError, deleteCollector, isSessionEnded } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { helmUninstallOf } from "~/lib/kubernetes-groups.js";
import { COLLECTOR_NOT_FOUND_MESSAGE } from "./CollectorDetailsDialog.js";
import { COLLECTOR_UNINSTALL_WORDS, HelmUninstall } from "./HelmUninstall.js";

/*
 * "Delete collector record": an AlertDialog, its title, "Delete" /
 * "Deleting...", the fallback "Failed to delete collector" and the toast
 * `Deleted record for {name}`, with `DeleteFleetDialog`'s pattern for a write
 * under way.
 *
 * - The body says what a deleted collector becomes if it keeps polling.
 * - Escape does nothing while the delete is under way; Cancel is disabled;
 *   the action keeps the dialog open (`preventDefault`) until the API
 *   answers. A double click sends once.
 * - A 404 `collector_not_found` counts as deleted: "Collector not found"
 *   toasted, closed, reloaded. A 404 `fleet_not_found` toasts the API's
 *   words (`fleetRefusalMessage`), closes and reloads (the grid then shows "Fleet not found").
 * - An unknown outcome (a 5xx, no connection, a reply that doesn't parse,
 *   the 30 s hang guard `FLEET_WRITE_TIMEOUT_MS`) toasts the 503's words,
 *   closes and reloads. Any other refusal (a 429, say) toasts and stays
 *   open.
 * - The organization's or the terms' refusal closes and revalidates the
 *   layout; a session ended is silent. An answer after the dialog unmounted,
 *   or for an organization no longer active, does nothing; each opening is
 *   a new session (`useOpeningKey`).
 * - A collector naming no group is refused, so the body names no default
 *   group. On a Kubernetes-supervisor fleet the body is a pod's: deleting
 *   the record forgets the collector, and a pod still running enrolls again
 *   (then how to stop it, its group's quoted `helm uninstall` from the
 *   tab's groups, snapshotted at the opening; nothing when the groups are
 *   unread, its group isn't among them or its settings can't be read).
 * The name is text only, in the masked shell; no attribute holds it.
 */

export const DELETE_COLLECTOR_FAILED_MESSAGE = "Failed to delete collector";

/** What follows the name in the body (no "(else Default)"). */
export const COLLECTOR_DELETE_CONSEQUENCES =
  "If the collector keeps polling, it enrolls again as a new collector: in the group it was installed into, unpinned, with no error history, and it is sent that group's published version if it has one. If that group has been deleted, it can't enroll again.";

/** A Kubernetes fleet's body around the name. */
export const KUBERNETES_COLLECTOR_DELETE_BEFORE = "Deleting the record just forgets";
export const KUBERNETES_COLLECTOR_DELETE_AFTER = ": a pod still running enrolls again on its next poll.";

export interface DeleteCollectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collector: Collector | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The fleet's type: a Kubernetes fleet's body is a pod's. */
  fleetType?: FleetType;
  /** The tab's groups (null while unread): a Kubernetes fleet's uninstall line names the collector's group's release. */
  groups?: readonly CollectorGroup[] | null | undefined;
  /** After the delete, a 404, or an unknown outcome: the grid reloads its page and the fleet. */
  onDeleted: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the host gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: nothing of an earlier one's write carries over. */
export function DeleteCollectorDialog(props: DeleteCollectorDialogProps) {
  const opening = useOpeningKey(props.open);
  return <DeleteCollectorSession key={opening} {...props} />;
}

function DeleteCollectorSession({
  open,
  onOpenChange,
  collector,
  organizationId,
  fleetId,
  fleetType = "server",
  groups = null,
  onDeleted,
  onCloseAutoFocus,
}: DeleteCollectorDialogProps) {
  const { revalidate } = useRevalidator();
  // The group's uninstall as the opening found it (a snapshot: a poll behind the dialog changes nothing in it).
  const [uninstall] = useState(() => {
    if (fleetType !== "kubernetes-supervisor" || collector === null || groups === null) return null;
    const group = groups.find((each) => each.id === collector.groupId);
    return group === undefined ? null : helmUninstallOf(group);
  });
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
    if (failure instanceof ApiError && failure.code === "collector_not_found") {
      toast.error(COLLECTOR_NOT_FOUND_MESSAGE);
      onOpenChange(false);
      onDeleted();
      return;
    }
    if (isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, DELETE_COLLECTOR_FAILED_MESSAGE));
      onOpenChange(false);
      onDeleted();
      return;
    }
    if (isUnknownOutcome(failure)) {
      toast.error(FLEETS_UNAVAILABLE_MESSAGE);
      onOpenChange(false);
      onDeleted();
      return;
    }
    toast.error(fleetRefusalMessage(failure, DELETE_COLLECTOR_FAILED_MESSAGE));
  };

  const handleDelete = async () => {
    if (collector === null || deletingRef.current) return;
    deletingRef.current = true;
    setIsDeleting(true);
    const sentIn = organizationId;
    const deleted = collector;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await deleteCollector(sentIn, fleetId, deleted.id, { signal: guard.signal });
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
    toast.success(`Deleted record for ${deleted.name}`);
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
          <AlertDialogTitle>Delete collector record</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {fleetType === "kubernetes-supervisor" ? (
                <p>
                  {KUBERNETES_COLLECTOR_DELETE_BEFORE} <span className="font-medium text-foreground">{collector?.name}</span>
                  {KUBERNETES_COLLECTOR_DELETE_AFTER}
                </p>
              ) : (
                <p>
                  You are deleting the record of <span className="font-medium text-foreground">{collector?.name}</span>.{" "}
                  {COLLECTOR_DELETE_CONSEQUENCES}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {uninstall !== null && <HelmUninstall words={COLLECTOR_UNINSTALL_WORDS} commands={[uninstall]} />}
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
            {isDeleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
