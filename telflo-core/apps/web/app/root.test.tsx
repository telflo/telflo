import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES, OPEN_SOURCE_SITE, SITE_VARIABLES, type CurrentUserResponse, type Theme } from "@telflo/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Outlet, createRoutesStub, type HydrationState } from "react-router";
import { toast } from "sonner";
import App, { ErrorBoundary, Layout, loader, shouldRevalidate } from "./root.js";
import { useSite } from "~/lib/use-site.js";
import { AppLayout } from "~/components/layout/AppLayout.js";
import * as apiClient from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import type { AppLayoutData } from "~/routes/app-layout.js";

// Its own file: sonner keeps toasts in a module singleton, and one raised in
// another test file with no Toaster mounted must not show up here.

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";
const CURRENT_USER: CurrentUserResponse = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "person@example.com" },
  organization: { id: ORGANIZATION_ID, name: "personal", type: "personal", logoId: null, role: "admin" },
  organizations: [{ id: ORGANIZATION_ID, name: "personal", type: "personal", logoId: null, role: "admin" }],
  termsAcceptanceRequired: false,
  isProductAdmin: false,
  mayCreateOrganizations: true,
  preferences: DEFAULT_USER_PREFERENCES,
};

describe("root App", () => {
  it("renders the page with the one Toaster beside it", async () => {
    const Stub = createRoutesStub([
      { path: "/", Component: App, children: [{ path: "/", Component: () => <p>a page</p> }] },
    ]);
    render(<Stub initialEntries={["/"]} />);

    expect(await screen.findByText("a page")).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: /Notifications/ })).toHaveLength(1);
  });

  it("holds the one slot for Monaco's live region: replay-blocked, audible under dialogs", async () => {
    const Stub = createRoutesStub([
      { path: "/", Component: App, children: [{ path: "/", Component: () => <p>a page</p> }] },
    ]);
    const { container } = render(<Stub initialEntries={["/"]} />);
    await screen.findByText("a page");

    const slots = container.querySelectorAll("[data-monaco-aria-host-slot]");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toHaveClass("ph-no-capture");
    expect(slots[0]).toHaveAttribute("aria-live", "off");
    expect(slots[0]!.querySelector("[data-monaco-aria-host]")).not.toBeNull();
  });

  it("shows the logout toast on /login, not after the next sign-in", async () => {
    vi.spyOn(apiClient, "deleteCurrentSession").mockResolvedValue(undefined);
    useUserStore.getState().setCurrent(CURRENT_USER);
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: App,
        children: [
          {
            path: "/app",
            Component: () => (
              <AppLayout>
                <p>signed-in page</p>
              </AppLayout>
            ),
          },
          { path: "/login", Component: () => <p>landed on /login</p> },
        ],
      },
    ]);
    render(<Stub initialEntries={["/app"]} />);
    await screen.findByText("signed-in page");
    expect(screen.queryByText("Logged out successfully")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(await screen.findByTitle("Switch organization"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Logout" }));

    expect(await screen.findByText("landed on /login")).toBeInTheDocument();
    expect(await screen.findByText("Logged out successfully")).toBeInTheDocument();
  });
});

