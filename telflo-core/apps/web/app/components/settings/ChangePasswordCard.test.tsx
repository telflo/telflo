import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordCard } from "./ChangePasswordCard.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { ChangePasswordRequestSchema } from "@telflo/contracts";
import {
  NEW_PASSWORD_MAXIMUM_LENGTH,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  PASSWORD_UPDATE_FAILED_MESSAGE,
  PASSWORD_UPDATED_MESSAGE,
  PASSWORDS_DO_NOT_MATCH_MESSAGE,
} from "~/lib/account.js";
import { held } from "~/test/account.js";
import { expectNoAttributeHolds } from "~/test/fleets.js";

/*
 * Change Password (D21 decisions 35 and 45): the web's checks before
 * sending, the API's message under Current Password, success's toast, and
 * the passwords only in the fields, emptied after every answer.
 */

const CURRENT = "canary-current-pw-81f2";
const NEXT = "canary-new-password-5d0e";

const current = () => screen.getByLabelText("Current Password");
const next = () => screen.getByLabelText("New Password");
const confirm = () => screen.getByLabelText("Confirm New Password");
const update = () => screen.getByRole("button", { name: /^(Update Password|Updating\.\.\.)$/ });

async function fill(user: ReturnType<typeof userEvent.setup>, values: { current: string; next: string; confirm: string }) {
  await user.type(current(), values.current);
  await user.type(next(), values.next);
  await user.type(confirm(), values.confirm);
}

function fieldsAreEmpty() {
  for (const field of [current(), next(), confirm()]) expect((field as HTMLInputElement).value).toBe("");
}

