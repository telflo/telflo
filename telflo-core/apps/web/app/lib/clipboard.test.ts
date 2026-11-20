import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextFromPromise } from "./clipboard.js";

// The copy, with and without ClipboardItem, and a rejected text writing
// nothing (a reveal answering after the dialog closed never reaches the
// clipboard).

describe("copyTextFromPromise", () => {
  const originalClipboard = navigator.clipboard;
  const originalClipboardItem = globalThis.ClipboardItem;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
    globalThis.ClipboardItem = originalClipboardItem;
    vi.restoreAllMocks();
  });

  /** A ClipboardItem stub that records its payload. */
  class RecordingClipboardItem {
    items: Record<string, unknown>;
    constructor(items: Record<string, unknown>) {
      this.items = items;
    }
  }

  it("invokes clipboard.write synchronously, before the text promise resolves (Safari's gesture)", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { write, writeText: vi.fn() }, configurable: true });
    globalThis.ClipboardItem = RecordingClipboardItem as unknown as typeof ClipboardItem;

    let resolveText: (text: string) => void = () => {};
    const textPromise = new Promise<string>((resolve) => {
      resolveText = resolve;
    });

    const copying = copyTextFromPromise(textPromise);

    // The whole point of the fix: write() was already called, synchronously, while the text is still pending.
    expect(write).toHaveBeenCalledTimes(1);

    resolveText("docker run -d telflo-collector");
    await copying;

    const item = (write.mock.calls[0]![0] as RecordingClipboardItem[])[0]!;
    expect(item.items).toHaveProperty("text/plain");
    const blob = await (item.items["text/plain"] as Promise<Blob>);
    expect(blob.type).toBe("text/plain");
    // jsdom's Blob has no text(): read it as a browser would.
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(text).toBe("docker run -d telflo-collector");
  });

  it("falls back to writeText with the resolved text when ClipboardItem is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // @ts-expect-error simulating an engine without ClipboardItem (Firefox before 127)
    globalThis.ClipboardItem = undefined;

    await copyTextFromPromise(Promise.resolve("hello"));

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("writes nothing when the text is refused (the dialog closed first), and rejects", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // @ts-expect-error as above
    globalThis.ClipboardItem = undefined;
    const closed = new Error("closed");

    await expect(copyTextFromPromise(Promise.reject(closed))).rejects.toBe(closed);
    expect(writeText).not.toHaveBeenCalled();
  });
});
