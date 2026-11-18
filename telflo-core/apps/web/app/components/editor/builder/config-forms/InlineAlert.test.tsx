import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InlineAlert } from "./InlineAlert.js";

describe("InlineAlert", () => {
  it("draws the info box by default, with an optional title", () => {
    render(<InlineAlert>Body text</InlineAlert>);
    const body = screen.getByText("Body text");
    expect(body).toHaveClass("text-xs", "text-muted-foreground");
    expect(body).not.toHaveClass("mt-1");
    expect(body.parentElement).toHaveClass("rounded-md", "border", "px-3", "py-2", "border-border", "bg-muted/50");
  });

  it.each([
    ["warn", "border-warn/25", "bg-warn-soft", "text-warn"],
    ["fail", "border-fail/25", "bg-fail-soft", "text-fail"],
  ] as const)("draws the %s variant with its title", (variant, border, background, color) => {
    render(
      <InlineAlert variant={variant} title="Zero timeout" className="mt-2">
        Batches are sent only when full.
      </InlineAlert>,
    );
    const title = screen.getByText("Zero timeout");
    expect(title).toHaveClass("text-xs", "font-medium", color);
    expect(title.parentElement).toHaveClass(border, background, "mt-2");
    expect(screen.getByText("Batches are sent only when full.")).toHaveClass("mt-1", color);
  });
});
