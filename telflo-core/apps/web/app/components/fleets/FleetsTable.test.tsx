import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { FleetDetail, FleetSummary } from "@telflo/contracts";
import { formatDateTime } from "~/lib/format.js";
import {
  EMPTY_SUMMARY,
  expectNoAttributeHolds,
  expectNoAttributeHoldsInOpenTooltips,
  FLEET_ID,
  fleetDetail,
  populatedSummary,
} from "~/test/fleets.js";
import { FleetsTable } from "./FleetsTable.js";
import { ARCHIVED_TOOLTIP } from "./TokenCell.js";

// The fleet list's table (D17a decision 18, Preflight ruling 11): Type after
// Fleet, Online before the sync column, the online count and legend, the
// sync column's words, "No collectors" in both, and the Token badge's link.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const OTHER_ID = "4e5f6071-8293-44a5-bb6c-7d8e9fa0b1c2";

function summary(overrides: Partial<FleetSummary>): FleetSummary {
  return { ...EMPTY_SUMMARY, ...overrides };
}

function renderTable(fleets: FleetDetail[], onAction = vi.fn()) {
  const view = render(
    <MemoryRouter>
      <FleetsTable fleets={fleets} now={NOW} onAction={onAction} />
    </MemoryRouter>,
  );
  return { ...view, onAction };
}

function rowOf(label: string): HTMLElement {
  return screen.getByRole("link", { name: label }).closest("tr") as HTMLElement;
}

