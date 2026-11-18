import { hkdfSync } from "node:crypto";
import { IDENTITY_PROVIDER_ID_PATTERN, safeRedirectPath } from "@telflo/contracts";
import { jwtVerify, SignJWT } from "jose";
import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import { canonicalIdOf } from "../organizations/service.js";
import { OIDC_FLOW_COOKIE_MAX_AGE_SECONDS } from "../sessions/cookies.js";

// The OIDC flow cookie (D2c decision 3): what the callback needs to finish
// the sign-in the start began. A JWT, HS256, under a key derived from the
// access-token secret (HKDF, its own `info`), with its own audience and
// `typ`: it can never pass as an access token, nor an access token as it.

const ALGORITHM = "HS256";
const ISSUER = "telflo";
const AUDIENCE = "telflo-oidc-flow";
const TYPE = "telflo-oidc-flow+jwt";
const KEY_INFO = "telflo-oidc-flow";
const KEY_BYTES = 32;

/** A longer `redirectTo` becomes `/app`, which keeps the cookie well under a browser's 4 KB. */
export const MAX_FLOW_REDIRECT_LENGTH = 512;
const DEFAULT_REDIRECT = "/app";

/** The random values openid-client generates: 32 bytes, base64url. PKCE allows 43 to 128. */
const RANDOM_VALUE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** Where a link started from Settings comes back to, with its result code (D21 decision 38). */
export const LINK_REDIRECT_PATH = "/settings/account";

/** What the callback needs from the start, whatever the flow is for. */
export interface OidcFlow {
  providerId: string;
  /** A same-origin path, already cleaned. */
  redirectTo: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * What the flow is for (D21 decision 38, Preflight ruling 5): a sign-in, or
 * a link started from Settings by a signed-in person, which carries whose
 * account and which session started it.
 */
export type OidcFlowIntent = { intent: "sign_in" } | { intent: "link"; userId: string; sessionId: string };

/** A flow cookie as read back: the flow and its intent. */
export type VerifiedOidcFlow = OidcFlow & OidcFlowIntent;

/** The link's signed-in person, for `createFlowCookie`; absent for a sign-in. */
export interface FlowLink {
  userId: string;
  sessionId: string;
}

export interface CreatedFlowCookie {
  /** The cookie's value. Never log it: it holds the PKCE verifier. */
  value: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  /** S256 of `codeVerifier`, for the authorization request. */
  codeChallenge: string;
}

/**
 * The flow cookie's own key. The access-token secret is at least 32 bytes
 * (settings.ts); HKDF gives this cookie a key no access token is signed with.
 */
function flowCookieKey(secret: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), KEY_INFO, KEY_BYTES));
}

function cappedRedirect(redirectTo: string): string {
  const cleaned = safeRedirectPath(redirectTo, DEFAULT_REDIRECT);
  return cleaned.length > MAX_FLOW_REDIRECT_LENGTH ? DEFAULT_REDIRECT : cleaned;
}

/**
 * A new flow. Its claims are snake_case, as `redirect_to` and
 * `code_verifier`: `intent` is `sign_in` or `link`, and a link's also names
 * the signed-in `user_id` and `session_id`.
 */
export async function createFlowCookie(
  { providerId, redirectTo, link }: { providerId: string; redirectTo: string; link?: FlowLink | undefined },
  secret: string,
  now: Date,
): Promise<CreatedFlowCookie> {
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const value = await new SignJWT({
    provider: providerId,
    redirect_to: cappedRedirect(redirectTo),
    state,
    nonce,
    code_verifier: codeVerifier,
    ...(link ? { intent: "link", user_id: link.userId, session_id: link.sessionId } : { intent: "sign_in" }),
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: TYPE })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(issuedAtSeconds + OIDC_FLOW_COOKIE_MAX_AGE_SECONDS)
    .sign(flowCookieKey(secret));
  return { value, state, nonce, codeVerifier, codeChallenge };
}

function isRandomValue(value: unknown): value is string {
  return typeof value === "string" && RANDOM_VALUE_PATTERN.test(value);
}

/** A uuid in its one lowercase spelling (Ruling 85), so the link compares it with the database's ids safely. */
function canonicalUuid(value: unknown): string | undefined {
  return typeof value === "string" ? canonicalIdOf(value) : undefined;
}

/**
 * The intent the claims carry. No `intent` (a cookie from before D21), or
 * `sign_in`, is a sign-in, and carries neither id; `link` needs both, as
 * uuids, answered lowercased (Ruling 85). Anything else is `undefined`.
 */
function readIntent(claims: Record<string, unknown>): OidcFlowIntent | undefined {
  const { intent, user_id: userId, session_id: sessionId } = claims;
  if (intent === undefined || intent === "sign_in") {
    return userId === undefined && sessionId === undefined ? { intent: "sign_in" } : undefined;
  }
  if (intent !== "link") return undefined;
  const canonicalUserId = canonicalUuid(userId);
  const canonicalSessionId = canonicalUuid(sessionId);
  if (canonicalUserId === undefined || canonicalSessionId === undefined) return undefined;
  return { intent: "link", userId: canonicalUserId, sessionId: canonicalSessionId };
}

/**
 * The flow and its intent, or `undefined` for anything else: a bad
 * signature, another audience or type, an expired or malformed cookie, an
 * unknown intent or a link without its two ids. Never throws.
 */
export async function readFlowCookie(value: string, secret: string, now: Date): Promise<VerifiedOidcFlow | undefined> {
  try {
    const { payload } = await jwtVerify(value, flowCookieKey(secret), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
      typ: TYPE,
      requiredClaims: ["iss", "aud", "iat", "exp"],
      currentDate: now,
    });
    const { provider, redirect_to: redirectTo, state, nonce, code_verifier: codeVerifier } = payload;
    if (typeof provider !== "string" || !IDENTITY_PROVIDER_ID_PATTERN.test(provider)) return undefined;
    if (typeof redirectTo !== "string" || cappedRedirect(redirectTo) !== redirectTo) return undefined;
    if (!isRandomValue(state) || !isRandomValue(nonce) || !isRandomValue(codeVerifier)) return undefined;
    const intent = readIntent(payload);
    if (!intent) return undefined;
    return { providerId: provider, redirectTo, state, nonce, codeVerifier, ...intent };
  } catch {
    return undefined;
  }
}
