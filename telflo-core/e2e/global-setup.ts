import { createDb, createPool } from "@telflo/db";
import { insertSeededFlows, insertSeededTestRegexes, truncateAll } from "@telflo/db/testing";
import { readAfterResponsePending, waitForAfterResponseDrain } from "./support/after-response.js";
import {
  E2E_API_URL,
  E2E_SAAS_API_URL,
  E2E_OPAMP_VIOLATIONS_PATH,
  E2E_OTELCOL_TESTING_VIOLATIONS_PATH,
  E2E_OTELCOL_VALIDATOR_VIOLATIONS_PATH,
  E2E_OTTL_EVALUATOR_VIOLATIONS_PATH,
  e2eOwnerDatabaseUrl,
} from "./support/environment.js";
import { assertNoFakeOpampServerViolations } from "./support/fake-opamp-server.js";
import { assertNoFakeOtelcolTestingViolations } from "./support/fake-otelcol-testing.js";
import { assertNoFakeOtelcolValidatorViolations } from "./support/fake-otelcol-validator.js";
import { assertNoFakeOttlEvaluatorViolations } from "./support/fake-ottl-evaluator.js";

/**
 * Empties telflo_platform_e2e_test once per run, so a run never sees the last
 * one's users, as the tables' owner: the API's own role can't truncate. Tests
 * don't truncate between themselves: each seeds its own users, and they run in
 * parallel. The truncation empties the flows table too, so the seeded flows
 * (migration 1700000000026) are put back after it; a test that writes flows
 * uses its own `e2e-` slugs. So too the regex library's 35 seeded entries
 * (migration 1700000000031). The truncation also turns the product admins'
 * switch "Only product admins can create organizations" off (`everyone`): the
 * browser tests' baseline, since many specs create organizations as ordinary
 * accounts, while a freshly migrated database has it on.
 * organization-creation.e2e.ts, the one spec that turns it on, runs alone and
 * puts this baseline back.
 *
 * The E2E API has already created and migrated the database by now (see
 * start-api.ts): Playwright starts the web servers before global setup.
 *
 * The teardown it returns runs after the last test, before Playwright stops
 * the web servers, and fails the run if the fake opamp-server, the fake
 * collector validator, the fake collector tester or the fake OTTL evaluator
 * saw a request from the E2E API (or sent a reply) that broke its contract
 * (support/fake-opamp-server.ts, support/fake-otelcol-validator.ts,
 * support/fake-otelcol-testing.ts, support/fake-ottl-evaluator.ts). It first
 * waits, a bounded number of times, for both E2E APIs' after-response jobs to
 * settle (the default pair's and the SaaS pair's: the count is their sum; an
 * organization's registration, a deleted configuration's clean-up), so one the
 * last test set off has reached the fake before the file is read, and fails
 * the run if they never do (support/after-response.ts).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const db = createDb(createPool(e2eOwnerDatabaseUrl()));
  try {
    await truncateAll(db);
    await insertSeededFlows(db);
    await insertSeededTestRegexes(db);
  } finally {
    await db.destroy();
  }
  return async () => {
    await waitForAfterResponseDrain(async () => {
      const [ours, saas] = await Promise.all([readAfterResponsePending(E2E_API_URL), readAfterResponsePending(E2E_SAAS_API_URL)]);
      return ours + saas;
    });
    // All read before any throws, so one run reports every fake's violations.
    const failures: unknown[] = [];
    for (const assertion of [
      () => assertNoFakeOpampServerViolations(E2E_OPAMP_VIOLATIONS_PATH),
      () => assertNoFakeOtelcolValidatorViolations(E2E_OTELCOL_VALIDATOR_VIOLATIONS_PATH),
      () => assertNoFakeOtelcolTestingViolations(E2E_OTELCOL_TESTING_VIOLATIONS_PATH),
      () => assertNoFakeOttlEvaluatorViolations(E2E_OTTL_EVALUATOR_VIOLATIONS_PATH),
    ]) {
      try {
        assertion();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Several fakes saw contract violations.");
  };
}
