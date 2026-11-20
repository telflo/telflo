import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_PREFERENCES,
  PASSWORD_MINIMUM_LENGTH,
  type CurrentUserResponse,
  type InvitationPreviewResponse,
  type OidcProvider,
} from "@telflo/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLoaderData, useLocation } from "react-router";
import { AcceptInvitation, INVITATION_TOKEN_STORAGE_KEY, type InvitationVisitor } from "./AcceptInvitation.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { clearStoredToken } from "~/lib/address-bar-token.js";
import { useUserStore } from "~/lib/stores/user-store.js";

const TOKEN = "the-token-from-the-link";
// The messages as literals, not the contracts' constants, so a typo in one fails here.
const INVALID_LINK_MESSAGE = "Invalid or expired invite link. Please ask your admin to resend the invitation.";
const EXPIRED_LINK_MESSAGE = "This invitation link has expired. Please ask your admin to resend the invitation.";
const ALREADY_ACCEPTED_MESSAGE = "This invitation has already been accepted.";
// A literal, not the page's constant, so a change to the key fails here.
const STORAGE_KEY = "telflo.invitationToken";
const TERMS_VERSION = "2026-01-01";
/** The site's Terms. */
const TERMS = { version: TERMS_VERSION, termsUrl: "/home/terms-of-service", privacyUrl: "https://legal.example.com/privacy" };
const GROUP_ID = "00000000-0000-4000-8000-000000000003";
const GOOGLE: OidcProvider = { id: "google", name: "Google" };

const INVITATION: InvitationPreviewResponse["invitation"] = {
  organizationName: "Group",
  organizationType: "group",
  email: "invitee@example.com",
  role: "contributor",
  status: "pending",
  hasAccount: true,
  mayRegister: true,
};

const JOINED = { organization: { id: GROUP_ID, name: "Group", type: "group", logoId: null, role: "contributor" } } as const;

