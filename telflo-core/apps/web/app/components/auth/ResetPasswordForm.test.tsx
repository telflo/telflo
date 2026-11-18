import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { RESET_TOKEN_STORAGE_KEY, ResetPasswordForm } from "./ResetPasswordForm.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";

const GOOD_PASSWORD = "a-long-enough-password";
const SUCCESS_TEXT = "Password updated successfully! Redirecting...";

function routesStub() {
  return createRoutesStub([
    { path: "/reset-password", Component: ResetPasswordForm },
    { path: "/login", Component: () => <p>landed on /login</p> },
    { path: "/forgot-password", Component: () => <p>landed on /forgot-password</p> },
  ]);
}

/**
 * Renders the form at `url`. The form reads the token from the browser's own
 * `location.hash` (D3 Ruling 14), which the router's in-memory entries don't
 * set, so the document's URL is set to match.
 */
function renderAt(url = "/reset-password#token=from-the-email") {
  window.history.replaceState(null, "", url);
  const Stub = routesStub();
  return render(<Stub initialEntries={[url.split("#")[0]!]} />);
}

async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  password = GOOD_PASSWORD,
  confirmPassword = password,
) {
  await user.type(await screen.findByLabelText("New Password"), password);
  await user.type(screen.getByLabelText("Confirm Password"), confirmPassword);
  await user.click(screen.getByRole("button", { name: "Update Password" }));
}

