import { E2E_OPAMP_CONTROL_PORT, E2E_OPAMP_PORT, E2E_OPAMP_VIOLATIONS_PATH } from "./support/environment.js";
import { startE2eFakeOpampServer, startFakeOpampServerControl } from "./support/fake-opamp-server.js";

// The browser tests' opamp-server: the OpenAPI-checked fake from
// apps/api/src/testing, on 127.0.0.1:28085, which the E2E API's
// TELFLO_OPAMP_MANAGEMENT_* settings name (e2eApiEnv). No Go in the browser
// tests. Each contract violation goes to stderr and to
// E2E_OPAMP_VIOLATIONS_PATH as the fake sees it, and global-setup.ts's
// teardown fails the run on any (support/fake-opamp-server.ts). Its control
// port (support/fake-opamp-server.ts), on 127.0.0.1:E2E_OPAMP_CONTROL_PORT,
// lets a test enroll collectors, set their state and record their errors;
// it listens before the fake does. It lives under e2e/ and never ships.
// playwright.config.ts starts it, and waits for its /health.

const fakeStarted = startE2eFakeOpampServer({ port: E2E_OPAMP_PORT, violationsPath: E2E_OPAMP_VIOLATIONS_PATH });
const controlServer = await startFakeOpampServerControl(fakeStarted, E2E_OPAMP_CONTROL_PORT);
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
