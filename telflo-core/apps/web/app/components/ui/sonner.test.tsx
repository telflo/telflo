import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { Toaster } from "./sonner.js";

// Its own file: sonner keeps toasts in a module singleton.

describe("Toaster", () => {
  it("takes sonner's light for Light and dark for Dark and Navy, switching a toast already showing", async () => {
    const { container, rerender } = render(<Toaster theme="light" />);
    // sonner renders its list only once there is a toast.
    act(() => {
      toast("Saved");
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const toaster = () => container.querySelector("[data-sonner-toaster]");
    expect(toaster()).toHaveAttribute("data-sonner-theme", "light");

    rerender(<Toaster theme="navy" />);
    expect(toaster()).toHaveAttribute("data-sonner-theme", "dark");
    expect(screen.getByText("Saved")).toBeInTheDocument();

    rerender(<Toaster theme="dark" />);
    expect(toaster()).toHaveAttribute("data-sonner-theme", "dark");

    rerender(<Toaster theme="light" />);
    expect(toaster()).toHaveAttribute("data-sonner-theme", "light");
  });

  it("gives the toasts the app's popover tokens through sonner's --normal-* variables", async () => {
    const { container } = render(<Toaster theme="dark" />);
    act(() => {
      toast("Copied");
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();

    const toaster = container.querySelector<HTMLElement>("[data-sonner-toaster]");
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe("var(--color-popover)");
    expect(toaster?.style.getPropertyValue("--normal-text")).toBe("var(--color-popover-foreground)");
    expect(toaster?.style.getPropertyValue("--normal-border")).toBe("var(--color-border)");
  });
});
