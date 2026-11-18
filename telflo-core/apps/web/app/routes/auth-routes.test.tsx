import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, type CurrentUserResponse, type OidcProvider, type SiteSettings } from "@telflo/contracts";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import LoginPage, { loader as loginLoader, meta as loginMeta } from "./login.js";
import RegisterPage, { loader as registerLoader, meta as registerMeta } from "./register.js";
import CheckYourEmailPage, { meta as checkYourEmailMeta } from "./check-your-email.js";
import VerifyEmailPage, { VERIFY_TOKEN_STORAGE_KEY, meta as verifyEmailMeta } from "./verify-email.js";
import ForgotPasswordPage, {
  loader as forgotPasswordLoader,
  meta as forgotPasswordMeta,
} from "./forgot-password.js";
import ResetPasswordPage, { meta as resetPasswordMeta } from "./reset-password.js";
import * as analytics from "~/lib/analytics.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { fetchCurrentUser, fetchOidcProviders } from "~/lib/api-client.server.js";
import routes from "../routes.js";
import { SAAS_SITE, underSite } from "~/test/site.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn(), fetchOidcProviders: vi.fn() }));

const GOOGLE: OidcProvider = { id: "google", name: "Google" };

const SIGNED_IN_USER: CurrentUserResponse = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
  organization: { id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: "00000000-0000-4000-8000-000000000002", name: "Personal", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

/** Loader arguments for `url`; each route's generated type is inferred at the call. */
function loaderArgs<Args extends { request: Request }>(url: string): Args {
  return { request: new Request(url), params: {}, context: {} } as unknown as Args;
}

/** The redirect a loader threw, as its target path. */
async function redirectTarget(run: Promise<unknown>): Promise<string> {
  const thrown: unknown = await run.then(
    () => {
      throw new Error("the loader returned instead of redirecting");
    },
    (caught: unknown) => caught,
  );
  if (!(thrown instanceof Response)) throw thrown;
  expect(thrown.status).toBe(302);
  return thrown.headers.get("location") ?? "";
}

/**
 * Renders `url`. The reset form reads its token from the browser's own
 * `location.hash` (D3 Ruling 14), so the document's URL is set to match; the
 * router gets the path and query.
 */
function renderAt(url: string, { strict = false, site }: { strict?: boolean; site?: SiteSettings } = {}) {
  window.history.replaceState(null, "", url);
  const path = url.split("#")[0]!;
  // The pages read their providers from loader data; these stand in for the loaders.
  const noProviders = () => ({ providers: [] });
  const pages = [
    { path: "/login", Component: LoginPage, loader: noProviders, HydrateFallback: () => null },
    { path: "/register", Component: RegisterPage, loader: noProviders, HydrateFallback: () => null },
    { path: "/check-your-email", Component: CheckYourEmailPage },
    { path: "/verify-email", Component: VerifyEmailPage },
    { path: "/forgot-password", Component: ForgotPasswordPage },
    { path: "/reset-password", Component: ResetPasswordPage },
  ];
  // Root's site data only when a test gives one: without it, the open source's defaults (lib/use-site.ts).
  const Stub = createRoutesStub(site === undefined ? pages : underSite(site, pages));
  const stub = <Stub initialEntries={[path]} />;
  return render(strict ? <StrictMode>{stub}</StrictMode> : stub);
}

describe("signed-in redirects", () => {
  beforeEach(() => {
    vi.mocked(fetchCurrentUser).mockReset();
    vi.mocked(fetchOidcProviders).mockReset().mockResolvedValue([]);
  });

  it("sends a signed-in visitor on /login to /app", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: SIGNED_IN_USER });
    expect(await redirectTarget(loginLoader(loaderArgs("http://localhost/login")))).toBe("/app");
  });

  it("sends a signed-in visitor on /login to a safe redirectTo", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: SIGNED_IN_USER });
    const url = `http://localhost/login?redirectTo=${encodeURIComponent("/app/settings?tab=1")}`;
    expect(await redirectTarget(loginLoader(loaderArgs(url)))).toBe("/app/settings?tab=1");
  });

  it.each(["https://evil.example", "//evil.example"])(
    "sends a signed-in visitor on /login to /app instead of the unsafe %s",
    async (redirectTo) => {
      vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: SIGNED_IN_USER });
      const url = `http://localhost/login?redirectTo=${encodeURIComponent(redirectTo)}`;
      expect(await redirectTarget(loginLoader(loaderArgs(url)))).toBe("/app");
    },
  );

  it("sends a signed-in visitor on /register to /app", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: SIGNED_IN_USER });
    expect(await redirectTarget(registerLoader(loaderArgs("http://localhost/register")))).toBe("/app");
  });

  it.each(["signed_out", "refresh_needed"] as const)(
    "lets a %s visitor see /login and /register, forwarding the request",
    async (status) => {
      vi.mocked(fetchCurrentUser).mockResolvedValue({ status });
      const loginArgs = loaderArgs<Parameters<typeof loginLoader>[0]>("http://localhost/login");
      const registerArgs = loaderArgs<Parameters<typeof registerLoader>[0]>("http://localhost/register");

      await expect(loginLoader(loginArgs)).resolves.toEqual({ providers: [] });
      await expect(registerLoader(registerArgs)).resolves.toEqual({ providers: [] });
      expect(fetchCurrentUser).toHaveBeenCalledWith(loginArgs.request);
      expect(fetchCurrentUser).toHaveBeenCalledWith(registerArgs.request);
      expect(fetchOidcProviders).toHaveBeenCalledWith(loginArgs.request);
      expect(fetchOidcProviders).toHaveBeenCalledWith(registerArgs.request);
    },
  );

  it("shows the /login and /register forms to a visitor whose access token has expired", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "refresh_needed" });
    const Stub = createRoutesStub([
      { path: "/login", Component: LoginPage, loader: loginLoader, HydrateFallback: () => null },
      { path: "/register", Component: RegisterPage, loader: registerLoader, HydrateFallback: () => null },
    ]);

    const login = render(<Stub initialEntries={["/login"]} />);
    expect(await screen.findByRole("heading", { name: /sign in to telflo/i })).toBeInTheDocument();
    login.unmount();

    render(<Stub initialEntries={["/register"]} />);
    expect(await screen.findByRole("heading", { name: /create account/i })).toBeInTheDocument();
  });

  it("still redirects a signed-in visitor when the providers list fails", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: SIGNED_IN_USER });
    vi.mocked(fetchOidcProviders).mockRejectedValue(new ApiError("network_error", "Could not reach the API."));
    expect(await redirectTarget(loginLoader(loaderArgs("http://localhost/login")))).toBe("/app");
    expect(await redirectTarget(registerLoader(loaderArgs("http://localhost/register")))).toBe("/app");
  });

  it("sends a signed-in visitor on /forgot-password to /app", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_in", currentUser: SIGNED_IN_USER });
    expect(
      await redirectTarget(forgotPasswordLoader(loaderArgs("http://localhost/forgot-password"))),
    ).toBe("/app");
  });

  it.each(["signed_out", "refresh_needed"] as const)(
    "shows the /forgot-password form to a %s visitor",
    async (status) => {
      vi.mocked(fetchCurrentUser).mockResolvedValue({ status });
      const args = loaderArgs<Parameters<typeof forgotPasswordLoader>[0]>("http://localhost/forgot-password");
      await expect(forgotPasswordLoader(args)).resolves.toBeNull();
      expect(fetchCurrentUser).toHaveBeenCalledWith(args.request);

      const Stub = createRoutesStub([
        {
          path: "/forgot-password",
          Component: ForgotPasswordPage,
          loader: forgotPasswordLoader,
          HydrateFallback: () => null,
        },
      ]);
      render(<Stub initialEntries={["/forgot-password"]} />);
      expect(await screen.findByRole("button", { name: "Send Reset Link" })).toBeInTheDocument();
    },
  );

  it("shows the Google button on /login and /register when the API lists Google", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_out" });
    vi.mocked(fetchOidcProviders).mockResolvedValue([GOOGLE]);
    const Stub = createRoutesStub([
      { path: "/login", Component: LoginPage, loader: loginLoader, HydrateFallback: () => null },
      { path: "/register", Component: RegisterPage, loader: registerLoader, HydrateFallback: () => null },
    ]);

    const login = render(<Stub initialEntries={[`/login?redirectTo=${encodeURIComponent("/app/x")}`]} />);
    expect(await screen.findByRole("link", { name: "Google" })).toHaveAttribute(
      "href",
      `/api/v1/auth/oidc/google?redirectTo=${encodeURIComponent("/app/x")}`,
    );
    expect(screen.getByText("or continue with email")).toBeInTheDocument();
    login.unmount();

    render(<Stub initialEntries={["/register"]} />);
    expect(await screen.findByRole("link", { name: "Google" })).toHaveAttribute("href", "/api/v1/auth/oidc/google");
    expect(screen.getByText("Register with a social account")).toBeInTheDocument();
  });

  it("still renders the /login and /register forms, without buttons, when the providers fetch fails", async () => {
    vi.mocked(fetchCurrentUser).mockResolvedValue({ status: "signed_out" });
    vi.mocked(fetchOidcProviders).mockRejectedValue(new ApiError("network_error", "Could not reach the API."));
    await expect(loginLoader(loaderArgs("http://localhost/login"))).resolves.toEqual({ providers: [] });
    await expect(registerLoader(loaderArgs("http://localhost/register"))).resolves.toEqual({ providers: [] });

    const Stub = createRoutesStub([
      { path: "/login", Component: LoginPage, loader: loginLoader, HydrateFallback: () => null },
      { path: "/register", Component: RegisterPage, loader: registerLoader, HydrateFallback: () => null },
    ]);
    const login = render(<Stub initialEntries={["/login"]} />);
    expect(await screen.findByRole("heading", { name: /sign in to telflo/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Google" })).not.toBeInTheDocument();
    login.unmount();

    render(<Stub initialEntries={["/register"]} />);
    expect(await screen.findByRole("heading", { name: /create account/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Google" })).not.toBeInTheDocument();
  });

  it("shows /login?error=oauth_email_unverified's message on the page", async () => {
    renderAt("/login?error=oauth_email_unverified");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Google account can't be used to sign in. Sign up with your email address instead.",
    );
  });

  it("shows /login?error=oauth_email_reserved's message on the page (D22 decision 24)", async () => {
    renderAt("/login?error=oauth_email_reserved");
    expect(await screen.findByRole("alert")).toHaveTextContent("This address can't be used");
  });

  it("lets an API outage propagate instead of treating it as signed out", async () => {
    vi.mocked(fetchCurrentUser).mockRejectedValue(new ApiError("network_error", "Could not reach the API."));

    await expect(loginLoader(loaderArgs("http://localhost/login"))).rejects.toBeInstanceOf(ApiError);
    await expect(registerLoader(loaderArgs("http://localhost/register"))).rejects.toBeInstanceOf(ApiError);
    await expect(
      forgotPasswordLoader(loaderArgs("http://localhost/forgot-password")),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("auth routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("takes a successful registration to the check-your-email page, accepting the site's Terms version (D36-1 decision 32)", async () => {
    const register = vi.spyOn(apiClient, "postRegister").mockResolvedValue({ status: "verification_sent" });
    const user = userEvent.setup();
    renderAt("/register", { site: SAAS_SITE });

    await user.type(await screen.findByLabelText(/^email$/i), "person@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    await user.type(screen.getByLabelText(/confirm password/i), "a-long-enough-password");
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", SAAS_SITE.terms.termsUrl);
    await user.click(screen.getByRole("checkbox", { name: /terms/i }));
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/we have sent a confirmation link/i)).toBeInTheDocument();
    expect(register).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "a-long-enough-password",
      acceptedTermsVersion: SAAS_SITE.terms.version,
    });
  });

  it("on a site that asks for no Terms, /register shows no agreement and sends no version (D36-1 decision 32)", async () => {
    const register = vi.spyOn(apiClient, "postRegister").mockResolvedValue({ status: "verification_sent" });
    const user = userEvent.setup();
    renderAt("/register", { site: { ...SAAS_SITE, terms: { version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" } } });

    await user.type(await screen.findByLabelText(/^email$/i), "person@example.com");
    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    await user.type(screen.getByLabelText(/confirm password/i), "a-long-enough-password");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/we have sent a confirmation link/i)).toBeInTheDocument();
    expect(register).toHaveBeenCalledWith({ email: "person@example.com", password: "a-long-enough-password" });
  });

  it("walks from sign-in to registration and back, where registration is open", async () => {
    const user = userEvent.setup();
    renderAt("/login", { site: SAAS_SITE });

    await user.click(await screen.findByRole("link", { name: /sign up/i }));
    expect(await screen.findByRole("heading", { name: /create account/i })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /^sign in$/i }));
    expect(await screen.findByRole("heading", { name: /sign in to telflo/i })).toBeInTheDocument();
  });

  it("passes the link's token to the verification panel", async () => {
    const spy = vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "verified" });
    renderAt("/verify-email?token=from-the-email");

    expect(await screen.findByText(/your email address is confirmed/i)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ token: "from-the-email" });
  });

  it("takes the verification token out of the address bar as the page mounts (D4 Ruling 14)", async () => {
    vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "verified" });
    renderAt("/verify-email?token=from-the-email&utm_source=mail");

    await screen.findByText(/your email address is confirmed/i);
    expect(window.location.href).not.toContain("from-the-email");
    expect(window.location.pathname + window.location.search).toBe("/verify-email?utm_source=mail");
  });

  it("confirms once under strict mode's double effects, the token read from the address bar", async () => {
    const spy = vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValue({ status: "verified" });
    renderAt("/verify-email?token=from-the-email", { strict: true });

    await screen.findByText(/your email address is confirmed/i);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ token: "from-the-email" });
  });

  it("confirms again on a reload, as it did when the token stayed in the address bar", async () => {
    const spy = vi.spyOn(apiClient, "postVerifyEmail").mockResolvedValueOnce({ status: "verified" });
    const first = renderAt("/verify-email?token=from-the-email");
    await screen.findByText(/your email address is confirmed/i);
    first.unmount();

    spy.mockResolvedValueOnce({ status: "already_verified" });
    renderAt("/verify-email");

    expect(await screen.findByText(/already confirmed/i)).toBeInTheDocument();
    expect(spy).toHaveBeenLastCalledWith({ token: "from-the-email" });
    expect(sessionStorage.getItem(VERIFY_TOKEN_STORAGE_KEY)).toBe("from-the-email");
  });

  it("without a token in the address bar or kept, says the link is missing its code", async () => {
    const spy = vi.spyOn(apiClient, "postVerifyEmail");
    renderAt("/verify-email");

    expect(await screen.findByText(/missing its confirmation code/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("offers no Sign up where registration isn't open, the open source's default (D36-1 decision 23)", async () => {
    renderAt("/login");
    expect(await screen.findByRole("heading", { name: /sign in to telflo/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /sign up/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/don.t have an account/i)).not.toBeInTheDocument();
  });

  it.each(["/register", "/check-your-email", "/verify-email"])(
    "renders %s inside the auth shell, with a way back to sign-in (D36-1 decision 23: no home page)",
    async (path) => {
      vi.spyOn(apiClient, "postVerifyEmail").mockReturnValue(new Promise(() => {}));
      renderAt(path);
      expect(await screen.findByRole("link", { name: /back to sign in/i })).toHaveAttribute("href", "/login");
    },
  );

  it("renders /login inside the auth shell, with no link back to itself; the logo goes to sign-in, the rail names no site", async () => {
    renderAt("/login");
    expect(await screen.findByRole("heading", { name: /sign in to telflo/i })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /back to/i })).not.toBeInTheDocument();
    for (const logo of screen.getAllByRole("link", { name: "Telflo" })) expect(logo).toHaveAttribute("href", "/login");
    expect(screen.queryByText("telflo.com")).not.toBeInTheDocument();
  });

  it.each(["/forgot-password", "/reset-password#token=from-the-email"])(
    "renders %s inside the auth shell without the home link",
    async (path) => {
      renderAt(path);
      expect(await screen.findByRole("link", { name: /^sign in$/i })).toHaveAttribute("href", "/login");
      await waitFor(() => expect(document.body).toHaveClass("tf-app"));
      expect(screen.queryByRole("link", { name: /back to sign in/i })).not.toBeInTheDocument();
    },
  );

  it("walks from sign-in to forgot password and back", async () => {
    const user = userEvent.setup();
    renderAt("/login");

    await user.click(await screen.findByRole("link", { name: /forgot password/i }));
    expect(await screen.findByText("Reset Password")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /^sign in$/i }));
    expect(await screen.findByRole("heading", { name: /sign in to telflo/i })).toBeInTheDocument();
  });

  it("passes the link's token to the reset form", async () => {
    const spy = vi.spyOn(apiClient, "resetPassword").mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAt("/reset-password#token=from-the-email");

    await user.type(await screen.findByLabelText("New Password"), "a-long-enough-password");
    await user.type(screen.getByLabelText("Confirm Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Update Password" }));

    expect(await screen.findByText("Password updated successfully! Redirecting...")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ token: "from-the-email", password: "a-long-enough-password" });
    expect(window.location.href).not.toContain("from-the-email");
  });

  it("sends no Referer from /reset-password, as a backstop to the fragment, and keeps it out of search indexes", () => {
    const meta = resetPasswordMeta({} as Parameters<typeof resetPasswordMeta>[0]);
    expect(meta).toContainEqual({ name: "referrer", content: "no-referrer" });
    expect(meta).toContainEqual({ name: "robots", content: "noindex" });
  });

  it("scopes <body> to the app theme only while an auth screen is shown", async () => {
    const { unmount } = renderAt("/check-your-email");
    await screen.findByText(/check your email/i);
    // Radix portals render into <body>, so the app tokens must reach it.
    await waitFor(() => expect(document.body).toHaveClass("tf-app"));

    unmount();
    expect(document.body).not.toHaveClass("tf-app");
  });

  it.each(["/login", "/register", "/check-your-email", "/verify-email", "/forgot-password", "/reset-password"])(
    "has session replay mask all of %s's text: ph-mask on the shell's root and, while shown, on <body> (D4 Ruling 14)",
    async (path) => {
      vi.spyOn(apiClient, "postVerifyEmail").mockReturnValue(new Promise(() => {}));
      const { container, unmount } = renderAt(path);
      await screen.findAllByRole("img", { name: "Telflo" });

      expect(container.firstElementChild).toHaveClass("ph-mask");
      await waitFor(() => expect(document.body).toHaveClass("ph-mask"));

      unmount();
      expect(document.body).not.toHaveClass("ph-mask");
    },
  );

  it.each(["/login", "/register", "/check-your-email", "/verify-email", "/forgot-password", "/reset-password"])(
    "masks autocapture's text and attributes while %s is shown (D4 Ruling 16)",
    async (path) => {
      vi.spyOn(apiClient, "postVerifyEmail").mockReturnValue(new Promise(() => {}));
      const release = vi.fn();
      const masked = vi.spyOn(analytics, "setAnalyticsMasked").mockReturnValue(release);
      const { unmount } = renderAt(path);
      await screen.findAllByRole("img", { name: "Telflo" });

      await waitFor(() => expect(masked).toHaveBeenCalledWith(true));
      expect(release).not.toHaveBeenCalled();

      unmount();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("titles each page", () => {
    expect(loginMeta({} as Parameters<typeof loginMeta>[0])).toContainEqual({ title: "Login - Telflo" });
    expect(registerMeta({} as Parameters<typeof registerMeta>[0])).toContainEqual({ title: "Sign Up - Telflo" });
    expect(checkYourEmailMeta({} as Parameters<typeof checkYourEmailMeta>[0])).toContainEqual({
      title: "Check your email - Telflo",
    });
    expect(verifyEmailMeta({} as Parameters<typeof verifyEmailMeta>[0])).toContainEqual({
      title: "Confirm your email - Telflo",
    });
    expect(forgotPasswordMeta({} as Parameters<typeof forgotPasswordMeta>[0])).toEqual([
      { title: "Forgot Password - Telflo" },
      { name: "description", content: "Reset your Telflo password" },
    ]);
    expect(resetPasswordMeta({} as Parameters<typeof resetPasswordMeta>[0])).toEqual(
      expect.arrayContaining([
        { title: "Reset Password - Telflo" },
        { name: "description", content: "Set a new password for your Telflo account" },
      ]),
    );
  });
});

