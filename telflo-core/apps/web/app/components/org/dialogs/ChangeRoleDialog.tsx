import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OrganizationRoleSchema, type Member, type OrganizationRole } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.js";
import { changeMemberRole } from "~/lib/api-client.js";
import { isManagementLost, isRefusal, refusalMessage, useLeaveManagement } from "~/lib/organizations.js";

/*
 * Changing a member's role (ADR 0018). It offers Admin and Contributor,
 * the only roles (D7 decision 2). A refusal toasts the API's message, and
 * anything else "Failed to update role"; a refusal saying the viewer is no
 * longer an admin here leaves the page for /app.
 */

interface ChangeRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: Member | null;
  organizationId: string;
  /** Reloads the member list. */
  onChanged: () => void;
}

export function ChangeRoleDialog({
  open,
  onOpenChange,
  member,
  organizationId,
  onChanged,
}: ChangeRoleDialogProps) {
  const leaveManagement = useLeaveManagement();
  const [role, setRole] = useState<OrganizationRole | "">("");
  const [isLoading, setIsLoading] = useState(false);

  // Each opening starts from the member's current role.
  useEffect(() => {
    if (member && open) {
      setRole(member.role);
    }
  }, [member, open]);

  const handleSubmit = async () => {
    if (!member || role === "") return;
    setIsLoading(true);
    try {
      await changeMemberRole(organizationId, member.userId, { role });
    } catch (error) {
      setIsLoading(false);
      if (isManagementLost(error)) {
        onOpenChange(false);
        leaveManagement(error);
        return;
      }
      toast.error(refusalMessage(error, "Failed to update role"));
      // A refusal usually means the list is out of date (the member was
      // removed meanwhile, say).
      if (isRefusal(error)) onChanged();
      return;
    }
    setIsLoading(false);
    toast.success(`${member.email} role changed to ${role}`);
    onOpenChange(false);
    onChanged();
  };

  const roleUnchanged = member?.role === role;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Role</DialogTitle>
          <DialogDescription>
            Change the user's role for{" "}
            <span className="font-medium text-foreground">
              {member?.email}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="change-role">Role</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(OrganizationRoleSchema.parse(value))}
              disabled={isLoading}
            >
              <SelectTrigger id="change-role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="contributor">Contributor</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {role === "admin" && "Full access to manage the organization and its members."}
              {role === "contributor" && "Can create and edit configurations."}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={isLoading || roleUnchanged}
          >
            {isLoading ? "Updating..." : "Update Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
