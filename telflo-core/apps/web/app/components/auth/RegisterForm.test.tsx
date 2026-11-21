import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, render as renderInDom, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import { RegisterForm } from "./RegisterForm.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";

const TERMS_VERSION = "2026-01-01";
/** The site's Terms: an absolute URL and a path, as the settings allow both. */
const TERMS = { version: TERMS_VERSION, termsUrl: "https://legal.example.com/terms", privacyUrl: "/home/privacy-policy" };

/** The form links to the sign-in page, so it needs a router around it. */
function render(ui: React.ReactElement) {
  return renderInDom(<MemoryRouter>{ui}</MemoryRouter>);
}

async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  overrides: { email?: string; password?: string; confirmPassword?: string } = {},
) {
  await user.type(screen.getByLabelText(/^email$/i), overrides.email ?? "person@example.com");
  await user.type(screen.getByLabelText(/^password$/i), overrides.password ?? "a-long-enough-password");
  await user.type(
    screen.getByLabelText(/confirm password/i),
    overrides.confirmPassword ?? overrides.password ?? "a-long-enough-password",
  );
  await user.click(screen.getByRole("checkbox", { name: /terms/i }));
}

describe("RegisterForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("submits the form and reports success", async () => {
    const spy = vi
      .spyOn(apiClient, "postRegister")
      .mockResolvedValue({ status: "verification_sent" });
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={onSuccess} providers={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(spy).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "a-long-enough-password",
      acceptedTermsVersion: TERMS_VERSION,
    });
  });

  it("captures the user_signed_up event after a registration, and none after a failure", async () => {
    const capture = vi.spyOn(analytics, "captureEvent");
    const register = vi
      .spyOn(apiClient, "postRegister")
      .mockRejectedValueOnce(new apiClient.ApiError("validation_failed", "Something is off."))
      .mockResolvedValueOnce({ status: "verification_sent" });
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<RegisterForm terms={TERMS} onSuccess={onSuccess} providers={[]} />);
    await fillForm(user);

    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByText("Something is off.")).toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(register).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("user_signed_up", { method: "email" });
  });

  it("refuses to submit an implausible email address", async () => {
    const spy = vi.spyOn(apiClient, "postRegister");
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    await fillForm(user, { email: "not-an-email" });
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses to submit when the passwords differ", async () => {
    const spy = vi.spyOn(apiClient, "postRegister");
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    await fillForm(user, { password: "a-long-enough-password", confirmPassword: "something-else" });
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses to submit a password below the minimum length", async () => {
    const spy = vi.spyOn(apiClient, "postRegister");
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    await fillForm(user, { password: "short" });
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("requires the terms checkbox", async () => {
    const spy = vi.spyOn(apiClient, "postRegister");
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    await user.type(screen.getByLabelText(/^email$/i), "person@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    await user.type(screen.getByLabelText(/confirm password/i), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/accept the terms/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the server's message when registration fails", async () => {
    vi.spyOn(apiClient, "postRegister").mockRejectedValue(
      new apiClient.ApiError("invalid_request", "That email address is not valid."),
    );
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/that email address is not valid/i)).toBeInTheDocument();
  });

  it("shows the API's words for an address at the reserved domain, 422 email_reserved", async () => {
    vi.spyOn(apiClient, "postRegister").mockRejectedValue(
      new apiClient.ApiError("email_reserved", "This address can't be used"),
    );
    const onSuccess = vi.fn();
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={onSuccess} providers={[]} />);
    await fillForm(user, { email: "ci-1a2b3c4d@service-accounts.telflo.invalid" });
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This address can't be used");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /create account/i })).toBeEnabled();
  });

  it("disables the submit button while the request is in flight", async () => {
    let release: (value: { status: "verification_sent" }) => void = () => {};
    vi.spyOn(apiClient, "postRegister").mockReturnValue(
      new Promise((resolve) => { release = resolve; }),
    );
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    await fillForm(user);
    const button = screen.getByRole("button", { name: /create account/i });
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    release({ status: "verification_sent" });
    // Let the resulting state update (isSubmitting -> false) settle inside
    // Testing Library's act() before the test ends, instead of leaving it to
    // land on a later, unwrapped microtask.
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("submits only once when the button is clicked twice quickly", async () => {
    // Without the in-flight guard this creates two registrations. The reply
    // is held until after the second click, so both clicks land while the
    // first request is in flight, however slow the run.
    let release: (value: { status: "verification_sent" }) => void = () => {};
    const spy = vi.spyOn(apiClient, "postRegister").mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const user = userEvent.setup();

    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    await fillForm(user);
    const button = screen.getByRole("button", { name: /create account/i });
    await user.click(button);
    await user.click(button);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    release({ status: "verification_sent" });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(spy).toHaveBeenCalledOnce();
  });

  it("links the site's Terms of Service and Privacy Policy from the terms checkbox, each in a new tab", () => {
    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);

    expect(
      screen.getByRole("checkbox", { name: "I agree to the Terms of Service and Privacy Policy" }),
    ).toBeInTheDocument();
    for (const [name, href] of [
      ["Terms of Service", "https://legal.example.com/terms"],
      ["Privacy Policy", "/home/privacy-policy"],
    ] as const) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("leaves the terms box unticked when a document's link is clicked", async () => {
    const user = userEvent.setup();
    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    const checkbox = screen.getByRole("checkbox", { name: /terms/i });

    await user.click(screen.getByRole("link", { name: "Terms of Service" }));
    await user.click(screen.getByRole("link", { name: "Privacy Policy" }));

    expect(checkbox).not.toBeChecked();

    // The agreement's own words still tick it.
    await user.click(screen.getByText("I agree to the"));
    expect(checkbox).toBeChecked();
  });

  it("shows the API's words when the site isn't open to sign-ups, 403 registration_not_open", async () => {
    const message = "This site is invitation-only. Ask an organization admin for an invitation.";
    vi.spyOn(apiClient, "postRegister").mockRejectedValue(new apiClient.ApiError("registration_not_open", message));
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    render(<RegisterForm terms={null} onSuccess={onSuccess} providers={[]} />);

    await user.type(screen.getByLabelText(/^email$/i), "person@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    await user.type(screen.getByLabelText(/confirm password/i), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  describe("on a site that asks for no Terms", () => {
    it("shows no Usage policies divider, no checkbox and no document links", () => {
      render(<RegisterForm terms={null} onSuccess={vi.fn()} providers={[]} />);
      expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
      expect(screen.queryByText("Usage policies")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Terms of Service" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Privacy Policy" })).not.toBeInTheDocument();
    });

    it("submits without a tick and sends no acceptedTermsVersion key at all", async () => {
      const spy = vi.spyOn(apiClient, "postRegister").mockResolvedValue({ status: "verification_sent" });
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<RegisterForm terms={null} onSuccess={onSuccess} providers={[]} />);

      await user.type(screen.getByLabelText(/^email$/i), "person@example.com");
      await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
      await user.type(screen.getByLabelText(/confirm password/i), "a-long-enough-password");
      await user.click(screen.getByRole("button", { name: /create account/i }));

      await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
      expect(spy).toHaveBeenCalledOnce();
      const [body] = spy.mock.calls[0]!;
      expect(body).toEqual({ email: "person@example.com", password: "a-long-enough-password" });
      expect(Object.keys(body)).not.toContain("acceptedTermsVersion");
    });
  });

  it("links to sign-in for people who already have an account", () => {
    render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/login");
  });

  describe("federated sign-up", () => {
    const GOOGLE = { id: "google", name: "Google" };

    /** jsdom can't follow a link to another document; the tests only need the click. */
    function stopNavigation(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest("a[href^='/api/']")) event.preventDefault();
    }
    beforeEach(() => document.addEventListener("click", stopNavigation));
    afterEach(() => document.removeEventListener("click", stopNavigation));

    it("shows no Google button and no dividers without providers", () => {
      render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[]} />);
      expect(screen.queryByRole("link", { name: "Google" })).not.toBeInTheDocument();
      expect(screen.queryByText("Register with a social account")).not.toBeInTheDocument();
      expect(screen.queryByText("or with an email")).not.toBeInTheDocument();
    });

    it("shows the social divider, the Google button, then the email divider when Google is configured", () => {
      render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[GOOGLE]} />);
      const social = screen.getByText("Register with a social account");
      const link = screen.getByRole("link", { name: "Google" });
      const email = screen.getByText("or with an email");
      const field = screen.getByLabelText(/^email$/i);

      const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(follows(social, link) && follows(link, email) && follows(email, field)).toBe(true);
      expect(link).toHaveAttribute("href", "/api/v1/auth/oidc/google");
      expect(link.querySelector("svg")).not.toBeNull();
    });

    it("draws no button or dividers for a provider without a known icon", () => {
      render(
        <RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[{ id: "okta", name: "Okta" }]} />,
      );
      expect(screen.queryByRole("link", { name: "Okta" })).not.toBeInTheDocument();
      expect(screen.queryByText("Register with a social account")).not.toBeInTheDocument();
    });

    it("reads Redirecting... after a click and disables the other controls", async () => {
      const user = userEvent.setup();
      render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[GOOGLE]} />);
      await user.click(screen.getByRole("link", { name: "Google" }));

      expect(screen.getByRole("link", { name: "Redirecting..." })).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByLabelText(/^email$/i)).toBeDisabled();
      expect(screen.getByLabelText(/^password$/i)).toBeDisabled();
      expect(screen.getByLabelText(/confirm password/i)).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: /terms/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /create account/i })).toBeDisabled();
    });

    it("is usable again when the page comes back from the back/forward cache", async () => {
      const user = userEvent.setup();
      render(<RegisterForm terms={TERMS} onSuccess={vi.fn()} providers={[GOOGLE]} />);
      await user.click(screen.getByRole("link", { name: "Google" }));
      expect(screen.getByRole("link", { name: "Redirecting..." })).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      expect(screen.getByRole("link", { name: "Google" })).not.toHaveAttribute("aria-disabled");
      expect(screen.getByLabelText(/^email$/i)).toBeEnabled();
      expect(screen.getByRole("button", { name: /create account/i })).toBeEnabled();
    });
  });
});
