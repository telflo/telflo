import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORG_WELCOME_TOUR_DELAY_MS,
  orgWelcomeMessage,
  postAcceptRedirectUrl,
  startOrgWelcomeTour,
} from "./org-welcome-tour.js";

// The callout's four behaviors, each a test.

describe("orgWelcomeMessage", () => {
  it("includes the org name and the switcher hint", () => {
    const msg = orgWelcomeMessage("Cisco", "group");
    expect(msg.title).toContain("Cisco");
    expect(msg.description).toContain("Org Switcher");
  });

  it("escapes HTML in the org name (driver.js renders descriptions as HTML)", () => {
    const msg = orgWelcomeMessage('<img src=x onerror="alert(1)">', "group");
    expect(msg.title).not.toContain("<img");
    expect(msg.title).toContain("&lt;img");
  });

  it("says the callout's words", () => {
    expect(orgWelcomeMessage("Acme & Co", "group")).toEqual({
      title: "Welcome to the Acme &amp; Co organization",
      description:
        "Your account is now working in <strong>Acme &amp; Co</strong> — its configurations, tests, and fleets " +
        "are what you'll see everywhere in the app. To change organizations, use this Org Switcher any time.",
    });
  });
});

describe("orgWelcomeMessage's name for a personal workspace", () => {
  it("says <email>'s organization for one named by its owner's email, the email and 's in bold", () => {
    expect(orgWelcomeMessage("owner@example.com", "personal")).toEqual({
      title: "Welcome to owner@example.com's organization",
      description:
        "Your account is now working in <strong>owner@example.com's</strong> organization — its configurations, tests, and fleets " +
        "are what you'll see everywhere in the app. To change organizations, use this Org Switcher any time.",
    });
  });

  it("says the callout's words for a group named by an email address, a renamed workspace and one named only like an email", () => {
    // [name, type, the name as the HTML carries it]
    for (const [name, type, shown] of [
      ["ops@example.com", "group", "ops@example.com"],
      ["Sam's Lab", "personal", "Sam&#39;s Lab"],
      ["sam@example", "personal", "sam@example"],
    ] as const) {
      const msg = orgWelcomeMessage(name, type);
      expect(msg.title).toBe(`Welcome to the ${shown} organization`);
      expect(msg.description.startsWith(`Your account is now working in <strong>${shown}</strong> — its`)).toBe(true);
    }
  });

  it("escapes a personal workspace's name too", () => {
    const msg = orgWelcomeMessage("<b>x</b>@example.com", "personal");
    expect(msg.title).toBe("Welcome to &lt;b&gt;x&lt;/b&gt;@example.com's organization");
  });
});

describe("postAcceptRedirectUrl", () => {
  it("carries the joined org id as a query param", () => {
    expect(postAcceptRedirectUrl("abc-123")).toBe("/app?joined_org=abc-123");
  });

  it("falls back to /app when acceptance matched no invitation", () => {
    expect(postAcceptRedirectUrl(null)).toBe("/app");
  });
});

describe("startOrgWelcomeTour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.body.className = "";
  });

  it("points the callout at the organization switcher after the sidebar settles", () => {
    const switcher = document.createElement("button");
    switcher.dataset.tourStep = "org-switcher";
    document.body.append(switcher);

    startOrgWelcomeTour("<b>Acme</b>", "group");
    expect(document.querySelector(".driver-popover")).toBeNull();
    vi.advanceTimersByTime(ORG_WELCOME_TOUR_DELAY_MS);

    const popover = document.querySelector(".driver-popover");
    expect(popover).not.toBeNull();
    expect(popover).toHaveClass("tour-popover");
    expect(popover!.querySelector(".driver-popover-title")!.textContent).toBe("Welcome to the <b>Acme</b> organization");
    expect(popover!.querySelector(".driver-popover-description strong")!.textContent).toBe("<b>Acme</b>");
    expect(popover!.querySelector(".driver-popover-next-btn")!.textContent).toBe("Got it");
  });

  it("does nothing when the switcher isn't in the page", () => {
    startOrgWelcomeTour("Acme", "group");
    vi.advanceTimersByTime(ORG_WELCOME_TOUR_DELAY_MS);

    expect(document.querySelector(".driver-popover")).toBeNull();
  });
});
