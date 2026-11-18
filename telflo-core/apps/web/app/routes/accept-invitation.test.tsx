import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse, type OidcProvider } from "@telflo/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import AcceptInvitationPage, {
  clientLoader,
  loader,
  meta,
  type AcceptInvitationData,
} from "./accept-invitation.js";
import { INVITATION_TOKEN_STORAGE_KEY } from "~/components/auth/AcceptInvitation.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { fetchCurrentUser, fetchOidcProviders } from "~/lib/api-client.server.js";
import { clearStoredToken } from "~/lib/address-bar-token.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn(), fetchOidcProviders: vi.fn() }));

const TOKEN = "the-token-from-the-link";
const GOOGLE: OidcProvider = { id: "google", name: "Google" };

const INVITEE: CurrentUserResponse = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "invitee@example.com" },
  organization: { id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

function loaderArgs(url: string): Parameters<typeof loader>[0] {
  return { request: new Request(url), params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
}

/** Client loader arguments whose `serverLoader` runs `serverLoader`. */
function clientLoaderArgs(serverLoader: () => Promise<AcceptInvitationData>): Parameters<typeof clientLoader>[0] {
  return {
    request: new Request("http://localhost/accept-invitation"),
    params: {},
    context: {},
    serverLoader,
  } as unknown as Parameters<typeof clientLoader>[0];
}

const REFRESH_NEEDED: AcceptInvitationData = { visitor: { status: "refresh_needed" }, providers: [GOOGLE] };

describe("accept-invitation loader", () => {
  beforeEach(() => {
    vi.mocked(fetchCurrentUser).mockReset();
    vi.mocked(fetchOidcProviders).mockReset().mockResolvedValue([GOOGLE]);
  });

  it("keeps a signed-in visitor on the page, since they may be the one invited", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: INVITEE });
    const args = loaderArgs("http://localhost/accept-invitation");

    await expect(loader(args)).resolves.toEqual({
      visitor: { status: "signed_in", currentUser: INVITEE },
      providers: [GOOGLE],
    });
    expect(fetchCurrentUser).toHaveBeenCalledWith(args.request);
    expect(fetchOidcProviders).toHaveBeenCalledWith(args.request);
  });

  it.each(["signed_out", "refresh_needed"] as const)("passes %s on to the page", async (status) => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status });

    await expect(loader(loaderArgs("http://localhost/accept-invitation"))).resolves.toEqual({
      visitor: { status },
      providers: [GOOGLE],
    });
  });

  it("shows the page without the Google button when the providers list fails", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_out" });
    vi.mocked(fetchOidcProviders).mockRejectedValue(new ApiError("network_error", "Could not reach the API."));

    await expect(loader(loaderArgs("http://localhost/accept-invitation"))).resolves.toEqual({
      visitor: { status: "signed_out" },
      providers: [],
    });
  });

  it("lets an API outage propagate instead of treating it as signed out", async () => {
    vi.mocked(fetchCurrentUser).mockRejectedValue(new ApiError("network_error", "Could not reach the API."));

    await expect(loader(loaderArgs("http://localhost/accept-invitation"))).rejects.toBeInstanceOf(ApiError);
  });
});

