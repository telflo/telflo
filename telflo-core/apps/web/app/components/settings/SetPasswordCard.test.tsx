import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetPasswordCard, useSetPassword } from "./SetPasswordCard.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { SET_PASSWORD_FAILED_MESSAGE } from "~/lib/account.js";
import { ACCOUNT_EMAIL, held } from "~/test/account.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";

/* Set a Password (D21 decisions 36 and 45): D3's reset link for the account's own email. */

function Card() {
  return <SetPasswordCard email={ACCOUNT_EMAIL} setPassword={useSetPassword(ACCOUNT_EMAIL)} />;
}

describe("SetPasswordCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the reset for the account's own email and says so in fixed words", async () => {
    const answer = held<{ status: "accepted" }>();
    const requestPasswordReset = vi.spyOn(apiClient, "requestPasswordReset").mockReturnValue(answer.promise);
    const toasts = [vi.spyOn(toast, "success"), vi.spyOn(toast, "error")];
    render(<Card />);
    const user = userEvent.setup();

    expect(screen.getByRole("heading", { name: "Set a Password" })).toBeInTheDocument();
    expect(screen.getByText("Your account signs in with Google. We'll email you a link to set a password.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(requestPasswordReset).toHaveBeenCalledWith({ email: ACCOUNT_EMAIL });
    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();

    answer.resolve({ status: "accepted" });
    expect(await screen.findByRole("status")).toHaveTextContent(
      `We sent a link to ${ACCOUNT_EMAIL}. Open it to set your password. Setting it signs you out on every device.`,
    );
    expect(screen.queryByRole("button", { name: "Email me a link" })).not.toBeInTheDocument();
    expect(requestPasswordReset).toHaveBeenCalledTimes(1);
    // The email is text, never a toast or an attribute.
    for (const spy of toasts) expect(spy).not.toHaveBeenCalled();
    expectNoAttributeHolds(ACCOUNT_EMAIL);
  });

  it("a limit toasts its fixed message, anything else fixed words, and the button comes back", async () => {
    vi.spyOn(apiClient, "requestPasswordReset")
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many requests. Try again later.", { status: 429 }))
      .mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const error = vi.spyOn(toast, "error");
    render(<Card />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Too many requests. Try again later."));
    await user.click(await screen.findByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(SET_PASSWORD_FAILED_MESSAGE));
    expect(screen.getByRole("button", { name: "Email me a link" })).toBeEnabled();
  });
});
