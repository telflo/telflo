import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_ACCOUNT_NOT_FOUND_MESSAGE, type ApiToken, type CreatedApiTokenResponse, type ServiceAccount } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import {
  API_TOKENS_REFRESH_FAILED_MESSAGE,
  SERVICE_ACCOUNT_LOAD_FAILED_MESSAGE,
  SERVICE_ACCOUNT_RENAMED_MESSAGE,
  SERVICE_ACCOUNT_UNREADABLE,
  formatServiceAccountDate,
} from "~/lib/service-accounts.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { held, signInMethods } from "~/test/account.js";
import { anyStateHolds, attributesHolding } from "~/test/fleets.js";
import {
  ACCOUNT_ID,
  ADMIN_EMAIL,
  ORGANIZATION_ID,
  SECOND_ACCOUNT_ID,
  SECOND_TOKEN_ID,
  TOKEN_ID,
  TOKEN_START,
  apiToken,
  buildApiToken,
  expectTokenOnlyInsideNoCapture,
  holdsText,
  quietQueries,
  renderServiceAccountPages,
  serviceAccount,
  showsText,
  waitUntilGone,
} from "~/test/service-accounts.js";

/*
 * A service account's page: the tokens read for the account in the path (a
 * session always has an organization), the Expired badge, the reveal's
 * lifetime and the failed reads. Tokens are built at run time and compared
 * as booleans only, and failed queries print no DOM while one may be on
 * the page.
 */

const ACCOUNT = serviceAccount({ tokenCount: 2 });
const READ_TOKEN = apiToken();
const WRITE_TOKEN = apiToken({
  id: SECOND_TOKEN_ID,
  name: "nightly",
  prefix: `${TOKEN_START}Zz9_-xYq`,
  access: "write",
  expiresAt: "2026-10-01T12:00:00.000Z",
  lastUsedAt: "2026-09-20T12:00:00.000Z",
  createdAt: "2026-09-03T12:00:00.000Z",
  isExpired: true,
});

/** The page's reads, answered in turn: each read asks for the account and its tokens. */
function servePage(accounts: Array<ServiceAccount | Error>, tokenLists: Array<ApiToken[] | Error>) {
  const getAccount = vi.spyOn(apiClient, "getServiceAccount");
  const getTokens = vi.spyOn(apiClient, "getApiTokens");
  for (const answer of accounts) {
    if (answer instanceof Error) getAccount.mockRejectedValueOnce(answer);
    else getAccount.mockResolvedValueOnce({ serviceAccount: answer });
  }
  for (const answer of tokenLists) {
    if (answer instanceof Error) getTokens.mockRejectedValueOnce(answer);
    else getTokens.mockResolvedValueOnce({ items: answer });
  }
  return { getAccount, getTokens };
}

const renderDetail = (id = ACCOUNT_ID) => renderServiceAccountPages(`/settings/service-accounts/${id}`);

