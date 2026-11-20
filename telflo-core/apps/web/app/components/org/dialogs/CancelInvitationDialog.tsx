import { useState } from "react";
import { toast } from "sonner";
import type { Invitation } from "@telflo/contracts";
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
import { cancelInvitation } from "~/lib/api-client.js";
import { isManagementLost, isRefusal, refusalMessage, useLeaveManagement } from "~/lib/organizations.js";

/*
 * Cancelling an invitation. Cancelling revokes the invitation, so its link
 * stops working; the row stays for the audit trail.
 *
 * The dialog stays open, showing "Cancelling...", until the API answers,
 * and a refusal keeps it open, as the Remove Member dialog does.
 */

interface CancelInvitationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invitation: Invitation | null;
  organizationId: string;
  /** Reloads the invitation list. */
  onChanged: () => void;
}

export function CancelInvitationDialog({
  open,
  onOpenChange,
  invitation,
  organizationId,
  onChanged,
}: CancelInvitationDialogProps) {
  const leaveManagement = useLeaveManagement();
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    if (!invitation) return;
    setIsLoading(true);
    try {
      await cancelInvitation(organizationId, invitation.id);
    } catch (error) {
      setIsLoading(false);
      if (isManagementLost(error)) {
        onOpenChange(false);
        leaveManagement(error);
        return;
      }
      toast.error(refusalMessage(error, "Failed to cancel invitation"));
      // A refusal means the invitation is no longer pending.
      if (isRefusal(error)) onChanged();
      return;
    }
    setIsLoading(false);
    toast.success(`Invitation cancelled for ${invitation.email}`);
    onOpenChange(false);
    onChanged();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel Invitation</AlertDialogTitle>
          <AlertDialogDescription>
            You are permanently cancelling the invitation for{" "}
            <span className="font-medium text-foreground">
              {invitation?.email}
            </span>
            . This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Go Back</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Stay open until the API answers.
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={isLoading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isLoading ? "Cancelling..." : "Cancel Invitation"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
