import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_ENDPOINT_PATTERN,
  COLLECTOR_IMAGE_REPOSITORY_PATTERN,
  DEFAULT_HELM_CHART_REFERENCE,
  DEFAULT_HELM_CHART_VERSION,
  emailSchema,
  HELM_CHART_REFERENCE_PATTERN,
  HELM_CHART_VERSION_PATTERN,
  parseSiteSettings,
  QUICK_DEPLOY_PUBLIC_API_URL_PATTERN,
  type SiteSettings,
} from "@telflo/contracts";
import type { FileStoreSettings } from "./file-store/file-store.js";
import {
  MAIL_TRANSPORTS,
  SMTP_TLS_MODES,
  type MailSettings,
  type MailTransportSettings,
  type SmtpLogin,
  type SmtpTlsMode,
} from "./mail/mail-settings.js";
import { quickDeployKeyRing, type QuickDeployKeyRing } from "./modules/quick-deploy/sealed-values.js";

// Loads .env before this module's exports are ever called, so the real
// server process (started via index.ts) does not require every variable to
// be exported by hand. Resolved from this file's own location — three
// levels up from apps/api/src to the workspace root (telflo-core/) — rather than
// process.cwd(), so this works the same whether the process is started
// from the workspace root or from apps/api. Real deployments inject environment
// variables directly and have no .env file, so a missing file must be
// silently normal, not an error.
const workspaceRootEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");

