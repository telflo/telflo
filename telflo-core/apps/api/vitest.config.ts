import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    fileParallelism: false,
    // Creates and migrates the test database before any worker starts; see
    // vitest.global-setup.ts for why each database-using package declares it.
    globalSetup: ["../../vitest.global-setup.ts"],
    setupFiles: ["../../vitest.setup.ts"],
  },
});
