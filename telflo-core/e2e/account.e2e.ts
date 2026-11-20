import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { findSessions, seedUser, setSessionIpAddress, type SeededUser } from "./support/database.js";
import { open } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { waitForEmail } from "./support/mail.js";
import {
  attributeHoldersOf,
  recordRequestUrls,
  recordToasts,
  storageHolding,
  toastsHolding,
  urlsHolding,
} from "./support/privacy.js";
import {
  expireAccessToken,
  savePreferencesThroughApi,
  serverHtmlClass,
  signInThroughForm,
  themeCookie,
  waitForHydration,
} from "./support/session.js";

// Settings › Account across two browsers: this browser (the test's own
// context, with the project's Playwright device's user agent, which reads
// the same on any host: Desktop Chrome's "Chrome on Windows", Desktop
// Firefox's "Firefox on Windows", Desktop Safari's "Safari on macOS") and
// another one, a second context with its own cookie jar and a Firefox on
// Linux user agent, so its row reads apart from "This browser". Both sign in
// through the form, so each session records its browser's own user agent.
//
// Privacy: the account's email and a session's IP address are
// visible text only, never in an attribute, a URL, a toast or browser
// storage. Every browser test signs in from the loopback, so the other
// session's IP is set to an address of the test's own (TEST-NET-3) to look
// for; the other browser's user agent carries a token of its own, which the
// API parses into families and never sends back. The passwords live only in
// the form's fields: never in an attribute (filled, or after the answer), a
// URL, a toast or browser storage.

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new passphrase for this account";
const CANARY_IP = "203.0.113.77";
const USER_AGENT_CANARY = "e2e-user-agent-canary";
const FIREFOX_ON_LINUX = `Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 ${USER_AGENT_CANARY}`;

/** This browser's row, by the project's device's user agent. */
const THIS_BROWSER_ROW = { chromium: "Chrome on Windows", firefox: "Firefox on Windows", webkit: "Safari on macOS" } as const;

const test = base.extend<{ other: BrowserContext }>({
  other: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: E2E_WEB_URL, userAgent: FIREFOX_ON_LINUX });
    await use(context);
    await context.close();
  },
});

function sessionRows(page: Page) {
  return page.getByRole("list", { name: "Sessions" }).getByRole("listitem");
}

function signedIn(page: Page) {
  return page.getByTitle("Switch organization");
}

/** Signs `user` in on this browser and on the other one; answers the other browser's page, on /app. */
async function signInOnBoth(page: Page, other: BrowserContext, user: SeededUser): Promise<Page> {
  await signInThroughForm(page, user);
  const otherPage = await other.newPage();
  await signInThroughForm(otherPage, user);
  return otherPage;
}

/** The other browser's session: the newer of the two. */
async function otherSessionId(user: SeededUser): Promise<string> {
  const sessions = await findSessions(user.userId);
  expect(sessions).toHaveLength(2);
  return sessions[1]!.id;
}

/** Settings › Account's Sessions card, both rows read. */
async function openAccount(page: Page): Promise<void> {
  await open(page, "/settings/account");
  await expect(sessionRows(page)).toHaveCount(2);
}

