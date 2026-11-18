import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_TOKEN_NOT_FOUND_MESSAGE } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { API_TOKEN_REVOKE_FAILED_MESSAGE, API_TOKEN_REVOKED_MESSAGE } from "~/lib/service-accounts.js";
import { held } from "~/test/account.js";
import { attributesHolding } from "~/test/fleets.js";
import { ACCOUNT_ID, ORGANIZATION_ID, TOKEN_ID, apiToken, holdsText, renderInRouter } from "~/test/service-accounts.js";
import { RevokeApiTokenDialog } from "./RevokeApiTokenDialog.js";

/*
 * Revoking a token (D22 decisions 9, 31 and 43; Q137): it asks for
 * confirmation first, in Q137's words.
 */

function renderDialog(token = apiToken()) {
  const onRevoked = vi.fn();
  function Page() {
    const [open, setOpen] = useState(true);
    return (
      <RevokeApiTokenDialog
        open={open}
        onOpenChange={setOpen}
        organizationId={ORGANIZATION_ID}
        serviceAccountId={ACCOUNT_ID}
        token={token}
        onRevoked={() => {
          onRevoked();
          setOpen(false);
        }}
      />
    );
  }
  const user = renderInRouter(Page);
  return { user, onRevoked };
}

describe("RevokeApiTokenDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("asks with Q137's words, the token's name as text in the title and in no attribute", async () => {
    renderDialog(apiToken({ name: "canary-token-7a1" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Revoke token canary-token-7a1?" });
    expect(within(dialog).getByText("Any client using it loses access immediately.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Revoke" })).toBeEnabled();
    expect(attributesHolding("canary-token-7a1")).toEqual([]);
  });

  it("revokes after the confirm, toasts fixed words and reports back", async () => {
    const answer = held<undefined>();
    const revoke = vi.spyOn(apiClient, "revokeApiToken").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    const { user, onRevoked } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");
    // Nothing happens until the confirm is pressed.
    expect(revoke).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(revoke).toHaveBeenCalledWith(ORGANIZATION_ID, ACCOUNT_ID, TOKEN_ID);
    expect(within(dialog).getByRole("button", { name: "Revoking…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBe(dialog);

    answer.resolve(undefined);
    await waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
    // Booleans first (Ruling 99): no toast holds the token's name or prefix, then the words.
    const listed = apiToken();
    for (const text of [listed.name, listed.prefix]) expect(holdsText(success.mock.calls, text), "a toast holding the token's name or prefix").toBe(false);
    expect(success).toHaveBeenCalledWith(API_TOKEN_REVOKED_MESSAGE);
    expect(API_TOKEN_REVOKED_MESSAGE).toBe("Token revoked");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("a token revoked meanwhile toasts the API's words and reports back; another failure keeps the dialog", async () => {
    vi.spyOn(apiClient, "revokeApiToken")
      .mockRejectedValueOnce(new ApiError("server_error", "Something went wrong.", { status: 500 }))
      .mockRejectedValueOnce(new ApiError("api_token_not_found", API_TOKEN_NOT_FOUND_MESSAGE, { status: 404 }));
    const error = vi.spyOn(toast, "error");
    const { user, onRevoked } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");

    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(error.mock.calls.length, "a toast").toBe(1));
    const listed = apiToken();
    for (const text of [listed.name, listed.prefix]) expect(holdsText(error.mock.calls, text), "a toast holding the token's name or prefix").toBe(false);
    expect(error).toHaveBeenCalledWith(API_TOKEN_REVOKE_FAILED_MESSAGE);
    expect(API_TOKEN_REVOKE_FAILED_MESSAGE).toBe("Failed to revoke token");
    expect(onRevoked).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Revoke" })).toBeEnabled();

    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(error).toHaveBeenLastCalledWith(API_TOKEN_NOT_FOUND_MESSAGE));
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it("management lost meanwhile leaves for /app", async () => {
    vi.spyOn(apiClient, "revokeApiToken").mockRejectedValue(
      new ApiError("organization_admin_required", "Only an organization admin can do this", { status: 403 }),
    );
    const { user, onRevoked } = renderDialog();
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("takes any owner's calls (D25 Preflight ruling 22): their revoke and words, never the service account's", async () => {
    const calls = {
      create: vi.fn(),
      revoke: vi.fn(async () => undefined),
      startCall: () => () => true,
      leaveOn: () => false,
      isRefusal: () => false,
      failureMessage: (_failure: unknown, fallback: string) => fallback,
    };
    const serviceAccountRevoke = vi.spyOn(apiClient, "revokeApiToken");
    const success = vi.spyOn(toast, "success");
    const onRevoked = vi.fn();
    function Page() {
      const [open, setOpen] = useState(true);
      return <RevokeApiTokenDialog open={open} onOpenChange={setOpen} calls={calls} token={apiToken()} onRevoked={onRevoked} />;
    }
    const user = renderInRouter(Page);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
    expect(calls.revoke.mock.calls[0]).toEqual([TOKEN_ID]);
    expect(success).toHaveBeenCalledWith(API_TOKEN_REVOKED_MESSAGE);
    expect(serviceAccountRevoke).not.toHaveBeenCalled();
  });
});
