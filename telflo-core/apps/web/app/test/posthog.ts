import { vi } from "vitest";

/**
 * posthog-js, mocked at its module boundary, for the tests of lib/analytics.ts
 * and of what uses it. Each test gets a fresh analytics module and a fresh
 * mock, so `imported` counts this test's imports alone:
 *
 *   beforeEach(() => {
 *     posthog = mockPostHog();
 *   });
 *   const { useAnalytics } = await import("~/lib/analytics.js");
 *
 * Any module that imports lib/analytics.ts has to be imported the same way,
 * after mockPostHog, so it shares that fresh module.
 */
export function mockPostHog() {
  const client = {
    init: vi.fn(),
    opt_in_capturing: vi.fn(),
    clear_opt_in_out_capturing: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    set_config: vi.fn(),
    capture: vi.fn(),
    onFeatureFlags: vi.fn(),
    isFeatureEnabled: vi.fn(),
    getFeatureFlag: vi.fn(),
  };
  const mock = { imported: vi.fn(), client };
  vi.resetModules();
  vi.doMock("posthog-js", () => {
    mock.imported();
    return { default: client };
  });
  return mock;
}

export type PostHogMock = ReturnType<typeof mockPostHog>;

/** Long enough for a dynamic import, and whatever waits on it, to have run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