describe("ServiceAccountDetailSection", () => {
  let unquiet: () => void;
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    unquiet = quietQueries();
    // The create dialog reads the admin's sign-in methods: none with a password here (no field).
    vi.spyOn(apiClient, "getSignInMethods").mockResolvedValue(signInMethods({ hasPassword: false }));
  });
  afterEach(() => unquiet());

  it("shows the header and the tokens with prefix, access, expiry, last use and the Expired badge", async () => {
    servePage([ACCOUNT], [[READ_TOKEN, WRITE_TOKEN]]);
    renderDetail();
    expect(await screen.findByRole("heading", { name: "ci-pipeline" })).toBeInTheDocument();
    expect(screen.getByText(ACCOUNT.email)).toHaveClass("font-mono");
    expect(screen.getByRole("link", { name: "Service Accounts" })).toHaveAttribute("href", "/settings/service-accounts");
    const details = [...document.querySelectorAll("dl > div")].map((each) => [each.querySelector("dt")?.textContent, each.querySelector("dd")?.textContent]);
    expect(details).toEqual([
      ["Created", formatServiceAccountDate(ACCOUNT.createdAt)],
      ["Created by", ADMIN_EMAIL],
      ["Tokens", "2"],
    ]);

    expect(screen.getByRole("heading", { name: "API Tokens" })).toBeInTheDocument();
    expect(screen.getByText("Bearer tokens that authenticate as this service account. A token is shown only once when created.")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Prefix",
      "Access",
      "Expires",
      "Last used",
      "Created",
      "Actions",
    ]);
    const shown = (row: HTMLElement) => within(row).getAllByRole("cell").slice(0, 6).map((cell) => cell.textContent);
    const [, read, write] = within(table).getAllByRole("row");
    expect(shown(read!)).toEqual(["deploy", `${READ_TOKEN.prefix}…`, "Read", "Never", "Never", formatServiceAccountDate(READ_TOKEN.createdAt)]);
    expect(shown(write!)).toEqual([
      "nightly",
      `${WRITE_TOKEN.prefix}…`,
      "Read & Write",
      `${formatServiceAccountDate(WRITE_TOKEN.expiresAt)}Expired`,
      formatServiceAccountDate(WRITE_TOKEN.lastUsedAt),
      formatServiceAccountDate(WRITE_TOKEN.createdAt),
    ]);
    expect(within(write!).getByText("Expired")).toBeInTheDocument();
    expect(within(read!).queryByText("Expired")).not.toBeInTheDocument();
    expect(within(write!).getByText("Read & Write")).toHaveClass("text-warn");
    expect(screen.getByText(`${READ_TOKEN.prefix}…`)).toHaveClass("font-mono");
    // The icons.
    expect(screen.getByRole("link", { name: "Service Accounts" }).querySelector("svg")?.getAttribute("class")).toContain("lucide-arrow-left");
    expect(screen.getByRole("heading", { name: "ci-pipeline" }).querySelector("svg")?.getAttribute("class")).toContain("lucide-bot");
    expect(screen.getByRole("button", { name: "Rename" }).querySelector("svg")?.getAttribute("class")).toContain("lucide-pencil");
    expect(screen.getByRole("button", { name: "Create token" }).querySelector("svg")?.getAttribute("class")).toContain("lucide-plus");
  });

  it("reads the account and the tokens for the account in the path", async () => {
    const { getAccount, getTokens } = servePage([ACCOUNT], [[READ_TOKEN]]);
    renderDetail();
    await screen.findByText("deploy");
    expect(getAccount).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT_ID, { signal: expect.any(AbortSignal) });
    expect(getTokens).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT_ID, { signal: expect.any(AbortSignal) });
  });

  it("names each token's Revoke by fixed words and the name cell", async () => {
    servePage([ACCOUNT], [[READ_TOKEN, WRITE_TOKEN]]);
    renderDetail();
    await screen.findByText("deploy");
    const revoke = screen.getByRole("button", { name: "Revoke token deploy" });
    expect(revoke).not.toHaveAttribute("aria-label");
    expect(revoke.querySelector("svg")?.getAttribute("class")).toContain("lucide-trash2");
    expect(screen.getByRole("button", { name: "Revoke token nightly" })).toBeInTheDocument();
  });

  it("renames: the field prefilled with no attribute holding the name, Save disabled while empty, then fixed words and the page read again", async () => {
    servePage([serviceAccount({ name: "Canary Robot 2b" }), serviceAccount({ name: "ci-prod" })], [[READ_TOKEN], [READ_TOKEN]]);
    const rename = vi.spyOn(apiClient, "renameServiceAccount").mockResolvedValue({ serviceAccount: serviceAccount({ name: "ci-prod" }) });
    const success = vi.spyOn(toast, "success");
    const user = renderDetail();
    await screen.findByRole("heading", { name: "Canary Robot 2b" });

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename service account" });
    expect(within(dialog).getByText("The name is how this identity appears in Telflo. Its tokens are unaffected.")).toBeInTheDocument();
    const field = within(dialog).getByLabelText("Name");
    expect(field).toHaveValue("Canary Robot 2b");
    expect(field.closest(".ph-no-capture")).not.toBeNull();
    expect(field).toHaveAttribute("maxlength", "64");
    expect(attributesHolding("Canary Robot 2b")).toEqual([]);
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();

    await user.clear(field);
    expect(save).toBeDisabled();
    await user.type(field, "  ci-prod ");
    expect(attributesHolding("ci-prod")).toEqual([]);
    await user.click(save);
    expect(rename).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT_ID, { name: "ci-prod" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(success).toHaveBeenCalledWith(SERVICE_ACCOUNT_RENAMED_MESSAGE);
    expect(SERVICE_ACCOUNT_RENAMED_MESSAGE).toBe("Service account renamed");
    expect(await screen.findByRole("heading", { name: "ci-prod" })).toBeInTheDocument();
  });

  it("creates a token and shows it once, inside ph-no-capture; the list is read again only once the reveal closes", async () => {
    const token = buildApiToken();
    const made = apiToken({ id: SECOND_TOKEN_ID, name: "ci", prefix: token.slice(0, 11), access: "write" });
    const { getTokens } = servePage([ACCOUNT, ACCOUNT], [[READ_TOKEN], [made, READ_TOKEN]]);
    const create = vi
      .spyOn(apiClient, "createApiToken")
      .mockResolvedValue({ apiToken: made, token } satisfies CreatedApiTokenResponse);
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const user = renderDetail();
    await screen.findByText("deploy");

    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    await user.click(within(dialog).getByLabelText("Allow write access"));
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(create.mock.calls[0]).toEqual([ORGANIZATION_ID, ACCOUNT_ID, { name: "ci", access: "write", expiresInDays: null }]);

    const reveal = await screen.findByRole("dialog", { name: "Copy your token" });
    expectTokenOnlyInsideNoCapture(token);
    expect(reveal.querySelector(".ph-no-capture code")?.textContent === token, "the token in the copy box").toBe(true);
    expect(screen.queryByRole("dialog", { name: "Create API token" }) === null, "the create dialog closed").toBe(true);
    // Not while the token is shown.
    expect(getTokens).toHaveBeenCalledTimes(1);
    // No toast, no storage holds it.
    expect(holdsText([success.mock.calls, error.mock.calls], token), "a toast holding the token").toBe(false);
    expect(holdsText({ ...localStorage, ...sessionStorage }, token), "storage holding the token").toBe(false);

    await user.click(within(reveal).getByRole("button", { name: "Done" }));
    await waitUntilGone(() => screen.queryByRole("dialog"), "the reveal closed");
    expect(document.body.innerHTML.includes(token), "the token in the DOM").toBe(false);
    expect(anyStateHolds(token), "the token in a component's state").toBe(false);
    await waitFor(() => expect(getTokens).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(showsText("ci"), "the new token's row").toBe(true));
    expect(holdsText([success.mock.calls, error.mock.calls], token), "a toast holding the token").toBe(false);
  });

  for (const [how, close] of [
    ["Escape", () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })],
    ["an outside click", () => fireEvent.pointerDown(document.body)],
  ] as const) {
    it(`the token is gone from the DOM and every state after ${how}, and the list is read again`, async () => {
      const token = buildApiToken();
      const made = apiToken({ id: SECOND_TOKEN_ID, name: "ci", prefix: token.slice(0, 11) });
      const { getTokens } = servePage([ACCOUNT, ACCOUNT], [[READ_TOKEN], [made, READ_TOKEN]]);
      vi.spyOn(apiClient, "createApiToken").mockResolvedValue({ apiToken: made, token });
      const user = renderDetail();
      await screen.findByText("deploy");
      await user.click(screen.getByRole("button", { name: "Create token" }));
      const dialog = await screen.findByRole("dialog", { name: "Create API token" });
      await user.type(within(dialog).getByLabelText("Name"), "ci");
      await user.click(within(dialog).getByRole("button", { name: "Create token" }));
      await screen.findByRole("dialog", { name: "Copy your token" });
      expect(anyStateHolds(token), "the page holds the token while shown").toBe(true);

      close();
      await waitUntilGone(() => screen.queryByRole("dialog"), "the reveal closed");
      expect(document.body.innerHTML.includes(token), "the token in the DOM").toBe(false);
      expect(anyStateHolds(token), "the token in a component's state").toBe(false);
      await waitFor(() => expect(getTokens).toHaveBeenCalledTimes(2));
    });
  }

  it("a failed read after the reveal toasts that the list couldn't refresh and keeps the list shown", async () => {
    const token = buildApiToken();
    const made = apiToken({ id: SECOND_TOKEN_ID, name: "ci", prefix: token.slice(0, 11) });
    servePage([ACCOUNT, ACCOUNT], [[READ_TOKEN], new ApiError("server_error", "Something went wrong.", { status: 500 })]);
    vi.spyOn(apiClient, "createApiToken").mockResolvedValue({ apiToken: made, token });
    const error = vi.spyOn(toast, "error");
    const user = renderDetail();
    await screen.findByText("deploy");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    const reveal = await screen.findByRole("dialog", { name: "Copy your token" });
    await user.click(within(reveal).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(error.mock.calls.length, "toasts after the reveal").toBeGreaterThan(0));
    // Booleans first: no toast holds the token, then the toast's words.
    expect(holdsText(error.mock.calls, token), "a toast holding the token").toBe(false);
    expect(error).toHaveBeenCalledWith(API_TOKENS_REFRESH_FAILED_MESSAGE);
    expect(API_TOKENS_REFRESH_FAILED_MESSAGE).toBe("Token created, but the list could not refresh");
    expect(showsText("deploy"), "the list still shown").toBe(true);
    expect(showsText(SERVICE_ACCOUNT_UNREADABLE), "the failed state").toBe(false);
  });

  it("an answer that never came for a create toasts and reads the list again", async () => {
    const { getTokens } = servePage([ACCOUNT, ACCOUNT], [[READ_TOKEN], [READ_TOKEN]]);
    vi.spyOn(apiClient, "createApiToken").mockRejectedValue(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const user = renderDetail();
    await screen.findByText("deploy");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(getTokens).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Copy your token" })).toBeNull();
  });

  it("revokes after the confirm with its fixed words, and reads the list again", async () => {
    const { getTokens } = servePage([ACCOUNT, ACCOUNT], [[READ_TOKEN, WRITE_TOKEN], [WRITE_TOKEN]]);
    const revoke = vi.spyOn(apiClient, "revokeApiToken").mockResolvedValue(undefined);
    const user = renderDetail();
    await screen.findByText("deploy");

    await user.click(screen.getByRole("button", { name: "Revoke token deploy" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke token deploy?" });
    expect(within(dialog).getByText("Any client using it loses access immediately.")).toBeInTheDocument();
    expect(revoke).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(revoke).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT_ID, TOKEN_ID);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("deploy")).not.toBeInTheDocument());
    expect(getTokens).toHaveBeenCalledTimes(2);
    expect(screen.getByText("nightly")).toBeInTheDocument();
  });

  it("shows the empty state when the account has no tokens", async () => {
    servePage([serviceAccount({ tokenCount: 0 })], [[]]);
    renderDetail();
    expect(await screen.findByText("No tokens yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect([...document.querySelectorAll("dd")].at(-1)?.textContent).toBe("0");
  });

  it("renders the not-found state for an account the API doesn't find", async () => {
    const missing = new ApiError("service_account_not_found", SERVICE_ACCOUNT_NOT_FOUND_MESSAGE, { status: 404 });
    servePage([missing], [missing]);
    const error = vi.spyOn(toast, "error");
    renderDetail();
    expect(await screen.findByText("Service account not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Service Accounts" })).toBeInTheDocument();
    expect(error).not.toHaveBeenCalled();
  });

  it("a failed read toasts and says the account couldn't be loaded", async () => {
    servePage([new ApiError("server_error", "Something went wrong.", { status: 500 })], [[READ_TOKEN]]);
    const error = vi.spyOn(toast, "error");
    renderDetail();
    expect(await screen.findByText(SERVICE_ACCOUNT_UNREADABLE)).toBeInTheDocument();
    expect(SERVICE_ACCOUNT_UNREADABLE).toBe("The service account could not be loaded.");
    expect(error).toHaveBeenCalledWith(SERVICE_ACCOUNT_LOAD_FAILED_MESSAGE);
    expect(SERVICE_ACCOUNT_LOAD_FAILED_MESSAGE).toBe("Failed to load service account");
    expect(screen.queryByText("No tokens yet.")).toBeNull();
  });

  it("keeps the newer of two reads: an older read answering last is ignored", async () => {
    vi.spyOn(apiClient, "getServiceAccount").mockResolvedValue({ serviceAccount: ACCOUNT });
    const olderRead = held<{ items: ApiToken[] }>();
    const getTokens = vi
      .spyOn(apiClient, "getApiTokens")
      .mockResolvedValueOnce({ items: [READ_TOKEN, WRITE_TOKEN] })
      .mockReturnValueOnce(olderRead.promise)
      .mockResolvedValueOnce({ items: [] });
    vi.spyOn(apiClient, "revokeApiToken").mockResolvedValue(undefined);
    const user = renderDetail();
    await screen.findByText("deploy");

    // The first revoke's read stays out; the second revoke's read answers first.
    await user.click(screen.getByRole("button", { name: "Revoke token deploy" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(getTokens).toHaveBeenCalledTimes(2));
    await waitUntilGone(() => screen.queryByRole("alertdialog"), "the first revoke's dialog closed");
    await user.click(screen.getByRole("button", { name: "Revoke token nightly" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(getTokens).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("No tokens yet.")).toBeInTheDocument();

    // The older read answers last, still listing nightly: the page keeps the newer.
    await act(async () => {
      olderRead.resolve({ items: [WRITE_TOKEN] });
      await olderRead.promise;
    });
    await act(async () => {});
    expect(screen.getByText("No tokens yet.")).toBeInTheDocument();
    expect(screen.queryByText("nightly")).toBeNull();
  });

  it("an account no longer shown takes no answer: the page is keyed by the account", async () => {
    const OTHER = serviceAccount({ id: SECOND_ACCOUNT_ID, name: "other-account", email: "other-account-0c0c0c0c@service-accounts.telflo.invalid" });
    const firstAccount = held<{ serviceAccount: ServiceAccount }>();
    vi.spyOn(apiClient, "getServiceAccounts").mockResolvedValue({ items: [ACCOUNT, OTHER] });
    vi.spyOn(apiClient, "getServiceAccount").mockImplementation((_organizationId, id) =>
      id === ACCOUNT_ID ? firstAccount.promise : Promise.resolve({ serviceAccount: OTHER }),
    );
    vi.spyOn(apiClient, "getApiTokens").mockImplementation((_organizationId, id) =>
      Promise.resolve({ items: id === ACCOUNT_ID ? [READ_TOKEN] : [WRITE_TOKEN] }),
    );
    const user = renderServiceAccountPages("/settings/service-accounts");

    // The first account's page, its read still out; back to the list; the second account's page.
    await user.click(await screen.findByRole("link", { name: "ci-pipeline" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Loading…");
    await user.click(screen.getByRole("link", { name: "Service Accounts" }));
    await user.click(await screen.findByRole("link", { name: "other-account" }));
    expect(await screen.findByRole("heading", { name: "other-account" })).toBeInTheDocument();
    expect(screen.getByText("nightly")).toBeInTheDocument();

    // The first account's answer lands: nothing changes.
    await act(async () => {
      firstAccount.resolve({ serviceAccount: ACCOUNT });
      await firstAccount.promise;
    });
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "other-account" })).toBeInTheDocument();
    expect(screen.getByText("nightly")).toBeInTheDocument();
    expect(screen.queryByText("ci-pipeline")).toBeNull();
    expect(screen.queryByText("deploy")).toBeNull();
  });
});
