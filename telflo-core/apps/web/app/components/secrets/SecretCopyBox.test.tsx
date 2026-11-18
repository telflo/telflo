import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { COPIED_FOR_MS, COPY_FAILED_MESSAGE } from "~/lib/hooks/use-copied-text.js";
import { MASK_DOTS, SecretCopyBox, maskSecret } from "./SecretCopyBox.js";

const BEARER = "tfd_canary-bearer-0123456789abcdef";

/** The browser's clipboard, as the test wants it: a `writeText`, or none at all (an insecure origin). */
function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  });
}

/** Every attribute value in the document's body, to show the secret is in none. */
function attributeValues(): string[] {
  return [...document.body.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].map((attribute) => attribute.value),
  );
}

describe("SecretCopyBox (D17a Preflight ruling 13)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    setClipboard(undefined);
  });

  it("renders the secret as selectable code text inside a ph-no-capture box, with its Copy button inside the box", () => {
    render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" />);

    const code = screen.getByText(BEARER);
    expect(code.tagName).toBe("CODE");
    expect(code).toHaveClass("select-all", "break-all", "font-mono");
    const box = code.closest(".ph-no-capture");
    expect(box).not.toBeNull();
    const button = screen.getByRole("button", { name: "Copy default token" });
    expect(box).toContainElement(button);
    expect(button).toHaveTextContent("Copy");
    // Text only: no input holds it, and no attribute carries it.
    expect(document.querySelector("input, textarea")).toBeNull();
    expect(attributeValues().some((value) => value.includes(BEARER))).toBe(false);
  });

  it("keeps no line breaks of its own by default; multiline keeps the secret's and copies them as shown (D17c-1 Preflight ruling 25)", async () => {
    const { rerender } = render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" />);
    expect(screen.getByText(BEARER)).not.toHaveClass("whitespace-pre-wrap");

    const command = `docker run -d \\\n  -e OPAMP_TOKEN='${BEARER}' \\\n  'ghcr.io/telflo/telflo/collector:0.162.0'`;
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    rerender(<SecretCopyBox secret={command} copyLabel="Copy command" multiline />);
    const code = document.querySelector("code")!;
    expect(code.textContent).toBe(command);
    expect(code).toHaveClass("whitespace-pre-wrap", "select-all", "break-all", "font-mono");
    expect(code.closest(".ph-no-capture")).not.toBeNull();
    expect(attributeValues().some((value) => value.includes(BEARER))).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    });
    expect(writeText).toHaveBeenCalledWith(command);
  });

  it("copies the secret, reads Copied for 2 s, then Copy again", async () => {
    // The 2 s are D17a Preflight ruling 13's: a change to the constant fails here, not only the timing below.
    expect(COPIED_FOR_MS).toBe(2_000);
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    const success = vi.spyOn(toast, "success");
    render(<SecretCopyBox secret={BEARER} copyLabel="Copy rotate token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy rotate token" }));
    });
    expect(writeText).toHaveBeenCalledWith(BEARER);
    const button = screen.getByRole("button", { name: "Copy rotate token" });
    expect(button).toHaveTextContent("Copied");
    expect(success).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(COPIED_FOR_MS - 1));
    expect(button).toHaveTextContent("Copied");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(button).toHaveTextContent("Copy");
    expect(button).not.toHaveTextContent("Copied");
  });

  it("keeps its fixed accessible name and announces Copied through an sr-only live region", async () => {
    vi.useFakeTimers();
    setClipboard(() => Promise.resolve());
    render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy default token" }));
    });
    expect(status).toHaveTextContent("Copied");
    // The button is still named by the caller's words, never "Copied".
    expect(screen.getByRole("button", { name: "Copy default token" })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(COPIED_FOR_MS));
    expect(status).toHaveTextContent("");
  });

  it("starts the 2 s again on a second Copy within them", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    render(<SecretCopyBox secret={BEARER} copyLabel="Copy rotate token" />);
    const button = screen.getByRole("button", { name: "Copy rotate token" });

    await act(async () => {
      fireEvent.click(button);
    });
    await act(() => vi.advanceTimersByTimeAsync(COPIED_FOR_MS - 500));
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledTimes(2);

    // 2 s after the first copy: still Copied, the second's 2 s running.
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(button).toHaveTextContent("Copied");
    await act(() => vi.advanceTimersByTimeAsync(COPIED_FOR_MS - 500 - 1));
    expect(button).toHaveTextContent("Copied");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(button).not.toHaveTextContent("Copied");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("toasts 'Failed to copy to clipboard' when the browser refuses, never the error or the secret, and the text stays", async () => {
    setClipboard(() => Promise.reject(new Error(`NotAllowedError while writing ${BEARER}`)));
    const error = vi.spyOn(toast, "error");
    render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy default token" }));
    });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(COPY_FAILED_MESSAGE);
    expect(COPY_FAILED_MESSAGE).toBe("Failed to copy to clipboard");
    expect(screen.getByRole("button", { name: "Copy default token" })).toHaveTextContent("Copy");
    expect(screen.getByText(BEARER)).toBeInTheDocument();
  });

  it("toasts the same where there is no clipboard at all (an insecure origin)", async () => {
    setClipboard(undefined);
    const error = vi.spyOn(toast, "error");
    render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy default token" }));
    });

    expect(error).toHaveBeenCalledWith(COPY_FAILED_MESSAGE);
  });

  it("stands its timer down when it goes away mid-Copied", async () => {
    vi.useFakeTimers();
    setClipboard(() => Promise.resolve());
    const { unmount } = render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy default token" }));
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("masked", () => {
    it("shows the prefix, the first 4 and the last 4 characters, and the whole token nowhere", () => {
      expect(MASK_DOTS).toBe("••••••••");
      render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" masked />);

      const code = document.querySelector("code")!;
      expect(code.textContent).toBe(`tfd_cana${MASK_DOTS}cdef`);
      expect(code).toHaveClass("select-none");
      expect(code).not.toHaveClass("select-all");
      expect(document.body.textContent).not.toContain(BEARER);
      expect(attributeValues().some((value) => value.includes(BEARER))).toBe(false);
      expect(code.closest(".ph-no-capture")).toContainElement(screen.getByRole("button", { name: "Show default token" }));
    });

    it("copies the whole token while it shows masked", async () => {
      const writeText = vi.fn(() => Promise.resolve());
      setClipboard(writeText);
      render(<SecretCopyBox secret={BEARER} copyLabel="Copy rotate token" masked />);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy rotate token" }));
      });

      expect(writeText).toHaveBeenCalledWith(BEARER);
      expect(document.body.textContent).not.toContain(BEARER);
    });

    it("shows the whole token on Show, selectable, and masks it again on Hide", () => {
      render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" masked />);
      const show = screen.getByRole("button", { name: "Show default token" });
      expect(show).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(show);
      const code = screen.getByText(BEARER);
      expect(code).toHaveClass("select-all");
      const hide = screen.getByRole("button", { name: "Hide default token" });
      expect(hide).toHaveAttribute("aria-pressed", "true");
      expect(hide).toHaveTextContent("Hide");
      expect(attributeValues().some((value) => value.includes(BEARER))).toBe(false);

      fireEvent.click(hide);
      expect(document.body.textContent).not.toContain(BEARER);
      expect(screen.getByRole("button", { name: "Show default token" })).toBeInTheDocument();
    });

    it("has no Show button unless masked", () => {
      render(<SecretCopyBox secret={BEARER} copyLabel="Copy default token" />);
      expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
    });
  });

  describe("maskSecret", () => {
    it("keeps the prefix through the first underscore, 4 characters, the dots and the last 4", () => {
      expect(maskSecret("tfr_ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe(`tfr_ABCD${MASK_DOTS}WXYZ`);
      expect(maskSecret("tf_abc_0123456789abcdef")).toBe(`tf_abc_${MASK_DOTS}cdef`);
      expect(maskSecret("0123456789abcdefXYZ")).toBe(`0123${MASK_DOTS}fXYZ`);
    });

    it("shows only the prefix and the dots when fewer than 16 characters follow it", () => {
      expect(maskSecret("tfd_0123456789abcde")).toBe(`tfd_${MASK_DOTS}`);
      expect(maskSecret("tfd_0123456789abcdef")).toBe(`tfd_0123${MASK_DOTS}cdef`);
      expect(maskSecret("short")).toBe(MASK_DOTS);
    });
  });
});
