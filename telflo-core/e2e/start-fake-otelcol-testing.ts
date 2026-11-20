import {
  E2E_OTELCOL_TESTING_CONTROL_PORT,
  E2E_OTELCOL_TESTING_PORT,
  E2E_OTELCOL_TESTING_VIOLATIONS_PATH,
} from "./support/environment.js";
import { startE2eFakeOtelcolTesting, startFakeOtelcolTestingControl } from "./support/fake-otelcol-testing.js";

// The browser tests' collector tester: the OpenAPI-checked fake from
// apps/api/src/testing, on 127.0.0.1:28087, which the E2E API's
// TELFLO_OTELCOL_TESTING_* settings name (e2eApiEnv). No collector and no
// kwok in the browser tests: it answers by markers in the text
// (support/fake-otelcol-testing.ts). Each contract violation goes to stderr
// and to E2E_OTELCOL_TESTING_VIOLATIONS_PATH as the fake sees it, and
// global-setup.ts's teardown fails the run on any. Its control route
// (support/fake-otelcol-testing.ts), on E2E_OTELCOL_TESTING_CONTROL_PORT,
// lets a test count and release its own held `slow` runs; it listens before
// the fake does. It lives under e2e/ and never ships. playwright.config.ts
// starts it, and waits for its /testing/v1/health.

const fakeStarted = startE2eFakeOtelcolTesting({
  port: E2E_OTELCOL_TESTING_PORT,
  violationsPath: E2E_OTELCOL_TESTING_VIOLATIONS_PATH,
});
const controlServer = await startFakeOtelcolTestingControl(fakeStarted, E2E_OTELCOL_TESTING_CONTROL_PORT);
const fake = await fakeStarted;

async function stop(): Promise<void> {
  // Already reported, to stderr and the file, as each was seen.
  const unread = fake.takeViolations();
  controlServer.closeAllConnections();
  await new Promise<void>((done) => controlServer.close(() => done()));
  await fake.close();
  process.exit(unread.length > 0 ? 1 : 0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
