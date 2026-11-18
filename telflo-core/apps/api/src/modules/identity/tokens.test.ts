import { describe, expect, it } from "vitest";
import { generateVerificationToken, hashToken } from "./tokens.js";

describe("generateVerificationToken", () => {
  it("returns a url-safe token, so it survives being placed in a link", () => {
    const { token } = generateVerificationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("returns at least 256 bits of entropy", () => {
    // 32 bytes base64url-encoded is 43 characters.
    const { token } = generateVerificationToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("returns a different token on every call", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateVerificationToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it("returns a hash that matches the token", () => {
    const { token, tokenHash } = generateVerificationToken();
    expect(tokenHash).toBe(hashToken(token));
  });

  it("never returns the plaintext token as its own hash", () => {
    const { token, tokenHash } = generateVerificationToken();
    expect(tokenHash).not.toBe(token);
  });
});

describe("hashToken", () => {
  it("produces a 64-character hex sha-256 digest", () => {
    expect(hashToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic, so a returning link resolves to the same row", () => {
    expect(hashToken("stable-input")).toBe(hashToken("stable-input"));
  });

  it("produces different digests for inputs differing by one character", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  it("handles an empty string without throwing", () => {
    expect(hashToken("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
