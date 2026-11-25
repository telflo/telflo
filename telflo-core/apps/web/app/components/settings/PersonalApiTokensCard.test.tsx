import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_TOKEN_NOT_FOUND_MESSAGE,
  PERSONAL_API_TOKEN_LIMIT_REACHED_MESSAGE,
  type CreatedApiTokenResponse,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import {
  PERSONAL_API_TOKENS_EMPTY,
  PERSONAL_API_TOKENS_LOAD_FAILED_MESSAGE,
  PERSONAL_API_TOKENS_SCOPE_WORDS,
} from "~/lib/personal-api-tokens.js";
import { API_TOKEN_CREATE_FAILED_MESSAGE, API_TOKEN_REVOKED_MESSAGE } from "~/lib/service-accounts.js";
import { anyStateHolds, attributesHolding } from "~/test/fleets.js";
import {
  SECOND_TOKEN_ID,
  TOKEN_ID,
  apiToken,
  buildApiToken,
  expectTokenOnlyInsideNoCapture,
  holdsText,
  quietQueries,
  renderInRouter,
  showsText,
  waitUntilGone,
} from "~/test/service-accounts.js";
import { PersonalApiTokensCard } from "./PersonalApiTokensCard.js";

/*
 * Settings › Account's "API tokens": the person's own tokens through the
 * shared tokens table and dialogs, with the person's calls (no organization)
 * and words. A token is built at run time and never printed: booleans with
 * fixed labels only while one is on the page. A token's name is the person's
 * content: visible text only, never an attribute, a toast or the title.
 */

const NAME = "canary-personal-token-4c";

function created(token: string): CreatedApiTokenResponse {
  return { apiToken: apiToken({ id: SECOND_TOKEN_ID, name: "ci", prefix: token.slice(0, 11) }), token };
}

