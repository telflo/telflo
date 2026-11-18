import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { FleetDetail } from "@telflo/contracts";
import { formatDateTime } from "~/lib/format.js";
import { expectNoAttributeHolds, fleetDetail } from "~/test/fleets.js";
import { FleetHeader, FleetNotFound } from "./FleetHeader.js";

// A fleet's page's header (D17a decision 19): the label and the actions
// render; an archived fleet shows Unarchive and Delete (decision 3); no
// configuration line (D17a has none). The header actions (D17c-1 decisions
// 13 and 44; Preflight rulings 19, 21 and 22): "Install collector" and the
// "Setup guide" toggle, passed by the route for an active server fleet only.

function renderHeader(fleet: FleetDetail, extra: Partial<Parameters<typeof FleetHeader>[0]> = {}) {
  const onAction = vi.fn();
  render(
    <MemoryRouter>
      <FleetHeader fleet={fleet} onAction={onAction} {...extra} />
    </MemoryRouter>,
  );
  return { onAction, user: userEvent.setup() };
}

describe("FleetHeader", () => {
  it.each([
    ["server", "active", "Supervisor", "Active"],
    ["server", "archived", "Supervisor", "Archived"],
    ["kubernetes-supervisor", "active", "K8s Supervisor", "Active"],
    ["kubernetes-supervisor", "archived", "K8s Supervisor", "Archived"],
  ] as const)("shows a %s fleet that is %s: the label as its heading, the type, the badge and Created", (type, status, typeWords, badge) => {
    const fleet = fleetDetail({ type, status });
    renderHeader(fleet);
    expect(screen.getByRole("heading", { level: 1, name: "edge-prod" })).toBeInTheDocument();
    expect(screen.getByText(typeWords)).toBeInTheDocument();
    expect(screen.getByText(badge)).toBeInTheDocument();
    expect(screen.queryByText(badge === "Active" ? "Archived" : "Active")).toBeNull();
    expect(screen.getByText(/^Created/)).toHaveTextContent(`Created ${formatDateTime(fleet.createdAt)}`);
  });

  it("offers Rename, Archive and Delete for an active fleet, each asking the page with the fleet and the button pressed", async () => {
    const fleet = fleetDetail();
    const { onAction, user } = renderHeader(fleet);

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("button", { name: "Unarchive" })).toBeNull();
    expect(onAction.mock.calls).toEqual([
      ["rename", fleet, screen.getByRole("button", { name: "Rename" })],
      ["archive", fleet, screen.getByRole("button", { name: "Archive" })],
      ["delete", fleet, screen.getByRole("button", { name: "Delete" })],
    ]);
  });

  it("offers Rename, Unarchive and Delete for an archived fleet", async () => {
    const fleet = fleetDetail({ status: "archived" });
    const { onAction, user } = renderHeader(fleet);

    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(onAction.mock.calls).toEqual([
      ["unarchive", fleet, screen.getByRole("button", { name: "Unarchive" })],
      ["delete", fleet, screen.getByRole("button", { name: "Delete" })],
    ]);
  });

  it("offers no Install collector and no Setup guide unless the route passes them", () => {
    renderHeader(fleetDetail());
    expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Setup guide" })).toBeNull();
  });

  it("offers Install collector before Rename, asking the route with the button pressed", async () => {
    const onInstall = vi.fn();
    const { user } = renderHeader(fleetDetail(), { onInstall });
    const install = screen.getByRole("button", { name: "Install collector" });
    expect(screen.getAllByRole("button").map((each) => each.textContent)).toEqual(["Install collector", "Rename", "Archive", "Delete"]);
    await user.click(install);
    expect(onInstall).toHaveBeenCalledWith(install);
  });

  // D17d-2 decision 23; Preflight ruling 28.
  it("offers a Kubernetes-supervisor fleet's Install with Helm before Rename, asking the route with the button pressed", async () => {
    const onInstall = vi.fn();
    const { user } = renderHeader(fleetDetail({ type: "kubernetes-supervisor" }), { onInstall });
    const install = screen.getByRole("button", { name: "Install with Helm" });
    expect(screen.getAllByRole("button").map((each) => each.textContent)).toEqual(["Install with Helm", "Rename", "Archive", "Delete"]);
    await user.click(install);
    expect(onInstall).toHaveBeenCalledWith(install);
  });

  it("offers Setup guide first, a toggle whose aria-pressed follows it, with no title", async () => {
    const onToggle = vi.fn();
    const { user } = renderHeader(fleetDetail(), { onInstall: vi.fn(), setupGuide: { open: false, onToggle } });
    const toggle = screen.getByRole("button", { name: "Setup guide" });
    expect(screen.getAllByRole("button").map((each) => each.textContent)).toEqual(["Setup guide", "Install collector", "Rename", "Archive", "Delete"]);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toHaveAttribute("title");
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows Setup guide pressed while the checklist is open", () => {
    renderHeader(fleetDetail(), { setupGuide: { open: true, onToggle: vi.fn() } });
    expect(screen.getByRole("button", { name: "Setup guide" })).toHaveAttribute("aria-pressed", "true");
  });

  it("holds the label in no attribute (decision 29)", () => {
    const canary = "canary-label-7e2a";
    renderHeader(fleetDetail({ label: canary }), { onInstall: vi.fn(), setupGuide: { open: true, onToggle: vi.fn() } });
    expect(document.body.textContent).toContain(canary);
    expectNoAttributeHolds(canary);
  });
});

describe("FleetNotFound", () => {
  it("says the fleet may have been deleted, with the back link to the list", () => {
    render(
      <MemoryRouter>
        <FleetNotFound />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Fleet not found" })).toBeInTheDocument();
    expect(screen.getByText("It may have been deleted, or you may not have access.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fleets" })).toHaveAttribute("href", "/fleet-management");
  });
});
