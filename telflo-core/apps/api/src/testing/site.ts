/**
 * The Terms version the API's tests run with (D36-1 Preflight ruling 14):
 * vitest.setup.ts pins TELFLO_TERMS_VERSION to it, the SaaS's value and the
 * one registration recorded before the version became a setting, so a test
 * that registers, accepts or seeds a user's Terms names it from here.
 */
export const TEST_TERMS_VERSION = "2026-01-01";
