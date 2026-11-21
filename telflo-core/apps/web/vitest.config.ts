import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { mdxPlugin } from "./mdx.config.js";

export default defineConfig({
  // The blog's posts are MDX, compiled as the build compiles them
  // (mdx.config.ts). React Router's plugin stays out: it would compile the
  // route modules for the framework, not for the tests.
  plugins: [mdxPlugin(), tsconfigPaths()],
  test: {
    name: "web",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // A hang guard well above the setup's 5 s for each findBy/waitFor, so a
    // wait that fails after earlier steps reports Testing Library's error
    // ("Unable to find …"), not vitest's "Test timed out in 5000ms".
    testTimeout: 15_000,
    // monaco-yaml's bundled worker runs in the schema tests as the editor
    // runs it (app/test/schema-worker.ts). Inlined, it goes through
    // Vite's module graph, so the test's mock of
    // `monaco-worker-manager/worker` hands over its language service.
    // Only the worker file: the tests that mock `monaco-yaml` itself are
    // untouched.
    server: { deps: { inline: [/monaco-yaml\/yaml\.worker\.js$/] } },
    include: ["app/**/*.test.ts", "app/**/*.test.tsx", "scripts/**/*.test.ts"],
  },
});
