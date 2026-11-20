import { expect, test, type Page, type Request } from "@playwright/test";
import { addMember, findSessions, seedUser } from "./support/database.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { expireAccessToken, signInThroughApi, signInThroughForm, waitForHydration } from "./support/session.js";

const PASSWORD = "correct horse battery staple";

test("signing in through the form lands on /app inside the shell, and the sidebar footer shows the personal organization", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });

  await signInThroughForm(page, user);

  await expect(page).toHaveURL("/app");
  await expect(page.getByTitle("Switch organization")).toContainText(user.organizationName);
});

test("a new sign-in lands in the organization joined most recently, then where the person last was", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: user.userId });
  const switcher = page.getByTitle("Switch organization");

  // No earlier session: the organization joined most recently.
  await signInThroughForm(page, user);
  await expect(switcher).toContainText(group.organizationName);

  // Switched to the personal organization, then signed out: the next sign-in starts there.
  await switcher.click();
  await page.getByRole("dialog").getByRole("button", { name: user.organizationName }).click();
  await expect(switcher).toContainText(user.organizationName);
  await switcher.click();
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL("/login");

  await signInThroughForm(page, user);
  await expect(switcher).toContainText(user.organizationName);
  await expect(switcher).not.toContainText(group.organizationName);
});

test("a signed-out visit to /app redirects to /login?redirectTo=%2Fapp", async ({ page }) => {
  await page.goto("/app");

  await expect(page).toHaveURL("/login?redirectTo=%2Fapp");
});

/**
 * Records every toast the page shows from its first frame on, as
 * "<sonner's data-type>: <text>", each once: a MutationObserver on the
 * document sees a toast as sonner commits it, so one shown and gone before
 * the test looks still counts. A string, evaluated in the page: the E2E code
 * is typechecked without DOM types.
 */
async function watchToasts(page: Page): Promise<void> {
  await page.addInitScript(`
    window.__toastsSeen = [];
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll("[data-sonner-toast]")) {
        const seen = (toast.getAttribute("data-type") ?? "") + ": " + (toast.textContent ?? "").trim();
        if (!window.__toastsSeen.includes(seen)) window.__toastsSeen.push(seen);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
  `);
}

/** Every toast the page has shown since it loaded (watchToasts). */
function toastsSeen(page: Page): Promise<string[]> {
  return page.evaluate<string[]>("window.__toastsSeen");
}

/** Logout's toast, and no other: no failure toast at any point. */
const ONLY_LOGOUTS_TOAST = ["success: Logged out successfully"];

test("Logout lands on /login with 'Logged out successfully', and the session row is revoked with reason logout", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await watchToasts(page);
  // No wait for the page's reads to finish first: one still in flight when
  // Logout signs out is the next tests' subject, and Logout handles it.
  await page.goto("/app");
  await waitForHydration(page);
  await expect(page.getByText("No configurations yet.")).toBeVisible();

  // Logout lives in the sidebar footer's organization popover.
  await page.getByTitle("Switch organization").click();
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page).toHaveURL("/login");
  await expect(page.getByText("Logged out successfully")).toBeVisible();
  expect(await toastsSeen(page)).toEqual(ONLY_LOGOUTS_TOAST);
  const sessions = await findSessions(user.userId);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.revoked_at).not.toBeNull();
  expect(sessions[0]?.revoked_reason).toBe("logout");
});

/** The page's configurations list read: `GET /api/v1/organizations/{id}/configurations`, with or without a query. */
function isConfigurationsRead(request: Request): boolean {
  return request.method() === "GET" && /^\/api\/v1\/organizations\/[^/]+\/configurations$/.test(new URL(request.url()).pathname);
}

function isLogout(request: Request): boolean {
  return request.method() === "DELETE" && new URL(request.url()).pathname === "/api/v1/auth/sessions/current";
}

/**
 * Logout with the page's first configurations read held in flight until the
 * DELETE has been answered. The read then goes on, and the API refuses it:
 * a stray 401 from the session Logout ended. With `holdLoginData`,
 * `/login`'s data (`/login.data`, the navigation's server loader) is held
 * until that 401 has answered, so the `/app` page is certainly still
 * mounted when the list handles it; without, the two race, as they do for a
 * person.
 *
 * Logout must land on `/login` exactly, its toast shown and no other toast
 * at any point: no hard load to `/login?redirectTo=…`, and no
 * "Failed to load configuration" following the browser onto `/login`.
 */
