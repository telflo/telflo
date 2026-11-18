import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OnlineBar, onlineLegend, type LivenessCounts } from "./OnlineBar.js";

// The Online column (D17a decisions 9 and 18, Preflight ruling 11).

const SOME: LivenessCounts = { collectors: 10, online: 4, warning: 3, unknown: 2, offline: 1 };
const LEGEND =
  "4 online (seen in the last minute) · 3 warning (1–2 minutes) · 2 unknown (2–5 minutes) · 1 offline (over 5 minutes)";

describe("OnlineBar", () => {
  it("says each count with its window", () => {
    expect(onlineLegend(SOME)).toBe(LEGEND);
  });

  // The legend is text, not a title.
  it("shows {online}/{collectors}, the legend as screen-reader text, and four hidden segments sized by their counts", () => {
    const { container } = render(<OnlineBar summary={SOME} />);
    expect(screen.getByText("4/10")).toBeInTheDocument();
    expect(screen.getByText(LEGEND)).toHaveClass("sr-only");
    expect(container.querySelector("[title]")).toBeNull();

    const bar = container.querySelector('[aria-hidden="true"]');
    const widths = [...(bar?.children ?? [])].map((segment) => (segment as HTMLElement).style.width);
    expect(widths).toEqual(["40%", "30%", "20%", "10%"]);
    expect([...(bar?.children ?? [])].map((segment) => segment.className.split(" ")[0])).toEqual([
      "bg-ok",
      "bg-warn",
      "bg-muted-foreground/40",
      "bg-fail",
    ]);
  });

  it("shows the legend as tooltip text on a focusable trigger", async () => {
    render(<OnlineBar summary={SOME} />);
    const trigger = screen.getByText("4/10").parentElement as HTMLElement;
    expect(trigger).toHaveAttribute("tabindex", "0");

    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(LEGEND);
  });

  it('says "No collectors" for a fleet with none', () => {
    render(<OnlineBar summary={{ collectors: 0, online: 0, warning: 0, unknown: 0, offline: 0 }} />);
    expect(screen.getByText("No collectors")).toBeInTheDocument();
    expect(screen.queryByText("0/0")).toBeNull();
  });
});
