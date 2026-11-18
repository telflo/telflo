import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, DEFAULT_DOCS_URL } from "@telflo/contracts";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { seedUser } from "./support/database.js";
import { E2E_ANALYTICS_WEB_URL, E2E_SAAS_WEB_URL, E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// The site's switches in the browser (D36-1 decisions 20-23, 27, 31 and 33;
// Preflight rulings 6, 7, 12, 16 and 19): on the default pair, the open
// source's defaults (no marketing site, `/` to sign-in or the app, robots
// disallowing everything, the playground and the anonymous reads off, no
// Sign up, no request leaving the site); the "on" cases on the SaaS pair.
// The switched pages answer 404 on a full load and on a client-side
// navigation alike (server loaders, never client ones). The marketing
// pages' own checks left with them (telflo-site's now); the robots and
// no-PostHog checks moved here from marketing.e2e.ts.

const PASSWORD = "correct horse battery staple";

/** The pages that left the web app (decision 20), and the sitemap. */
const REMOVED_PAGES = [
  "/pricing",
  "/use-cases",
  "/partners",
  "/demo",
  "/try",
  "/changelog",
  "/blog",
  "/blog/welcome-to-the-telflo-blog",
  "/terms-of-service",
  "/privacy-policy",
  "/cookie-policy",
  "/flows",
  "/flows/pii-redaction-gateway",
  "/sitemap.xml",
];

/** The playground's pages, behind TELFLO_PLAYGROUND (decision 31). */
const PLAYGROUND_PAGES = ["/playground", "/playground/flows", "/playground/fleet-management", "/playground/editor", "/public-editor"];

const ROBOTS = "User-agent: *\nDisallow: /\n";

/** Root's 404 page, answered with a 404 to the document request. */
async function expectNotFoundPage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "404", exact: true })).toBeVisible();
  await expect(page.getByText("The requested page could not be found.", { exact: true })).toBeVisible();
}

/** A client-side navigation through React Router (its data router), from a hydrated page. */
async function navigateInApp(page: Page, path: string): Promise<void> {
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  await page.evaluate(`window.__reactRouterDataRouter.navigate(${JSON.stringify(path)})`);
  await page.waitForURL((url) => url.pathname === path);
}

/** The open routes the switches turn off, through the web server's /api proxy, as a visitor's browser calls them. */
function anonymousCalls(request: APIRequestContext) {
  return {
    validate: () => request.post("/api/public/v1/validate/anonymous", { data: { yaml: "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n" } }),
    publishedFlows: () => request.get("/api/v1/published-flows"),
    showcase: () => request.get("/api/v1/flow-showcase"),
    salesInquiry: () =>
      request.post("/api/v1/sales-inquiries", {
        headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
        data: { name: "E2E Visitor", email: "visitor@example.com", message: "Hello.", website: "" },
      }),
  };
}

/** The playground's tour already seen, so its welcome dialog doesn't open. */
async function asReturningVisitor(context: BrowserContext): Promise<void> {
  await context.addInitScript(`try { localStorage.setItem("telflo-playground-tour-completed", "true"); } catch {}`);
}

