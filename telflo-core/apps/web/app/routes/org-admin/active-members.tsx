import { useOutletContext } from "react-router";
import { ActiveMembersPage } from "~/components/org/ActiveMembersPage.js";
import type { OrgAdminOutletContext } from "~/routes/org-admin.js";

export default function OrgActiveMembers() {
  const { members, currentUserId, organizationId, reloadMembers } = useOutletContext<OrgAdminOutletContext>();
  return (
    <ActiveMembersPage
      members={members}
      currentUserId={currentUserId}
      organizationId={organizationId}
      onChanged={() => {
        void reloadMembers();
      }}
    />
  );
}
