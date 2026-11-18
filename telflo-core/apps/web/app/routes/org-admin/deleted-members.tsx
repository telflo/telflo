import { useOutletContext } from "react-router";
import { DeletedMembersPage } from "~/components/org/DeletedMembersPage.js";
import type { OrgAdminOutletContext } from "~/routes/org-admin.js";

export default function OrgDeletedMembers() {
  const { members, organizationId, reloadMembers } = useOutletContext<OrgAdminOutletContext>();
  return (
    <DeletedMembersPage
      members={members}
      organizationId={organizationId}
      onChanged={() => {
        void reloadMembers();
      }}
    />
  );
}