test.describe("the open source's defaults (the default pair)", () => {
  test("/ sends a signed-out visitor to sign-in with a 302, and there is no marketing page", async ({ page, request }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("/login");

    await page.goto("/");
    await expect(page).toHaveURL(`${E2E_WEB_URL}/login`);
    await expect(page.getByRole("heading", { name: /sign in to telflo/i })).toBeVisible();
  });

  test("/ sends a signed-in visitor to /app", async ({ page }) => {
    const user = await seedUser({ password: PASSWORD });
    await signInThroughApi(page, user);

    await page.goto("/");
    await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
    await waitForHydration(page);
  });

  test("every page that left with the marketing site, and the sitemap, is a 404", async ({ page, request }) => {
    for (const path of REMOVED_PAGES) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(404);
    }
    await expectNotFoundPage(page, "/pricing");
  });

  test("the playground's pages are 404s on a full load and on a client-side navigation (decision 31)", async ({ page }) => {
    for (const path of PLAYGROUND_PAGES) await expectNotFoundPage(page, path);

    await page.goto("/login");
    await waitForHydration(page);
    await navigateInApp(page, "/playground");
    await expect(page.getByRole("heading", { level: 1, name: "404", exact: true })).toBeVisible();
    await expect(page.getByText("You're in the playground")).toHaveCount(0);
  });

  test("the anonymous reads and the sales inquiries answer as a path nothing serves (decisions 25 and 31)", async ({ request }) => {
    const calls = anonymousCalls(request);
    for (const [name, call] of Object.entries(calls)) {
      const response = await call();
      expect(response.status(), name).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code, name).toBe("not_found");
    }
  });

  test("sign-in offers no Sign up: the site is invitation-only (decision 23)", async ({ page }) => {
    await page.goto("/login");
    await waitForHydration(page);
    await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign up/i })).toHaveCount(0);
  });

  test("/docs/* still redirects to the docs (decision 21)", async ({ request }) => {
    const response = await request.get("/docs/anything", { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers()["location"]).toBe(DEFAULT_DOCS_URL);
  });

  test("without a PostHog key, no request leaves the site and no cookie banner shows", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));

    await page.goto("/");
    await expect(page).toHaveURL(`${E2E_WEB_URL}/login`);
    await waitForHydration(page);
    await page.waitForLoadState("networkidle");
    // A navigation in the app, once root's effects have run.
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(`${E2E_WEB_URL}/forgot-password`);
    await expect(page.getByRole("heading", { name: "Reset Password" })).toBeVisible();

    await expect(page.getByRole("dialog", { name: "Telflo uses cookies" })).toHaveCount(0);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((url) => new URL(url).origin !== E2E_WEB_URL)).toEqual([]);
  });
});

for (const base of [E2E_WEB_URL, E2E_SAAS_WEB_URL, E2E_ANALYTICS_WEB_URL]) {
  test(`robots.txt disallows every path and names no sitemap, whatever the site's values (${base}; Preflight ruling 12)`, async ({
    request,
  }) => {
    const robots = await request.get(`${base}/robots.txt`);
    expect(robots.status()).toBe(200);
    expect(robots.headers()["content-type"]).toMatch(/^text\/plain/);
    expect(await robots.text()).toBe(ROBOTS);
    expect((await request.get(`${base}/sitemap.xml`, { maxRedirects: 0 })).status()).toBe(404);
  });
}

test.describe("the SaaS's values (the SaaS pair)", () => {
  test.use({ baseURL: E2E_SAAS_WEB_URL });

  test("the playground's pages render, on a full load and on a client-side navigation", async ({ page, context }) => {
    await asReturningVisitor(context);
    const response = await page.goto("/playground");
    expect(response?.status()).toBe(200);
    await waitForHydration(page);
    await expect(page.getByText("You're in the playground")).toBeVisible();

    await page.goto("/login");
    await waitForHydration(page);
    await navigateInApp(page, "/playground/flows");
    await expect(page.getByText("You're in the playground")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "404", exact: true })).toHaveCount(0);
  });

  test("the anonymous reads answer; the sales inquiries stay off (no address in the browser tests)", async ({ request }) => {
    const calls = anonymousCalls(request);
    expect((await calls.validate()).status()).toBe(200);
    expect((await calls.publishedFlows()).status()).toBe(200);
    expect((await calls.showcase()).status()).toBe(200);
    expect((await calls.salesInquiry()).status()).toBe(404);
  });

  test("sign-in offers Sign up: registration is open", async ({ page }) => {
    await page.goto("/login");
    await waitForHydration(page);
    await expect(page.getByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/register");
  });

  test("/ still sends a signed-out visitor to sign-in: the site's own home page is the gateway's extraRoutes, not the app's", async ({
    request,
  }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("/login");
  });
});
