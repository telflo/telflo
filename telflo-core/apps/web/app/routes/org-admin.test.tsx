import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_PREFERENCES,
  type CurrentUserResponse,
  type Invitation,
  type Member,
  type SiteSettings,
} from "@telflo/contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import {
  createRoutesStub,
  createStaticHandler,
  createStaticRouter,
  Outlet,
  StaticRouterProvider,
  useNavigationType,
  useRouteError,
} from "react-router";
import { toast } from "sonner";
import routes from "../routes.js";
import AppLayoutRoute, { shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import OrgAdminRoute from "./org-admin.js";
import OrgActiveMembers from "./org-admin/active-members.js";
import OrgDeletedMembers from "./org-admin/deleted-members.js";
import OrgInvitedMembers from "./org-admin/invited-members.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import {
  CONTRIBUTOR,
  EXPIRED_INVITATION,
  INVITED_CONTRIBUTOR,
  ORGANIZATION_ID,
  OWNER,
  REMOVED,
  VIEWER,
} from "~/test/members.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

const GROUP = { id: ORGANIZATION_ID, name: "Group", type: "group", logoId: null } as const;

function currentUserWithRole(role: "admin" | "contributor"): CurrentUserResponse {
  return {
    user: { id: VIEWER.userId, email: VIEWER.email },
    organization: { ...GROUP, role },
    organizations: [
      { id: "00000000-0000-4000-8000-000000000002", name: "viewer", type: "personal", logoId: null, role: "admin" },
      { ...GROUP, role },
    ],
    termsAcceptanceRequired: false,
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: DEFAULT_USER_PREFERENCES,
  };
}

const MEMBERS: Member[] = [VIEWER, OWNER, CONTRIBUTOR, REMOVED];
const INVITATIONS: Invitation[] = [INVITED_CONTRIBUTOR, EXPIRED_INVITATION];

/** The two lists the layout loads, answered as given. */
function serveLists(members: Member[] = MEMBERS, invitations: Invitation[] = INVITATIONS) {
  return {
    getMembers: vi.spyOn(apiClient, "getMembers").mockResolvedValue({ items: members }),
    getInvitations: vi.spyOn(apiClient, "getInvitations").mockResolvedValue({ items: invitations }),
  };
}

/** `/app`, saying how it was reached. */
function AppPage() {
  return <p>landed on /app by {useNavigationType()}</p>;
}

function ErrorBoundary() {
  const error = useRouteError();
  return <p>error boundary: {error instanceof Error ? error.message : "unknown"}</p>;
}

/** The Permissions page under the signed-in layout, as the app routes it. */
function renderPermissions(
  path = "/org-admin",
  role: "admin" | "contributor" = "admin",
  currentUser: CurrentUserResponse = currentUserWithRole(role),
  site?: SiteSettings,
) {
  const pages: Parameters<typeof createRoutesStub>[0] = [
    {
      id: "routes/app-layout",
      Component: AppLayoutRoute as unknown as React.ComponentType,
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser }),
      shouldRevalidate,
      HydrateFallback: () => null,
      ErrorBoundary,
      children: [
        {
          path: "/org-admin",
          Component: OrgAdminRoute,
          children: [
            { index: true, Component: OrgInvitedMembers },
            { path: "active-members", Component: OrgActiveMembers },
            { path: "deleted-members", Component: OrgDeletedMembers },
          ],
        },
        { path: "/app", Component: AppPage },
      ],
    },
  ];
  // Root's site data only when a test gives one: without it, the open source's defaults (lib/use-site.ts).
  const Stub = createRoutesStub(site === undefined ? pages : underSite(site, pages));
  render(<Stub initialEntries={["/somewhere-before", path]} initialIndex={1} />);
  return userEvent.setup();
}

/** The Members nav's item, and its count ("" while there is none). */
function navItem(label: "Invited" | "Active" | "Deleted"): { button: HTMLElement; count: string } {
  const nav = screen.getByRole("heading", { level: 3, name: "Members" }).closest("nav")!;
  const button = within(nav).getByRole("button", { name: new RegExp(`^${label}`) });
  return { button, count: button.textContent!.slice(label.length) };
}

