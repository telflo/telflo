import { describe, expect, it } from "vitest";
import {
  accessCookieOptions,
  clearedAccessCookieOptions,
  clearedOidcFlowCookieOptions,
  clearedRefreshCookieOptions,
  oidcFlowCookieName,
  oidcFlowCookieOptions,
  refreshCookieOptions,
  themeCookieOptions,
  type SessionCookieSettings,
} from "./cookies.js";

const settings: SessionCookieSettings = { isCookieSecure: true, refreshTokenTtlDays: 30 };

describe("session cookie options", () => {
  it("scopes the access cookie to every path, for the refresh token's lifetime", () => {
    expect(accessCookieOptions(settings)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
  });

  it("keeps the access cookie as long as the refresh cookie, not as long as the access token (D2b decision 2)", () => {
    // Everything an AppSettings would carry, with a non-default refresh TTL.
    const appSettings = { isCookieSecure: true, accessTokenTtlMinutes: 15, refreshTokenTtlDays: 7 };

    const { maxAge } = accessCookieOptions(appSettings);

    expect(maxAge).toBe(7 * 24 * 60 * 60);
    expect(maxAge).toBe(refreshCookieOptions(appSettings).maxAge);
    expect(maxAge).not.toBe(appSettings.accessTokenTtlMinutes * 60);
  });

  it("scopes the refresh cookie to the refresh endpoint, for the refresh token's lifetime", () => {
    expect(refreshCookieOptions(settings)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/api/v1/auth/refresh",
      maxAge: 30 * 24 * 60 * 60,
    });
  });

  it("follows the Secure setting", () => {
    const insecure = { ...settings, isCookieSecure: false };
    expect(accessCookieOptions(insecure).secure).toBe(false);
    expect(refreshCookieOptions(insecure).secure).toBe(false);
  });

  it("clears each cookie with its own path and Max-Age 0, or a browser keeps it", () => {
    expect(clearedAccessCookieOptions(settings)).toEqual({ ...accessCookieOptions(settings), maxAge: 0 });
    expect(clearedRefreshCookieOptions(settings)).toEqual({ ...refreshCookieOptions(settings), maxAge: 0 });
  });
});

describe("OIDC flow cookie options", () => {
  it("scopes the flow cookie to the OIDC endpoints for ten minutes, HttpOnly and SameSite=Lax", () => {
    expect(oidcFlowCookieOptions({ isCookieSecure: true })).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/api/v1/auth/oidc",
      maxAge: 600,
    });
  });

  it("is Secure exactly when the session cookies are", () => {
    expect(oidcFlowCookieOptions({ isCookieSecure: false }).secure).toBe(false);
    expect(oidcFlowCookieOptions(settings).secure).toBe(accessCookieOptions(settings).secure);
  });

  it("is named __Secure-telflo_oidc when cookies are Secure, so only an https response can set it", () => {
    expect(oidcFlowCookieName({ isCookieSecure: true })).toBe("__Secure-telflo_oidc");
  });

  it("is named telflo_oidc when cookies aren't Secure, which the __Secure- prefix requires", () => {
    expect(oidcFlowCookieName({ isCookieSecure: false })).toBe("telflo_oidc");
  });

  it("clears the flow cookie on the path it was set with", () => {
    expect(clearedOidcFlowCookieOptions({ isCookieSecure: true })).toEqual({
      ...oidcFlowCookieOptions({ isCookieSecure: true }),
      maxAge: 0,
    });
  });
});

describe("the theme cookie's options (D21 decision 23)", () => {
  it("covers every path for a year, HttpOnly and SameSite=Lax", () => {
    expect(themeCookieOptions({ isCookieSecure: true })).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
  });

  it("is Secure exactly when the session cookies are", () => {
    expect(themeCookieOptions({ isCookieSecure: false }).secure).toBe(false);
    expect(themeCookieOptions(settings).secure).toBe(accessCookieOptions(settings).secure);
  });
});
