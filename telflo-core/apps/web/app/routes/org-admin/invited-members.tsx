import { useOutletContext } from "react-router";
import { InvitedMembersPage } from "~/components/org/InvitedMembersPage.js";
import type { OrgAdminOutletContext } from "~/routes/org-admin.js";

/** The Permissions page's index (D6 decision 13). */
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
