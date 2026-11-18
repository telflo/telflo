import { useState } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE,
  mayInviteFrom,
  type Invitation,
  type OrganizationType,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { resendInvitation } from "~/lib/api-client.js";
import { isManagementLost, isRefusal, refusalMessage, useLeaveManagement } from "~/lib/organizations.js";
import { useSite } from "~/lib/use-site.js";
import { CancelInvitationDialog } from "./dialogs/CancelInvitationDialog.js";
import { InviteOrgMemberDialog } from "./dialogs/InviteOrgMemberDialog.js";
import { formatDate } from "./format-date.js";

/*
 * The invited members' list (ADR 0018). The invitations come from the
 * Permissions layout rather than a store, and the Active page's spinner shows
 * until they have loaded. The role is the API's, already lowercase. An
 * invitation past its expiry says "Expired" beside its date (new; D6 decision
 * 13), and Resend revives it.
 *
 * A resend reloads the list, so a revived invitation loses its "Expired". A
 * refusal reloads it too: the invitation is usually gone.
 */

interface InvitedMembersPageProps {
  /** The pending invitations, expired ones included; null while the list loads. */
  invitations: Invitation[] | null;
  organizationId: string;
  /** The organization's name, for the invite dialog. */
  organizationName: string;
  /** Its type, for the invite dialog, and whether it may invite on this site (D36-1 decision 57). */
  organizationType: OrganizationType;
  /** Reloads the list after a change. */
  onChanged: () => void;
}

export function InvitedMembersPage({ invitations, organizationId, organizationName, organizationType, onChanged }: InvitedMembersPageProps) {
  const leaveManagement = useLeaveManagement();
  const mayInvite = mayInviteFrom(useSite().registration, organizationType);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [selectedInvitation, setSelectedInvitation] = useState<Invitation | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  const handleCancel = (invitation: Invitation) => {
    setSelectedInvitation(invitation);
    setCancelDialogOpen(true);
  };

  const handleResend = async (invitation: Invitation) => {
    setResendingId(invitation.id);
    try {
      await resendInvitation(organizationId, invitation.id);
      toast.success("Invitation resent");
      onChanged();
    } catch (error) {
      if (isManagementLost(error)) {
        leaveManagement(error);
        return;
      }
      toast.error(refusalMessage(error, "Failed to resend invitation"));
      if (isRefusal(error)) onChanged();
    } finally {
      setResendingId(null);
    }
  };

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
          Invited Members
        </h1>
        {mayInvite ? (
          <Button onClick={() => setInviteDialogOpen(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            Invite Member
          </Button>
        ) : (
          <p className="text-[13px] text-muted-foreground">{PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE}</p>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground mb-4">
        Pending invitations to your organization
      </p>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        {invitations === null ? (
          <div className="flex items-center justify-center py-12" role="status" aria-label="Loading invitations">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-muted-foreground/25 border-t-muted-foreground" />
          </div>
        ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              <th className="h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border">
                Email
              </th>
              <th className="h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border">
                Role
              </th>
              <th className="h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border">
                Invited At
              </th>
              <th className="h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center text-[13px] text-muted-foreground"
                >
                  No pending invitations
                </td>
              </tr>
            ) : (
              invitations.map((invitation) => (
                <tr
                  key={invitation.id}
                  className="border-b border-border last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-foreground">
                    {invitation.email}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-muted-foreground">
                    {invitation.role}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {formatDate(invitation.invitedAt)}
                    {invitation.isExpired && (
                      <span className="ml-2 rounded-[4px] bg-warn-soft px-1 font-sans text-[11px] font-medium text-warn">
                        Expired
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[13px] space-x-1">
                    {mayInvite && (
                      <button
                        onClick={() => {
                          void handleResend(invitation);
                        }}
                        disabled={resendingId === invitation.id}
                        className="rounded-[4px] px-1.5 py-0.5 font-medium text-brand hover:bg-brand-soft disabled:opacity-50"
                      >
                        {resendingId === invitation.id ? "Sending..." : "Resend"}
                      </button>
                    )}
                    <button
                      onClick={() => handleCancel(invitation)}
                      className="rounded-[4px] px-1.5 py-0.5 font-medium text-fail hover:bg-fail-soft"
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        )}
      </div>

      {mayInvite && (
        <InviteOrgMemberDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          organizationId={organizationId}
          organizationName={organizationName}
          organizationType={organizationType}
          onInvited={onChanged}
        />
      )}
      <CancelInvitationDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        invitation={selectedInvitation}
        organizationId={organizationId}
        onChanged={onChanged}
      />
    </div>
  );
}