/** Root's loader arguments for a page request carrying `cookie` (settings.test.tsx's form). */
function loaderArgs(cookie?: string): Parameters<typeof loader>[0] {
  const request = new Request("http://localhost/login", cookie === undefined ? {} : { headers: { cookie } });
  return { request, params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
}

describe("root loader", () => {
  beforeEach(() => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "");
    vi.stubEnv("TELFLO_POSTHOG_KEY", "");
    vi.stubEnv("TELFLO_POSTHOG_HOST", "");
    // The site's variables unset: the open source's defaults.
    for (const name of Object.values(SITE_VARIABLES)) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const site = OPEN_SOURCE_SITE;

  it("passes on TELFLO_PUBLIC_WEB_URL, without a trailing slash", () => {
    vi.stubEnv("TELFLO_PUBLIC_WEB_URL", "https://telflo.example/");
    expect(loader(loaderArgs())).toEqual({ publicWebUrl: "https://telflo.example", analytics: null, theme: "dark", site });
  });

  it("passes on null when the setting is unset", () => {
    expect(loader(loaderArgs())).toEqual({ publicWebUrl: null, analytics: null, theme: "dark", site });
  });

  it("passes on the site's switches and links, the open source's defaults when unset", () => {
    expect(loader(loaderArgs()).site).toEqual({
      registration: "invite-only",
      playground: false,
      anonymousValidate: false,
      publicFlows: false,
      salesInquiry: false,
      emailNotifications: false,
      userFeedback: false,
      learning: false,
      userAdmin: false,
      docsUrl: "https://docs.telflo.com/",
      terms: { version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" },
    });
  });

  it("passes on the SaaS's site values, read when it runs", () => {
    vi.stubEnv("TELFLO_REGISTRATION", "open");
    vi.stubEnv("TELFLO_PLAYGROUND", "true");
    vi.stubEnv("TELFLO_ANONYMOUS_VALIDATE", "true");
    vi.stubEnv("TELFLO_PUBLIC_FLOWS", "true");
    vi.stubEnv("TELFLO_EMAIL_NOTIFICATIONS", "true");
    vi.stubEnv("TELFLO_USER_FEEDBACK", "true");
    vi.stubEnv("TELFLO_LEARNING", "true");
    vi.stubEnv("TELFLO_USER_ADMIN", "true");
    vi.stubEnv("TELFLO_DOCS_URL", "");
    vi.stubEnv("TELFLO_TERMS_VERSION", "2026-01-01");
    vi.stubEnv("TELFLO_TERMS_URL", "/home/terms-of-service");
    vi.stubEnv("TELFLO_PRIVACY_URL", "/home/privacy-policy");
    vi.stubEnv("TELFLO_COOKIE_POLICY_URL", "https://telflo.example/home/cookie-policy");
    expect(loader(loaderArgs()).site).toEqual({
      registration: "open",
      playground: true,
      anonymousValidate: true,
      publicFlows: true,
      salesInquiry: false,
      emailNotifications: true,
      userFeedback: true,
      learning: true,
      userAdmin: true,
      docsUrl: "",
      terms: {
        version: "2026-01-01",
        termsUrl: "/home/terms-of-service",
        privacyUrl: "/home/privacy-policy",
        cookiePolicyUrl: "https://telflo.example/home/cookie-policy",
      },
    });
  });

  it("throws the API's fixed refusal for a site value its rules refuse, quoting nothing of it", () => {
    vi.stubEnv("TELFLO_TERMS_URL", "https://cnryuser:cnrypw@legal.example.com/terms");
    let message = "";
    try {
      loader(loaderArgs());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.startsWith("Environment variable TELFLO_TERMS_URL must be an https URL")).toBe(true);
    expect(message.includes("cnry")).toBe(false);
  });

  it("the loader reads telflo_theme and gives dark for an absent, unknown or oversized value", () => {
    // The word alone goes out: never the cookie header or anything else in it.
    expect(loader(loaderArgs("telflo_theme=light"))).toEqual({ publicWebUrl: null, analytics: null, theme: "light", site });
    expect(loader(loaderArgs("a=1; telflo_theme=navy; telflo_access=x")).theme).toBe("navy");
    expect(loader(loaderArgs(" telflo_theme = navy ")).theme).toBe("navy");
    // The first of two, as browsers send the most specific path's first.
    expect(loader(loaderArgs("telflo_theme=navy; telflo_theme=light")).theme).toBe("navy");

    for (const cookie of [
      undefined,
      "",
      "telflo_access=x",
      "telflo_theme",
      "telflo_theme=",
      "telflo_theme=Dark",
      "telflo_theme=LIGHT",
      "telflo_theme=system",
      'telflo_theme="light"',
      "telflo_theme=%6Cight",
      "telflo_theme=light navy",
      "xtelflo_theme=light",
      `telflo_theme=${"light".repeat(1_000)}`,
    ]) {
      expect(loader(loaderArgs(cookie)).theme, String(cookie)).toBe(DEFAULT_USER_PREFERENCES.theme);
    }
  });

  it("passes on PostHog's key and host, read when it runs", () => {
    vi.stubEnv("TELFLO_POSTHOG_KEY", "phc_test");
    vi.stubEnv("TELFLO_POSTHOG_HOST", "https://eu.i.posthog.com/");
    expect(loader(loaderArgs()).analytics).toEqual({ key: "phc_test", host: "https://eu.i.posthog.com" });

    vi.stubEnv("TELFLO_POSTHOG_HOST", "");
    expect(loader(loaderArgs()).analytics).toEqual({ key: "phc_test", host: null });
  });

  it("passes on no analytics without a key, whatever the host", () => {
    vi.stubEnv("TELFLO_POSTHOG_HOST", "https://eu.i.posthog.com");
    expect(loader(loaderArgs()).analytics).toBeNull();

    vi.stubEnv("TELFLO_POSTHOG_KEY", "   ");
    expect(loader(loaderArgs()).analytics).toBeNull();
  });

  it("never reloads on a navigation: the settings don't change while the server runs", () => {
    expect(shouldRevalidate()).toBe(false);
  });
});

const SIGNED_IN = (theme: Theme): AppLayoutData => ({
  status: "signed_in",
  currentUser: { ...CURRENT_USER, preferences: { ...DEFAULT_USER_PREFERENCES, theme } },
});

/**
 * The page's HTML as the server renders it: root's Layout around its page
 * (or its error boundary), from loader data and errors as the server's
 * render has them. On the server the remembered value is null and the user
 * store empty.
 */
function serverHtml(path: string, hydrationData: HydrationState): string {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => null,
      Component: () => (
        <Layout>
          <Outlet />
        </Layout>
      ),
      ErrorBoundary: (props: unknown) => (
        <Layout>
          <ErrorBoundary {...(props as Parameters<typeof ErrorBoundary>[0])} />
        </Layout>
      ),
      children: [
        { path: "login", handle: { theme: "remembered" }, Component: () => <p>an auth screen</p> },
        { path: "pricing", Component: () => <p>a marketing page</p> },
        {
          id: "routes/app-layout",
          loader: () => null,
          Component: Outlet,
          children: [{ path: "app", Component: () => <p>a signed-in page</p> }],
        },
      ],
    },
  ]);
  // The stub's manifest names no entry module, so <Scripts /> preloads ""
  // and React warns about the empty href; that warning alone is dropped.
  const consoleError = console.error;
  const quiet = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const [format, attribute] = args;
    const emptyHref =
      typeof format === "string" && format.startsWith('An empty string ("") was passed to the %s') && attribute === "href";
    if (!emptyHref) consoleError(...args);
  });
  try {
    return renderToString(<Stub initialEntries={[path]} hydrationData={hydrationData} />);
  } finally {
    quiet.mockRestore();
  }
}

