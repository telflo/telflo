/*
 * Where a request goes, as the public surface's guards read it: ONE
 * normalizer for the request log (request-log.ts) and the request-time
 * verification (modules/public-api/route-guard.ts), so the two can never
 * disagree about whether a request is under `/api/public/v1`. Spellings
 * keep coming (dot segments, encoded and doubly encoded letters,
 * `;`-parameters, characters that change length in lower case,
 * absolute-form request lines), so the class is ruled by an allowlist: a
 * request this puts under the prefix is logged by its matched route's
 * pattern only (or a fixed `[unmatched]`), and is answered only by a
 * verified route or the public plugin's own 404.
 */

/** The prefix, with a segment boundary, case aside. Tested on a normalized path only, never sliced. */
const PUBLIC_PATH = /^\/api\/public\/v1(\/|$)/i;

/** An absolute-form request target's `scheme://authority` (RFC 9112 §3.2.2): `GET http://x/api/… HTTP/1.1`. */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** How many rounds of percent-decoding at most: enough for any spelling a proxy and a router decode between them. */
export const DECODING_ROUNDS = 3;

/** One round of percent-decoding: each valid escape, past a malformed one. */
function decodedOnce(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/%([0-9a-fA-F]{2})/g, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
}

/** Where the target's path ends: the first `?` or `#` (find-my-way splits at either). */
function pathPartOf(target: string): string {
  const ends = [target.indexOf("?"), target.indexOf("#")].filter((index) => index !== -1);
  return ends.length === 0 ? target : target.slice(0, Math.min(...ends));
}

/**
 * A request target's path, normalized: its query and fragment dropped, an
 * absolute-form `scheme://authority` stripped, percent-decoded until it is
 * stable (at most DECODING_ROUNDS rounds), with a leading slash, runs of
 * slashes made one and dot segments resolved. Case is kept: the prefix is
 * matched case aside by a regex, never by lower-casing and slicing.
 */
export function publicPathOf(rawUrl: string): string {
  let path = pathPartOf(rawUrl).replace(ABSOLUTE_FORM, "");
  for (let round = 0; round < DECODING_ROUNDS; round += 1) {
    const decoded = decodedOnce(path);
    if (decoded === path) break;
    path = decoded;
  }
  const segments: string[] = [];
  for (const segment of `/${path}`.replace(/\/{2,}/g, "/").split("/").slice(1)) {
    if (segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** Whether a request target, normalized by publicPathOf, is under `/api/public/v1`. */
export function isPublicPath(rawUrl: string): boolean {
  return PUBLIC_PATH.test(publicPathOf(rawUrl));
}
