import type { AnalyticsSettings } from "~/lib/analytics.js";

/**
 * PostHog's settings, for root's loader to pass to the browser (D4 decision
 * 8): TELFLO_POSTHOG_KEY and, optionally, TELFLO_POSTHOG_HOST. Read at call
 * time, as public-url.server.ts reads its URL, so one image serves a hosted
 * site with analytics and an on-prem install without.
 *
 * Without a key (unset or "", the E2E servers' and the tests' "unset"), it is
 * null: PostHog is never loaded and no banner shows. A host without a key is
 * ignored. An empty host is posthog-js's own default.
 */
export function analyticsSettings(): AnalyticsSettings | null {
  const key = process.env.TELFLO_POSTHOG_KEY?.trim();
  if (!key) return null;
  const host = process.env.TELFLO_POSTHOG_HOST?.trim().replace(/\/+$/, "");
  return { key, host: host || null };
}
