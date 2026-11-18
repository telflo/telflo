import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { API_TOKEN_PATTERN, API_TOKEN_PREFIX_PATTERN } from "@telflo/contracts";
import { apiTokenHash, mintApiToken } from "./tokens.js";

// A token is a secret (D22 decision 48): these tests compare it as
// booleans and lengths, so a failure never prints one.

describe("an API token (decision 7)", () => {
  it("mints tf_ and 43 base64url characters from 32 random bytes, its hash the SHA-256 hex of the whole token, its prefix the first 11 characters", () => {
    const { token, tokenHash, tokenPrefix } = mintApiToken();

    expect(API_TOKEN_PATTERN.test(token)).toBe(true);
    expect(token.length).toBe(46);
    expect(token.startsWith("tf_")).toBe(true);
    expect(Buffer.from(token.slice(3), "base64url").length).toBe(32);
    expect(tokenHash === createHash("sha256").update(token, "utf8").digest("hex")).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(tokenHash)).toBe(true);
    expect(apiTokenHash(token) === tokenHash).toBe(true);
    expect(tokenPrefix.length).toBe(11);
    expect(token.startsWith(tokenPrefix)).toBe(true);
    expect(API_TOKEN_PREFIX_PATTERN.test(tokenPrefix)).toBe(true);
  });

  it("is new each time", () => {
    const minted = Array.from({ length: 64 }, () => mintApiToken());
    expect(new Set(minted.map(({ token }) => token)).size).toBe(64);
    expect(new Set(minted.map(({ tokenHash }) => tokenHash)).size).toBe(64);
  });
});