/** `<html>`'s class attribute in `html`; "" for none. */
function htmlClass(html: string): string {
  const tag = /<html[^>]*>/.exec(html)?.[0];
  if (tag === undefined) throw new Error("no <html> in the render");
  return /class="([^"]*)"/.exec(tag)?.[1] ?? "";
}

const ROOT_DATA = (theme: Theme) => ({ publicWebUrl: null, analytics: null, theme });

describe("root Layout's <html> class", () => {
  beforeEach(() => {
    useUserStore.getState().clear();
  });

  it("renders the signed-in page's stored class, not the cookie's", () => {
    for (const [stored, className] of [
      ["navy", "dark navy"],
      ["light", ""],
      ["dark", "dark"],
    ] as const) {
      const html = serverHtml("/app", {
        loaderData: { root: ROOT_DATA(stored === "light" ? "navy" : "light"), "routes/app-layout": SIGNED_IN(stored) },
      });
      expect(html).toContain("a signed-in page");
      expect(htmlClass(html), stored).toBe(className);
    }
  });

  it("renders the cookie's class on the refresh placeholder", () => {
    const html = serverHtml("/app", {
      loaderData: { root: ROOT_DATA("navy"), "routes/app-layout": { status: "refresh_needed" } },
    });
    expect(htmlClass(html)).toBe("dark navy");
  });

  it("renders an auth screen's class from the cookie", () => {
    for (const [cookie, className] of [
      ["light", ""],
      ["navy", "dark navy"],
      ["dark", "dark"],
    ] as const) {
      const html = serverHtml("/login", { loaderData: { root: ROOT_DATA(cookie) } });
      expect(html).toContain("an auth screen");
      expect(htmlClass(html), cookie).toBe(className);
    }
  });

  it("renders dark on a marketing page and on an error", () => {
    const marketing = serverHtml("/pricing", { loaderData: { root: ROOT_DATA("light") } });
    expect(marketing).toContain("a marketing page");
    expect(htmlClass(marketing)).toBe("dark");

    // A 404: no route matched.
    const notFound = serverHtml("/nowhere", { loaderData: { root: ROOT_DATA("light") } });
    expect(notFound).toContain("The requested page could not be found.");
    expect(htmlClass(notFound)).toBe("dark");

    // A failed layout loader: the error at root's boundary, no layout data.
    const failedLayout = serverHtml("/app", {
      loaderData: { root: ROOT_DATA("light") },
      errors: { root: new Error("the API is down") },
    });
    expect(failedLayout).toContain("Oops!");
    expect(htmlClass(failedLayout)).toBe("dark");

    // An error below a loaded signed-in layout keeps the stored theme.
    const childError = serverHtml("/app", {
      loaderData: { root: ROOT_DATA("light"), "routes/app-layout": SIGNED_IN("navy") },
      errors: { root: new Error("the page failed") },
    });
    expect(childError).toContain("Oops!");
    expect(htmlClass(childError)).toBe("dark navy");
  });

  it("renders an auth screen's error in the cookie's theme, not dark", () => {
    // The error reaches root's boundary; the auth route is still matched, so its handle still holds.
    for (const [cookie, className] of [
      ["light", ""],
      ["navy", "dark navy"],
    ] as const) {
      const authError = serverHtml("/login", {
        loaderData: { root: ROOT_DATA(cookie) },
        errors: { root: new Error("the API is down") },
      });
      expect(authError).toContain("Oops!");
      expect(htmlClass(authError), cookie).toBe(className);
    }
  });
});

