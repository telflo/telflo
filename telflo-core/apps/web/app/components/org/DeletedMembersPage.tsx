import { useState } from "react";
import type { Member } from "@telflo/contracts";
import { RestoreMemberDialog } from "./dialogs/RestoreMemberDialog.js";
import { formatDate } from "./format-date.js";

/*
 * The deleted members' list. Deleted At is the membership's
 * `deletedAt`. The list comes from the Permissions layout, and the
 * Active page's spinner shows until it has loaded.
 */

interface DeletedMembersPageProps {
  /** Every member, active and removed; null while the list loads. */
  members: Member[] | null;
  organizationId: string;
  /** Reloads the list after a change. */
  onChanged: () => void;
}

export function DeletedMembersPage({ members, organizationId, onChanged }: DeletedMembersPageProps) {
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);

  const deletedMembers = (members ?? []).filter((m) => m.deletedAt !== null);

  const handleRestore = (member: Member) => {
    setSelectedMember(member);
    setRestoreDialogOpen(true);
  };

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
          Deleted Members
        </h1>
      </div>
      <p className="text-[13px] text-muted-foreground mb-4">
        Previously removed members
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
                Deleted At
              </th>
              <th className="h-9 px-3 text-left align-middle font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground border-b border-border">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {deletedMembers.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-8 text-center text-[13px] text-muted-foreground"
                >
                  No deleted members
                </td>
              </tr>
            ) : (
              deletedMembers.map((member) => (
                <tr
                  key={member.userId}
                  className="border-b border-border last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-foreground">
                    {member.email}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[13px] text-muted-foreground">
                    {member.role}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {formatDate(member.deletedAt)}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[13px]">
                    <button
                      onClick={() => handleRestore(member)}
                      className="rounded-[4px] px-1.5 py-0.5 font-medium text-ok hover:bg-ok-soft"
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        )}
      </div>

      <RestoreMemberDialog
        open={restoreDialogOpen}
        onOpenChange={setRestoreDialogOpen}
        member={selectedMember}
        organizationId={organizationId}
        onChanged={onChanged}
      />
    </div>
  );
}
