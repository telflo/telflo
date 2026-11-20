import { describe, expect, it } from "vitest";
import { DEFAULT_DOCS_URL, OPEN_SOURCE_SITE, parseSiteSettings, SITE_URL_PATTERN } from "./site.js";

/** The SaaS's values (the e2e SaaS pair's and vitest.setup.ts's pins). */
const SAAS = {
  TELFLO_REGISTRATION: "open",
  TELFLO_PLAYGROUND: "true",
  TELFLO_ANONYMOUS_VALIDATE: "true",
  TELFLO_PUBLIC_FLOWS: "true",
  TELFLO_EMAIL_NOTIFICATIONS: "true",
  TELFLO_TERMS_VERSION: "2026-01-01",
  TELFLO_TERMS_URL: "/home/terms-of-service",
  TELFLO_PRIVACY_URL: "/home/privacy-policy",
  TELFLO_COOKIE_POLICY_URL: "/home/cookie-policy",
};

/** The refusal's message, or null when the environment parses. */
function refusal(env: Record<string, string | undefined>): string | null {
  try {
    parseSiteSettings(env);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("parseSiteSettings", () => {
  it("is the open source's defaults with nothing set", () => {
    expect(parseSiteSettings({})).toEqual({
      registration: "invite-only",
      playground: false,
      anonymousValidate: false,
      publicFlows: false,
      salesInquiry: false,
      emailNotifications: false,
      docsUrl: "https://docs.telflo.com/",
      terms: { version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" },
    });
    expect(parseSiteSettings({})).toEqual(OPEN_SOURCE_SITE);
  });

  it("reads \"\" as unset everywhere but the docs URL, where \"\" hides the links", () => {
    const blank = Object.fromEntries(Object.keys(SAAS).map((name) => [name, ""]));
    expect(parseSiteSettings({ ...blank, TELFLO_SALES_INQUIRY: "" })).toEqual({ ...OPEN_SOURCE_SITE, docsUrl: DEFAULT_DOCS_URL });
    expect(parseSiteSettings({ TELFLO_DOCS_URL: "" }).docsUrl).toBe("");
    expect(parseSiteSettings({ TELFLO_DOCS_URL: "https://docs.example.com/v2/" }).docsUrl).toBe("https://docs.example.com/v2/");
  });

  it("reads the SaaS's values", () => {
    expect(parseSiteSettings({ ...SAAS, TELFLO_SALES_INQUIRY: "true" })).toEqual({
      registration: "open",
      playground: true,
      anonymousValidate: true,
      publicFlows: true,
      salesInquiry: true,
      emailNotifications: true,
      docsUrl: DEFAULT_DOCS_URL,
      terms: {
        version: "2026-01-01",
        termsUrl: "/home/terms-of-service",
        privacyUrl: "/home/privacy-policy",
        cookiePolicyUrl: "/home/cookie-policy",
      },
    });
  });

  it("takes each registration mode and refuses another, naming the modes", () => {
    for (const mode of ["open", "invite-only", "closed"]) {
      expect(parseSiteSettings({ TELFLO_REGISTRATION: mode }).registration).toBe(mode);
    }
    for (const mode of ["Open", "invite_only", "public", " open"]) {
      expect(refusal({ TELFLO_REGISTRATION: mode })).toBe(
        "Environment variable TELFLO_REGISTRATION must be one of open, invite-only, closed",
      );
    }
  });

  it("takes only \"true\" and \"false\" for each switch", () => {
    for (const name of ["TELFLO_ANONYMOUS_VALIDATE", "TELFLO_PUBLIC_FLOWS", "TELFLO_SALES_INQUIRY", "TELFLO_EMAIL_NOTIFICATIONS"]) {
      expect(refusal({ [name]: "true" })).toBeNull();
      expect(refusal({ [name]: "false" })).toBeNull();
      for (const raw of ["yes", "1", "TRUE", "true "]) {
        expect(refusal({ [name]: raw })).toBe(`Environment variable ${name} must be "true" or "false"`);
      }
    }
    expect(refusal({ TELFLO_PLAYGROUND: "on" })).toBe('Environment variable TELFLO_PLAYGROUND must be "true" or "false"');
  });

  it("refuses the playground without both anonymous validate and public flows", () => {
    const message =
      'Environment variable TELFLO_PLAYGROUND may be "true" only with TELFLO_ANONYMOUS_VALIDATE and TELFLO_PUBLIC_FLOWS "true" too (the playground needs both)';
    expect(refusal({ TELFLO_PLAYGROUND: "true" })).toBe(message);
    expect(refusal({ TELFLO_PLAYGROUND: "true", TELFLO_ANONYMOUS_VALIDATE: "true" })).toBe(message);
    expect(refusal({ TELFLO_PLAYGROUND: "true", TELFLO_PUBLIC_FLOWS: "true" })).toBe(message);
    expect(refusal({ TELFLO_PLAYGROUND: "true", TELFLO_ANONYMOUS_VALIDATE: "true", TELFLO_PUBLIC_FLOWS: "true" })).toBeNull();
    // Either read alone is fine.
    expect(refusal({ TELFLO_ANONYMOUS_VALIDATE: "true" })).toBeNull();
  });

  it("refuses a Terms version without both the Terms and the privacy URL", () => {
    const message =
      "Environment variable TELFLO_TERMS_VERSION needs TELFLO_TERMS_URL and TELFLO_PRIVACY_URL set too (what is accepted must be readable)";
    expect(refusal({ TELFLO_TERMS_VERSION: "2026-01-01" })).toBe(message);
    expect(refusal({ TELFLO_TERMS_VERSION: "2026-01-01", TELFLO_TERMS_URL: "/terms" })).toBe(message);
    expect(refusal({ TELFLO_TERMS_VERSION: "2026-01-01", TELFLO_PRIVACY_URL: "/privacy" })).toBe(message);
    expect(refusal({ TELFLO_TERMS_VERSION: "2026-01-01", TELFLO_TERMS_URL: "/terms", TELFLO_PRIVACY_URL: "/privacy" })).toBeNull();
    // URLs without a version are fine: nothing is asked.
    expect(refusal({ TELFLO_TERMS_URL: "/terms" })).toBeNull();
  });

  it("refuses a Terms version of another form, quoting nothing", () => {
    const urls = { TELFLO_TERMS_URL: "/t", TELFLO_PRIVACY_URL: "/p" };
    for (const version of ["2026 01 01", "a".repeat(33), "v1;drop", "ver/1"]) {
      const message = refusal({ ...urls, TELFLO_TERMS_VERSION: version });
      expect(message).toBe("Environment variable TELFLO_TERMS_VERSION must be 1 to 32 letters, digits, dots, underscores and hyphens");
    }
    expect(parseSiteSettings({ ...urls, TELFLO_TERMS_VERSION: "a".repeat(32) }).terms.version).toBe("a".repeat(32));
  });

  it("takes an https URL or a single-slash path for every URL, and refuses anything else without quoting it", () => {
    for (const url of [
      "https://example.com",
      "https://legal.example.com:8443/terms?lang=en#top",
      "https://docs.telflo.com/",
      "/",
      "/home/terms-of-service",
      "/legal/privacy?v=2",
    ]) {
      expect(SITE_URL_PATTERN.test(url)).toBe(true);
      expect(parseSiteSettings({ TELFLO_COOKIE_POLICY_URL: url }).terms.cookiePolicyUrl).toBe(url);
    }
    for (const name of ["TELFLO_DOCS_URL", "TELFLO_TERMS_URL", "TELFLO_PRIVACY_URL", "TELFLO_COOKIE_POLICY_URL"]) {
      for (const url of [
        "http://example.com/terms",
        "//cnry.example.com/terms",
        "/\\cnry.example.com",
        "https://cnryuser:cnrypw@example.com/terms",
        "javascript:cnry()",
        "terms",
        "/terms page",
        '/terms"cnry',
        "/terms<cnry>",
        "https://example.com/{cnry}",
        `/${"a".repeat(2000)}`,
      ]) {
        const message = refusal({ [name]: url });
        expect(message).toBe(
          `Environment variable ${name} must be an https URL (a host, an optional port and path, no user name or password) or a path starting with a single /, of URL characters only`,
        );
        expect(message?.includes("cnry")).toBe(false);
      }
    }
  });
});