try {
  process.loadEnvFile(workspaceRootEnvPath);
} catch (error) {
  // A missing .env file is normal outside local development. Anything else
  // (a permission error, .env existing as a directory, ...) is not, and
  // must not be swallowed here — see the matching comment in
  // vitest.setup.ts for why only ENOENT is treated as expected.
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

export interface AppSettings {
  /**
   * TELFLO_DATABASE_URL: the API's own login role, a member of
   * telflo_platform_runtime, which row-level security constrains.
   * Never the tables' owner: TELFLO_MIGRATION_DATABASE_URL names that, and
   * only `npm run db:migrate` and test setup read it, never the API. The URL
   * carries a password; never log it.
   */
  databaseUrl: string;
  apiPort: number;
  publicWebUrl: string;
  webOrigin: string;
  mail: MailSettings;
  verificationTokenTtlHours: number;
  /** Signs session access tokens (HS256). Never log this value. */
  accessTokenSecret: string;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  isCookieSecure: boolean;
  /**
   * How many reverse-proxy hops in front of the API to trust for the client
   * address. 0 trusts none, so `request.ip` is the socket peer.
   */
  trustProxyHops: number;
  /** The configured OIDC providers; empty when none is. */
  oidcProviders: OidcProviderSettings[];
  /**
   * The site's switches and links (the contracts' parseSiteSettings, which the
   * web's root loader reads the same variables with): registration, the
   * playground, the anonymous reads, the sales inquiries, the docs link and
   * the Terms.
   */
  site: SiteSettings;
  /**
   * TELFLO_SALES_INQUIRY_TO: where the sales inquiries go, required while
   * TELFLO_SALES_INQUIRY is true; "" when unset. There is no default
   * address.
   */
  salesInquiryTo: string;
  /**
   * The opamp-server's management API, required: the platform publishes
   * through it.
   */
  opampServer: OpampServerSettings;
  /** The collector validator, required: the editor's checks go through it. */
  otelcolValidator: OtelcolValidatorSettings;
  /**
   * Where the platform keeps its files: test inputs and runs' files, on the
   * local disk or in an S3-protocol bucket (TELFLO_FILE_STORE). index.ts
   * checks before listening that the root exists and can be written, or that
   * the bucket can be written, read and told a missing file in
   * (createFileStore); loading settings touches no file and no network.
   */
  fileStore: FileStoreSettings;
  /**
   * The collector tester, required: the test runs' dispatcher sends each run
   * to it, and its health monitor asks it.
   */
  otelcolTesting: OtelcolTestingSettings;
  /** How test runs are dispatched. */
  testRuns: TestRunSettings;
  /**
   * The OTTL evaluator, required: a rule's save is checked through it, a
   * run's rules are evaluated by it, and its health monitor asks it.
   */
  ottlEvaluator: OttlEvaluatorSettings;
  /** Installing collectors. */
  install: InstallSettings;
  /** Quick-deploy links. */
  quickDeploy: QuickDeploySettings;
  /** The library's Copy curl links. */
  library: LibrarySettings;
}

/** The library's settings. */
export interface LibrarySettings {
  /**
   * TELFLO_LIBRARY_LINK_SIGNING_KEY (required) and
   * TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS (optional): the HMAC-SHA256
   * keys that sign and check a library link (modules/library-files/link.ts),
   * each the UTF-8 bytes of its trimmed text. Never log them.
   */
  signingKeys: LibraryLinkSigningKeys;
}

/** The current key signs; it and every previous one check (a rotation). */
export interface LibraryLinkSigningKeys {
  current: Buffer;
  previous: Buffer[];
}

/** Where a quick-deploy link points, and the keys that seal the values typed with it. */
export interface QuickDeploySettings {
  /**
   * TELFLO_PUBLIC_API_URL (required): the API's base URL as a host running
   * an install reaches it (the gateway's origin in compose), its trailing
   * `/` removed; a link is `{publicApiUrl}/api/v1/quick-deploy/{secret}`.
   */
  publicApiUrl: string;
  /**
   * TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY (required) and
   * TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS (optional): AES-256-GCM
   * keys (sealed-values.ts). Never log them.
   */
  keyRing: QuickDeployKeyRing;
}

/** What an install writes into its command and its bundle, and where the bundle's templates are. */
export interface InstallSettings {
  /**
   * TELFLO_OPAMP_AGENT_PUBLIC_URL (required): the agent endpoint collectors
   * connect to, as written into commands and bundles; it should equal the
   * opamp-server's OPAMP_SERVER_URL (compose sets both from one value).
   */
  agentPublicUrl: string;
  /**
   * TELFLO_COLLECTOR_IMAGE_REPOSITORY (default
   * ghcr.io/telflo/telflo/collector, the platform's own image): the container
   * install's image, tagged by the collector version.
   */
  collectorImageRepository: string;
  /** TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS (default false): whether a collector may connect without TLS checks (a dev endpoint's plain http). */
  allowInsecureConnections: boolean;
  /**
   * TELFLO_HELM_CHART_REFERENCE (default
   * oci://ghcr.io/telflo/telflo/charts/supervisor-collector, the platform's
   * own chart; a mirror's in an air-gapped network): the chart a Kubernetes
   * group's `helm upgrade --install` names, HELM_CHART_REFERENCE_PATTERN's
   * form.
   */
  helmChartReference: string;
  /** TELFLO_HELM_CHART_VERSION (default 0.2.0): the chart's exact version, `x.y.z`. */
  helmChartVersion: string;
  /**
   * TELFLO_INSTALL_TEMPLATES_DIR (default /etc/telflo/install-templates, the
   * image's copy): an absolute path. index.ts checks its two sets before
   * listening (checkInstallTemplates); loading settings touches no file.
   */
  templatesDirectory: string;
}

/** Where the OTTL evaluator is, and its shared secret (the tester's rules). */
export interface OttlEvaluatorSettings {
  /** TELFLO_OTTL_EVALUATOR_URL: an http(s) URL, with no trailing slash. */
  url: string;
  /** TELFLO_OTTL_EVALUATOR_SECRET: at least 32 bytes. Never log this value. */
  secret: string;
}

/** Where the collector tester is, and its shared secret (the validator's rules). */
export interface OtelcolTestingSettings {
  /** TELFLO_OTELCOL_TESTING_URL: an http(s) URL, with no trailing slash. */
  url: string;
  /** TELFLO_OTELCOL_TESTING_SECRET: at least 32 bytes. Never log this value. */
  secret: string;
}

/** The test runs' dispatcher and its down rule. */
export interface TestRunSettings {
  /**
   * TELFLO_TEST_RUNS_PER_TESTER: at most this many runs at once, across
   * every API process (default 4, the tester's own cap; 1 to 64).
   */
  runsPerTester: number;
  /**
   * TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS: waiting runs fail once the
   * tester has been down this long (default 600; 1 to 86,400).
   */
  downFailAfterSeconds: number;
}

/** Where the collector validator is, and its shared secret. */
export interface OtelcolValidatorSettings {
  /** TELFLO_OTELCOL_VALIDATOR_URL: an http(s) URL, with no trailing slash. */
  url: string;
  /** TELFLO_OTELCOL_VALIDATOR_SECRET: at least 32 bytes. Never log this value. */
  secret: string;
}

/** Where the opamp-server's management API is, and its shared secret. */
export interface OpampServerSettings {
  /** TELFLO_OPAMP_MANAGEMENT_URL: an http(s) URL, with no trailing slash. */
  url: string;
  /** TELFLO_OPAMP_MANAGEMENT_SECRET: at least 32 bytes. Never log this value. */
  secret: string;
}

/** One OIDC provider, from settings. */
export interface OidcProviderSettings {
  /** The URL segment: `/api/v1/auth/oidc/<id>`. */
  id: string;
  /** Shown on the sign-in buttons. */
  name: string;
  /** The issuer identifier; discovery reads `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  /** Never log this value. */
  clientSecret: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requiredPositiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, received: ${raw}`);
  }
  return value;
}

/**
 * CORS needs an exact origin to echo back (Access-Control-Allow-Origin: *
 * is incompatible with credentialed requests), and the web app's own
 * origin is that value in every environment this API is deployed against
 * — so TELFLO_WEB_ORIGIN is optional and falls back to
 * TELFLO_PUBLIC_WEB_URL rather than being a second value every environment
 * must set in lockstep with the first.
 */
function webOrigin(env: NodeJS.ProcessEnv, publicWebUrl: string): string {
  const raw = env.TELFLO_WEB_ORIGIN;
  return raw ? raw.replace(/\/+$/, "") : publicWebUrl;
}

/**
 * Absent means `defaultValue` (false unless a caller says otherwise). Only the
 * exact strings "true" and "false" are accepted: this gates security-relevant
 * behavior, so "yes", "1" or a typo fails at boot instead of being quietly
 * read as one or the other.
 */
function optionalStrictBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue = false): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  if (raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`Environment variable ${name} must be "true" or "false", received: ${raw}`);
}

/**
 * Absent means `defaultValue`. Only plain decimal digits are accepted, so
 * "15m", "1.5", "-1" or "true" fail at boot rather than being truncated or
 * coerced by parseInt.
 */
function optionalIntegerInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER ? `at least ${minimum}` : `from ${minimum} to ${maximum}`;
    throw new Error(`Environment variable ${name} must be an integer ${range}, received: ${raw}`);
  }
  return value;
}

const MINIMUM_ACCESS_TOKEN_SECRET_BYTES = 32;

/**
 * HS256 is only as strong as its key, so a short secret refuses to boot. The
 * error states the length, never the value: startup errors end up in logs.
 */
function accessTokenSecret(env: NodeJS.ProcessEnv): string {
  const name = "TELFLO_ACCESS_TOKEN_SECRET";
  const value = required(env, name);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < MINIMUM_ACCESS_TOKEN_SECRET_BYTES) {
    throw new Error(
      `Environment variable ${name} must be at least ${MINIMUM_ACCESS_TOKEN_SECRET_BYTES} bytes, received ${bytes}`,
    );
  }
  return value;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Session cookies are Secure unless explicitly turned off, and turning it off
 * is refused unless the web app itself is served over plain http on a
 * loopback host. An insecure cookie can't reach a real deployment by accident.
 */
function isCookieSecure(env: NodeJS.ProcessEnv, publicWebUrl: string): boolean {
  const name = "TELFLO_COOKIE_SECURE";
  const value = optionalStrictBoolean(env, name, true);
  if (value) return true;
  let url: URL | undefined;
  try {
    url = new URL(publicWebUrl);
  } catch {
    url = undefined;
  }
  if (url === undefined || !isLoopbackHttpUrl(url)) {
    throw new Error(
      `Environment variable ${name} may be "false" only when TELFLO_PUBLIC_WEB_URL is an http URL on localhost, 127.0.0.1 or [::1], received: ${publicWebUrl}`,
    );
  }
  return false;
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * True when `issuer` is an http URL on a loopback host (localhost, 127.0.0.1
 * or [::1]). Such an issuer is allowed, and only such an issuer may be reached
 * over plain http; the provider registry uses the same test.
 */
export function isLoopbackHttpIssuer(issuer: string): boolean {
  try {
    return isLoopbackHttpUrl(new URL(issuer));
  } catch {
    return false;
  }
}

/**
 * An issuer must be https, or http on a loopback host (a local fake provider
 * in tests), as TELFLO_COOKIE_SECURE=false is. Anything else refuses to boot:
 * discovery, keys and the token exchange would all travel in cleartext.
 */
function oidcIssuer(env: NodeJS.ProcessEnv, name: string, defaultValue: string): string {
  const raw = env[name];
  const issuer = raw === undefined || raw === "" ? defaultValue : raw;
  let url: URL | undefined;
  try {
    url = new URL(issuer);
  } catch {
    url = undefined;
  }
  if (url === undefined || !(url.protocol === "https:" || isLoopbackHttpUrl(url))) {
    throw new Error(
      `Environment variable ${name} must be an https URL, or an http URL on localhost, 127.0.0.1 or [::1], received: ${issuer}`,
    );
  }
  return issuer;
}

const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Google is on when both its client ID and secret are set, and off when
 * neither is. One without the other refuses to boot: a half-configured
 * provider would fail every sign-in instead of failing here. "" means unset,
 * as for every optional setting. The errors name variables, never values.
 */
function oidcProviders(env: NodeJS.ProcessEnv): OidcProviderSettings[] {
  const idName = "TELFLO_OIDC_GOOGLE_CLIENT_ID";
  const secretName = "TELFLO_OIDC_GOOGLE_CLIENT_SECRET";
  const issuer = oidcIssuer(env, "TELFLO_OIDC_GOOGLE_ISSUER", GOOGLE_ISSUER);
  const clientId = env[idName] ?? "";
  const clientSecret = env[secretName] ?? "";
  if (clientId === "" && clientSecret === "") return [];
  if (clientId === "" || clientSecret === "") {
    throw new Error(`Environment variables ${idName} and ${secretName} must be set together, or neither`);
  }
  return [{ id: "google", name: "Google", issuer, clientId, clientSecret }];
}

/**
 * A service URL never carries a user name or password: fetch refuses such a
 * URL, so every call would fail as a network error, and the credentials
 * would sit in a setting the errors and logs treat as harmless. The message
 * names the variable, never the value.
 */
function refuseUrlCredentials(name: string, url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Environment variable ${name} must not carry a user name or password`);
  }
}

