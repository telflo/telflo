import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OidcProvider } from "@telflo/contracts";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, redirect, useLocation } from "react-router";
import { LoginForm } from "./LoginForm.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

const SIGNED_IN = { user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" } };

const GOOGLE: OidcProvider = { id: "google", name: "Google" };

/** The form at `path`, with a page at every place a sign-in may land. */
function renderAt(path = "/login", providers: readonly OidcProvider[] = []) {
  const Stub = createRoutesStub([
    { path: "/login", Component: () => <LoginForm providers={providers} /> },
    { path: "/app", Component: () => <p>landed on /app</p> },
    { path: "/app/settings", Component: () => <p>landed on /app/settings</p> },
    { path: "*", Component: () => <p>landed elsewhere</p> },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

/** As renderAt, but /app sends the browser back to sign-in, as it does when no session cookie arrived. */
function renderWithSessionDropped(path = "/login") {
  const Stub = createRoutesStub([
    { path: "/login", Component: () => <LoginForm providers={[]} /> },
    {
      path: "/app",
      loader: () => redirect(`/login?redirectTo=${encodeURIComponent("/app")}`),
      Component: () => <p>landed on /app</p>,
    },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

const SESSION_NOT_KEPT = /your browser didn't keep the session/i;

async function signIn(email = "Person@Example.com", password = "a-long-enough-password") {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(/^email$/i), email);
  await user.type(screen.getByLabelText(/^password$/i), password);
  await user.click(screen.getByRole("button", { name: /^sign in$/i }));
  return user;
}

describe("LoginForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the credentials as typed and lands on /app", async () => {
    // The contract's email schema lowercases server-side; the form sends
    // what was typed.
    const spy = vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
    renderAt();
    await signIn();

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ email: "Person@Example.com", password: "a-long-enough-password" });
  });

  it("never says the session was dropped on a normal sign-in", async () => {
    vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
    renderAt();
    await signIn();

    expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    expect(screen.queryByText(SESSION_NOT_KEPT)).not.toBeInTheDocument();
  });

  it("re-enables and explains when the destination sends it back to sign-in", async () => {
    // The browser dropped the session cookies (Safari with Secure cookies on
    // http://localhost), so /app redirected to /login and this form stayed.
    vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
    renderWithSessionDropped();
    await signIn();

    expect(await screen.findByText(SESSION_NOT_KEPT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
    expect(screen.getByLabelText(/^email$/i)).toBeEnabled();
    expect(screen.queryByText("landed on /app")).not.toBeInTheDocument();
  });

  it("lands on a safe redirectTo", async () => {
    vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
    renderAt(`/login?redirectTo=${encodeURIComponent("/app/settings")}`);
    await signIn();

    expect(await screen.findByText("landed on /app/settings")).toBeInTheDocument();
  });

  describe("the CLI's sign-in page's fragment", () => {
    const FRAGMENT = "#state=SSSSSSSSSSSSSSSSSSSS-_ttttttttttttttttttttt&port=54321&host=ada-laptop";

    /** Where the sign-in landed: its path, query and fragment, as the router has them. */
    function Landed() {
      const location = useLocation();
      return <p data-testid="landed">{`${location.pathname}${location.search}${location.hash}`}</p>;
    }

    /** The form at `/login?redirectTo=<redirectTo>`, the browser's address carrying `hash`, as the layout's 302 leaves it. */
    function renderOnTheWayTo(redirectTo: string, hash: string) {
      const path = `/login?redirectTo=${encodeURIComponent(redirectTo)}`;
      window.history.replaceState(null, "", `${path}${hash}`);
      const Stub = createRoutesStub([
        { path: "/login", Component: () => <LoginForm providers={[]} /> },
        { path: "*", Component: Landed },
      ]);
      return render(<Stub initialEntries={[path]} />);
    }

    afterEach(() => window.history.replaceState(null, "", "/"));

    it.each(["/cli-auth", "/CLI-Auth/", "/cli-auth?x=1"])("carries it to %s after a password sign-in", async (redirectTo) => {
      vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
      renderOnTheWayTo(redirectTo, FRAGMENT);
      await signIn();
      expect((await screen.findByTestId("landed")).textContent).toBe(`${redirectTo}${FRAGMENT}`);
    });

    it.each(["/app/settings", "/cli-authx", "/app/cli-auth", "/cli-auth/x"])("never carries a fragment to %s", async (redirectTo) => {
      vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
      renderOnTheWayTo(redirectTo, FRAGMENT);
      await signIn();
      expect((await screen.findByTestId("landed")).textContent).toBe(redirectTo);
    });

    it("keeps a fragment redirectTo already has, adding none", async () => {
      vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
      renderOnTheWayTo("/cli-auth#own", FRAGMENT);
      await signIn();
      expect((await screen.findByTestId("landed")).textContent).toBe("/cli-auth#own");
    });

    it("lands on /cli-auth with no fragment when the address has none", async () => {
      vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
      renderOnTheWayTo("/cli-auth", "");
      await signIn();
      expect((await screen.findByTestId("landed")).textContent).toBe("/cli-auth");
    });
  });

  it.each(["https://evil.example", "//evil.example"])(
    "ignores the unsafe redirectTo %s and lands on /app",
    async (redirectTo) => {
      vi.spyOn(apiClient, "createSession").mockResolvedValue(SIGNED_IN);
      renderAt(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
      await signIn();

      expect(await screen.findByText("landed on /app")).toBeInTheDocument();
    },
  );

  it("shows the server's text for invalid credentials", async () => {
    vi.spyOn(apiClient, "createSession").mockRejectedValue(
      new ApiError("invalid_credentials", "Invalid login credentials"),
    );
    renderAt();
    await signIn();

    expect(await screen.findByText("Invalid login credentials")).toBeInTheDocument();
    expect(screen.queryByText(/landed/)).not.toBeInTheDocument();
  });

  it("says an unverified email is not confirmed", async () => {
    vi.spyOn(apiClient, "createSession").mockRejectedValue(
      new ApiError("email_not_verified", "Verify your email address before signing in."),
    );
    renderAt();
    await signIn();

    expect(await screen.findByText("Email not confirmed")).toBeInTheDocument();
  });

  it("shows the server's text when rate limited", async () => {
    vi.spyOn(apiClient, "createSession").mockRejectedValue(
      new ApiError("rate_limited", "Too many attempts. Try again in 15 minutes."),
    );
    renderAt();
    await signIn();

    expect(await screen.findByText("Too many attempts. Try again in 15 minutes.")).toBeInTheDocument();
  });

  it("shows the generic message when the server can't be reached", async () => {
    vi.spyOn(apiClient, "createSession").mockRejectedValue(
      new ApiError("network_error", "Could not reach the server. Check your connection."),
    );
    renderAt();
    await signIn();

    expect(
      await screen.findByText("An unexpected error occurred. Please try again."),
    ).toBeInTheDocument();
  });

  it("clears the previous error on a new attempt", async () => {
    vi.spyOn(apiClient, "createSession")
      .mockRejectedValueOnce(new ApiError("invalid_credentials", "Invalid login credentials"))
      .mockReturnValueOnce(new Promise(() => {}));
    renderAt();
    const user = await signIn();
    await screen.findByText("Invalid login credentials");

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(screen.queryByText("Invalid login credentials")).not.toBeInTheDocument();
  });

  it("reads 'Signing in...' while pending and submits a double click once", async () => {
    const spy = vi.spyOn(apiClient, "createSession").mockReturnValue(new Promise(() => {}));
    renderAt();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^email$/i), "person@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    await user.dblClick(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("button", { name: "Signing in..." })).toBeDisabled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe("resending the confirmation email", () => {
    const PROMPT = "Didn't receive the confirmation email?";
    const SENT = "Confirmation email sent — check your inbox.";
    const notVerified = () => new ApiError("email_not_verified", "Verify your email address before signing in.");

    it("offers no prompt for invalid credentials", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(
        new ApiError("invalid_credentials", "Invalid login credentials"),
      );
      renderAt();
      await signIn();

      await screen.findByText("Invalid login credentials");
      expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resend" })).not.toBeInTheDocument();
    });

    it("offers the prompt after 'Email not confirmed'", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(notVerified());
      renderAt();
      await signIn();

      expect(await screen.findByText(PROMPT)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Resend" })).toBeEnabled();
    });

    it("sends the Email field's value at the time Resend is clicked", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(notVerified());
      const spy = vi.spyOn(apiClient, "requestVerificationEmail").mockResolvedValue({ status: "accepted" });
      renderAt();
      const user = await signIn("first@example.com");
      await screen.findByText(PROMPT);

      const email = screen.getByLabelText(/^email$/i);
      await user.clear(email);
      await user.type(email, "second@example.com");
      await user.click(screen.getByRole("button", { name: "Resend" }));

      await screen.findByText(SENT);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ email: "second@example.com" });
    });

    it("reads 'Sending...' while the resend is in flight", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(notVerified());
      vi.spyOn(apiClient, "requestVerificationEmail").mockReturnValue(new Promise(() => {}));
      renderAt();
      const user = await signIn();
      await user.click(await screen.findByRole("button", { name: "Resend" }));

      expect(await screen.findByRole("button", { name: "Sending..." })).toBeDisabled();
    });

    it("replaces the prompt with the success text", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(notVerified());
      vi.spyOn(apiClient, "requestVerificationEmail").mockResolvedValue({ status: "accepted" });
      renderAt();
      const user = await signIn();
      await user.click(await screen.findByRole("button", { name: "Resend" }));

      expect(await screen.findByText(SENT)).toBeInTheDocument();
      expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    });

    it("keeps the prompt and shows an ApiError's message when the resend fails", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(notVerified());
      vi.spyOn(apiClient, "requestVerificationEmail").mockRejectedValue(
        new ApiError("rate_limited", "Too many requests. Try again in 60 minutes."),
      );
      renderAt();
      const user = await signIn();
      await user.click(await screen.findByRole("button", { name: "Resend" }));

      expect(await screen.findByText("Too many requests. Try again in 60 minutes.")).toBeInTheDocument();
      expect(screen.getByText(PROMPT)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Resend" })).toBeEnabled();
      expect(screen.queryByText(SENT)).not.toBeInTheDocument();
    });

    it("keeps the prompt and shows the fallback text when the resend fails otherwise", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(notVerified());
      vi.spyOn(apiClient, "requestVerificationEmail").mockRejectedValue(new TypeError("boom"));
      renderAt();
      const user = await signIn();
      await user.click(await screen.findByRole("button", { name: "Resend" }));

      expect(
        await screen.findByText("Failed to resend confirmation email. Please try again."),
      ).toBeInTheDocument();
      expect(screen.getByText(PROMPT)).toBeInTheDocument();
    });

    it("clears the prompt when sign-in is submitted again", async () => {
      vi.spyOn(apiClient, "createSession")
        .mockRejectedValueOnce(notVerified())
        .mockReturnValueOnce(new Promise(() => {}));
      renderAt();
      const user = await signIn();
      await screen.findByText(PROMPT);

      await user.click(screen.getByRole("button", { name: /^sign in$/i }));
      expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    });

    it("clears the success text when sign-in is submitted again", async () => {
      vi.spyOn(apiClient, "createSession")
        .mockRejectedValueOnce(notVerified())
        .mockReturnValueOnce(new Promise(() => {}));
      vi.spyOn(apiClient, "requestVerificationEmail").mockResolvedValue({ status: "accepted" });
      renderAt();
      const user = await signIn();
      await user.click(await screen.findByRole("button", { name: "Resend" }));
      await screen.findByText(SENT);

      await user.click(screen.getByRole("button", { name: /^sign in$/i }));
      expect(screen.queryByText(SENT)).not.toBeInTheDocument();
      expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    });
  });

  it("links to registration for people without an account, where registration is open", async () => {
    const Stub = createRoutesStub(underSite(SAAS_SITE, [{ path: "/login", Component: () => <LoginForm providers={[]} /> }]));
    render(<Stub initialEntries={["/login"]} />);
    expect(await screen.findByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/register");
  });

  it.each(["invite-only", "closed"] as const)("offers no Sign up under %s registration", async (registration) => {
    const Stub = createRoutesStub(
      underSite({ ...SAAS_SITE, registration }, [{ path: "/login", Component: () => <LoginForm providers={[]} /> }]),
    );
    render(<Stub initialEntries={["/login"]} />);
    expect(await screen.findByRole("link", { name: /forgot password/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign up/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/don.t have an account/i)).not.toBeInTheDocument();
  });

  it("keeps the forgot-password link", async () => {
    renderAt();
    expect(await screen.findByRole("link", { name: /forgot password/i })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("shows and hides the password", async () => {
    const user = userEvent.setup();
    renderAt();
    const password = await screen.findByLabelText(/^password$/i);
    expect(password).toHaveAttribute("type", "password");

    await user.click(screen.getByRole("button", { name: /show password/i }));
    expect(password).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(password).toHaveAttribute("type", "password");
  });

  describe("federated sign-in", () => {
    const GOOGLE_LINK = { name: "Google" } as const;
    const START = "/api/v1/auth/oidc/google";

    /** jsdom can't follow a link to another document; the tests only need the click. */
    function stopNavigation(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest("a[href^='/api/']")) event.preventDefault();
    }
    beforeEach(() => document.addEventListener("click", stopNavigation));
    afterEach(() => document.removeEventListener("click", stopNavigation));

    it("shows no Google button and no divider without providers", async () => {
      renderAt();
      await screen.findByLabelText(/^email$/i);
      expect(screen.queryByRole("link", GOOGLE_LINK)).not.toBeInTheDocument();
      expect(screen.queryByText("or continue with email")).not.toBeInTheDocument();
    });

    it("shows the Google button, then the divider, before the email form when Google is configured", async () => {
      renderAt("/login", [GOOGLE]);
      const link = await screen.findByRole("link", GOOGLE_LINK);
      const divider = screen.getByText("or continue with email");
      const email = screen.getByLabelText(/^email$/i);

      expect(link.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(divider.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(link.querySelector("svg")).not.toBeNull();
    });

    it("draws no button for a provider without a known icon", async () => {
      renderAt("/login", [{ id: "okta", name: "Okta" }]);
      await screen.findByLabelText(/^email$/i);
      expect(screen.queryByRole("link", { name: "Okta" })).not.toBeInTheDocument();
      expect(screen.queryByText("or continue with email")).not.toBeInTheDocument();
    });

    it("links Google to the start endpoint with no redirectTo when the page has none", async () => {
      renderAt("/login", [GOOGLE]);
      expect(await screen.findByRole("link", GOOGLE_LINK)).toHaveAttribute("href", START);
    });

    it("carries the page's safe redirectTo to the start endpoint", async () => {
      renderAt(`/login?redirectTo=${encodeURIComponent("/app/settings?tab=1")}`, [GOOGLE]);
      expect(await screen.findByRole("link", GOOGLE_LINK)).toHaveAttribute(
        "href",
        `${START}?redirectTo=${encodeURIComponent("/app/settings?tab=1")}`,
      );
    });

    it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", ""])(
      "leaves the unsafe redirectTo %j out of the start link",
      async (redirectTo) => {
        renderAt(`/login?redirectTo=${encodeURIComponent(redirectTo)}`, [GOOGLE]);
        expect(await screen.findByRole("link", GOOGLE_LINK)).toHaveAttribute("href", START);
      },
    );

    it("reads Redirecting... after a click and disables the other controls", async () => {
      const user = userEvent.setup();
      renderAt("/login", [GOOGLE]);
      await user.click(await screen.findByRole("link", GOOGLE_LINK));

      const link = screen.getByRole("link", { name: "Redirecting..." });
      expect(link).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByLabelText(/^email$/i)).toBeDisabled();
      expect(screen.getByLabelText(/^password$/i)).toBeDisabled();
      expect(screen.getByRole("button", { name: /^sign in$/i })).toBeDisabled();
    });

    it("is usable again when the page comes back from the back/forward cache", async () => {
      const user = userEvent.setup();
      renderAt("/login", [GOOGLE]);
      await user.click(await screen.findByRole("link", GOOGLE_LINK));
      expect(screen.getByRole("link", { name: "Redirecting..." })).toBeInTheDocument();

      // A pageshow that isn't a restore (the first load) changes nothing.
      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      });
      expect(screen.getByRole("link", { name: "Redirecting..." })).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      const link = screen.getByRole("link", GOOGLE_LINK);
      expect(link).not.toHaveAttribute("aria-disabled");
      expect(screen.getByLabelText(/^email$/i)).toBeEnabled();
      expect(screen.getByLabelText(/^password$/i)).toBeEnabled();
      expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
    });

    it("doesn't count a click that opens a new tab as redirecting", async () => {
      const user = userEvent.setup();
      renderAt("/login", [GOOGLE]);
      const link = await screen.findByRole("link", GOOGLE_LINK);
      await user.keyboard("{Control>}");
      await user.click(link);
      await user.keyboard("{/Control}");

      expect(screen.getByRole("link", GOOGLE_LINK)).not.toHaveAttribute("aria-disabled");
      expect(screen.getByLabelText(/^email$/i)).toBeEnabled();
    });

    it("makes the Google button inert while an email sign-in is under way", async () => {
      vi.spyOn(apiClient, "createSession").mockReturnValue(new Promise(() => {}));
      renderAt("/login", [GOOGLE]);
      await signIn();

      const link = screen.getByRole("link", GOOGLE_LINK);
      expect(link).toHaveAttribute("aria-disabled", "true");
      // Clicking it doesn't start a redirect either.
      await userEvent.setup().click(link);
      expect(screen.queryByRole("link", { name: "Redirecting..." })).not.toBeInTheDocument();
    });
  });

  describe("?error= from a federated sign-in", () => {
    it("shows the fixed message for oauth_failed", async () => {
      renderAt("/login?error=oauth_failed");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Social login failed. Please try again or use email/password.",
      );
    });

    it("shows the unverified-email message for oauth_email_unverified", async () => {
      renderAt("/login?error=oauth_email_unverified");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This Google account can't be used to sign in. Sign up with your email address instead.",
      );
    });

    it("shows the reserved-domain message for oauth_email_reserved", async () => {
      renderAt("/login?error=oauth_email_reserved");
      expect(await screen.findByRole("alert")).toHaveTextContent("This address can't be used");
    });

    it("shows the invitation-only message for registration_not_open", async () => {
      renderAt("/login?error=registration_not_open");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This site is invitation-only. Ask an organization admin for an invitation.",
      );
    });

    it.each(["access_denied", "Social login failed", "toString", "__proto__", ""])(
      "shows nothing for the unknown error %j",
      async (code) => {
        renderAt(`/login?error=${encodeURIComponent(code)}`);
        await screen.findByLabelText(/^email$/i);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      },
    );

    it("shows a failed email sign-in's own message in place of the query's", async () => {
      vi.spyOn(apiClient, "createSession").mockRejectedValue(
        new ApiError("invalid_credentials", "Invalid login credentials"),
      );
      renderAt("/login?error=oauth_failed");
      await signIn();

      expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    });
  });
});
