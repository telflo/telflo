import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import {
  OrganizationRoleSchema,
  type OrganizationErrorCode,
  type OrganizationRole,
  type OrganizationType,
} from "@telflo/contracts";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
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
import { Label } from "~/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.js";
import { ApiError, inviteMember } from "~/lib/api-client.js";
import { isEmailAddress, organizationLabel } from "~/lib/organization-names.js";
import { isManagementLost, refusalMessage, useLeaveManagement } from "~/lib/organizations.js";

/*
 * Inviting members (ADR 0018). Its description names the organization in bold
 * (the owner, D36-1 Q261; organization content: visible text in the masked
 * shell only, never an attribute). A personal workspace under its default
 * name, its owner's email (Q263), reads "the <email>'s organization" (Q262;
 * lib/organization-names.ts' organizationLabel, the rule the other places
 * that name an organization in a sentence share, Q264). The addresses are
 * split on commas, trimmed, lowercased and checked with isEmailAddress, then
 * invited one request at a time, in order (D6 decision 13). It offers
 * Contributor and Admin, the only roles (D7 decision 2).
 *
 * Each failure is the API's refusal ("User has already been invited to this
 * organization"), or "Failed to invite" for anything else. An
 * invitation whose email couldn't be sent (502 `invitation_email_failed`)
 * is a failure too, but it was created, so the list reloads for it as for a
 * success. A refusal saying the viewer is no longer an admin here stops the
 * remaining invitations and leaves the page for /app.
 */

const DEFAULT_ROLE: OrganizationRole = "contributor";

/** The invitation was created, but its email wasn't sent. */
const EMAIL_FAILED: OrganizationErrorCode = "invitation_email_failed";

interface InviteOrgMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  /** The organization's name, in bold in the description. */
  organizationName: string;
  /** Its type: a personal workspace named by its email reads "the <email>'s organization" (Q262, Q263). */
  organizationType: OrganizationType;
  /** Reloads the invitation list. */
  onInvited: () => void;
}

export function InviteOrgMemberDialog({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  organizationType,
  onInvited,
}: InviteOrgMemberDialogProps) {
  const leaveManagement = useLeaveManagement();
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<OrganizationRole>(DEFAULT_ROLE);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async () => {
    const emailList = emails
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (emailList.length === 0) {
      setError("At least one email is required");
      return;
    }

    const invalid = emailList.filter((e) => !isEmailAddress(e));
    if (invalid.length > 0) {
      setError(`Invalid email${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`);
      return;
    }

    setError(null);
    setSuccess(null);
    setIsLoading(true);

    const succeeded: string[] = [];
    const failed: { email: string; message: string }[] = [];
    let created = false;

    for (const email of emailList) {
      try {
        await inviteMember(organizationId, { email, role });
        succeeded.push(email);
        created = true;
      } catch (err) {
        if (isManagementLost(err)) {
          setIsLoading(false);
          handleOpenChange(false);
          leaveManagement(err);
          return;
        }
        // Surface the server's reason (e.g. "previously removed — restore
        // them from the Deleted view") instead of a blanket failure.
        failed.push({ email, message: refusalMessage(err, "Failed to invite") });
        if (err instanceof ApiError && err.code === EMAIL_FAILED) created = true;
      }
    }

    if (succeeded.length > 0) {
      setSuccess(
        succeeded.length === 1 ? "Invitation Sent" : "Invitations Sent",
      );
    }
    if (failed.length > 0) {
      setError(
        failed.length === 1
          ? failed[0]!.message
          : failed.map((f) => `${f.email}: ${f.message}`).join("\n"),
      );
    }
    if (succeeded.length > 0 && failed.length === 0) {
      setEmails("");
      setRole(DEFAULT_ROLE);
    }
    if (created) {
      onInvited();
    }
    setIsLoading(false);
  };

  const resetForm = () => {
    setEmails("");
    setRole(DEFAULT_ROLE);
    setError(null);
    setSuccess(null);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite Members</DialogTitle>
          <DialogDescription>
            Send invitations to join the <strong className="font-semibold text-foreground">{organizationLabel(organizationName, organizationType)}</strong>{" "}
            organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <Alert variant="destructive">
              {/* pre-line: multi-email failures arrive one-per-line */}
              <AlertDescription className="whitespace-pre-line">
                {error}
              </AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert>
              <AlertDescription className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-ok shrink-0" />
                {success}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="invite-email">Email Addresses</Label>
            <Input
              id="invite-email"
              type="text"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="user@example.com, another@example.com"
              autoFocus
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Separate multiple emails with commas.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(OrganizationRoleSchema.parse(value))}
              disabled={isLoading}
            >
              <SelectTrigger id="invite-role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="contributor">Contributor</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
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
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={isLoading || !emails.trim()}
          >
            {isLoading ? "Sending..." : "Send Invitations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
