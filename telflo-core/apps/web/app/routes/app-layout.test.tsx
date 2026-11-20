import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse } from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, createRoutesStub, redirect, useLocation } from "react-router";
import AppLayoutRoute, { clientLoader, loader, shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import { SAAS_SITE, underSite } from "~/test/site.js";
import * as welcomeTour from "~/components/layout/org-welcome-tour.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { fetchCurrentUser } from "~/lib/api-client.server.js";
import { numberPreferenceRead, useUserStore } from "~/lib/stores/user-store.js";
import { useRememberedTheme } from "~/lib/theme.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

const SIGNED_IN_USER: CurrentUserResponse = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
  organization: { id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

/**
 * A page under the layout. The real `/app` page loads configurations, which
 * these tests aren't about; its own tests are `configurations.test.tsx`.
 */
function ChildPage() {
  return (
    <>
      <h1>Configurations</h1>
      <p>The page under the layout.</p>
    </>
  );
}

function loaderArgs(url: string): Parameters<typeof loader>[0] {
  return { request: new Request(url), params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
}

/** Client loader arguments whose `serverLoader` runs `serverLoader`. */
function clientLoaderArgs(serverLoader: () => Promise<AppLayoutData>): Parameters<typeof clientLoader>[0] {
  return {
    request: new Request("http://localhost/app"),
    params: {},
    context: {},
    serverLoader,
  } as unknown as Parameters<typeof clientLoader>[0];
}

/** What `run` threw, or a failure if it resolved. */
async function rejectionOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error("resolved instead of throwing");
    },
    (caught: unknown) => caught,
  );
}

describe("app layout loader", () => {
  beforeEach(() => {
    vi.mocked(fetchCurrentUser).mockReset();
  });

  it("sends a signed-out visitor to sign in, and back to the page afterwards", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_out" });

    const thrown = await rejectionOf(loader(loaderArgs("http://localhost/app?x=1")));

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get("location")).toBe("/login?redirectTo=%2Fapp%3Fx%3D1");
  });

  it("says a refresh is needed, rather than redirecting, when the access token has expired", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "refresh_needed" });

    await expect(loader(loaderArgs("http://localhost/app"))).resolves.toEqual({ status: "refresh_needed" });
  });

  it("returns the current user when there is a session, forwarding the request", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: SIGNED_IN_USER });
    const args = loaderArgs("http://localhost/app");

    await expect(loader(args)).resolves.toEqual({ status: "signed_in", currentUser: SIGNED_IN_USER });
    expect(fetchCurrentUser).toHaveBeenCalledWith(args.request);
  });

  it("lets an API failure surface as an error rather than a redirect", async () => {
    vi.mocked(fetchCurrentUser).mockRejectedValue(new ApiError("network_error", "Could not reach the API."));

    await expect(loader(loaderArgs("http://localhost/app"))).rejects.toBeInstanceOf(ApiError);
  });
});