describe("ResetPasswordForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("renders the card with neither the form nor the missing-code alert on the server", () => {
    // The server never sees the fragment; effects don't run in a server render.
    const Stub = routesStub();
    const html = renderToString(<Stub initialEntries={["/reset-password"]} />);

    expect(html).toContain("Set New Password");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('id="password"');
    expect(html).not.toContain("Update Password");
    expect(html).not.toContain("missing its reset code");
  });

  it("takes the token out of the address bar as it mounts, before analytics can record the URL (D4 Ruling 14)", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword").mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAt("/reset-password?utm_source=mail#token=from-the-email");

    await screen.findByLabelText("New Password");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain("from-the-email");
    expect(window.location.pathname + window.location.search).toBe("/reset-password?utm_source=mail");

    await fillAndSubmit(user);
    await screen.findByText(SUCCESS_TEXT);
    expect(spy).toHaveBeenCalledWith({ token: "from-the-email", password: GOOD_PASSWORD });
  });

  it("keeps the token for a reload, as it did when the token stayed in the address bar", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword").mockResolvedValue(undefined);
    const user = userEvent.setup();
    const first = renderAt();
    await screen.findByLabelText("New Password");
    first.unmount();

    // The reload: the address bar no longer has the fragment.
    renderAt("/reset-password");
    await fillAndSubmit(user);

    await screen.findByText(SUCCESS_TEXT);
    expect(spy).toHaveBeenCalledWith({ token: "from-the-email", password: GOOD_PASSWORD });
    // Used: a later visit asks for a new link.
    expect(sessionStorage.getItem(RESET_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("forgets a token the API says is no good", async () => {
    vi.spyOn(apiClient, "resetPassword").mockRejectedValue(
      new ApiError("invalid_reset_token", "That reset link is invalid or has expired. Request a new one."),
    );
    const user = userEvent.setup();
    renderAt();
    await fillAndSubmit(user);

    await screen.findByText(/that reset link is invalid or has expired/i);
    expect(sessionStorage.getItem(RESET_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("keeps the token after another failure, for another try", async () => {
    vi.spyOn(apiClient, "resetPassword").mockRejectedValue(
      new ApiError("rate_limited", "Too many attempts. Try again in 5 minutes."),
    );
    const user = userEvent.setup();
    renderAt();
    await fillAndSubmit(user);

    await screen.findByText("Too many attempts. Try again in 5 minutes.");
    expect(sessionStorage.getItem(RESET_TOKEN_STORAGE_KEY)).toBe("from-the-email");
  });

  it("reads the token from the fragment, not the query", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword");
    renderAt("/reset-password?token=from-a-query");

    expect(await screen.findByText(/this link is missing its reset code\./i)).toBeInTheDocument();
    expect(screen.queryByLabelText("New Password")).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the card, with D1's minimum as the hint", async () => {
    renderAt();
    expect(await screen.findByText("Set New Password")).toBeInTheDocument();
    expect(screen.getByText("Enter your new password below")).toBeInTheDocument();
    expect(screen.getByText("Minimum 12 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText("New Password")).toHaveAttribute("minlength", "12");
    expect(screen.getByLabelText("New Password")).toHaveAttribute("placeholder", "••••••••");
    expect(screen.getByLabelText("Confirm Password")).toHaveAttribute("placeholder", "••••••••");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("leaves validation to the page, so a real browser shows its messages in its order", async () => {
    renderAt();
    const form = (await screen.findByLabelText("New Password")).closest("form")!;
    expect(form).toHaveAttribute("novalidate");
  });

  it("checks the match first, sending nothing", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword");
    const user = userEvent.setup();
    renderAt();
    // Both too short and different: the mismatch is reported.
    await fillAndSubmit(user, "short", "shorter");

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("then checks the length, sending nothing", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword");
    const user = userEvent.setup();
    renderAt();
    await fillAndSubmit(user, "elevenchars");

    expect(await screen.findByText("Password must be at least 12 characters")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends the link's token and the new password", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword").mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAt();
    await fillAndSubmit(user);

    await screen.findByText(SUCCESS_TEXT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ token: "from-the-email", password: GOOD_PASSWORD });
  });

  it("on success shows the message, disables the form, and moves to /login after 2000 ms, not before", async () => {
    vi.spyOn(apiClient, "resetPassword").mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAt();
    await user.type(await screen.findByLabelText("New Password"), GOOD_PASSWORD);
    await user.type(screen.getByLabelText("Confirm Password"), GOOD_PASSWORD);

    // Only the redirect's timer is faked; it is scheduled by this submit.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update Password" }));
      await Promise.resolve();
    });

    expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText("New Password")).toBeDisabled();
    expect(screen.getByLabelText("Confirm Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update Password" })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(screen.queryByText("landed on /login")).not.toBeInTheDocument();
    expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("landed on /login")).toBeInTheDocument();
  });

  it("shows invalid_reset_token's message with a link to request a new one", async () => {
    vi.spyOn(apiClient, "resetPassword").mockRejectedValue(
      new ApiError("invalid_reset_token", "That reset link is invalid or has expired. Request a new one."),
    );
    const user = userEvent.setup();
    renderAt();
    await fillAndSubmit(user);

    expect(
      await screen.findByText(/that reset link is invalid or has expired\. request a new one\./i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    expect(screen.getByRole("button", { name: "Update Password" })).toBeEnabled();
  });

  it("shows another ApiError's message without the link", async () => {
    vi.spyOn(apiClient, "resetPassword").mockRejectedValue(
      new ApiError("rate_limited", "Too many attempts. Try again in 5 minutes."),
    );
    const user = userEvent.setup();
    renderAt();
    await fillAndSubmit(user);

    expect(await screen.findByText("Too many attempts. Try again in 5 minutes.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Request a new link" })).not.toBeInTheDocument();
  });

  it("shows the generic text for anything that isn't an ApiError", async () => {
    vi.spyOn(apiClient, "resetPassword").mockRejectedValue(new TypeError("boom"));
    const user = userEvent.setup();
    renderAt();
    await fillAndSubmit(user);

    expect(await screen.findByText("An unexpected error occurred. Please try again.")).toBeInTheDocument();
  });

  it("without a token shows the missing-code alert and no form", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword");
    renderAt("/reset-password");

    expect(await screen.findByText(/this link is missing its reset code\./i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    expect(screen.queryByLabelText("New Password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update Password" })).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads 'Updating...' while in flight and sends a double submit once", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword").mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderAt();
    await user.type(await screen.findByLabelText("New Password"), GOOD_PASSWORD);
    await user.type(screen.getByLabelText("Confirm Password"), GOOD_PASSWORD);
    // Two submits of the form itself, so the button's disabled state can't
    // be what stops the second: only the handler's guard can.
    const form = screen.getByRole("button", { name: "Update Password" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole("button", { name: "Updating..." })).toBeDisabled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shows and hides each password", async () => {
    const user = userEvent.setup();
    renderAt();
    const password = await screen.findByLabelText("New Password");
    const confirm = screen.getByLabelText("Confirm Password");
    const [showPassword, showConfirm] = screen.getAllByRole("button", { name: /show password/i });

    await user.click(showPassword!);
    expect(password).toHaveAttribute("type", "text");
    expect(confirm).toHaveAttribute("type", "password");

    await user.click(showConfirm!);
    expect(confirm).toHaveAttribute("type", "text");
  });
});
