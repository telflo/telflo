import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectorDistribution, Configuration } from "@telflo/contracts";
import { ConfigurationsTable } from "./ConfigurationsTable.js";
import { ACME, CATALOGUE, CONTRIB_LABEL } from "~/test/collector-distributions.js";
import { COLLEAGUE_EMAIL, MEMBER_EMAIL, MEMBER_ID, MINE, ORPHANED, THEIRS } from "~/test/configurations.js";

/** By default every row may be deleted, as an admin's are, with the catalogue read. */
function renderTable(
  canDelete: (configuration: Configuration) => boolean = () => true,
  configurations: Configuration[] = [MINE, THEIRS, ORPHANED],
  distributions: CollectorDistribution[] | null = CATALOGUE,
) {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  render(
    <ConfigurationsTable
      configurations={configurations}
      currentUserId={MEMBER_ID}
      canDelete={canDelete}
      onOpen={onOpen}
      onDelete={onDelete}
      distributions={distributions}
    />,
  );
  return { onOpen, onDelete, user: userEvent.setup() };
}

/** The row whose name button is `name`. */
function row(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest("tr")!;
}

describe("ConfigurationsTable", () => {
  it("has the configurations columns, Status and Distribution among them, and headers that don't sort", () => {
    renderTable();

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Owner",
      "Status",
      "Distribution",
      "Created",
      "Updated",
      "Actions",
    ]);
    for (const header of screen.getAllByRole("columnheader")) {
      expect(within(header).queryByRole("button")).toBeNull();
    }
    // The header row and one row per configuration, in the order given.
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("shows the name, the description below it, the owner with (you) on the member's own, and both dates", () => {
    renderTable();
    const cells = within(row("Production Monitoring")).getAllByRole("cell");

    expect(cells[0]).toHaveTextContent("Production MonitoringCollects traces and metrics from production");
    expect(cells[1]).toHaveTextContent(`${MEMBER_EMAIL}(you)`);
    expect(cells[4]).toHaveTextContent(new Date(MINE.createdAt).toLocaleDateString());
    expect(cells[5]).toHaveTextContent(new Date(MINE.updatedAt).toLocaleDateString());
  });

  it("shows Draft (outline) or Published (info) in the Status column, the word alone", () => {
    renderTable();

    for (const [name, word, variantClass] of [
      ["Production Monitoring", "Draft", "border-border"],
      ["Staging Logs", "Published", "border-brand/25"],
      ["Left Behind", "Published", "border-brand/25"],
    ] as const) {
      const status = within(row(name)).getAllByRole("cell")[2]!;
      expect(status).toHaveTextContent(new RegExp(`^${word}$`));
      const badge = within(status).getByText(word);
      expect(badge).toHaveClass(variantClass);
      for (const attribute of badge.attributes) {
        expect(attribute.name).not.toMatch(/^(title|aria-label|data-)/);
      }
    }
  });

  it("shows someone else's email without (you), and no description line for none", () => {
    renderTable();
    const cells = within(row("Staging Logs")).getAllByRole("cell");

    expect(cells[0]).toHaveTextContent(/^Staging Logs$/);
    expect(cells[1]).toHaveTextContent(new RegExp(`^${COLLEAGUE_EMAIL}$`));
  });

  it("shows — for a creator whose account is gone", () => {
    renderTable();

    expect(within(row("Left Behind")).getAllByRole("cell")[1]).toHaveTextContent(/^—$/);
  });

  it("opens from the name, a button and not a link, and from Edit", async () => {
    const { onOpen, onDelete, user } = renderTable();
    expect(screen.queryByRole("link")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Staging Logs" }));
    await user.click(within(row("Staging Logs")).getByRole("button", { name: "Edit" }));

    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenNthCalledWith(1, THEIRS);
    expect(onOpen).toHaveBeenNthCalledWith(2, THEIRS);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("has Delete on every row it's allowed on, someone else's too (an admin's), and Delete doesn't open", async () => {
    const { onOpen, onDelete, user } = renderTable();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(3);

    await user.click(within(row("Left Behind")).getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledWith(ORPHANED, within(row("Left Behind")).getByRole("button", { name: "Delete" }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("has Delete only on the rows it's allowed on, and asks about each configuration", () => {
    const canDelete = vi.fn((configuration: Configuration) => configuration.id === MINE.id);
    renderTable(canDelete);

    expect(within(row("Production Monitoring")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(row("Staging Logs")).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(row("Left Behind")).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(row("Staging Logs")).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(canDelete).toHaveBeenCalledWith(THEIRS);
  });

  describe("the Distribution column", () => {
    it("renders each row's distribution as a compact tag: the mark and the short name", () => {
      renderTable(() => true, [MINE, { ...THEIRS, collectorDistribution: ACME.id }], [...CATALOGUE, ACME]);

      expect(screen.getByRole("columnheader", { name: "Distribution" })).toBeInTheDocument();
      const contrib = within(row("Production Monitoring")).getAllByRole("cell")[3]!;
      expect(contrib).toHaveTextContent(/^Otel Contrib$/);
      expect(within(contrib).getByTitle(/^Built for/).querySelector("svg")).not.toBeNull();
      // No short name of its own: the catalogue's label.
      expect(within(row("Staging Logs")).getAllByRole("cell")[3]).toHaveTextContent(/^Acme Collector$/);
    });

    // Every configuration has a distribution here, so the case left is one
    // the catalogue doesn't list.
    it("renders a distribution the catalogue doesn't list as its id, with the generic glyph", () => {
      renderTable(() => true, [{ ...MINE, collectorDistribution: "grafana-alloy" }]);

      const cell = within(row("Production Monitoring")).getAllByRole("cell")[3]!;
      expect(cell).toHaveTextContent(/^grafana-alloy$/);
      expect(within(cell).getByTitle("Built for grafana-alloy — chosen when this configuration was created.")).toBeInTheDocument();
      expect(cell.querySelector("svg")).not.toBeNull();
    });

    it("gives the tag fixed text for its tooltip, the catalogue's label in it, and puts no name or email in any attribute", () => {
      renderTable();

      for (const name of ["Production Monitoring", "Staging Logs", "Left Behind"]) {
        const cell = within(row(name)).getAllByRole("cell")[3]!;
        expect(within(cell).getByTitle(`Built for ${CONTRIB_LABEL} — chosen when this configuration was created.`)).toBeInTheDocument();
        for (const element of [cell, ...cell.querySelectorAll("*")]) {
          for (const attribute of element.attributes) {
            expect(attribute.value).not.toContain(name);
            expect(attribute.value).not.toContain(MEMBER_EMAIL);
            expect(attribute.value).not.toContain(COLLEAGUE_EMAIL);
          }
        }
      }
    });

    it("names the distribution by its id, with its mark, while the catalogue is unread", () => {
      renderTable(() => true, [MINE], null);

      const cell = within(row("Production Monitoring")).getAllByRole("cell")[3]!;
      expect(cell).toHaveTextContent(/^Otel Contrib$/);
      expect(within(cell).getByTitle("Built for otelcol-contrib — chosen when this configuration was created.")).toBeInTheDocument();
      expect(cell.querySelector('svg[aria-label="OpenTelemetry"]')).not.toBeNull();
    });
  });
});
