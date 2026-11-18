import { imageTypeOf } from "@telflo/contracts";
import { describe, expect, it } from "vitest";

/*
 * D23-2 decisions 32 and 34 (Preflight ruling 15): the API types a logo with
 * the contracts' `imageTypeOf` on the Buffer the upload was read into. A
 * Buffer is a Uint8Array, often a view into a larger shared pool (a
 * non-zero byteOffset): these are the API's own cases, beside the
 * contracts' Uint8Array ones. Only the bytes decide; a file's name or its
 * declared type never reaches the function.
 */
describe("imageTypeOf on the API's Buffers", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ")]);

  it.each([
    ["a PNG", png, "image/png"],
    ["a JPEG", jpeg, "image/jpeg"],
    ["a WebP", webp, "image/webp"],
  ] as const)("names %s from its bytes", (_label, bytes, type) => {
    expect(imageTypeOf(bytes)).toBe(type);
  });

  it("reads a Buffer that is a view into a larger pool from its own first byte", () => {
    const pool = Buffer.concat([Buffer.from("GIF89a-padding"), png]);
    const view = pool.subarray(14);
    expect(view.byteOffset).toBeGreaterThan(0);
    expect(imageTypeOf(view)).toBe("image/png");
    // The pool's own start is a GIF: refused.
    expect(imageTypeOf(pool)).toBeUndefined();
  });

  it.each([
    ["SVG (what a .png name may hold)", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["SVG with an XML declaration", Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00")],
    ["HTML", Buffer.from("<!doctype html><html></html>")],
    ["an empty file", Buffer.alloc(0)],
    ["a PNG signature cut short", png.subarray(0, 7)],
    ["a RIFF that isn't WebP (a WAV)", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])],
    ["a JPEG's first two bytes only", jpeg.subarray(0, 2)],
  ])("refuses %s", (_label, bytes) => {
    expect(imageTypeOf(bytes)).toBeUndefined();
  });
});
