import { hkdfSync, randomUUID } from "node:crypto";
import { SignJWT, type JWTPayload } from "jose";
import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import { describe, expect, it } from "vitest";
import { createAccessTokens } from "../sessions/access-tokens.js";
import { oidcFlowCookieName, oidcFlowCookieOptions } from "../sessions/cookies.js";
import { createFlowCookie, LINK_REDIRECT_PATH, MAX_FLOW_REDIRECT_LENGTH, readFlowCookie } from "./flow-cookie.js";

const SECRET = "a-test-secret-that-is-at-least-32-bytes-long";
const OTHER_SECRET = "another-test-secret-that-is-at-least-32-bytes";
const START = new Date("2026-09-26T12:00:00.000Z");
const TEN_MINUTES_MS = 10 * 60 * 1000;

function secondsAt(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * The key the contract names: HKDF-SHA256 of the access-token secret, empty
 * salt, info "telflo-oidc-flow". Derived here independently, so a cookie this
 * signs differs from a real one only in the field a test changes.
 */
function flowKey(secret = SECRET): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), "telflo-oidc-flow", 32));
}

/** An undefined override leaves the claim out: JSON drops it. */
function wirePayload(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    iss: "telflo",
    aud: "telflo-oidc-flow",
    iat: secondsAt(START),
    exp: secondsAt(START) + 600,
    provider: "google",
    redirect_to: "/app",
    state: randomState(),
    nonce: randomNonce(),
    code_verifier: randomPKCECodeVerifier(),
    ...overrides,
  };
}

function sign(payload: JWTPayload, { key = flowKey(), typ = "telflo-oidc-flow+jwt" } = {}): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ }).sign(key);
}

