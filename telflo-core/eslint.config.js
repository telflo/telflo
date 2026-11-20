import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.react-router/**",
      // Swagger UI, vendored unchanged for the API reference page
      // (docs/third-party-assets.md): another project's built files, never
      // edited here.
      "apps/api/src/modules/public-api/docs/swagger-ui/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The API reference page's start: a classic script the browser runs
    // after the vendored bundle, which defines SwaggerUIBundle.
    files: ["apps/api/src/modules/public-api/docs/init.js"],
    languageOptions: {
      sourceType: "script",
      globals: { document: "readonly", MutationObserver: "readonly", SwaggerUIBundle: "readonly" },
    },
  },
  {
    rules: {
      // No default exports except where a framework requires them.
      "no-restricted-syntax": [
        "error",
        { selector: "ExportDefaultDeclaration", message: "No default exports. Use a named export." },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Test support never ships. The fake OIDC provider under
    // apps/api/src/testing is left out of the images (.dockerignore), so
    // production code that imported it would fail only when deployed.
    // @telflo/db/testing (packages/db/src/testing.ts) is still in the build
    // context, but is for tests alone, so production code may not import it
    // either. Tests, test support itself and the browser tests may import
    // both.
    // The CLI's integration harness (apps/cli/tests/) is test support too:
    // it imports the API's, and is never built or packed.
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/testing/**", "**/testing.ts", "**/test-database.ts", "apps/cli/tests/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/testing", "**/testing/*", "**/testing.js", "@telflo/db/testing"],
              message: "Test support never ships: import it only from tests or e2e/.",
            },
          ],
        },
      ],
    },
  },
  {
    // The CLI ships alone: an `npm pack` tarball installs with no workspace
    // beside it, so its code imports nothing from a workspace package at run
    // time. `import type`
    // only: the inline `import { type X }` leaves `import {} from …` under
    // verbatimModuleSyntax, a runtime import. scripts/check-cli-package.sh
    // searches the built dist/ too. Tests may import the workspaces.
    files: ["apps/cli/**/*.ts"],
    ignores: ["**/*.test.ts", "apps/cli/tests/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@telflo/*"],
              allowTypeImports: true,
              message: "The CLI ships alone: import type from a workspace package, never a value.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  {
    // React Router requires default exports from route modules and config files.
    // `app/routes.ts` is the route config file itself (a sibling of app/routes/,
    // not a member of it), so it needs its own explicit entry here. Playwright
    // requires one from its global setup file.
    files: [
      "apps/web/app/routes/**",
      "apps/web/app/routes.ts",
      "apps/web/app/root.tsx",
      "**/*.config.{js,ts}",
      "vitest.workspace.ts",
      "e2e/global-setup.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
);
