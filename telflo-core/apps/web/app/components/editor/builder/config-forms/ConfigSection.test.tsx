import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ConfigField } from "./ConfigField.js";
import { ConfigSection } from "./ConfigSection.js";

describe("ConfigSection", () => {
  it("starts collapsed, and opens and closes from its header", async () => {
    render(
      <ConfigSection title="Advanced">
        <p>inside</p>
      </ConfigSection>,
    );
    const header = screen.getByRole("button", { name: "Advanced" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Advanced")).toHaveClass("font-mono", "uppercase", "text-[11px]");
    expect(screen.queryByText("inside")).toBeNull();

    const user = userEvent.setup();
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("inside")).toBeInTheDocument();

    await user.click(header);
    expect(screen.queryByText("inside")).toBeNull();
  });

  it("opens by default or by force, and shows a count unless it is empty or zero", () => {
    const { rerender } = render(
      <ConfigSection title="Queue" defaultOpen count={3} className="mt-4" titleClassName="normal-case">
        <p>inside</p>
      </ConfigSection>,
    );
    expect(screen.getByText("inside")).toBeInTheDocument();
    expect(screen.getByText("3")).toHaveClass("tabular-nums");
    expect(screen.getByText("Queue")).toHaveClass("normal-case");

    rerender(
      <ConfigSection title="Queue" forceOpen count={0}>
        <p>inside</p>
      </ConfigSection>,
    );
    expect(screen.getByRole("button", { name: "Queue" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("ConfigField", () => {
  it("shows its label, the control and the hint with the default", () => {
    render(
      <ConfigField label="Timeout" htmlFor="timeout" description="How long to wait." defaultValue="5s" required>
        <input id="timeout" />
      </ConfigField>,
    );
    expect(screen.getByRole("textbox", { name: /Timeout/ })).toBeInTheDocument();
    expect(screen.getByText("*")).toHaveAttribute("aria-hidden");
    expect(screen.getByText(/How long to wait\. · Default/)).toBeInTheDocument();
    expect(screen.getByText("5s")).toHaveClass("font-mono");
  });

  it("shows the default alone, or no hint at all", () => {
    const { rerender } = render(
      <ConfigField label="Timeout" defaultValue="5s">
        <input />
      </ConfigField>,
    );
    expect(screen.getByText(/^Default/).textContent).toBe("Default 5s");

    rerender(
      <ConfigField label="Timeout">
        <input />
      </ConfigField>,
    );
    expect(screen.queryByText(/Default/)).toBeNull();
    expect(document.querySelector("p")).toBeNull();
  });
});
