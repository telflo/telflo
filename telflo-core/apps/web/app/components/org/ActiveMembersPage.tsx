import { useState } from "react";
import type { Member } from "@telflo/contracts";
import { ChangeRoleDialog } from "./dialogs/ChangeRoleDialog.js";
import { DeleteMemberDialog } from "./dialogs/DeleteMemberDialog.js";
import { formatDate } from "./format-date.js";

/*
 * The active members' list. The list comes from the Permissions layout
 * rather than a store, and a spinner shows until it has loaded. Two rows
 * have no role link and no Delete: the viewer's own, marked "(you)", and
 * the owner of a personal organization.
 */

interface ActiveMembersPageProps {
  /** Every member, active and removed; null while the list loads. */
  members: Member[] | null;
  currentUserId: string;
  organizationId: string;
  /** Reloads the list after a change. */
  onChanged: () => void;
}

export function ActiveMembersPage({ members, currentUserId, organizationId, onChanged }: ActiveMembersPageProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [changeRoleDialogOpen, setChangeRoleDialogOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [roleChangeMember, setRoleChangeMember] = useState<Member | null>(null);

  const activeMembers = (members ?? []).filter((m) => m.deletedAt === null);

  const handleDelete = (member: Member) => {
    setSelectedMember(member);
    setDeleteDialogOpen(true);
  };

  const handleChangeRole = (member: Member) => {
    setRoleChangeMember(member);
    setChangeRoleDialogOpen(true);
  };

  /** Neither the viewer's own membership nor a personal organization's owner can be changed or removed. */
  const isManageable = (member: Member) => member.userId !== currentUserId && !member.isOrganizationOwner;

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
          Active Members
        </h1>
      </div>
      <p className="text-[13px] text-muted-foreground mb-4">
        Current members of your organization
      </p>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        {members === null ? (
          <div className="flex items-center justify-center py-12" role="status" aria-label="Loading members">
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
                Joined At
              </th>
              <th className="h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {activeMembers.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center text-[13px] text-muted-foreground"
                >
                  No active members
                </td>
              </tr>
            ) : (
              activeMembers.map((member) => (
                <tr
                  key={member.userId}
                  className="border-b border-border last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-foreground">
                    {member.email}
                    {member.userId === currentUserId && (
                      <span className="ml-2 font-sans text-xs text-muted-foreground">(you)</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-muted-foreground">
                    {isManageable(member) ? (
                      <button
                        onClick={() => handleChangeRole(member)}
                        className="text-brand hover:underline cursor-pointer"
                      >
                        {member.role}
                      </button>
                    ) : (
                      member.role
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {formatDate(member.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                    {isManageable(member) && (
                      <button
                        onClick={() => handleDelete(member)}
                        className="rounded-[4px] px-1.5 py-0.5 font-medium text-fail hover:bg-fail-soft"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        )}
      </div>

      <DeleteMemberDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        member={selectedMember}
        organizationId={organizationId}
        onChanged={onChanged}
      />

      <ChangeRoleDialog
        open={changeRoleDialogOpen}
        onOpenChange={setChangeRoleDialogOpen}
        member={roleChangeMember}
        organizationId={organizationId}
        onChanged={onChanged}
      />
    </div>
  );
}
