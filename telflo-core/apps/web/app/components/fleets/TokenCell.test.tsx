import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { FleetRotateToken, FleetStatus } from "@telflo/contracts";
import { formatDateTime } from "~/lib/format.js";
import { FLEET_ID } from "~/test/fleets.js";
import { ARCHIVED_TOOLTIP, expiryBucket, SUSPENDED_TOOLTIP, TOKEN_LINK_SUFFIX, TokenCell, tokenBucket, tokenTooltipLines } from "./TokenCell.js";

// The Token column (D17a decision 21, Preflight rulings 4 and 12).

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

/** A rotate token expiring `ms` after NOW. */
function expiringIn(ms: number, overrides: Partial<FleetRotateToken> = {}): FleetRotateToken {
  return { expiresAt: new Date(NOW + ms).toISOString(), graceEndsAt: null, validCount: 1, ...overrides };
}

function renderCell(rotateToken: FleetRotateToken | null, status: FleetStatus = "active") {
  return render(
    <MemoryRouter>
      <TokenCell fleetId={FLEET_ID} rotateToken={rotateToken} status={status} now={NOW} />
    </MemoryRouter>,
  );
}

describe("tokenBucket (Preflight ruling 12)", () => {
  it("is Suspended (outline) with no valid rotate token, and Never (secondary) for one that never expires", () => {
    expect(tokenBucket(null, NOW)).toEqual({ variant: "outline", label: "Suspended" });
    expect(tokenBucket({ expiresAt: null, graceEndsAt: null, validCount: 1 }, NOW)).toEqual({ variant: "secondary", label: "Never" });
  });

  it.each([
    ["past its expiry at render (the poll's lag)", -SECOND, "destructive", "<1d left"],
    ["1 day less a second", DAY - SECOND, "destructive", "<1d left"],
    ["1 day", DAY, "destructive", "1d left"],
    ["7 days less a second", 7 * DAY - SECOND, "destructive", "6d left"],
    ["7 days", 7 * DAY, "warning", "7d left"],
    ["30 days less a second", 30 * DAY - SECOND, "warning", "29d left"],
    ["30 days", 30 * DAY, "success", "30d"],
    ["60 days less a second", 60 * DAY - SECOND, "success", "59d"],
    ["60 days", 60 * DAY, "success", "2mo"],
    ["75 days", 75 * DAY, "success", "3mo"],
    ["344 days", 344 * DAY, "success", "11mo"],
    ["345 days less a second", 345 * DAY - SECOND, "success", "11mo"],
    ["345 days", 345 * DAY, "success", "1y"],
    ["547 days", 547 * DAY, "success", "1y"],
    ["548 days", 548 * DAY, "success", "2y"],
    // Each create preset (Task 5), read 2 s after it was made.
    ["180 days less 2 s (the preset)", 180 * DAY - 2 * SECOND, "success", "6mo"],
    ["1 year less 2 s (the preset)", 365 * DAY - 2 * SECOND, "success", "1y"],
    ["2 years less 2 s (the preset)", 730 * DAY - 2 * SECOND, "success", "2y"],
  ] as const)("reads a token expiring in %s as %s %s", (_when, ms, variant, label) => {
    expect(tokenBucket(expiringIn(ms), NOW)).toEqual({ variant, label });
  });
});

describe("expiryBucket (D17b-2 decision 26, Preflight ruling 12)", () => {
  it("is Never (secondary) for no expiry, and never Suspended", () => {
    expect(expiryBucket(null, NOW)).toEqual({ variant: "secondary", label: "Never" });
  });

  it.each([
    [-SECOND, "destructive", "<1d left"],
    [DAY - SECOND, "destructive", "<1d left"],
    [3 * DAY, "destructive", "3d left"],
    [7 * DAY, "warning", "7d left"],
    [29 * DAY, "warning", "29d left"],
    [45 * DAY, "success", "45d"],
    [180 * DAY, "success", "6mo"],
    [400 * DAY, "success", "1y"],
  ] as const)("reads an expiry %s ms away as %s %s, as tokenBucket reads the fleet's current token", (ms, variant, label) => {
    const expiresAt = new Date(NOW + ms).toISOString();
    expect(expiryBucket(expiresAt, NOW)).toEqual({ variant, label });
    expect(tokenBucket(expiringIn(ms), NOW)).toEqual(expiryBucket(expiresAt, NOW));
  });
});

