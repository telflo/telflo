import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import type { ComponentType } from "react";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse, type Invitation } from "@telflo/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLoaderData, useRouteError } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLayoutData } from "./app-layout.js";

/*
 * Logout from the Permissions page with its members' read in flight, on a
 * real router (D12 Ruling 40; the FW2 follow-up review's MAJOR). The root is
 * the real one, its App (the one Toaster) and its ErrorBoundary, the only
 * boundary there is; under it the real signed-in layout (the sidebar, whose
 * Logout is the real useLogout) and the real org-admin route. The client is
 * the real one, with axios answering through a fake API, as
 * lib/use-logout.stray-read.test.tsx does. Logout navigates to `/login`,
 * whose data is held, so the Permissions page is still mounted when the
 * read's stray 401 arrives, as in a browser where the 401 beats
 * `/login.data`. The list must not throw it: root's ErrorBoundary would
 * replace the whole app, the sidebar and "Logged out successfully" with it,
 * with "Oops!" until `/login` loads.
 *
 * Its own file: sonner keeps toasts in a module singleton (root.test.tsx).
 */

// The signed-in layout's server loader's; this test gives the layout its data.
vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

type Reply = { status: number; body?: unknown };
type Route = () => Reply | Promise<Reply>;

const ORGANIZATION_ID = "0190a8b0-0000-7000-8000-0000000000aa";
const VIEWER_ID = "0190a8b0-0000-7000-8000-0000000000bb";
const MEMBERS = `GET /api/v1/organizations/${ORGANIZATION_ID}/members`;
const INVITATIONS = `GET /api/v1/organizations/${ORGANIZATION_ID}/invitations`;
const LOGOUT = "DELETE /api/v1/auth/sessions/current";

const UNAUTHENTICATED: Reply = { status: 401, body: { error: { code: "unauthenticated", message: "You need to sign in." } } };

const ORGANIZATION = { id: ORGANIZATION_ID, name: "Group", type: "group", logoId: null, role: "admin" } as const;
const CURRENT_USER: CurrentUserResponse = {
  user: { id: VIEWER_ID, email: "admin@example.com" },
  organization: ORGANIZATION,
  organizations: [ORGANIZATION],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};
const INVITATION: Invitation = {
  id: "0190a8b0-0000-7000-8000-0000000000cc",
  email: "invited@example.com",
  role: "contributor",
  invitedAt: "2026-10-01T12:00:00.000Z",
  expiresAt: "2026-10-08T12:00:00.000Z",
  isExpired: false,
};

let routes: Record<string, Route> = {};

