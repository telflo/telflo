import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  carried,
  expect,
  isCapture,
  isFlagsOrConfig,
  isRecorderScript,
  postHogStorage,
  postHogStorageValues,
  test,
  waitForRecorded,
} from "./support/analytics.js";
import { recordedRequests } from "./support/posthog-stub.js";
import { waitForHydration } from "./support/session.js";

// Product analytics with a key (D4 decision 8), against the analytics web
// server, whose PostHog host is the local stub (support/posthog-stub.ts).
// What posthog-js really does, and so what these assert (Preflight ruling
// 3): before the visitor chooses, it loads only its flags and remote
// configuration, captures nothing, starts no replay and stores nothing;
// accepting starts capture. Replay never starts on localhost (unit tests
// prove it starts elsewhere), so it is asserted absent only before consent.
// And after accepting, an emailed link's token never reaches PostHog
// (Ruling 14).

/** posthog-js sends its queued events every 3 s (its DEFAULT_FLUSH_INTERVAL_MS). */
const POSTHOG_FLUSH_INTERVAL_MS = 3_000;

function banner(page: Page) {
  return page.getByRole("dialog", { name: "Telflo uses cookies" });
}

function preferences(page: Page) {
  return page.getByRole("dialog", { name: "Your privacy options" });
}

test("with a key, the banner shows, and until the visitor chooses PostHog loads only its flags and configuration: no capture, no replay, no ph_ storage", async ({
  page,
  context,
  tag,
}) => {
  await page.goto("/");
  await waitForHydration(page);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).getByRole("button", { name: "Allow all" })).toBeVisible();

  // PostHog has started: it asked the stub for its flags or configuration.
  await waitForRecorded(tag, isFlagsOrConfig, "PostHog's flags or configuration");

  // The preferences modal, analytics off until the visitor turns it on.
  await banner(page).getByRole("button", { name: "Cookie preferences" }).click();
  await expect(preferences(page)).toBeVisible();
  await expect(preferences(page).getByRole("heading", { name: "Strictly necessary cookies" })).toBeVisible();
  await expect(preferences(page).getByText("Always active")).toBeVisible();
  await expect(preferences(page).getByRole("switch", { name: "Analytics & session replay" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await preferences(page).getByRole("button", { name: "Close" }).click();
  await expect(banner(page)).toBeVisible();

  // A second page, still undecided, then long enough for posthog-js to have
  // sent anything it had queued: an absence needs a window to be absent in.
  await page.goto("/forgot-password");
  await waitForHydration(page);
  await expect(banner(page)).toBeVisible();
  await page.waitForTimeout(POSTHOG_FLUSH_INTERVAL_MS + 1_000);

  const requests = await recordedRequests(tag);
  expect(requests.filter(isCapture).map((request) => request.url)).toEqual([]);
  expect(requests.filter(isRecorderScript).map((request) => request.url)).toEqual([]);
  expect(requests.filter((request) => !isFlagsOrConfig(request)).map((request) => request.url)).toEqual([]);
  expect(await postHogStorage(page, context)).toEqual([]);
});

test("accepting in the preferences modal starts capture: an /e/ request, and PostHog's ph_ storage", async ({
  page,
  context,
  tag,
}) => {
  await page.goto("/");
  await waitForHydration(page);
  await banner(page).getByRole("button", { name: "Cookie preferences" }).click();
  const analyticsSwitch = preferences(page).getByRole("switch", { name: "Analytics & session replay" });
  await analyticsSwitch.click();
  await expect(analyticsSwitch).toHaveAttribute("aria-checked", "true");
  await preferences(page).getByRole("button", { name: "Confirm my choices" }).click();

  await expect(preferences(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
  await waitForRecorded(tag, isCapture, "an event (/e/)");
  await expect.poll(() => postHogStorage(page, context)).not.toEqual([]);

  // The choice is kept: the next page shows no banner.
  await page.goto("/forgot-password");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name: "Reset Password" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

/**
 * A link's token, unique to the test: letters and digits only, so neither
 * URL- nor JSON-encoding changes it, and a search of what the stub recorded
 * and decoded finds it wherever it went.
 */
function secret(): string {
  return `SECRET${randomUUID().replaceAll("-", "")}`;
}

/**
 * The visitor opens an emailed link, accepts on that page, then leaves it:
 * PostHog captures the page's address (its pageview, the person's initial
 * URL, the pageleave sent as the page unloads), and none of it may carry the
 * token.
 */
async function acceptOnEmailedLinkThenLeave(page: Page, tag: string, path: string, token: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
  // The page has taken its token out of the address bar.
  await expect.poll(() => page.url()).not.toContain(token);
  expect(page.url()).not.toContain("token");

  await banner(page).getByRole("button", { name: "Allow all" }).click();
  await expect(banner(page)).toHaveCount(0);
  const pathname = new URL(path, "http://localhost").pathname;
  await waitForRecorded(tag, (request) => isCapture(request) && request.body.includes(pathname), `an event from ${pathname}`);

  // Leaving sends the page's pageleave; the next page's own event comes after it.
  await page.goto("/forgot-password");
  await waitForHydration(page);
  await waitForRecorded(tag, (request) => isCapture(request) && request.body.includes("/forgot-password"), "an event from /forgot-password");
}

test("after accepting on /reset-password#token=…, the token is gone from the address bar and never reaches PostHog", async ({
  page,
  context,
  tag,
}) => {
  const token = secret();
  await acceptOnEmailedLinkThenLeave(page, tag, `/reset-password#token=${token}`, token);

  const requests = await recordedRequests(tag);
  expect(requests.filter(isCapture).length).toBeGreaterThan(0);
  expect(requests.filter((request) => carried(request).includes(token)).map((request) => request.url)).toEqual([]);
  expect(await postHogStorageValues(page, context)).not.toContain(token);
});

test("after accepting on /verify-email?token=…, the token is gone from the address bar and never reaches PostHog", async ({
  page,
  context,
  tag,
}) => {
  const token = secret();
  await acceptOnEmailedLinkThenLeave(page, tag, `/verify-email?token=${token}`, token);

  const requests = await recordedRequests(tag);
  expect(requests.filter(isCapture).length).toBeGreaterThan(0);
  expect(requests.filter((request) => carried(request).includes(token)).map((request) => request.url)).toEqual([]);
  expect(await postHogStorageValues(page, context)).not.toContain(token);
});
