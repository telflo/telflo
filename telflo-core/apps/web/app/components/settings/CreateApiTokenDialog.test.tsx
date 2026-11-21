import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_TOKEN_EXPIRY_DAYS_MESSAGE,
  API_TOKEN_LIMIT_REACHED_MESSAGE,
  API_TOKEN_PATTERN,
  type CreatedApiTokenResponse,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { API_TOKEN_CREATE_FAILED_MESSAGE } from "~/lib/service-accounts.js";
import { held } from "~/test/account.js";
import { anyStateHolds, attributesHolding } from "~/test/fleets.js";
import {
  ACCOUNT_ID,
  ORGANIZATION_ID,
  apiToken,
  buildApiToken,
  quietQueries,
  renderInRouter,
  waitUntilGone,
} from "~/test/service-accounts.js";
import { CreateApiTokenDialog, expiryDaysOf } from "./CreateApiTokenDialog.js";

/*
 * "Create API token": minting a token on the account, the expiry's check, the
 * refusals and the lost answer. Its token is built at run time and
 * compared only as a boolean.
 */

function renderDialog() {
  const onCreated = vi.fn();
  const onUnknownOutcome = vi.fn();
  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <CreateApiTokenDialog
        open={open}
        onOpenChange={setOpen}
        organizationId={ORGANIZATION_ID}
        serviceAccountId={ACCOUNT_ID}
        onCreated={onCreated}
        onUnknownOutcome={onUnknownOutcome}
      />
    );
  }
  const user = renderInRouter(Page);
  return { user, onCreated, onUnknownOutcome };
}

async function openDialog() {
  const rendered = renderDialog();
  const dialog = await screen.findByRole("dialog", { name: "Create API token" });
  return { ...rendered, dialog };
}

function created(token: string, over: Partial<CreatedApiTokenResponse["apiToken"]> = {}): CreatedApiTokenResponse {
  return { apiToken: apiToken({ name: "ci", prefix: token.slice(0, 11), ...over }), token };
}

