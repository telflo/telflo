import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { VerifyEmailPanel } from "./VerifyEmailPanel.js";
import * as apiClient from "~/lib/api-client.js";

// Rendered under StrictMode throughout: React double-invokes effects in
// development, which is the environment this component actually runs in, so
// testing under an ordinary single mount would not exercise that behavior.
// The panel links to sign-in, so it renders inside a router.
function renderPanel(token: string | null | undefined) {
  const Stub = createRoutesStub([
    { path: "/verify-email", Component: () => <VerifyEmailPanel token={token} /> },
  ]);
  return render(
    <StrictMode>
      <Stub initialEntries={["/verify-email"]} />
    </StrictMode>,
  );
}

const RESENT_TEXT = "If that address has an unconfirmed account, we have sent a new confirmation link to it.";

async function failVerification() {
  vi.spyOn(apiClient, "postVerifyEmail").mockRejectedValue(
    new apiClient.ApiError("invalid_verification_token", "That confirmation link is invalid or has expired."),
  );
  renderPanel("bad-token");
  await screen.findByText(/invalid or has expired/i);
}

describe("VerifyEmailPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("waits, sending nothing, until the page has read the token from the address bar", async () => {
    const spy = vi.spyOn(apiClient, "postVerifyEmail");
    renderPanel(undefined);

    expect(await screen.findByText("Confirming your email…")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("confirms the account when the token is accepted", async () => {
    vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "verified" });
    renderPanel("good-token");
    expect(await screen.findByText(/your email address is confirmed/i)).toBeInTheDocument();
  });

  it("treats an already-verified account as success, not as an error", async () => {
    // Clicking the link twice, or a mail client prefetching it, must not look
    // like a failure to someone whose account is in fact verified.
    vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "already_verified" });
    renderPanel("reused-token");
    expect(await screen.findByText(/already confirmed/i)).toBeInTheDocument();
  });

  it("shows the server's message when the token is rejected", async () => {
    vi.spyOn(apiClient, "postVerifyEmail").mockRejectedValue(
      new apiClient.ApiError("invalid_verification_token", "That confirmation link is invalid or has expired."),
    );
    renderPanel("bad-token");
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
  });

  it("reports a missing token without calling the server", async () => {
    const spy = vi.spyOn(apiClient, "postVerifyEmail");
    renderPanel(null);
    expect(await screen.findByText(/link is missing its confirmation code/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows a pending state while the request is in flight", async () => {
    vi.spyOn(apiClient, "postVerifyEmail").mockReturnValue(new Promise(() => {}));
    renderPanel("slow-token");
    expect(await screen.findByText(/confirming your email/i)).toBeInTheDocument();
  });

  it("says the user can now sign in, with a Sign in link, when verified", async () => {
    vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "verified" });
    renderPanel("good-token");
    expect(await screen.findByText("You can now sign in.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("offers the same Sign in link when the email was already confirmed", async () => {
    vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "already_verified" });
    renderPanel("reused-token");
    expect(await screen.findByText("Already confirmed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });

  it("offers no resend form unless the link failed", async () => {
    vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "verified" });
    renderPanel("good-token");
    await screen.findByText("You can now sign in.");
    expect(screen.queryByRole("button", { name: "Send a new link" })).not.toBeInTheDocument();
  });

  it("offers a resend form when the link failed, sending the typed address, then its success text", async () => {
    const spy = vi.spyOn(apiClient, "requestVerificationEmail").mockResolvedValue({ status: "accepted" });
    await failVerification();
    const user = userEvent.setup();

    const email = screen.getByLabelText(/^email$/i);
    expect(email).toHaveAttribute("placeholder", "you@example.com");
    await user.type(email, "Person@Example.com");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    expect(await screen.findByText(RESENT_TEXT)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ email: "Person@Example.com" });
    expect(screen.queryByRole("button", { name: "Send a new link" })).not.toBeInTheDocument();
  });

  it("offers the resend form when the link has no token", async () => {
    renderPanel(null);
    await screen.findByText(/link is missing its confirmation code/i);
    expect(screen.getByRole("button", { name: "Send a new link" })).toBeInTheDocument();
  });

  it("reads 'Sending...' while the resend is in flight", async () => {
    vi.spyOn(apiClient, "requestVerificationEmail").mockReturnValue(new Promise(() => {}));
    await failVerification();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email$/i), "person@example.com");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    expect(await screen.findByRole("button", { name: "Sending..." })).toBeDisabled();
  });

  it("shows an ApiError's message when the resend fails, and keeps the form", async () => {
    vi.spyOn(apiClient, "requestVerificationEmail").mockRejectedValue(
      new apiClient.ApiError("rate_limited", "Too many requests. Try again in 60 minutes."),
    );
    await failVerification();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email$/i), "person@example.com");
    await user.click(screen.getByRole("button", { name: "Send a new link" }));

    expect(await screen.findByText("Too many requests. Try again in 60 minutes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a new link" })).toBeEnabled();
    expect(screen.queryByText(RESENT_TEXT)).not.toBeInTheDocument();
  });

  it("submits the token exactly once despite React strict-mode double mounting", async () => {
    const spy = vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "verified" });
    renderPanel("once-token");
    await screen.findByText(/your email address is confirmed/i);
    expect(spy).toHaveBeenCalledOnce();
  });
});
