import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FleetRotateToken, FleetStatus } from "@telflo/contracts";
import { formatDateTime } from "~/lib/format.js";
import { EMPTY_SUMMARY, fleetDetail } from "~/test/fleets.js";
import { bannerOf, expiringBannerWords, SUSPENDED_BANNER, suspendedBannerWords, TOKEN_BANNER_LABEL, TokenBanner } from "./TokenBanner.js";

/*
 * The rotate-before-expiry banner. Its button opening the rotate dialog, and
 * the focus coming back to it, are in `TokensTab.test.tsx`.
 */

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function fleetWith(rotateToken: FleetRotateToken | null, status: FleetStatus = "active") {
  return fleetDetail({ status, summary: { ...EMPTY_SUMMARY, rotateToken } });
}

const expiringIn = (ms: number): FleetRotateToken => ({ expiresAt: new Date(NOW + ms).toISOString(), graceEndsAt: null, validCount: 1 });

/** The banner by its name: a `region` landmark, rendered only when there is one. It carries its tone. */
const banner = () => screen.getByRole("region", { name: TOKEN_BANNER_LABEL });
/** No banner: no region by its name at all, hidden or not. */
const expectNoBanner = () => expect(screen.queryByRole("region", { name: TOKEN_BANNER_LABEL, hidden: true })).toBeNull();

function renderBanner(rotateToken: FleetRotateToken | null, status: FleetStatus = "active") {
  const onRotate = vi.fn();
  const { container } = render(<TokenBanner fleet={fleetWith(rotateToken, status)} now={NOW} onRotate={onRotate} defaultTokenValid />);
  return { onRotate, container };
}

describe("TokenBanner", () => {
  it("says a suspended fleet has no valid rotate token, destructive, in its fixed words", () => {
    renderBanner(null);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status", { hidden: true })).toBeNull();
    expect(TOKEN_BANNER_LABEL).toBe("Rotate token notice");
    expect(banner()).toHaveTextContent(SUSPENDED_BANNER);
    expect(SUSPENDED_BANNER).toBe(
      "This fleet has no valid rotate token. Collectors that enroll or restart are sent no configuration, and collectors holding a revoked or expired rotate token are refused until their supervisors restart. Rotate to issue a new one: collectors on the default token that accept connection settings are handed it on one of their next polls.",
    );
    expect(banner()).toHaveClass("text-fail");
  });

  it("says a suspended fleet's restarted collectors can't come back while it has no valid default token", () => {
    render(<TokenBanner fleet={fleetWith(null)} now={NOW} onRotate={vi.fn()} defaultTokenValid={false} />);
    expect(banner()).toHaveTextContent(suspendedBannerWords(false));
    expect(suspendedBannerWords(false)).toBe(
      "This fleet has no valid rotate token. Collectors that enroll or restart are sent no configuration, and collectors holding a revoked or expired rotate token are refused until their supervisors restart (the fleet has no valid default token now: issue a new default token and re-install them). Rotate to issue a new rotate token: collectors re-installed with a new default token that accept connection settings are handed it on one of their next polls.",
    );
    expect(bannerOf(fleetWith(null), NOW, false)).toEqual({ tone: "destructive", words: suspendedBannerWords(false) });
  });

  it("says it in words true either way before the tab's tokens are read", () => {
    render(<TokenBanner fleet={fleetWith(null)} now={NOW} onRotate={vi.fn()} defaultTokenValid={null} />);
    expect(suspendedBannerWords(null)).toBe(
      "This fleet has no valid rotate token. Collectors that enroll or restart are sent no configuration, and collectors holding a revoked or expired rotate token are refused until their supervisors restart and, if the fleet has a valid default token, come back through it. Rotate to issue a new rotate token: collectors on a valid default token that accept connection settings are handed it on one of their next polls.",
    );
    expect(banner()).toHaveTextContent(suspendedBannerWords(null));
    expect(banner()).not.toHaveTextContent(SUSPENDED_BANNER);
    expect(suspendedBannerWords(true)).toBe(SUSPENDED_BANNER);
  });

  it("says the current token expires in 5 days, with its date, destructive under 7 days (the story's)", () => {
    const rotateToken = expiringIn(5 * DAY + HOUR);
    renderBanner(rotateToken);
    expect(banner()).toHaveTextContent(
      `The fleet's rotate token expires in 5 days (${formatDateTime(rotateToken.expiresAt)}). Rotate it before then: collectors still holding it when it expires are refused until their supervisors restart.`,
    );
    expect(banner()).toHaveClass("text-fail");
  });

  it.each([
    ["under a day", 3 * HOUR, "in 3 hours", "destructive"],
    ["just under 7 days", 7 * DAY - 1, "in 6 days", "destructive"],
    ["7 days", 7 * DAY, "in 7 days", "warning"],
    ["20 days", 20 * DAY, "in 20 days", "warning"],
    ["just under 30 days", 30 * DAY - 1, "in 29 days", "warning"],
  ] as const)("shows an expiry %s away (%s), %s", (_why, ms, words, tone) => {
    const rotateToken = expiringIn(ms);
    expect(bannerOf(fleetWith(rotateToken), NOW)).toEqual({ tone, words: expiringBannerWords(rotateToken.expiresAt!, NOW) });
    renderBanner(rotateToken);
    expect(banner()).toHaveTextContent(`expires ${words} (`);
    expect(banner()).toHaveClass(tone === "warning" ? "text-warn" : "text-fail");
  });

  it.each([
    ["30 days away", expiringIn(30 * DAY), "active"],
    ["a year away", expiringIn(365 * DAY), "active"],
    ["never expiring", { expiresAt: null, graceEndsAt: null, validCount: 1 }, "active"],
    ["on an archived fleet, suspended", null, "archived"],
    ["on an archived fleet, expiring in 2 days", expiringIn(2 * DAY), "archived"],
  ] as const)("renders nothing for a current token %s", (_why, rotateToken, status) => {
    expect(bannerOf(fleetWith(rotateToken, status), NOW)).toBeNull();
    const { container } = renderBanner(rotateToken, status);
    expectNoBanner();
    expect(container).toBeEmptyDOMElement();
  });

  // No live semantics (Radix's hideOthers skips aria-live elements, a status re-announced the countdown,
  // an empty status was exposed), so the banner comes and goes as a whole.
  it("is a region named Rotate token notice with no live semantics, there only while there is a banner", () => {
    const onRotate = vi.fn();
    const { container, rerender } = render(<TokenBanner fleet={fleetWith(expiringIn(365 * DAY))} now={NOW} onRotate={onRotate} defaultTokenValid />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TokenBanner fleet={fleetWith(null)} now={NOW} onRotate={onRotate} defaultTokenValid />);
    expect(banner()).toHaveTextContent(SUSPENDED_BANNER);
    expect(banner()).toHaveAttribute("role", "region");
    expect(banner()).toHaveAttribute("aria-label", TOKEN_BANNER_LABEL);
    expect(container.firstElementChild).toBe(banner());
    expect(container.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
    rerender(<TokenBanner fleet={fleetWith(expiringIn(365 * DAY))} now={NOW} onRotate={onRotate} defaultTokenValid />);
    expect(container).toBeEmptyDOMElement();
    expectNoBanner();
  });

  it('opens the rotation from its "Rotate token" button, handing over the button', async () => {
    const { onRotate } = renderBanner(expiringIn(5 * DAY));
    const button = screen.getByRole("button", { name: "Rotate token" });
    await userEvent.setup().click(button);
    expect(onRotate).toHaveBeenCalledWith(button);
  });
});