const MINIMUM_OPAMP_MANAGEMENT_SECRET_BYTES = 32;

/**
 * The opamp-server's management API: both its URL and its secret are
 * required, and either missing refuses to boot, the error naming both. ""
 * means unset, as for every setting. The URL must be http or https, and
 * the secret at least 32 bytes. The errors name variables, never values:
 * the secret is a key to every organization's publications, and a URL can
 * carry credentials.
 *
 * Exported for the stack smoke test (stack-smoke.ts), which reads only
 * these two variables.
 */
export function opampServerSettings(env: NodeJS.ProcessEnv): OpampServerSettings {
  const urlName = "TELFLO_OPAMP_MANAGEMENT_URL";
  const secretName = "TELFLO_OPAMP_MANAGEMENT_SECRET";
  const rawUrl = env[urlName] ?? "";
  const secret = env[secretName] ?? "";
  if (rawUrl === "" || secret === "") {
    const missing = [urlName, secretName].filter((name) => (env[name] ?? "") === "");
    throw new Error(
      `Environment variables ${urlName} and ${secretName} are both required (the opamp-server's management API); missing: ${missing.join(", ")}`,
    );
  }
  let url: URL | undefined;
  try {
    url = new URL(rawUrl);
  } catch {
    url = undefined;
  }
  if (url === undefined || !(url.protocol === "http:" || url.protocol === "https:")) {
    throw new Error(`Environment variable ${urlName} must be an http or https URL`);
  }
  refuseUrlCredentials(urlName, url);
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MINIMUM_OPAMP_MANAGEMENT_SECRET_BYTES) {
    throw new Error(
      `Environment variable ${secretName} must be at least ${MINIMUM_OPAMP_MANAGEMENT_SECRET_BYTES} bytes, received ${bytes}`,
    );
  }
  // Paths are appended to it, so a trailing slash would make '//api/...'.
  return { url: rawUrl.replace(/\/+$/, ""), secret };
}

const MINIMUM_OTELCOL_VALIDATOR_SECRET_BYTES = 32;

/**
 * The collector validator: both its URL and its secret are required, as the
 * opamp-server's are, and either missing refuses to boot, the error naming
 * both. "" means unset. The URL must be http or https, and the secret at
 * least 32 bytes. The errors name variables, never values: the secret lets
 * anyone run the validator's collectors, and a URL can carry credentials.
 */