describe("the Permissions page (/org-admin)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("routes /org-admin under the signed-in layout, with Invited as its index, Active and Deleted beside it", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    const orgAdmin = layout?.children?.find((route) => route.path === "org-admin");
    expect(orgAdmin?.file).toBe("routes/org-admin.tsx");
    expect(orgAdmin?.children?.map((route) => [route.index ?? false, route.path, route.file])).toEqual([
      [true, undefined, "routes/org-admin/invited-members.tsx"],
      [false, "active-members", "routes/org-admin/active-members.tsx"],
      [false, "deleted-members", "routes/org-admin/deleted-members.tsx"],
    ]);
  });

  it("sends a contributor to /app, replacing the history entry, without loading the members or the invitations", async () => {
    const getMembers = vi.spyOn(apiClient, "getMembers");
    const getInvitations = vi.spyOn(apiClient, "getInvitations");
    renderPermissions("/org-admin", "contributor");

    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    expect(getMembers).not.toHaveBeenCalled();
    expect(getInvitations).not.toHaveBeenCalled();
  });

  it("renders nothing for a contributor on the server, without React Router's <Navigate> warning", async () => {
    // A non-admin loading /org-admin directly meets the page first on the
    // server, in a static router, where rendering <Navigate> warns. The page
    // renders nothing there, and sends them on from an effect in the browser.
    const handler = createStaticHandler([
      {
        id: "routes/app-layout",
        Component: Outlet,
        loader: (): AppLayoutData => ({ status: "signed_in", currentUser: currentUserWithRole("contributor") }),
        children: [{ path: "/org-admin", Component: OrgAdminRoute }],
      },
    ]);
    const context = await handler.query(new Request("http://localhost/org-admin"));
    if (context instanceof Response) throw new Error("the static handler answered with a response");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getMembers = vi.spyOn(apiClient, "getMembers");
    const getInvitations = vi.spyOn(apiClient, "getInvitations");

    const html = renderToString(
      <StaticRouterProvider router={createStaticRouter(handler.dataRoutes, context)} context={context} />,
    );

    expect(warn).not.toHaveBeenCalled();
    expect(html).not.toContain("Members");
    expect(getMembers).not.toHaveBeenCalled();
    expect(getInvitations).not.toHaveBeenCalled();
  });

  it("sends a contributor on the Active and Deleted pages to /app too", async () => {
    renderPermissions("/org-admin/active-members", "contributor");
    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
    cleanup();

    renderPermissions("/org-admin/deleted-members", "contributor");
    expect(await screen.findByText("landed on /app by REPLACE")).toBeInTheDocument();
  });

  it("shows an admin the Organization nav, with the Invited page as the index and the counts from the two lists", async () => {
    const { getMembers, getInvitations } = serveLists();
    renderPermissions();

    expect(await screen.findByRole("heading", { level: 1, name: "Invited Members" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Organization" })).toBeInTheDocument();
    await waitFor(() => expect(navItem("Invited").count).toBe("2"));
    await waitFor(() => expect(navItem("Active").count).toBe("3"));
    expect(navItem("Deleted").count).toBe("1");
    // Invited, Active, Deleted, in that order.
    const nav = screen.getByRole("heading", { level: 3, name: "Members" }).closest("nav")!;
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual(["Invited2", "Active3", "Deleted1"]);
    expect(navItem("Invited").button).toHaveClass("bg-accent", "text-foreground");
    expect(navItem("Active").button).not.toHaveClass("bg-accent");
    expect(navItem("Deleted").button).not.toHaveClass("bg-accent");
    expect(getMembers).toHaveBeenCalledTimes(1);
    expect(getMembers).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(getInvitations).toHaveBeenCalledTimes(1);
    expect(getInvitations).toHaveBeenCalledWith(ORGANIZATION_ID);
    expect(screen.getByText("invited@example.com")).toBeInTheDocument();
    // The signed-in shell is around it, with Permissions current.
    expect(screen.getByRole("link", { name: "Permissions" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the Active page at /org-admin/active-members, current in the nav", async () => {
    serveLists();
    renderPermissions("/org-admin/active-members");

    expect(await screen.findByRole("heading", { level: 1, name: "Active Members" })).toBeInTheDocument();
    expect(await screen.findByText("contributor@example.com")).toBeInTheDocument();
    expect(navItem("Active").button).toHaveClass("bg-accent", "text-foreground");
    expect(navItem("Invited").button).not.toHaveClass("bg-accent");
    expect(screen.getByRole("link", { name: "Permissions" })).toHaveAttribute("aria-current", "page");
  });

  it("shows no counts while the lists load", async () => {
    vi.spyOn(apiClient, "getMembers").mockReturnValue(new Promise(() => {}));
    vi.spyOn(apiClient, "getInvitations").mockReturnValue(new Promise(() => {}));
    renderPermissions();

    expect(await screen.findByRole("status", { name: "Loading invitations" })).toBeInTheDocument();
    expect(navItem("Invited").count).toBe("");
    expect(navItem("Active").count).toBe("");
    expect(navItem("Deleted").count).toBe("");
  });

  it("moves to the Active and Deleted pages from the nav without loading either list again", async () => {
    const { getMembers, getInvitations } = serveLists();
    const user = renderPermissions();
    await screen.findByText("invited@example.com");

    await user.click(navItem("Active").button);
    expect(await screen.findByRole("heading", { level: 1, name: "Active Members" })).toBeInTheDocument();
    expect(screen.getByText("contributor@example.com")).toBeInTheDocument();
    expect(navItem("Active").button).toHaveClass("bg-accent");

    await user.click(navItem("Deleted").button);
    expect(await screen.findByRole("heading", { level: 1, name: "Deleted Members" })).toBeInTheDocument();
    expect(screen.getByText("removed@example.com")).toBeInTheDocument();
    expect(navItem("Deleted").button).toHaveClass("bg-accent");
    expect(navItem("Deleted").count).toBe("1");

    await user.click(navItem("Invited").button);
    expect(await screen.findByRole("heading", { level: 1, name: "Invited Members" })).toBeInTheDocument();
    expect(getMembers).toHaveBeenCalledTimes(1);
    expect(getInvitations).toHaveBeenCalledTimes(1);
  });

  it("reloads the invitations, and not the members, after an invitation changes, and the count follows", async () => {
    const { getMembers, getInvitations } = serveLists();
    getInvitations.mockResolvedValueOnce({ items: INVITATIONS }).mockResolvedValueOnce({ items: [EXPIRED_INVITATION] });
    vi.spyOn(apiClient, "cancelInvitation").mockResolvedValue(undefined);
    const user = renderPermissions();

    await screen.findByText("invited@example.com");
    const row = screen.getByText("invited@example.com").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Cancel Invitation" }));

    await waitFor(() => expect(navItem("Invited").count).toBe("1"));
    expect(getInvitations).toHaveBeenCalledTimes(2);
    expect(getMembers).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("invited@example.com")).not.toBeInTheDocument();
  });

  it("names the active organization, in bold, in the invite dialog's description (Q261)", async () => {
    serveLists();
    const user = renderPermissions();

    await user.click(await screen.findByRole("button", { name: "Invite Member" }));

    const dialog = await screen.findByRole("dialog", { name: "Invite Members" });
    expect(dialog).toHaveTextContent("Send invitations to join the Group organization.");
    expect(within(dialog).getByText("Group", { selector: "strong" })).toBeInTheDocument();
  });

  it("names the active personal workspace under its default name, its email (Q263), as the <email>'s organization, from /me's type (Q262), on a site with open registration (D36-1 decision 57)", async () => {
    serveLists();
    const signedIn = currentUserWithRole("admin");
    const personal = { ...signedIn.organizations[0]!, name: "viewer@example.com" };
    const user = renderPermissions(
      "/org-admin",
      "admin",
      {
        ...signedIn,
        organization: personal,
        organizations: [personal, signedIn.organizations[1]!],
      },
      SAAS_SITE,
    );

    await user.click(await screen.findByRole("button", { name: "Invite Member" }));

    const dialog = await screen.findByRole("dialog", { name: "Invite Members" });
    expect(dialog).toHaveTextContent("Send invitations to join the viewer@example.com's organization.");
    expect(within(dialog).getByText("viewer@example.com's", { selector: "strong" })).toBeInTheDocument();
  });

  it("offers no Invite Member in the active personal workspace on an invite-only site, the open source's default, and says why in its place (D36-1 decision 57, Q268)", async () => {
    serveLists();
    const signedIn = currentUserWithRole("admin");
    const personal = { ...signedIn.organizations[0]!, name: "viewer@example.com" };
    renderPermissions("/org-admin", "admin", {
      ...signedIn,
      organization: personal,
      organizations: [personal, signedIn.organizations[1]!],
    });

    expect(await screen.findByText("Invitations can't be sent from a personal workspace on this site.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite Member" })).not.toBeInTheDocument();
  });

  it("reloads the invitations after inviting from the dialog", async () => {
    const invited: Invitation = { ...INVITED_CONTRIBUTOR, id: "00000000-0000-4000-8000-000000000023", email: "new@example.com" };
    const { getInvitations } = serveLists();
    getInvitations.mockResolvedValueOnce({ items: INVITATIONS }).mockResolvedValueOnce({ items: [invited, ...INVITATIONS] });
    vi.spyOn(apiClient, "inviteMember").mockResolvedValue({ invitation: invited });
    const user = renderPermissions();

    await user.click(await screen.findByRole("button", { name: "Invite Member" }));
    await user.type(screen.getByLabelText("Email Addresses"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Send Invitations" }));
    expect(await screen.findByText("Invitation Sent")).toBeInTheDocument();
    await waitFor(() => expect(getInvitations).toHaveBeenCalledTimes(2));
    // The dialog stays open with its alert.
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(navItem("Invited").count).toBe("3"));
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
  });

  it("reloads the members after a change, and the counts follow", async () => {
    const afterRemoval: Member[] = [VIEWER, OWNER, { ...CONTRIBUTOR, deletedAt: "2026-05-01T12:00:00.000Z" }, REMOVED];
    const { getMembers, getInvitations } = serveLists();
    getMembers.mockResolvedValueOnce({ items: MEMBERS }).mockResolvedValueOnce({ items: afterRemoval });
    vi.spyOn(apiClient, "removeMember").mockResolvedValue(undefined);
    const user = renderPermissions("/org-admin/active-members");

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Delete Member" }));

    await waitFor(() => expect(navItem("Active").count).toBe("2"));
    expect(navItem("Deleted").count).toBe("2");
    expect(getMembers).toHaveBeenCalledTimes(2);
    expect(getInvitations).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("contributor@example.com")).not.toBeInTheDocument();
  });

  it.each([
    // Someone demoted the viewer meanwhile.
    ["403 organization_admin_required", "organization_admin_required", "Only an admin of this organization can do that"],
    // Another tab switched away from, or deleted, the organization.
    ["404 organization_not_found", "organization_not_found", "Organization not found"],
  ])("when both loads are refused with %s, toasts its message once and goes to /app", async (_, code, message) => {
    vi.spyOn(apiClient, "getMembers").mockRejectedValue(new ApiError(code, message));
    vi.spyOn(apiClient, "getInvitations").mockRejectedValue(new ApiError(code, message));
    const error = vi.spyOn(toast, "error");
    renderPermissions();

    expect(await screen.findByText(/^landed on \/app/)).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(message);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("when only the invitations' load is refused, toasts its message and goes to /app", async () => {
    vi.spyOn(apiClient, "getMembers").mockResolvedValue({ items: MEMBERS });
    vi.spyOn(apiClient, "getInvitations").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    );
    const error = vi.spyOn(toast, "error");
    renderPermissions();

    expect(await screen.findByText(/^landed on \/app/)).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
  });

  it("when a change is refused with 403 organization_admin_required, toasts its message and goes to /app", async () => {
    serveLists();
    vi.spyOn(apiClient, "restoreMember").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an admin of this organization can do that"),
    );
    const error = vi.spyOn(toast, "error");
    const user = renderPermissions("/org-admin/deleted-members");

    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await user.click(await screen.findByRole("button", { name: "Restore Member" }));

    expect(await screen.findByText(/^landed on \/app/)).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an admin of this organization can do that");
  });

  it("lets an unexpected load failure of the members reach the error boundary, rather than showing no members", async () => {
    vi.spyOn(apiClient, "getMembers").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    vi.spyOn(apiClient, "getInvitations").mockResolvedValue({ items: INVITATIONS });
    // React and React Router log an error caught by a boundary.
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPermissions("/org-admin/active-members");

    expect(
      await screen.findByText("error boundary: Could not reach the server. Check your connection."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No active members")).not.toBeInTheDocument();
  });

  it("lets an unexpected load failure of the invitations reach the error boundary, rather than showing none", async () => {
    vi.spyOn(apiClient, "getMembers").mockResolvedValue({ items: MEMBERS });
    vi.spyOn(apiClient, "getInvitations").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPermissions();

    expect(
      await screen.findByText("error boundary: Could not reach the server. Check your connection."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No pending invitations")).not.toBeInTheDocument();
  });

  // The session-ended handler owns a 401 `unauthenticated`, and while Logout
  // has it suspended the page is leaving for /login: the list neither throws
  // to the error boundary, which below root is root's own and replaced the
  // whole app (the sidebar, Logout's toast) with "Oops!", nor toasts, nor
  // leaves (D12 Ruling 40).
  it.each([
    ["members", "Invited", "2", "Active", "/org-admin", "invited@example.com"],
    ["invitations", "Active", "3", "Invited", "/org-admin/active-members", "contributor@example.com"],
  ] as const)(
    "when the %s' load finds the session over (401 unauthenticated), shows nothing: no error boundary, no toast, no navigation",
    async (refusedList, loadedItem, loadedCount, refusedItem, path, loadedRow) => {
      const sessionEnded = new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
      const refusal = Promise.reject(sessionEnded);
      refusal.catch(() => undefined);
      const { getMembers, getInvitations } = serveLists();
      (refusedList === "members" ? getMembers : getInvitations).mockReturnValue(refusal);
      const error = vi.spyOn(toast, "error");
      const consoleError = vi.spyOn(console, "error");
      renderPermissions(path);

      expect(await screen.findByText(loadedRow)).toBeInTheDocument();
      await waitFor(() => expect(navItem(loadedItem).count).toBe(loadedCount));
      // The refused load has answered, and the page has had its turn to handle it.
      await act(async () => {
        await refusal.catch(() => undefined);
      });
      expect(screen.queryByText(/^error boundary/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^landed on \/app/)).not.toBeInTheDocument();
      expect(navItem(refusedItem).count).toBe("");
      expect(screen.getByRole("heading", { level: 2, name: "Organization" })).toBeInTheDocument();
      expect(error).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    },
  );
});
