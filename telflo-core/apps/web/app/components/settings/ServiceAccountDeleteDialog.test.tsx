import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_ACCOUNT_NOT_FOUND_MESSAGE, type ServiceAccount } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import {
  SERVICE_ACCOUNT_DELETE_FAILED_MESSAGE,
  SERVICE_ACCOUNT_DELETED_MESSAGE,
  serviceAccountDeleteTokenWords,
} from "~/lib/service-accounts.js";
import { held } from "~/test/account.js";
import { attributesHolding } from "~/test/fleets.js";
import { ACCOUNT_ID, ORGANIZATION_ID, renderInRouter, serviceAccount, where } from "~/test/service-accounts.js";
import { ServiceAccountDeleteDialog } from "./ServiceAccountDeleteDialog.js";

/*
 * Deleting a service account, in its fixed words.
 */

function renderDialog(target: ServiceAccount = serviceAccount()) {
  const onDeleted = vi.fn();
  const onOpenChange = vi.fn();
  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <ServiceAccountDeleteDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          organizationId={ORGANIZATION_ID}
          target={target}
          onDeleted={(id) => {
            onDeleted(id);
            setOpen(false);
          }}
        />
      </>
    );
  }
  const user = renderInRouter(Page);
  return { user, onDeleted, onOpenChange };
}

describe("ServiceAccountDeleteDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps Permanently delete disabled until the typed name, trimmed, matches", async () => {
    const { user } = renderDialog();
    const dialog = await screen.findByRole("alertdialog", { name: "Delete service account: ci-pipeline" });
    const confirm = within(dialog).getByRole("button", { name: "Permanently delete" });
    const field = within(dialog).getByRole("textbox", { name: "This cannot be undone. Type the account's name to confirm." });
    expect(confirm).toBeDisabled();

    await user.type(field, "ci-pipelin");
    expect(confirm).toBeDisabled();
    await user.type(field, "e");
    expect(confirm).toBeEnabled();
    await user.clear(field);
    await user.type(field, "  ci-pipeline  ");
    expect(confirm).toBeEnabled();
    // Case counts: the name exactly, spaces aside.
    await user.clear(field);
    await user.type(field, "CI-pipeline");
    expect(confirm).toBeDisabled();
  });

  it("says its sentences for none, one and several tokens, and no list of deleted things", async () => {
    expect(serviceAccountDeleteTokenWords(0)).toBe("It will be removed from this organization.");
    expect(serviceAccountDeleteTokenWords(1)).toBe("Its token will stop working immediately, and it will be removed from this organization.");
    expect(serviceAccountDeleteTokenWords(2)).toBe("Its 2 tokens will stop working immediately, and it will be removed from this organization.");

    renderDialog(serviceAccount({ tokenCount: 1 }));
    const dialog = await screen.findByRole("alertdialog");
    const paragraphs = [...dialog.querySelectorAll("p")].map((paragraph) => paragraph.textContent);
    expect(paragraphs).toEqual([
      "Its token will stop working immediately, and it will be removed from this organization.",
      "Configurations, configuration versions, validation pipelines and rules, and test suites and runs it created are kept; configurations and their versions still show its address as their creator.",
      "This cannot be undone. Type the account's name to confirm.",
    ]);
    expect(dialog.querySelector("ul")).toBeNull();
    expect(dialog).not.toHaveTextContent(/secrets|chat history|attributed to this account|1 tokens/);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("puts the typed name nowhere but the field, inside ph-no-capture, and the name in no attribute", async () => {
    const { user } = renderDialog(serviceAccount({ name: "Canary Robot 41c" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete service account: Canary Robot 41c" });
    const field = within(dialog).getByRole("textbox");
    expect(field.closest(".ph-no-capture")).not.toBeNull();
    expect(field).not.toHaveAttribute("placeholder");
    expect(field).toHaveAttribute("maxlength", "64");
    expect(attributesHolding("Canary Robot 41c")).toEqual([]);
    await user.type(field, "Canary Robot 41c");
    expect(field).toHaveValue("Canary Robot 41c");
    expect(attributesHolding("Canary Robot 41c")).toEqual([]);
    expect(attributesHolding("Canary")).toEqual([]);
  });

  it("deletes and reports back", async () => {
    const answer = held<undefined>();
    const remove = vi.spyOn(apiClient, "deleteServiceAccount").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    const { user, onDeleted } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "ci-pipeline");
    await user.click(within(dialog).getByRole("button", { name: "Permanently delete" }));

    expect(remove).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT_ID);
    expect(within(dialog).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Unclosable while it deletes.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBe(dialog);

    answer.resolve(undefined);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(ACCOUNT_ID));
    expect(success).toHaveBeenCalledWith(SERVICE_ACCOUNT_DELETED_MESSAGE);
    expect(SERVICE_ACCOUNT_DELETED_MESSAGE).toBe("Service account deleted");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("a refusal keeps the dialog, toasting the API's words, and a failure the fallback", async () => {
    vi.spyOn(apiClient, "deleteServiceAccount")
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many requests. Try again later.", { status: 429 }))
      .mockRejectedValueOnce(new ApiError("server_error", "Something went wrong.", { status: 500 }));
    const error = vi.spyOn(toast, "error");
    const { user, onDeleted } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "ci-pipeline");

    await user.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Too many requests. Try again later."));
    expect(within(dialog).getByRole("button", { name: "Permanently delete" })).toBeEnabled();

    await user.click(within(dialog).getByRole("button", { name: "Permanently delete" }));
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(SERVICE_ACCOUNT_DELETE_FAILED_MESSAGE));
    expect(SERVICE_ACCOUNT_DELETE_FAILED_MESSAGE).toBe("Failed to delete service account");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBe(dialog);
  });

  it("an account deleted meanwhile (404 service_account_not_found) toasts the API's words and reports back, so the dialog closes and the list reads again", async () => {
    vi.spyOn(apiClient, "deleteServiceAccount").mockRejectedValue(
      new ApiError("service_account_not_found", SERVICE_ACCOUNT_NOT_FOUND_MESSAGE, { status: 404 }),
    );
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    const { user, onDeleted } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "ci-pipeline");
    await user.click(within(dialog).getByRole("button", { name: "Permanently delete" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(ACCOUNT_ID));
    expect(error).toHaveBeenCalledWith(SERVICE_ACCOUNT_NOT_FOUND_MESSAGE);
    expect(success).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("management lost meanwhile closes the dialog and leaves for /app with the API's message", async () => {
    vi.spyOn(apiClient, "deleteServiceAccount").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an organization admin can do this", { status: 403 }),
    );
    const error = vi.spyOn(toast, "error");
    const { user, onDeleted } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "ci-pipeline");
    await user.click(within(dialog).getByRole("button", { name: "Permanently delete" }));

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith("Only an organization admin can do this");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(where()).toContain("/app");
  });

  it("each opening starts empty, the button disabled", async () => {
    const { user } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "ci-pipeline");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    const again = await screen.findByRole("alertdialog");
    expect(within(again).getByRole("textbox")).toHaveValue("");
    expect(within(again).getByRole("button", { name: "Permanently delete" })).toBeDisabled();
  });
});
