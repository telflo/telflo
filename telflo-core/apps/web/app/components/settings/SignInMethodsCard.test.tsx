import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SignInMethodsResponse } from "@telflo/contracts";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSetPassword } from "./SetPasswordCard.js";
import { SignInMethodsCard, showsSignInMethods } from "./SignInMethodsCard.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { LINK_START_FAILED_MESSAGE } from "~/lib/account.js";
import { ACCOUNT_EMAIL, IDENTITY_EMAIL, LINKED_GOOGLE, held, signInMethods } from "~/test/account.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";

/*
 * Sign-in methods (D21 decisions 37-39 and 45): the password's state, each
 * configured provider linked or not, Link with the password prompt when
 * there is a password, Unlink with the current password, and "Set a
 * password first" for an account with none.
 */

const PASSWORD = "canary-link-pw-77aa";
const AUTHORIZATION_URL = "https://accounts.example.test/authorize?state=abc";

const onChanged = vi.fn();

/** What a browser fires when it shows the page; `persisted` when it comes back from the back/forward cache. */
function pageShow(persisted: boolean) {
  act(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));
  });
}

function Card({ methods }: { methods: SignInMethodsResponse }) {
  return <SignInMethodsCard methods={methods} onChanged={onChanged} setPassword={useSetPassword(ACCOUNT_EMAIL)} />;
}

function renderCard(methods: SignInMethodsResponse) {
  render(<Card methods={methods} />);
  return userEvent.setup();
}

let assign: ReturnType<typeof vi.fn>;

