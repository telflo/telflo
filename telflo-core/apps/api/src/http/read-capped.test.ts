import { describe, expect, it } from "vitest";
import { readCapped, TOO_LARGE } from "./read-capped.js";

// The shared capped reader (D16b Preflight ruling 2): every internal
// service's client reads its replies with it.

const encoder = new TextEncoder();

/** A body streamed in `chunks`, counting the pulls and noting a cancel. */
function streamed(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; pulls: () => number; cancelled: () => boolean } {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls];
      pulls += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

describe("readCapped", () => {
  it("reads a reply of exactly the cap", async () => {
    const text = "x".repeat(1024);

    expect(await readCapped(new Response(text), 1024)).toBe(text);
  });

  it("refuses a reply one byte over the cap", async () => {
    expect(await readCapped(new Response("x".repeat(1025)), 1024)).toBe(TOO_LARGE);
  });

  it("counts bytes, not characters: 512 two-byte characters fill a 1,024-byte cap, one more passes it", async () => {
    expect(await readCapped(new Response("é".repeat(512)), 1024)).toBe("é".repeat(512));
    expect(await readCapped(new Response(`${"é".repeat(512)}x`), 1024)).toBe(TOO_LARGE);
  });

  it("refuses a declared Content-Length over the cap before reading a byte, and cancels the body", async () => {
    const body = streamed([encoder.encode("small")]);
    const response = new Response(body.stream, { headers: { "content-length": "1025" } });

    expect(await readCapped(response, 1024)).toBe(TOO_LARGE);
    // A stream's first pull may happen on construction; none follows.
    expect(body.pulls()).toBeLessThanOrEqual(1);
    expect(body.cancelled()).toBe(true);
  });

  it("counts a body whose Content-Length lies low, and cancels the read once it passes the cap", async () => {
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(512).fill(0x20));
    const body = streamed(chunks);
    const response = new Response(body.stream, { headers: { "content-length": "10" } });

    expect(await readCapped(response, 1024)).toBe(TOO_LARGE);
    expect(body.cancelled()).toBe(true);
    expect(body.pulls()).toBeLessThan(100);
  });

  it("reads a body streamed in chunks, a character split across two of them", async () => {
    const bytes = encoder.encode("añb");
    const body = streamed([bytes.slice(0, 2), bytes.slice(2)]);

    expect(await readCapped(new Response(body.stream), 1024)).toBe("añb");
  });

  it("decodes as Response.text() does: a leading BOM dropped, malformed bytes replaced", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62]);

    const capped = await readCapped(new Response(bytes), 1024);

    expect(capped).toBe(await new Response(bytes).text());
    expect(capped).toBe("a�b");
  });

  it("answers an empty string for a reply without a body", async () => {
    expect(await readCapped(new Response(null, { status: 204 }), 1024)).toBe("");
  });

  it("ignores a Content-Length that isn't a number", async () => {
    const response = new Response("ok", { headers: { "content-length": "lots" } });

    expect(await readCapped(response, 1024)).toBe("ok");
  });

  it("throws when the body breaks off, as Response.text() does", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("{"));
          controller.error(new Error("other side closed"));
        },
      }),
    );

    await expect(readCapped(response, 1024)).rejects.toThrow("other side closed");
  });
});
