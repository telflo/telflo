import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DEFAULT_DOCS_URL } from "@telflo/contracts";
import { testDatabaseUrl } from "@telflo/db/test-database";
import { FAKE_OIDC_CLIENT_ID, FAKE_OIDC_CLIENT_SECRET } from "../../apps/api/src/testing/fake-oidc-provider.js";
import { FAKE_OPAMP_SERVER_SECRET } from "../../apps/api/src/testing/fake-opamp-server.js";
import { FAKE_OTELCOL_TESTING_SECRET } from "../../apps/api/src/testing/fake-otelcol-testing.js";
import { FAKE_OTELCOL_VALIDATOR_SECRET } from "../../apps/api/src/testing/fake-otelcol-validator.js";
import { FAKE_OTTL_EVALUATOR_SECRET } from "../../apps/api/src/testing/fake-ottl-evaluator.js";

// The browser tests' own servers and database. Never the developer's: their
// dev servers listen on 53000 and 8080 against `telflo`, and a browser run
// must neither reuse nor disturb them.
//
// Every port is below 32768, outside the range Linux (32768–60999) and macOS
// (49152–65535) hand out for outgoing connections: in that range a CI
// runner's own connection can hold one by chance, and the server then fails
// to start ("Port 53100 is already in use").

export const E2E_WEB_PORT = 23100;
export const E2E_API_PORT = 28080;
export const E2E_OIDC_PORT = 28090;
export const E2E_WEB_URL = `http://localhost:${E2E_WEB_PORT}`;
export const E2E_API_URL = `http://localhost:${E2E_API_PORT}`;

/**
 * The second pair, the SaaS's: an API and a web dev server with the SaaS's
 * site values (open registration, the playground and the anonymous reads on,
 * the Terms asked), beside the default pair (E2E_WEB_URL, E2E_API_URL), which
 * runs the open source's defaults. The specs of open registration, the Terms,
 * the playground and the anonymous reads run on it (support/saas.ts's `test`);
 * both pairs share the database, Mailpit, the fakes and the file store.
 */
export const E2E_SAAS_WEB_PORT = 23102;
export const E2E_SAAS_API_PORT = 28081;
export const E2E_SAAS_WEB_URL = `http://localhost:${E2E_SAAS_WEB_PORT}`;
export const E2E_SAAS_API_URL = `http://localhost:${E2E_SAAS_API_PORT}`;
/** The SaaS pair's Terms version (TELFLO_TERMS_VERSION): the one registration recorded before it became a setting. */
export const E2E_SAAS_TERMS_VERSION = "2026-01-01";

/**
 * The analytics web dev server, the only one with a PostHog key: the analytics
 * tests run against it, every other test against E2E_WEB_URL or
 * E2E_SAAS_WEB_URL, where analytics is off. It runs the SaaS's values, against
 * the SaaS pair's API (the playground's analytics need the playground and
 * PostHog on one server).
 */
export const E2E_ANALYTICS_WEB_PORT = 23101;
export const E2E_ANALYTICS_WEB_URL = `http://localhost:${E2E_ANALYTICS_WEB_PORT}`;
/**
 * The analytics server's PostHog host: a stub that records what it is sent
 * (start-posthog-stub.ts). On 127.0.0.1, another site from the page, as
 * PostHog's own host is.
 */
export const E2E_POSTHOG_STUB_PORT = 28095;
export const E2E_POSTHOG_STUB_HOSTNAME = "127.0.0.1";
export const E2E_POSTHOG_STUB_URL = `http://${E2E_POSTHOG_STUB_HOSTNAME}:${E2E_POSTHOG_STUB_PORT}`;
/** A made-up project key: only the stub ever sees it. */
export const E2E_POSTHOG_KEY = "phc_e2e_only_fake_project_key";
/**
 * The fake OpenID Provider (start-fake-oidc-provider.ts), behind the Google
 * button. On 127.0.0.1, not localhost: a different site from the web app on
 * localhost, as Google is, so the return from the provider is a cross-site
 * navigation and the SameSite=Lax flow cookie must survive it.
 */
export const E2E_OIDC_HOSTNAME = "127.0.0.1";
export const E2E_OIDC_ISSUER = `http://${E2E_OIDC_HOSTNAME}:${E2E_OIDC_PORT}`;

