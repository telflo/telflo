import { randomUUID } from "node:crypto";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { E2E_ANALYTICS_WEB_URL } from "./environment.js";
import { recordedRequests, TAG_HEADER, type RecordedRequest } from "./posthog-stub.js";

// The analytics tests' browsers, which PostHog must take for a person's.
// posthog-js drops every event from what it takes for a bot (its
// `isLikelyBot`): a user agent or `navigator.userAgentData` brand naming
// `HeadlessChrome`, or `navigator.webdriver` true. Playwright's browsers are
// some of that by default, so without this "after accepting, an /e/ request"
// would never happen:
// - the user agent is the project's own, which names no headless browser;
// - Chromium runs as the full browser in its new headless mode (the
//   `chromium` channel, which `playwright install chromium` installs beside
//   the headless shell): the headless shell's brands name HeadlessChrome;
// - `navigator.webdriver` reads false, from an init script, in all three
//   browsers (Chromium's `--disable-blink-features=AutomationControlled` would
//   do it for Chromium alone; Firefox and WebKit have no such switch).
//
// And each test's browser sends a tag of its own in a header on every
// request (support/posthog-stub.ts), so a test reads back only its own
// requests from the stub.

export const test = base.extend<{ tag: string }, object>({
  channel: [async ({ browserName }, use) => use(browserName === "chromium" ? "chromium" : undefined), { scope: "worker" }],
  baseURL: E2E_ANALYTICS_WEB_URL,
  // Playwright reads a fixture's dependencies from its first parameter's
  // pattern, so a fixture that needs none has an empty one.
  // eslint-disable-next-line no-empty-pattern
  tag: async ({}, use) => use(randomUUID()),
  extraHTTPHeaders: async ({ extraHTTPHeaders, tag }, use) => use({ ...extraHTTPHeaders, [TAG_HEADER]: tag }),
  context: async ({ context }, use) => {
    await context.addInitScript(
      `Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });`,
    );
    await use(context);
  },
});

export { expect };

/** posthog-js's event and replay endpoints: none may be called before consent (Preflight ruling 3). */
export function isCapture(request: RecordedRequest): boolean {
  return /^\/(e|i|s)(\/|$)/.test(request.path);
}

/** posthog-js's session recorder, loaded only when replay starts. */
export function isRecorderScript(request: RecordedRequest): boolean {
  return /recorder/i.test(request.path);
}

/**
 * What posthog-js asks for before consent (decision 8): its flags
 * (`/flags/`) and its remote configuration (`/array/<key>/config` and
 * `config.js`), and a CORS preflight for either.
 */
export function isFlagsOrConfig(request: RecordedRequest): boolean {
  return /^\/flags\/?$/.test(request.path) || /^\/array\/[^/]+\/config(\.js)?$/.test(request.path);
}

/** Waits until the stub has recorded a request from this test's browser that `matches`, and returns them all. */
export async function waitForRecorded(
  tag: string,
  matches: (request: RecordedRequest) => boolean,
  description: string,
): Promise<RecordedRequest[]> {
  let requests: RecordedRequest[] = [];
  await expect
    .poll(
      async () => {
        requests = await recordedRequests(tag);
        return requests.some(matches);
      },
      { message: `the PostHog stub recorded ${description}`, timeout: 15_000 },
    )
    .toBe(true);
  return requests;
}

/** Names of PostHog's `ph_…` cookies and storage keys in the page's origin. */
export async function postHogStorage(page: Page, context: BrowserContext): Promise<string[]> {
  const cookies = (await context.cookies()).map((cookie) => `cookie ${cookie.name}`);
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  const keys = await page.evaluate<string[]>(
    `[...Object.keys(localStorage).map((key) => "localStorage " + key), ...Object.keys(sessionStorage).map((key) => "sessionStorage " + key)]`,
  );
  return [...cookies, ...keys].filter((name) => / ph_/.test(name));
}

/** Every `ph_…` cookie's and storage entry's value in the page's origin, for searching. */
export async function postHogStorageValues(page: Page, context: BrowserContext): Promise<string> {
  const cookies = (await context.cookies()).filter((cookie) => cookie.name.startsWith("ph_"));
  const stored = await page.evaluate<string[]>(
    `[localStorage, sessionStorage].flatMap((storage) => Object.keys(storage).filter((key) => key.startsWith("ph_")).map((key) => storage.getItem(key) ?? ""))`,
  );
  return [...cookies.map((cookie) => decodeURIComponent(cookie.value)), ...stored].join("\n");
}

/** Everything a recorded request carried: its address, headers and decoded body. */
export function carried(request: RecordedRequest): string {
  return `${request.url}\n${request.headers}\n${request.body}`;
}
