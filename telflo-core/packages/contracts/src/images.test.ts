import { describe, expect, it } from "vitest";
import { imageTypeOf, ORGANIZATION_LOGO_MAXIMUM_BYTES, ORGANIZATION_LOGO_TYPES } from "./images.js";

// D23-2 decisions 32 and 61: a logo is typed from its bytes only. Built from
// Uint8Array and TextEncoder (the package runs in the browser too); the
// API's own tests cover a Node Buffer.

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const join = (...parts: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff);
const WEBP = join(text("RIFF"), bytes(0x24, 0x00, 0x00, 0x00), text("WEBP"));

describe("imageTypeOf (D23-2 decision 32)", () => {
  it.each([
    ["a PNG's signature", PNG, "image/png"],
    ["a PNG's signature and its IHDR", join(PNG, bytes(0, 0, 0, 13), text("IHDR")), "image/png"],
    ["a JPEG's signature (JFIF)", join(JPEG, bytes(0xe0, 0x00, 0x10), text("JFIF")), "image/jpeg"],
    ["a JPEG's signature (Exif)", join(JPEG, bytes(0xe1)), "image/jpeg"],
    ["a JPEG's three bytes alone", JPEG, "image/jpeg"],
    ["a WebP's RIFF, size and WEBP", WEBP, "image/webp"],
    ["a WebP's head and its VP8 chunk", join(WEBP, text("VP8 ")), "image/webp"],
    ["a WebP whose size bytes are anything", join(text("RIFF"), bytes(0xff, 0xff, 0xff, 0xff), text("WEBP")), "image/webp"],
  ] as const)("names %s", (_name, head, type) => {
    expect(imageTypeOf(head)).toBe(type);
  });

  it.each([
    ["an empty head", new Uint8Array()],
    ["one byte of a PNG", PNG.subarray(0, 1)],
    ["seven bytes of a PNG", PNG.subarray(0, 7)],
    ["two bytes of a JPEG", JPEG.subarray(0, 2)],
    ["a WebP head one byte short", WEBP.subarray(0, 11)],
    ["RIFF alone", text("RIFF")],
    ["a RIFF that isn't WebP (WAVE)", join(text("RIFF"), bytes(0x24, 0, 0, 0), text("WAVE"))],
    ["WEBP without RIFF", join(text("RIFX"), bytes(0x24, 0, 0, 0), text("WEBP"))],
    ["an SVG", text('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["an SVG with an XML declaration", text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["a GIF89a", join(text("GIF89a"), bytes(1, 0, 1, 0))],
    ["a GIF87a", text("GIF87a")],
    ["an HTML page", text("<!doctype html><title>x</title>")],
    ["plain text", text("not an image")],
    ["a PNG's signature with one byte changed", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b)],
    ["a PNG's signature one byte late", join(bytes(0), PNG)],
    ["a JPEG's signature with its third byte wrong", bytes(0xff, 0xd8, 0xfe)],
    ["zeros", new Uint8Array(12)],
  ])("refuses %s", (_name, head) => {
    expect(imageTypeOf(head)).toBeUndefined();
  });

  it("never reads a name: a file called logo.png holding SVG is refused, one called logo.svg holding PNG is a PNG", () => {
    const named = (name: string, content: Uint8Array) => ({ name, content });
    const svgAsPng = named("logo.png", text("<svg/>"));
    const pngAsSvg = named("logo.svg", PNG);
    // The function takes the bytes alone: the names can't reach it.
    expect(imageTypeOf(svgAsPng.content)).toBeUndefined();
    expect(imageTypeOf(pngAsSvg.content)).toBe("image/png");
  });

  it("reads a head inside a larger buffer by its own view", () => {
    const larger = join(bytes(0, 0, 0, 0), PNG);
    expect(imageTypeOf(larger.subarray(4))).toBe("image/png");
    expect(imageTypeOf(larger)).toBeUndefined();
  });
});

describe("the logo's limits (D23-2 decision 32)", () => {
  it("is 2 MiB, and the three types imageTypeOf names", () => {
    expect(ORGANIZATION_LOGO_MAXIMUM_BYTES).toBe(2 * 1024 * 1024);
    expect(ORGANIZATION_LOGO_TYPES).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });
});