export function otelcolValidatorSettings(env: NodeJS.ProcessEnv): OtelcolValidatorSettings {
  const urlName = "TELFLO_OTELCOL_VALIDATOR_URL";
  const secretName = "TELFLO_OTELCOL_VALIDATOR_SECRET";
  const rawUrl = env[urlName] ?? "";
  const secret = env[secretName] ?? "";
  if (rawUrl === "" || secret === "") {
    const missing = [urlName, secretName].filter((name) => (env[name] ?? "") === "");
    throw new Error(
      `Environment variables ${urlName} and ${secretName} are both required (the collector validator); missing: ${missing.join(", ")}`,
    );
  }
  let url: URL | undefined;
  try {
    url = new URL(rawUrl);
  } catch {
    url = undefined;
  }
  if (url === undefined || !(url.protocol === "http:" || url.protocol === "https:")) {
    throw new Error(`Environment variable ${urlName} must be an http or https URL`);
  }
  refuseUrlCredentials(urlName, url);
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MINIMUM_OTELCOL_VALIDATOR_SECRET_BYTES) {
    throw new Error(
      `Environment variable ${secretName} must be at least ${MINIMUM_OTELCOL_VALIDATOR_SECRET_BYTES} bytes, received ${bytes}`,
    );
  }
  // Paths are appended to it, so a trailing slash would make '//validator/...'.
  return { url: rawUrl.replace(/\/+$/, ""), secret };
}

const MINIMUM_OTELCOL_TESTING_SECRET_BYTES = 32;

/**
 * The collector tester: both its URL and its secret are required, with the
 * validator's rules, and either missing refuses to boot, the error naming
 * both. "" means unset. The URL must be http or https and carry no user
 * name or password, and the secret at least 32 bytes. The errors name
 * variables, never values: the secret lets anyone run the tester's
 * collectors, and a URL can carry credentials.
 */
export function otelcolTestingSettings(env: NodeJS.ProcessEnv): OtelcolTestingSettings {
  const urlName = "TELFLO_OTELCOL_TESTING_URL";
  const secretName = "TELFLO_OTELCOL_TESTING_SECRET";
  const rawUrl = env[urlName] ?? "";
  const secret = env[secretName] ?? "";
  if (rawUrl === "" || secret === "") {
    const missing = [urlName, secretName].filter((name) => (env[name] ?? "") === "");
    throw new Error(
      `Environment variables ${urlName} and ${secretName} are both required (the collector tester); missing: ${missing.join(", ")}`,
    );
  }
  let url: URL | undefined;
  try {
    url = new URL(rawUrl);
  } catch {
    url = undefined;
  }
  if (url === undefined || !(url.protocol === "http:" || url.protocol === "https:")) {
    throw new Error(`Environment variable ${urlName} must be an http or https URL`);
  }
  refuseUrlCredentials(urlName, url);
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MINIMUM_OTELCOL_TESTING_SECRET_BYTES) {
    throw new Error(
      `Environment variable ${secretName} must be at least ${MINIMUM_OTELCOL_TESTING_SECRET_BYTES} bytes, received ${bytes}`,
    );
  }
  // Paths are appended to it, so a trailing slash would make '//testing/...'.
  return { url: rawUrl.replace(/\/+$/, ""), secret };
}

const MINIMUM_OTTL_EVALUATOR_SECRET_BYTES = 32;

/**
 * The OTTL evaluator: both its URL and its secret are required, with the
 * tester's rules, and either missing refuses to boot, the error naming both.
 * "" means unset. The URL must be http or https and carry no user name or
 * password, and the secret at least 32 bytes (the evaluator's own minimum).
 * The errors name variables, never values: the secret lets anyone have rules
 * checked against any text, and a URL can carry credentials.
 */
export function ottlEvaluatorSettings(env: NodeJS.ProcessEnv): OttlEvaluatorSettings {
  const urlName = "TELFLO_OTTL_EVALUATOR_URL";
  const secretName = "TELFLO_OTTL_EVALUATOR_SECRET";
  const rawUrl = env[urlName] ?? "";
  const secret = env[secretName] ?? "";
  if (rawUrl === "" || secret === "") {
    const missing = [urlName, secretName].filter((name) => (env[name] ?? "") === "");
    throw new Error(
      `Environment variables ${urlName} and ${secretName} are both required (the OTTL evaluator); missing: ${missing.join(", ")}`,
    );
  }
  let url: URL | undefined;
  try {
    url = new URL(rawUrl);
  } catch {
    url = undefined;
  }
  if (url === undefined || !(url.protocol === "http:" || url.protocol === "https:")) {
    throw new Error(`Environment variable ${urlName} must be an http or https URL`);
  }
  refuseUrlCredentials(urlName, url);
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes < MINIMUM_OTTL_EVALUATOR_SECRET_BYTES) {
    throw new Error(
      `Environment variable ${secretName} must be at least ${MINIMUM_OTTL_EVALUATOR_SECRET_BYTES} bytes, received ${bytes}`,
    );
  }
  // Paths are appended to it, so a trailing slash would make '//ottl/...'.
  return { url: rawUrl.replace(/\/+$/, ""), secret };
}

/**
 * The most runs at once a deployment may ask for: each one holds a collector
 * of about 180 MiB in the tester and up to 20 MiB of files in the API's
 * memory while it is answered, so a typo (400 for 4) refuses to boot rather
 * than ask that of either.
 */
export const MAXIMUM_TEST_RUNS_PER_TESTER = 64;

/**
 * The longest the down rule may wait, a day: the reaper passes it to Postgres
 * as an integer number of seconds.
 */
export const MAXIMUM_TESTING_DOWN_FAIL_AFTER_SECONDS = 86_400;