/**
 * The E2E API's opamp-server: the OpenAPI-checked fake from
 * apps/api/src/testing, run by start-fake-opamp-server.ts on 127.0.0.1:28085
 * (the fake listens on 127.0.0.1 only). No Go in the browser tests. Its
 * secret is the fake's public test one.
 */
export const E2E_OPAMP_PORT = 28085;
export const E2E_OPAMP_URL = `http://127.0.0.1:${E2E_OPAMP_PORT}`;
/**
 * That fake's control port, on 127.0.0.1, test-only, as the collector
 * tester's: the browser tests enroll collectors in a fleet and set their
 * last-seen time and drift state through support/fake-opamp-server.ts's
 * helpers. Not a route of the contract, and no setting: the E2E API never
 * calls it.
 */
export const E2E_OPAMP_CONTROL_PORT = 28084;
export const E2E_OPAMP_CONTROL_URL = `http://127.0.0.1:${E2E_OPAMP_CONTROL_PORT}`;
/**
 * Where the fake writes each contract violation it sees, one per line, as
 * it sees it: start-fake-opamp-server.ts empties it when it starts, and
 * global-setup.ts's teardown fails the run if it holds any (support/fake-opamp-server.ts).
 * Under test-results/, which Playwright clears before it starts the web
 * servers, and which CI uploads when a run fails.
 */
export const E2E_OPAMP_VIOLATIONS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-results/fake-opamp-server-violations.log",
);

/**
 * The E2E API's collector validator: the OpenAPI-checked fake from
 * apps/api/src/testing, run by start-fake-otelcol-validator.ts on
 * 127.0.0.1:28086. No collector in the browser tests: the fake answers by
 * the text. Its secret is the fake's public test one.
 */
export const E2E_OTELCOL_VALIDATOR_PORT = 28086;
export const E2E_OTELCOL_VALIDATOR_URL = `http://127.0.0.1:${E2E_OTELCOL_VALIDATOR_PORT}`;
/**
 * Where that fake writes each contract violation it sees, as the
 * opamp-server's does: start-fake-otelcol-validator.ts empties it when it
 * starts, and global-setup.ts's teardown fails the run if it holds any.
 */
export const E2E_OTELCOL_VALIDATOR_VIOLATIONS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-results/fake-otelcol-validator-violations.log",
);

/**
 * The E2E API's collector tester: the OpenAPI-checked fake from
 * apps/api/src/testing, run by start-fake-otelcol-testing.ts on
 * 127.0.0.1:28087. No collector and no kwok in the browser tests: the fake
 * answers by markers in the text (support/fake-otelcol-testing.ts). Its
 * secret is the fake's public test one.
 */
export const E2E_OTELCOL_TESTING_PORT = 28087;
export const E2E_OTELCOL_TESTING_URL = `http://127.0.0.1:${E2E_OTELCOL_TESTING_PORT}`;
/**
 * That fake's control route, on a port of its own on 127.0.0.1, test-only:
 * the browser tests count and release the `slow` runs the fake holds, each
 * test only its own (by a token in its text), through
 * support/fake-otelcol-testing.ts's helpers. The E2E API never calls it.
 */
export const E2E_OTELCOL_TESTING_CONTROL_PORT = 28088;
export const E2E_OTELCOL_TESTING_CONTROL_URL = `http://127.0.0.1:${E2E_OTELCOL_TESTING_CONTROL_PORT}`;
/**
 * Where that fake writes each contract violation it sees, as the
 * validator's does: start-fake-otelcol-testing.ts empties it when it
 * starts, and global-setup.ts's teardown fails the run if it holds any.
 */
export const E2E_OTELCOL_TESTING_VIOLATIONS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-results/fake-otelcol-testing-violations.log",
);
/**
 * The E2E API's OTTL evaluator: the OpenAPI-checked fake from
 * apps/api/src/testing, run by start-fake-ottl-evaluator.ts on
 * 127.0.0.1:28089. No OTTL in the browser tests: the fake answers by a marker
 * in a rule's pattern or OTTL string literal
 * (support/fake-ottl-evaluator.ts). Its secret is the fake's public test one.
 */