describe("CreateApiTokenDialog", () => {
  let unquiet: () => void;
  beforeEach(() => {
    vi.restoreAllMocks();
    unquiet = quietQueries();
  });
  afterEach(() => unquiet());

  it("has its words and fields: the name inside ph-no-capture, write access off, the expiry a text field with a numeric keyboard", async () => {
    const { user, dialog } = await openDialog();
    expect(within(dialog).getByText("The token will be shown once. Store it somewhere safe.")).toBeInTheDocument();
    const name = within(dialog).getByLabelText("Name");
    expect(name.closest(".ph-no-capture")).not.toBeNull();
    expect(name).toHaveAttribute("placeholder", "e.g. CI pipeline");
    expect(name).toHaveAttribute("maxlength", "64");
    const write = within(dialog).getByRole("checkbox", { name: "Allow write access" });
    expect(write).not.toBeChecked();
    expect(within(dialog).getByText("Create, update, and delete resources. Leave off for read-only.")).toBeInTheDocument();
    const expiry = within(dialog).getByLabelText("Expires in (days, optional)");
    expect(expiry).toHaveAttribute("type", "text");
    expect(expiry).toHaveAttribute("inputmode", "numeric");
    expect(expiry).toHaveAttribute("placeholder", "Never");

    const create = within(dialog).getByRole("button", { name: "Create token" });
    expect(create).toBeDisabled();
    await user.type(name, "  ");
    expect(create).toBeDisabled();
    await user.type(name, "canary-token-name-9d");
    expect(create).toBeEnabled();
    // The typed name is never an attribute.
    expect(attributesHolding("canary-token-name-9d")).toEqual([]);
  });

  it("sends Read and never by default, the name trimmed", async () => {
    const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(created(buildApiToken()));
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText("Name"), "  ci  ");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]).toEqual([ORGANIZATION_ID, ACCOUNT_ID, { name: "ci", access: "read", expiresInDays: null }]);
  });

  it("sends Read & write and the days typed", async () => {
    const create = vi.spyOn(apiClient, "createApiToken").mockResolvedValue(created(buildApiToken(), { access: "write" }));
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    await user.click(within(dialog).getByLabelText("Allow write access"));
    await user.type(within(dialog).getByLabelText("Expires in (days, optional)"), " 30 ");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]).toEqual([ORGANIZATION_ID, ACCOUNT_ID, { name: "ci", access: "write", expiresInDays: 30 }]);
  });

  it("refuses an expiry outside 1 to 3650 before sending", async () => {
    expect(expiryDaysOf("")).toBeNull();
    expect(expiryDaysOf("   ")).toBeNull();
    expect(expiryDaysOf("1")).toBe(1);
    expect(expiryDaysOf("3650")).toBe(3650);
    expect(expiryDaysOf("007")).toBe(7);
    for (const typed of ["0", "3651", "1.5", "-1", "7d", "1e3", "seven", "+5", "٣"]) expect(expiryDaysOf(typed), typed).toBeUndefined();

    const create = vi.spyOn(apiClient, "createApiToken");
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    const expiry = within(dialog).getByLabelText("Expires in (days, optional)");
    for (const typed of ["0", "3651", "1.5", "abc"]) {
      await user.clear(expiry);
      await user.type(expiry, typed);
      await user.click(within(dialog).getByRole("button", { name: "Create token" }));
      expect(within(dialog).getByRole("alert")).toHaveTextContent(API_TOKEN_EXPIRY_DAYS_MESSAGE);
      expect(expiry).toHaveAttribute("aria-invalid", "true");
    }
    expect(API_TOKEN_EXPIRY_DAYS_MESSAGE).toBe("Enter a whole number of days from 1 to 3650.");
    expect(create).not.toHaveBeenCalled();
    // Typing again clears the problem.
    await user.type(expiry, "x");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hands the reply's token to the page, keeps it in no state of its own, and closes", async () => {
    const token = buildApiToken();
    expect(API_TOKEN_PATTERN.test(token)).toBe(true);
    const answer = held<CreatedApiTokenResponse>();
    vi.spyOn(apiClient, "createApiToken").mockReturnValue(answer.promise);
    const { user, dialog, onCreated, onUnknownOutcome } = await openDialog();
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Unclosable while it creates.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);

    answer.resolve(created(token));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]![0] === token, "the reply's token handed on").toBe(true);
    await waitUntilGone(() => screen.queryByRole("dialog"), "the create dialog closed");
    expect(document.body.innerHTML.includes(token), "the token in the DOM").toBe(false);
    expect(anyStateHolds(token), "the token in a component's state").toBe(false);
    expect(onUnknownOutcome).not.toHaveBeenCalled();
  });

  it("a refusal toasts the API's words and keeps the dialog; an answer that never came toasts the fallback and the list is read again", async () => {
    vi.spyOn(apiClient, "createApiToken")
      .mockRejectedValueOnce(new ApiError("api_token_limit_reached", API_TOKEN_LIMIT_REACHED_MESSAGE, { status: 409 }))
      .mockRejectedValueOnce(new ApiError("server_error", "Something went wrong.", { status: 500 }));
    const error = vi.spyOn(toast, "error");
    const { user, dialog, onCreated, onUnknownOutcome } = await openDialog();
    await user.type(within(dialog).getByLabelText("Name"), "ci");

    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(API_TOKEN_LIMIT_REACHED_MESSAGE));
    expect(API_TOKEN_LIMIT_REACHED_MESSAGE).toBe("This service account has 20 tokens. Revoke one first.");
    expect(onUnknownOutcome).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog);

    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(API_TOKEN_CREATE_FAILED_MESSAGE));
    expect(API_TOKEN_CREATE_FAILED_MESSAGE).toBe("Failed to create token");
    expect(onUnknownOutcome).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("management lost meanwhile closes the dialog and leaves for /app", async () => {
    vi.spyOn(apiClient, "createApiToken").mockRejectedValue(
      new ApiError("organization_not_found", "Organization not found", { status: 404 }),
    );
    const error = vi.spyOn(toast, "error");
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Organization not found");
  });

  it("takes any owner's calls: their create and words; an answer no longer current is dropped, and only leaveOn decides a leave", async () => {
    const token = buildApiToken();
    let current = true;
    const calls = {
      create: vi.fn(async () => created(token)),
      revoke: vi.fn(),
      startCall: () => () => current,
      leaveOn: vi.fn(() => false),
      isRefusal: () => true,
      failureMessage: () => "the owner's words",
    };
    const serviceAccountCreate = vi.spyOn(apiClient, "createApiToken");
    const onCreated = vi.fn();
    const error = vi.spyOn(toast, "error");
    function Page() {
      const [open, setOpen] = useState(true);
      return <CreateApiTokenDialog open={open} onOpenChange={setOpen} calls={calls} onCreated={onCreated} onUnknownOutcome={vi.fn()} />;
    }
    const user = renderInRouter(Page);
    const dialog = await screen.findByRole("dialog", { name: "Create API token" });
    await user.type(within(dialog).getByLabelText("Name"), "ci");
    current = false;
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(calls.create).toHaveBeenCalledTimes(1));
    expect(calls.create.mock.calls[0]).toEqual([{ name: "ci", access: "read", expiresInDays: null }]);
    expect(onCreated).not.toHaveBeenCalled();
    expect(serviceAccountCreate).not.toHaveBeenCalled();

    current = true;
    calls.create.mockRejectedValueOnce(new ApiError("api_token_name_taken", "taken", { status: 409 }));
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("the owner's words"));
    expect(calls.leaveOn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });
});