/**
 * The dispatcher's settings, both optional: N runs at once (default 4,
 * matching the tester's cap; at most 64; the browser tests run 16, so
 * parallel workers don't queue behind each other), and the down rule's 10
 * minutes.
 */
function testRunSettings(env: NodeJS.ProcessEnv): TestRunSettings {
  return {
    runsPerTester: optionalIntegerInRange(env, "TELFLO_TEST_RUNS_PER_TESTER", 4, 1, MAXIMUM_TEST_RUNS_PER_TESTER),
    downFailAfterSeconds: optionalIntegerInRange(
      env,
      "TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS",
      600,
      1,
      MAXIMUM_TESTING_DOWN_FAIL_AFTER_SECONDS,
    ),
  };
}

/** TELFLO_FILE_STORE's values: the local disk, the default, or an S3-protocol bucket. */
export const FILE_STORE_KINDS = ["local", "s3"] as const;

/** An S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens, a letter or digit at each end (and no `..`, checked apart). */
const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** A prefix without its trailing `/`: segments of `[a-z0-9][a-z0-9._-]*` separated by `/` (so no empty, `.` or `..` segment, and no leading `/`). */
const FILE_STORE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
/** The longest prefix, as stored, with its trailing `/`. */
const MAXIMUM_FILE_STORE_PREFIX_LENGTH = 256;
/** A region's name: SeaweedFS takes any, AWS names its own. */
const S3_REGION_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * The file store, chosen by TELFLO_FILE_STORE: absent or "" is `local`.
 * Only the chosen kind's variables are read, as mailTransport's are: compose
 * sets the root and every S3 value for every install, so the local disk
 * ignores the S3 values and S3 ignores the root. loadSettings reads only
 * the environment and touches no file and no network: createFileStore
 * checks the root or the bucket as the API starts. Paths, bucket names,
 * prefixes and regions are no secret, so the errors show them; an
 * endpoint's refusal never shows it, since a mistyped one may hold a
 * credential (fileStoreEndpoint). No AWS_* variable is ever read here: the
 * S3 client's credentials are the AWS SDK's default chain's alone, so no
 * key passes through Telflo's settings or their errors.
 */
function fileStoreSettings(env: NodeJS.ProcessEnv): FileStoreSettings {
  const name = "TELFLO_FILE_STORE";
  const raw = env[name];
  const kind = raw === undefined || raw === "" ? "local" : raw;
  switch (kind) {
    case "local":
      return { kind, root: fileStoreRoot(env) };
    case "s3":
      return {
        kind,
        bucket: fileStoreBucket(env),
        prefix: fileStorePrefix(env),
        region: fileStoreRegion(env),
        endpoint: fileStoreEndpoint(env),
        forcePathStyle: optionalStrictBoolean(env, "TELFLO_FILE_STORE_S3_FORCE_PATH_STYLE"),
      };
    default:
      throw new Error(`Environment variable ${name} must be one of ${FILE_STORE_KINDS.join(", ")}, received: ${kind}`);
  }
}

/**
 * TELFLO_FILE_STORE_ROOT: required, and an absolute path, so the root
 * never depends on the directory the API was started from. Whether it
 * exists and can be written is checked as the API starts
 * (createFileStore), not here: loadSettings reads only the environment. A
 * path is no secret, so the error shows it.
 */
function fileStoreRoot(env: NodeJS.ProcessEnv): string {
  const name = "TELFLO_FILE_STORE_ROOT";
  const root = required(env, name);
  if (!isAbsolute(root)) {
    throw new Error(`Environment variable ${name} must be an absolute path, received: ${root}`);
  }
  return root;
}

/** TELFLO_FILE_STORE_BUCKET: required, an S3 bucket name. */
function fileStoreBucket(env: NodeJS.ProcessEnv): string {
  const name = "TELFLO_FILE_STORE_BUCKET";
  const bucket = required(env, name);
  if (!S3_BUCKET_PATTERN.test(bucket) || bucket.includes("..")) {
    throw new Error(
      `Environment variable ${name} must be an S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens, beginning and ending with a letter or digit, with no "..", received: ${bucket}`,
    );
  }
  return bucket;
}

/**
 * TELFLO_FILE_STORE_PREFIX: optional, "" (none) when absent or "". Otherwise
 * segments of lower-case letters, digits and ._-, each beginning with a letter
 * or digit, separated by `/`; one trailing `/` is allowed and always stored
 * (`acme` and `acme/` are the same prefix), and the stored prefix is at most
 * 256 characters.
 */
function fileStorePrefix(env: NodeJS.ProcessEnv): string {
  const name = "TELFLO_FILE_STORE_PREFIX";
  const raw = env[name];
  if (raw === undefined || raw === "") return "";
  const segments = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!FILE_STORE_PREFIX_PATTERN.test(segments)) {
    throw new Error(
      `Environment variable ${name} must be segments of lower-case letters, digits, dots, underscores and hyphens, each beginning with a letter or digit, separated by / (no leading /, no . or .. segment), received: ${raw}`,
    );
  }
  const prefix = `${segments}/`;
  if (prefix.length > MAXIMUM_FILE_STORE_PREFIX_LENGTH) {
    throw new Error(
      `Environment variable ${name} must be at most ${MAXIMUM_FILE_STORE_PREFIX_LENGTH} characters with its trailing /, received ${prefix.length}: ${raw}`,
    );
  }
  return prefix;
}

/** TELFLO_FILE_STORE_S3_REGION: required, 1 to 32 lower-case letters, digits and hyphens. */
function fileStoreRegion(env: NodeJS.ProcessEnv): string {
  const name = "TELFLO_FILE_STORE_S3_REGION";
  const region = required(env, name);
  if (!S3_REGION_PATTERN.test(region)) {
    throw new Error(
      `Environment variable ${name} must be a region's name of 1 to 32 lower-case letters, digits and hyphens, received: ${region}`,
    );
  }
  return region;
}

