import { describe, expect, it } from "vitest";
import { formatDateTime } from "~/lib/format.js";
import { DEFAULT_TOKEN_ID, listedToken, ROTATE_TOKEN_ID } from "~/test/fleets.js";
import {
  collectorTokenWords,
  CURRENT_ROTATE_TOKEN_WORDS,
  DEFAULT_TOKEN_WORDS,
  TOKEN_REFUSED_WORDS,
  UNKNOWN_TOKEN_WORDS,
} from "./CollectorTokenRow.js";

// The Token row's rule: the opamp-server's `GetActiveRotate` (valid rotate
// tokens ordered `do_refresh, created_at desc, id desc`) and
// `Token.ValidAt` (not revoked, no expiry or one after now), checked in the
// rule's order.

const NOW = Date.parse("2026-10-14T10:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR_MS = 3_600_000;

const LOWER_ID = "00000000-0000-4000-8000-00000000000a";
const GREATER_ID = "00000000-0000-4000-8000-00000000000b";

const defaultToken = (overrides: Parameters<typeof listedToken>[0] = {}) =>
  listedToken({ id: DEFAULT_TOKEN_ID, kind: "default", ...overrides });

describe("collectorTokenWords", () => {
  it("shows a dash for no token, and says a token the list doesn't hold is unknown", () => {
    expect(collectorTokenWords(null, [defaultToken()], NOW)).toBe("—");
    expect(collectorTokenWords(ROTATE_TOKEN_ID, [defaultToken()], NOW)).toBe(UNKNOWN_TOKEN_WORDS);
    expect(collectorTokenWords(ROTATE_TOKEN_ID, [], NOW)).toBe(UNKNOWN_TOKEN_WORDS);
  });

  it("says the default token, valid with no expiry", () => {
    expect(collectorTokenWords(DEFAULT_TOKEN_ID, [defaultToken(), listedToken()], NOW)).toBe(DEFAULT_TOKEN_WORDS);
  });

  it("says a revoked or expired token of either kind is refused, before saying its kind", () => {
    const revokedDefault = defaultToken({ revokedAt: at(-HOUR_MS) });
    expect(collectorTokenWords(DEFAULT_TOKEN_ID, [revokedDefault], NOW)).toBe(TOKEN_REFUSED_WORDS);
    const expiredDefault = defaultToken({ expiresAt: at(-1) });
    expect(collectorTokenWords(DEFAULT_TOKEN_ID, [expiredDefault], NOW)).toBe(TOKEN_REFUSED_WORDS);
    // The only rotate token, revoked: refused, never "current".
    const revokedRotate = listedToken({ revokedAt: at(-HOUR_MS) });
    expect(collectorTokenWords(ROTATE_TOKEN_ID, [revokedRotate], NOW)).toBe(TOKEN_REFUSED_WORDS);
  });

  it("counts an expiry at now as expired (valid only while its expiry is after now)", () => {
    expect(collectorTokenWords(ROTATE_TOKEN_ID, [listedToken({ expiresAt: at(0) })], NOW)).toBe(TOKEN_REFUSED_WORDS);
    expect(collectorTokenWords(ROTATE_TOKEN_ID, [listedToken({ expiresAt: at(1) })], NOW)).toBe(CURRENT_ROTATE_TOKEN_WORDS);
  });

  it("says the only valid rotate token is current", () => {
    expect(collectorTokenWords(ROTATE_TOKEN_ID, [defaultToken(), listedToken()], NOW)).toBe(CURRENT_ROTATE_TOKEN_WORDS);
  });

  it("puts a token not being refreshed before one being refreshed, however new", () => {
    const replaced = listedToken({ id: GREATER_ID, doRefresh: true, createdAt: at(-HOUR_MS), expiresAt: at(2 * HOUR_MS) });
    const successor = listedToken({ id: LOWER_ID, doRefresh: false, createdAt: at(-2 * HOUR_MS) });
    const tokens = [replaced, successor];
    expect(collectorTokenWords(LOWER_ID, tokens, NOW)).toBe(CURRENT_ROTATE_TOKEN_WORDS);
    expect(collectorTokenWords(GREATER_ID, tokens, NOW)).toBe(`Rotate token (being replaced until ${formatDateTime(at(2 * HOUR_MS))})`);
  });

  it("puts the newest first among tokens alike in refresh", () => {
    const older = listedToken({ id: GREATER_ID, createdAt: at(-2 * HOUR_MS), expiresAt: at(HOUR_MS) });
    const newer = listedToken({ id: LOWER_ID, createdAt: at(-HOUR_MS) });
    expect(collectorTokenWords(LOWER_ID, [older, newer], NOW)).toBe(CURRENT_ROTATE_TOKEN_WORDS);
    expect(collectorTokenWords(GREATER_ID, [older, newer], NOW)).toBe(`Rotate token (being replaced until ${formatDateTime(at(HOUR_MS))})`);
  });

  it("puts the greater id first among tokens made at the same time", () => {
    const createdAt = at(-HOUR_MS);
    const lower = listedToken({ id: LOWER_ID, createdAt });
    const greater = listedToken({ id: GREATER_ID, createdAt });
    expect(collectorTokenWords(GREATER_ID, [lower, greater], NOW)).toBe(CURRENT_ROTATE_TOKEN_WORDS);
    expect(collectorTokenWords(LOWER_ID, [lower, greater], NOW)).toBe("Rotate token (being replaced)");
  });

  it("skips an invalid rotate token when finding the current one", () => {
    const revokedNewest = listedToken({ id: GREATER_ID, createdAt: at(-HOUR_MS), revokedAt: at(-1) });
    const valid = listedToken({ id: LOWER_ID, createdAt: at(-2 * HOUR_MS) });
    expect(collectorTokenWords(LOWER_ID, [revokedNewest, valid], NOW)).toBe(CURRENT_ROTATE_TOKEN_WORDS);
  });
});
