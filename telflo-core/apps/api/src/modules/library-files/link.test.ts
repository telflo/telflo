import { createHmac, randomBytes } from "node:crypto";
import { LIBRARY_LINK_PATTERN } from "@telflo/contracts";
import { describe, expect, it } from "vitest";
import type { LibraryLinkSigningKeys } from "../../settings.js";
import { createLibraryLinks, hmacLibraryLinkTag, LIBRARY_LINK_PREFIX, libraryLinkPath, type LibraryLinkTagger } from "./link.js";

/*
 * The library link. Every link here is signed with a key built at run
 * time, so it is a secret: each assertion on a link is a boolean (`test`,
 * `===`, `includes`), never toEqual or toContain on it, and no failure
 * prints one. A check's result holds the file's id and the expiry only, so
 * it is compared directly.
 */

/** A key as an operator would set one: 43 base64url characters, its UTF-8 bytes. Never printed. */
const newKey = () => Buffer.from(randomBytes(32).toString("base64url"), "utf8");

const FILE_ID = "0199e000-0000-7000-8000-00000000f11e";
const NOW = new Date(Date.UTC(2026, 9, 24, 9, 0, 0, 250));
/** ceil((NOW + 24 h) / 1 s): the expiry the link carries, in seconds. */
const EXPIRY = Math.ceil((NOW.getTime() + 24 * 60 * 60 * 1000) / 1000);
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A tagger that counts its calls, around the real one. */
function countingTagger(): { tagOf: LibraryLinkTagger; calls: () => number } {
  let calls = 0;
  return {
    tagOf: (key, signed) => {
      calls += 1;
      return hmacLibraryLinkTag(key, signed);
    },
    calls: () => calls,
  };
}

