import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MASK_DOTS } from "~/components/secrets/SecretCopyBox.js";
import { CreatedFleetTokens } from "./CreatedFleetTokens.js";

const DEFAULT_BEARER = "tfd_default-bearer-canary";
const ROTATE_BEARER = "tfr_rotate-bearer-canary";

describe("CreatedFleetTokens", () => {
  it("shows the default token, which never expires, and the rotate token with its expiry, each in its own ph-no-capture box", () => {
    render(
      <CreatedFleetTokens
        tokens={{ defaultBearer: DEFAULT_BEARER, rotateBearer: ROTATE_BEARER, rotateExpiresAt: "2027-10-14T09:00:00.000Z" }}
      />,
    );
    expect(screen.getByText("Default token")).toBeInTheDocument();
    expect(screen.getByText("The one an install uses. It never expires.")).toBeInTheDocument();
    expect(screen.getByText("Rotate token")).toBeInTheDocument();
    expect(screen.getByText(/^It expires Oct 14, 2027, /)).toBeInTheDocument();
    const defaultBox = screen.getByText(`tfd_defa${MASK_DOTS}nary`).closest(".ph-no-capture");
    const rotateBox = screen.getByText(`tfr_rota${MASK_DOTS}nary`).closest(".ph-no-capture");
    expect(defaultBox).not.toBeNull();
    expect(rotateBox).not.toBeNull();
    expect(defaultBox).not.toBe(rotateBox);
    expect(defaultBox).toContainElement(screen.getByRole("button", { name: "Copy default token" }));
    expect(rotateBox).toContainElement(screen.getByRole("button", { name: "Copy rotate token" }));
  });

  it("shows both tokens masked, copies each whole, and shows one whole on its own Show", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CreatedFleetTokens tokens={{ defaultBearer: DEFAULT_BEARER, rotateBearer: ROTATE_BEARER, rotateExpiresAt: null }} />);
    expect(document.body.textContent).not.toContain(DEFAULT_BEARER);
    expect(document.body.textContent).not.toContain(ROTATE_BEARER);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy default token" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy rotate token" }));
    });
    expect(writeText).toHaveBeenNthCalledWith(1, DEFAULT_BEARER);
    expect(writeText).toHaveBeenNthCalledWith(2, ROTATE_BEARER);

    fireEvent.click(screen.getByRole("button", { name: "Show rotate token" }));
    expect(screen.getByText(ROTATE_BEARER)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(DEFAULT_BEARER);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });

  it("says a rotate token without an expiry never expires", () => {
    render(<CreatedFleetTokens tokens={{ defaultBearer: "tfd_a", rotateBearer: "tfr_b", rotateExpiresAt: null }} />);
    expect(screen.getByText("It never expires.")).toBeInTheDocument();
  });
});
