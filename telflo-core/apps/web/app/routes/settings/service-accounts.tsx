import { useEffect } from "react";
import { useNavigate } from "react-router";
import { ServiceAccountsSection } from "~/components/settings/ServiceAccountsSection.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/**
 * Settings › Service Accounts (D22 decision 41), for admins of the active
 * organization only (Q132): anyone else is sent to `/settings`, replacing
 * the history entry, from an effect rather than by
 * rendering <Navigate>, which warns on the server (org-admin's form). The
 * section is keyed by the organization, so a switch starts it afresh.
 */
export default function SettingsServiceAccountsRoute() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const isSignedIn = currentUser !== null;
  const isAdmin = currentUser?.organization.role === "admin";

  useEffect(() => {
    if (isSignedIn && !isAdmin) void navigate("/settings", { replace: true });
  }, [isSignedIn, isAdmin, navigate]);

  if (currentUser === null || !isAdmin) return null;
  const organizationId = currentUser.organization.id;
  return <ServiceAccountsSection key={organizationId} organizationId={organizationId} />;
}