function signedInAs(email: string): InvitationVisitor {
  const personal = { id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" } as const;
  const currentUser: CurrentUserResponse = {
    user: { id: "00000000-0000-4000-8000-000000000001", email },
    organization: personal,
    organizations: [personal],
    termsAcceptanceRequired: false,
    isProductAdmin: false,
    mayCreateOrganizations: true,
    preferences: DEFAULT_USER_PREFERENCES,
  };
  return { status: "signed_in", currentUser };
}

const SIGNED_OUT: InvitationVisitor = { status: "signed_out" };

/** Where the page went after joining. */
function Landed() {
  const location = useLocation();
  return <p>landed on {location.pathname + location.search}</p>;
}

/**
 * The page at `/accept-invitation`, its link's fragment in the document's
 * URL as a browser would have it (the router gets the path alone). The
 * visitor comes from a loader, so a revalidation reads it again.
 */
function renderPage({
  visitor,
  providers = [],
  hash = `#token=${TOKEN}`,
  terms = TERMS,
}: {
  visitor: InvitationVisitor | (() => InvitationVisitor);
  providers?: readonly OidcProvider[];
  hash?: string;
  /** The site's Terms; null for a site that asks for none. */
  terms?: typeof TERMS | null;
}) {
  window.history.replaceState(null, "", `/accept-invitation${hash}`);
  const loader = vi.fn(() => ({ visitor: typeof visitor === "function" ? visitor() : visitor }));
  const Stub = createRoutesStub([
    {
      path: "/accept-invitation",
      loader,
      HydrateFallback: () => null,
      Component: function Page() {
        const data = useLoaderData<{ visitor: InvitationVisitor }>();
        return <AcceptInvitation visitor={data.visitor} providers={providers} terms={terms} />;
      },
    },
    { path: "/app", Component: Landed },
    { path: "/forgot-password", Component: () => <p>forgot password page</p> },
  ]);
  render(<Stub initialEntries={["/accept-invitation"]} />);
  return { loader };
}

/**
 * A second link pasted into the open tab: the browser changes only the
 * fragment, pushing an entry, and fires `hashchange`; nothing loads.
 */
function pasteLink(token: string) {
  act(() => {
    window.history.pushState(null, "", `/accept-invitation#token=${token}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

function previewAnswers(invitation: InvitationPreviewResponse["invitation"]) {
  return vi.spyOn(apiClient, "previewInvitation").mockResolvedValue({ invitation });
}

describe("AcceptInvitation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    clearStoredToken(INVITATION_TOKEN_STORAGE_KEY);
    useUserStore.getState().clear();
  });

  describe("the link", () => {
    it("shows the invalid-link alert, and asks nothing, when there is no token", async () => {
      const preview = vi.spyOn(apiClient, "previewInvitation");
      renderPage({ visitor: SIGNED_OUT, hash: "" });

      expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
      expect(screen.queryByRole("link", { name: "Go to Telflo" })).not.toBeInTheDocument();
      expect(preview).not.toHaveBeenCalled();
    });

    it("says the loading text while the preview loads", async () => {
      vi.spyOn(apiClient, "previewInvitation").mockReturnValue(new Promise(() => {}));
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByText("Processing your invitation...")).toBeInTheDocument();
    });

    it("says the loading text, and offers nothing, while the access token awaits its refresh", async () => {
      const preview = previewAnswers(INVITATION);
      renderPage({ visitor: { status: "refresh_needed" } });

      await waitFor(() => expect(preview).toHaveBeenCalled());
      expect(screen.getByText("Processing your invitation...")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("previews with the fragment's token, in the body, and takes the token out of the address bar", async () => {
      const preview = previewAnswers(INVITATION);
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByText("Sign in to join Group")).toBeInTheDocument();
      expect(preview).toHaveBeenCalledWith({ token: TOKEN });
      expect(window.location.hash).toBe("");
      expect(window.location.href).not.toContain(TOKEN);
    });

    it("previews with the token kept in sessionStorage when the page is loaded again without the fragment", async () => {
      // As on the way back from Google.
      window.sessionStorage.setItem(STORAGE_KEY, TOKEN);
      const preview = previewAnswers(INVITATION);
      renderPage({ visitor: SIGNED_OUT, hash: "" });

      expect(await screen.findByText("Sign in to join Group")).toBeInTheDocument();
      expect(preview).toHaveBeenCalledWith({ token: TOKEN });
    });

    it("previews with the fragment's token for as long as the page lasts when sessionStorage refuses it", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      });
      const preview = previewAnswers(INVITATION);
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByText("Sign in to join Group")).toBeInTheDocument();
      expect(preview).toHaveBeenCalledWith({ token: TOKEN });
      expect(window.location.hash).toBe("");
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("takes a second link's token when only the fragment changes, and previews that invitation instead", async () => {
      const preview = vi
        .spyOn(apiClient, "previewInvitation")
        .mockImplementation(async ({ token }) => ({
          invitation: token === TOKEN ? INVITATION : { ...INVITATION, organizationName: "Second Group" },
        }));
      renderPage({ visitor: SIGNED_OUT });
      expect(await screen.findByText("Sign in to join Group")).toBeInTheDocument();

      pasteLink("the-second-token");

      expect(await screen.findByText("Sign in to join Second Group")).toBeInTheDocument();
      expect(preview).toHaveBeenLastCalledWith({ token: "the-second-token" });
      expect(window.location.hash).toBe("");
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe("the-second-token");
    });

    it("clears the last link's failure when a second link arrives", async () => {
      const preview = vi.spyOn(apiClient, "previewInvitation").mockImplementation(async ({ token }) => {
        if (token === TOKEN) throw new ApiError("invitation_not_found", INVALID_LINK_MESSAGE);
        return { invitation: INVITATION };
      });
      const accept = vi
        .spyOn(apiClient, "acceptInvitation")
        .mockRejectedValue(new ApiError("invitation_expired", EXPIRED_LINK_MESSAGE));
      renderPage({ visitor: signedInAs(INVITATION.email) });
      expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);

      pasteLink("the-second-token");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Accept Invitation" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(EXPIRED_LINK_MESSAGE);
      expect(accept).toHaveBeenCalledWith({ token: "the-second-token" });

      // A third link: the second's refusal goes with it.
      pasteLink("the-third-token");
      await waitFor(() => expect(preview).toHaveBeenLastCalledWith({ token: "the-third-token" }));
      expect(await screen.findByRole("button", { name: "Accept Invitation" })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps a second link's token, and shows nothing of the first's refusal, when a join answers after the second arrived", async () => {
      previewAnswers(INVITATION);
      let refuseFirst: (error: unknown) => void = () => {};
      vi.spyOn(apiClient, "acceptInvitation").mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            refuseFirst = reject;
          }),
      );
      renderPage({ visitor: signedInAs(INVITATION.email) });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Accept Invitation" }));

      pasteLink("the-second-token");
      await act(async () => {
        refuseFirst(new ApiError("invitation_not_found", INVALID_LINK_MESSAGE));
      });

      expect(await screen.findByRole("button", { name: "Accept Invitation" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe("the-second-token");
    });

    it("shows the invalid-link message, with Go to Telflo, and forgets the token, for a link that finds nothing", async () => {
      vi.spyOn(apiClient, "previewInvitation").mockRejectedValue(
        new ApiError("invitation_not_found", INVALID_LINK_MESSAGE),
      );
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
      expect(screen.getByRole("link", { name: "Go to Telflo" })).toHaveAttribute("href", "/app");
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("shows another failure's message and keeps the token, since the link may still work", async () => {
      vi.spyOn(apiClient, "previewInvitation").mockRejectedValue(
        new ApiError("rate_limited", "Too many requests. Try again in 30 seconds."),
      );
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Try again in 30 seconds.");
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    });

    it("shows the expired message, with Go to Telflo, and forgets the token, since a resend issues a new one", async () => {
      previewAnswers({ ...INVITATION, status: "expired" });
      renderPage({ visitor: signedInAs(INVITATION.email) });

      expect(await screen.findByRole("alert")).toHaveTextContent(EXPIRED_LINK_MESSAGE);
      expect(screen.getByRole("link", { name: "Go to Telflo" })).toHaveAttribute("href", "/app");
      expect(screen.queryByRole("button", { name: "Accept Invitation" })).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("says an accepted invitation has been accepted, with Go to Telflo, and forgets the token", async () => {
      previewAnswers({ ...INVITATION, status: "accepted" });
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByRole("alert")).toHaveTextContent(ALREADY_ACCEPTED_MESSAGE);
      expect(screen.getByRole("link", { name: "Go to Telflo" })).toHaveAttribute("href", "/app");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe("signed in as the invited address", () => {
    it("offers to join in the invitation's role, and Accept joins, forgets the token and lands on /app?joined_org=", async () => {
      previewAnswers(INVITATION);
      const accept = vi.spyOn(apiClient, "acceptInvitation").mockResolvedValue(JOINED);
      // The address comparison ignores case.
      renderPage({ visitor: signedInAs("Invitee@Example.com") });

      expect(await screen.findByRole("heading", { name: "Join Group" })).toBeInTheDocument();
      expect(screen.getByText("You've been invited with the contributor role.")).toBeInTheDocument();
      expect(screen.getByText("Invitee@Example.com")).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole("button", { name: "Accept Invitation" }));

      expect(await screen.findByText(`landed on /app?joined_org=${GROUP_ID}`)).toBeInTheDocument();
      expect(accept).toHaveBeenCalledWith({ token: TOKEN });
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("shows the API's mismatch message (a 403 invitation_email_mismatch), and stays", async () => {
      const message = "This invitation was sent to invitee@example.com. Sign in with that address to accept it.";
      previewAnswers(INVITATION);
      vi.spyOn(apiClient, "acceptInvitation").mockRejectedValue(new ApiError("invitation_email_mismatch", message));
      renderPage({ visitor: signedInAs(INVITATION.email) });

      await userEvent.setup().click(await screen.findByRole("button", { name: "Accept Invitation" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("button", { name: "Accept Invitation" })).toBeEnabled();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    });

    it.each([
      ["invitation_not_found", INVALID_LINK_MESSAGE],
      ["invitation_expired", EXPIRED_LINK_MESSAGE],
      ["invitation_already_accepted", ALREADY_ACCEPTED_MESSAGE],
    ])("shows the %s refusal and forgets the token, which can never work again", async (code, message) => {
      previewAnswers(INVITATION);
      vi.spyOn(apiClient, "acceptInvitation").mockRejectedValue(new ApiError(code, message));
      renderPage({ visitor: signedInAs(INVITATION.email) });

      await userEvent.setup().click(await screen.findByRole("button", { name: "Accept Invitation" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("says Accepting... and holds still while accepting", async () => {
      previewAnswers(INVITATION);
      const accept = vi.spyOn(apiClient, "acceptInvitation").mockReturnValue(new Promise(() => {}));
      renderPage({ visitor: signedInAs(INVITATION.email) });
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Accept Invitation" }));

      const busy = await screen.findByRole("button", { name: "Accepting..." });
      expect(busy).toBeDisabled();
      await user.click(busy);
      expect(accept).toHaveBeenCalledTimes(1);
    });
  });

  describe("signed in as another address", () => {
    it("says which address the invitation is for and offers Sign out, which signs out here and shows the form", async () => {
      previewAnswers(INVITATION);
      const signOut = vi.spyOn(apiClient, "deleteCurrentSession").mockResolvedValue(undefined);
      const signedOutLocally = vi.spyOn(analytics, "signedOutLocally");
      const accept = vi.spyOn(apiClient, "acceptInvitation");
      window.localStorage.setItem("telflo-playground-staged-edit", JSON.stringify({ version: 1 }));
      const other = signedInAs("someone-else@example.com");
      if (other.status === "signed_in") useUserStore.getState().setCurrent(other.currentUser);
      let visitor = other;
      const { loader } = renderPage({ visitor: () => visitor });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This invitation was sent to invitee@example.com. Sign in with that address to accept it.",
      );
      expect(screen.getByText("someone-else@example.com")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Accept Invitation" })).not.toBeInTheDocument();

      visitor = SIGNED_OUT;
      await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));

      expect(await screen.findByText("Sign in to join Group")).toBeInTheDocument();
      expect(signOut).toHaveBeenCalledTimes(1);
      // PostHog forgets the user, as a Logout does, and the staged playground edit goes.
      expect(signedOutLocally).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem("telflo-playground-staged-edit") !== null).toBe(false);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(useUserStore.getState().current).toBeNull();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      // It stayed on the page: no navigation to /login.
      expect(screen.queryByText(/landed on/)).not.toBeInTheDocument();
      expect(accept).not.toHaveBeenCalled();
    });

    it("says so, and stays signed in, when signing out fails", async () => {
      previewAnswers(INVITATION);
      vi.spyOn(apiClient, "deleteCurrentSession").mockRejectedValue(
        new ApiError("network_error", "Could not reach the server. Check your connection."),
      );
      const signedOutLocally = vi.spyOn(analytics, "signedOutLocally");
      window.localStorage.setItem("telflo-playground-staged-edit", JSON.stringify({ version: 1 }));
      const { loader } = renderPage({ visitor: signedInAs("someone-else@example.com") });

      await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));

      expect(await screen.findByText("Failed to log out")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
      expect(loader).toHaveBeenCalledTimes(1);
      expect(signedOutLocally).not.toHaveBeenCalled();
      // Still signed in: the staged edit stays.
      expect(window.localStorage.getItem("telflo-playground-staged-edit") !== null).toBe(true);
    });
  });

  describe("signed out, with an account at the address", () => {
    it("shows the address fixed, with Forgot password?, and Sign In & Join signs in as it and then accepts", async () => {
      previewAnswers(INVITATION);
      const calls: string[] = [];
      const signIn = vi.spyOn(apiClient, "createSession").mockImplementation(async () => {
        calls.push("sign in");
        return { user: { id: "00000000-0000-4000-8000-000000000001", email: INVITATION.email } };
      });
      const accept = vi.spyOn(apiClient, "acceptInvitation").mockImplementation(async () => {
        calls.push("accept");
        return JOINED;
      });
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByRole("heading", { name: "Sign in to join Group" })).toBeInTheDocument();
      expect(screen.getByText("Sign in to your account to join your organization")).toBeInTheDocument();
      const email = screen.getByLabelText("Email");
      expect(email).toHaveValue(INVITATION.email);
      expect(email).toHaveAttribute("readonly");
      expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password");
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Password"), "the-right-password");
      await user.click(screen.getByRole("button", { name: "Sign In & Join" }));

      expect(await screen.findByText(`landed on /app?joined_org=${GROUP_ID}`)).toBeInTheDocument();
      expect(signIn).toHaveBeenCalledWith({ email: INVITATION.email, password: "the-right-password" });
      expect(accept).toHaveBeenCalledWith({ token: TOKEN });
      expect(calls).toEqual(["sign in", "accept"]);
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("shows the sign-in message for a wrong password, and doesn't accept", async () => {
      previewAnswers(INVITATION);
      vi.spyOn(apiClient, "createSession").mockRejectedValue(
        new ApiError("invalid_credentials", "Invalid login credentials"),
      );
      const accept = vi.spyOn(apiClient, "acceptInvitation");
      renderPage({ visitor: SIGNED_OUT });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Password"), "the-wrong-password");
      await user.click(screen.getByRole("button", { name: "Sign In & Join" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
      expect(screen.getByRole("button", { name: "Sign In & Join" })).toBeEnabled();
      expect(accept).not.toHaveBeenCalled();
    });

    it("says Email not confirmed for an unverified account, with Forgot password? still in view", async () => {
      previewAnswers(INVITATION);
      vi.spyOn(apiClient, "createSession").mockRejectedValue(
        new ApiError("email_not_verified", "Confirm your email address before signing in."),
      );
      renderPage({ visitor: SIGNED_OUT });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Password"), "the-right-password");
      await user.click(screen.getByRole("button", { name: "Sign In & Join" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Email not confirmed");
      expect(screen.getByRole("link", { name: "Forgot password?" })).toBeVisible();
    });

    it("says Signing in... while signing in", async () => {
      previewAnswers(INVITATION);
      vi.spyOn(apiClient, "createSession").mockReturnValue(new Promise(() => {}));
      renderPage({ visitor: SIGNED_OUT });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Password"), "the-right-password");
      await user.click(screen.getByRole("button", { name: "Sign In & Join" }));

      expect(await screen.findByRole("button", { name: "Signing in..." })).toBeDisabled();
    });

    it("signed in but not joined, loads the page again signed in, with the failure and Accept", async () => {
      previewAnswers(INVITATION);
      vi.spyOn(apiClient, "createSession").mockResolvedValue({
        user: { id: "00000000-0000-4000-8000-000000000001", email: INVITATION.email },
      });
      vi.spyOn(apiClient, "acceptInvitation").mockRejectedValue(
        new ApiError("invitation_expired", EXPIRED_LINK_MESSAGE),
      );
      let visitor: InvitationVisitor = SIGNED_OUT;
      renderPage({ visitor: () => visitor });
      const user = userEvent.setup();

      await user.type(await screen.findByLabelText("Password"), "the-right-password");
      visitor = signedInAs(INVITATION.email);
      await user.click(screen.getByRole("button", { name: "Sign In & Join" }));

      expect(await screen.findByRole("button", { name: "Accept Invitation" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(EXPIRED_LINK_MESSAGE);
    });

    it("offers Google, coming back to this page, with no token in the link", async () => {
      previewAnswers(INVITATION);
      renderPage({ visitor: SIGNED_OUT, providers: [GOOGLE] });

      const google = await screen.findByRole("link", { name: "Google" });
      expect(google).toHaveAttribute("href", `/api/v1/auth/oidc/google?redirectTo=${encodeURIComponent("/accept-invitation")}`);
      expect(google.getAttribute("href")).not.toContain(TOKEN);
      expect(screen.getByText("or continue with email")).toBeInTheDocument();
    });
  });

  describe("signed out, an invitation that can't make an account here", () => {
    it.each([
      ["no account at the address", false],
      ["an account at the address", true],
    ])("offers sign-in only, with %s, saying why only when there is none, never Create Account & Join", async (_label, hasAccount) => {
      previewAnswers({ ...INVITATION, hasAccount, mayRegister: false });
      const register = vi.spyOn(apiClient, "registerFromInvitation");
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByRole("heading", { name: "Sign in to join Group" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign In & Join" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Create Account & Join" })).toBeNull();
      expect(screen.queryByLabelText("Confirm Password")).toBeNull();
      const notice = screen.queryByText("This invitation can't create a new account. Sign in with an existing account to accept it.");
      expect(notice !== null).toBe(!hasAccount);
      expect(register).not.toHaveBeenCalled();
    });
  });

  describe("signed out, with no account at the address", () => {
    const NEW_ADDRESS = { ...INVITATION, hasAccount: false };

    async function fillIn(password: string, confirmation: string, acceptTerms: boolean) {
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText("Password"), password);
      await user.type(screen.getByLabelText("Confirm Password"), confirmation);
      if (acceptTerms) await user.click(screen.getByRole("checkbox", { name: /terms/i }));
      await user.click(screen.getByRole("button", { name: "Create Account & Join" }));
    }

    it("shows the address fixed and the terms, and Create Account & Join registers from the invitation and lands on /app?joined_org=", async () => {
      previewAnswers(NEW_ADDRESS);
      const register = vi.spyOn(apiClient, "registerFromInvitation").mockResolvedValue(JOINED);
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByRole("heading", { name: "Join Group on Telflo" })).toBeInTheDocument();
      expect(screen.getByText("Set up your account to join your organization")).toBeInTheDocument();
      expect(screen.getByLabelText("Email")).toHaveValue(INVITATION.email);
      expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
      expect(screen.getByText(`Minimum ${PASSWORD_MINIMUM_LENGTH} characters.`)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/home/terms-of-service");
      expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "https://legal.example.com/privacy");
      await fillIn("a-long-enough-password", "a-long-enough-password", true);

      expect(await screen.findByText(`landed on /app?joined_org=${GROUP_ID}`)).toBeInTheDocument();
      expect(register).toHaveBeenCalledWith({
        token: TOKEN,
        password: "a-long-enough-password",
        acceptedTermsVersion: TERMS_VERSION,
      });
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it.each([
      ["mismatched passwords", "a-long-enough-password", "a-different-password", true, "Passwords do not match"],
      ["a short password", "short", "short", true, `Password must be at least ${PASSWORD_MINIMUM_LENGTH} characters`],
      ["the terms not accepted", "a-long-enough-password", "a-long-enough-password", false, "You must accept the terms to continue."],
    ])("refuses %s before asking the API", async (_, password, confirmation, acceptTerms, message) => {
      previewAnswers(NEW_ADDRESS);
      const register = vi.spyOn(apiClient, "registerFromInvitation");
      renderPage({ visitor: SIGNED_OUT });

      await fillIn(password, confirmation, acceptTerms);

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(register).not.toHaveBeenCalled();
    });

    it("on a site that asks for no Terms: no divider and no checkbox, and Create Account & Join sends no acceptedTermsVersion key", async () => {
      previewAnswers(NEW_ADDRESS);
      const register = vi.spyOn(apiClient, "registerFromInvitation").mockResolvedValue(JOINED);
      renderPage({ visitor: SIGNED_OUT, terms: null });

      expect(await screen.findByRole("heading", { name: "Join Group on Telflo" })).toBeInTheDocument();
      expect(screen.queryByText("Usage policies")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Terms of Service" })).not.toBeInTheDocument();
      await fillIn("a-long-enough-password", "a-long-enough-password", false);

      expect(await screen.findByText(`landed on /app?joined_org=${GROUP_ID}`)).toBeInTheDocument();
      expect(register).toHaveBeenCalledOnce();
      const [body] = register.mock.calls[0]!;
      expect(body).toEqual({ token: TOKEN, password: "a-long-enough-password" });
      expect(Object.keys(body)).not.toContain("acceptedTermsVersion");
    });

    it("shows the API's words when the site is closed to new accounts, 403 registration_not_open, and keeps the form", async () => {
      previewAnswers(NEW_ADDRESS);
      const message = "This site isn't accepting new accounts.";
      vi.spyOn(apiClient, "registerFromInvitation").mockRejectedValue(new ApiError("registration_not_open", message));
      renderPage({ visitor: SIGNED_OUT, terms: null });

      await fillIn("a-long-enough-password", "a-long-enough-password", false);

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("button", { name: "Create Account & Join" })).toBeInTheDocument();
    });

    it("shows the API's refusal, and keeps the form", async () => {
      const message = "An account already exists for this email address. Sign in to accept the invitation.";
      previewAnswers(NEW_ADDRESS);
      vi.spyOn(apiClient, "registerFromInvitation").mockRejectedValue(new ApiError("account_exists", message));
      renderPage({ visitor: SIGNED_OUT });

      await fillIn("a-long-enough-password", "a-long-enough-password", true);

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("button", { name: "Create Account & Join" })).toBeEnabled();
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(TOKEN);
    });

    it("shows the API's words for an invitation to the reserved domain, 422 email_reserved, and keeps the form", async () => {
      previewAnswers(NEW_ADDRESS);
      vi.spyOn(apiClient, "registerFromInvitation").mockRejectedValue(
        new ApiError("email_reserved", "This address can't be used"),
      );
      renderPage({ visitor: SIGNED_OUT });

      await fillIn("a-long-enough-password", "a-long-enough-password", true);

      expect(await screen.findByRole("alert")).toHaveTextContent("This address can't be used");
      expect(screen.getByRole("button", { name: "Create Account & Join" })).toBeEnabled();
    });

    it("forgets the token when registering finds the invitation cancelled since the preview", async () => {
      previewAnswers(NEW_ADDRESS);
      vi.spyOn(apiClient, "registerFromInvitation").mockRejectedValue(
        new ApiError("invitation_not_found", INVALID_LINK_MESSAGE),
      );
      renderPage({ visitor: SIGNED_OUT });

      await fillIn("a-long-enough-password", "a-long-enough-password", true);

      expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_LINK_MESSAGE);
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("says Creating account... while registering", async () => {
      previewAnswers(NEW_ADDRESS);
      vi.spyOn(apiClient, "registerFromInvitation").mockReturnValue(new Promise(() => {}));
      renderPage({ visitor: SIGNED_OUT });

      await fillIn("a-long-enough-password", "a-long-enough-password", true);

      expect(await screen.findByRole("button", { name: "Creating account..." })).toBeDisabled();
    });

    it("offers Google, coming back to this page, with no token in the link", async () => {
      previewAnswers(NEW_ADDRESS);
      renderPage({ visitor: SIGNED_OUT, providers: [GOOGLE] });

      const google = await screen.findByRole("link", { name: "Google" });
      expect(google).toHaveAttribute("href", `/api/v1/auth/oidc/google?redirectTo=${encodeURIComponent("/accept-invitation")}`);
      expect(google.getAttribute("href")).not.toContain(TOKEN);
      expect(screen.getByText("or set a password")).toBeInTheDocument();
    });
  });

  describe("naming the organization", () => {
    // A personal workspace under its default name, its owner's email.
    const PERSONAL = { ...INVITATION, organizationName: "owner@example.com", organizationType: "personal" } as const;

    it.each([
      ["signed in as the invited address", { visitor: signedInAs(INVITATION.email), invitation: PERSONAL }, "Join owner@example.com's organization"],
      ["signed in as someone else", { visitor: signedInAs("someone-else@example.com"), invitation: PERSONAL }, "Join owner@example.com's organization"],
      ["signed out, with an account", { visitor: SIGNED_OUT, invitation: PERSONAL }, "Sign in to join owner@example.com's organization"],
      ["signed out, with no account", { visitor: SIGNED_OUT, invitation: { ...PERSONAL, hasAccount: false } }, "Join owner@example.com's organization on Telflo"],
    ])("names a personal workspace called by its owner's email as <email>'s organization, %s", async (_case, { visitor, invitation }, heading) => {
      previewAnswers(invitation);
      renderPage({ visitor });

      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    });

    it.each([
      ["a group named by an email address", { organizationName: "ops@example.com", organizationType: "group" }],
      ["a renamed personal workspace", { organizationName: "Sam's Lab", organizationType: "personal" }],
      ["a personal workspace named only like an email", { organizationName: "sam@example", organizationType: "personal" }],
    ] as const)("names %s by its name alone", async (_case, named) => {
      previewAnswers({ ...INVITATION, ...named, hasAccount: false });
      renderPage({ visitor: SIGNED_OUT });

      expect(await screen.findByRole("heading", { name: `Join ${named.organizationName} on Telflo` })).toBeInTheDocument();
    });

    it("puts the workspace's email in no attribute, only the heading's text, since replay records attributes", async () => {
      previewAnswers({ ...PERSONAL, hasAccount: false });
      renderPage({ visitor: SIGNED_OUT });
      expect(await screen.findByRole("heading", { name: "Join owner@example.com's organization on Telflo" })).toBeInTheDocument();

      const attributeValues = Array.from(document.body.querySelectorAll("*")).flatMap((element) =>
        Array.from(element.attributes, (attribute) => attribute.value),
      );
      expect(attributeValues.some((value) => value.includes("owner@example.com"))).toBe(false);
      expect(document.title.includes("owner@example.com")).toBe(false);
    });
  });

  it("shows no Google button when no provider is configured", async () => {
    previewAnswers(INVITATION);
    renderPage({ visitor: SIGNED_OUT });

    expect(await screen.findByText("Sign in to join Group")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Google" })).not.toBeInTheDocument();
    expect(screen.queryByText("or continue with email")).not.toBeInTheDocument();
  });
});
