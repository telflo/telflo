import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Coverage is a whole-run concern (one report spanning every workspace
// project), so it is configured here at the root rather than duplicated
// into each package's vitest.config.ts. vitest.workspace.ts still lists the
// projects themselves.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // `exclude` REPLACES vitest's defaults rather than extending them, so
      // this must start from coverageConfigDefaults.exclude (which is what
      // keeps test files, *.config.*, migrations' .d.ts, etc. out of the
      // denominator) and only add to it. apps/*/dist are stray, gitignored
      // `tsc --build` output living inside the workspace (see .gitignore) —
      // a duplicate compiled mirror of src/, not source under test. Counting
      // it would silently deflate the thresholds below with files nobody
      // can write a test against.
      // vitest.setup.ts files (and vitest.global-setup.ts) are test harness (jsdom stubs, env loading),
      // not product code, for the same reason config files are excluded.
      // apps/web/build is the same kind of stray, gitignored output: a local
      // `react-router build` leaves bundled JS there. e2e/ is the Playwright
      // browser tests and their support code, which vitest never runs.
      exclude: [
        ...coverageConfigDefaults.exclude,
        "**/dist/**",
        "**/build/**",
        "**/vitest.setup.ts",
        "vitest.global-setup.ts",
        "e2e/**",
        // The stack smoke test's entry point (D11a Preflight ruling 12): it
        // runs only inside the compose stack. Its sequence, runStackSmoke, is
        // tested against the fake.
        "apps/api/src/opamp-server/stack-smoke.ts",
        // The CLI's bin entry (D27 Preflight ruling 5): three lines (the
        // shebang, the import, `await main(process.argv)`); `main` and `run`
        // are tested in program.test.ts.
        "apps/cli/src/index.ts",
        // The CLI's integration harness and its helpers (D27 Preflight
        // ruling 4): test support, never built or packed, not product code.
        "apps/cli/tests/**",
      ],
      thresholds: {
        // Raised on 2026-09-25 at D2a's final review, which measured 97.06%
        // statements, 93.5% branches, 92.7% functions, 97.06% lines (with
        // **dist/, **build/ and vitest.setup.ts excluded, see the `exclude`
        // comment above), each set a little below its measurement so the
        // gate fails on real regressions rather than on incidental jitter.
        // This is a floor that ratchets up as coverage improves, not an
        // aspirational target: raise these numbers when measured coverage
        // genuinely rises, never lower them to make a red build green.
        statements: 96,
        branches: 92,
        functions: 91,
        lines: 96,
      },
    },
  },
});