test("changing the password keeps the other browser signed in, and its email arrives", async ({
  page,
  context,
  other,
  request,
  browserName,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  const otherPage = await signInOnBoth(page, other, user);
  await setSessionIpAddress(await otherSessionId(user), CANARY_IP);

  await openAccount(page);
  // This browser first, then the other, each named by its browser and system.
  await expect(sessionRows(page).nth(0)).toContainText(THIS_BROWSER_ROW[browserName]);
  await expect(sessionRows(page).nth(0)).toContainText("This browser");
  await expect(sessionRows(page).nth(0).getByRole("button")).toHaveCount(0);
  await expect(sessionRows(page).nth(1)).toContainText("Firefox on Linux");
  await expect(sessionRows(page).nth(1)).not.toContainText("This browser");
  await expect(sessionRows(page).nth(1)).toContainText(`IP address ${CANARY_IP}`);
  await expect(sessionRows(page).nth(1).getByRole("button", { name: /^Sign out the session signed in / })).toBeVisible();
  // In the page: the sidebar's switcher shows it too, as the personal organization's name.
  await expect(page.getByRole("main").getByText(user.email, { exact: true })).toBeVisible();

  await page.getByLabel("Current Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("New Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm New Password", { exact: true }).fill(NEW_PASSWORD);
  // Filled, before sending: in the fields' values alone, never an attribute.
  const passwords = [PASSWORD, NEW_PASSWORD];
  expect(await attributeHoldersOf(page, passwords)).toEqual([[], []]);
  await page.getByRole("button", { name: "Update Password" }).click();
  await expect(page.getByText("Password updated successfully", { exact: true })).toBeVisible();
  for (const label of ["Current Password", "New Password", "Confirm New Password"]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
  }
  expect(await attributeHoldersOf(page, passwords)).toEqual([[], []]);

  const email = await waitForEmail({ to: user.email, subject: "Your Telflo password was changed" });
  expect(email).toContain("The password for your Telflo account was changed from Settings.");

  // The other browser stays signed in, past its access token: its refresh still works.
  await expireAccessToken(other);
  await open(otherPage, "/app");
  await expect(otherPage).toHaveURL("/app");
  await expect(signedIn(otherPage)).toBeVisible();
  expect((await findSessions(user.userId)).map((session) => session.revoked_at)).toEqual([null, null]);

  // Only the new password signs in now.
  const signIn = (password: string) =>
    request.post("/api/v1/auth/sessions", {
      data: { email: user.email, password },
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
  expect((await signIn(PASSWORD)).status()).toBe(401);
  expect((await signIn(NEW_PASSWORD)).status()).toBe(200);

  // The email, the IP address and the user agent: visible text only; the passwords nowhere.
  const canaries = [user.email, CANARY_IP, USER_AGENT_CANARY];
  expect(await attributeHoldersOf(page, canaries)).toEqual([[], [], []]);
  expect(await storageHolding(page, [...canaries, ...passwords])).toEqual([]);
  expect(urlsHolding(urls, [...canaries, ...passwords])).toEqual([]);
  expect(toastsHolding(toasts, [...canaries, ...passwords])).toEqual([]);
  expect(toasts).toContain("Password updated successfully");
  expect(await page.locator("body").innerText()).not.toContain(USER_AGENT_CANARY);
});

test("Sign out on the other browser's row sends that browser to sign in at its next navigation", async ({ page, context, other }) => {
  const user = await seedUser({ password: PASSWORD });
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  const otherPage = await signInOnBoth(page, other, user);
  const otherSession = await otherSessionId(user);
  await setSessionIpAddress(otherSession, CANARY_IP);

  await openAccount(page);
  const otherRow = sessionRows(page).filter({ hasText: "Firefox on Linux" });
  await otherRow.getByRole("button", { name: /^Sign out the session signed in / }).click();
  await expect(page.getByText("Session signed out.", { exact: true })).toBeVisible();
  await expect(sessionRows(page)).toHaveCount(1);
  await expect(sessionRows(page)).toContainText("This browser");

  const sessions = await findSessions(user.userId);
  expect(sessions.find((session) => session.id === otherSession)?.revoked_reason).toBe("signed_out_elsewhere");
  expect(sessions.find((session) => session.id !== otherSession)?.revoked_at).toBeNull();

  // The other browser's next navigation, a link in its shell, lands on sign-in.
  await otherPage.getByRole("link", { name: "Configurations", exact: true }).click();
  await expect(otherPage).toHaveURL("/login?redirectTo=%2Fapp");

  // This browser is still signed in.
  await page.reload();
  await waitForHydration(page);
  await expect(signedIn(page)).toBeVisible();

  // The toast is fixed words: no email, IP address or user agent in it, or in a URL.
  const canaries = [user.email, CANARY_IP, USER_AGENT_CANARY];
  expect(toasts).toContain("Session signed out.");
  expect(toastsHolding(toasts, canaries)).toEqual([]);
  expect(urlsHolding(urls, canaries)).toEqual([]);
});

test("Sign out everywhere, confirmed, ends both browsers' sessions and keeps the theme cookie", async ({
  page,
  context,
  other,
  browser,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  const otherPage = await signInOnBoth(page, other, user);
  await setSessionIpAddress(await otherSessionId(user), CANARY_IP);
  // A theme other than the default, so keeping the cookie shows.
  await savePreferencesThroughApi(page, { theme: "navy" });
  expect(await themeCookie(context)).toBe("navy");

  await openAccount(page);
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere?" });
  await expect(dialog).toContainText("This signs you out of Telflo in every browser, this one included.");
  await dialog.getByRole("button", { name: "Sign out everywhere" }).click();

  await expect(page).toHaveURL("/login");
  await expect(page.getByText("Signed out everywhere", { exact: true })).toBeVisible();
  expect((await findSessions(user.userId)).every((session) => session.revoked_at !== null)).toBe(true);
  // The theme cookie is never cleared: a full load of /login, JavaScript off, is still Navy.
  expect(await themeCookie(context)).toBe("navy");
  expect(await serverHtmlClass(browser, context, "/login")).toEqual({ url: `${E2E_WEB_URL}/login`, htmlClass: "dark navy" });

  await otherPage.getByRole("link", { name: "Configurations", exact: true }).click();
  await expect(otherPage).toHaveURL("/login?redirectTo=%2Fapp");
  await page.goto("/app");
  await expect(page).toHaveURL("/login?redirectTo=%2Fapp");

  // The toast is fixed words: no email, IP address or user agent in it, or in a URL.
  const canaries = [user.email, CANARY_IP, USER_AGENT_CANARY];
  expect(toasts).toContain("Signed out everywhere");
  expect(toastsHolding(toasts, canaries)).toEqual([]);
  expect(urlsHolding(urls, canaries)).toEqual([]);
});
