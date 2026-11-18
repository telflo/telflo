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
import { restoreMember } from "~/lib/api-client.js";
import { isManagementLost, isRefusal, refusalMessage, useLeaveManagement } from "~/lib/organizations.js";

/*
 * Restoring a removed member (ADR 0018). There is no unban: removing
 * doesn't ban (D5 Parity Notes). As with removing, the dialog stays open
 * until the API answers.
 */

interface RestoreMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: Member | null;
  organizationId: string;
  /** Reloads the member list. */
  onChanged: () => void;
}

export function RestoreMemberDialog({
  open,
  onOpenChange,
  member,
  organizationId,
  onChanged,
}: RestoreMemberDialogProps) {
  const leaveManagement = useLeaveManagement();
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    if (!member) return;
    setIsLoading(true);
    try {
      await restoreMember(organizationId, member.userId);
    } catch (error) {
      setIsLoading(false);
      if (isManagementLost(error)) {
        onOpenChange(false);
        leaveManagement(error);
        return;
      }
      toast.error(refusalMessage(error, "Failed to restore member"));
      // A refusal usually means the list is out of date.
      if (isRefusal(error)) onChanged();
      return;
    }
    setIsLoading(false);
    toast.success(`${member.email} has been restored to the organization`);
    onOpenChange(false);
    onChanged();
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore Member</AlertDialogTitle>
          <AlertDialogDescription>
            You are restoring{" "}
            <span className="font-medium text-foreground">
              {member?.email}
            </span>
            's access to the organization. They will regain their previous
            capabilities.
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
          >
            {isLoading ? "Restoring..." : "Restore Member"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
