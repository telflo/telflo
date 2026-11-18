import { randomUUID } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccessTokens, type AccessTokenClaims, type IAccessTokens } from "./access-tokens.js";

const SECRET = "a-test-secret-that-is-at-least-32-bytes-long";
const OTHER_SECRET = "another-test-secret-that-is-at-least-32-bytes";
const TTL_MINUTES = 15;
const START = new Date("2026-09-25T12:00:00.000Z");

function sampleClaims(): AccessTokenClaims {
  return { userId: randomUUID(), sessionId: randomUUID(), organizationId: randomUUID() };
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function secondsAt(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** A complete, correct wire payload, for tests to break one field at a time. */
function wirePayload(claims: AccessTokenClaims, issuedAt = START): JWTPayload {
  const iat = secondsAt(issuedAt);
  return {
    iss: "telflo",
    aud: "telflo-session",
    sub: claims.userId,
    sid: claims.sessionId,
    organization_id: claims.organizationId,
    jti: randomUUID(),
    iat,
    exp: iat + TTL_MINUTES * 60,
  };
}

async function sign(
  payload: JWTPayload,
  { secret = SECRET, alg = "HS256", typ = "JWT" as string | null } = {},
): Promise<string> {
  const header = typ === null ? { alg } : { alg, typ };
  return new SignJWT(payload).setProtectedHeader(header).sign(new TextEncoder().encode(secret));
}

function decodePayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("createAccessTokens", () => {
  let current: Date;
  let accessTokens: IAccessTokens;

  beforeEach(() => {
    current = START;
    accessTokens = createAccessTokens({ secret: SECRET, ttlMinutes: TTL_MINUTES, now: () => current });
  });

  function advanceMinutes(minutes: number): void {
    current = new Date(current.getTime() + minutes * 60_000);
  }

  describe("issue", () => {
    it("expires the token ttlMinutes after now()", async () => {
      const { expiresAt } = await accessTokens.issue(sampleClaims());
      expect(expiresAt).toEqual(new Date(START.getTime() + TTL_MINUTES * 60_000));
    });

    it("puts the spec's claims on the wire", async () => {
      const claims = sampleClaims();
      const { token } = await accessTokens.issue(claims);
      const payload = decodePayload(token);
      expect(payload).toEqual({
        iss: "telflo",
        aud: "telflo-session",
        sub: claims.userId,
        sid: claims.sessionId,
        organization_id: claims.organizationId,
        jti: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        iat: secondsAt(START),
        exp: secondsAt(START) + TTL_MINUTES * 60,
      });
      const [header] = token.split(".");
      expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toEqual({ alg: "HS256", typ: "JWT" });
    });

    it("gives every token a different jti", async () => {
      const claims = sampleClaims();
      const first = decodePayload((await accessTokens.issue(claims)).token);
      const second = decodePayload((await accessTokens.issue(claims)).token);
      expect(first.jti).not.toBe(second.jti);
    });
  });

  describe("verify", () => {
    it("accepts a freshly issued token with the same claims", async () => {
      const claims = sampleClaims();
      const { token } = await accessTokens.issue(claims);
      expect(await accessTokens.verify(token)).toEqual({ status: "valid", claims });
    });

    it("still accepts the token one second before it expires", async () => {
      const claims = sampleClaims();
      const { token } = await accessTokens.issue(claims);
      current = new Date(START.getTime() + TTL_MINUTES * 60_000 - 1000);
      expect(await accessTokens.verify(token)).toEqual({ status: "valid", claims });
    });

    it("reports a token past its expiry as expired, with its claims", async () => {
      const claims = sampleClaims();
      const { token } = await accessTokens.issue(claims);
      advanceMinutes(TTL_MINUTES + 1);
      expect(await accessTokens.verify(token)).toEqual({ status: "expired", claims });
    });

    it("round-trips organization_id", async () => {
      const claims = sampleClaims();
      const { token } = await accessTokens.issue(claims);
      const result = await accessTokens.verify(token);
      expect(result.status === "valid" && result.claims.organizationId).toBe(claims.organizationId);
    });

    it("rejects the wrong audience", async () => {
      const token = await sign({ ...wirePayload(sampleClaims()), aud: "telflo-other" });
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects the wrong issuer", async () => {
      const token = await sign({ ...wirePayload(sampleClaims()), iss: "not-telflo" });
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects an expired token with the wrong audience as invalid, not expired", async () => {
      const token = await sign({ ...wirePayload(sampleClaims()), aud: "telflo-other" });
      advanceMinutes(TTL_MINUTES + 1);
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects an expired token with the wrong issuer as invalid, not expired", async () => {
      const token = await sign({ ...wirePayload(sampleClaims()), iss: "not-telflo" });
      advanceMinutes(TTL_MINUTES + 1);
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it.each(["at+jwt", "JWS"])("rejects a token whose typ is %s", async (typ) => {
      const token = await sign(wirePayload(sampleClaims()), { typ });
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects a token with no typ", async () => {
      const token = await sign(wirePayload(sampleClaims()), { typ: null });
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects a missing iss", async () => {
      const { iss: _iss, ...payload } = wirePayload(sampleClaims());
      expect(await accessTokens.verify(await sign(payload))).toEqual({ status: "invalid" });
    });

    it("rejects a missing aud", async () => {
      const { aud: _aud, ...payload } = wirePayload(sampleClaims());
      expect(await accessTokens.verify(await sign(payload))).toEqual({ status: "invalid" });
    });

    it("rejects a missing sub", async () => {
      const { sub: _sub, ...payload } = wirePayload(sampleClaims());
      expect(await accessTokens.verify(await sign(payload))).toEqual({ status: "invalid" });
    });

    it("rejects a missing sid", async () => {
      const { sid: _sid, ...payload } = wirePayload(sampleClaims());
      expect(await accessTokens.verify(await sign(payload))).toEqual({ status: "invalid" });
    });

    it("rejects a missing organization_id", async () => {
      const { organization_id: _organizationId, ...payload } = wirePayload(sampleClaims());
      expect(await accessTokens.verify(await sign(payload))).toEqual({ status: "invalid" });
    });

    it("rejects an expired token missing organization_id as invalid, not expired", async () => {
      const { organization_id: _organizationId, ...payload } = wirePayload(sampleClaims());
      const token = await sign(payload);
      advanceMinutes(TTL_MINUTES + 1);
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it.each([
      ["sub", "not-a-uuid"],
      ["sid", "not-a-uuid"],
      ["organization_id", "not-a-uuid"],
      ["organization_id", 42],
    ])("rejects a %s that is not a UUID (%s)", async (claim, value) => {
      const token = await sign({ ...wirePayload(sampleClaims()), [claim]: value });
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects a missing exp", async () => {
      const { exp: _exp, ...payload } = wirePayload(sampleClaims());
      expect(await accessTokens.verify(await sign(payload))).toEqual({ status: "invalid" });
    });

    it("rejects garbage", async () => {
      expect(await accessTokens.verify("not.a.jwt")).toEqual({ status: "invalid" });
      expect(await accessTokens.verify("garbage")).toEqual({ status: "invalid" });
    });

    it("rejects the empty string", async () => {
      expect(await accessTokens.verify("")).toEqual({ status: "invalid" });
    });

    it("rejects a token signed with another secret", async () => {
      const token = await sign(wirePayload(sampleClaims()), { secret: OTHER_SECRET });
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects alg: none", async () => {
      const header = base64url({ alg: "none", typ: "JWT" });
      const token = `${header}.${base64url(wirePayload(sampleClaims()))}.`;
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects an HS512 token signed with the right secret", async () => {
      const token = await sign(wirePayload(sampleClaims()), { alg: "HS512" });
      expect(await accessTokens.verify(token)).toEqual({ status: "invalid" });
    });

    it("rejects a tampered payload", async () => {
      const { token } = await accessTokens.issue(sampleClaims());
      const [header, , signature] = token.split(".");
      const tampered = { ...decodePayload(token), organization_id: randomUUID() };
      expect(await accessTokens.verify(`${header}.${base64url(tampered)}.${signature}`)).toEqual({ status: "invalid" });
    });

    it("rejects an expired token with a bad signature as invalid, not expired", async () => {
      const expiredForeign = await sign(wirePayload(sampleClaims()), { secret: OTHER_SECRET });
      const { token } = await accessTokens.issue(sampleClaims());
      const [header, payload] = token.split(".");
      const [, , foreignSignature] = expiredForeign.split(".");
      advanceMinutes(TTL_MINUTES + 1);
      expect(await accessTokens.verify(expiredForeign)).toEqual({ status: "invalid" });
      expect(await accessTokens.verify(`${header}.${payload}.${foreignSignature}`)).toEqual({ status: "invalid" });
    });
  });
});
