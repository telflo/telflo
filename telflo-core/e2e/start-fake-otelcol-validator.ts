import { E2E_OTELCOL_VALIDATOR_PORT, E2E_OTELCOL_VALIDATOR_VIOLATIONS_PATH } from "./support/environment.js";
import { startE2eFakeOtelcolValidator } from "./support/fake-otelcol-validator.js";

// The browser tests' collector validator: the OpenAPI-checked fake from
// apps/api/src/testing, on 127.0.0.1:28086, which the E2E API's
// TELFLO_OTELCOL_VALIDATOR_* settings name (e2eApiEnv). No collector in the
// browser tests: it answers by the text
// (support/fake-otelcol-validator.ts). Each contract violation goes to
// stderr and to E2E_OTELCOL_VALIDATOR_VIOLATIONS_PATH as the fake sees it,
// and global-setup.ts's teardown fails the run on any. It lives under e2e/
// and never ships. playwright.config.ts starts it, and waits for its
// /health.

const fake = await startE2eFakeOtelcolValidator({
  port: E2E_OTELCOL_VALIDATOR_PORT,
  violationsPath: E2E_OTELCOL_VALIDATOR_VIOLATIONS_PATH,
});

async function stop(): Promise<void> {
  // Already reported, to stderr and the file, as each was seen.
  const unread = fake.takeViolations();
  await fake.close();
  process.exit(unread.length > 0 ? 1 : 0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