describe("SignInMethodsCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    onChanged.mockReset();
    assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hidden with no provider and no identity", () => {
    expect(showsSignInMethods(signInMethods({ providers: [] }))).toBe(false);
    expect(showsSignInMethods(signInMethods({ providers: [], hasPassword: false }))).toBe(false);
    expect(showsSignInMethods(signInMethods())).toBe(true);
    // A linked identity whose provider is no longer configured still shows (Preflight ruling 16).
    expect(showsSignInMethods(signInMethods({ providers: [], identities: [LINKED_GOOGLE] }))).toBe(true);
  });

  it("shows the password's state and Google linked as its email on its date, the email only as text", () => {
    renderCard(signInMethods({ identities: [LINKED_GOOGLE] }));
    expect(screen.getByRole("heading", { name: "Sign-in methods" })).toBeInTheDocument();
    expect(screen.getByText("How you can sign in to Telflo")).toBeInTheDocument();
    expect(screen.getByText("Password").nextElementSibling).toHaveTextContent("Set");
    expect(screen.getByText(`Linked as ${IDENTITY_EMAIL} on Oct 9, 2026`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink Google" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Link Google" })).not.toBeInTheDocument();
    expectNoAttributeHolds(IDENTITY_EMAIL);
  });

  it("Link asks for the password when set, then navigates to the provider's URL", async () => {
    const answer = held<{ authorizationUrl: string }>();
    const start = vi.spyOn(apiClient, "createIdentityLinkRequest").mockReturnValue(answer.promise);
    const user = renderCard(signInMethods());

    await user.click(screen.getByRole("button", { name: "Link Google" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    const continueButton = within(dialog).getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
    expect(start).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    expectNoAttributeHolds(PASSWORD);
    await user.click(continueButton);
    expect(start).toHaveBeenCalledWith({ provider: "google", currentPassword: PASSWORD });
    expect(assign).not.toHaveBeenCalled();

    answer.resolve({ authorizationUrl: AUTHORIZATION_URL });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZATION_URL));
    expect((within(dialog).getByLabelText("Current Password") as HTMLInputElement).value).toBe("");
  });

  it("a wrong password shows the API's message under the field, emptied; an unreachable provider toasts the link's words", async () => {
    vi.spyOn(apiClient, "createIdentityLinkRequest")
      .mockRejectedValueOnce(new ApiError("current_password_incorrect", "The current password is incorrect.", { status: 400 }))
      .mockRejectedValueOnce(
        new ApiError("provider_unavailable", "That sign-in provider isn't available right now. Try again later.", { status: 503 }),
      );
    const error = vi.spyOn(toast, "error");
    const user = renderCard(signInMethods());

    await user.click(screen.getByRole("button", { name: "Link Google" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    const field = within(dialog).getByLabelText("Current Password");
    await user.type(field, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The current password is incorrect.");
    expect(field).toHaveAccessibleDescription("The current password is incorrect.");
    expect((field as HTMLInputElement).value).toBe("");
    // Enabled again and focused, so the next try is typed at once.
    expect(field).toBeEnabled();
    expect(field).toHaveFocus();
    expect(error).not.toHaveBeenCalled();

    await user.type(field, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(LINK_START_FAILED_MESSAGE));
    expect(LINK_START_FAILED_MESSAGE).toBe("Linking Google didn't work. Try again.");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(assign).not.toHaveBeenCalled();
  });

  it("a password-less account links without the prompt", async () => {
    const start = vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl: AUTHORIZATION_URL });
    const user = renderCard(signInMethods({ hasPassword: false }));
    expect(screen.getByText("Password").nextElementSibling).toHaveTextContent("Not set");

    await user.click(screen.getByRole("button", { name: "Link Google" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(start).toHaveBeenCalledWith({ provider: "google" });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZATION_URL));
  });

  it("Back from the provider after a password-less start: the Link button is enabled again only on a back/forward cache restore", async () => {
    const start = vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl: AUTHORIZATION_URL });
    const user = renderCard(signInMethods({ hasPassword: false }));

    await user.click(screen.getByRole("button", { name: "Link Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZATION_URL));
    expect(screen.getByRole("button", { name: "Link Google" })).toBeDisabled();

    pageShow(false);
    expect(screen.getByRole("button", { name: "Link Google" })).toBeDisabled();

    pageShow(true);
    expect(screen.getByRole("button", { name: "Link Google" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Link Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("Back from the provider after the password prompt: the restored dialog can be cancelled and Link used again", async () => {
    vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl: AUTHORIZATION_URL });
    const user = renderCard(signInMethods());

    await user.click(screen.getByRole("button", { name: "Link Google" }));
    const dialog = await screen.findByRole("dialog", { name: "Link Google" });
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZATION_URL));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    pageShow(false);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    pageShow(true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Link Google" })).toBeEnabled();
  });

  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,x"],
    ["plain http off the loopback host", "http://accounts.example.test/authorize?state=abc"],
  ])("a password-less start refuses %s: no navigation, the link's fixed words, Link usable again", async (_name, authorizationUrl) => {
    vi.spyOn(apiClient, "createIdentityLinkRequest").mockResolvedValue({ authorizationUrl });
    const error = vi.spyOn(toast, "error");
    const user = renderCard(signInMethods({ hasPassword: false }));

    await user.click(screen.getByRole("button", { name: "Link Google" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(LINK_START_FAILED_MESSAGE));
    expect(error).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Link Google" })).toBeEnabled();
  });

  it("Unlink needs the password", async () => {
    const answer = held<undefined>();
    const unlink = vi.spyOn(apiClient, "unlinkIdentity").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    const user = renderCard(signInMethods({ identities: [LINKED_GOOGLE] }));

    await user.click(screen.getByRole("button", { name: "Unlink Google" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink Google" });
    expect(within(dialog).getByRole("button", { name: "Unlink" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(unlink).toHaveBeenCalledWith("google", { currentPassword: PASSWORD });

    answer.resolve(undefined);
    await waitFor(() => expect(success).toHaveBeenCalledWith("Google sign-in removed."));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The Unlink button goes with the methods' read: the card's heading holds the focus, not the body.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign-in methods" })).toHaveFocus());
  });

  it("a dialog closed without an answer gives the focus back to the button that opened it", async () => {
    const user = renderCard(signInMethods({ identities: [LINKED_GOOGLE] }));
    await user.click(screen.getByRole("button", { name: "Unlink Google" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink Google" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlink Google" })).toHaveFocus());
  });

  it("the Link dialog's Escape gives the focus back to Link Google", async () => {
    const user = renderCard(signInMethods());
    await user.click(screen.getByRole("button", { name: "Link Google" }));
    await screen.findByRole("dialog", { name: "Link Google" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Link Google" })).toHaveFocus());
  });

  it("Unlink's wrong password stays in the dialog with the API's message; another refusal toasts and reads again", async () => {
    vi.spyOn(apiClient, "unlinkIdentity")
      .mockRejectedValueOnce(new ApiError("current_password_incorrect", "The current password is incorrect.", { status: 400 }))
      .mockRejectedValueOnce(new ApiError("identity_not_linked", "Your account has no sign-in with this provider.", { status: 404 }));
    const error = vi.spyOn(toast, "error");
    const user = renderCard(signInMethods({ identities: [LINKED_GOOGLE] }));

    await user.click(screen.getByRole("button", { name: "Unlink Google" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink Google" });
    const field = within(dialog).getByLabelText("Current Password");
    await user.type(field, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The current password is incorrect.");
    expect((field as HTMLInputElement).value).toBe("");
    expect(field).toHaveFocus();
    expect(onChanged).not.toHaveBeenCalled();

    await user.type(field, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Your account has no sign-in with this provider."));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign-in methods" })).toHaveFocus());
  });

  it("Unlink is disabled with Set a password first when there is none", async () => {
    const requestPasswordReset = vi.spyOn(apiClient, "requestPasswordReset").mockResolvedValue({ status: "accepted" });
    const unlink = vi.spyOn(apiClient, "unlinkIdentity");
    const user = renderCard(signInMethods({ hasPassword: false, identities: [LINKED_GOOGLE] }));

    expect(screen.getByRole("button", { name: "Unlink Google" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Set a password first" }));
    expect(requestPasswordReset).toHaveBeenCalledWith({ email: ACCOUNT_EMAIL });
    await waitFor(() => expect(screen.getByRole("button", { name: "Set a password first" })).toBeDisabled());
    expect(unlink).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists an identity whose provider is no longer configured, by its id, and offers no Link for it", () => {
    renderCard(signInMethods({ providers: [], identities: [{ ...LINKED_GOOGLE, provider: "legacy-idp", relinksByEmail: false }] }));
    expect(screen.getByText("legacy-idp")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink legacy-idp" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Link / })).not.toBeInTheDocument();
  });

  it("Unlink's words say a sign-in links it again exactly when the identity's relinksByEmail does (Q126, Ruling 92)", async () => {
    const user = renderCard(
      signInMethods({ identities: [LINKED_GOOGLE, { ...LINKED_GOOGLE, provider: "legacy-idp", relinksByEmail: false }] }),
    );
    await user.click(screen.getByRole("button", { name: "Unlink Google" }));
    const google = await screen.findByRole("dialog", { name: "Unlink Google" });
    expect(google).toHaveAccessibleDescription(
      expect.stringContaining("If your Telflo address is this Google account's address, signing in with Google links it again."),
    );
    await user.click(within(google).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Unlink legacy-idp" }));
    const legacy = await screen.findByRole("dialog", { name: "Unlink legacy-idp" });
    expect(legacy).toHaveAccessibleDescription(
      "Enter your current password to remove this sign-in. You can still sign in with your password.",
    );
  });

  it("leaves the sentence out for a configured Google that doesn't re-link by email (another issuer: no authority rule)", async () => {
    const user = renderCard(signInMethods({ identities: [{ ...LINKED_GOOGLE, relinksByEmail: false }] }));
    await user.click(screen.getByRole("button", { name: "Unlink Google" }));
    const google = await screen.findByRole("dialog", { name: "Unlink Google" });
    expect(google).toHaveAccessibleDescription(
      "Enter your current password to remove this sign-in. You can still sign in with your password.",
    );
  });
});