describe("ChangePasswordCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("shows the card with the current password, Update Password disabled until all three are filled", async () => {
    render(<ChangePasswordCard />);
    const user = userEvent.setup();
    expect(screen.getByRole("heading", { name: "Change Password" })).toBeInTheDocument();
    for (const field of [current(), next(), confirm()]) expect(field).toHaveAttribute("type", "password");
    expect(update()).toBeDisabled();
    await user.type(current(), "a");
    await user.type(next(), "b");
    expect(update()).toBeDisabled();
    await user.type(confirm(), "c");
    expect(update()).toBeEnabled();
  });

  it("checks the match and the length before sending", async () => {
    const changePassword = vi.spyOn(apiClient, "changePassword");
    render(<ChangePasswordCard />);
    const user = userEvent.setup();

    await fill(user, { current: CURRENT, next: NEXT, confirm: `${NEXT}x` });
    await user.click(update());
    expect(screen.getByRole("alert")).toHaveTextContent(PASSWORDS_DO_NOT_MATCH_MESSAGE);
    expect(PASSWORDS_DO_NOT_MATCH_MESSAGE).toBe("Passwords do not match");

    // The match is checked first, then the length: 11 characters, matching.
    await user.clear(next());
    await user.clear(confirm());
    await user.type(next(), "elevenchars");
    await user.type(confirm(), "elevenchars");
    await user.click(update());
    expect(screen.getByRole("alert")).toHaveTextContent(PASSWORD_TOO_SHORT_MESSAGE);
    expect(PASSWORD_TOO_SHORT_MESSAGE).toBe("Password must be at least 12 characters");
    expect(changePassword).not.toHaveBeenCalled();

    // Twelve is enough, and the current password goes as typed, untrimmed.
    changePassword.mockResolvedValue(undefined);
    await user.clear(next());
    await user.clear(confirm());
    await user.type(next(), "twelve chars");
    await user.type(confirm(), "twelve chars");
    await user.click(update());
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith({ currentPassword: CURRENT, newPassword: "twelve chars" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a new password over the API's 128 characters is too long, without a maxLength that would cut a paste short", async () => {
    const changePassword = vi.spyOn(apiClient, "changePassword").mockResolvedValue(undefined);
    render(<ChangePasswordCard />);
    const user = userEvent.setup();
    // The web's limit is the contract's (the package doesn't export its constant).
    const longest = "p".repeat(NEW_PASSWORD_MAXIMUM_LENGTH);
    expect(NEW_PASSWORD_MAXIMUM_LENGTH).toBe(128);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: CURRENT, newPassword: longest }).success).toBe(true);
    expect(ChangePasswordRequestSchema.safeParse({ currentPassword: CURRENT, newPassword: `${longest}p` }).success).toBe(false);
    for (const field of [next(), confirm()]) expect(field).not.toHaveAttribute("maxlength");

    await user.type(current(), CURRENT);
    await user.click(next());
    await user.paste(`${longest}p`);
    await user.click(confirm());
    await user.paste(`${longest}p`);
    await user.click(update());
    expect(screen.getByRole("alert")).toHaveTextContent(PASSWORD_TOO_LONG_MESSAGE);
    expect(PASSWORD_TOO_LONG_MESSAGE).toBe("Password must be at most 128 characters");
    expect(changePassword).not.toHaveBeenCalled();
    // A check that fails in the browser keeps what was typed.
    expect((next() as HTMLInputElement).value).toBe(`${longest}p`);

    await user.clear(next());
    await user.clear(confirm());
    await user.click(next());
    await user.paste(longest);
    await user.click(confirm());
    await user.paste(longest);
    await user.click(update());
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith({ currentPassword: CURRENT, newPassword: longest }));
  });

  it("shows the API's message under Current Password", async () => {
    vi.spyOn(apiClient, "changePassword").mockRejectedValue(
      new ApiError("current_password_incorrect", "The current password is incorrect.", { status: 400 }),
    );
    const error = vi.spyOn(toast, "error");
    render(<ChangePasswordCard />);
    const user = userEvent.setup();

    await fill(user, { current: CURRENT, next: NEXT, confirm: NEXT });
    await user.click(update());

    expect(await screen.findByRole("alert")).toHaveTextContent("The current password is incorrect.");
    expect(current()).toHaveAccessibleDescription("The current password is incorrect.");
    expect(current()).toHaveAttribute("aria-invalid", "true");
    expect(error).not.toHaveBeenCalled();
    fieldsAreEmpty();
  });

  it("after a wrong current password, the field takes the focus again once it is enabled", async () => {
    const answer = held<undefined>();
    vi.spyOn(apiClient, "changePassword").mockReturnValue(answer.promise);
    render(<ChangePasswordCard />);
    const user = userEvent.setup();

    await fill(user, { current: CURRENT, next: NEXT, confirm: NEXT });
    await user.click(update());
    expect(current()).toBeDisabled();
    expect(current()).not.toHaveFocus();

    answer.reject(new ApiError("current_password_incorrect", "The current password is incorrect.", { status: 400 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The current password is incorrect.");
    expect(current()).toBeEnabled();
    expect(current()).toHaveFocus();
  });

  it("after a wrong current password, a focus moved out of the form meanwhile stays where the person put it", async () => {
    const answer = held<undefined>();
    vi.spyOn(apiClient, "changePassword").mockReturnValue(answer.promise);
    render(
      <>
        <ChangePasswordCard />
        <button type="button">Elsewhere</button>
      </>,
    );
    const user = userEvent.setup();

    await fill(user, { current: CURRENT, next: NEXT, confirm: NEXT });
    await user.click(update());
    expect(current()).toBeDisabled();
    await user.tab();
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    expect(elsewhere).toHaveFocus();

    answer.reject(new ApiError("current_password_incorrect", "The current password is incorrect.", { status: 400 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The current password is incorrect.");
    expect(current()).toBeEnabled();
    expect(elsewhere).toHaveFocus();
    expect(current()).not.toHaveFocus();
  });

  it("toasts another refusal's fixed message, and anything else the fallback words, emptying the fields", async () => {
    const changePassword = vi
      .spyOn(apiClient, "changePassword")
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many attempts. Try again later.", { status: 429 }))
      .mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const error = vi.spyOn(toast, "error");
    render(<ChangePasswordCard />);
    const user = userEvent.setup();

    await fill(user, { current: CURRENT, next: NEXT, confirm: NEXT });
    await user.click(update());
    await waitFor(() => expect(error).toHaveBeenCalledWith("Too many attempts. Try again later."));
    fieldsAreEmpty();

    await fill(user, { current: CURRENT, next: NEXT, confirm: NEXT });
    await user.click(update());
    await waitFor(() => expect(error).toHaveBeenCalledWith(PASSWORD_UPDATE_FAILED_MESSAGE));
    expect(changePassword).toHaveBeenCalledTimes(2);
    fieldsAreEmpty();
  });

  it("toasts and empties the fields on success", async () => {
    const answer = held<undefined>();
    vi.spyOn(apiClient, "changePassword").mockReturnValue(answer.promise);
    const success = vi.spyOn(toast, "success");
    render(<ChangePasswordCard />);
    const user = userEvent.setup();

    await fill(user, { current: CURRENT, next: NEXT, confirm: NEXT });
    await user.click(update());
    expect(update()).toHaveTextContent("Updating...");
    expect(update()).toBeDisabled();

    answer.resolve(undefined);
    await waitFor(() => expect(success).toHaveBeenCalledWith(PASSWORD_UPDATED_MESSAGE));
    expect(PASSWORD_UPDATED_MESSAGE).toBe("Password updated successfully");
    fieldsAreEmpty();
    expect(update()).toHaveTextContent("Update Password");
    expect(update()).toBeDisabled();
  });

  it("the passwords are in no attribute and no storage", async () => {
    const answer = held<undefined>();
    vi.spyOn(apiClient, "changePassword").mockReturnValue(answer.promise);
    const toastCalls = [vi.spyOn(toast, "success"), vi.spyOn(toast, "error")];
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(<ChangePasswordCard />);
    const user = userEvent.setup();

    await fill(user, { current: CURRENT, next: NEXT, confirm: NEXT });
    // Typed, and while the change is in flight: in the fields' values alone, never an attribute.
    expectNoAttributeHolds(CURRENT);
    expectNoAttributeHolds(NEXT);
    await user.click(update());
    expectNoAttributeHolds(CURRENT);
    expectNoAttributeHolds(NEXT);

    answer.resolve(undefined);
    await waitFor(() => expect(toastCalls[0]).toHaveBeenCalled());
    expectNoAttributeHolds(CURRENT);
    expectNoAttributeHolds(NEXT);
    expect(document.body.textContent).not.toContain(CURRENT);
    expect(document.body.textContent).not.toContain(NEXT);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    for (const call of toastCalls.flatMap((spy) => spy.mock.calls)) {
      expect(JSON.stringify(call)).not.toContain(CURRENT);
      expect(JSON.stringify(call)).not.toContain(NEXT);
    }
  });
});
