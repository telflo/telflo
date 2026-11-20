import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import type { Invitation, Member, OrganizationType } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { getInvitations, getMembers, isSessionEnded, type ApiError } from "~/lib/api-client.js";
import { isManagementLost, useLeaveManagement } from "~/lib/organizations.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { cn } from "~/lib/utils.js";

/*
 * The Permissions page (`/org-admin`). Its Members nav has "Invited", the
 * index, "Active" and "Deleted", each with its count. The signed-in layout
 * route supplies the shell and the session check, so this neither wraps
 * itself in AppLayout nor loads the user. There is no "No organization
 * defined" panel: everyone has an active organization.
 *
 * The members and the invitations load here, together, once for the three
 * pages, through the browser client, so an expired access token is
 * refreshed by its interceptor (a child route doesn't assume a fresh
 * token in a server loader of its own). The counts come from the same
 * lists.
 */

/** What the member pages get from this layout, through the outlet. */
export type OrgAdminOutletContext = {
  /** Every member, active and removed; null until the first load answers. */
  members: Member[] | null;
  /** The pending invitations, expired ones included; null until the first load answers. */
  invitations: Invitation[] | null;
  currentUserId: string;
  organizationId: string;
  /** The organization's name, shown in the invite dialog (organization content: visible text in the masked shell only). */
  organizationName: string;
  /** Its type: a personal workspace's default name reads differently in the invite dialog. */
  organizationType: OrganizationType;
  /** Loads the members again, after a change. */
  reloadMembers: () => Promise<void>;
  /** Loads the invitations again, after a change. */
  reloadInvitations: () => Promise<void>;
};

/** The pathname without a trailing slash, so `/org-admin/` is the index too. */
function normalized(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * One of the layout's lists, loaded while the viewer is an admin. Only the
 * latest load's answer is shown: a reload overtakes the load before it, and
 * nothing lands after the page has gone. A refusal saying the page can't go
 * on goes to `onLost`; any other failure is returned, for the error
 * boundary.
 *
 * A load that finds the session over (`unauthenticated`, isSessionEnded) is
 * neither: nothing is shown, and the list stays as it was. The
 * session-ended handler owns that case and takes the browser to sign in,
 * and while Logout has the handler suspended the page is leaving for
 * Logout's `/login`. Thrown, it reached root's error boundary, the only one
 * there is, which replaced the whole app, the sidebar and Logout's toast
 * with "Oops!" until `/login` loaded.
 */
function useAdminList<Item>(
  fetchItems: (() => Promise<{ items: Item[] }>) | undefined,
  onLost: (error: ApiError) => void,
): { items: Item[] | null; failure: { error: unknown } | null; reload: () => Promise<void> } {
  const [items, setItems] = useState<Item[] | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const latestLoad = useRef(0);

  const reload = useCallback(async () => {
    if (!fetchItems) return;
    const thisLoad = ++latestLoad.current;
    try {
      const { items } = await fetchItems();
      if (thisLoad === latestLoad.current) setItems(items);
    } catch (error) {
      if (thisLoad !== latestLoad.current) return;
      if (isSessionEnded(error)) return;
      if (isManagementLost(error)) onLost(error);
      else setFailure({ error });
    }
  }, [fetchItems, onLost]);

  useEffect(() => {
    if (!fetchItems) return;
    setItems(null);
    void reload();
    return () => {
      latestLoad.current++;
    };
  }, [fetchItems, reload]);

  return { items, failure, reload };
}

export default function OrgAdminRoute() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const leaveManagement = useLeaveManagement();
  const organizationId = currentUser?.organization.id;
  const isSignedIn = currentUser !== null;
  const isAdmin = currentUser?.organization.role === "admin";

  // Both lists are usually refused together (a demotion, a switch in another
  // tab), and the page is left once.
  const hasLeft = useRef(false);
  const leaveOnce = useCallback(
    (error: ApiError) => {
      if (hasLeft.current) return;
      hasLeft.current = true;
      leaveManagement(error);
    },
    [leaveManagement],
  );

  const fetchMembers = useMemo(
    () => (isAdmin && organizationId ? () => getMembers(organizationId) : undefined),
    [isAdmin, organizationId],
  );
  const fetchInvitations = useMemo(
    () => (isAdmin && organizationId ? () => getInvitations(organizationId) : undefined),
    [isAdmin, organizationId],
  );
  const members = useAdminList(fetchMembers, leaveOnce);
  const invitations = useAdminList(fetchInvitations, leaveOnce);

  // Only admins of the active organization manage its members:
  // anyone else is sent to /app, replacing the history entry. From an
  // effect rather than by rendering <Navigate>, which warns when rendered on
  // the server, as it is when a non-admin loads /org-admin directly.
  useEffect(() => {
    if (isSignedIn && !isAdmin) void navigate("/app", { replace: true });
  }, [isSignedIn, isAdmin, navigate]);

  // Anything but a refusal or an ended session (no connection, a server
  // error, a drifted response) reaches the error boundary, as the signed-in
  // layout's own failures do, rather than looking like an organization with
  // no members.
  const failure = members.failure ?? invitations.failure;
  if (failure) throw failure.error;

  if (currentUser === null || !isAdmin) return null;

  const invitedCount = invitations.items?.length;
  const activeCount = members.items?.filter((member) => member.deletedAt === null).length;
  const deletedCount = members.items?.filter((member) => member.deletedAt !== null).length;

  const navGroups = [
    {
      label: "Members",
      items: [
        { path: "/org-admin", label: "Invited", count: invitedCount },
        { path: "/org-admin/active-members", label: "Active", count: activeCount },
        { path: "/org-admin/deleted-members", label: "Deleted", count: deletedCount },
      ],
    },
  ];

  const context: OrgAdminOutletContext = {
    members: members.items,
    invitations: invitations.items,
    currentUserId: currentUser.user.id,
    organizationId: currentUser.organization.id,
    organizationName: currentUser.organization.name,
    organizationType: currentUser.organization.type,
    reloadMembers: members.reload,
    reloadInvitations: invitations.reload,
  };

  return (
    <div className="flex h-full">
      {/* Left Sidebar Navigation */}
      <div className="w-52 bg-card border-r border-border flex flex-col">
        <div className="flex h-13 items-center border-b border-border px-4">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
            Organization
          </h2>
        </div>
        <nav className="flex-1 space-y-4 px-2 py-3">
          {navGroups.map((group) => (
            <div key={group.label}>
              <h3 className="tf-label mb-1.5 px-2.5">
                {group.label}
              </h3>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active = normalized(location.pathname) === item.path;
                  return (
                    <Button
                      key={item.path}
                      variant="ghost"
                      className={cn(
                        "relative h-8 w-full justify-start rounded-[5px] px-2.5 text-left text-[13px] font-medium",
                        active
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() => {
                        void navigate(item.path);
                      }}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                      )}
                      {item.label}
                      {item.count != null && (
                        <span className="ml-auto rounded-[4px] bg-muted px-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {item.count}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-auto">
        <Outlet context={context} />
      </div>
    </div>
  );
}
