import { createHmac, timingSafeEqual } from "node:crypto";
import { LIBRARY_LINK_LIFETIME_HOURS, LIBRARY_LINK_PATTERN } from "@telflo/contracts";
import type { LibraryLinkSigningKeys } from "../../settings.js";
import { canonicalIdOf } from "../organizations/service.js";

/*
 * The library link: a signed, stateless capability to download one library
 * file for 24 hours, the same for both file stores (never an S3 presigned
 * URL).
 *
 *   link  = "tll_" ‖ base64url, no padding, of 53 bytes:
 *   bytes = version (1 byte, 0x01)
 *         ‖ the file's id (16 bytes)
 *         ‖ the expiry, seconds since the epoch, unsigned 32-bit big-endian (4 bytes)
 *         ‖ tag (32 bytes)
 *   tag   = HMAC-SHA256(key's UTF-8 bytes, "telflo-library-link\0" ‖ the first 21 bytes)
 *
 * 71 characters after `tll_`. No key id: on each check the tag is computed
 * under EVERY key, the current one and each previous one, and compared with
 * `timingSafeEqual`, accumulated without a short circuit, so a check costs
 * the same whichever key (if any) signed it. Nothing is stored: deleting the
 * file or retiring the key ends a link.
 *
 * Checking, in order: the shape (LIBRARY_LINK_PATTERN); the decoded bytes
 * exactly 53 long and re-encoding to the same text (base64url's last
 * character carries two spare bits: without this check, changing it to a
 * sibling spelling would verify); version 1; the tags. Any of those failing
 * is `invalid` (the route's 404). A good tag whose expiry has come
 * (`now >= expiry`, the injected clock) is `expired` (410). Only then does
 * the file's id go on.
 *
 * The link and the keys are secrets: nothing here logs, and no error names
 * either.
 */

/** A link's prefix, so secret scanners and the redactions can match it. */
export const LIBRARY_LINK_PREFIX = "tll_";

const VERSION = 0x01;
const SIGNED_BYTES = 21;
const TAG_BYTES = 32;
const LINK_BYTES = SIGNED_BYTES + TAG_BYTES;
const LIFETIME_MS = LIBRARY_LINK_LIFETIME_HOURS * 60 * 60 * 1000;
const DOMAIN = Buffer.from("telflo-library-link\0", "utf8");

/** The tag of `signed` under `key`: HMAC-SHA256 of the domain and the signed bytes. */
export type LibraryLinkTagger = (key: Buffer, signed: Buffer) => Buffer;

/** The real tagger. A test passes one that counts its calls around it. */
export const hmacLibraryLinkTag: LibraryLinkTagger = (key, signed) =>
  createHmac("sha256", key).update(DOMAIN).update(signed).digest();

/** What a check found: a link a key signed and still valid, one expired, or nothing. */
export type LibraryLinkCheck =
  | { kind: "valid"; fileId: string; expiresAt: number }
  | { kind: "expired" }
  | { kind: "invalid" };

export interface LibraryLinks {
  /** A new link to `fileId` (a canonical id) under the current key, valid LIBRARY_LINK_LIFETIME_HOURS from `now`. */
  sign(fileId: string, now: Date): string;
  /** The check above. `expiresAt` is the expiry in seconds since the epoch, for the per-link count's key. */
  check(link: string, now: Date): LibraryLinkCheck;
}

export function createLibraryLinks(keys: LibraryLinkSigningKeys, tagOf: LibraryLinkTagger = hmacLibraryLinkTag): LibraryLinks {
  const every = [keys.current, ...keys.previous];
  return {
    sign(fileId, now) {
      const canonical = canonicalIdOf(fileId);
      if (canonical === undefined) throw new Error("A library link names a canonical file id.");
      const signed = Buffer.alloc(SIGNED_BYTES);
      signed[0] = VERSION;
      Buffer.from(canonical.replaceAll("-", ""), "hex").copy(signed, 1);
      // Past 2106 this throws a RangeError rather than wrap.
      signed.writeUInt32BE(Math.ceil((now.getTime() + LIFETIME_MS) / 1000), 17);
      return LIBRARY_LINK_PREFIX + Buffer.concat([signed, tagOf(keys.current, signed)]).toString("base64url");
    },

    check(link, now) {
      if (!LIBRARY_LINK_PATTERN.test(link)) return { kind: "invalid" };
      const text = link.slice(LIBRARY_LINK_PREFIX.length);
      const bytes = Buffer.from(text, "base64url");
      if (bytes.length !== LINK_BYTES || bytes.toString("base64url") !== text) return { kind: "invalid" };
      if (bytes[0] !== VERSION) return { kind: "invalid" };
      const signed = bytes.subarray(0, SIGNED_BYTES);
      const tag = bytes.subarray(SIGNED_BYTES);
      // Every key's tag, whatever matched before it: no short circuit.
      let isAuthentic = false;
      for (const key of every) isAuthentic = timingSafeEqual(tagOf(key, signed), tag) || isAuthentic;
      if (!isAuthentic) return { kind: "invalid" };
      const expiresAt = signed.readUInt32BE(17);
      if (now.getTime() >= expiresAt * 1000) return { kind: "expired" };
      const hex = signed.subarray(1, 17).toString("hex");
      const fileId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return { kind: "valid", fileId, expiresAt };
    },
  };
}

/** A link's route, as `POST …/:fileId/link` answers its `path`. */
export function libraryLinkPath(link: string): string {
  return `/api/v1/library-links/${link}`;
}
