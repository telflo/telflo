import type { Kysely } from "kysely";
import type { CustomFetch } from "openid-client";
import type { Database } from "@telflo/db";
import type { AppSettings } from "./settings.js";
import type { IMailer } from "./mail/mailer.js";
import type { RateLimits } from "./http/rate-limits.js";
import type { RunAfterResponse } from "./http/after-response.js";
import type { OpampServerClient } from "./opamp-server/client.js";
import type { OtelcolValidatorClient } from "./otelcol-validator/client.js";
import type { TestingDependencies } from "./modules/test-runs/test-runs-dependencies.js";
import type { InstallTemplateLoader } from "./install/templates.js";
import type { IFileStore } from "./file-store/file-store.js";

/**
 * What the server hands to every module. Declared here rather than in
 * server.ts because route modules need the type and server.ts needs the
 * routes; a shared module breaks the cycle instead of relying on type-only
 * imports erasing at runtime.
 */
export interface ServerDependencies {
  settings: AppSettings;
  db: Kysely<Database>;
  mailer: IMailer;
  /**
   * The clock for token issue and expiry. Optional so production wiring can
   * leave it out; tests pass one they can advance instead of sleeping.
   * Defaults to `() => new Date()` in buildServer.
   */
  now?: () => Date;
  /**
   * Overrides RATE_LIMITS. Tests only: every test server passes
   * TEST_RATE_LIMITS unless it is testing the limits themselves (Preflight
   * Ruling 2). Production wiring never sets it.
   */
  rateLimits?: RateLimits;
  /**
   * Runs work after the response (D3 decision 2). Defaults to
   * createAfterResponseRunner in buildServer. Every test server that calls an
   * email endpoint passes createCollectingRunner's `run`, so no queued work
   * outlives its test.
   */
  runAfterResponse?: RunAfterResponse;
  /**
   * Where the server's log lines go. Tests only, to read what a request
   * logged; production logs to stdout. Set LOG_LEVEL too: tests run silent.
   */
  logStream?: { write(line: string): void };
  /**
   * Every request the OIDC providers' configurations make goes through it.
   * Tests only, to make a provider unreachable without the network;
   * production uses the global fetch.
   */
  oidcFetch?: CustomFetch;
  /**
   * The opamp-server's management API (D11a decision 12), built in index.ts
   * from settings.opampServer; required (D11b decision 8). The
   * organizations' changes are sent to its registry after each commit
   * (D11a decision 20), and D11b publishes through it. Tests pass a client
   * of the fake (testing/opamp-server.ts).
   */
  opampServer: OpampServerClient;
  /**
   * The collector validator (D13b decisions 11 and 12), built in index.ts
   * from settings.otelcolValidator; required. A version's validation asks it
   * after its read commits. Tests about validation pass a client of the
   * fake (testing/otelcol-validator.ts); every other test server passes
   * UNCALLED_OTELCOL_VALIDATOR, which fails a test that reaches it.
   */
  otelcolValidator: OtelcolValidatorClient;
  /**
   * Where the platform's files live (ADR 0012; D23-2 decision 31): test
   * files, runs' files, test templates, definitions' inputs, and from D23-2
   * organizations' logos and library files. Built once in index.ts and
   * e2e/start-api.ts by createFileStore (its startup check runs before
   * listen) and shared with the test runs' background work; required, so
   * production wiring can't leave it out. Tests that keep files pass a
   * store of their own (on a temporary directory); every other test server
   * passes UNCALLED_FILE_STORE (testing/file-store.ts), which fails a test
   * that reaches it.
   */
  fileStore: IFileStore;
  /**
   * The test runs' collaborators (D14a Preflight ruling 17): the collector
   * tester's client and its health monitor, the queue's wake,
   * and the OTTL evaluator's client and its health monitor (D15a: a rule's
   * save is checked, and a run's rules evaluated, through it). Built in
   * index.ts and e2e/start-api.ts by createTestRunsDependencies; required.
   * Tests about test runs and validation rules pass their own (the fake
   * tester's client, the fake evaluator's: testing/ottl-evaluator.ts);
   * every other test server passes
   * UNCALLED_TESTING (testing/otelcol-testing.ts), whose evaluator is
   * UNCALLED_OTTL_EVALUATOR, which fails a test that reaches it.
   */
  testing: TestingDependencies;
  /**
   * The install templates' loader (D17c-1 decision 36), built and checked in
   * index.ts and e2e/start-api.ts before listening (checkInstallTemplates).
   * Optional: left out, the fleet routes build one on
   * settings.install.templatesDirectory, which the tests' setup points at
   * the repository's set. It reads the directory again on every render.
   */
  installTemplates?: InstallTemplateLoader;
}
