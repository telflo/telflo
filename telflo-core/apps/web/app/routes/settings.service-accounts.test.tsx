import { act, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_ACCOUNT_NOT_FOUND_MESSAGE, type ApiToken, type ServiceAccount } from "@telflo/contracts";
import routes from "../routes.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { anyStateHolds, attributesHolding } from "~/test/fleets.js";
import {
  ACCOUNT_ID,
  apiToken,
  buildApiToken,
  expectTokenOnlyInsideNoCapture,
  holdsText,
  quietQueries,
  renderServiceAccountPages,
  serviceAccount,
  showsText,
  waitUntilGone,
  where,
} from "~/test/service-accounts.js";

/*
 * Settings › Service Accounts' routes: the list's guard and its leaving when
 * management is lost, and the privacy of both pages and their dialogs.
 */

describe("the Service Accounts list's route (/settings/service-accounts)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("routes the list and an account's page, by its id only, under Settings", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    const settings = layout?.children?.find((route) => route.path === "settings");
    const children = settings?.children?.map((route) => [route.path, route.file]) ?? [];
    expect(children.slice(-2)).toEqual([
      ["service-accounts", "routes/settings/service-accounts.tsx"],
      ["service-accounts/:serviceAccountId", "routes/settings/service-accounts.$serviceAccountId.tsx"],
    ]);
  });

  it("a contributor opening it is sent to /settings, replacing the entry, with no read", async () => {
    const list = vi.spyOn(apiClient, "getServiceAccounts");
    renderServiceAccountPages("/settings/service-accounts", "contributor");
    expect(await screen.findByText("landed on /settings")).toBeInTheDocument();
    expect(where()).toBe("/settings REPLACE");
    expect(list).not.toHaveBeenCalled();
  });

  it("a 403 while open leaves the page for /app with the API's message", async () => {
    vi.spyOn(apiClient, "getServiceAccounts").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an organization admin can do this", { status: 403 }),
    );
    const error = vi.spyOn(toast, "error");
    renderServiceAccountPages("/settings/service-accounts");
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an organization admin can do this");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("an organization no longer active (404 organization_not_found) leaves the page too", async () => {
    vi.spyOn(apiClient, "getServiceAccounts").mockRejectedValue(
      new ApiError("organization_not_found", "Organization not found", { status: 404 }),
    );
    renderServiceAccountPages("/settings/service-accounts");
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
  });

  it("a session that ended says nothing and stays (the session-ended handler has it)", async () => {
    vi.spyOn(apiClient, "getServiceAccounts").mockRejectedValue(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    const error = vi.spyOn(toast, "error");
    renderServiceAccountPages("/settings/service-accounts");
    await waitFor(() => expect(apiClient.getServiceAccounts).toHaveBeenCalled());
    await act(async () => {});
    expect(error).not.toHaveBeenCalled();
    expect(where()).toBe("/settings/service-accounts POP");
  });
});

