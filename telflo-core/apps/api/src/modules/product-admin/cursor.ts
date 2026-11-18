import { CANONICAL_UUID } from "../organizations/service.js";
import { invalidCursor } from "./errors.js";

/*
 * The product-admin lists' opaque cursor (D29 decisions 9, 31 and 33): the
 * base64url of JSON holding the last item's `createdAt`, as ISO 8601 to the
 * millisecond, and its `id`. The next page is the rows strictly after that
 * pair, newest first. The Users list orders a person's created_at truncated
 * to the millisecond (migration 041: users' created_at defaults to now(),
 * in microseconds), so a JavaScript Date carries it whole; feedback's is
 * the API's clock, in milliseconds already.
 *
 * A client can send anything, so decoding accepts only what encoding makes
 * (the configurations' cursor's rule): an ISO timestamp `Date` prints back
 * identically, and a canonical UUID, lowercased. Anything else is 400
 * `invalid_request`, never a database error. The cursor holds no search
 * term and no email.
 */

export interface PagePosition {
  createdAt: Date;
  id: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeCursor({ createdAt, id }: PagePosition): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

/** The position `text` names; throws 400 `invalid_request` for anything `encodeCursor` couldn't have made. */
export function decodeCursor(text: string): PagePosition {
  // Node's decoder skips characters outside the alphabet: checked first.
  if (!BASE64URL.test(text)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { createdAt, id } = decoded as Record<string, unknown>;
  if (typeof createdAt !== "string" || typeof id !== "string") throw invalidCursor();
  if (!isIsoTimestamp(createdAt) || !CANONICAL_UUID.test(id)) throw invalidCursor();
  return { createdAt: new Date(createdAt), id: id.toLowerCase() };
}

/** Exactly what `Date#toISOString` prints. */
function isIsoTimestamp(text: string): boolean {
  const date = new Date(text);
  return !Number.isNaN(date.getTime()) && date.toISOString() === text;
}
