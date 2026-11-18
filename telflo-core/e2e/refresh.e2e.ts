import { expect, test, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import { REFRESH_COOKIE_NAME } from "../apps/api/src/modules/sessions/cookies.js";
import { findSessions, revokeSessions, seedUser, type SeededUser } from "./support/database.js";
import { expireAccessToken, signInThroughApi, waitForHydration } from "./support/session.js";

// Refresh on page load and navigation (D2b decision 4): a server loader
// can't refresh, so the layout renders a placeholder and its client loader
// refreshes through the browser client, on hydration and on every client-side
// navigation. One refresh per expiry, in every tab.

const PASSWORD = "correct horse battery staple";
const REFRESH_PATH = "/api/v1/auth/refresh";

function isRefresh(request: Request): boolean {
  return request.method() === "POST" && new URL(request.url()).pathname === REFRESH_PATH;
}

/** Counts the refresh requests `page` sends from now on. */
function countRefreshes(page: Page): { readonly count: number } {
  const counter = { count: 0 };
  page.on("request", (request) => {
    if (isRefresh(request)) counter.count += 1;
  });
  return counter;
}

/**
 * Gives a duplicate refresh time to show up before the count is read. A
 * second refresh would follow the first within one round trip, so a second
 * of quiet is ample. Not `networkidle`: Firefox can leave the sidebar logo's
 * requests pending, so the network never goes idle and the wait times out.
 */
async function allowLateRefreshes(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
}

async function refreshCookie(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === REFRESH_COOKIE_NAME)?.value;
}

/** The signed-in shell, with the user's organization in the sidebar footer. */
async function expectSignedIn(page: Page, user: SeededUser): Promise<void> {
  await expect(page).toHaveURL("/app");
  await expect(page.getByTitle("Switch organization")).toContainText(user.organizationName);
}

async function openSignedIn(page: Page, user: SeededUser): Promise<void> {
  // /app lists the organization's configurations after it loads. Wait for that
  // request too: a test that then revokes the session would otherwise race it,
  // and its 401 sends the page to /login under the test's own reload (PR #13's
  // CI: "page.reload: net::ERR_ABORTED").
  // In development React's StrictMode runs the list's effect twice, so /app
  // sends that read twice at once: wait for every one, not only the first.
  const reads: Request[] = [];
  const onRequest = (request: Request) => {
    if (isListRead(request)) reads.push(request);
  };
  page.on("request", onRequest);
  const listed = page.waitForResponse((response) => isListRead(response.request()));
  await page.goto("/app");
  await waitForHydration(page);
  await listed;
  await expectSignedIn(page, user);
  page.off("request", onRequest);
  await Promise.all(reads.map(async (read) => (await read.response())?.finished()));
}

/** /app's read of the organization's configurations. */
function isListRead(request: Request): boolean {
  return request.method() === "GET" && new URL(request.url()).pathname.endsWith("/configurations");
}

test("reloading /app after the access token expires refreshes once and stays signed in", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await openSignedIn(page, user);
  const refreshTokenBefore = await refreshCookie(context);

  await expireAccessToken(context);
  const refreshes = countRefreshes(page);
  await page.reload();

  await expectSignedIn(page, user);
  await allowLateRefreshes(page);
  expect(refreshes.count).toBe(1);
  const refreshTokenAfter = await refreshCookie(context);
  expect(refreshTokenAfter).toBeDefined();
  expect(refreshTokenAfter).not.toBe(refreshTokenBefore);
  const sessions = await findSessions(user.userId);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.revoked_at).toBeNull();
});

test("a client-side navigation after the access token expires refreshes once and stays signed in", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await openSignedIn(page, user);

  await expireAccessToken(context);
  const refreshes = countRefreshes(page);
  // Its response, not only its request: the /me read below needs the
  // rotated cookies the response sets (D14b Ruling 48; waiting for the
  // request let that read race the refresh and meet a 401).
  const refreshed = page.waitForResponse((response) => isRefresh(response.request()));
  // A link to the page already open. The layout revalidates on every
  // navigation (its shouldRevalidate, Ruling 10; a same-URL link would
  // anyway, Preflight ruling 3), so its client loader runs.
  await page.getByRole("link", { name: "Configurations" }).click();
  const refresh = await refreshed;
  expect(refresh.status()).toBe(200);

  await expectSignedIn(page, user);
  await allowLateRefreshes(page);
  expect(refreshes.count).toBe(1);
  // The browser now holds a working access token, once the refresh's
  // response has fully arrived (null: it finished without an error).
  expect(await refresh.finished()).toBeNull();
  expect((await page.request.get("/api/v1/auth/me")).status()).toBe(200);
});

test("reloading /app with a revoked session and an expired access token lands on /login", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await openSignedIn(page, user);

  await revokeSessions(user.userId);
  await expireAccessToken(context);
  await page.reload();

  await expect(page).toHaveURL("/login?redirectTo=%2Fapp");
});

test("two tabs reloading at once after the access token expires both stay signed in", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const pages = [page, await context.newPage()];
  for (const tab of pages) await openSignedIn(tab, user);

  // Hold each refresh until both tabs have sent theirs, then release them
  // together: both carry the same refresh token, and the second to arrive
  // finds it already consumed. If the second never comes, release after a
  // while so the test fails on the count rather than timing out.
  const held: Route[] = [];
  let releaseAll: () => void = () => {};
  const bothSent = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  await context.route(`**${REFRESH_PATH}`, async (route) => {
    held.push(route);
    if (held.length === 2) releaseAll();
    await Promise.race([bothSent, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await route.continue();
  });

  await expireAccessToken(context);
  const refreshes = pages.map(countRefreshes);
  await Promise.all(pages.map((tab) => tab.reload()));

  for (const tab of pages) await expectSignedIn(tab, user);
  await Promise.all(pages.map(allowLateRefreshes));
  expect(refreshes.map((counter) => counter.count)).toEqual([1, 1]);
  const sessions = await findSessions(user.userId);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.revoked_at).toBeNull();
});