describe("the Service Accounts pages' privacy", () => {
  const NAME = "Canary Robot 5D1";
  const SLUG = "canary-robot-5d1";
  const ADDRESS = `${SLUG}-0e0e0e0e@service-accounts.telflo.invalid`;
  const RENAMED = "Second Canary 6E2";
  const TOKEN_NAME = "canary-token-name-7F3";

  let unquiet: () => void;
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    localStorage.clear();
    sessionStorage.clear();
    unquiet = quietQueries();
  });
  afterEach(() => {
    unquiet();
    localStorage.clear();
    sessionStorage.clear();
  });

  /** The API, as a store of one organization's accounts and tokens. */
  function fakeApi(token: string) {
    let account: ServiceAccount | null = null;
    let tokens: ApiToken[] = [];
    vi.spyOn(apiClient, "getServiceAccounts").mockImplementation(() => Promise.resolve({ items: account === null ? [] : [account] }));
    vi.spyOn(apiClient, "createServiceAccount").mockImplementation((_organizationId, { name }) => {
      account = serviceAccount({ id: ACCOUNT_ID, name, email: ADDRESS, tokenCount: 0 });
      return Promise.resolve({ serviceAccount: account });
    });
    vi.spyOn(apiClient, "getServiceAccount").mockImplementation(() =>
      account === null
        ? Promise.reject(new ApiError("service_account_not_found", SERVICE_ACCOUNT_NOT_FOUND_MESSAGE, { status: 404 }))
        : Promise.resolve({ serviceAccount: account }),
    );
    vi.spyOn(apiClient, "renameServiceAccount").mockImplementation((_organizationId, _id, { name }) => {
      account = { ...account!, name };
      return Promise.resolve({ serviceAccount: account });
    });
    vi.spyOn(apiClient, "getApiTokens").mockImplementation(() => Promise.resolve({ items: tokens }));
    vi.spyOn(apiClient, "createApiToken").mockImplementation((_organizationId, _id, request) => {
      const made = apiToken({ name: request.name, prefix: token.slice(0, 11), access: request.access });
      tokens = [made];
      return Promise.resolve({ apiToken: made, token });
    });
    vi.spyOn(apiClient, "revokeApiToken").mockImplementation(() => {
      tokens = [];
      return Promise.resolve(undefined);
    });
    vi.spyOn(apiClient, "deleteServiceAccount").mockImplementation(() => {
      account = null;
      return Promise.resolve(undefined);
    });
  }

  it("puts no name, address, token name, token or prefix in an attribute, the URL, the title, a toast or storage, through every page and dialog", async () => {
    const token = buildApiToken();
    const prefix = token.slice(0, 11);
    const names = [NAME, SLUG, ADDRESS, RENAMED, TOKEN_NAME];
    fakeApi(token);
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    /** Each canary nowhere but visible text: no attribute, not the router's URL, not the title. */
    const expectOnlyAsText = (step: string) => {
      for (const canary of names) {
        expect(attributesHolding(canary), `${step}: attributes holding ${canary}`).toEqual([]);
        expect(where().includes(canary), `${step}: ${canary} in the URL`).toBe(false);
        expect(document.title.includes(canary), `${step}: ${canary} in the title`).toBe(false);
      }
      for (const [label, secret] of [
        ["the token", token],
        ["its prefix", prefix],
      ] as const) {
        expect(attributesHolding(secret).length, `${step}: attributes holding ${label}`).toBe(0);
        expect(where().includes(secret), `${step}: ${label} in the URL`).toBe(false);
        expect(document.title.includes(secret), `${step}: ${label} in the title`).toBe(false);
      }
    };

    const user = renderServiceAccountPages("/settings/service-accounts");
    expect(await screen.findByText("No service accounts yet.")).toBeInTheDocument();

    // (2) Create, the name typed.
    await user.click(screen.getByRole("button", { name: "Create service account" }));
    const create = await screen.findByRole("dialog", { name: "Create service account" });
    await user.type(within(create).getByLabelText("Name"), NAME);
    expectOnlyAsText("create, typed");
    await user.click(within(create).getByRole("button", { name: "Create" }));

    // (1) The list with the canary account.
    const link = await screen.findByRole("link", { name: NAME });
    expectOnlyAsText("the list");

    // (3) The account's page, by its id.
    await user.click(link);
    expect(await screen.findByText(ADDRESS)).toBeInTheDocument();
    expect(where()).toContain(`/settings/service-accounts/${ACCOUNT_ID}`);
    expectOnlyAsText("the account's page");

    // (4) Rename, prefilled, to the second canary.
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const rename = await screen.findByRole("dialog", { name: "Rename service account" });
    expectOnlyAsText("rename, open");
    const field = within(rename).getByLabelText("Name");
    await user.clear(field);
    await user.type(field, RENAMED);
    expectOnlyAsText("rename, typed");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: RENAMED })).toBeInTheDocument();

    // (5) A token with a canary name.
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const createToken = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(createToken).getByLabelText("Name"), TOKEN_NAME);
    expectOnlyAsText("create token, typed");
    await user.click(within(createToken).getByRole("button", { name: "Create token" }));

    // (6) The reveal: the token only inside ph-no-capture; Copy; Done.
    const reveal = await screen.findByRole("dialog", { name: "Copy your token" });
    expectTokenOnlyInsideNoCapture(token);
    expectOnlyAsText("the reveal");
    await user.click(within(reveal).getByRole("button", { name: "Copy token" }));
    expect((await navigator.clipboard.readText()) === token, "the clipboard holds the token").toBe(true);
    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitUntilGone(() => screen.queryByRole("dialog"), "the reveal closed");
    expect(document.body.innerHTML.includes(token), "the token in the DOM after Done").toBe(false);
    expect(anyStateHolds(token), "the token in a component's state after Done").toBe(false);

    // The token's row: its name and prefix as text. Booleans from here on:
    // were Done to fail, the token would still be on the page.
    await waitFor(() => expect(showsText(TOKEN_NAME), "the token's name listed").toBe(true));
    const listed = [...document.querySelectorAll("td span")].some((cell) => cell.textContent === `${prefix}…`);
    expect(listed, "the prefix listed as text").toBe(true);
    expectOnlyAsText("the token's row");

    // (7) Revoke's dialog, the token's name in its title as text.
    await user.click(screen.getByRole("button", { name: `Revoke token ${TOKEN_NAME}` }));
    const revoke = await screen.findByRole("alertdialog", { name: `Revoke token ${TOKEN_NAME}?` });
    expectOnlyAsText("revoke, open");
    await user.click(within(revoke).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(showsText("No tokens yet."), "the token revoked").toBe(true));

    // (8) Back to the list, and the delete dialog with the name typed.
    await user.click(screen.getByRole("link", { name: "Service Accounts" }));
    await user.click(await screen.findByRole("button", { name: `Delete service account ${RENAMED}` }));
    const remove = await screen.findByRole("alertdialog", { name: `Delete service account: ${RENAMED}` });
    await user.type(within(remove).getByRole("textbox"), RENAMED);
    expectOnlyAsText("delete, typed");
    await user.click(within(remove).getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(showsText("No service accounts yet."), "the account deleted").toBe(true));
    expectOnlyAsText("the list, after the delete");

    // No toast and no storage held a canary (booleans first); every toast was fixed words.
    for (const secret of [...names, token, prefix]) {
      expect(holdsText([success.mock.calls, error.mock.calls], secret), "a toast holding a canary").toBe(false);
      expect(holdsText(setItem.mock.calls, secret), "a storage write holding a canary").toBe(false);
      expect(holdsText({ ...localStorage, ...sessionStorage }, secret), "storage holding a canary").toBe(false);
    }
    expect(success.mock.calls.map(([words]) => words)).toEqual([
      "Service account created",
      "Service account renamed",
      "Token revoked",
      "Service account deleted",
    ]);
    expect(error).not.toHaveBeenCalled();
  });
});
