import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnlinkProviderDialog } from "./UnlinkProviderDialog.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { UNLINK_FAILED_MESSAGE } from "~/lib/account.js";
import { GOOGLE, held } from "~/test/account.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";

/* Unlinking a provider (D21 decisions 39 and 45). */

const PASSWORD = "canary-unlink-pw-3e9f";
const onChanged = vi.fn();

function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <UnlinkProviderDialog open={open} onOpenChange={setOpen} provider={GOOGLE} relinksByEmail onChanged={onChanged} />
    </>
  );
}

describe("UnlinkProviderDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    onChanged.mockReset();
  });

  it("asks in fixed words, and closing it takes the typed password with it", async () => {
    const unlink = vi.spyOn(apiClient, "unlinkIdentity");
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink Google" });
    // Q126: a Google sign-in with the account's own address links it again, and the words say so.
    expect(dialog).toHaveAccessibleDescription(
      "Enter your current password to remove this sign-in. You can still sign in with your password. " +
        "If your Telflo address is this Google account's address, signing in with Google links it again.",
    );
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    expectNoAttributeHolds(PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Open" }));
    const again = await screen.findByRole("dialog", { name: "Unlink Google" });
    expect((within(again).getByLabelText("Current Password") as HTMLInputElement).value).toBe("");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("says the re-link in the provider's configured name", async () => {
    render(
      <UnlinkProviderDialog
        open
        onOpenChange={() => {}}
        provider={{ id: "corp", name: "Acme SSO" }}
        relinksByEmail
        onChanged={onChanged}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Unlink Acme SSO" });
    expect(dialog).toHaveAccessibleDescription(
      expect.stringContaining("If your Telflo address is this Acme SSO account's address, signing in with Acme SSO links it again."),
    );
  });

  it("leaves the re-link sentence out when the identity's provider doesn't re-link by email (Ruling 92)", async () => {
    // relinksByEmail false: not configured, or configured without an email-authority rule (Google at another issuer).
    render(
      <UnlinkProviderDialog
        open
        onOpenChange={() => {}}
        provider={GOOGLE}
        relinksByEmail={false}
        onChanged={onChanged}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Unlink Google" });
    expect(dialog).toHaveAccessibleDescription(
      "Enter your current password to remove this sign-in. You can still sign in with your password.",
    );
  });

  it("a wrong password is announced, and the emptied field takes the focus again once it is enabled", async () => {
    const answer = held<undefined>();
    vi.spyOn(apiClient, "unlinkIdentity").mockReturnValue(answer.promise);
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink Google" });
    const field = within(dialog).getByLabelText("Current Password");
    await user.type(field, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    expect(field).toBeDisabled();
    expect(field).not.toHaveFocus();

    answer.reject(new ApiError("current_password_incorrect", "The current password is incorrect.", { status: 400 }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The current password is incorrect.");
    expect(field).toBeEnabled();
    expect(field).toHaveFocus();
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("a failure that isn't a refusal toasts fixed words, closes, and reads the methods again", async () => {
    vi.spyOn(apiClient, "unlinkIdentity").mockRejectedValue(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const error = vi.spyOn(toast, "error");
    render(<Opener />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Unlink Google" });
    await user.type(within(dialog).getByLabelText("Current Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(UNLINK_FAILED_MESSAGE));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain(PASSWORD);
  });
});
