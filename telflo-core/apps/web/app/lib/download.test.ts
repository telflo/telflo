// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadBlob, downloadTextFile } from "./download.js";

describe("downloadTextFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the browser a correctly named and typed blob", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:stub");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadTextFile("receivers:\n  otlp:\n", "config.yaml", "text/yaml");

    expect(click).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("text/yaml");
    // jsdom's Blob has no .text(); read it via FileReader instead.
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(text).toBe("receivers:\n  otlp:\n");
  });

  it("revokes the object URL and detaches the anchor it created", () => {
    const revokeObjectURL = vi.fn();
    Object.assign(URL, {
      createObjectURL: vi.fn((_blob: Blob) => "blob:stub"),
      revokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadTextFile("x", "config.yaml", "text/yaml");

    // A leaked blob URL pins its data for the life of the document, and a
    // leaked anchor would accumulate on every download.
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub");
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });
});

describe("downloadBlob (D14a Preflight ruling 14)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clicks a detached anchor for the blob, named as asked, and never touches <body>", () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:stub");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: { anchor: HTMLAnchorElement; connected: boolean; download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ anchor: this, connected: this.isConnected, download: this.download, href: this.href });
    });
    // Every way an element could reach <body>, watched.
    const appendChild = vi.spyOn(document.body, "appendChild");
    const append = vi.spyOn(document.body, "append");
    const insertBefore = vi.spyOn(document.body, "insertBefore");
    const prepend = vi.spyOn(document.body, "prepend");
    const observed: MutationRecord[] = [];
    const observer = new MutationObserver((records) => observed.push(...records));
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const bytes = new Uint8Array([0xff, 0xfe, 0x7b, 0x00]);

    downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), "zq-private-input.json");

    observed.push(...observer.takeRecords());
    observer.disconnect();
    expect(clicked).toEqual([{ anchor: expect.any(HTMLAnchorElement), connected: false, download: "zq-private-input.json", href: "blob:stub" }]);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(createObjectURL.mock.calls[0]?.[0]?.size).toBe(4);
    for (const spy of [appendChild, append, insertBefore, prepend]) expect(spy).not.toHaveBeenCalled();
    expect(observed).toEqual([]);
    expect(document.querySelector("a[download]")).toBeNull();
    // A leaked blob URL pins its data for the document's life.
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub");
  });

  it("revokes the URL even when the click throws", () => {
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:stub"), revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => downloadBlob(new Blob(["x"]), "output.json")).toThrow("blocked");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub");
  });
});
