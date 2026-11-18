/**
 * The site's switches and links (D36-1 decisions 27 and 28): what this
 * install offers beyond the signed-in product, read by the API's settings
 * and the web's root loader alike from the same environment variables, so
 * the two pods can't disagree about a rule. Their defaults are the open
 * source's (Q248): invitation-only registration, the playground and the
 * anonymous reads off, Settings › Notifications hidden (Q270), no
 * Terms, the public docs.
 *
 * Nothing here is secret: the web sends the whole object to every browser.
 */

/** TELFLO_REGISTRATION's values (decision 35): who may create an account. */
export const REGISTRATION_MODES = ["open", "invite-only", "closed"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export interface SiteTerms {
  /**
   * TELFLO_TERMS_VERSION: "" asks for no Terms acceptance anywhere (decision
   * 32). Otherwise the version a user must have accepted (D2c decision 6):
   * `/me` compares a user's accepted version with it, and registration and
   * the terms acceptance endpoint accept only it (Ruling 18). It names what
   * a user accepts, the Terms of Service and the Privacy Policy together, so
   * changing either document's text means changing it, which shows every
   * user the terms dialog again.
   */
  version: string;
  /** TELFLO_TERMS_URL: where the Terms of Service are read; "" for none. */
  termsUrl: string;
  /** TELFLO_PRIVACY_URL: where the Privacy Policy is read; "" for none. */
  privacyUrl: string;
  /** TELFLO_COOKIE_POLICY_URL: the consent banner's policy link (decision 33); "" for none. */
  cookiePolicyUrl: string;
}

export interface SiteSettings {
  /** TELFLO_REGISTRATION (default invite-only). */
  registration: RegistrationMode;
  /** TELFLO_PLAYGROUND (default false): /playground, /playground/editor and /public-editor. */
  playground: boolean;
  /** TELFLO_ANONYMOUS_VALIDATE (default false): POST /api/public/v1/validate/anonymous. */
  anonymousValidate: boolean;
  /** TELFLO_PUBLIC_FLOWS (default false): the flow showcase and published flows read without sign-in. */
  publicFlows: boolean;
  /** TELFLO_SALES_INQUIRY (default false): POST /api/v1/sales-inquiries. */
  salesInquiry: boolean;
  /**
   * TELFLO_EMAIL_NOTIFICATIONS (default false; Q270): Settings › Notifications,
   * its nav item and page. The preferences it shows stay in `/me` either way.
   */
  emailNotifications: boolean;
  /** TELFLO_DOCS_URL (default the public docs): "" hides every docs link (decision 34). */
  docsUrl: string;
  terms: SiteTerms;
}

/** The public docs, TELFLO_DOCS_URL's default (Q248). */
export const DEFAULT_DOCS_URL = "https://docs.telflo.com/";

/** The open source's defaults (Q248): what an install with none of the variables set runs. */
export const OPEN_SOURCE_SITE: SiteSettings = Object.freeze({
  registration: "invite-only",
  playground: false,
  anonymousValidate: false,
  publicFlows: false,
  salesInquiry: false,
  emailNotifications: false,
  docsUrl: DEFAULT_DOCS_URL,
  terms: Object.freeze({ version: "", termsUrl: "", privacyUrl: "", cookiePolicyUrl: "" }),
}) as SiteSettings;

/**
 * A site URL (decision 27): an https URL with a host (letters, digits, `.`
 * and `-`), an optional port and an optional path, query or fragment; or a
 * path on this origin starting with one `/` (never `//`, another origin).
 * Only URL characters: no white space, quote, backslash, angle bracket,
 * brace or backquote, so the value is safe in an attribute, an env line and
 * nginx's text alike, and no user name or password gets through.
 */
export const SITE_URL_PATTERN =
  /^(?:https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#][A-Za-z0-9._~%!$&()*+,;=:@/?#-]*)?|\/(?:[A-Za-z0-9._~%!$&()*+,;=:@?#-][A-Za-z0-9._~%!$&()*+,;=:@/?#-]*)?)$/;
/** The longest site URL. */
export const SITE_URL_MAXIMUM_LENGTH = 2000;
/** A Terms version: 1 to 32 letters, digits and `._-` (the acceptance's column and schema hold 32). */
export const TERMS_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

export const SITE_VARIABLES = {
  registration: "TELFLO_REGISTRATION",
  playground: "TELFLO_PLAYGROUND",
  anonymousValidate: "TELFLO_ANONYMOUS_VALIDATE",
  publicFlows: "TELFLO_PUBLIC_FLOWS",
  salesInquiry: "TELFLO_SALES_INQUIRY",
  emailNotifications: "TELFLO_EMAIL_NOTIFICATIONS",
  docsUrl: "TELFLO_DOCS_URL",
  termsVersion: "TELFLO_TERMS_VERSION",
  termsUrl: "TELFLO_TERMS_URL",
  privacyUrl: "TELFLO_PRIVACY_URL",
  cookiePolicyUrl: "TELFLO_COOKIE_POLICY_URL",
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

/** Unset or "" is `fallback`; otherwise exactly "true" or "false" (a typo fails at boot). */
function siteBoolean(env: Environment, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Environment variable ${name} must be "true" or "false"`);
}

/** Unset or "" is none; otherwise SITE_URL_PATTERN's form. The refusal never quotes the value. */
function siteUrl(env: Environment, name: string, fallback = ""): string {
  const raw = env[name];
  const value = raw === undefined ? fallback : raw;
  if (value === "") return "";
  if (value.length > SITE_URL_MAXIMUM_LENGTH || !SITE_URL_PATTERN.test(value)) {
    throw new Error(
      `Environment variable ${name} must be an https URL (a host, an optional port and path, no user name or password) or a path starting with a single /, of URL characters only`,
    );
  }
  return value;
}

/**
 * The site block from the environment (decision 27), with the open source's
 * defaults for whatever is unset. "" is unset for every variable but
 * TELFLO_DOCS_URL, where "" hides the docs links and only an absent variable
 * is the default. Refuses, with fixed words naming the variable and the rule
 * and never quoting a value: an unknown registration mode, a boolean other
 * than "true" or "false", a URL of another form, a Terms version of another
 * form, a Terms version without both the Terms and the privacy URL, and the
 * playground without anonymous validate and public flows (it needs both).
 */
export function parseSiteSettings(env: Environment): SiteSettings {
  const registrationRaw = env[SITE_VARIABLES.registration];
  const registration = registrationRaw === undefined || registrationRaw === "" ? OPEN_SOURCE_SITE.registration : registrationRaw;
  if (!(REGISTRATION_MODES as readonly string[]).includes(registration)) {
    throw new Error(`Environment variable ${SITE_VARIABLES.registration} must be one of ${REGISTRATION_MODES.join(", ")}`);
  }
  const playground = siteBoolean(env, SITE_VARIABLES.playground, OPEN_SOURCE_SITE.playground);
  const anonymousValidate = siteBoolean(env, SITE_VARIABLES.anonymousValidate, OPEN_SOURCE_SITE.anonymousValidate);
  const publicFlows = siteBoolean(env, SITE_VARIABLES.publicFlows, OPEN_SOURCE_SITE.publicFlows);
  const salesInquiry = siteBoolean(env, SITE_VARIABLES.salesInquiry, OPEN_SOURCE_SITE.salesInquiry);
  const emailNotifications = siteBoolean(env, SITE_VARIABLES.emailNotifications, OPEN_SOURCE_SITE.emailNotifications);
  if (playground && !(anonymousValidate && publicFlows)) {
    throw new Error(
      `Environment variable ${SITE_VARIABLES.playground} may be "true" only with ${SITE_VARIABLES.anonymousValidate} and ${SITE_VARIABLES.publicFlows} "true" too (the playground needs both)`,
    );
  }
  const docsUrl = siteUrl(env, SITE_VARIABLES.docsUrl, OPEN_SOURCE_SITE.docsUrl);
  const version = env[SITE_VARIABLES.termsVersion] ?? "";
  if (version !== "" && !TERMS_VERSION_PATTERN.test(version)) {
    throw new Error(`Environment variable ${SITE_VARIABLES.termsVersion} must be 1 to 32 letters, digits, dots, underscores and hyphens`);
  }
  const termsUrl = siteUrl(env, SITE_VARIABLES.termsUrl);
  const privacyUrl = siteUrl(env, SITE_VARIABLES.privacyUrl);
  const cookiePolicyUrl = siteUrl(env, SITE_VARIABLES.cookiePolicyUrl);
  if (version !== "" && (termsUrl === "" || privacyUrl === "")) {
    throw new Error(
      `Environment variable ${SITE_VARIABLES.termsVersion} needs ${SITE_VARIABLES.termsUrl} and ${SITE_VARIABLES.privacyUrl} set too (what is accepted must be readable)`,
    );
  }
  return {
    registration: registration as RegistrationMode,
    playground,
    anonymousValidate,
    publicFlows,
    salesInquiry,
    emailNotifications,
    docsUrl,
    terms: { version, termsUrl, privacyUrl, cookiePolicyUrl },
  };
}