export const E2E_OTTL_EVALUATOR_PORT = 28089;
export const E2E_OTTL_EVALUATOR_URL = `http://127.0.0.1:${E2E_OTTL_EVALUATOR_PORT}`;
/**
 * Where that fake writes each contract violation it sees, as the tester's
 * does: start-fake-ottl-evaluator.ts empties it when it starts, and
 * global-setup.ts's teardown fails the run if it holds any.
 */
export const E2E_OTTL_EVALUATOR_VIOLATIONS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-results/fake-ottl-evaluator-violations.log",
);
/**
 * The E2E API's runs at once: large, so the browsers' parallel workers never
 * queue behind each other's runs. A queued run is shown with the fake's slow
 * marker; "n ahead" is the API suite's.
 */
export const E2E_TEST_RUNS_PER_TESTER = 16;

/**
 * The E2E API's file store root: its own temporary directory, never the
 * developer's root. Under test-results/, which Playwright clears before it
 * starts the web servers, so each run starts with no files, and which git
 * ignores. start-api.ts creates it before the E2E API starts.
 */
export const E2E_FILE_STORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../test-results/file-store");

/**
 * Installing: the agent endpoint the install dialog's command and the
 * bundles name, which nothing connects to in the browser tests (.invalid,
 * RFC 2606), and the repository's own install templates
 * (install-templates/, beside the workspace).
 */
export const E2E_OPAMP_AGENT_PUBLIC_URL = "https://opamp-agent.e2e.invalid/v1/opamp";
export const E2E_INSTALL_TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../install-templates");

/**
 * Quick-deploy links: the E2E API's own origin, so a link a browser test
 * makes downloads from the E2E API itself, and a fixed key, public and
 * e2e-only, which seals the values typed in a test. It guards nothing.
 */
export const E2E_PUBLIC_API_URL = `http://localhost:${E2E_API_PORT}`;
export const E2E_QUICK_DEPLOY_ENCRYPTION_KEY = "ZTJlLW9ubHktcXVpY2stZGVwbG95LWtleS1wdWJsaWM=";

/**
 * The library's Copy curl links: a fixed key, public and e2e-only, which
 * signs the links a browser test makes. It guards nothing.
 */
export const E2E_LIBRARY_LINK_SIGNING_KEY = "e2e-only-library-link-signing-key-not-for-production";

/**
 * Signs the E2E API's access tokens. The E2E API and `expireAccessToken`
 * both read it from here, so a token the helper mints verifies. Used only
 * against the E2E servers; it guards nothing.
 */
export const E2E_ACCESS_TOKEN_SECRET = "e2e-only-access-token-secret-never-used-anywhere-else";

/**
 * The API's access-token lifetime, set explicitly rather than left to its
 * default so `expireAccessToken` mints with the same one.
 */
export const E2E_ACCESS_TOKEN_TTL_MINUTES = 15;

const E2E_DATABASE_NAME = "telflo_platform_e2e_test";

/**
 * `.env` under the process environment, as vitest.global-setup.ts reads it:
 * only for where Postgres and Mailpit are. Read without writing it into
 * process.env, so nothing else from the developer's `.env` reaches the E2E
 * servers.
 */
