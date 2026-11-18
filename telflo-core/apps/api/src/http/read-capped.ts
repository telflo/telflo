// Reading a reply from an internal service under a size cap (D16b Preflight
// ruling 2; docs/conventions/security.md, "Calling an internal service from
// an endpoint"). The validator's, the evaluator's, the tester's and the
// opamp-server's clients each read their replies with it, so no service, nor
// anything between it and the platform, can make the API hold more of a
// reply than its client allows.

/** What `readCapped` answers for a reply over the cap. */
export const TOO_LARGE: unique symbol = Symbol("too large");

/**
 * The reply's text, or TOO_LARGE once it passes `maxBytes`. A declared
 * Content-Length over the cap is refused before a byte is read, and the body
 * cancelled; otherwise the bytes are counted as they stream, and the read
 * cancelled as soon as they pass the cap (a Content-Length that lies low
 * changes nothing). A reply of exactly `maxBytes` is read. The text is
 * decoded as `Response.text()` decodes it (UTF-8, a leading BOM dropped,
 * malformed bytes replaced). A read that breaks off throws, as `text()`
 * does.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string | typeof TOO_LARGE> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return TOO_LARGE;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}