describe("FleetsTable's columns", () => {
  it("has its columns in order, plain headers that don't sort, Type right after Fleet and Online right before Configuration Sync", () => {
    renderTable([fleetDetail()]);
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers).toEqual(["Fleet", "Type", "Online", "Configuration Sync", "Token", "Last Seen", "Actions"]);
    expect(within(screen.getAllByRole("row")[0]!).queryByRole("button")).toBeNull();
  });

  it("keeps the API's order, newest first", () => {
    renderTable([fleetDetail({ label: "newest" }), fleetDetail({ id: OTHER_ID, label: "older" })]);
    expect(screen.getAllByRole("link", { name: /newest|older/ }).map((link) => link.textContent)).toEqual(["newest", "older"]);
  });

  it("links the fleet's label to its page, by id", () => {
    renderTable([fleetDetail()]);
    expect(screen.getByRole("link", { name: "edge-prod" })).toHaveAttribute("href", `/fleet-management/${FLEET_ID}`);
  });

  it("marks an archived fleet, and only an archived one", () => {
    renderTable([fleetDetail({ status: "archived" }), fleetDetail({ id: OTHER_ID, label: "edge-dev" })]);
    expect(within(rowOf("edge-prod")).getByText("Archived")).toBeInTheDocument();
    expect(within(rowOf("edge-dev")).queryByText("Archived")).toBeNull();
  });

  // No Bridge (D16a decision 1).
  it.each([
    ["server", "Supervisor"],
    ["kubernetes-supervisor", "K8s Supervisor"],
  ] as const)("labels a %s fleet %s", (type, label) => {
    renderTable([fleetDetail({ type })]);
    expect(within(rowOf("edge-prod")).getByText(label)).toBeInTheDocument();
  });

  it('shows "No collectors" in Online and Configuration Sync, "—" for Last Seen, for a fleet with none', () => {
    renderTable([fleetDetail()]);
    const row = rowOf("edge-prod");
    expect(within(row).getAllByText("No collectors")).toHaveLength(2);
    const cells = within(row).getAllByRole("cell");
    expect(cells[5]).toHaveTextContent(/^—$/);
  });

  it("shows some of each liveness and drift as the summary counts them", () => {
    renderTable([
      fleetDetail({
        summary: summary({
          collectors: 10,
          online: 4,
          warning: 3,
          unknown: 2,
          offline: 1,
          inSync: 4,
          pending: 3,
          failed: 1,
          drifted: 1,
          unassigned: 1,
          lastSeenAt: new Date(NOW - 5_000).toISOString(),
        }),
      }),
    ]);
    const cells = within(rowOf("edge-prod")).getAllByRole("cell");
    expect(within(cells[2]!).getByText("4/10")).toBeInTheDocument();
    expect(within(cells[3]!).getByText("1 failed · 1 drifted · 3 pending · 1 unassigned · 4 in sync")).toBeInTheDocument();
    expect(within(cells[5]!).getByText("5 seconds ago")).toBeInTheDocument();
  });

  it("reads the Token badge and Last Seen at the time it is given", () => {
    renderTable([
      fleetDetail({
        summary: summary({
          collectors: 1,
          online: 1,
          inSync: 1,
          lastSeenAt: new Date(NOW - 3 * 60_000).toISOString(),
          rotateToken: { expiresAt: new Date(NOW + 20 * 86_400_000).toISOString(), graceEndsAt: null, validCount: 1 },
        }),
      }),
    ]);
    const cells = within(rowOf("edge-prod")).getAllByRole("cell");
    expect(within(cells[3]!).getByText("all in sync")).toBeInTheDocument();
    expect(within(cells[4]!).getByRole("link", { name: "20d left (open the Tokens tab)" })).toHaveAttribute(
      "href",
      `/fleet-management/${FLEET_ID}?tab=tokens`,
    );
    expect(within(cells[5]!).getByText("3 minutes ago")).toBeInTheDocument();
  });

  it.each([
    ["Suspended", null],
    ["Never", { expiresAt: null, graceEndsAt: null, validCount: 1 }],
  ] as const)("shows a %s token", (label, rotateToken) => {
    renderTable([fleetDetail({ summary: summary({ rotateToken }) })]);
    expect(within(rowOf("edge-prod")).getByRole("link", { name: `${label} (open the Tokens tab)` })).toBeInTheDocument();
  });

  it("gives the Token cell the fleet's status: an archived fleet's tooltip says it is archived, an active one's doesn't", async () => {
    renderTable([fleetDetail({ status: "archived" }), fleetDetail({ id: OTHER_ID, label: "edge-dev" })]);
    act(() => within(within(rowOf("edge-prod")).getAllByRole("cell")[4]!).getByRole("link").focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(ARCHIVED_TOOLTIP);
    act(() => within(within(rowOf("edge-dev")).getAllByRole("cell")[4]!).getByRole("link").focus());
    await waitFor(() => expect(screen.getByRole("tooltip")).not.toHaveTextContent(ARCHIVED_TOOLTIP));
  });

  it("shows Last Seen's full time as tooltip text, never a title", async () => {
    const lastSeenAt = new Date(NOW - 2 * 86_400_000).toISOString();
    renderTable([fleetDetail({ summary: summary({ collectors: 1, offline: 1, pending: 1, lastSeenAt }) })]);
    const relative = screen.getByText("2 days ago");
    expect(relative).not.toHaveAttribute("title");
    act(() => relative.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(formatDateTime(lastSeenAt));
  });
});

describe("FleetsTable's row actions (decision 29)", () => {
  it("names each button for its fleet through aria-labelledby, with a fixed title", () => {
    renderTable([fleetDetail(), fleetDetail({ id: OTHER_ID, label: "edge-dev", status: "archived" })]);

    const active = within(rowOf("edge-prod"));
    expect(active.getByRole("button", { name: "Rename edge-prod" })).toHaveAttribute("title", "Rename");
    expect(active.getByRole("button", { name: "Archive edge-prod" })).toHaveAttribute("title", "Archive");
    expect(active.getByRole("button", { name: "Delete edge-prod" })).toHaveAttribute("title", "Delete");
    expect(active.queryByRole("button", { name: /Unarchive/ })).toBeNull();

    const archived = within(rowOf("edge-dev"));
    expect(archived.getByRole("button", { name: "Unarchive edge-dev" })).toHaveAttribute("title", "Unarchive");
    expect(archived.queryByRole("button", { name: /^Archive/ })).toBeNull();
    for (const button of [...active.getAllByRole("button"), ...archived.getAllByRole("button")]) {
      expect(button).not.toHaveAttribute("aria-label");
      expect(button.getAttribute("aria-labelledby")).not.toMatch(/edge/);
    }
  });

  it("asks the page for each action, with its fleet and the button pressed", async () => {
    const user = userEvent.setup();
    const archivedFleet = fleetDetail({ id: OTHER_ID, label: "edge-dev", status: "archived" });
    const activeFleet = fleetDetail();
    const { onAction } = renderTable([activeFleet, archivedFleet]);

    await user.click(screen.getByRole("button", { name: "Rename edge-prod" }));
    await user.click(screen.getByRole("button", { name: "Archive edge-prod" }));
    await user.click(screen.getByRole("button", { name: "Delete edge-prod" }));
    await user.click(screen.getByRole("button", { name: "Unarchive edge-dev" }));

    expect(onAction.mock.calls).toEqual([
      ["rename", activeFleet, screen.getByRole("button", { name: "Rename edge-prod" })],
      ["archive", activeFleet, screen.getByRole("button", { name: "Archive edge-prod" })],
      ["delete", activeFleet, screen.getByRole("button", { name: "Delete edge-prod" })],
      ["unarchive", archivedFleet, screen.getByRole("button", { name: "Unarchive edge-dev" })],
    ]);
  });

  it("holds the fleet's label in no attribute, every cell's tooltip trigger there and each tooltip open in turn (decision 29: replay can't mask one)", async () => {
    const canary = "canary-label-5d1f";
    const { container } = renderTable([
      fleetDetail({ label: canary, summary: populatedSummary(NOW) }),
      fleetDetail({ id: OTHER_ID, label: `${canary}-archived`, status: "archived", summary: populatedSummary(NOW) }),
    ]);
    expect(container.textContent).toContain(canary);
    expectNoAttributeHolds(canary);
    // Online, Configuration Sync, Token and Last Seen, in both rows: every tooltip opened and scanned.
    expect(await expectNoAttributeHoldsInOpenTooltips(canary, container)).toBe(8);
  });
});
