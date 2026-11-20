import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { testDatabaseUrl, testMigrationDatabaseUrl } from "@telflo/db/test-database";
import { FAKE_OPAMP_SERVER_SECRET } from "./apps/api/src/testing/fake-opamp-server.js";
import { FAKE_OTELCOL_TESTING_SECRET } from "./apps/api/src/testing/fake-otelcol-testing.js";
import { FAKE_OTELCOL_VALIDATOR_SECRET } from "./apps/api/src/testing/fake-otelcol-validator.js";
import { FAKE_OTTL_EVALUATOR_SECRET } from "./apps/api/src/testing/fake-ottl-evaluator.js";

// Shared by every package's vitest.config.ts (setupFiles), so integration
// tests do not each need TELFLO_DATABASE_URL (and friends) exported by hand
// before running. The path is resolved from this file's own location, not
// process.cwd(), because `npm test -w <package>` runs with cwd set to that
// package's directory, not the workspace root (telflo-core/).
//
// This is the one implementation; do not copy this try/catch into
// individual package configs.
const workspaceRootEnvPath = resolve(dirname(fileURLToPath(import.meta.url)), ".env");

try {
  process.loadEnvFile(workspaceRootEnvPath);
} catch (error) {
  // A missing .env file is normal outside local development — real
  // deployments inject environment variables directly. Anything else (a
  // permission error, .env existing as a directory, ...) must not be
  // swallowed: left uncaught here, it would otherwise surface later as a
  // confusing "Missing required environment variable" instead of the real
  // cause. (Verified empirically: Node's own .env parser is lenient and does
  // not throw on malformed *syntax* — only I/O failures like ENOENT do — but
  // narrowing to exactly the expected failure is still the correct
  // discipline, not "whatever this function happens to throw today".)
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

// A developer's own AWS identity never reaches a test, nor its endpoint,
// region or retry settings: right after the .env fill, every AWS_ variable
// present, and every variable the SDK's default credential chain reads
// whether present or not, is set to "" (which the SDK reads as unset;
// deleted, settings.ts's own .env load would refill it). The shared config and credentials files are pointed at a path
// that doesn't exist (the SDK reads both for every client, even beside
// environment keys), and the instance metadata service is never asked. The
// S3 tests then put only their test server's two keys in the environment,
// with vi.stubEnv, through that same chain. Tests build their stores from
// explicit settings, on the local disk unless they name S3.
const AWS_CHAIN_VARIABLES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CREDENTIAL_EXPIRATION",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL_STS",
];
for (const name of new Set([
  ...Object.keys(process.env).filter((key) => key.startsWith("AWS_")),
  ...AWS_CHAIN_VARIABLES,
])) {
  process.env[name] = "";
}
process.env.AWS_CONFIG_FILE = "/nonexistent/telflo-test-aws-config";
process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/telflo-test-aws-credentials";
process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.TELFLO_FILE_STORE = "local";

// Tests never touch the development database: every integration test
// empties all tables. Both database URLs are repointed at the test database
// (`telflo_platform` becomes `telflo_platform_test`): TELFLO_DATABASE_URL, the API's own login
// role, which servers under test connect as, and TELFLO_MIGRATION_DATABASE_URL,
// the tables' owner, for fixtures, truncation and test-only DDL.
// TELFLO_TEST_DATABASE_URL and TELFLO_TEST_MIGRATION_DATABASE_URL
// override them. vitest.global-setup.ts has already created, migrated and
// provisioned it. This runs in every worker process, so each derives them for
// itself rather than relying on what it inherited; testDatabaseUrl is
// idempotent, and throws rather than return a database whose name does not end
// in "_test", or when the owner's URL is missing. When neither application
// variable is set (no .env, and a package without database tests) there is
// nothing to repoint.
if (process.env.TELFLO_DATABASE_URL || process.env.TELFLO_TEST_DATABASE_URL) {
  process.env.TELFLO_DATABASE_URL = testDatabaseUrl(process.env);
  process.env.TELFLO_MIGRATION_DATABASE_URL = testMigrationDatabaseUrl(process.env);
}