describe("the Toaster", () => {
  it("the Toaster follows the theme", async () => {
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ROOT_DATA("light"),
        HydrateFallback: () => null,
        Component: App,
        children: [
          {
            path: "/login",
            handle: { theme: "remembered" },
            Component: () => (
              <>
                <button type="button" onClick={() => toast("Saved")}>
                  Raise
                </button>
                <Link to="/pricing">Pricing</Link>
              </>
            ),
          },
          { path: "/pricing", Component: () => <h1>pricing</h1> },
        ],
      },
    ]);
    const { container } = render(<Stub initialEntries={["/login"]} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Raise" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const toaster = () => container.querySelector("[data-sonner-toaster]");
    // The auth screen renders the cookie's Light.
    expect(toaster()).toHaveAttribute("data-sonner-theme", "light");

    // A marketing page is Dark; the toast still showing takes it.
    await user.click(screen.getByRole("link", { name: "Pricing" }));
    expect(await screen.findByRole("heading", { name: "pricing" })).toBeInTheDocument();
    await waitFor(() => expect(toaster()).toHaveAttribute("data-sonner-theme", "dark"));
  });
});

describe("useSite", () => {
  function SiteProbe() {
    const site = useSite();
    return <p>{`${site.registration} ${site.terms.version || "no terms"} ${site.docsUrl || "no docs"}`}</p>;
  }

  it("reads the site root's loader passed on", async () => {
    const saas = { ...OPEN_SOURCE_SITE, registration: "open" as const, docsUrl: "", terms: { ...OPEN_SOURCE_SITE.terms, version: "2026-01-01" } };
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        Component: () => <Outlet />,
        loader: () => ({ publicWebUrl: null, analytics: null, theme: "dark", site: saas }),
        HydrateFallback: () => null,
        children: [{ path: "/", Component: SiteProbe }],
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByText("open 2026-01-01 no docs")).toBeInTheDocument();
  });

  it("falls back to the open source's defaults without root's data", async () => {
    const Stub = createRoutesStub([{ path: "/", Component: SiteProbe }]);
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByText("invite-only no terms https://docs.telflo.com/")).toBeInTheDocument();
  });
});