export function developerEnv(): NodeJS.ProcessEnv {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
  let fromFile: NodeJS.Dict<string> = {};
  try {
    fromFile = parseEnv(readFileSync(envPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { ...fromFile, ...process.env };
}

/**
 * The developer's (or CI's) Postgres server, with the database renamed to
 * `telflo_platform_e2e_test`. Its own database rather than vitest's `telflo_platform_test`, so
 * a browser run and a vitest run can go at once without deadlocking. testDatabaseUrl refuses a
 * name that doesn't end in `_test`.
 *
 * As the API's own login role (TELFLO_DATABASE_URL): what the E2E API
 * connects as, like the real one.
 */
export function e2eDatabaseUrl(): string {
  return e2eUrl("TELFLO_DATABASE_URL");
}

/**
 * The same database as the tables' owner (TELFLO_MIGRATION_DATABASE_URL): for
 * preparing it (start-api.ts), emptying it (global-setup.ts), and seeding and
 * reading rows (support/database.ts). Never the E2E API's own connection.
 */
export function e2eOwnerDatabaseUrl(): string {
  return e2eUrl("TELFLO_MIGRATION_DATABASE_URL");
}

function e2eUrl(variable: "TELFLO_DATABASE_URL" | "TELFLO_MIGRATION_DATABASE_URL"): string {
  const server = developerEnv()[variable];
  if (!server) {
    throw new Error(`The browser tests need ${variable} to find a Postgres server; see .env.example.`);
  }
  const url = new URL(server);
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return testDatabaseUrl({ TELFLO_TEST_DATABASE_URL: url.toString() });
}

/**
 * Every setting the E2E API reads, set here rather than taken from `.env`.
 * The optional ones are set to "" (the API's "use the default"), because
 * settings.ts loads `.env` on import and fills in any variable that is
 * absent: a developer's local override would otherwise reach these servers.
 */
export function e2eApiEnv(): Record<string, string> {
  const developer = developerEnv();
  return {
    TELFLO_DATABASE_URL: e2eDatabaseUrl(),
    // Read only by start-api.ts, to create, migrate and provision the
    // database before the API starts; the API never reads it.
    TELFLO_MIGRATION_DATABASE_URL: e2eOwnerDatabaseUrl(),
    TELFLO_API_PORT: String(E2E_API_PORT),
    TELFLO_PUBLIC_WEB_URL: E2E_WEB_URL,
    TELFLO_WEB_ORIGIN: "",
    // Safari/WebKit refuses Secure cookies on http://localhost.
    TELFLO_COOKIE_SECURE: "false",
    TELFLO_ACCESS_TOKEN_SECRET: E2E_ACCESS_TOKEN_SECRET,
    TELFLO_ACCESS_TOKEN_TTL_MINUTES: String(E2E_ACCESS_TOKEN_TTL_MINUTES),
    TELFLO_REFRESH_TOKEN_TTL_DAYS: "",
    TELFLO_TRUST_PROXY_HOPS: "",
    TELFLO_VERIFICATION_TOKEN_TTL_HOURS: "24",
    // The developer's (or CI's) Mailpit: the password-reset and
    // resend-confirmation tests read what the API sends from its API
    // (support/mail.ts), each by its own recipient.
    TELFLO_MAIL_TRANSPORT: "smtp",
    TELFLO_MAIL_FROM: "no-reply@telflo.local",
    TELFLO_SMTP_HOST: developer.TELFLO_SMTP_HOST ?? "localhost",
    TELFLO_SMTP_PORT: developer.TELFLO_SMTP_PORT ?? "51025",
    TELFLO_SMTP_ALLOW_INSECURE: "",
    // Mailpit takes plain SMTP, with no login and no CA.
    TELFLO_SMTP_TLS: "none",
    TELFLO_SMTP_USERNAME: "",
    TELFLO_SMTP_PASSWORD: "",
    TELFLO_SMTP_CA_FILE: "",
    // No sales inquiries, so no address.
    TELFLO_SALES_INQUIRY_TO: "",
    // Google, pointed at the fake provider on loopback: the browser tests see
    // the Google button, and the fake sits behind it. Never the developer's
    // Google settings, and never the internet.
    TELFLO_OIDC_GOOGLE_ISSUER: E2E_OIDC_ISSUER,
    TELFLO_OIDC_GOOGLE_CLIENT_ID: FAKE_OIDC_CLIENT_ID,
    TELFLO_OIDC_GOOGLE_CLIENT_SECRET: FAKE_OIDC_CLIENT_SECRET,
    // The fake opamp-server (start-fake-opamp-server.ts), never the
    // developer's: the API registers every organization the tests create
    // there, and publishes there.
    TELFLO_OPAMP_MANAGEMENT_URL: E2E_OPAMP_URL,
    TELFLO_OPAMP_MANAGEMENT_SECRET: FAKE_OPAMP_SERVER_SECRET,
    // The fake collector validator (start-fake-otelcol-validator.ts), never
    // the developer's: the editor's checks go there.
    TELFLO_OTELCOL_VALIDATOR_URL: E2E_OTELCOL_VALIDATOR_URL,
    TELFLO_OTELCOL_VALIDATOR_SECRET: FAKE_OTELCOL_VALIDATOR_SECRET,
    // Its own temporary root, never the developer's, and on the local disk
    // whatever the developer's TELFLO_FILE_STORE says (start-api.ts refuses
    // any other kind).
    TELFLO_FILE_STORE: "local",
    TELFLO_FILE_STORE_ROOT: E2E_FILE_STORE_ROOT,
    // The fake collector tester (start-fake-otelcol-testing.ts), never the
    // developer's: test runs go there.
    TELFLO_OTELCOL_TESTING_URL: E2E_OTELCOL_TESTING_URL,
    TELFLO_OTELCOL_TESTING_SECRET: FAKE_OTELCOL_TESTING_SECRET,
    TELFLO_TEST_RUNS_PER_TESTER: String(E2E_TEST_RUNS_PER_TESTER),
    // The default down rule; the browser tests show the tester down with
    // page.route, never the real state.
    TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS: "",
    // The fake OTTL evaluator (start-fake-ottl-evaluator.ts), never the
    // developer's: rules are checked and evaluated there.
    TELFLO_OTTL_EVALUATOR_URL: E2E_OTTL_EVALUATOR_URL,
    TELFLO_OTTL_EVALUATOR_SECRET: FAKE_OTTL_EVALUATOR_SECRET,
    // Installing: never the developer's endpoint, image or templates.
    TELFLO_OPAMP_AGENT_PUBLIC_URL: E2E_OPAMP_AGENT_PUBLIC_URL,
    TELFLO_COLLECTOR_IMAGE_REPOSITORY: "",
    TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS: "",
    TELFLO_HELM_CHART_REFERENCE: "",
    TELFLO_HELM_CHART_VERSION: "",
    TELFLO_INSTALL_TEMPLATES_DIR: E2E_INSTALL_TEMPLATES_DIR,
    // Quick-deploy links: never the developer's URL or keys.
    TELFLO_PUBLIC_API_URL: E2E_PUBLIC_API_URL,
    TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY: E2E_QUICK_DEPLOY_ENCRYPTION_KEY,
    TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS: "",
    // The library's links: never the developer's keys.
    TELFLO_LIBRARY_LINK_SIGNING_KEY: E2E_LIBRARY_LINK_SIGNING_KEY,
    TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS: "",
    // The site's switches and links: the open source's defaults, whatever
    // the developer's .env says.
    ...E2E_OPEN_SOURCE_SITE_ENV,
    LOG_LEVEL: "warn",
  };
}

/**
 * The site's variables at the open source's defaults: each "" (its
 * default), but the docs link, which "" would hide: its default is given.
 */
const E2E_OPEN_SOURCE_SITE_ENV: Record<string, string> = {
  TELFLO_REGISTRATION: "",
  TELFLO_PLAYGROUND: "",
  TELFLO_ANONYMOUS_VALIDATE: "",
  TELFLO_PUBLIC_FLOWS: "",
  TELFLO_SALES_INQUIRY: "",
  TELFLO_EMAIL_NOTIFICATIONS: "",
  TELFLO_USER_FEEDBACK: "",
  TELFLO_LEARNING: "",
  TELFLO_USER_ADMIN: "",
  TELFLO_DOCS_URL: DEFAULT_DOCS_URL,
  TELFLO_TERMS_VERSION: "",
  TELFLO_TERMS_URL: "",
  TELFLO_PRIVACY_URL: "",
  TELFLO_COOKIE_POLICY_URL: "",
};

/**
 * The SaaS pair's site values: registration open; the playground,
 * anonymous validate and public flows on; Settings › Notifications,
 * Contact us and User Feedback, Learning and the library, and Product admin
 * › Users shown; the Terms asked, at E2E_SAAS_TERMS_VERSION, with three legal-page URLs
 * (nothing serves them in the browser tests); no sales inquiries.
 */
const E2E_SAAS_SITE_ENV: Record<string, string> = {
  ...E2E_OPEN_SOURCE_SITE_ENV,
  TELFLO_REGISTRATION: "open",
  TELFLO_PLAYGROUND: "true",
  TELFLO_ANONYMOUS_VALIDATE: "true",
  TELFLO_PUBLIC_FLOWS: "true",
  TELFLO_EMAIL_NOTIFICATIONS: "true",
  TELFLO_USER_FEEDBACK: "true",
  TELFLO_LEARNING: "true",
  TELFLO_USER_ADMIN: "true",
  TELFLO_TERMS_VERSION: E2E_SAAS_TERMS_VERSION,
  TELFLO_TERMS_URL: "/home/terms-of-service",
  TELFLO_PRIVACY_URL: "/home/privacy-policy",
  TELFLO_COOKIE_POLICY_URL: "/home/cookie-policy",
};

/**
 * The SaaS pair's API: e2eApiEnv's, on its own port, its links to the SaaS
 * pair's web server and its own origin, with the SaaS's site values. The
 * same database, Mailpit, fakes and file store as the default pair's.
 */
export function e2eSaasApiEnv(): Record<string, string> {
  return {
    ...e2eApiEnv(),
    TELFLO_API_PORT: String(E2E_SAAS_API_PORT),
    TELFLO_PUBLIC_WEB_URL: E2E_SAAS_WEB_URL,
    TELFLO_PUBLIC_API_URL: E2E_SAAS_API_URL,
    ...E2E_SAAS_SITE_ENV,
  };
}

/**
 * The web dev server's environment: its port, where the API is, and every
 * setting the web server reads. The dev server loads apps/web/.env under
 * these (React Router's Vite plugin; the environment wins), so each is set
 * here, the optional ones to "" (the web's "unset"): the developer's own
 * public URL or PostHog key must never reach these servers, nor CI's job
 * environment.
 */
export function e2eWebEnv(): Record<string, string> {
  return {
    TELFLO_WEB_PORT: String(E2E_WEB_PORT),
    // Vite's /api proxy, for the browser's same-origin calls.
    TELFLO_API_PORT: String(E2E_API_PORT),
    // Server loaders reach the API directly.
    TELFLO_API_INTERNAL_URL: E2E_API_URL,
    // Relative to apps/web. Never the developer's node_modules/.vite, which
    // their own dev server may be using (see vite.config.ts).
    TELFLO_VITE_CACHE_DIR: "node_modules/.vite-e2e",
    // Canonical URLs.
    TELFLO_PUBLIC_WEB_URL: E2E_WEB_URL,
    // Analytics off.
    TELFLO_POSTHOG_KEY: "",
    TELFLO_POSTHOG_HOST: "",
    // The site's switches and links, as the API's.
    ...E2E_OPEN_SOURCE_SITE_ENV,
  };
}

/**
 * The SaaS pair's web server: e2eWebEnv's, on its own port and Vite cache
 * (two dev servers must not share one), its /api proxy and server loaders
 * to the SaaS pair's API, its own public URL, with the SaaS's site values.
 */
export function e2eSaasWebEnv(): Record<string, string> {
  return {
    ...e2eWebEnv(),
    TELFLO_WEB_PORT: String(E2E_SAAS_WEB_PORT),
    TELFLO_API_PORT: String(E2E_SAAS_API_PORT),
    TELFLO_API_INTERNAL_URL: E2E_SAAS_API_URL,
    TELFLO_VITE_CACHE_DIR: "node_modules/.vite-e2e-saas",
    TELFLO_PUBLIC_WEB_URL: E2E_SAAS_WEB_URL,
    ...E2E_SAAS_SITE_ENV,
  };
}

/**
 * The analytics web server's environment: e2eSaasWebEnv's (the SaaS's site
 * values, its /api proxy and server loaders to the SaaS pair's API), on its
 * own port and Vite cache (two dev servers must not share one), with its own
 * public URL, and a PostHog key whose host is the local stub, so nothing
 * leaves the machine.
 */
export function e2eAnalyticsWebEnv(): Record<string, string> {
  return {
    ...e2eSaasWebEnv(),
    TELFLO_WEB_PORT: String(E2E_ANALYTICS_WEB_PORT),
    TELFLO_VITE_CACHE_DIR: "node_modules/.vite-e2e-analytics",
    TELFLO_PUBLIC_WEB_URL: E2E_ANALYTICS_WEB_URL,
    TELFLO_POSTHOG_KEY: E2E_POSTHOG_KEY,
    TELFLO_POSTHOG_HOST: E2E_POSTHOG_STUB_URL,
  };
}
