import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_ACCOUNT_NAME_TAKEN_MESSAGE } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import {
  SERVICE_ACCOUNT_CREATE_FAILED_MESSAGE,
  SERVICE_ACCOUNT_CREATED_MESSAGE,
  SERVICE_ACCOUNT_DELETED_MESSAGE,
  SERVICE_ACCOUNTS_LOAD_FAILED_MESSAGE,
  SERVICE_ACCOUNTS_UNREADABLE,
  formatServiceAccountDate,
} from "~/lib/service-accounts.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { held } from "~/test/account.js";
import { ACCOUNT_ID, ADMIN_EMAIL, ORGANIZATION_ID, SECOND_ACCOUNT_ID, renderServiceAccountPages, serviceAccount } from "~/test/service-accounts.js";

/*
 * Settings › Service Accounts' list (D22 decisions 42 and 49): a session
 * always has an organization, and the page is keyed by it; the failed read,
 * the refusals and the row actions' names.
 */

const ACCOUNT = serviceAccount();
const GRAFANA = serviceAccount({ id: SECOND_ACCOUNT_ID, name: "grafana", email: "grafana-b1c2d3e4@service-accounts.telflo.invalid", tokenCount: 5 });

function serveAccounts(...answers: Array<ReturnType<typeof serviceAccount>[] | Error>) {
  const spy = vi.spyOn(apiClient, "getServiceAccounts");
  for (const answer of answers) {
    if (answer instanceof Error) spy.mockRejectedValueOnce(answer);
    else spy.mockResolvedValueOnce({ items: answer });
  }
  return spy;
}

const renderList = () => renderServiceAccountPages("/settings/service-accounts");

