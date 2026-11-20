import { CANONICAL_UUID } from "../organizations/service.js";
import type { ConfigurationPagePosition } from "./repositories/configuration-repository.js";
import { invalidCursor } from "./errors.js";

/*
 * The list's opaque cursor: the base64url of JSON holding the last item's
 * `updatedAt`, as ISO 8601, and its `id`. The next page is the rows
 * strictly after that pair.
 *
 * The timestamp round-trips exactly because the API writes every
 * configuration timestamp from its clock, in whole milliseconds (decision
 * 4). A client can send anything, so decoding accepts only what encoding
 * makes: an ISO timestamp that `Date` prints back identically, and a UUID
 * in its canonical form, lowercased as Postgres prints one. Anything else is
 * 400 `invalid_request`, never a database error.
 */

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeCursor({ updatedAt, id }: ConfigurationPagePosition): string {
  return Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id }), "utf8").toString("base64url");
}

/** The position `text` names; throws 400 `invalid_request` for anything `encodeCursor` couldn't have made. */
export function decodeCursor(text: string): ConfigurationPagePosition {
  // Node's decoder skips characters outside the alphabet, so it would read
  // a cursor with junk in it; the alphabet is checked first.
  if (!BASE64URL.test(text)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { updatedAt, id } = decoded as Record<string, unknown>;
  if (typeof updatedAt !== "string" || typeof id !== "string") throw invalidCursor();
  if (!isIsoTimestamp(updatedAt) || !CANONICAL_UUID.test(id)) throw invalidCursor();
  return { updatedAt: new Date(updatedAt), id: id.toLowerCase() };
}

/** Exactly what `Date#toISOString` prints: `new Date` alone reads far more ("2026", "Sep 27"). */
function isIsoTimestamp(text: string): boolean {
  const date = new Date(text);
  return !Number.isNaN(date.getTime()) && date.toISOString() === text;
}