/** A fresh client, with axios answering through `routes` (a request's query left out of its key). */
async function loadClient() {
  vi.resetModules();
  const { default: axios, AxiosError, AxiosHeaders } = await import("axios");
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const key = `${(config.method ?? "get").toUpperCase()} ${config.baseURL ?? ""}${(config.url ?? "").split("?")[0]}`;
    const route = routes[key];
    const reply = route ? await route() : { status: 404, body: { error: { code: "not_found", message: key } } };
    const response = {
      data: reply.body === undefined ? "" : JSON.stringify(reply.body),
      status: reply.status,
      statusText: "",
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
      request: {},
    };
    if (config.validateStatus ? config.validateStatus(reply.status) : true) return response;
    throw new AxiosError(`Request failed with status code ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response);
  };
  axios.defaults.adapter = adapter;
  return import("~/lib/api-client.js");
}

/** A reply the test sends when it chooses. */
function held(): { route: Route; answer: (reply: Reply) => void; reached: Promise<void> } {
  let answer!: (reply: Reply) => void;
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const reply = new Promise<Reply>((resolve) => {
    answer = resolve;
  });
  return {
    route: () => {
      arrived();
      return reply;
    },
    answer,
    reached,
  };
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {};
  assign = vi.fn();
  vi.stubGlobal("location", { pathname: "/org-admin", search: "", assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Logout from the Permissions page with a list's read in flight (D12 Ruling 40)", () => {
  it("the read's stray 401, arriving before /login's data, leaves the app up: no 'Oops!', the sidebar stays, only 'Logged out successfully'", async () => {
    const membersRead = held();
    routes[MEMBERS] = membersRead.route;
    routes[INVITATIONS] = () => ({ status: 200, body: { items: [INVITATION] } });
    routes[LOGOUT] = () => ({ status: 204 });
    const apiClient = await loadClient();
    // Watched, not replaced: the page's own read, so the test can wait for the page to have handled its answer.
    const getMembers = vi.spyOn(apiClient, "getMembers");
    const { toast } = await import("sonner");
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const { default: App, ErrorBoundary: RootErrorBoundary } = await import("../root.js");
    const { default: AppLayoutRoute, shouldRevalidate } = await import("./app-layout.js");
    const { default: OrgAdminRoute } = await import("./org-admin.js");
    const { default: OrgInvitedMembers } = await import("./org-admin/invited-members.js");
    const { default: OrgActiveMembers } = await import("./org-admin/active-members.js");
    const { default: OrgDeletedMembers } = await import("./org-admin/deleted-members.js");

    // Framework mode hands route modules their props; a data router doesn't, so they are handed here.
    const RootBoundary = RootErrorBoundary as unknown as ComponentType<{ error: unknown }>;
    const Layout = AppLayoutRoute as unknown as ComponentType<{ loaderData: AppLayoutData }>;
    let releaseLoginData!: () => void;
    const loginData = new Promise<void>((resolve) => {
      releaseLoginData = resolve;
    });
    const router = createMemoryRouter(
      [
        {
          id: "root",
          path: "/",
          loader: () => ({ publicWebUrl: null, analytics: null }),
          Component: App,
          ErrorBoundary: () => <RootBoundary error={useRouteError()} />,
          HydrateFallback: () => null,
          children: [
            {
              id: "routes/app-layout",
              loader: (): AppLayoutData => ({ status: "signed_in", currentUser: CURRENT_USER }),
              shouldRevalidate,
              Component: () => <Layout loaderData={useLoaderData<AppLayoutData>()} />,
              children: [
                {
                  path: "org-admin",
                  Component: OrgAdminRoute,
                  children: [
                    { index: true, Component: OrgInvitedMembers },
                    { path: "active-members", Component: OrgActiveMembers },
                    { path: "deleted-members", Component: OrgDeletedMembers },
                  ],
                },
              ],
            },
            {
              path: "login",
              loader: async () => {
                await loginData;
                return null;
              },
              Component: () => <p>login page</p>,
            },
          ],
        },
      ],
      { initialEntries: ["/org-admin"] },
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("invited@example.com")).toBeInTheDocument();
    await membersRead.reached;
    // React and React Router log an error that reaches a boundary.
    const consoleError = vi.spyOn(console, "error");

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Switch organization"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Logout" }));
    await waitFor(() => expect(router.state.navigation.location?.pathname).toBe("/login"));
    expect(success).toHaveBeenCalledWith("Logged out successfully");
    expect(await screen.findByText("Logged out successfully")).toBeInTheDocument();

    // The stray 401, while /login's data is still on its way. The page's read
    // is settled after the page's own handler of it has run.
    membersRead.answer(UNAUTHENTICATED);
    await act(async () => {
      await getMembers.mock.results[0]!.value.catch(() => undefined);
    });

    expect(screen.queryByText("Oops!")).not.toBeInTheDocument();
    expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    // The app is still up, the sidebar and the Permissions page with it, and Logout's toast.
    expect(screen.getByTitle("Switch organization")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Permissions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Organization" })).toBeInTheDocument();
    expect(screen.getByText("invited@example.com")).toBeInTheDocument();
    expect(screen.getByText("Logged out successfully")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/org-admin");
    expect(error).not.toHaveBeenCalled();

    releaseLoginData();
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.queryByTitle("Switch organization")).not.toBeInTheDocument();
    expect(screen.getByText("Logged out successfully")).toBeInTheDocument();
    expect(screen.queryByText("Oops!")).not.toBeInTheDocument();
    expect(success).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    // Logout's /login, not the session-ended handler's hard load of /login?redirectTo=….
    expect(assign).not.toHaveBeenCalled();
  });
});
