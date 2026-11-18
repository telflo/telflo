import { test as base } from "@playwright/test";
import { E2E_SAAS_WEB_URL } from "./environment.js";

/**
 * Playwright's `test` on the SaaS pair (D36-1 decision 48, Preflight ruling
 * 16): `page` and `request` reach E2E_SAAS_WEB_URL, whose web server and API
 * run the SaaS's site values (open registration, the Terms asked, the
 * playground and the anonymous reads on), where the default pair runs the
 * open source's defaults. A whole spec imports it in place of
 * @playwright/test's; a single test of a default-pair spec takes
 * `test.use({ baseURL: E2E_SAAS_WEB_URL })` in a describe of its own.
 */
export const test = base.extend({
  baseURL: async ({ baseURL: _default }, use) => {
    await use(E2E_SAAS_WEB_URL);
  },
});