describe("accept-invitation client loader (D6 Preflight ruling 3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    clearStoredToken(INVITATION_TOKEN_STORAGE_KEY);
  });

  it("runs on hydration, so it can refresh what the server couldn't", () => {
    expect(clientLoader.hydrate).toBe(true);
  });

  it("takes the token out of the address bar before anything is asked of the server", async () => {
    window.history.replaceState(null, "", `/accept-invitation#token=${TOKEN}`);
    let hashWhenAsked: string | undefined;

    await clientLoader(
      clientLoaderArgs(async () => {
        hashWhenAsked = window.location.hash;
        return { visitor: { status: "signed_out" }, providers: [] };
      }),
    );

    expect(hashWhenAsked).toBe("");
    expect(window.sessionStorage.getItem("telflo.invitationToken")).toBe(TOKEN);
  });

  it("passes signed_in and signed_out through without asking the browser client", async () => {
    const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser");
    const signedIn: AcceptInvitationData = { visitor: { status: "signed_in", currentUser: INVITEE }, providers: [] };
    const signedOut: AcceptInvitationData = { visitor: { status: "signed_out" }, providers: [] };

    await expect(clientLoader(clientLoaderArgs(async () => signedIn))).resolves.toEqual(signedIn);
    await expect(clientLoader(clientLoaderArgs(async () => signedOut))).resolves.toEqual(signedOut);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token through the browser client, and returns signed_in", async () => {
    const getCurrentUser = vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(INVITEE);

    await expect(clientLoader(clientLoaderArgs(async () => REFRESH_NEEDED))).resolves.toEqual({
      visitor: { status: "signed_in", currentUser: INVITEE },
      providers: [GOOGLE],
    });
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("reads a refused refresh as signed out, with the session-ended handler suspended so nothing goes to /login", async () => {
    const release = vi.fn();
    const suspend = vi.spyOn(apiClient, "suspendSessionEndedHandler").mockReturnValue(release);
    vi.spyOn(apiClient, "getCurrentUser").mockImplementation(async () => {
      // The refresh is refused while the handler is suspended.
      expect(suspend).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      throw new ApiError("unauthenticated", "Your session has ended. Sign in again.");
    });

    await expect(clientLoader(clientLoaderArgs(async () => REFRESH_NEEDED))).resolves.toEqual({
      visitor: { status: "signed_out" },
      providers: [GOOGLE],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("lets any other failure reach the error boundary, and releases the handler", async () => {
    const release = vi.fn();
    vi.spyOn(apiClient, "suspendSessionEndedHandler").mockReturnValue(release);
    const failure = new ApiError("network_error", "Could not reach the server. Check your connection.");
    vi.spyOn(apiClient, "getCurrentUser").mockRejectedValue(failure);

    await expect(clientLoader(clientLoaderArgs(async () => REFRESH_NEEDED))).rejects.toBe(failure);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("accept-invitation page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    clearStoredToken(INVITATION_TOKEN_STORAGE_KEY);
  });

  function renderRoute(serverData: AcceptInvitationData) {
    window.history.replaceState(null, "", `/accept-invitation#token=${TOKEN}`);
    const Stub = createRoutesStub([
      {
        path: "/accept-invitation",
        Component: AcceptInvitationPage as unknown as React.ComponentType,
        loader: () => clientLoader(clientLoaderArgs(async () => serverData)),
        HydrateFallback: () => null,
      },
    ]);
    return render(<Stub initialEntries={["/accept-invitation"]} />);
  }

  it("shows the signed-in state to a visitor whose access token expired but whose refresh token is live", async () => {
    vi.spyOn(apiClient, "getCurrentUser").mockResolvedValue(INVITEE);
    vi.spyOn(apiClient, "previewInvitation").mockResolvedValue({
      invitation: { organizationName: "Group", organizationType: "group", email: "invitee@example.com", role: "contributor", status: "pending", hasAccount: true, mayRegister: true },
    });
    renderRoute(REFRESH_NEEDED);

    expect(await screen.findByRole("heading", { name: "Join Group" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept Invitation" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("shows the sign-in form when the refresh is refused", async () => {
    vi.spyOn(apiClient, "getCurrentUser").mockRejectedValue(
      new ApiError("unauthenticated", "Your session has ended. Sign in again."),
    );
    vi.spyOn(apiClient, "previewInvitation").mockResolvedValue({
      invitation: { organizationName: "Group", organizationType: "group", email: "invitee@example.com", role: "contributor", status: "pending", hasAccount: true, mayRegister: true },
    });
    renderRoute(REFRESH_NEEDED);

    expect(await screen.findByRole("heading", { name: "Sign in to join Group" })).toBeInTheDocument();
  });

  it("suspends the session-ended handler while it is shown, in the auth shell", async () => {
    const release = vi.fn();
    const suspend = vi.spyOn(apiClient, "suspendSessionEndedHandler").mockReturnValue(release);
    vi.spyOn(apiClient, "previewInvitation").mockReturnValue(new Promise(() => {}));
    const { unmount } = renderRoute({ visitor: { status: "signed_out" }, providers: [] });

    expect(await screen.findByText("Processing your invitation...")).toBeInTheDocument();
    // The auth shell marks <body> in an effect, which can come after the text appears under load (D8 Ruling 33).
    await waitFor(() => expect(document.body).toHaveClass("tf-app"));
    expect(suspend).toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    unmount();
    expect(release).toHaveBeenCalled();
  });

  it("has its title and description, is kept out of search indexes, and sends no Referer", () => {
    expect(meta({} as Parameters<typeof meta>[0])).toEqual([
      { title: "Accept Invitation - Telflo" },
      { name: "description", content: "Accept your organization invitation to Telflo" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex" },
    ]);
  });
});