describe("PersonalApiTokensCard", () => {
  let unquiet: () => void;
  beforeEach(() => {
    vi.restoreAllMocks();
    unquiet = quietQueries();
  });
  afterEach(() => unquiet());

  it("lists the person's tokens with the shared tokens table, says in fixed words who a token acts as, and names each Revoke by aria-labelledby", async () => {
    vi.spyOn(apiClient, "getPersonalApiTokens").mockResolvedValue({
      items: [apiToken({ name: NAME, access: "write", expiresAt: "2026-12-01T12:00:00.000Z", isExpired: false })],
    });
    renderInRouter(PersonalApiTokensCard);
    expect(await screen.findByText(NAME)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "API tokens" })).toBeInTheDocument();
    expect(PERSONAL_API_TOKENS_SCOPE_WORDS).toBe(
      "A personal token acts as you, with your role, in every organization you belong to: send the organization's id in the X-Telflo-Org header (GET /api/public/v1/orgs lists your organizations and their ids). Organization admins can't see or revoke it.",
    );
    expect(screen.getByText(PERSONAL_API_TOKENS_SCOPE_WORDS)).toBeInTheDocument();
    // The API reference: a plain link to the API's own page, with its slash.
    const reference = screen.getByRole("link", { name: "API reference" });
    expect([reference.getAttribute("href"), reference.getAttribute("target"), reference.parentElement!.textContent]).toEqual([
      "/api/public/v1/docs/",
      null,
      "The API reference lists the API’s routes and lets you try them with a token.",
    ]);
    expect(screen.getByText("tf_abc12345…")).toBeInTheDocument();
    expect(screen.getByText("Read & Write")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Revoke token ${NAME}` })).toBeInTheDocument();
    expect(attributesHolding(NAME)).toEqual([]);
    expect(attributesHolding("tf_abc12345")).toEqual([]);
  });

  it("an empty list says so; a failed read says so, and Try again reads again", async () => {
    vi.spyOn(apiClient, "getPersonalApiTokens")
      .mockRejectedValueOnce(new ApiError("internal_error", "Something went wrong.", { status: 500 }))
      .mockResolvedValueOnce({ items: [] });
    const user = renderInRouter(PersonalApiTokensCard);
    const failed = await screen.findByText(PERSONAL_API_TOKENS_LOAD_FAILED_MESSAGE);
    await user.click(within(failed.parentElement!).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(PERSONAL_API_TOKENS_EMPTY)).toBeInTheDocument();
  });

  it("creates through the person's own route, shows the token once inside ph-no-capture, then drops it and reads the list again", async () => {
    const token = buildApiToken();
    const list = vi
      .spyOn(apiClient, "getPersonalApiTokens")
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [created(token).apiToken] });
    const create = vi.spyOn(apiClient, "createPersonalApiToken").mockResolvedValue(created(token));
    const serviceAccountCreate = vi.spyOn(apiClient, "createApiToken");
    const toasts = [vi.spyOn(toast, "success"), vi.spyOn(toast, "error")];
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = renderInRouter(PersonalApiTokensCard);
    await screen.findByText(PERSONAL_API_TOKENS_EMPTY);

    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), NAME);
    expect(within(dialog).getByLabelText("Name").closest(".ph-no-capture") !== null).toBe(true);
    await user.click(within(dialog).getByLabelText("Allow write access"));
    await user.type(within(dialog).getByLabelText("Expires in (days, optional)"), "90");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]).toEqual([{ name: NAME, access: "write", expiresInDays: 90 }]);
    expect(serviceAccountCreate).not.toHaveBeenCalled();

    const reveal = await screen.findByRole("dialog", { name: "Copy your token" });
    expectTokenOnlyInsideNoCapture(token);
    // Not read again while the token is shown.
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitUntilGone(() => screen.queryByRole("dialog"), "the reveal closed");
    expect(document.body.innerHTML.includes(token), "the token in the DOM").toBe(false);
    expect(anyStateHolds(token), "the token in a component's state").toBe(false);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(showsText("ci"), "the new row").toBe(true);

    for (const spy of toasts) expect(holdsText(spy.mock.calls, token) || holdsText(spy.mock.calls, NAME), "a toast holding the token or its name").toBe(false);
    expect(holdsText(setItem.mock.calls, token) || holdsText(setItem.mock.calls, NAME), "storage holding the token or its name").toBe(false);
    expect(document.title.includes(NAME)).toBe(false);
  });

  it("a refusal toasts the person's words and keeps the dialog; an answer that never came toasts the fallback and reads the list again; nothing leaves the page", async () => {
    const list = vi.spyOn(apiClient, "getPersonalApiTokens").mockResolvedValue({ items: [] });
    vi.spyOn(apiClient, "createPersonalApiToken")
      .mockRejectedValueOnce(new ApiError("api_token_limit_reached", PERSONAL_API_TOKEN_LIMIT_REACHED_MESSAGE, { status: 409 }))
      .mockRejectedValueOnce(new ApiError("organization_not_found", "Organization not found", { status: 404 }));
    const error = vi.spyOn(toast, "error");
    const user = renderInRouter(PersonalApiTokensCard);
    await screen.findByText(PERSONAL_API_TOKENS_EMPTY);
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), "ci");

    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("You have 20 tokens. Revoke one first."));
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBe(dialog);

    // Not a personal token's refusal (no management to lose here): the fallback, and the list read again.
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(API_TOKEN_CREATE_FAILED_MESSAGE));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("landed on /app")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("revokes through the person's own route after the confirm; a token already gone toasts its words and the list is read again", async () => {
    const list = vi
      .spyOn(apiClient, "getPersonalApiTokens")
      .mockResolvedValue({ items: [apiToken({ name: NAME }), apiToken({ id: SECOND_TOKEN_ID, name: "second" })] });
    const revoke = vi
      .spyOn(apiClient, "revokePersonalApiToken")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError("api_token_not_found", API_TOKEN_NOT_FOUND_MESSAGE, { status: 404 }));
    const serviceAccountRevoke = vi.spyOn(apiClient, "revokeApiToken");
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const user = renderInRouter(PersonalApiTokensCard);
    await screen.findByText(NAME);

    await user.click(screen.getByRole("button", { name: `Revoke token ${NAME}` }));
    const confirm = await screen.findByRole("alertdialog", { name: `Revoke token ${NAME}?` });
    await user.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith(API_TOKEN_REVOKED_MESSAGE));
    expect(revoke.mock.calls[0]).toEqual([TOKEN_ID]);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Revoke token second" }));
    const again = await screen.findByRole("alertdialog", { name: "Revoke token second?" });
    await user.click(within(again).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Token not found"));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(serviceAccountRevoke).not.toHaveBeenCalled();
    for (const spy of [success, error]) expect(holdsText(spy.mock.calls, NAME)).toBe(false);
  });

  describe("the current password", () => {
    const PASSWORD = "canary-current-8a2f-password";
    const withPassword = (hasPassword: boolean | undefined) => () => <PersonalApiTokensCard hasPassword={hasPassword} />;

    async function openCreate(hasPassword: boolean | undefined) {
      vi.spyOn(apiClient, "getPersonalApiTokens").mockResolvedValue({ items: [] });
      const user = renderInRouter(withPassword(hasPassword));
      await screen.findByText(PERSONAL_API_TOKENS_EMPTY);
      await user.click(screen.getByRole("button", { name: "Create token" }));
      const dialog = await screen.findByRole("dialog", { name: "Create API token" });
      await user.type(within(dialog).getByLabelText("Name"), "ci");
      return { user, dialog };
    }

    it("an account with one: Create token waits for it, and it goes in the create's body", async () => {
      const create = vi.spyOn(apiClient, "createPersonalApiToken").mockResolvedValue(created(buildApiToken()));
      const { user, dialog } = await openCreate(true);
      const field = within(dialog).getByLabelText("Current password");
      expect(field).toHaveAttribute("type", "password");
      expect(field).toHaveAttribute("autocomplete", "current-password");
      expect(within(dialog).getByRole("button", { name: "Create token" })).toBeDisabled();
      await user.type(field, PASSWORD);
      await user.click(within(dialog).getByRole("button", { name: "Create token" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]).toEqual([{ name: "ci", access: "read", expiresInDays: null, currentPassword: PASSWORD }]);
    });

    it("a wrong one is said under the field, which is emptied; no toast, the dialog stays, the list isn't read again", async () => {
      const create = vi
        .spyOn(apiClient, "createPersonalApiToken")
        .mockRejectedValueOnce(new ApiError("current_password_incorrect", "The current password is incorrect.", { status: 400 }))
        .mockResolvedValueOnce(created(buildApiToken()));
      const error = vi.spyOn(toast, "error");
      const { user, dialog } = await openCreate(true);
      const field = within(dialog).getByLabelText("Current password");
      await user.type(field, "wrong-one");
      await user.click(within(dialog).getByRole("button", { name: "Create token" }));

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("The current password is incorrect.");
      expect(field).toHaveValue("");
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(within(dialog).getByRole("button", { name: "Create token" })).toBeDisabled();
      expect(error).not.toHaveBeenCalled();
      expect(vi.mocked(apiClient.getPersonalApiTokens)).toHaveBeenCalledTimes(1);

      await user.type(field, PASSWORD);
      expect(within(dialog).queryByRole("alert")).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Create token" }));
      await screen.findByRole("dialog", { name: "Copy your token" });
      expect(create.mock.calls.map(([request]) => request.currentPassword)).toEqual(["wrong-one", PASSWORD]);
    });

    it("an account without one (OIDC only): no field, and none sent", async () => {
      const create = vi.spyOn(apiClient, "createPersonalApiToken").mockResolvedValue(created(buildApiToken()));
      const { user, dialog } = await openCreate(false);
      expect(within(dialog).queryByLabelText("Current password")).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Create token" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty("currentPassword");
    });

    it("unknown (the sign-in methods unread): the field shown, not blocking; blank sends none", async () => {
      const create = vi.spyOn(apiClient, "createPersonalApiToken").mockResolvedValue(created(buildApiToken()));
      const { user, dialog } = await openCreate(undefined);
      expect(within(dialog).getByLabelText("Current password")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Create token" }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty("currentPassword");
    });
  });
});