// Tests run with the settings a real deployment gets, not the developer's
// local overrides: each of these is optional with a production default, and a
// dev .env that sets one changes behavior tests assert (a local
// TELFLO_COOKIE_SECURE=false, for Safari on http://localhost, drops the
// Secure attribute the session tests check). A test that needs a different
// value passes it to loadSettings explicitly.
//
// Each is set to "" (which settings.ts reads as "use the default") rather
// than deleted: apps/api/src/settings.ts loads .env again when it is first
// imported, and process.loadEnvFile fills in only variables that are absent,
// so a deleted variable would come straight back from the dev .env.
for (const devOnly of [
  "TELFLO_COOKIE_SECURE",
  "TELFLO_TRUST_PROXY_HOPS",
  "TELFLO_WEB_ORIGIN",
  "TELFLO_ACCESS_TOKEN_TTL_MINUTES",
  "TELFLO_REFRESH_TOKEN_TTL_DAYS",
  "TELFLO_SMTP_ALLOW_INSECURE",
  // A developer's own Google client must never reach a test.
  // A test that needs a provider passes one in its settings object.
  "TELFLO_OIDC_GOOGLE_CLIENT_ID",
  "TELFLO_OIDC_GOOGLE_CLIENT_SECRET",
  "TELFLO_OIDC_GOOGLE_ISSUER",
  // A developer's own inbox must never receive a test's inquiries.
  "TELFLO_SALES_INQUIRY_TO",
  // The test runs' dispatcher: a developer's own N or
  // down limit must not change what the dispatcher's tests assert.
  "TELFLO_TEST_RUNS_PER_TESTER",
  "TELFLO_TESTING_DOWN_FAIL_AFTER_SECONDS",
  // Installing: the image's repository and the
  // insecure flag at their defaults, whatever a developer's own.
  "TELFLO_COLLECTOR_IMAGE_REPOSITORY",
  "TELFLO_OPAMP_ALLOW_INSECURE_CONNECTIONS",
  // The Helm install's chart at its defaults too.
  "TELFLO_HELM_CHART_REFERENCE",
  "TELFLO_HELM_CHART_VERSION",
  // The relay's login and CA: never a developer's own.
  "TELFLO_SMTP_USERNAME",
  "TELFLO_SMTP_PASSWORD",
  "TELFLO_SMTP_CA_FILE",
  // No cookie-policy link (the API never reads it; the web's tests stub it).
  "TELFLO_COOKIE_POLICY_URL",
]) {
  process.env[devOnly] = "";
}

// The site's switches: the tests run the SaaS's values, whatever a
// developer's .env says, so the API and CLI tests that call the switched
// routes (registration, Terms, the playground's anonymous reads, the
// published flows) keep their behaviour; a test of the open source's
// defaults passes its own settings. The sales inquiries stay off (their
// tests switch them on with an address of their own), and the docs link is
// the default. Mail goes to the test's own Mailpit in plain SMTP
// (development and test environments set none).
Object.assign(process.env, {
  TELFLO_REGISTRATION: "open",
  TELFLO_PLAYGROUND: "true",
  TELFLO_ANONYMOUS_VALIDATE: "true",
  TELFLO_PUBLIC_FLOWS: "true",
  TELFLO_SALES_INQUIRY: "false",
  TELFLO_EMAIL_NOTIFICATIONS: "true",
  TELFLO_DOCS_URL: "https://docs.telflo.com/",
  // TEST_TERMS_VERSION (apps/api/src/testing/site.ts).
  TELFLO_TERMS_VERSION: "2026-01-01",
  TELFLO_TERMS_URL: "/home/terms-of-service",
  TELFLO_PRIVACY_URL: "/home/privacy-policy",
  TELFLO_SMTP_TLS: "none",
});

// Nor a developer's own opamp-server a test's publications. Both settings are
// required, so they can't be blanked: loadSettings would
// refuse. They are placeholders instead, which no client is built from: an
// address that never resolves (.invalid, RFC 2606) and the fake's public
// test secret. Every test server is given a client of its file's own fake
// (apps/api/src/testing/opamp-server.ts), never one from these settings.
process.env.TELFLO_OPAMP_MANAGEMENT_URL = "http://opamp-server-placeholder.invalid";
process.env.TELFLO_OPAMP_MANAGEMENT_SECRET = FAKE_OPAMP_SERVER_SECRET;

