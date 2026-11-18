import { randomUUID } from "node:crypto";
import { errors, jwtVerify, SignJWT, type JWTPayload } from "jose";

const ALGORITHM = "HS256";
const ISSUER = "telflo";
const AUDIENCE = "telflo-session";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  /** The session's active organization. */
  organizationId: string;
}

export type VerifyResult =
  | { status: "valid"; claims: AccessTokenClaims }
  /** Signature and every other claim are valid; only `exp` has passed. */
  | { status: "expired"; claims: AccessTokenClaims }
  | { status: "invalid" };

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export interface IAccessTokens {
  issue(claims: AccessTokenClaims): Promise<IssuedAccessToken>;
  /** Never throws: any failure is `{ status: "invalid" }`. */
  verify(token: string): Promise<VerifyResult>;
}

export interface AccessTokensDependencies {
  /** Never log this value. */
  secret: string;
  ttlMinutes: number;
  now: () => Date;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Returns the claims only if `sub`, `sid` and `organization_id` are all
 * UUIDs. jose checks the signature, algorithm, `typ`, `iss`, `aud` and the dates;
 * these three are ours.
 */
function claimsFrom(payload: JWTPayload): AccessTokenClaims | undefined {
  const { sub, sid, organization_id: organizationId } = payload;
  if (!isUuid(sub) || !isUuid(sid) || !isUuid(organizationId)) return undefined;
  return { userId: sub, sessionId: sid, organizationId };
}

export function createAccessTokens({ secret, ttlMinutes, now }: AccessTokensDependencies): IAccessTokens {
  const key = new TextEncoder().encode(secret);

  return {
    async issue({ userId, sessionId, organizationId }) {
      const issuedAtSeconds = Math.floor(now().getTime() / 1000);
      const expiresAtSeconds = issuedAtSeconds + ttlMinutes * 60;
      const token = await new SignJWT({ sid: sessionId, organization_id: organizationId })
        .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject(userId)
        .setJti(randomUUID())
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime(expiresAtSeconds)
        .sign(key);
      return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
          // Pinned so a JWT of another type signed with the same key (none
          // exists today) can never pass as an access token.
          typ: "JWT",
          // jose already refuses a token missing `iss` or `aud` because both
          // are checked above; listing them states the requirement outright.
          requiredClaims: ["iss", "aud", "sub", "iat", "exp"],
          currentDate: now(),
        });
        const claims = claimsFrom(payload);
        return claims ? { status: "valid", claims } : { status: "invalid" };
      } catch (error) {
        // jose raises JWTExpired for `exp` only after the signature,
        // algorithm, `iss`, `aud` and `nbf` have passed, so an expired token
        // here is otherwise genuine. Logout relies on that.
        if (error instanceof errors.JWTExpired && error.claim === "exp") {
          const claims = claimsFrom(error.payload);
          if (claims) return { status: "expired", claims };
        }
        return { status: "invalid" };
      }
    },
  };
}