describe("ServiceAccountsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  it("lists accounts with creator and token count", async () => {
    const list = serveAccounts([ACCOUNT, { ...GRAFANA, createdBy: null }]);
    renderList();
    const table = await screen.findByRole("table");
    expect(list).toHaveBeenCalledWith(ORGANIZATION_ID, { signal: expect.any(AbortSignal) });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Created", "Created by", "Tokens", "Actions"]);
    const [, first, second] = within(table).getAllByRole("row");
    const shown = (row: HTMLElement) => within(row).getAllByRole("cell").slice(0, 4).map((cell) => cell.textContent);
    expect(shown(first!)).toEqual(["ci-pipeline", formatServiceAccountDate(ACCOUNT.createdAt), ADMIN_EMAIL, "2"]);
    // A creator whose user is gone: "—".
    expect(shown(second!)).toEqual(["grafana", formatServiceAccountDate(GRAFANA.createdAt), "—", "5"]);
    expect(formatServiceAccountDate(ACCOUNT.createdAt)).toMatch(/^Sep [12], 2026$/);
  });

  it("links the name to the detail page by id", async () => {
    serveAccounts([ACCOUNT]);
    renderList();
    const link = await screen.findByRole("link", { name: "ci-pipeline" });
    expect(link).toHaveAttribute("href", `/settings/service-accounts/${ACCOUNT_ID}`);
  });

  it("shows Loading…, then the empty state when the organization has no accounts", async () => {
    const answer = held<{ items: [] }>();
    vi.spyOn(apiClient, "getServiceAccounts").mockReturnValue(answer.promise);
    renderList();
    expect(await screen.findByRole("status")).toHaveTextContent("Loading…");
    answer.resolve({ items: [] });
    expect(await screen.findByText("No service accounts yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("a failed read toasts and says the accounts couldn't be loaded, not the empty state", async () => {
    serveAccounts(new ApiError("server_error", "Something went wrong.", { status: 500 }));
    const error = vi.spyOn(toast, "error");
    renderList();
    expect(await screen.findByText(SERVICE_ACCOUNTS_UNREADABLE)).toBeInTheDocument();
    expect(SERVICE_ACCOUNTS_UNREADABLE).toBe("Service accounts could not be loaded.");
    expect(error).toHaveBeenCalledWith(SERVICE_ACCOUNTS_LOAD_FAILED_MESSAGE);
    expect(SERVICE_ACCOUNTS_LOAD_FAILED_MESSAGE).toBe("Failed to load service accounts");
    expect(screen.queryByText("No service accounts yet.")).not.toBeInTheDocument();
  });

  it("the intro card has decision 42's words and the API reference, a plain link to the API's page with its slash (D25 decision 49)", async () => {
    serveAccounts([]);
    renderList();
    const intro = (await screen.findByText("About service accounts")).parentElement!;
    expect([...intro.querySelectorAll("p")].map((paragraph) => paragraph.textContent)).toEqual([
      "About service accounts",
      "A service account is a machine identity in this organization. Anything it creates through the Telflo API belongs to it, so activity stays attributable to the integration rather than to a person.",
      "Each account holds one or more API tokens. Rotate a token by adding a new one and revoking the old, without changing who the API acts as.",
      "The API reference lists the API’s routes and lets you try them with a token.",
      "Tokens are credentials for service account access—treat them with care.",
    ]);
    const links = [...intro.querySelectorAll("a")];
    expect(links.map((link) => ({ text: link.textContent, href: link.getAttribute("href"), target: link.getAttribute("target") }))).toEqual([
      { text: "API reference", href: "/api/public/v1/docs/", target: null },
    ]);
    expect(screen.getByRole("link", { name: "API reference" })).toBe(links[0]);
    expect(screen.getByRole("heading", { name: "Service Accounts" })).toBeInTheDocument();
    expect(screen.getByText("Machine identities for the Telflo public API, scoped to this organization.")).toBeInTheDocument();
    // The icons (Preflight ruling 30).
    expect(intro.parentElement!.querySelector("svg")?.getAttribute("class")).toContain("lucide-bot");
    expect(intro.querySelector("svg")?.getAttribute("class")).toContain("lucide-shield-alert");
    expect(screen.getByRole("button", { name: "Create service account" }).querySelector("svg")?.getAttribute("class")).toContain("lucide-plus");
  });

  it("disables Create until a name is typed, spaces aside", async () => {
    serveAccounts([ACCOUNT]);
    const user = renderList();
    await screen.findByText("ci-pipeline");
    await user.click(screen.getByRole("button", { name: "Create service account" }));
    const dialog = await screen.findByRole("dialog", { name: "Create service account" });
    expect(within(dialog).getByText("Give the account a name that says what uses it. You can add tokens to it afterwards.")).toBeInTheDocument();
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveAttribute("placeholder", "e.g. CI pipeline");
    expect(name).toHaveAttribute("maxlength", "64");
    await user.type(name, "   ");
    expect(create).toBeDisabled();
    await user.type(name, "x");
    expect(create).toBeEnabled();
    await user.clear(name);
    expect(create).toBeDisabled();
  });

  it("creates an account, toasts fixed words and reads the list again", async () => {
    const list = serveAccounts([ACCOUNT], [GRAFANA, ACCOUNT]);
    const answer = held<{ serviceAccount: typeof GRAFANA }>();
    const create = vi.spyOn(apiClient, "createServiceAccount").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    const user = renderList();
    await screen.findByText("ci-pipeline");

    await user.click(screen.getByRole("button", { name: "Create service account" }));
    const dialog = await screen.findByRole("dialog", { name: "Create service account" });
    await user.type(within(dialog).getByLabelText("Name"), "  grafana  ");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(create).toHaveBeenCalledWith(ORGANIZATION_ID, { name: "grafana" });
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    answer.resolve({ serviceAccount: GRAFANA });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(success).toHaveBeenCalledWith(SERVICE_ACCOUNT_CREATED_MESSAGE);
    expect(SERVICE_ACCOUNT_CREATED_MESSAGE).toBe("Service account created");
    expect(await screen.findByText("grafana")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);

    // A new opening starts empty, Create disabled.
    await user.click(screen.getByRole("button", { name: "Create service account" }));
    const again = await screen.findByRole("dialog", { name: "Create service account" });
    expect(within(again).getByLabelText("Name")).toHaveValue("");
    expect(within(again).getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("a refusal toasts the API's message and keeps the dialog; an answer that never came toasts the fallback and reads the list again", async () => {
    const list = serveAccounts([ACCOUNT], [ACCOUNT]);
    vi.spyOn(apiClient, "createServiceAccount")
      .mockRejectedValueOnce(new ApiError("service_account_name_taken", SERVICE_ACCOUNT_NAME_TAKEN_MESSAGE, { status: 409 }))
      .mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const error = vi.spyOn(toast, "error");
    const user = renderList();
    await screen.findByText("ci-pipeline");
    await user.click(screen.getByRole("button", { name: "Create service account" }));
    const dialog = await screen.findByRole("dialog", { name: "Create service account" });
    await user.type(within(dialog).getByLabelText("Name"), "CI-Pipeline");

    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(SERVICE_ACCOUNT_NAME_TAKEN_MESSAGE));
    expect(screen.getByRole("dialog", { name: "Create service account" })).toBe(dialog);
    expect(within(dialog).getByLabelText("Name")).toHaveValue("CI-Pipeline");
    expect(list).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(SERVICE_ACCOUNT_CREATE_FAILED_MESSAGE));
    expect(SERVICE_ACCOUNT_CREATE_FAILED_MESSAGE).toBe("Failed to create service account");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name: "Create service account" })).toBe(dialog);
  });

  it("names each row's Delete by fixed words and the name cell, and opens the delete dialog for that row", async () => {
    serveAccounts([ACCOUNT, GRAFANA]);
    const user = renderList();
    await screen.findByText("grafana");

    const remove = screen.getByRole("button", { name: "Delete service account grafana" });
    expect(remove).not.toHaveAttribute("aria-label");
    expect(remove.querySelector("svg")?.getAttribute("class")).toContain("lucide-trash2");
    expect(screen.getByRole("button", { name: "Delete service account ci-pipeline" })).toBeInTheDocument();

    await user.click(remove);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete service account: grafana" });
    expect(dialog).toHaveTextContent("Its 5 tokens will stop working immediately, and it will be removed from this organization.");
    expect(screen.queryByText(/Delete service account: ci-pipeline/)).not.toBeInTheDocument();
  });

  it("a delete toasts, closes and reads the list again", async () => {
    const list = serveAccounts([ACCOUNT, GRAFANA], [ACCOUNT]);
    const remove = vi.spyOn(apiClient, "deleteServiceAccount").mockResolvedValue(undefined);
    const success = vi.spyOn(toast, "success");
    const user = renderList();
    await screen.findByText("grafana");

    await user.click(screen.getByRole("button", { name: "Delete service account grafana" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "grafana");
    await user.click(within(dialog).getByRole("button", { name: "Permanently delete" }));

    expect(remove).toHaveBeenCalledWith(ORGANIZATION_ID, SECOND_ACCOUNT_ID);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(success).toHaveBeenCalledWith(SERVICE_ACCOUNT_DELETED_MESSAGE);
    await waitFor(() => expect(screen.queryByText("grafana")).not.toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("ci-pipeline")).toBeInTheDocument();
  });
});
