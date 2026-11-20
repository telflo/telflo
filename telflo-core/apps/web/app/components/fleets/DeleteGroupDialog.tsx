import { useId, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type CollectorGroup, type FleetType } from "@telflo/contracts";
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
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, deleteCollectorGroup, isSessionEnded } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { helmUninstallOf } from "~/lib/kubernetes-groups.js";
import { GROUP_NOT_FOUND_MESSAGE } from "./GroupDialog.js";
import { HelmUninstall } from "./HelmUninstall.js";

/*
 * A group's delete, both fleet types': an AlertDialog with the title
 * `Delete {name}`, "Delete" / "Deleting..." and Cancel, with
 * `DeleteCollectorDialog`'s pattern for a write under way. Differences:
 *
 * - The body says what the delete does: the group and its collectors'
 *   records go; a collector installed into it that is still running keeps
 *   its configuration and is refused from then on, while one moved into it
 *   from another group rejoins the group it was installed into (its install
 *   names that group); a Kubernetes fleet's adds the Helm release's
 *   uninstall. The Default group has no Delete (the tabs offer none, and
 *   the API refuses it).
 * - The delete is confirmed by typing the group's name ("Type {name} to
 *   confirm", the name bold with its white space kept): Delete is disabled
 *   until the typed text, with ASCII white space stripped from its ends (never
 *   `trim()`, which would strip a U+FEFF a name may hold at its ends; a name
 *   never starts or ends with a space: the contract refuses one), equals the
 *   name exactly, and the handler checks it again. The input is uncontrolled
 *   (no `value` attribute ever holds the text) and inside `ph-no-capture` (the
 *   typed text is configuration text), empty at each opening, with no
 *   placeholder. The label, the name's text in it, sits inside `ph-no-capture`
 *   with the input; it stays the input's accessible name, which so holds the
 *   name as label text (the privacy rule allows visible text; no attribute
 *   holds it).
 * - Escape does nothing while the delete is under way; Cancel is disabled;
 *   the action keeps the dialog open until the API answers. A double click
 *   sends once.
 * - "Group deleted" toasts a success, closes, and reloads the tab and the
 *   fleet. A 404 `collector_group_not_found` counts as deleted: "Group not
 *   found" toasted, closed, reloaded. A 404 `fleet_not_found` toasts the
 *   API's words, closes and reloads (the page then shows "Fleet not found").
 * - An unknown outcome (a 5xx, no connection, a reply that doesn't parse,
 *   the 30 s hang guard) toasts the 503's words, closes and reloads. Any
 *   other refusal (a 429 with its words, say) toasts and stays open, else
 *   "Failed to delete group".
 * - The organization's or the terms' refusal closes and revalidates the
 *   layout; a session ended is silent. An answer after the dialog unmounted,
 *   or for an organization no longer active, does nothing; each opening is
 *   a new session (`useOpeningKey`).
 * - A Kubernetes fleet's: after GROUP_DELETE_HELM, the group's quoted
 *   `helm uninstall` (its settings as the opening found them) in a copy box
 *   outside the description; none when its settings can't be read.
 * The name is text only, in the masked shell; no attribute holds it, nor the
 * typed text.
 */

export const DELETE_GROUP_FAILED_MESSAGE = "Failed to delete group";

/** The body, both fleet types: what the delete does to the group and its collectors (installed into it, or moved in). */
export const GROUP_DELETE_CONSEQUENCES =
  "This deletes the group and its collectors' records. A collector installed into it that is still running keeps the configuration it has, but the fleet refuses its connections from then on: uninstall it, or reinstall it into another group. A collector moved into it from another group rejoins the group it was installed into.";
/** A Kubernetes fleet's addition. */
export const GROUP_DELETE_HELM = "Uninstall the group's Helm release in your cluster.";
/** The confirm label's words around the group's name, shown bold between them. */
export const GROUP_DELETE_CONFIRM_BEFORE = "Type";
export const GROUP_DELETE_CONFIRM_AFTER = "to confirm";

/** The confirm label as text: the input's accessible name. */
export function groupDeleteConfirmLabel(name: string): string {
  return `${GROUP_DELETE_CONFIRM_BEFORE} ${name} ${GROUP_DELETE_CONFIRM_AFTER}`;
}

/** ASCII white space at either end: tab, line feed, carriage return, space. */
const ASCII_SPACE_AT_ENDS = /^[\t\n\r ]+|[\t\n\r ]+$/g;

/** Whether the typed text confirms the group's name: exact, but for ASCII white space at its ends. */
export function confirmsGroupName(typed: string, name: string): boolean {
  return typed.replace(ASCII_SPACE_AT_ENDS, "") === name;
}

export interface DeleteGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: CollectorGroup | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** After the delete, a 404, or an unknown outcome: the tab reloads, and the fleet. */
  onDeleted: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
  /** The fleet's type: a Kubernetes fleet's body adds GROUP_DELETE_HELM. */
  fleetType?: FleetType | undefined;
}

/** Each opening is a new session: nothing of an earlier one's write carries over. */
export function DeleteGroupDialog(props: DeleteGroupDialogProps) {
  const opening = useOpeningKey(props.open);
  return <DeleteGroupSession key={opening} {...props} />;
}

function DeleteGroupSession({
  open,
  onOpenChange,
  group,
  organizationId,
  fleetId,
  onDeleted,
  onCloseAutoFocus,
  fleetType = "server",
}: DeleteGroupDialogProps) {
  const confirmId = useId();
  // The typed text, as state for the button and read again from the input in the handler: the input is
  // uncontrolled, so no `value` attribute ever holds it.
  const confirmInput = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [uninstall] = useState(() => (fleetType === "kubernetes-supervisor" && group !== null ? helmUninstallOf(group) : null));
  const confirmed = group !== null && confirmsGroupName(typed, group.name);
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
    if (failure instanceof ApiError && failure.code === "collector_group_not_found") {
      toast.error(GROUP_NOT_FOUND_MESSAGE);
      onOpenChange(false);
      onDeleted();
      return;
    }
    if (isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, DELETE_GROUP_FAILED_MESSAGE));
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
    toast.error(fleetRefusalMessage(failure, DELETE_GROUP_FAILED_MESSAGE));
  };

  const handleDelete = async () => {
    if (group === null || deletingRef.current || !confirmsGroupName(confirmInput.current?.value ?? "", group.name)) return;
    deletingRef.current = true;
    setIsDeleting(true);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await deleteCollectorGroup(sentIn, fleetId, group.id, { signal: guard.signal });
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
    toast.success("Group deleted");
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
          <AlertDialogTitle>Delete {group?.name}</AlertDialogTitle>
          <AlertDialogDescription>
            {GROUP_DELETE_CONSEQUENCES}
            {fleetType === "kubernetes-supervisor" && ` ${GROUP_DELETE_HELM}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {uninstall !== null && <HelmUninstall commands={[uninstall]} />}
        <div className="ph-no-capture grid gap-2">
          <Label htmlFor={confirmId} className="font-normal leading-snug">
            {GROUP_DELETE_CONFIRM_BEFORE} <span className="whitespace-pre-wrap break-words font-bold">{group?.name}</span>{" "}
            {GROUP_DELETE_CONFIRM_AFTER}
          </Label>
          <Input
            ref={confirmInput}
            id={confirmId}
            onChange={(event) => setTyped(event.target.value)}
            disabled={isDeleting}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog open while the delete runs; it closes itself when the API answers.
              event.preventDefault();
              void handleDelete();
            }}
            disabled={isDeleting || !confirmed}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
