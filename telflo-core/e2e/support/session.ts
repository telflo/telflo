import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, THEME_COOKIE_NAME } from "@telflo/contracts";
import { createAccessTokens } from "../../apps/api/src/modules/sessions/access-tokens.js";
import { ACCESS_COOKIE_NAME } from "../../apps/api/src/modules/sessions/cookies.js";
import { E2E_ACCESS_TOKEN_SECRET, E2E_ACCESS_TOKEN_TTL_MINUTES, E2E_WEB_URL } from "./environment.js";

export interface Credentials {
  email: string;
  password: string;
}

/**
 * Waits until React has taken over the server-rendered page. Until then a
 * click lands on inert HTML and is lost, and hydration clears what was typed.
 * On a cold dev server (every CI run, and each browser's first page) that
 * window is long enough for a test to fall into it. Once React has attached
 * to the document, which marks it with a `__reactContainer$…` key, React 19
 * captures events and replays them after hydration, so nothing is lost.
 */
export async function waitForHydration(page: Page): Promise<void> {
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  await page.waitForFunction(`Object.keys(document).some((key) => key.startsWith("__reactContainer$"))`);
}

/** Signs in the way a person does: the /login form, then the shell at /app. */
export async function signInThroughForm(page: Page, { email, password }: Credentials): Promise<void> {
  await page.goto("/login");
  await waitForHydration(page);
  await page.getByLabel("Email").fill(email);
  // The show/hide toggle is also labeled "…password", so match exactly.
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/app");
}

/**
 * Signs in without the form, for tests about something else. `page.request`
 * shares the page's cookie jar, so the session cookies land where the page
 * will send them. Stays on whatever page is open.
 */
export async function signInThroughApi(page: Page, { email, password }: Credentials): Promise<void> {
  const response = await page.request.post("/api/v1/auth/sessions", {
    data: { email, password },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(200);
}

/**
 * Switches the page's session to another organization without the sidebar,
 * for tests about something else: the API sets the new access cookie in the
 * page's cookie jar. Stays on whatever page is open, so the page still shows
 * the organization it last loaded until its next navigation.
 */
export async function switchOrganizationThroughApi(page: Page, organizationId: string): Promise<void> {
  const response = await page.request.put("/api/v1/auth/sessions/current/organization", {
    data: { organizationId },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(200);
}

const MINUTE_MS = 60_000;

/**
 * Replaces the access cookie's token with one for the same user, session and
 * organization that expired a minute ago, signed with the E2E API's secret:
 * what the browser holds after 16 idle minutes, without waiting for them.
 * Minted with the API's own `createAccessTokens`, its clock set 16 minutes
 * back, so the token differs from a real one only in its dates. The cookie
 * keeps its other attributes.
 */
export async function expireAccessToken(context: BrowserContext): Promise<void> {
  const cookie = (await context.cookies()).find((candidate) => candidate.name === ACCESS_COOKIE_NAME);
  if (!cookie) throw new Error(`expireAccessToken: no ${ACCESS_COOKIE_NAME} cookie; sign in first`);

  // The E2E secret verifies the cookie's token too, which is how its claims
  // are read: no second JWT library, and a cookie the API didn't sign fails
  // here rather than as a confusing 401 later.
  const current = await createAccessTokens({
    secret: E2E_ACCESS_TOKEN_SECRET,
    ttlMinutes: E2E_ACCESS_TOKEN_TTL_MINUTES,
    now: () => new Date(),
  }).verify(cookie.value);
  if (current.status === "invalid") {
    throw new Error(`expireAccessToken: the ${ACCESS_COOKIE_NAME} cookie holds no token the E2E API signed`);
  }

  const issuedAt = new Date(Date.now() - (E2E_ACCESS_TOKEN_TTL_MINUTES + 1) * MINUTE_MS);
  const { token } = await createAccessTokens({
    secret: E2E_ACCESS_TOKEN_SECRET,
    ttlMinutes: E2E_ACCESS_TOKEN_TTL_MINUTES,
    now: () => issuedAt,
  }).issue(current.claims);

  await context.addCookies([{ ...cookie, value: token }]);
}

/**
 * Saves preferences without Settings, for tests about something else: the
 * API stores them and, for a theme, sets the `telflo_theme` cookie in the
 * page's cookie jar. Stays on whatever page is open, which shows the change
 * at its next navigation.
 */
export async function savePreferencesThroughApi(page: Page, preferences: Record<string, unknown>): Promise<void> {
  const response = await page.request.patch("/api/v1/auth/me/preferences", {
    data: preferences,
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(200);
}

/** The `telflo_theme` cookie's word in `context`, or undefined when it holds none. */
export async function themeCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === THEME_COOKIE_NAME)?.value;
}

/**
 * Sets the `telflo_theme` cookie in `context` to `value`, keeping its other
 * attributes, as a browser that was last told another theme holds it.
 */
export async function setThemeCookie(context: BrowserContext, value: string): Promise<void> {
  const cookie = (await context.cookies()).find((candidate) => candidate.name === THEME_COOKIE_NAME);
  if (!cookie) throw new Error(`setThemeCookie: no ${THEME_COOKIE_NAME} cookie; sign in first`);
  await context.addCookies([{ ...cookie, value }]);
}

/**
 * What `path`'s server HTML gives `<html>` as its class, before any script
 * runs: read in a second context with JavaScript off and `from`'s cookies,
 * so no script of the page can have set it. Answers the address the page
 * landed on too (after the server's redirects) and an empty class as "".
 */
export async function serverHtmlClass(
  browser: Browser,
  from: BrowserContext,
  path: string,
): Promise<{ url: string; htmlClass: string }> {
  const context = await browser.newContext({ baseURL: E2E_WEB_URL, javaScriptEnabled: false });
  try {
    await context.addCookies(await from.cookies());
    const page = await context.newPage();
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    return { url: page.url(), htmlClass: (await page.locator("html").getAttribute("class")) ?? "" };
  } finally {
    await context.close();
  }
}

/**
 * A client-side navigation to the open page's own address with `search`,
 * through React Router (its data router, `window.__reactRouterDataRouter`):
 * the page's routes stay mounted, and the signed-in layout's loaders run again
 * (its `shouldRevalidate`), as on any navigation. For the checks that a
 * preference saved in another tab reaches a page that stays open, an open
 * Monaco included; going back to the page would mount it anew and prove
 * nothing.
 */
export async function navigateToSearch(page: Page, search: string): Promise<void> {
  const target = new URL(page.url());
  target.search = search;
  const path = `${target.pathname}${target.search}`;
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  await page.evaluate(`window.__reactRouterDataRouter.navigate(${JSON.stringify(path)})`);
  await page.waitForURL(path);
}

/**
 * Marks the editor's tour as done in every page `context` opens, for tests
 * that aren't about the tour: it would cover the page on a first visit.
 */
export async function skipEditorTour(context: BrowserContext): Promise<void> {
  await context.addInitScript(`try { localStorage.setItem("telflo-tour-completed", "true"); } catch {}`);
}
