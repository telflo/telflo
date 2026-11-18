import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ConfigurationSyncCell,
  configurationSyncLegend,
  configurationSyncText,
  type DriftCounts,
} from "./ConfigurationSyncCell.js";

// The Configuration Sync column (D17a decisions 9 and 18, Preflight ruling 11).

const NONE: DriftCounts = { collectors: 0, inSync: 0, pending: 0, failed: 0, drifted: 0, unassigned: 0 };

function counts(overrides: Partial<DriftCounts>): DriftCounts {
  const merged = { ...NONE, ...overrides };
  return { ...merged, collectors: merged.inSync + merged.pending + merged.failed + merged.drifted + merged.unassigned };
}

describe("configurationSyncText", () => {
  it('is "all in sync" only when every collector is in sync', () => {
    expect(configurationSyncText(counts({ inSync: 5 }))).toBe("all in sync");
    // Nothing assigned is never "all in sync": the count.
    expect(configurationSyncText(counts({ unassigned: 3 }))).toBe("3 unassigned");
  });

  it("names the non-zero counts in a fixed order: failed, drifted, pending, unassigned, in sync", () => {
    expect(configurationSyncText(counts({ inSync: 5, unassigned: 4, pending: 3, drifted: 2, failed: 1 }))).toBe(
      "1 failed · 2 drifted · 3 pending · 4 unassigned · 5 in sync",
    );
    expect(configurationSyncText(counts({ failed: 1, inSync: 3 }))).toBe("1 failed · 3 in sync");
    expect(configurationSyncText(counts({ pending: 2 }))).toBe("2 pending");
  });

  it("counts every state in the legend, with what it means", () => {
    expect(configurationSyncLegend(counts({ inSync: 3, failed: 1 }))).toBe(
      "1 failed (failed to apply its configuration) · 0 drifted (running another configuration) · 0 pending (not running its configuration yet) · 0 unassigned (no configuration assigned) · 3 in sync (running its configuration)",
    );
  });
});

describe("ConfigurationSyncCell", () => {
  it('shows "all in sync" quietly', () => {
    render(<ConfigurationSyncCell summary={counts({ inSync: 5 })} />);
    expect(screen.getByText("all in sync")).toHaveClass("text-muted-foreground");
  });

  it("shows the counts in the warning colour when any collector isn't in sync, never a fraction", () => {
    const { container } = render(<ConfigurationSyncCell summary={counts({ failed: 1, inSync: 3 })} />);
    const text = screen.getByText("1 failed · 3 in sync");
    expect(text).toHaveClass("text-warn");
    expect(container.textContent).not.toMatch(/\d+\/\d+/);
  });

  it("puts the legend in screen-reader text and a tooltip, never a title", async () => {
    const summary = counts({ inSync: 1, drifted: 1 });
    const { container } = render(<ConfigurationSyncCell summary={summary} />);
    const legend = configurationSyncLegend(summary);
    expect(screen.getByText(`(${legend})`)).toHaveClass("sr-only");
    expect(container.querySelector("[title]")).toBeNull();

    const trigger = screen.getByText("1 drifted · 1 in sync");
    expect(trigger).toHaveAttribute("tabindex", "0");
    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(legend);
  });

  it('says "No collectors" for a fleet with none', () => {
    render(<ConfigurationSyncCell summary={NONE} />);
    expect(screen.getByText("No collectors")).toBeInTheDocument();
  });
});