async function logoutWithAReadInFlight(page: Page, { holdLoginData }: { holdLoginData: boolean }): Promise<void> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await watchToasts(page);

  // Each XHR the page makes is recorded once its `loadend` listeners have
  // run, the client's own first (it sets them before sending): by then the
  // client has handled the answer, and any hard load to /login?redirectTo
  // it started has begun, and any toast it asked for is on its way (sonner
  // shows it a task later). A string, evaluated in the page: the E2E code
  // is typechecked without DOM types.
  await page.addInitScript(`
    window.__settledRequests = [];
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__seenAs = method.toUpperCase() + " " + new URL(url, location.href).pathname;
      return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("loadend", () => window.__settledRequests.push(this.__seenAs + " " + this.status));
      return send.apply(this, args);
    };
  `);
  // Every document the page loads from here on: a hard load to /login?redirectTo would be one.
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
  });

  // The page's first configurations read is held until Logout's DELETE has been answered.
  let logoutAnswered!: () => void;
  const afterLogout = new Promise<void>((resolve) => {
    logoutAnswered = resolve;
  });
  page.on("response", (response) => {
    if (isLogout(response.request())) logoutAnswered();
  });
  let readHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    readHeld = resolve;
  });
  await page.route(/\/api\/v1\/organizations\/[^/]+\/configurations(\?|$)/, async (route) => {
    if (!isConfigurationsRead(route.request())) return route.fallback();
    readHeld();
    await afterLogout;
    await route.continue();
  });
  const strayAnswer = page.waitForResponse((response) => isConfigurationsRead(response.request()));
  // /login's data, held until the stray read has answered; recorded, so the hold is known to have been exercised.
  const loginDataHeld: string[] = [];
  if (holdLoginData) {
    await page.route(/\/login\.data(\?|$)/, async (route) => {
      loginDataHeld.push(new URL(route.request().url()).pathname);
      await strayAnswer;
      await route.continue();
    });
  }

  await page.goto("/app");
  await waitForHydration(page);
  await held;

  await page.getByTitle("Switch organization").click();
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page).toHaveURL(`${E2E_WEB_URL}/login`);
  await expect(page.getByText("Logged out successfully")).toBeVisible();
  if (holdLoginData) expect(loginDataHeld).toEqual(["/login.data"]);
  // The held read went on after the sign-out, and the API refused it: the session is gone.
  expect((await strayAnswer).status()).toBe(401);
  // The client has handled that 401 in this document (a hard load would have
  // started a new one, whose record is empty)...
  await expect
    .poll(() => page.evaluate<string[]>("window.__settledRequests"))
    .toContainEqual(expect.stringMatching(/^GET \/api\/v1\/organizations\/[^/ ]+\/configurations 401$/));
  // ...and a round trip from the page after it finds the same document, with
  // nothing loaded since, and every toast asked for meanwhile shown.
  expect(await page.evaluate<string>("fetch('/robots.txt').then(() => location.href)")).toBe(`${E2E_WEB_URL}/login`);
  expect(documents.filter((url) => url.includes("redirectTo"))).toEqual([]);
  await expect(page.getByText("Logged out successfully")).toBeVisible();
  expect(await toastsSeen(page)).toEqual(ONLY_LOGOUTS_TOAST);
  const sessions = await findSessions(user.userId);
  expect(sessions.map((session) => session.revoked_reason)).toEqual(["logout"]);
}

test("Logout while a configurations read is held in flight lands on /login exactly, with its toast and no other: the read's 401 after the sign-out neither sends the page to /login?redirectTo nor toasts a failure", async ({
  page,
}) => {
  await logoutWithAReadInFlight(page, { holdLoginData: false });
});

test("Logout with a configurations read in flight and /login's data held until the read's 401 has answered: /login exactly, with its toast and no other", async ({
  page,
}) => {
  await logoutWithAReadInFlight(page, { holdLoginData: true });
});

test("expireAccessToken produces a cookie the API answers with 401 access_token_expired", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  // Proves the sign-in worked, so the 401 below is the helper's doing.
  expect((await page.request.get("/api/v1/auth/me")).status()).toBe(200);

  await expireAccessToken(context);

  const response = await page.request.get("/api/v1/auth/me");
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "access_token_expired" } });
});
