import { useOutletContext } from "react-router";
import { InvitedMembersPage } from "~/components/org/InvitedMembersPage.js";
import type { OrgAdminOutletContext } from "~/routes/org-admin.js";

/** The Permissions page's index. */
export default function OrgInvitedMembers() {
  const { invitations, organizationId, organizationName, organizationType, reloadInvitations } = useOutletContext<OrgAdminOutletContext>();
  return (
    <InvitedMembersPage
      invitations={invitations}
      organizationId={organizationId}
      organizationName={organizationName}
      organizationType={organizationType}
      onChanged={() => {
        void reloadInvitations();
      }}
    />
  );
}