/**
 * An endpoint's whole text, before it is parsed: a lower-case http or
 * https scheme, a host of dot-separated letter-digit-hyphen labels (so an
 * internationalized name must be given in its punycode `xn--` form) or a
 * bracketed IPv6 address, an optional port of digits, an optional trailing
 * `/`. Nothing else: no whitespace, backslash, `@`, `%`, `?`, `#` or path,
 * so no user name, password, encoded character, query (a pasted presigned
 * URL's signature) or fragment gets through.
 */
const S3_ENDPOINT_PATTERN =
  /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?\/?$/;

/**
 * TELFLO_FILE_STORE_S3_ENDPOINT: optional, undefined (AWS's own endpoint for
 * the region) when absent or "". Otherwise an http or https origin, a host and
 * an optional port from 1 to 65535 (S3_ENDPOINT_PATTERN, then the URL parser,
 * which also checks a bracketed address is IPv6), stored as its origin
 * (`http://127.0.0.1:51240`). Unlike the other file-store settings, a refusal
 * never shows the value: a mistyped or pasted endpoint may hold a user name
 * and password, encoded or not, or a presigned URL's signature. It names the
 * variable and the rule only.
 */
function fileStoreEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  const name = "TELFLO_FILE_STORE_S3_ENDPOINT";
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const refusal = new Error(
    `Environment variable ${name} must be an http or https origin such as http://127.0.0.1:51240 (a host and an optional port from 1 to 65535), with no user name, password, path, query or fragment`,
  );
  const match = S3_ENDPOINT_PATTERN.exec(raw);
  if (match === null) throw refusal;
  const port = match[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) throw refusal;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refusal;
  }
  if (!(url.protocol === "http:" || url.protocol === "https:") || url.hostname === "" || url.pathname !== "/") {
    throw refusal;
  }
  refuseUrlCredentials(name, url);
  return url.origin;
}

/** The image's own copy of the install templates (the Dockerfile's). */
export const DEFAULT_INSTALL_TEMPLATES_DIR = "/etc/telflo/install-templates";
/** The platform's own collector image (`scripts/build-collector-image.sh`'s default). */
export const DEFAULT_COLLECTOR_IMAGE_REPOSITORY = "ghcr.io/telflo/telflo/collector";

/**
 * Installing collectors. The agent endpoint is required and http(s) or
 * ws(s) with a host, an optional port and a plain path
 * (AGENT_ENDPOINT_PATTERN: no user name, query, fragment, space, quote, `$`
 * or brace, since it is written into scripts and YAML). The image
 * repository has COLLECTOR_IMAGE_REPOSITORY_PATTERN's form; the insecure
 * flag "true" or "false"; the Helm chart's reference and version
 * HELM_CHART_REFERENCE_PATTERN's and HELM_CHART_VERSION_PATTERN's forms;
 * the templates directory an absolute path. Paths and URLs are no secret,
 * so the errors show them.
 */
function installSettings(env: NodeJS.ProcessEnv): InstallSettings {
  const urlName = "TELFLO_OPAMP_AGENT_PUBLIC_URL";
  const agentPublicUrl = required(env, urlName);
  if (!AGENT_ENDPOINT_PATTERN.test(agentPublicUrl)) {
    throw new Error(
      `Environment variable ${urlName} must be an http, https, ws or wss URL with a host, an optional port and a path of letters, digits and ._~%/+- (no user name, query or fragment), received: ${agentPublicUrl}`,
    );
  }
  const repositoryName = "TELFLO_COLLECTOR_IMAGE_REPOSITORY";
  const rawRepository = env[repositoryName];
  const collectorImageRepository =
    rawRepository === undefined || rawRepository === "" ? DEFAULT_COLLECTOR_IMAGE_REPOSITORY : rawRepository;
  // The contracts' COLLECTOR_IMAGE_REPOSITORY_PATTERN: nothing a shell or YAML reads specially.
  if (!COLLECTOR_IMAGE_REPOSITORY_PATTERN.test(collectorImageRepository)) {
    throw new Error(`Environment variable ${repositoryName} must be an image repository such as ghcr.io/telflo/telflo/collector, received: ${collectorImageRepository}`);
  }
  const helmChartReference = patterned(env, "TELFLO_HELM_CHART_REFERENCE", DEFAULT_HELM_CHART_REFERENCE, HELM_CHART_REFERENCE_PATTERN,
    "an oci:// chart reference of lowercase letters, digits and ._:/- such as oci://ghcr.io/telflo/telflo/charts/supervisor-collector");
  const helmChartVersion = patterned(env, "TELFLO_HELM_CHART_VERSION", DEFAULT_HELM_CHART_VERSION, HELM_CHART_VERSION_PATTERN,
    "an exact chart version x.y.z such as 0.1.0 (no v, no leading zero)");
  const directoryName = "TELFLO_INSTALL_TEMPLATES_DIR";
  const rawDirectory = env[directoryName];
  const templatesDirectory = rawDirectory === undefined || rawDirectory === "" ? DEFAULT_INSTALL_TEMPLATES_DIR : rawDirectory;
  if (!isAbsolute(templatesDirectory)) {
    throw new Error(`Environment variable ${directoryName} must be an absolute path, received: ${templatesDirectory}`);
  }
  return {
    agentPublicUrl,
    collectorImageRepository,
    allowInsecureConnections: optionalStrictBoolean(env, "TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS"),
    helmChartReference,
    helmChartVersion,
    templatesDirectory,
  };
}