describe("tokenTooltipLines (Preflight rulings 4 and 12)", () => {
  it("says the valid count and the current token's expiry", () => {
    const expiresAt = new Date(NOW + 90 * DAY).toISOString();
    expect(tokenTooltipLines({ expiresAt, graceEndsAt: null, validCount: 1 }, "active")).toEqual([
      "1 valid rotate token",
      `Current one expires ${formatDateTime(expiresAt)}`,
    ]);
    expect(tokenTooltipLines({ expiresAt: null, graceEndsAt: null, validCount: 1 }, "active")).toEqual([
      "1 valid rotate token",
      "Current one never expires",
    ]);
  });

  it("says when the grace ends while a replaced token is in it", () => {
    const graceEndsAt = new Date(NOW + 30 * DAY).toISOString();
    expect(tokenTooltipLines({ expiresAt: null, graceEndsAt, validCount: 2 }, "active")).toEqual([
      "2 valid rotate tokens",
      "Current one never expires",
      `Grace ends ${formatDateTime(graceEndsAt)}: collectors on the replaced token move to the current one on their next poll.`,
    ]);
  });

  it("says what a Suspended fleet's collectors meet, not a no-op stub", () => {
    expect(tokenTooltipLines(null, "active")).toEqual([SUSPENDED_TOOLTIP]);
    expect(SUSPENDED_TOOLTIP).toBe(
      "No valid rotate token: collectors on a valid default token still connect but get no configuration, and collectors on a revoked or expired rotate token are refused.",
    );
  });

  // The final review's Minor: the agent endpoint refuses an archived fleet's
  // every collector (403, or 401 for a dead token), so neither the Suspended words nor the grace's
  // move to the current token is true of it; the factual lines stay.
  describe("for an archived fleet", () => {
    it("says its collectors are refused in place of the Suspended words", () => {
      expect(tokenTooltipLines(null, "archived")).toEqual([ARCHIVED_TOOLTIP]);
      expect(ARCHIVED_TOOLTIP).toBe("Archived: its collectors are refused whatever their token.");
    });

    it("says so in place of the grace line, keeping the valid count and the expiry", () => {
      const expiresAt = new Date(NOW + 90 * DAY).toISOString();
      const graceEndsAt = new Date(NOW + 30 * DAY).toISOString();
      expect(tokenTooltipLines({ expiresAt, graceEndsAt, validCount: 2 }, "archived")).toEqual([
        "2 valid rotate tokens",
        `Current one expires ${formatDateTime(expiresAt)}`,
        ARCHIVED_TOOLTIP,
      ]);
    });

    it("says so after a dated token's valid count and expiry", () => {
      const expiresAt = new Date(NOW + 90 * DAY).toISOString();
      expect(tokenTooltipLines({ expiresAt, graceEndsAt: null, validCount: 1 }, "archived")).toEqual([
        "1 valid rotate token",
        `Current one expires ${formatDateTime(expiresAt)}`,
        ARCHIVED_TOOLTIP,
      ]);
      expect(tokenTooltipLines({ expiresAt: null, graceEndsAt: null, validCount: 1 }, "archived")).toEqual([
        "1 valid rotate token",
        "Current one never expires",
        ARCHIVED_TOOLTIP,
      ]);
    });
  });
});

describe("TokenCell", () => {
  // One route for every type (decision 7).
  it("links the badge to the fleet's Tokens tab, its name saying where it goes (Ruling 25)", () => {
    renderCell(expiringIn(400 * DAY));
    expect(screen.getByRole("link", { name: "1y (open the Tokens tab)" })).toHaveAttribute("href", `/fleet-management/${FLEET_ID}?tab=tokens`);
    expect(TOKEN_LINK_SUFFIX).toBe(" (open the Tokens tab)");
  });

  it.each([
    [null, "Suspended", "text-muted-foreground"],
    [{ expiresAt: null, graceEndsAt: null, validCount: 1 }, "Never", "bg-secondary"],
    [expiringIn(3 * DAY), "3d left", "text-fail"],
    [expiringIn(20 * DAY), "20d left", "text-warn"],
    [expiringIn(400 * DAY), "1y", "text-ok"],
  ] as const)("shows the bucket's badge in its colour (%#)", (rotateToken, label, colour) => {
    renderCell(rotateToken);
    expect(screen.getByText(label)).toHaveClass(colour);
    expect(screen.queryByText("Rotating →")).toBeNull();
  });

  it("shows Rotating beside the badge while a replaced token is in its grace", () => {
    renderCell({ expiresAt: null, graceEndsAt: new Date(NOW + 30 * DAY).toISOString(), validCount: 2 });
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.getByText("Rotating →")).toHaveClass("text-brand");
  });

  it("puts its lines in a tooltip, as text, never a title", async () => {
    const graceEndsAt = new Date(NOW + 30 * DAY).toISOString();
    const { container } = renderCell({ expiresAt: null, graceEndsAt, validCount: 2 });
    expect(container.querySelector("[title]")).toBeNull();

    act(() => screen.getByRole("link").focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("2 valid rotate tokens");
    expect(tooltip).toHaveTextContent("Current one never expires");
    expect(tooltip).toHaveTextContent(`Grace ends ${formatDateTime(graceEndsAt)}`);
  });

  it("says a Suspended fleet's words in its tooltip", async () => {
    renderCell(null);
    act(() => screen.getByRole("link").focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(SUSPENDED_TOOLTIP);
  });

  it("keeps an archived Suspended fleet's badge and says only that it is archived", async () => {
    renderCell(null, "archived");
    expect(screen.getByText("Suspended")).toHaveClass("text-muted-foreground");
    act(() => screen.getByRole("link").focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(ARCHIVED_TOOLTIP);
    expect(tooltip).not.toHaveTextContent(SUSPENDED_TOOLTIP);
  });

  it("keeps an archived fleet's badges in its grace, its tooltip archived in place of the grace line", async () => {
    const graceEndsAt = new Date(NOW + 30 * DAY).toISOString();
    renderCell({ expiresAt: new Date(NOW + 400 * DAY).toISOString(), graceEndsAt, validCount: 2 }, "archived");
    expect(screen.getByText("1y")).toHaveClass("text-ok");
    expect(screen.getByText("Rotating →")).toBeInTheDocument();
    act(() => screen.getByRole("link").focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("2 valid rotate tokens");
    expect(tooltip).toHaveTextContent(ARCHIVED_TOOLTIP);
    expect(tooltip).not.toHaveTextContent("Grace ends");
  });

  it("keeps an archived fleet's dated badge, its tooltip ending archived", async () => {
    const expiresAt = new Date(NOW + 20 * DAY).toISOString();
    renderCell({ expiresAt, graceEndsAt: null, validCount: 1 }, "archived");
    expect(screen.getByText("20d left")).toHaveClass("text-warn");
    act(() => screen.getByRole("link").focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(`1 valid rotate tokenCurrent one expires ${formatDateTime(expiresAt)}${ARCHIVED_TOOLTIP}`);
  });
});
