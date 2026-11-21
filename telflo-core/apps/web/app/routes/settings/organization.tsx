import { EditOrganization } from "~/components/settings/EditOrganization.js";
import { PublicInstallLinksCard } from "~/components/settings/PublicInstallLinksCard.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/**
 * Settings → Organization. Everyone sees the list and can create one, Edit
 * needs admin, and nobody is without an organization. Below the list, the
 * current organization's "Public install links" switch, keyed by it:
 * another organization's card starts afresh.
 */
export default function SettingsOrganizationRoute() {
  const organizationId = useCurrentUser()?.organization.id ?? null;
  return (
    <>
      <EditOrganization />
      {organizationId !== null && <PublicInstallLinksCard key={organizationId} />}
    </>
  );
}
