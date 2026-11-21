import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { FleetDetail, FleetRotateToken, FleetSummary } from "@telflo/contracts";
import { formatDateTime } from "~/lib/format.js";
import { EMPTY_SUMMARY, FLEET_ID, fleetDetail, populatedSummary } from "~/test/fleets.js";
import { onlineEmphasis, StatsStrip, versionDriftCount, versionDriftHint } from "./StatsStrip.js";
import { ARCHIVED_TOOLTIP, SUSPENDED_TOOLTIP } from "./TokenCell.js";

// A server fleet's stats strip: the server tiles, from the fleet's
// summary.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function summary(overrides: Partial<FleetSummary>): FleetSummary {
  return { ...EMPTY_SUMMARY, ...overrides };
}

function renderStrip(fleet: FleetDetail) {
  return render(
    <MemoryRouter>
      <StatsStrip fleet={fleet} now={NOW} />
    </MemoryRouter>,
  );
}

/** A tile by its label: its value and hint. */
function tile(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

function valueOf(label: string): HTMLElement {
  return tile(label).children[1] as HTMLElement;
}

describe("StatsStrip", () => {
  it("shows the server tiles in order: Collectors, Online, Version drift, Token expires", () => {
    const { container } = renderStrip(fleetDetail());
    const labels = [...(container.firstElementChild as HTMLElement).children].map((each) => each.firstElementChild?.textContent);
    expect(labels).toEqual(["Collectors", "Online", "Version drift", "Token expires"]);
  });

  it("shows an empty fleet's: no collectors, none online (neutral), no drift, a token that never expires", () => {
    renderStrip(fleetDetail());
    expect(valueOf("Collectors")).toHaveTextContent(/^0$/);
    expect(valueOf("Online")).toHaveTextContent(/^0$/);
    expect(valueOf("Online")).toHaveClass("text-foreground");
    expect(within(tile("Online")).getByText("Last minute")).toBeInTheDocument();
    expect(valueOf("Version drift")).toHaveTextContent(/^0$/);
    expect(valueOf("Version drift")).toHaveClass("text-foreground");
    expect(within(tile("Version drift")).getByText("All up to date")).toBeInTheDocument();
    expect(within(tile("Token expires")).getByText("Never")).toBeInTheDocument();
  });

  it("shows a mixed fleet's: the counts, some offline in the warning color, pending, failed and drifted as lagging", () => {
    renderStrip(fleetDetail({ summary: populatedSummary(NOW) }));
    expect(valueOf("Collectors")).toHaveTextContent(/^10$/);
    expect(valueOf("Online")).toHaveTextContent(/^4$/);
    expect(valueOf("Online")).toHaveClass("text-warn");
    // 3 pending, 1 failed and 1 drifted; the unassigned one and the four in sync aren't lagging.
    expect(valueOf("Version drift")).toHaveTextContent(/^5$/);
    expect(valueOf("Version drift")).toHaveClass("text-warn");
    expect(within(tile("Version drift")).getByText("Collectors lagging")).toBeInTheDocument();
    expect(within(tile("Token expires")).getByText("20d left")).toBeInTheDocument();
    expect(within(tile("Token expires")).getByText("Rotating →")).toBeInTheDocument();
  });

  it("colors Online danger with collectors and none online", () => {
    renderStrip(fleetDetail({ summary: summary({ collectors: 3, offline: 3 }) }));
    expect(valueOf("Online")).toHaveClass("text-fail");
  });

  it.each([
    [summary({ collectors: 3, online: 3 }), "neutral"],
    [summary({ collectors: 3, online: 1, warning: 2 }), "warn"],
    [summary({ collectors: 3, unknown: 3 }), "danger"],
    [summary({}), "neutral"],
  ] as const)("reckons Online's emphasis (%#)", (counts, emphasis) => {
    expect(onlineEmphasis(counts)).toBe(emphasis);
  });

  it("counts pending, failed and drifted as drift, never unassigned or in sync", () => {
    expect(versionDriftCount(summary({ pending: 2, failed: 3, drifted: 4, unassigned: 5, inSync: 6 }))).toBe(9);
  });

  it("shows a fleet with every collector online and in sync as neutral and up to date", () => {
    renderStrip(fleetDetail({ summary: summary({ collectors: 2, online: 2, inSync: 2 }) }));
    expect(valueOf("Online")).toHaveClass("text-foreground");
    expect(within(tile("Version drift")).getByText("All up to date")).toBeInTheDocument();
  });

  it("says how many have nothing assigned when none lags, in place of up to date", () => {
    renderStrip(fleetDetail({ summary: summary({ collectors: 3, online: 3, unassigned: 3 }) }));
    expect(valueOf("Version drift")).toHaveTextContent(/^0$/);
    expect(valueOf("Version drift")).toHaveClass("text-foreground");
    expect(within(tile("Version drift")).getByText("3 with nothing assigned")).toBeInTheDocument();
    expect(within(tile("Version drift")).queryByText("All up to date")).toBeNull();
  });

  it.each([
    ["Collectors lagging", summary({ pending: 1, unassigned: 2 })],
    ["Collectors lagging", summary({ drifted: 1 })],
    ["1 with nothing assigned", summary({ inSync: 2, unassigned: 1 })],
    ["4 with nothing assigned", summary({ unassigned: 4 })],
    ["All up to date", summary({ inSync: 2 })],
    ["All up to date", summary({})],
  ] as const)("reckons Version drift's hint: %s (%#)", (hint, counts) => {
    expect(versionDriftHint(counts)).toBe(hint);
  });

  describe("Token expires: the Token badge and tooltip, a link to the fleet's Tokens tab", () => {
    /** The tile's trigger: the link to the Tokens tab, its tooltip opened by focusing it. */
    function trigger(): HTMLElement {
      return within(tile("Token expires")).getByRole("link");
    }

    async function tooltipOf(): Promise<HTMLElement> {
      act(() => trigger().focus());
      return screen.findByRole("tooltip");
    }

    function rotate(overrides: Partial<FleetRotateToken>): FleetSummary {
      return summary({ rotateToken: { expiresAt: null, graceEndsAt: null, validCount: 1, ...overrides } });
    }

    it.each([
      ["Suspended", summary({ rotateToken: null }), "text-muted-foreground"],
      ["Never", rotate({}), "bg-secondary"],
      ["<1d left", rotate({ expiresAt: new Date(NOW + DAY / 2).toISOString() }), "text-fail"],
      ["3d left", rotate({ expiresAt: new Date(NOW + 3 * DAY).toISOString() }), "text-fail"],
      ["20d left", rotate({ expiresAt: new Date(NOW + 20 * DAY).toISOString() }), "text-warn"],
      ["45d", rotate({ expiresAt: new Date(NOW + 45 * DAY).toISOString() }), "text-ok"],
      ["6mo", rotate({ expiresAt: new Date(NOW + 180 * DAY).toISOString() }), "text-ok"],
      ["1y", rotate({ expiresAt: new Date(NOW + 400 * DAY).toISOString() }), "text-ok"],
    ] as const)("shows %s in its color, linking to the fleet's Tokens tab", (label, counts, colour) => {
      renderStrip(fleetDetail({ summary: counts }));
      expect(within(tile("Token expires")).getByText(label)).toHaveClass(colour);
      expect(screen.getAllByRole("link")).toEqual([trigger()]);
      expect(trigger()).toHaveAttribute("href", `/fleet-management/${FLEET_ID}?tab=tokens`);
      expect(trigger()).toHaveTextContent(label);
    });

    it("says the valid count, the expiry and the grace in its tooltip, never in a title", async () => {
      const expiresAt = new Date(NOW + 20 * DAY).toISOString();
      const graceEndsAt = new Date(NOW + 2 * DAY).toISOString();
      const { container } = renderStrip(fleetDetail({ summary: rotate({ expiresAt, graceEndsAt, validCount: 2 }) }));
      expect(container.querySelector("[title]")).toBeNull();
      const tooltip = await tooltipOf();
      expect(tooltip).toHaveTextContent("2 valid rotate tokens");
      expect(tooltip).toHaveTextContent(`Current one expires ${formatDateTime(expiresAt)}`);
      expect(tooltip).toHaveTextContent(`Grace ends ${formatDateTime(graceEndsAt)}`);
    });

    it("says a Suspended fleet's words", async () => {
      renderStrip(fleetDetail({ summary: summary({ rotateToken: null }) }));
      expect(await tooltipOf()).toHaveTextContent(SUSPENDED_TOOLTIP);
    });

    it("says an archived fleet's collectors are refused, in place of the grace line", async () => {
      const graceEndsAt = new Date(NOW + 2 * DAY).toISOString();
      renderStrip(fleetDetail({ status: "archived", summary: rotate({ graceEndsAt, validCount: 2 }) }));
      const tooltip = await tooltipOf();
      expect(tooltip).toHaveTextContent(ARCHIVED_TOOLTIP);
      expect(tooltip).not.toHaveTextContent("Grace ends");
    });
  });
});
