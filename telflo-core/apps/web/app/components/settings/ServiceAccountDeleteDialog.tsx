import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH, type ServiceAccount } from "@telflo/contracts";
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
import { deleteServiceAccount, isSessionEnded } from "~/lib/api-client.js";
import { useStillCurrent } from "~/lib/configurations.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { isManagementLost, useLeaveManagement } from "~/lib/organizations.js";
import {
  SERVICE_ACCOUNT_DELETE_CONFIRM_WORDS,
  SERVICE_ACCOUNT_DELETE_FAILED_MESSAGE,
  SERVICE_ACCOUNT_DELETE_KEPT_WORDS,
  SERVICE_ACCOUNT_DELETED_MESSAGE,
  isServiceAccountError,
  serviceAccountDeleteTokenWords,
  serviceAccountFailureMessage,
} from "~/lib/service-accounts.js";

/*
 * Deleting a service account, from the list's row:
 *
 * - "Delete service account: {name}", the name as visible text in the
 *   masked shell; the token sentence by the listed count (none, one, more);
 *   no list of deleted things (the platform deletes nothing else); the kept
 *   work, of which configurations and their versions "still show its
 *   address as their creator" (no other screen shows a creator).
 * - "This cannot be undone. Type the account's name to confirm." labels the
 *   field (no placeholder holds the name). The field is inside
 *   `ph-no-capture` and uncontrolled: no `value` attribute ever holds the
 *   typed name. "Permanently delete" is enabled once the typed text, trimmed,
 *   equals the name.
 * - The account is the one the row held when the dialog opened (the
 *   parent's snapshot; a list's reload doesn't change it).
 * - Success toasts "Service account deleted" and reports back (the list
 *   reads again). `404 service_account_not_found` (deleted meanwhile, in
 *   another tab) toasts its fixed message and reports back too, so the
 *   dialog closes and the list reads again, as a revoke's
 *   `api_token_not_found` does. Any other refusal toasts its fixed message
 *   and keeps the dialog; a refusal saying management is lost leaves
 *   through `useLeaveManagement`. Unclosable while it deletes.
 */

export interface ServiceAccountDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  target: ServiceAccount | null;
  /** After a delete, or an account already gone (`service_account_not_found`): the dialog closes, the list reads again. */
  onDeleted: (serviceAccountId: string) => void;
}

/** Each opening is a new session: an empty field, the button disabled. */
export function ServiceAccountDeleteDialog(props: ServiceAccountDeleteDialogProps) {
  const opening = useOpeningKey(props.open);
  return <DeleteSession key={opening} {...props} />;
}

function DeleteSession({ open, onOpenChange, organizationId, target, onDeleted }: ServiceAccountDeleteDialogProps) {
  const id = useId();
  const leaveManagement = useLeaveManagement();
  const isStillCurrent = useStillCurrent(organizationId);
  const field = useRef<HTMLInputElement>(null);
  const [matches, setMatches] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const changeOpen = (next: boolean) => {
    if (!deletingRef.current) onOpenChange(next);
  };

  const confirm = async () => {
    if (target === null || deletingRef.current) return;
    if ((field.current?.value ?? "").trim() !== target.name) return;
    deletingRef.current = true;
    setDeleting(true);
    const sentIn = organizationId;
    try {
      await deleteServiceAccount(sentIn, target.id);
      if (!isStillCurrent(sentIn)) return;
      toast.success(SERVICE_ACCOUNT_DELETED_MESSAGE);
      onDeleted(target.id);
    } catch (failure) {
      if (!isStillCurrent(sentIn) || isSessionEnded(failure)) return;
      if (isManagementLost(failure)) {
        onOpenChange(false);
        leaveManagement(failure);
        return;
      }
      toast.error(serviceAccountFailureMessage(failure, SERVICE_ACCOUNT_DELETE_FAILED_MESSAGE));
      // Gone already: the row was stale.
      if (isServiceAccountError(failure, "service_account_not_found")) onDeleted(target.id);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  if (target === null) return null;
  const confirmId = `${id}-confirm`;
  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-fail">Delete service account: {target.name}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>{serviceAccountDeleteTokenWords(target.tokenCount)}</p>
              <p>{SERVICE_ACCOUNT_DELETE_KEPT_WORDS}</p>
              <p id={confirmId} className="font-medium text-fail">
                {SERVICE_ACCOUNT_DELETE_CONFIRM_WORDS}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="ph-no-capture">
          <Input
            ref={field}
            aria-labelledby={confirmId}
            maxLength={SERVICE_ACCOUNT_NAME_MAXIMUM_LENGTH}
            autoComplete="off"
            autoFocus
            readOnly={deleting}
            onInput={(event) => setMatches(event.currentTarget.value.trim() === target.name)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
            disabled={deleting || !matches}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting ? "Deleting…" : "Permanently delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