describe("the library link", () => {
  const current = newKey();
  const previousOne = newKey();
  const previousTwo = newKey();
  const keys: LibraryLinkSigningKeys = { current, previous: [previousOne, previousTwo] };

  it("is tll_ and 71 base64url characters, 53 bytes: version 1, the file's id, the expiry and the tag", () => {
    const link = createLibraryLinks(keys).sign(FILE_ID, NOW);
    expect(LIBRARY_LINK_PATTERN.test(link)).toBe(true);
    expect(link.length === 75 && link.startsWith(LIBRARY_LINK_PREFIX)).toBe(true);
    const bytes = Buffer.from(link.slice(4), "base64url");
    expect(bytes.length).toBe(53);
    expect(bytes[0]).toBe(1);
    expect(bytes.subarray(1, 17).toString("hex")).toBe(FILE_ID.replaceAll("-", ""));
    expect(bytes.readUInt32BE(17)).toBe(EXPIRY);
    // The tag is HMAC-SHA256 under the current key's bytes of the domain and the first 21 bytes.
    const expected = createHmac("sha256", current).update("telflo-library-link\0", "utf8").update(bytes.subarray(0, 21)).digest();
    expect(bytes.subarray(21).equals(expected)).toBe(true);
  });

  it("signs an upper-case id as its canonical spelling, and refuses an id that isn't one", () => {
    const links = createLibraryLinks(keys);
    const upper = links.sign(FILE_ID.toUpperCase(), NOW);
    expect(links.check(upper, NOW)).toEqual({ kind: "valid", fileId: FILE_ID, expiresAt: EXPIRY });
    expect(() => links.sign("not-a-uuid", NOW)).toThrow("A library link names a canonical file id.");
  });

  it("checks: the file's id and the expiry, until the second before it", () => {
    const links = createLibraryLinks(keys);
    const link = links.sign(FILE_ID, NOW);
    expect(links.check(link, NOW)).toEqual({ kind: "valid", fileId: FILE_ID, expiresAt: EXPIRY });
    expect(links.check(link, new Date(EXPIRY * 1000 - 1))).toEqual({ kind: "valid", fileId: FILE_ID, expiresAt: EXPIRY });
  });

  it("is expired exactly at its expiry, and after it, by the injected clock", () => {
    const links = createLibraryLinks(keys);
    const link = links.sign(FILE_ID, NOW);
    expect(links.check(link, new Date(EXPIRY * 1000))).toEqual({ kind: "expired" });
    expect(links.check(link, new Date(EXPIRY * 1000 + 1))).toEqual({ kind: "expired" });
    expect(links.check(link, new Date(EXPIRY * 1000 + 365 * 24 * 60 * 60 * 1000))).toEqual({ kind: "expired" });
  });

  it("lasts 24 hours from a whole second: the expiry is rounded up", () => {
    const links = createLibraryLinks(keys);
    const onTheSecond = new Date(Date.UTC(2026, 9, 24, 9, 0, 0, 0));
    const link = links.sign(FILE_ID, onTheSecond);
    const expiresAt = onTheSecond.getTime() / 1000 + 24 * 60 * 60;
    expect(links.check(link, onTheSecond)).toEqual({ kind: "valid", fileId: FILE_ID, expiresAt });
    expect(links.check(link, new Date(expiresAt * 1000))).toEqual({ kind: "expired" });
  });

  it("still checks under a previous key (a rotation), and is invalid once that key is retired", () => {
    const before = createLibraryLinks({ current: previousTwo, previous: [] }).sign(FILE_ID, NOW);
    expect(createLibraryLinks(keys).check(before, NOW)).toEqual({ kind: "valid", fileId: FILE_ID, expiresAt: EXPIRY });
    expect(createLibraryLinks({ current, previous: [previousOne] }).check(before, NOW)).toEqual({ kind: "invalid" });
  });

  it("is invalid under another key, whatever its expiry", () => {
    const other = createLibraryLinks({ current: newKey(), previous: [] });
    const link = other.sign(FILE_ID, NOW);
    expect(createLibraryLinks(keys).check(link, NOW)).toEqual({ kind: "invalid" });
    expect(createLibraryLinks(keys).check(link, new Date(EXPIRY * 1000 + 1))).toEqual({ kind: "invalid" });
  });

  it("is invalid with ANY one of its characters changed to any other of the alphabet, the prefix's included (the canonical re-encode)", () => {
    const links = createLibraryLinks(keys);
    const link = links.sign(FILE_ID, NOW);
    let tried = 0;
    let accepted = 0;
    for (let index = 0; index < link.length; index += 1) {
      for (const character of BASE64URL) {
        if (character === link[index]) continue;
        tried += 1;
        if (links.check(link.slice(0, index) + character + link.slice(index + 1), NOW).kind !== "invalid") accepted += 1;
      }
    }
    expect(tried).toBe(75 * 63);
    expect(accepted).toBe(0);
  });

  it("is invalid when its last character spells the same 53 bytes another way (the two spare bits)", () => {
    const links = createLibraryLinks(keys);
    const link = links.sign(FILE_ID, NOW);
    const bytes = Buffer.from(link.slice(4), "base64url");
    const siblings = [...BASE64URL].filter((character) => {
      const altered = link.slice(4, -1) + character;
      return altered !== link.slice(4) && Buffer.from(altered, "base64url").equals(bytes);
    });
    expect(siblings.length).toBe(3);
    for (const character of siblings) expect(links.check(link.slice(0, -1) + character, NOW)).toEqual({ kind: "invalid" });
  });

  it("is invalid for another version byte, even with its tag made right", () => {
    const links = createLibraryLinks(keys);
    const bytes = Buffer.from(links.sign(FILE_ID, NOW).slice(4), "base64url");
    bytes[0] = 2;
    hmacLibraryLinkTag(current, bytes.subarray(0, 21)).copy(bytes, 21);
    expect(links.check(`tll_${bytes.toString("base64url")}`, NOW)).toEqual({ kind: "invalid" });
  });

  it.each([
    ["empty", ""],
    ["the prefix alone", "tll_"],
    ["another prefix", `tqd_${"A".repeat(71)}`],
    ["upper-case prefix", `TLL_${"A".repeat(71)}`],
    ["one character short", `tll_${"A".repeat(70)}`],
    ["one character long", `tll_${"A".repeat(72)}`],
    ["padding", `tll_${"A".repeat(70)}=`],
    ["standard base64's +", `tll_${"A".repeat(70)}+`],
    ["a slash", `tll_${"A".repeat(70)}/`],
    ["all zeros", `tll_${"A".repeat(71)}`],
  ])("is invalid for %s", (_label, link) => {
    expect(createLibraryLinks(keys).check(link, NOW)).toEqual({ kind: "invalid" });
  });

  describe("every key's tag is computed, whatever matches (counted, never timed)", () => {
    const signedBy = (key: Buffer) => createLibraryLinks({ current: key, previous: [] }).sign(FILE_ID, NOW);

    it.each([
      ["the current key", () => signedBy(current)],
      ["the first previous key", () => signedBy(previousOne)],
      ["the last previous key", () => signedBy(previousTwo)],
      ["no key", () => signedBy(newKey())],
    ])("computes three tags for a link signed by %s", (_label, make) => {
      const link = make();
      const counted = countingTagger();
      createLibraryLinks(keys, counted.tagOf).check(link, NOW);
      expect(counted.calls()).toBe(3);
    });

    it("computes eight previous keys' and the current one's for a link the current key signed", () => {
      const nine = { current, previous: Array.from({ length: 8 }, newKey) };
      const counted = countingTagger();
      expect(createLibraryLinks(nine, counted.tagOf).check(signedBy(current), NOW).kind).toBe("valid");
      expect(counted.calls()).toBe(9);
    });

    it("computes every tag for an expired link too, before its expiry is read", () => {
      const counted = countingTagger();
      expect(createLibraryLinks(keys, counted.tagOf).check(signedBy(current), new Date(EXPIRY * 1000)).kind).toBe("expired");
      expect(counted.calls()).toBe(3);
    });

    it("computes none for a malformed link", () => {
      const counted = countingTagger();
      createLibraryLinks(keys, counted.tagOf).check(`tll_${"A".repeat(70)}`, NOW);
      expect(counted.calls()).toBe(0);
    });
  });

  it("puts the link in its route's path", () => {
    const link = createLibraryLinks(keys).sign(FILE_ID, NOW);
    expect(libraryLinkPath(link) === `/api/v1/library-links/${link}`).toBe(true);
  });
});
