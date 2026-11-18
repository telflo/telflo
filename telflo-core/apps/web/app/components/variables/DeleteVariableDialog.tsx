import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import type { OrganizationVariable, VariableInUseDetails } from "@telflo/contracts";
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
import { deleteOrganizationVariable, getVariableDrafts } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { useOpeningReads } from "~/lib/hooks/use-opening-reads.js";
import {
  DELETE_VARIABLE_FAILED_MESSAGE,
  VARIABLE_DELETED_MESSAGE,
  VARIABLES_READ_TIMEOUT_MS,
  VARIABLES_WRITE_TIMEOUT_MS,
  variableInUseDetailsOf,
  variableRefusalMessage,
} from "~/lib/variables.js";
import { DraftsWarning, type DraftsRead } from "./DraftsWarning.js";
import { VariableInUseList } from "./InUseLists.js";
import { handleSharedWriteFailure } from "./write-failures.js";

/*
 * A variable's delete (D20 decision 6, default 21; Q102; ADR 0018): an
 * AlertDialog with "Delete" / "Deleting..." and Cancel. In detail:
 * - the title is fixed ("Delete variable"), and the variable's reference
 *   is shown inside `ph-no-capture`, never quoted in the text;
 * - the guard is the opamp-server's (409 `variable_in_use`, its uses listed
 *   as `InUseLists.tsx` says, at most 100, then "… and N more published
 *   versions"); the dialog stays open, nothing deleted;
 * - the drafts that reference the name (default 21, read as the dialog
 *   opens) are a warning only: "Drafts using OTLP_EP: edge-config";
 * - "Variable deleted" toasts a success, closes and reloads; a variable
 *   already gone toasts "Variable not found" (an error), closes and
 *   reloads the list, which no longer shows it; an unknown
 *   outcome as `write-failures.ts` says. Escape and Cancel wait while the
 *   delete runs; a double click sends once. The variable is the one the
 *   dialog opened on (D17c-1 Ruling 66).
 */

export interface DeleteVariableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  variable: OrganizationVariable | null;
  /** After the delete, a variable found gone, or an unknown outcome: the page reads its list again. */
  onChanged: () => void;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

export function DeleteVariableDialog(props: DeleteVariableDialogProps) {
  const opening = useOpeningKey(props.open);
  return <DeleteVariableSession key={opening} {...props} />;
}

function DeleteVariableSession({ open, onOpenChange, organizationId, variable: live, onChanged, onCloseAutoFocus }: DeleteVariableDialogProps) {
  const [variable] = useState(live);
  const [drafts, setDrafts] = useState<DraftsRead>({ state: "reading" });
  const [inUse, setInUse] = useState<VariableInUseDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const openingRead = useOpeningReads(open, VARIABLES_READ_TIMEOUT_MS);

  useEffect(() => {
    if (variable === null) return;
    void openingRead((signal) => getVariableDrafts(organizationId, variable.id, { signal })).then((answer) => {
      if (answer === null) return;
      setDrafts(answer.ok ? { state: "read", configurations: answer.value } : { state: "failed" });
    });
  }, [openingRead, organizationId, variable]);

  const close = () => {
    if (!deletingRef.current) onOpenChange(false);
  };

  const failed = (failure: unknown) => {
    const handled = handleSharedWriteFailure(
      failure,
      { close: () => onOpenChange(false), revalidate: () => void revalidate(), reload: onChanged, showError: setError },
      [{ code: "variable_not_found", message: "Variable not found" }],
    );
    if (handled) return;
    setInUse(variableInUseDetailsOf(failure));
    setError(variableRefusalMessage(failure, DELETE_VARIABLE_FAILED_MESSAGE));
  };

  const handleDelete = async () => {
    if (variable === null || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    setInUse(null);
    const sentIn = organizationId;
    const guard = abortAfter(VARIABLES_WRITE_TIMEOUT_MS);
    try {
      await deleteOrganizationVariable(sentIn, variable.id, { signal: guard.signal });
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
    toast.success(VARIABLE_DELETED_MESSAGE);
    onOpenChange(false);
    onChanged();
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
          <AlertDialogTitle>Delete variable</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the variable. It is refused while a published version that a collector group or a collector
            uses references it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {variable !== null && (
          <div className="ph-no-capture grid gap-3">
            <p className="break-all font-mono text-[13px] text-foreground">{`\${org:${variable.name}}`}</p>
            <DraftsWarning name={variable.name} drafts={drafts} />
            {inUse !== null && <VariableInUseList details={inUse} />}
          </div>
        )}
        <DialogErrorAlert error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog open while the delete runs; it closes itself when the API answers.
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