// Nor a developer's own collector validator a test's text: required too, so
// placeholders in the same way. Every test server is given a client of its
// file's own fake, or one that fails if called
// (apps/api/src/testing/otelcol-validator.ts), never one from these settings.
process.env.TELFLO_OTELCOL_VALIDATOR_URL = "http://otelcol-validator-placeholder.invalid";
process.env.TELFLO_OTELCOL_VALIDATOR_SECRET = FAKE_OTELCOL_VALIDATOR_SECRET;

// Nor a developer's own collector tester a test's runs:
// required too, so placeholders in the same way. Every test that runs a test
// is given a client of its file's own fake (apps/api/src/testing/otelcol-testing.ts),
// never one from these settings.
process.env.TELFLO_OTELCOL_TESTING_URL = "http://otelcol-testing-placeholder.invalid";
process.env.TELFLO_OTELCOL_TESTING_SECRET = FAKE_OTELCOL_TESTING_SECRET;

// Nor a developer's own OTTL evaluator a test's rules:
// required too, so placeholders in the same way. Every test that checks or
// evaluates rules is given a client of its file's own fake, or one that
// fails if called (apps/api/src/testing/ottl-evaluator.ts), never one from
// these settings.
process.env.TELFLO_OTTL_EVALUATOR_URL = "http://ottl-evaluator-placeholder.invalid";
process.env.TELFLO_OTTL_EVALUATOR_SECRET = FAKE_OTTL_EVALUATOR_SECRET;

// Nor a developer's own file store a test's files: its root is required too,
// so a placeholder in the same way, an absolute path that doesn't exist,
// which no store is built from (createFileStore refuses it). Every test that
// keeps files builds its store on its own temporary directory (mkdtemp),
// removed afterwards.
process.env.TELFLO_FILE_STORE_ROOT = "/nonexistent/telflo-file-store-placeholder";

// Installing: the agent endpoint is required, so a placeholder that never
// resolves, written into the tests' facts and bundles only; and the templates are the repository's own set
// (install-templates/, beside this workspace), never a developer's
// directory. A test of the loader builds its own directories.
process.env.TELFLO_OPAMP_AGENT_PUBLIC_URL = "https://opamp-agent-placeholder.invalid/v1/opamp";
process.env.TELFLO_INSTALL_TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../install-templates");

// Quick-deploy links: both required, so the tests' own values, never a
// developer's: the API's base URL a test's links are made under (the test
// API's port, which no test listens on), and a fixed key, public and
// test-only, which seals the values typed in a test; no previous key,
// whatever a developer's .env holds ("" is unset). A test of a rotation
// builds its own ring.
process.env.TELFLO_PUBLIC_API_URL = "http://127.0.0.1:56899";
process.env.TELFLO_QUICK_DEPLOY_ENCRYPTION_KEY = "dml0ZXN0LW9ubHktcXVpY2stZGVwbG95LWtleS1wdWI=";
process.env.TELFLO_QUICK_DEPLOY_PREVIOUS_ENCRYPTION_KEYS = "";

// The library's Copy curl links: the key is required, so a fixed key, public
// and test-only, which signs the links a test makes; no previous key,
// whatever a developer's .env holds ("" is unset). A test of a rotation builds its own keys.
process.env.TELFLO_LIBRARY_LINK_SIGNING_KEY = "vitest-only-library-link-signing-key-not-for-production";
process.env.TELFLO_LIBRARY_LINK_SIGNING_KEYS_PREVIOUS = "";

// Dozens of HTTP requests flow through Fastify's own request logger in the
// integration suites. Test output should stay pristine so a real failure is
// not lost in routine request/response JSON lines. `??=` still lets someone
// override this when deliberately debugging a test with LOG_LEVEL set.
process.env.LOG_LEVEL ??= "silent";