describe("app layout client loader", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("runs on hydration, so it can refresh what the server couldn't", () => {
    expect(clientLoader.hydrate).toBe(true);
  });

  it("asks the browser client for the current user when a refresh is needed, and returns signed_in", async () => {
    const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(SIGNED_IN_USER);

    await expect(clientLoader(clientLoaderArgs(async () => ({ status: "refresh_needed" })))).resolves.toEqual({
      status: "signed_in",
      currentUser: SIGNED_IN_USER,
      preferencesReadAt: expect.any(Number),
    });
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("passes signed_in through without asking the browser client", async () => {
    const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser");
    const signedIn: AppLayoutData = { status: "signed_in", currentUser: SIGNED_IN_USER };

    await expect(clientLoader(clientLoaderArgs(async () => signedIn))).resolves.toEqual({
      ...signedIn,
      preferencesReadAt: expect.any(Number),
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("numbers its /me read before asking, so a save sent meanwhile counts as newer", async () => {
    let sentMeanwhile = 0;
    const data = await clientLoader(
      clientLoaderArgs(async () => {
        sentMeanwhile = numberPreferenceRead();
        return { status: "signed_in", currentUser: SIGNED_IN_USER };
      }),
    );
    if (data.status !== "signed_in") throw new Error("not signed in");
    expect(data.preferencesReadAt).toBeLessThan(sentMeanwhile);
  });

  it("lets the server loader's redirect through without asking the browser client", async () => {
    const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser");
    const toLogin = redirect("/login?redirectTo=%2Fapp");

    const thrown = await rejectionOf(
      clientLoader(
        clientLoaderArgs(async () => {
          throw toLogin;
        }),
      ),
    );

    expect(thrown).toBe(toLogin);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("sends the browser to sign in, and back to this page afterwards, when the session is over", async () => {
    // Whether the refresh was refused or the session was revoked just after
    // it, the layout doesn't rely on the session-ended handler.
    window.history.pushState({}, "", "/app?tab=yaml&x=1");
    vi.spyOn(apiClient, "getCurrentUser").mockRejectedValue(
      new ApiError("unauthenticated", "Your session has ended. Sign in again."),
    );

    const thrown = await rejectionOf(clientLoader(clientLoaderArgs(async () => ({ status: "refresh_needed" }))));

    if (!(thrown instanceof Response)) throw thrown;
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get("location")).toBe("/login?redirectTo=%2Fapp%3Ftab%3Dyaml%26x%3D1");
  });

  it("lets any other failure reach the error boundary", async () => {
    const failure = new ApiError("network_error", "Could not reach the server. Check your connection.");
    vi.spyOn(apiClient, "getCurrentUser").mockRejectedValue(failure);

    const thrown = await rejectionOf(clientLoader(clientLoaderArgs(async () => ({ status: "refresh_needed" }))));

    expect(thrown).toBe(failure);
  });
});

describe("app layout route", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  it("seeds the user store and renders the page inside the sidebar shell", async () => {
    const Stub = createRoutesStub([
      {
        id: "routes/app-layout",
        Component: AppLayoutRoute as unknown as React.ComponentType,
        loader: (): AppLayoutData => ({ status: "signed_in", currentUser: SIGNED_IN_USER }),
        HydrateFallback: () => null,
        children: [{ path: "/app", Component: ChildPage }],
      },
    ]);
    render(<Stub initialEntries={["/app"]} />);

    expect(await screen.findByRole("heading", { name: "Configurations" })).toBeInTheDocument();
    expect(screen.getByText("The page under the layout.")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    const { termsAcceptanceRequired: _flag, ...stored } = SIGNED_IN_USER;
    await waitFor(() => expect(useUserStore.getState().current).toEqual(stored));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  describe("the terms dialog", () => {
    const REQUIRES_TERMS: CurrentUserResponse = { ...SIGNED_IN_USER, termsAcceptanceRequired: true };

    function renderLayout(loader: () => AppLayoutData | Promise<AppLayoutData>) {
      const layoutLoader = vi.fn(loader);
      const Stub = createRoutesStub(underSite(SAAS_SITE, [
        {
          id: "routes/app-layout",
          Component: AppLayoutRoute as unknown as React.ComponentType,
          loader: layoutLoader,
          shouldRevalidate,
          HydrateFallback: () => null,
          children: [{ path: "/app", Component: ChildPage }],
        },
      ]));
      render(<Stub initialEntries={["/app"]} />);
      return layoutLoader;
    }

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("shows the dialog over the shell while terms acceptance is required", async () => {
      renderLayout(() => ({ status: "signed_in", currentUser: REQUIRES_TERMS }));

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      // The shell is still rendered beneath it.
      expect(screen.getByText("Workspace")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Configurations", hidden: true })).toBeInTheDocument();
    });

    it("shows no dialog when the current terms are accepted", async () => {
      renderLayout(() => ({ status: "signed_in", currentUser: SIGNED_IN_USER }));

      expect(await screen.findByRole("heading", { name: "Configurations" })).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes the dialog after Accept, once the revalidated /me no longer requires it", async () => {
      const acceptTerms = vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      let currentUser = REQUIRES_TERMS;
      const layoutLoader = renderLayout(() => ({ status: "signed_in", currentUser }));
      const dialog = await screen.findByRole("dialog", { name: "Updated Terms of Service" });
      const user = userEvent.setup();
      currentUser = SIGNED_IN_USER;

      await user.click(within(dialog).getByLabelText("I agree to the Terms of Service and Privacy Policy"));
      await user.click(within(dialog).getByRole("button", { name: "Accept" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(acceptTerms).toHaveBeenCalledTimes(1);
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("heading", { name: "Configurations" })).toBeInTheDocument();
    });

    it("shows the dialog when the client loader's refresh path answers", async () => {
      // The server loader said a refresh was needed; the browser client's
      // /me, after its refresh, says the terms need accepting.
      const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(REQUIRES_TERMS);
      renderLayout(() => clientLoader(clientLoaderArgs(async () => ({ status: "refresh_needed" }))));

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      expect(getCurrentUser).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Workspace")).toBeInTheDocument();
    });
  });

  it("renders a busy placeholder, not the sidebar or the page, and seeds nothing while a refresh is needed", async () => {
    const Stub = createRoutesStub([
      {
        id: "routes/app-layout",
        Component: AppLayoutRoute as unknown as React.ComponentType,
        loader: (): AppLayoutData => ({ status: "refresh_needed" }),
        HydrateFallback: () => null,
        children: [{ path: "/app", Component: ChildPage }],
      },
    ]);
    const { container } = render(<Stub initialEntries={["/app"]} />);

    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
    // The app's floor in the cookie's theme, not Tailwind's palette.
    expect(container.querySelector('[aria-busy="true"]')).toHaveClass("tf-app");
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Configurations" })).not.toBeInTheDocument();
    expect(useUserStore.getState().current).toBeNull();
  });

  it("revalidates on a navigation between two different child paths", async () => {
    // React Router's default keeps a pathless layout's data here, so a
    // navigation after the access token expired would skip the refresh.
    const layoutLoader = vi.fn((): AppLayoutData => ({ status: "signed_in", currentUser: SIGNED_IN_USER }));
    const Stub = createRoutesStub([
      {
        id: "routes/app-layout",
        Component: AppLayoutRoute as unknown as React.ComponentType,
        loader: layoutLoader,
        shouldRevalidate,
        HydrateFallback: () => null,
        children: [
          { path: "/app", Component: () => <Link to="/app/other">Other page</Link> },
          { path: "/app/other", Component: () => <h1>Other page</h1> },
        ],
      },
    ]);
    render(<Stub initialEntries={["/app"]} />);

    fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

    expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
    expect(layoutLoader).toHaveBeenCalledTimes(2);
    expect(
      shouldRevalidate({
        currentUrl: new URL("http://localhost/app"),
        nextUrl: new URL("http://localhost/app/other"),
        defaultShouldRevalidate: false,
      } as unknown as Parameters<typeof shouldRevalidate>[0]),
    ).toBe(true);
  });

  describe("re-seeding the user store", () => {
    const GROUP = { id: "00000000-0000-4000-8000-000000000003", name: "Group", type: "group", logoId: null, role: "contributor" } as const;
    const WITH_GROUP: CurrentUserResponse = {
      ...SIGNED_IN_USER,
      organizations: [...SIGNED_IN_USER.organizations, GROUP],
    };

    /** The layout with two pages, answering `first` and then `next` for every later load. */
    function renderRevalidating(first: CurrentUserResponse, next: CurrentUserResponse) {
      let answer = first;
      const layoutLoader = vi.fn((): AppLayoutData => {
        const currentUser = answer;
        answer = next;
        return { status: "signed_in", currentUser };
      });
      const Stub = createRoutesStub([
        {
          id: "routes/app-layout",
          Component: AppLayoutRoute as unknown as React.ComponentType,
          loader: layoutLoader,
          shouldRevalidate,
          HydrateFallback: () => null,
          children: [
            { path: "/app", Component: () => <Link to="/app/other">Other page</Link> },
            { path: "/app/other", Component: () => <h1>Other page</h1> },
          ],
        },
      ]);
      render(<Stub initialEntries={["/app"]} />);
      return layoutLoader;
    }

    it("re-seeds when the active organization changes", async () => {
      const switched: CurrentUserResponse = { ...WITH_GROUP, organization: GROUP };
      const layoutLoader = renderRevalidating(WITH_GROUP, switched);
      await waitFor(() => expect(useUserStore.getState().current?.organization.id).toBe(SIGNED_IN_USER.organization.id));

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(useUserStore.getState().current?.organization).toEqual(GROUP));
    });

    it("doesn't re-seed on a revalidation whose answer is unchanged", async () => {
      // The store learns of a rename another way (the Edit dialog), so a
      // re-seed from the same answer again would show.
      const layoutLoader = renderRevalidating(WITH_GROUP, WITH_GROUP);
      await waitFor(() => expect(useUserStore.getState().current?.organizations).toHaveLength(2));
      useUserStore.getState().updateOrganization(GROUP.id, { name: "Renamed", logoId: null });

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      expect(useUserStore.getState().current?.organizations[1]?.name).toBe("Renamed");
    });

    it("re-seeds when the list of organizations changes, so a restored membership shows in the switcher", async () => {
      const layoutLoader = renderRevalidating(SIGNED_IN_USER, WITH_GROUP);
      await waitFor(() => expect(useUserStore.getState().current?.organizations).toHaveLength(1));

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(useUserStore.getState().current?.organizations).toEqual(WITH_GROUP.organizations));
    });

    it("re-seeds when the role in the active organization changes, so a demoted admin loses Permissions", async () => {
      const admin: CurrentUserResponse = { ...WITH_GROUP, organization: { ...GROUP, role: "admin" } };
      const demoted: CurrentUserResponse = { ...WITH_GROUP, organization: GROUP };
      renderRevalidating(admin, demoted);
      expect(await screen.findByRole("link", { name: "Permissions" })).toBeInTheDocument();

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      await waitFor(() => expect(useUserStore.getState().current?.organization.role).toBe("contributor"));
      expect(screen.queryByRole("link", { name: "Permissions" })).not.toBeInTheDocument();
    });

    it("re-seeds when the product-admin flag changes, so a revocation reaches the store on the next navigation", async () => {
      const productAdmin: CurrentUserResponse = { ...SIGNED_IN_USER, isProductAdmin: true };
      const layoutLoader = renderRevalidating(productAdmin, SIGNED_IN_USER);
      await waitFor(() => expect(useUserStore.getState().current?.isProductAdmin).toBe(true));

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(useUserStore.getState().current?.isProductAdmin).toBe(false));
    });

    it("re-seeds the store when only the preferences change", async () => {
      const navy: CurrentUserResponse = {
        ...SIGNED_IN_USER,
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: "navy", editor: { ...DEFAULT_USER_PREFERENCES.editor, fontSize: 16 } },
      };
      const layoutLoader = renderRevalidating(SIGNED_IN_USER, navy);
      await waitFor(() => expect(useUserStore.getState().current?.preferences).toEqual(DEFAULT_USER_PREFERENCES));

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(useUserStore.getState().current?.preferences).toEqual(navy.preferences));
    });

    it("another tab's revert reaches the store, though /me says again what it said before this tab's save", async () => {
      // /me answers 13 both times: this tab saved 16 between them, another tab set 13 again.
      const layoutLoader = renderRevalidating(SIGNED_IN_USER, SIGNED_IN_USER);
      await waitFor(() => expect(useUserStore.getState().current?.preferences.editor.fontSize).toBe(13));
      const sequence = useUserStore.getState().setPreference("editor.fontSize", 16)!;
      const answer = { ...DEFAULT_USER_PREFERENCES, editor: { ...DEFAULT_USER_PREFERENCES.editor, fontSize: 16 as const } };
      expect(useUserStore.getState().takePreferenceAnswer("editor.fontSize", sequence, answer)).toBe(true);
      expect(useUserStore.getState().current?.preferences.editor.fontSize).toBe(16);

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(useUserStore.getState().current?.preferences.editor.fontSize).toBe(13));
      expect(useUserStore.getState().confirmedPreferences?.editor.fontSize).toBe(13);
    });

    it("re-seeds only the preferences, leaving a name the Edit dialog renamed", async () => {
      const navy: CurrentUserResponse = { ...WITH_GROUP, preferences: { ...DEFAULT_USER_PREFERENCES, theme: "navy" } };
      renderRevalidating(WITH_GROUP, navy);
      await waitFor(() => expect(useUserStore.getState().current?.organizations).toHaveLength(2));
      useUserStore.getState().updateOrganization(GROUP.id, { name: "Renamed", logoId: null });

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      await waitFor(() => expect(useUserStore.getState().current?.preferences.theme).toBe("navy"));
      expect(useUserStore.getState().current?.organizations[1]?.name).toBe("Renamed");
    });

    it("remembers the stored theme when it changes", async () => {
      // What the auth screens render after Logout's client-side way to /login.
      function Remembered() {
        return <p>remembered: {useRememberedTheme() ?? "none"}</p>;
      }
      const navy: CurrentUserResponse = { ...SIGNED_IN_USER, preferences: { ...DEFAULT_USER_PREFERENCES, theme: "navy" } };
      const light: CurrentUserResponse = { ...SIGNED_IN_USER, preferences: { ...DEFAULT_USER_PREFERENCES, theme: "light" } };
      let answer = navy;
      const Stub = createRoutesStub([
        {
          id: "routes/app-layout",
          Component: AppLayoutRoute as unknown as React.ComponentType,
          loader: (): AppLayoutData => ({ status: "signed_in", currentUser: answer }),
          shouldRevalidate,
          HydrateFallback: () => null,
          children: [
            {
              path: "/app",
              Component: () => (
                <>
                  <Remembered />
                  <Link to="/app/other">Other page</Link>
                </>
              ),
            },
            { path: "/app/other", Component: () => <Remembered /> },
          ],
        },
      ]);
      render(<Stub initialEntries={["/app"]} />);
      expect(await screen.findByText("remembered: navy")).toBeInTheDocument();

      // Another browser changed it: the next revalidation brings it.
      answer = light;
      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));
      expect(await screen.findByText("remembered: light")).toBeInTheDocument();

      // Appearance's optimistic choice in the store, before any answer.
      act(() => {
        const current = useUserStore.getState().current!;
        useUserStore.setState({ current: { ...current, preferences: { ...current.preferences, theme: "navy" } } });
      });
      expect(await screen.findByText("remembered: navy")).toBeInTheDocument();
    });

    it("re-seeds when the user changes", async () => {
      const other: CurrentUserResponse = {
        ...SIGNED_IN_USER,
        user: { id: "00000000-0000-4000-8000-000000000009", email: "other@example.com" },
      };
      renderRevalidating(SIGNED_IN_USER, other);
      await waitFor(() => expect(useUserStore.getState().current?.user.email).toBe("person@example.com"));

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      await waitFor(() => expect(useUserStore.getState().current?.user.email).toBe("other@example.com"));
    });
  });

  describe("the welcome callout after joining", () => {
    const JOINED = { id: "00000000-0000-4000-8000-000000000004", name: "Joined Group", type: "group", logoId: null, role: "contributor" } as const;
    const WITH_JOINED: CurrentUserResponse = {
      ...SIGNED_IN_USER,
      organization: JOINED,
      organizations: [...SIGNED_IN_USER.organizations, JOINED],
    };

    /** Where the page is, as the router has it. */
    function Search() {
      const location = useLocation();
      return <p>search: [{location.search}]</p>;
    }

    function renderAt(url: string, loader: () => AppLayoutData) {
      const layoutLoader = vi.fn(loader);
      const Stub = createRoutesStub(underSite(SAAS_SITE, [
        {
          id: "routes/app-layout",
          Component: AppLayoutRoute as unknown as React.ComponentType,
          loader: layoutLoader,
          shouldRevalidate,
          HydrateFallback: () => null,
          children: [{ path: "/app", Component: Search }],
        },
      ]));
      // Strict, as the app runs in development: effects run twice there, and
      // the callout must still start once.
      render(
        <StrictMode>
          <Stub initialEntries={[url]} />
        </StrictMode>,
      );
      return layoutLoader;
    }

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("starts the callout once for a listed organization, and removes joined_org from the URL", async () => {
      const startTour = vi.spyOn(welcomeTour, "startOrgWelcomeTour").mockImplementation(() => {});
      renderAt(`/app?joined_org=${JOINED.id}&x=1`, () => ({ status: "signed_in", currentUser: WITH_JOINED }));

      expect(await screen.findByText("search: [?x=1]")).toBeInTheDocument();
      expect(startTour).toHaveBeenCalledTimes(1);
      expect(startTour).toHaveBeenCalledWith("Joined Group", "group");
    });

    it("hands the callout a personal organization's type with its name, for its <email>'s organization words", async () => {
      const startTour = vi.spyOn(welcomeTour, "startOrgWelcomeTour").mockImplementation(() => {});
      const personal = { id: "00000000-0000-4000-8000-000000000005", name: "owner@example.com", type: "personal", logoId: null, role: "contributor" } as const;
      renderAt(`/app?joined_org=${personal.id}`, () => ({
        status: "signed_in",
        currentUser: { ...SIGNED_IN_USER, organization: personal, organizations: [...SIGNED_IN_USER.organizations, personal] },
      }));

      expect(await screen.findByText("search: []")).toBeInTheDocument();
      expect(startTour).toHaveBeenCalledTimes(1);
      expect(startTour).toHaveBeenCalledWith("owner@example.com", "personal");
    });

    it("removes an unknown organization's id and does nothing else", async () => {
      const startTour = vi.spyOn(welcomeTour, "startOrgWelcomeTour").mockImplementation(() => {});
      renderAt("/app?joined_org=00000000-0000-4000-8000-000000000099", () => ({
        status: "signed_in",
        currentUser: WITH_JOINED,
      }));

      expect(await screen.findByText("search: []")).toBeInTheDocument();
      expect(startTour).not.toHaveBeenCalled();
    });

    it("waits for the terms: joined_org stays until they are accepted, then the callout starts", async () => {
      const startTour = vi.spyOn(welcomeTour, "startOrgWelcomeTour").mockImplementation(() => {});
      vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      let currentUser: CurrentUserResponse = { ...WITH_JOINED, termsAcceptanceRequired: true };
      renderAt(`/app?joined_org=${JOINED.id}`, () => ({ status: "signed_in", currentUser }));

      const dialog = await screen.findByRole("dialog", { name: "Updated Terms of Service" });
      expect(screen.getByText(`search: [?joined_org=${JOINED.id}]`)).toBeInTheDocument();
      expect(startTour).not.toHaveBeenCalled();

      currentUser = WITH_JOINED;
      const user = userEvent.setup();
      await user.click(within(dialog).getByLabelText("I agree to the Terms of Service and Privacy Policy"));
      await user.click(within(dialog).getByRole("button", { name: "Accept" }));

      expect(await screen.findByText("search: []")).toBeInTheDocument();
      expect(startTour).toHaveBeenCalledTimes(1);
      expect(startTour).toHaveBeenCalledWith("Joined Group", "group");
    });

    it("does nothing without joined_org", async () => {
      const startTour = vi.spyOn(welcomeTour, "startOrgWelcomeTour").mockImplementation(() => {});
      renderAt("/app?x=1", () => ({ status: "signed_in", currentUser: WITH_JOINED }));

      expect(await screen.findByText("search: [?x=1]")).toBeInTheDocument();
      expect(startTour).not.toHaveBeenCalled();
    });
  });

  describe("identifying the user to PostHog", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const OTHER: CurrentUserResponse = {
      ...SIGNED_IN_USER,
      user: { id: "00000000-0000-4000-8000-000000000009", email: "other@example.com" },
    };

    /** The layout with two pages, answering each load with the next of `answers` (the last one repeating). */
    function renderAnswering(...answers: AppLayoutData[]) {
      const layoutLoader = vi.fn((): AppLayoutData => (answers.length > 1 ? answers.shift() : answers[0])!);
      const Stub = createRoutesStub([
        {
          id: "routes/app-layout",
          Component: AppLayoutRoute as unknown as React.ComponentType,
          loader: layoutLoader,
          shouldRevalidate,
          HydrateFallback: () => null,
          children: [
            { path: "/app", Component: () => <Link to="/app/other">Other page</Link> },
            { path: "/app/other", Component: () => <h1>Other page</h1> },
          ],
        },
      ]);
      render(<Stub initialEntries={["/app"]} />);
      return layoutLoader;
    }

    it("identifies the signed-in user by id and email once, not again on a revalidation", async () => {
      const identify = vi.spyOn(analytics, "identifyUser");
      const layoutLoader = renderAnswering({ status: "signed_in", currentUser: SIGNED_IN_USER });

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      expect(await screen.findByRole("heading", { name: "Other page" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      expect(identify).toHaveBeenCalledTimes(1);
      expect(identify).toHaveBeenCalledWith(SIGNED_IN_USER.user.id, "person@example.com");
    });

    it("identifies the new user when the session's user changes", async () => {
      const identify = vi.spyOn(analytics, "identifyUser");
      renderAnswering(
        { status: "signed_in", currentUser: SIGNED_IN_USER },
        { status: "signed_in", currentUser: OTHER },
      );

      fireEvent.click(await screen.findByRole("link", { name: "Other page" }));

      await waitFor(() => expect(identify).toHaveBeenCalledTimes(2));
      expect(identify).toHaveBeenLastCalledWith(OTHER.user.id, "other@example.com");
    });

    it("identifies nobody while a refresh is needed", async () => {
      const identify = vi.spyOn(analytics, "identifyUser");
      renderAnswering({ status: "refresh_needed" });

      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
      expect(identify).not.toHaveBeenCalled();
    });
  });
});
