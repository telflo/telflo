import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { OPEN_SOURCE_SITE, type SiteSettings } from "@telflo/contracts";
import type { AnalyticsSettings } from "~/lib/analytics.js";
import { setConsentStatus } from "~/lib/cookie-consent.js";
import { mockPostHog, settle, type PostHogMock } from "~/test/posthog.js";

// Root with and without TELFLO_POSTHOG_KEY. A fresh root for every test,
// sharing the fresh analytics module and posthog-js mock of test/posthog.ts.
// jsdom's page is on localhost, where replay never starts.

let posthog: PostHogMock;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  posthog = mockPostHog();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

async function renderRoot(analytics: AnalyticsSettings | null, site?: SiteSettings) {
  const { default: App } = await import("./root.js");
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      Component: App,
      loader: () => ({ publicWebUrl: null, analytics, ...(site !== undefined && { site }) }),
      HydrateFallback: () => null,
      children: [{ index: true, Component: () => <p>a page</p> }],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  await screen.findByText("a page");
}

describe("root without a PostHog key", () => {
  it("never imports posthog-js and shows no banner, even when a choice is made", async () => {
    await renderRoot(null);
    act(() => setConsentStatus("accepted"));
    await settle();

    expect(posthog.imported).not.toHaveBeenCalled();
    expect(posthog.client.init).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("root with a PostHog key", () => {
  it("hands the banner the site's cookie-policy URL, and none without one", async () => {
    const withPolicy = { ...OPEN_SOURCE_SITE, terms: { ...OPEN_SOURCE_SITE.terms, cookiePolicyUrl: "https://policies.example.org/cookies" } };
    await renderRoot({ key: "phc_test", host: null }, withPolicy);
    const banner = await screen.findByRole("dialog", { name: "Telflo uses cookies" });
    expect(within(banner).getByRole("link", { name: "Cookie Policy" })).toHaveAttribute("href", "https://policies.example.org/cookies");
  });

  it("names no cookie policy when the site has none, the open source's default", async () => {
    await renderRoot({ key: "phc_test", host: null }, OPEN_SOURCE_SITE);
    const banner = await screen.findByRole("dialog", { name: "Telflo uses cookies" });
    expect(within(banner).queryByText(/Cookie Policy/)).not.toBeInTheDocument();
  });

  it("imports and initialises posthog-js, and shows the banner", async () => {
    await renderRoot({ key: "phc_test", host: null });

    expect(await screen.findByRole("dialog", { name: "Telflo uses cookies" })).toBeInTheDocument();
    await waitFor(() => expect(posthog.client.init).toHaveBeenCalledTimes(1));
    expect(posthog.client.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({ cookieless_mode: "on_reject" }));
    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("on localhost, Allow all opts in to capture but never starts replay", async () => {
    await renderRoot({ key: "phc_test", host: null });
    const user = userEvent.setup();

    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow all" }));

    await waitFor(() => expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1));
    await settle();
    expect(posthog.client.startSessionRecording).not.toHaveBeenCalled();
  });
});

describe("an emailed link's token and PostHog", () => {
  /**
   * Root with analytics on and the page at `url`, as a browser loads it from
   * the email: the document's URL has the token; the router gets the path
   * and query. Returns the address PostHog saw when it initialised, which is
   * the one it records as the page's and keeps as the person's first.
   */
  async function addressAtInit(url: string): Promise<string> {
    window.history.replaceState(null, "", url);
    const { default: App } = await import("./root.js");
    const { default: ResetPasswordPage } = await import("./routes/reset-password.js");
    const { default: VerifyEmailPage } = await import("./routes/verify-email.js");
    const apiClient = await import("~/lib/api-client.js");
    vi.spyOn(apiClient, "postVerifyEmail").mockReturnValue(new Promise(() => {}));
    let seen = "";
    posthog.client.init.mockImplementation(() => {
      seen = window.location.href;
    });
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        Component: App,
        loader: () => ({ publicWebUrl: null, analytics: { key: "phc_test", host: null } }),
        HydrateFallback: () => null,
        children: [
          { path: "reset-password", Component: ResetPasswordPage },
          { path: "verify-email", Component: VerifyEmailPage },
        ],
      },
    ]);
    render(<Stub initialEntries={[url.split("#")[0]!]} />);
    await waitFor(() => expect(posthog.client.init).toHaveBeenCalledTimes(1));
    return seen;
  }

  it("the reset page's fragment is gone before PostHog starts", async () => {
    const seen = await addressAtInit("/reset-password#token=from-the-email");

    expect(seen).not.toContain("from-the-email");
    expect(seen).toMatch(/\/reset-password$/);
  });

  it("the verification page's query token is gone before PostHog starts", async () => {
    const seen = await addressAtInit("/verify-email?token=from-the-email");

    expect(seen).not.toContain("from-the-email");
    expect(seen).toMatch(/\/verify-email$/);
  });
});
