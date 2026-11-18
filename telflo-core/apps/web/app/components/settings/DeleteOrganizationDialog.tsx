import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { deleteOrganization } from "~/lib/api-client.js";
import { isManagementLost, refusalMessage, useLeaveManagement } from "~/lib/organizations.js";

/*
 * New in D5 (decision 9; its copy is in the Parity Notes' Appearance table).
 * Built from the shadcn Dialog in the style of the member confirmations. The
 * button is enabled only when the organization's exact name is typed:
 * case-sensitive and untrimmed.
 */

interface DeleteOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organization: { id: string; name: string } | null;
}

export function DeleteOrganizationDialog({ open, onOpenChange, organization }: DeleteOrganizationDialogProps) {
  const navigate = useNavigate();
  const leaveManagement = useLeaveManagement();
  const [confirmation, setConfirmation] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (!open) setConfirmation("");
    onOpenChange(open);
  };

  const handleConfirm = async () => {
    if (!organization) return;
    setIsLoading(true);
    try {
      await deleteOrganization(organization.id);
    } catch (error) {
      setIsLoading(false);
      // The organization was deleted, or switched away from, in another tab,
      // or the viewer is no longer its admin: nothing here can go on.
      if (isManagementLost(error)) {
        handleOpenChange(false);
        leaveManagement(error);
        return;
      }
      toast.error(refusalMessage(error, "Failed to delete organization"));
      return;
    }
    setIsLoading(false);
    toast.success(`${organization.name} has been deleted`);
    handleOpenChange(false);
    // The session now acts in the user's fallback organization (decision 9).
    // This page is never /app, so going there reloads the layout's data, and
    // the layout re-seeds the store from the fresh /me.
    await navigate("/app");
  };

  const matches = organization !== null && confirmation === organization.name;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Organization</DialogTitle>
          <DialogDescription>
            This permanently removes{" "}
            <span className="font-medium text-foreground">{organization?.name}</span>{" "}
            for every member. Type the organization&apos;s name to confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <Input
            aria-label="Organization name"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
            autoFocus
            disabled={isLoading}
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={isLoading || !matches}
          >
            {isLoading ? "Deleting..." : "Delete Organization"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
