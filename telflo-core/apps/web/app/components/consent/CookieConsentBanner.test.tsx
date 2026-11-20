import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CookieConsentBanner } from "./CookieConsentBanner.js";
import { getConsentStatus } from "~/lib/cookie-consent.js";
import { mockPostHog, settle, type PostHogMock } from "~/test/posthog.js";

// The banner with analytics running behind it, as root mounts them when
// TELFLO_POSTHOG_KEY is set: each choice is checked against what PostHog is
// told. posthog-js is mocked at its module boundary (test/posthog.ts), and
// the page is on a public host, where accepting starts replay.

let posthog: PostHogMock;

beforeEach(() => {
  localStorage.clear();
  posthog = mockPostHog();
  vi.stubGlobal("location", new URL("https://telflo.example/"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The site's cookie-policy URL the SaaS sets. */
const POLICY_URL = "/home/cookie-policy";

/** jsdom can't open another tab; the tests only need the click. */
function stopNavigation(event: MouseEvent) {
  if (event.target instanceof Element && event.target.closest("a[target='_blank']")) event.preventDefault();
}
beforeEach(() => document.addEventListener("click", stopNavigation));
afterEach(() => document.removeEventListener("click", stopNavigation));

async function renderWithAnalytics(cookiePolicyUrl: string = POLICY_URL) {
  const { useAnalytics } = await import("~/lib/analytics.js");
  function Root() {
    useAnalytics({ key: "phc_test", host: null });
    return <CookieConsentBanner cookiePolicyUrl={cookiePolicyUrl} />;
  }
  const rendered = render(<Root />);
  await vi.waitFor(() => expect(posthog.client.init).toHaveBeenCalled());
  await settle();
  return { ...rendered, user: userEvent.setup() };
}

function banner() {
  return screen.getByRole("dialog", { name: "Telflo uses cookies" });
}

describe("the consent banner", () => {
  it("shows until a choice is stored, with Cookie preferences, Allow all and the site's Cookie Policy, linked in a new tab", async () => {
    await renderWithAnalytics();

    const dialog = await screen.findByRole("dialog", { name: "Telflo uses cookies" });
    expect(dialog).toHaveTextContent(
      "We use cookies to understand how Telflo is used and to improve your experience. See our Cookie Policy.",
    );
    expect(within(dialog).getByRole("button", { name: "Cookie preferences" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Allow all" })).toBeInTheDocument();
    const policy = within(dialog).getByRole("link", { name: "Cookie Policy" });
    expect(policy).toHaveAttribute("href", POLICY_URL);
    expect(policy).toHaveAttribute("target", "_blank");
    expect(policy).toHaveAttribute("rel", "noopener noreferrer");
    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("names no policy page without the site's cookie-policy URL: the sentence ends after \"experience.\"", async () => {
    await renderWithAnalytics("");

    const dialog = await screen.findByRole("dialog", { name: "Telflo uses cookies" });
    expect(within(dialog).getByText(/^We use cookies/)).toHaveTextContent(
      /^We use cookies to understand how Telflo is used and to improve your experience\.$/,
    );
    expect(within(dialog).queryByText(/Cookie Policy/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cookie preferences", "Allow all"]);
  });

  it("following the Cookie Policy link leaves the banner up, undecided", async () => {
    const { user } = await renderWithAnalytics();

    await user.click(within(await screen.findByRole("dialog")).getByRole("link", { name: "Cookie Policy" }));

    expect(banner()).toBeInTheDocument();
    expect(getConsentStatus()).toBeNull();
    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("can't be dismissed without a choice", async () => {
    const { user } = await renderWithAnalytics();
    await screen.findByRole("dialog", { name: "Telflo uses cookies" });

    await user.keyboard("{Escape}");

    expect(banner()).toBeInTheDocument();
    expect(getConsentStatus()).toBeNull();
  });

  it("Allow all stores the choice, opts in to capture, starts replay and closes", async () => {
    const { user } = await renderWithAnalytics();

    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow all" }));

    expect(getConsentStatus()).toBe("accepted");
    await waitFor(() => expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1));
    expect(posthog.client.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the choice across a reload: no banner, and capture as chosen from the start", async () => {
    const first = await renderWithAnalytics();
    await first.user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Allow all" }));
    first.unmount();

    posthog = mockPostHog();
    await renderWithAnalytics();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1);
    expect(posthog.client.startSessionRecording).toHaveBeenCalledTimes(1);
  });
});

describe("the preferences modal", () => {
  async function openPreferences(cookiePolicyUrl: string = POLICY_URL) {
    const rendered = await renderWithAnalytics(cookiePolicyUrl);
    await rendered.user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cookie preferences" }),
    );
    return { ...rendered, modal: await screen.findByRole("dialog", { name: "Your privacy options" }) };
  }

  it("shows strictly necessary cookies always on, and analytics off by default", async () => {
    const { modal } = await openPreferences();

    expect(within(modal).getByRole("heading", { name: "Strictly necessary cookies" })).toBeInTheDocument();
    expect(within(modal).getByText("Always active")).toBeInTheDocument();
    expect(within(modal).getByRole("switch", { name: "Analytics & session replay" })).not.toBeChecked();
    expect(screen.queryByRole("dialog", { name: "Telflo uses cookies" })).not.toBeInTheDocument();
  });

  it("Confirm my choices with analytics off rejects: nothing is captured and replay stays off", async () => {
    const { user, modal } = await openPreferences();

    await user.click(within(modal).getByRole("button", { name: "Confirm my choices" }));

    expect(getConsentStatus()).toBe("rejected");
    await settle();
    expect(posthog.client.clear_opt_in_out_capturing).toHaveBeenCalledTimes(2);
    expect(posthog.client.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthog.client.startSessionRecording).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Confirm my choices with analytics on accepts: capture and replay start", async () => {
    const { user, modal } = await openPreferences();

    await user.click(within(modal).getByRole("switch", { name: "Analytics & session replay" }));
    await user.click(within(modal).getByRole("button", { name: "Confirm my choices" }));

    expect(getConsentStatus()).toBe("accepted");
    await waitFor(() => expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1));
    expect(posthog.client.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("its Allow all accepts", async () => {
    const { user, modal } = await openPreferences();

    await user.click(within(modal).getByRole("button", { name: "Allow all" }));

    expect(getConsentStatus()).toBe("accepted");
    await waitFor(() => expect(posthog.client.opt_in_capturing).toHaveBeenCalledTimes(1));
  });

  it("closing it goes back to the banner, undecided", async () => {
    const { user, modal } = await openPreferences();

    await user.click(within(modal).getByRole("button", { name: "Close" }));

    expect(await screen.findByRole("dialog", { name: "Telflo uses cookies" })).toBeInTheDocument();
    expect(getConsentStatus()).toBeNull();
  });

  it("reads more in the site's Cookie Policy, a link in a new tab, and names none without the URL", async () => {
    const { modal, unmount } = await openPreferences();
    expect(modal).toHaveTextContent("Read more in our Cookie Policy.");
    const policy = within(modal).getByRole("link", { name: "Cookie Policy" });
    expect(policy).toHaveAttribute("href", POLICY_URL);
    expect(policy).toHaveAttribute("target", "_blank");
    expect(policy).toHaveAttribute("rel", "noopener noreferrer");
    unmount();

    posthog = mockPostHog();
    const without = await openPreferences("");
    expect(without.modal).not.toHaveTextContent("Cookie Policy");
    expect(within(without.modal).queryByRole("link")).not.toBeInTheDocument();
  });
});