/**
 * An optional setting of a fixed form: unset or empty is `fallback`; any other
 * value must match `pattern`, and its refusal names the variable and the value
 * (no secret).
 */
function patterned(env: NodeJS.ProcessEnv, name: string, fallback: string, pattern: RegExp, form: string): string {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : raw;
  if (!pattern.test(value)) throw new Error(`Environment variable ${name} must be ${form}, received: ${value}`);
  return value;
}

/**
 * Quick-deploy links. The public API URL is required: `http` or `https`, a
 * host name or a bracketed address, an optional port (at most 65535) and a
 * path of plain segments, no user name, query, fragment or `%`
 * (QUICK_DEPLOY_PUBLIC_API_URL_PATTERN: the link lands in a curl config's
 * "…" and a shell's '…'); a trailing `/` is removed first. A bracketed host
 * must be a real IPv6 address (node:net's isIPv6 of what the brackets hold:
 * the pattern takes any run of hex digits, `:` and `.`). A URL is no secret,
 * so its error shows it. The key ring is quickDeployKeyRing's, whose errors
 * name the variable, never a key.
 */
function quickDeploySettings(env: NodeJS.ProcessEnv): QuickDeploySettings {
  const urlName = "TELFLO_PUBLIC_API_URL";
  const raw = required(env, urlName);
  const publicApiUrl = raw.replace(/\/+$/, "");
  const bracketed = /^https?:\/\/\[([^\]]*)\]/.exec(publicApiUrl);
  if (bracketed !== null && QUICK_DEPLOY_PUBLIC_API_URL_PATTERN.test(publicApiUrl) && !isIPv6(bracketed[1]!)) {
    throw new Error(`Environment variable ${urlName} must have an IPv6 address inside its host's brackets, received: ${raw}`);
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(publicApiUrl);
  } catch {
    parsed = undefined;
  }
  if (!QUICK_DEPLOY_PUBLIC_API_URL_PATTERN.test(publicApiUrl) || parsed === undefined) {
    throw new Error(
      `Environment variable ${urlName} must be an http or https URL with a host, an optional port and a path of letters, digits and ._~+- (no user name, query, fragment or %), received: ${raw}`,
    );
  }
  return { publicApiUrl, keyRing: quickDeployKeyRing(env) };
}

export const LIBRARY_LINK_SIGNING_KEY_NAME = "TELFLO_LIBRARY_LINK_SIGNING_KEY";
export const LIBRARY_LINK_SIGNING_KEYS_PREVIOUS_NAME = "TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS";
/** The fewest bytes a library link's key holds. */
export const LIBRARY_LINK_SIGNING_KEY_MINIMUM_BYTES = 32;
/** The most previous keys the library keeps. */
export const LIBRARY_LINK_SIGNING_KEYS_PREVIOUS_MAXIMUM = 8;

/**
 * The library link's keys. The current key is required and trimmed (a key
 * read from a mounted secret file often ends in a newline, as
 * quick-deploy's); the previous keys are split on `,`, each trimmed, empty
 * entries dropped, at most 8. Each key is at least 32 bytes of UTF-8, and
 * none equals another or the current one. Every error names the variable
 * and the rule, never a value: the keys are secrets.
 */
function librarySettings(env: NodeJS.ProcessEnv): LibrarySettings {
  const currentName = LIBRARY_LINK_SIGNING_KEY_NAME;
  const previousName = LIBRARY_LINK_SIGNING_KEYS_PREVIOUS_NAME;
  const minimum = LIBRARY_LINK_SIGNING_KEY_MINIMUM_BYTES;
  const currentText = (env[currentName] ?? "").trim();
  if (currentText === "") throw new Error(`Missing required environment variable: ${currentName}`);
  if (Buffer.byteLength(currentText, "utf8") < minimum) {
    throw new Error(`Environment variable ${currentName} must be at least ${minimum} bytes`);
  }
  const previousTexts = (env[previousName] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (previousTexts.length > LIBRARY_LINK_SIGNING_KEYS_PREVIOUS_MAXIMUM) {
    throw new Error(`Environment variable ${previousName} holds at most ${LIBRARY_LINK_SIGNING_KEYS_PREVIOUS_MAXIMUM} keys`);
  }
  if (previousTexts.some((text) => Buffer.byteLength(text, "utf8") < minimum)) {
    throw new Error(`Environment variable ${previousName} must hold keys of at least ${minimum} bytes each`);
  }
  if (new Set(previousTexts).size !== previousTexts.length) {
    throw new Error(`Environment variable ${previousName} repeats a key`);
  }
  if (previousTexts.includes(currentText)) {
    throw new Error(`Environment variable ${previousName} holds the current key (${currentName})`);
  }
  return {
    signingKeys: {
      current: Buffer.from(currentText, "utf8"),
      previous: previousTexts.map((text) => Buffer.from(text, "utf8")),
    },
  };
}

/**
 * TELFLO_SALES_INQUIRY_TO: absent or "" is none, which only an install
 * with TELFLO_SALES_INQUIRY off may have (the inquiries need somewhere to
 * go; there is no default address). Anything else must be one address the
 * contracts' email schema accepts, so a typo or a list fails at boot
 * rather than at the first inquiry. The errors name the variables, never
 * the value.
 */
function salesInquiryTo(env: NodeJS.ProcessEnv, site: SiteSettings): string {
  const name = "TELFLO_SALES_INQUIRY_TO";
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (site.salesInquiry) {
      throw new Error(`Environment variable ${name} is required while TELFLO_SALES_INQUIRY is "true" (where the inquiries go)`);
    }
    return "";
  }
  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Environment variable ${name} must be an email address`);
  return parsed.data;
}

/** TELFLO_SMTP_TLS: unset or "" is starttls. */
function smtpTls(env: NodeJS.ProcessEnv): SmtpTlsMode {
  const name = "TELFLO_SMTP_TLS";
  const raw = env[name];
  const value = raw === undefined || raw === "" ? "starttls" : raw;
  if (!(SMTP_TLS_MODES as readonly string[]).includes(value)) {
    throw new Error(`Environment variable ${name} must be one of ${SMTP_TLS_MODES.join(", ")}`);
  }
  return value as SmtpTlsMode;
}

/**
 * TELFLO_SMTP_USERNAME and TELFLO_SMTP_PASSWORD: both set is a login, neither
 * is none, one without the other refuses to boot (a half-configured login
 * would fail every message instead of failing here). "" is unset. The errors
 * name the variables, never a value.
 */
function smtpLogin(env: NodeJS.ProcessEnv): SmtpLogin | null {
  const usernameName = "TELFLO_SMTP_USERNAME";
  const passwordName = "TELFLO_SMTP_PASSWORD";
  const username = env[usernameName] ?? "";
  const password = env[passwordName] ?? "";
  if (username === "" && password === "") return null;
  if (username === "" || password === "") {
    throw new Error(`Environment variables ${usernameName} and ${passwordName} must be set together, or neither`);
  }
  return { username, password };
}

/** A PEM certificate block, as `openssl x509` writes one. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;

/**
 * TELFLO_SMTP_CA_FILE: absent or "" is none. Otherwise an absolute path, read
 * once here, at boot (the one file settings read): one or more PEM
 * certificates and nothing else (no private key, no other block, no stray
 * text), each one a certificate node:crypto parses. Its text is the CA the
 * SMTP connection alone trusts (smtp-mailer.ts, `tls.ca`; never
 * NODE_EXTRA_CA_CERTS). The errors name the variable and the rule, never the
 * file's text.
 */
function smtpCa(env: NodeJS.ProcessEnv): string | null {
  const name = "TELFLO_SMTP_CA_FILE";
  const path = env[name];
  if (path === undefined || path === "") return null;
  if (!isAbsolute(path)) throw new Error(`Environment variable ${name} must be an absolute path`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Environment variable ${name} names a file that can't be read`);
  }
  const blocks = text.match(PEM_CERTIFICATE) ?? [];
  const rest = text.replace(PEM_CERTIFICATE, "");
  const notCertificates = new Error(`Environment variable ${name} must name a file of PEM certificates only`);
  if (blocks.length === 0 || rest.trim() !== "") throw notCertificates;
  for (const block of blocks) {
    try {
      new X509Certificate(block);
    } catch {
      throw notCertificates;
    }
  }
  return blocks.join("\n") + "\n";
}