/** Every route module's file in the app's route config, nested ones included. */
function routeFiles(entries: ReadonlyArray<{ file: string; children?: ReadonlyArray<{ file: string }> }>): string[] {
  return entries.flatMap((entry) => [entry.file, ...routeFiles(entry.children ?? [])]);
}

describe("the auth screens' theme (D21 decision 22)", () => {
  it(
    "each of the seven auth routes and the playground's pages are marked remembered, and no other route is",
    async () => {
      // root's Layout renders these routes in the theme this browser was last
      // told (the remembered value, else the telflo_theme cookie); every
      // other page renders the stored theme or dark, never the cookie's.
      // D31-1 decision 14: the playground's pages and the public editor too
      // (its two redirects render nothing).
      const marked: string[] = [];
      for (const file of ["root.tsx", ...routeFiles(routes)]) {
        // The path is only known here; vitest resolves it from this file.
        const module = (await import(/* @vite-ignore */ `../${file}`)) as { handle?: unknown };
        if (module.handle === undefined) continue;
        expect(module.handle, file).toEqual({ theme: "remembered" });
        marked.push(file);
      }
      expect(marked.sort()).toEqual(
        [
          "routes/accept-invitation.tsx",
          "routes/check-your-email.tsx",
          "routes/forgot-password.tsx",
          "routes/login.tsx",
          "routes/playground.tsx",
          "routes/playground._index.tsx",
          "routes/playground.editor.tsx",
          "routes/playground.fleet-management.tsx",
          "routes/playground.fleet-management.$fleetId.tsx",
          "routes/playground.flows.tsx",
          "routes/playground.flows.$slug.tsx",
          "routes/public-editor.tsx",
          "routes/register.tsx",
          "routes/reset-password.tsx",
          "routes/verify-email.tsx",
        ].sort(),
      );
    },
    60_000,
  );
});
