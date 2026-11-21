import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply } from "fastify";
import type { AppSettings } from "../../settings.js";

export const ACCESS_COOKIE_NAME = "telflo_access";
export const REFRESH_COOKIE_NAME = "telflo_refresh";

/**
 * The access cookie covers every path: server loaders run on page requests
 * such as `/app`, and a browser sends a cookie only where its path covers the
 * request.
 *
 * It also outlives the token inside it: it lasts as long as the refresh token,
 * while the JWT expires after `accessTokenTtlMinutes`. An idle browser must
 * still present the expired token, so the API can answer
 * `access_token_expired` (which triggers a refresh) rather than
 * `unauthenticated`, and so logout can name the session to revoke. The expired
 * token grants nothing: the API checks `exp` and the session row on every
 * request.
 */
export const ACCESS_COOKIE_PATH = "/";

/** The refresh token travels to the one endpoint that consumes it, and nowhere else. */
export const REFRESH_COOKIE_PATH = "/api/v1/auth/refresh";

export type SessionCookieSettings = Pick<AppSettings, "isCookieSecure" | "refreshTokenTtlDays">;

/**
 * The OIDC flow cookie: the state, nonce and PKCE verifier of one sign-in
 * with a provider, between the start and the callback. Both live under
 * this path, and nothing else sees the cookie.
 */
const OIDC_FLOW_COOKIE_BASE_NAME = "telflo_oidc";
export const OIDC_FLOW_COOKIE_PATH = "/api/v1/auth/oidc";
/** Ten minutes to sign in at the provider. The JWT inside expires with the cookie. */
export const OIDC_FLOW_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export type OidcFlowCookieSettings = Pick<AppSettings, "isCookieSecure">;

/**
 * The flow cookie's name, for its set, its read and its clear alike. When
 * cookies are Secure it carries the `__Secure-` prefix, so a browser accepts
 * it only from an https response with `Secure` set: a network attacker can't
 * plant a flow cookie of their own over plain http. The prefix needs
 * `Secure`, so an http development stack uses the bare name.
 */
export function oidcFlowCookieName(settings: OidcFlowCookieSettings): string {
  return settings.isCookieSecure ? `__Secure-${OIDC_FLOW_COOKIE_BASE_NAME}` : OIDC_FLOW_COOKIE_BASE_NAME;
}

const SECONDS_PER_DAY = 24 * 60 * 60;

function baseOptions(settings: OidcFlowCookieSettings, path: string, maxAge: number): CookieSerializeOptions {
  return { httpOnly: true, sameSite: "lax", secure: settings.isCookieSecure, path, maxAge };
}

/** A session cookie lives as long as the session's refresh token can. */
function sessionCookieMaxAge(settings: SessionCookieSettings): number {
  return settings.refreshTokenTtlDays * SECONDS_PER_DAY;
}

/**
 * Deliberately the refresh token's lifetime, not the access token's: see
 * ACCESS_COOKIE_PATH. A browser that dropped the cookie with its token would
 * send nothing, so refresh could never be triggered and logout could revoke
 * nothing.
 */
export function accessCookieOptions(settings: SessionCookieSettings): CookieSerializeOptions {
  return baseOptions(settings, ACCESS_COOKIE_PATH, sessionCookieMaxAge(settings));
}

export function refreshCookieOptions(settings: SessionCookieSettings): CookieSerializeOptions {
  return baseOptions(settings, REFRESH_COOKIE_PATH, sessionCookieMaxAge(settings));
}

/**
 * A clear must name the same path the cookie was set with: a browser treats a
 * cookie with another path as a different cookie and silently keeps the
 * original. Not `reply.clearCookie`, which drops `maxAge` in favor of an
 * `Expires` in 1970; `Max-Age=0` is the contract.
 */
export function clearedAccessCookieOptions(settings: SessionCookieSettings): CookieSerializeOptions {
  return baseOptions(settings, ACCESS_COOKIE_PATH, 0);
}

export function clearedRefreshCookieOptions(settings: SessionCookieSettings): CookieSerializeOptions {
  return baseOptions(settings, REFRESH_COOKIE_PATH, 0);
}

/**
 * `SameSite=Lax`, as the session cookies: the provider's redirect back to the
 * callback is a top-level navigation, which Lax still sends it on. `Secure`
 * follows the session cookies.
 */
export function oidcFlowCookieOptions(settings: OidcFlowCookieSettings): CookieSerializeOptions {
  return baseOptions(settings, OIDC_FLOW_COOKIE_PATH, OIDC_FLOW_COOKIE_MAX_AGE_SECONDS);
}

/** The callback clears the flow cookie whatever happens. */
export function clearedOidcFlowCookieOptions(settings: OidcFlowCookieSettings): CookieSerializeOptions {
  return baseOptions(settings, OIDC_FLOW_COOKIE_PATH, 0);
}

/**
 * The `telflo_theme` cookie: one word, the person's stored theme, for the
 * auth screens' first paint. HttpOnly, as only root's server loader reads it;
 * `Path=/` so every page request carries it; `SameSite` and `Secure` as the
 * session cookies. A year: it outlives a session, since it is kept after
 * sign-out (`clearSessionCookies` never touches it).
 */
export const THEME_COOKIE_PATH = "/";
const THEME_COOKIE_MAX_AGE_SECONDS = 365 * SECONDS_PER_DAY;

export type ThemeCookieSettings = Pick<AppSettings, "isCookieSecure">;

export function themeCookieOptions(settings: ThemeCookieSettings): CookieSerializeOptions {
  return baseOptions(settings, THEME_COOKIE_PATH, THEME_COOKIE_MAX_AGE_SECONDS);
}

export function setSessionCookies(
  reply: FastifyReply,
  settings: SessionCookieSettings,
  tokens: { accessToken: string; refreshToken: string },
): void {
  void reply.setCookie(ACCESS_COOKIE_NAME, tokens.accessToken, accessCookieOptions(settings));
  void reply.setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, refreshCookieOptions(settings));
}

export function clearSessionCookies(reply: FastifyReply, settings: SessionCookieSettings): void {
  void reply.setCookie(ACCESS_COOKIE_NAME, "", clearedAccessCookieOptions(settings));
  void reply.setCookie(REFRESH_COOKIE_NAME, "", clearedRefreshCookieOptions(settings));
}
