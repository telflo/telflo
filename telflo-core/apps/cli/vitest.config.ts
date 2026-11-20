import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cli",
    // Unit tests beside their modules; the integration tests and their
    // harness in tests/.
    include: ["src/**/*.test.ts", "tests/**/*.integration.test.ts"],
    fileParallelism: false,
    // The integration tests run the real API on the agent's test database:
    // vitest.global-setup.ts creates and migrates it first.
    globalSetup: ["../../vitest.global-setup.ts"],
    // tests/setup.ts keeps every run away from a real login: no TELFLO_*
    // variable of the shell, and a temporary config folder and HOME.
    setupFiles: ["../../vitest.setup.ts", "./tests/setup.ts"],
  },
});