describe("the OIDC flow cookie", () => {
  it("round-trips the provider, redirectTo, state, nonce and PKCE verifier", async () => {
    const created = await createFlowCookie({ providerId: "google", redirectTo: "/app/settings?tab=1" }, SECRET, START);

    const flow = await readFlowCookie(created.value, SECRET, new Date(START.getTime() + 60_000));

    expect(flow).toEqual({
      providerId: "google",
      redirectTo: "/app/settings?tab=1",
      state: created.state,
      nonce: created.nonce,
      codeVerifier: created.codeVerifier,
      intent: "sign_in",
    });
    expect(created.codeChallenge).toBe(await calculatePKCECodeChallenge(created.codeVerifier));
  });

  describe("the intent", () => {
    const USER_ID = randomUUID();
    const SESSION_ID = randomUUID();

    it("a link flow round-trips with its user and session", async () => {
      const created = await createFlowCookie(
        { providerId: "google", redirectTo: LINK_REDIRECT_PATH, link: { userId: USER_ID, sessionId: SESSION_ID } },
        SECRET,
        START,
      );

      expect(await readFlowCookie(created.value, SECRET, START)).toEqual({
        providerId: "google",
        redirectTo: "/settings/account",
        state: created.state,
        nonce: created.nonce,
        codeVerifier: created.codeVerifier,
        intent: "link",
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      const [, payload] = created.value.split(".") as [string, string];
      expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toMatchObject({
        intent: "link",
        user_id: USER_ID,
        session_id: SESSION_ID,
      });
    });

    it("a sign-in's cookie says so, and carries neither id", async () => {
      const created = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, SECRET, START);
      const [, payload] = created.value.split(".") as [string, string];
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;

      expect(claims.intent).toBe("sign_in");
      expect(claims).not.toHaveProperty("user_id");
      expect(claims).not.toHaveProperty("session_id");
    });

    it("reads a link's ids in their one lowercase spelling", async () => {
      const value = await sign(
        wirePayload({ intent: "link", user_id: USER_ID.toUpperCase(), session_id: SESSION_ID.toUpperCase() }),
      );
      expect(await readFlowCookie(value, SECRET, START)).toMatchObject({ userId: USER_ID, sessionId: SESSION_ID });
    });

    it("a cookie with no intent reads as a sign-in", async () => {
      expect(await readFlowCookie(await sign(wirePayload()), SECRET, START)).toMatchObject({ intent: "sign_in" });
      expect(await readFlowCookie(await sign(wirePayload({ intent: "sign_in" })), SECRET, START)).toMatchObject({
        intent: "sign_in",
      });
    });

    it.each([
      ["link with no ids", { intent: "link" }],
      ["link with no session", { intent: "link", user_id: USER_ID }],
      ["link with no user", { intent: "link", session_id: SESSION_ID }],
      ["link with a user id that isn't a uuid", { intent: "link", user_id: "someone", session_id: SESSION_ID }],
      ["link with a numeric session id", { intent: "link", user_id: USER_ID, session_id: 42 }],
      ["link with a uuid without hyphens", { intent: "link", user_id: USER_ID.replaceAll("-", ""), session_id: SESSION_ID }],
      ["an unknown intent", { intent: "takeover", user_id: USER_ID, session_id: SESSION_ID }],
      ["an intent in another case", { intent: "LINK", user_id: USER_ID, session_id: SESSION_ID }],
      ["a sign_in carrying a user id", { intent: "sign_in", user_id: USER_ID }],
      ["a sign_in carrying a session id", { intent: "sign_in", session_id: SESSION_ID }],
      ["no intent but both ids", { user_id: USER_ID, session_id: SESSION_ID }],
    ])("link without both uuids, or an unknown intent, is refused: %s", async (_label, overrides: Record<string, unknown>) => {
      expect(await readFlowCookie(await sign(wirePayload(overrides)), SECRET, START)).toBeUndefined();
    });

    it("the cookie stays under 4 KB at the longest redirect", async () => {
      // 511 three-byte characters after the slash: the longest redirect the
      // cap keeps, at its most bytes, with a link's two ids on top.
      const longest = `/${"\u20ac".repeat(MAX_FLOW_REDIRECT_LENGTH - 1)}`;
      expect(longest).toHaveLength(MAX_FLOW_REDIRECT_LENGTH);
      const created = await createFlowCookie(
        { providerId: "google", redirectTo: longest, link: { userId: USER_ID, sessionId: SESSION_ID } },
        SECRET,
        START,
      );
      expect(await readFlowCookie(created.value, SECRET, START)).toMatchObject({ redirectTo: longest, intent: "link" });

      const settings = { isCookieSecure: true };
      const options = oidcFlowCookieOptions(settings);
      const header = [
        `${oidcFlowCookieName(settings)}=${created.value}`,
        `Max-Age=${options.maxAge}`,
        `Path=${options.path}`,
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
      ].join("; ");
      expect(Buffer.byteLength(header, "utf8")).toBeLessThan(4096);
    });
  });

  it("creates fresh random values for every flow", async () => {
    const first = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, SECRET, START);
    const second = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, SECRET, START);
    expect(new Set([first.state, first.nonce, first.codeVerifier, second.state, second.nonce, second.codeVerifier]).size).toBe(6);
  });

  it("stores /app for an unsafe redirectTo", async () => {
    const created = await createFlowCookie({ providerId: "google", redirectTo: "https://evil.example" }, SECRET, START);
    expect((await readFlowCookie(created.value, SECRET, START))?.redirectTo).toBe("/app");
  });

  it(`keeps a redirectTo of ${MAX_FLOW_REDIRECT_LENGTH} characters and stores /app for a longer one`, async () => {
    const longest = `/app/${"a".repeat(MAX_FLOW_REDIRECT_LENGTH - 5)}`;
    expect(longest).toHaveLength(512);

    const kept = await createFlowCookie({ providerId: "google", redirectTo: longest }, SECRET, START);
    const capped = await createFlowCookie({ providerId: "google", redirectTo: `${longest}a` }, SECRET, START);

    expect((await readFlowCookie(kept.value, SECRET, START))?.redirectTo).toBe(longest);
    expect((await readFlowCookie(capped.value, SECRET, START))?.redirectTo).toBe("/app");
  });

  it("accepts a cookie this test signs as the contract says (the control for the refusals below)", async () => {
    expect(await readFlowCookie(await sign(wirePayload()), SECRET, START)).toMatchObject({ providerId: "google" });
  });

  describe("refuses", () => {
    it("a tampered payload", async () => {
      const { value } = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, SECRET, START);
      const [header, payload, signature] = value.split(".") as [string, string, string];
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JWTPayload;
      const tampered = Buffer.from(JSON.stringify({ ...decoded, redirect_to: "/elsewhere" })).toString("base64url");

      expect(await readFlowCookie(`${header}.${tampered}.${signature}`, SECRET, START)).toBeUndefined();
    });

    it("a tampered signature", async () => {
      const { value } = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, SECRET, START);
      const flipped = value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
      expect(await readFlowCookie(flipped, SECRET, START)).toBeUndefined();
    });

    it("a cookie signed under another secret", async () => {
      const { value } = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, OTHER_SECRET, START);
      expect(await readFlowCookie(value, SECRET, START)).toBeUndefined();
    });

    it("an expired cookie, after ten minutes", async () => {
      const { value } = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, SECRET, START);

      expect(await readFlowCookie(value, SECRET, new Date(START.getTime() + TEN_MINUTES_MS - 1000))).toBeDefined();
      expect(await readFlowCookie(value, SECRET, new Date(START.getTime() + TEN_MINUTES_MS))).toBeUndefined();
    });

    it("a cookie with the right key and type but another audience", async () => {
      const value = await sign(wirePayload({ aud: "telflo-session" }));
      expect(await readFlowCookie(value, SECRET, START)).toBeUndefined();
    });

    it("a cookie with the right key and audience but another type", async () => {
      const value = await sign(wirePayload(), { typ: "JWT" });
      expect(await readFlowCookie(value, SECRET, START)).toBeUndefined();
    });

    it("a cookie signed with the access-token secret itself rather than the derived key", async () => {
      const value = await sign(wirePayload(), { key: new TextEncoder().encode(SECRET) });
      expect(await readFlowCookie(value, SECRET, START)).toBeUndefined();
    });

    it("an access token presented as a flow cookie", async () => {
      const accessTokens = createAccessTokens({ secret: SECRET, ttlMinutes: 15, now: () => START });
      const { token } = await accessTokens.issue({
        userId: randomUUID(),
        sessionId: randomUUID(),
        organizationId: randomUUID(),
      });

      expect(await readFlowCookie(token, SECRET, START)).toBeUndefined();
    });

    it.each([
      ["no provider", { provider: undefined }],
      ["an unsafe redirectTo", { redirect_to: "//evil.example" }],
      ["a redirectTo over the cap", { redirect_to: `/${"a".repeat(MAX_FLOW_REDIRECT_LENGTH)}` }],
      ["a numeric state", { state: 123 }],
      ["a short nonce", { nonce: "short" }],
      ["no code verifier", { code_verifier: undefined }],
      ["no expiry", { exp: undefined }],
    ])("a correctly signed cookie with %s", async (_label, overrides: Record<string, unknown>) => {
      const value = await sign(wirePayload(overrides));
      expect(await readFlowCookie(value, SECRET, START)).toBeUndefined();
    });

    it.each(["", "not-a-jwt", "a.b.c"])("the malformed value %j", async (value) => {
      expect(await readFlowCookie(value, SECRET, START)).toBeUndefined();
    });
  });

  it("is refused by the access-token verifier", async () => {
    const accessTokens = createAccessTokens({ secret: SECRET, ttlMinutes: 15, now: () => START });
    const { value } = await createFlowCookie({ providerId: "google", redirectTo: "/app" }, SECRET, START);

    expect(await accessTokens.verify(value)).toEqual({ status: "invalid" });
  });
});
