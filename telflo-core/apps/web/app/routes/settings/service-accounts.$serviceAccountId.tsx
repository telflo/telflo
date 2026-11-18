import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { ServiceAccountDetailSection } from "~/components/settings/ServiceAccountDetailSection.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/**
 * A service account's page (D22 decision 41), by its id only: for admins of
 * the active organization, anyone else sent to `/settings`, replacing the
 * history entry, as the list's route. The section is keyed by the
 * organization and the account (Preflight ruling 20), so an answer read for
 * an account no longer shown lands nowhere.
 */
export default function SettingsServiceAccountRoute() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const { serviceAccountId = "" } = useParams();
  const isSignedIn = currentUser !== null;
  const isAdmin = currentUser?.organization.role === "admin";

  useEffect(() => {
    if (isSignedIn && !isAdmin) void navigate("/settings", { replace: true });
  }, [isSignedIn, isAdmin, navigate]);

  if (currentUser === null || !isAdmin) return null;
  const organizationId = currentUser.organization.id;
  return (
    <ServiceAccountDetailSection
      key={`${organizationId}/${serviceAccountId}`}
      organizationId={organizationId}
      serviceAccountId={serviceAccountId}
    />
  );
}
