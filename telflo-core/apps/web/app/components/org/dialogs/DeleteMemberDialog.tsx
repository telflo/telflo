import { useState } from "react";
import { toast } from "sonner";
import type { Member } from "@telflo/contracts";
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
import { removeMember } from "~/lib/api-client.js";
import { isManagementLost, isRefusal, refusalMessage, useLeaveManagement } from "~/lib/organizations.js";

/*
 * Removing a member (ADR 0018). Removing takes only this membership: the
 * member keeps their account and their sessions, which move to their fallback
 * organization (D5 decision 9); the account isn't banned.
 *
 * The dialog stays open, showing "Removing...", until the API
 * answers, and a refusal keeps it open, as the Change Role dialog does.
 */

interface DeleteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: Member | null;
  organizationId: string;
  /** Reloads the member list. */
  onChanged: () => void;
}

export function DeleteMemberDialog({
  open,
  onOpenChange,
  member,
  organizationId,
  onChanged,
}: DeleteMemberDialogProps) {
  const leaveManagement = useLeaveManagement();
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    if (!member) return;
    setIsLoading(true);
    try {
      await removeMember(organizationId, member.userId);
    } catch (error) {
      setIsLoading(false);
      if (isManagementLost(error)) {
        onOpenChange(false);
        leaveManagement(error);
        return;
      }
      toast.error(refusalMessage(error, "Failed to remove member"));
      // A refusal usually means the list is out of date.
      if (isRefusal(error)) onChanged();
      return;
    }
    setIsLoading(false);
    toast.success(`${member.email} has been removed from the organization`);
    onOpenChange(false);
    onChanged();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove Member</AlertDialogTitle>
          <AlertDialogDescription>
            You are removing{" "}
            <span className="font-medium text-foreground">
              {member?.email}
            </span>{" "}
            from the organization. They will lose access immediately.
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
            {isLoading ? "Removing..." : "Delete Member"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
