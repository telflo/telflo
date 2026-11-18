import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CHOOSER_FOOTER_NOTE, FleetTypeChooserDialog } from "./FleetTypeChooserDialog.js";

/*
 * The fleet-type chooser: no bridge card and no "Private Preview" flags
 * (D17a decisions 4 and 24), one test says so.
 */

describe("FleetTypeChooserDialog (D17a decision 24)", () => {
  it("renders both fleet-type boxes and a Cancel button", () => {
    render(<FleetTypeChooserDialog open onOpenChange={() => {}} onSelect={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Create a new fleet" })).toBeInTheDocument();
    expect(screen.getByText("Linux servers & VMs")).toBeInTheDocument();
    expect(screen.getByText("Kubernetes (Helm)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("offers no Operator bridge, no Private Preview flag, and no disabled card (every member, both types)", () => {
    render(<FleetTypeChooserDialog open onOpenChange={() => {}} onSelect={() => {}} />);
    expect(screen.queryByText(/Operator bridge/)).toBeNull();
    expect(screen.queryByText("Private Preview")).toBeNull();
    const cards = screen.getAllByRole("button").filter((button) => button.textContent !== "Cancel" && button.textContent !== "Close");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toBeEnabled();
      expect(card).not.toHaveAttribute("title");
      expect(card).not.toHaveAttribute("aria-label");
    }
  });

  it("calls onSelect with server for the Linux card", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FleetTypeChooserDialog open onOpenChange={() => {}} onSelect={onSelect} />);
    await user.click(screen.getByText("Linux servers & VMs"));
    expect(onSelect).toHaveBeenCalledWith("server");
  });

  it("offers and selects the kubernetes-supervisor fleet type", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FleetTypeChooserDialog open onOpenChange={() => {}} onSelect={onSelect} />);
    await user.click(screen.getByText("Kubernetes (Helm)"));
    expect(onSelect).toHaveBeenCalledWith("kubernetes-supervisor");
  });

  it("marks no option recommended, and the footer says to start with Helm, without the bridge", () => {
    render(<FleetTypeChooserDialog open onOpenChange={() => {}} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Kubernetes \(Helm\)/ })).not.toHaveTextContent(/recommended/i);
    expect(screen.getByRole("button", { name: /Linux servers & VMs/ })).not.toHaveTextContent(/recommended/i);
    expect(screen.getByText(/start with Helm/)).toHaveTextContent(CHOOSER_FOOTER_NOTE);
    expect(CHOOSER_FOOTER_NOTE).toBe(
      "Not sure? On Kubernetes, start with Helm. You can run several fleets side by side, one per environment or cluster.",
    );
  });

  it("Cancel closes the dialog", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<FleetTypeChooserDialog open onOpenChange={onOpenChange} onSelect={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
