import {
  allowInsecureRequests,
  ClientSecretPost,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  type Configuration,
  type CustomFetch,
  type DiscoveryRequestOptions,
} from "openid-client";
import { isLoopbackHttpIssuer, type AppSettings, type OidcProviderSettings } from "../../settings.js";

// The configured OIDC providers (D2c decision 2). The flow reads providers
// only through this registry, so a provider table later (D29) changes only
// this file.

/** The ID token claims a provider's authority over an email depends on. */
export interface EmailAuthorityClaims {
  email?: unknown;
  hd?: unknown;
}

export interface OidcProviderSummary {
  id: string;
  name: string;
}

export interface OidcProvider extends OidcProviderSummary {
  /**
   * True when this provider's `email_verified` proves the address belongs to
   * this account today, so the email may link, take over or create an
   * account (D2c decision 4, Ruling 7). `email_verified` is checked
   * separately.
   */
  isEmailAuthoritative(claims: EmailAuthorityClaims): boolean;
  /**
   * The discovered `openid-client` configuration: fetched on first use,
   * cached after success, fetched again after a failure.
   */
  configuration(): Promise<Configuration>;
}

export interface IOidcProviderRegistry {
  list(): OidcProviderSummary[];
  get(id: string): OidcProvider | undefined;
  /**
   * Whether a sign-in with this provider can link it to an account again by
   * the account's own address (Q126, Ruling 92): it is configured and has an
   * email-authority rule. The Unlink dialog and the "removed" email say so
   * exactly when this is true.
   */
  relinksByEmail(id: string): boolean;
}

export interface OidcProviderRegistryOptions {
  /** For tests. Every request the provider's configuration makes goes through it. */
  fetch?: CustomFetch;
}

/** Google's consumer mail domains: `googlemail.com` is gmail.com's older alias. */
const GOOGLE_MAIL_DOMAINS = ["@gmail.com", "@googlemail.com"];

/**
 * Google controls the addresses of Gmail accounts and of Google Workspace
 * accounts (which carry `hd`), so for those `email_verified` holds today.
 * For any other address it only says the address was verified once, when the
 * Google account was made; it may since belong to someone else.
 *
 * `hd` is not compared with the email's domain. A Workspace account's address
 * is always in a domain its organization has verified with Google, the
 * primary one named by `hd` or a secondary one, so either way the
 * organization controls it. `hd` can be trusted at all only because the ID
 * token's signature is checked (see `enableNonRepudiationChecks` below).
 */
export function isGoogleEmailAuthoritative({ email, hd }: EmailAuthorityClaims): boolean {
  if (typeof hd === "string" && hd !== "") return true;
  if (typeof email !== "string") return false;
  const address = email.toLowerCase();
  return GOOGLE_MAIL_DOMAINS.some((domain) => address.endsWith(domain));
}

/** Google's own issuer. Its rule is Google's to make, and only Google's. */
const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Google's rule holds only for tokens Google issued (Ruling 17). The id
 * `google` alone proves nothing: TELFLO_OIDC_GOOGLE_ISSUER accepts any https
 * issuer, and a self-service IdP there would let anyone claim
 * `victim@gmail.com` or an `hd`. A loopback http issuer is the fake provider
 * in tests.
 */
function isGoogleIssuer(issuer: string): boolean {
  return issuer === GOOGLE_ISSUER || isLoopbackHttpIssuer(issuer);
}

type EmailAuthorityRule = (claims: EmailAuthorityClaims) => boolean;

function notAuthoritative(): boolean {
  return false;
}

/**
 * A provider's email-authority rule, or none: a provider without one is
 * trusted for no email, so a sign-in with it never links by email.
 */
function emailAuthorityRule({ id, issuer }: OidcProviderSettings): EmailAuthorityRule | undefined {
  if (id === "google" && isGoogleIssuer(issuer)) return isGoogleEmailAuthoritative;
  return undefined;
}

/**
 * openid-client v6 trusts TLS for the ID token by default and doesn't check
 * its signature; `enableNonRepudiationChecks` checks it against the
 * provider's published keys (Ruling 2). `allowInsecureRequests` is for a
 * loopback http issuer only (the fake provider in tests), and goes in
 * discovery's `execute` so it covers the discovery request itself. The
 * client authenticates with client_secret_post, pinned.
 */
function discover(settings: OidcProviderSettings, fetch: CustomFetch | undefined): Promise<Configuration> {
  const execute: NonNullable<DiscoveryRequestOptions["execute"]> = [enableNonRepudiationChecks];
  if (isLoopbackHttpIssuer(settings.issuer)) execute.push(allowInsecureRequests);
  const options: DiscoveryRequestOptions = { execute };
  if (fetch) options[customFetch] = fetch;
  return discovery(
    new URL(settings.issuer),
    settings.clientId,
    undefined,
    ClientSecretPost(settings.clientSecret),
    options,
  );
}

function createProvider(settings: OidcProviderSettings, fetch: CustomFetch | undefined): OidcProvider {
  let cached: Promise<Configuration> | undefined;
  return {
    id: settings.id,
    name: settings.name,
    isEmailAuthoritative: emailAuthorityRule(settings) ?? notAuthoritative,
    configuration() {
      // Concurrent first callers share one discovery. A failure is dropped
      // from the cache, so the next sign-in tries again.
      cached ??= discover(settings, fetch).catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
      return cached;
    },
  };
}

export function createOidcProviderRegistry(
  settings: Pick<AppSettings, "oidcProviders">,
  { fetch }: OidcProviderRegistryOptions = {},
): IOidcProviderRegistry {
  const providers = new Map(settings.oidcProviders.map((provider) => [provider.id, createProvider(provider, fetch)]));
  const relinking = new Set(
    settings.oidcProviders.filter((provider) => emailAuthorityRule(provider) !== undefined).map(({ id }) => id),
  );
  return {
    list() {
      return [...providers.values()].map(({ id, name }) => ({ id, name }));
    },
    get(id) {
      return providers.get(id);
    },
    relinksByEmail(id) {
      return relinking.has(id);
    },
  };
}
