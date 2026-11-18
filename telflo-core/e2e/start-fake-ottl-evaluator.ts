import { E2E_OTTL_EVALUATOR_PORT, E2E_OTTL_EVALUATOR_VIOLATIONS_PATH } from "./support/environment.js";
import { startE2eFakeOttlEvaluator } from "./support/fake-ottl-evaluator.js";

// The browser tests' OTTL evaluator (D15a Task 5, Preflight ruling 28): the
// OpenAPI-checked fake from apps/api/src/testing, on 127.0.0.1:28089, which
// the E2E API's TELFLO_OTTL_EVALUATOR_* settings name (e2eApiEnv). No OTTL in
// the browser tests: it answers by markers in the rules
// (support/fake-ottl-evaluator.ts). Each contract violation goes to stderr
// and to E2E_OTTL_EVALUATOR_VIOLATIONS_PATH as the fake sees it, and
// global-setup.ts's teardown fails the run on any. It lives under e2e/ and
// never ships. playwright.config.ts starts it, and waits for its /health.

const fake = await startE2eFakeOttlEvaluator({
  port: E2E_OTTL_EVALUATOR_PORT,
  violationsPath: E2E_OTTL_EVALUATOR_VIOLATIONS_PATH,
});

async function stop(): Promise<void> {
  // Already reported, to stderr and the file, as each was seen.
  const unread = fake.takeViolations();
  await fake.close();
  process.exit(unread.length > 0 ? 1 : 0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
