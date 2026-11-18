import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import type { VariableGroup, VariableGroupInUseDetails } from "@telflo/contracts";
import { DialogErrorAlert } from "~/components/fleets/DialogErrorAlert.js";
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
import { deleteVariableGroup } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { noteVariableGroupName } from "~/lib/variable-group-display.js";
import {
  DELETE_VARIABLE_GROUP_FAILED_MESSAGE,
  VARIABLE_GROUP_DELETED_MESSAGE,
  VARIABLE_GROUP_NOT_FOUND_MESSAGE,
  VARIABLES_WRITE_TIMEOUT_MS,
  hasVariableCode,
  variableGroupInUseDetailsOf,
  variableRefusalMessage,
} from "~/lib/variables.js";
import { VariableGroupInUseList } from "./InUseLists.js";
import { handleSharedWriteFailure } from "./write-failures.js";

/*
 * A variable group's delete (D20 decision 6; Q102; ADR 0018): a
 * confirmation with a fixed title ("Delete variable group", never the name)
 * and the opamp-server's guard: while a collector group or a collector uses
 * it, 409 `variable_group_in_use` lists the collector groups, at most 100,
 * then "… and N more collector groups", and the collectors it is pinned on;
 * nothing is deleted or unbound (a Parity Note). The group's name is shown
 * inside `ph-no-capture`. "Variable group deleted" toasts a success; a group
 * already gone counts as deleted; an unknown outcome as `write-failures.ts`
 * says.
 */

export interface DeleteVariableGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  variableGroup: VariableGroup | null;
  onChanged: () => void;
  /** After a success (and a group found gone): the group's page leaves for the list. */
  onDeleted?: () => void;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function DeleteVariableGroupDialog(props: DeleteVariableGroupDialogProps) {
  const opening = useOpeningKey(props.open);
  return <DeleteVariableGroupSession key={opening} {...props} />;
}

function DeleteVariableGroupSession({
  open,
  onOpenChange,
  organizationId,
  variableGroup: live,
  onChanged,
  onDeleted,
  onCloseAutoFocus,
}: DeleteVariableGroupDialogProps) {
  const [variableGroup] = useState(live);
  const [inUse, setInUse] = useState<VariableGroupInUseDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);

  const close = () => {
    if (!deletingRef.current) onOpenChange(false);
  };

  // Deleted (or found gone): the fleet screens' shared names forget it (D20 final review side 2, Minor 1).
  const gone = () => {
    if (variableGroup !== null) noteVariableGroupName(organizationId, variableGroup.id, null);
    onChanged();
    onDeleted?.();
  };

  const failed = (failure: unknown) => {
    const handled = handleSharedWriteFailure(
      failure,
      { close: () => onOpenChange(false), revalidate: () => void revalidate(), reload: onChanged, showError: setError },
      [],
    );
    if (handled) return;
    if (hasVariableCode(failure, "variable_group_not_found")) {
      toast.error(VARIABLE_GROUP_NOT_FOUND_MESSAGE);
      onOpenChange(false);
      gone();
      return;
    }
    setInUse(variableGroupInUseDetailsOf(failure));
    setError(variableRefusalMessage(failure, DELETE_VARIABLE_GROUP_FAILED_MESSAGE));
  };

  const handleDelete = async () => {
    if (variableGroup === null || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    setInUse(null);
    const sentIn = organizationId;
    const guard = abortAfter(VARIABLES_WRITE_TIMEOUT_MS);
    try {
      await deleteVariableGroup(sentIn, variableGroup.id, { signal: guard.signal });
    } catch (failure) {
      deletingRef.current = false;
      setDeleting(false);
      if (isStillCurrent(sentIn)) failed(failure);
      return;
    } finally {
      guard.clear();
    }
    deletingRef.current = false;
    setDeleting(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(VARIABLE_GROUP_DELETED_MESSAGE);
    onOpenChange(false);
    gone();
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
          if (deleting) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete variable group</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the variable group and its overrides. It is refused while a collector group or a collector uses
            it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {variableGroup !== null && (
          <div className="ph-no-capture grid gap-3">
            <p className="break-words text-[13px] font-medium text-foreground">{variableGroup.name}</p>
            {inUse !== null && <VariableGroupInUseList details={inUse} />}
          </div>
        )}
        <DialogErrorAlert error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void handleDelete();
            }}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
