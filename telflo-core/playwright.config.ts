import { defineConfig, devices } from "@playwright/test";
import {
  E2E_ANALYTICS_WEB_URL,
  E2E_API_URL,
  E2E_OIDC_ISSUER,
  E2E_OPAMP_URL,
  E2E_OTELCOL_TESTING_URL,
  E2E_OTELCOL_VALIDATOR_URL,
  E2E_OTTL_EVALUATOR_URL,
  E2E_POSTHOG_STUB_URL,
  E2E_SAAS_API_URL,
  E2E_SAAS_WEB_URL,
  E2E_WEB_URL,
  e2eAnalyticsWebEnv,
  e2eApiEnv,
  e2eSaasApiEnv,
  e2eSaasWebEnv,
  e2eWebEnv,
} from "./e2e/support/environment.js";

// Browser tests: Chromium, Firefox and WebKit against their own API (28080),
// web dev server (23100) and database (telflo_platform_e2e_test), with the
// fake OpenID Provider (127.0.0.1:28090, another site from the web app's
// localhost) behind the Google button, and the OpenAPI-checked fake
// opamp-server (127.0.0.1:28085), collector validator (127.0.0.1:28086),
// collector tester (127.0.0.1:28087) and OTTL evaluator (127.0.0.1:28089) as
// the API's (a contract violation fails the run, see global-setup.ts). A
// second web dev server (23101) has a PostHog key whose host is a local stub
// (127.0.0.1:28095) that records what it is sent: only the analytics tests
// use them, and nothing leaves the machine.
// Two API and web pairs: the default one (28080, 23100) runs the open
// source's defaults; the SaaS's (28081, 23102) its values, for the specs of
// open registration, the Terms, the playground and the anonymous reads
// (support/saas.ts). Both share the database, Mailpit, the fakes and the file
// store. Playwright starts the servers one after another, in this order: each
// API prepares the database before it listens, and the SaaS pair's API is up
// before the analytics web server, which proxies to it, starts.
// The E2E environment is set in e2e/support/environment.ts, never read from
// .env beyond where Postgres and Mailpit are.
//
// Only `*.e2e.ts` files are browser tests; vitest's includes never match
// them, and this never matches a vitest test.
const isCi = Boolean(process.env.CI);

/**
 * Specs that change a global setting other specs depend on: the product
 * admins' switch "Only product admins can create organizations"
 * (organizations.e2e.ts and organization-logos.e2e.ts create organizations
 * as ordinary accounts, under the baseline global-setup.ts sets: off, where
 * a fresh install has it on). They run alone, after every other spec (the
 * `*-exclusive` projects below).
 */
const EXCLUSIVE_SPECS = ["**/organization-creation.e2e.ts"];

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: isCi,
  retries: 0,
  // CI runners are slower than a laptop: web-first assertions get 10 s
  // instead of 5, and each server gets 120 s to come up instead of 60.
  expect: { timeout: 10_000 },
  reporter: isCi ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E_WEB_URL,
    trace: "retain-on-first-failure",
  },
  // The three browsers run together, then the specs that change a global
  // setting other specs depend on (EXCLUSIVE_SPECS), one browser at a time:
  // each exclusive project waits for all three browsers' projects and for
  // the exclusive project before it, so nothing else runs while one turns a
  // global row on (race-free by construction, not by timing). As Playwright
  // runs dependencies, a failure in an earlier project skips the exclusive
  // ones. To run one alone, pass its project with --no-deps (e.g. --project
  // chromium-exclusive --no-deps).
  //
  // WebKit's tests get 60 s each instead of 30: on a CI runner it takes
  // about twice as long as Chromium, most of all where Monaco renders, and
  // the editor's longer tests came within a step of 30 s.
  projects: [
    { name: "chromium", testIgnore: EXCLUSIVE_SPECS, use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", testIgnore: EXCLUSIVE_SPECS, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testIgnore: EXCLUSIVE_SPECS, timeout: 60_000, use: { ...devices["Desktop Safari"] } },
    {
      name: "chromium-exclusive",
      testMatch: EXCLUSIVE_SPECS,
      dependencies: ["chromium", "firefox", "webkit"],
      use: { ...devices["Desktop Chrome"] },
    },
    { name: "firefox-exclusive", testMatch: EXCLUSIVE_SPECS, dependencies: ["chromium-exclusive"], use: { ...devices["Desktop Firefox"] } },
    {
      name: "webkit-exclusive",
      testMatch: EXCLUSIVE_SPECS,
      dependencies: ["firefox-exclusive"],
      timeout: 60_000,
      use: { ...devices["Desktop Safari"] },
    },
  ],
  // Never `reuseExistingServer`: a server already on any of these ports is not one
  // these tests configured, and could be the developer's. Playwright fails
  // instead of testing against it.
  webServer: [
    {
      command: "tsx e2e/start-fake-oidc-provider.ts",
      url: `${E2E_OIDC_ISSUER}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "tsx e2e/start-fake-opamp-server.ts",
      url: `${E2E_OPAMP_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "tsx e2e/start-fake-otelcol-validator.ts",
      url: `${E2E_OTELCOL_VALIDATOR_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "tsx e2e/start-fake-otelcol-testing.ts",
      url: `${E2E_OTELCOL_TESTING_URL}/testing/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "tsx e2e/start-fake-ottl-evaluator.ts",
      url: `${E2E_OTTL_EVALUATOR_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "tsx e2e/start-api.ts",
      url: `${E2E_API_URL}/health`,
      env: e2eApiEnv(),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "tsx e2e/start-api.ts",
      url: `${E2E_SAAS_API_URL}/health`,
      env: e2eSaasApiEnv(),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npm run dev -w @telflo/web",
      url: `${E2E_WEB_URL}/login`,
      env: e2eWebEnv(),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npm run dev -w @telflo/web",
      url: `${E2E_SAAS_WEB_URL}/login`,
      env: e2eSaasWebEnv(),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "tsx e2e/start-posthog-stub.ts",
      url: `${E2E_POSTHOG_STUB_URL}/__stub/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npm run dev -w @telflo/web",
      url: `${E2E_ANALYTICS_WEB_URL}/login`,
      env: e2eAnalyticsWebEnv(),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