/**
 * Only the selected transport's variables are required: a SendGrid deployment
 * sets no SMTP host, and an on-prem SMTP deployment holds no SendGrid key.
 */
function mailTransport(env: NodeJS.ProcessEnv): MailTransportSettings {
  const kind = required(env, "TELFLO_MAIL_TRANSPORT");
  switch (kind) {
    case "smtp":
      return {
        kind,
        host: required(env, "TELFLO_SMTP_HOST"),
        port: requiredPositiveInteger(env, "TELFLO_SMTP_PORT"),
        allowInsecureTransport: optionalStrictBoolean(env, "TELFLO_SMTP_ALLOW_INSECURE"),
        tls: smtpTls(env),
        login: smtpLogin(env),
        ca: smtpCa(env),
      };
    case "sendgrid":
      return { kind, apiKey: required(env, "TELFLO_SENDGRID_API_KEY") };
    default:
      throw new Error(
        `Environment variable TELFLO_MAIL_TRANSPORT must be one of ${MAIL_TRANSPORTS.join(", ")}, received: ${kind}`,
      );
  }
}

/**
 * Fails fast and loudly. A process that boots with a half-configured
 * environment fails later, further from the cause, usually in front of a user.
 */
export function loadSettings(env: NodeJS.ProcessEnv): AppSettings {
  const publicWebUrl = required(env, "TELFLO_PUBLIC_WEB_URL").replace(/\/+$/, "");
  const site = parseSiteSettings(env);
  return {
    databaseUrl: required(env, "TELFLO_DATABASE_URL"),
    apiPort: requiredPositiveInteger(env, "TELFLO_API_PORT"),
    // Links are built by concatenation, so a trailing slash would produce
    // '//verify-email'. Normalize once, here.
    publicWebUrl,
    webOrigin: webOrigin(env, publicWebUrl),
    mail: {
      from: required(env, "TELFLO_MAIL_FROM"),
      transport: mailTransport(env),
    },
    verificationTokenTtlHours: requiredPositiveInteger(env, "TELFLO_VERIFICATION_TOKEN_TTL_HOURS"),
    accessTokenSecret: accessTokenSecret(env),
    accessTokenTtlMinutes: optionalIntegerInRange(env, "TELFLO_ACCESS_TOKEN_TTL_MINUTES", 15, 1, 15),
    refreshTokenTtlDays: optionalIntegerInRange(env, "TELFLO_REFRESH_TOKEN_TTL_DAYS", 30, 1),
    isCookieSecure: isCookieSecure(env, publicWebUrl),
    trustProxyHops: optionalIntegerInRange(env, "TELFLO_TRUST_PROXY_HOPS", 0, 0),
    oidcProviders: oidcProviders(env),
    site,
    salesInquiryTo: salesInquiryTo(env, site),
    opampServer: opampServerSettings(env),
    otelcolValidator: otelcolValidatorSettings(env),
    fileStore: fileStoreSettings(env),
    otelcolTesting: otelcolTestingSettings(env),
    testRuns: testRunSettings(env),
    ottlEvaluator: ottlEvaluatorSettings(env),
    install: installSettings(env),
    quickDeploy: quickDeploySettings(env),
    library: librarySettings(env),
  };
}
