import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { ForgotPasswordForm } from "./ForgotPasswordForm.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";

const SENT_TEXT =
  "If an account exists with this email, you will receive a password reset link shortly.";

function renderForm() {
  const Stub = createRoutesStub([
    { path: "/forgot-password", Component: ForgotPasswordForm },
    { path: "/login", Component: () => <p>landed on /login</p> },
  ]);
  return render(<Stub initialEntries={["/forgot-password"]} />);
}

async function submit(email = "Person@Example.com") {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/^email$/i), email);
  await user.click(screen.getByRole("button", { name: "Send Reset Link" }));
  return user;
}

describe("ForgotPasswordForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the card", async () => {
    renderForm();
    expect(await screen.findByText("Reset Password")).toBeInTheDocument();
    expect(screen.getByText("Enter your email to receive a password reset link")).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute("placeholder", "you@example.com");
  });

  it("submits the email as typed", async () => {
    const spy = vi.spyOn(apiClient, "requestPasswordReset").mockResolvedValue({ status: "accepted" });
    renderForm();
    await submit();

    await screen.findByText(SENT_TEXT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ email: "Person@Example.com" });
  });

  it("shows the success text and disables the field and button", async () => {
    vi.spyOn(apiClient, "requestPasswordReset").mockResolvedValue({ status: "accepted" });
    renderForm();
    await submit();

    expect(await screen.findByText(SENT_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send Reset Link" })).toBeDisabled();
  });

  it("shows an ApiError's message", async () => {
    vi.spyOn(apiClient, "requestPasswordReset").mockRejectedValue(
      new ApiError("rate_limited", "Too many requests. Try again in 60 minutes."),
    );
    renderForm();
    await submit();

    expect(await screen.findByText("Too many requests. Try again in 60 minutes.")).toBeInTheDocument();
    expect(screen.queryByText(SENT_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send Reset Link" })).toBeEnabled();
  });

  it("shows the generic text for anything that isn't an ApiError", async () => {
    vi.spyOn(apiClient, "requestPasswordReset").mockRejectedValue(new TypeError("boom"));
    renderForm();
    await submit();

    expect(await screen.findByText("An unexpected error occurred. Please try again.")).toBeInTheDocument();
  });

  it("reads 'Sending...' while in flight and submits a double click once", async () => {
    const spy = vi.spyOn(apiClient, "requestPasswordReset").mockReturnValue(new Promise(() => {}));
    renderForm();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^email$/i), "person@example.com");
    await user.dblClick(screen.getByRole("button", { name: "Send Reset Link" }));

    expect(await screen.findByRole("button", { name: "Sending..." })).toBeDisabled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("links back to sign-in", async () => {
    renderForm();
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByText(/remember your password\?/i)).toBeInTheDocument();
  });
});
