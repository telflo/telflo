import { E2E_POSTHOG_STUB_HOSTNAME, E2E_POSTHOG_STUB_PORT } from "./support/environment.js";
import { startPostHogStub } from "./support/posthog-stub.js";

// The analytics tests' PostHog host (support/posthog-stub.ts), on
// 127.0.0.1:28095. It lives under e2e/ and never ships. playwright.config.ts
// starts it, and waits for its health check.

const server = await startPostHogStub({ port: E2E_POSTHOG_STUB_PORT, hostname: E2E_POSTHOG_STUB_HOSTNAME });

function stop(): void {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
