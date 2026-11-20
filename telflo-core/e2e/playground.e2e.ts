import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
// The SaaS pair: open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { THEME_COOKIE_NAME } from "@telflo/contracts";
import { test as analyticsTest } from "./support/analytics.js";
import { E2E_POSTHOG_STUB_URL, E2E_SAAS_WEB_URL } from "./support/environment.js";
import { seedUser } from "./support/database.js";
import { maskedPlacesOf, unmaskedFieldsOf, within } from "./support/privacy.js";
import { decodedPath, isWithinPlaygroundInvariant, recordPlaygroundRequests, type RecordedPlaygroundRequest } from "./support/playground.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// The playground with NO account: the shell, the configurations page on the
// sample, a locked action's sign-up prompt, the masking, the theme (Navy),
// the phone layout, and the playground's request allowlist over every page.
// Each test opens a fresh context, signed out (the walk's signed-in visitor
// aside). The walk, at the end, covers every page and every locked action.
// The tour and its welcome dialog: the tests that aren't about it open the
// playground as a returning visitor, the tour already seen.

const GATEWAY_ID = "11111111-0000-4000-8000-000000000001";
const A_FLEET_ID = "0199a000-0000-7000-8000-000000000001";

/** The sample's ten, by name: sample words, fine to assert. */
const SAMPLE_NAMES = [
  "K8s Production Gateway",
  "Host Metrics — Linux Fleet",
  "Tail Sampling — Traces",
  "Frontend RUM Logs",
  "Span Metrics — RED",
  "K8s Node Agent",
  "PII Masking — Redaction",
  "Cost Filters — OTTL",
  "Backend Migration — Dual Ship",
  "edge-import-pilot (imported)",
];

function cards(page: Page) {
  return page.getByRole("heading", { level: 3 });
}

function sidebar(page: Page) {
  return page.getByRole("navigation", { name: "Playground", exact: true });
}

function signupPrompt(page: Page) {
  return page.getByRole("dialog", { name: "This is a sample workspace" });
}

/** The tour's completion flag (localStorage), set before any page script runs: a returning visitor. */
const TOUR_COMPLETED_KEY = "telflo-playground-tour-completed";
const returning = new WeakSet<BrowserContext>();

async function asReturningVisitor(context: BrowserContext): Promise<void> {
  if (returning.has(context)) return;
  returning.add(context);
  await context.addInitScript({
    content: `try { window.localStorage.setItem(${JSON.stringify(TOUR_COMPLETED_KEY)}, "true"); } catch {}`,
  });
}

/** Opens a playground page as a returning visitor (the tour seen: no welcome dialog). */
async function openPlayground(page: Page, path = "/playground"): Promise<void> {
  await asReturningVisitor(page.context());
  await page.goto(path);
  await waitForHydration(page);
}

/** Opens a playground page as a first visit: nothing stored. */
async function firstVisit(page: Page, path = "/playground"): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

function welcomeDialog(page: Page) {
  return page.getByRole("dialog", { name: "Welcome to the Telflo playground" });
}

/**
 * No welcome dialog, said only after the list has arrived and the page has
 * had ten samples (about a second) to open it: the offer opens in an effect
 * after the list arrives, so a check made at once could pass before it would
 * show.
 */
async function expectNoWelcomeDialog(page: Page): Promise<void> {
  await expect(cards(page)).toHaveCount(10);
  const seen: number[] = [];
  await expect
    .poll(
      async () => {
        seen.push(await welcomeDialog(page).count());
        return seen.length;
      },
      { intervals: [100], timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(10);
  expect(Math.max(...seen)).toBe(0);
}

function tourTitle(page: Page) {
  return page.locator(".driver-popover-title");
}

/** The tour's Next (or Finish) once the step titled `title` shows. */
async function nextFrom(page: Page, title: string): Promise<void> {
  await expect(tourTitle(page)).toHaveText(title);
  await page.locator(".driver-popover-next-btn").click();
}

test("the shell and the configurations page on the sample, with no account", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page);

  await expect(page).toHaveTitle("Playground - Telflo");
  await expect(page.getByText("You're in the playground")).toBeVisible();
  await expect(page.getByRole("link", { name: "Create free account" })).toHaveAttribute("href", "/register");
  await expect(sidebar(page).getByRole("link", { name: "Configurations" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Sample workspace")).toBeVisible();

  await expect(cards(page)).toHaveCount(10);
  expect((await cards(page).allTextContents()).sort()).toEqual([...SAMPLE_NAMES].sort());

  // Search and the filter, in the browser: the address never changes.
  await page.getByRole("searchbox", { name: "Search configurations" }).fill("ottl");
  await expect(cards(page)).toHaveText(["Cost Filters — OTTL"]);
  expect(new URL(page.url()).search).toBe("");
  await page.getByRole("searchbox", { name: "Search configurations" }).fill("");
  await page.getByRole("combobox", { name: "Filter" }).click();
  await page.getByRole("option", { name: "Published" }).click();
  await expect(cards(page)).toHaveCount(8);

  // A card opens the playground editor on it; New configuration the blank one.
  await cards(page).filter({ hasText: "K8s Production Gateway" }).click();
  await page.waitForURL(`**/playground/editor/${GATEWAY_ID}`);
  await expect(page).toHaveTitle("Playground Editor - Telflo");
  // The sample's check sent before the editor is left, so the set below is exact whatever the timing.
  await expect.poll(() => recorder.apiRequests().includes(VALIDATE)).toBe(true);
  await page.goBack();
  await expect(cards(page).first()).toBeVisible();
  await page.getByRole("button", { name: "New configuration" }).click();
  await page.waitForURL(/\/playground\/editor$/);

  // The sample editor's check; the blank one, empty, sends none.
  expect(recorder.outside()).toEqual([]);
  expect(new Set(recorder.apiRequests())).toEqual(new Set([VALIDATE]));
});

test("a locked action opens the sign-up prompt with its words: the sidebar's Variables, a card's Delete", async ({ page }) => {
  await openPlayground(page);
  await sidebar(page).getByRole("button", { name: "Variables" }).click();
  await expect(signupPrompt(page)).toBeVisible();
  await expect(signupPrompt(page)).toContainText("To manage your organization's variables, create a free account.");
  await expect(signupPrompt(page).getByRole("link", { name: "Create free account" })).toHaveAttribute("href", "/register");
  await expect(signupPrompt(page).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  await signupPrompt(page).getByRole("button", { name: "Keep exploring" }).click();
  await expect(signupPrompt(page)).toHaveCount(0);

  await expect(cards(page)).toHaveCount(10);
  const card = page.getByRole("button").filter({ has: page.getByRole("heading", { name: "Cost Filters — OTTL" }) });
  await card.hover();
  await card.getByTitle("Delete").click();
  await expect(signupPrompt(page)).toContainText("To manage your own configurations, create a free account.");
  await page.keyboard.press("Escape");
  await expect(cards(page)).toHaveCount(10);
});

test("every page so far stays within the playground's request allowlist", async ({ page, context }) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  for (const path of [
    "/playground",
    "/playground/flows",
    "/playground/flows/log-volume-cost-control",
    "/playground/fleet-management",
    `/playground/fleet-management/${A_FLEET_ID}`,
    `/playground/fleet-management/server/${A_FLEET_ID}`,
    `/playground/fleet-management/k8s/${A_FLEET_ID}`,
    "/playground/editor",
    `/playground/editor/${GATEWAY_ID}`,
    "/public-editor",
  ]) {
    await openPlayground(page, path);
    // A sample editor's check sent before it is left; the blank editors, empty, send none.
    if (path === `/playground/editor/${GATEWAY_ID}`) await expect.poll(() => recorder.apiRequests().includes(VALIDATE)).toBe(true);
  }
  // The typed fleet paths land on the one fleet page.
  await openPlayground(page, `/playground/fleet-management/k8s/${A_FLEET_ID}`);
  expect(new URL(page.url()).pathname).toBe(`/playground/fleet-management/${A_FLEET_ID}`);

  // Client navigation through the shell, and a reload.
  await openPlayground(page);
  await sidebar(page).getByRole("link", { name: "Flows" }).click();
  await page.waitForURL("**/playground/flows");
  await sidebar(page).getByRole("link", { name: "Fleet" }).click();
  await page.waitForURL("**/playground/fleet-management");
  await sidebar(page).getByRole("link", { name: "Configurations" }).click();
  await expect(cards(page)).toHaveCount(10);
  await page.reload();
  await waitForHydration(page);
  await expect(cards(page)).toHaveCount(10);

  expect(recorder.requests.length).toBeGreaterThan(20);
  // Nothing outside the invariant, and the only `/api/` requests are the flows pages' open reads and the sample
  // editor's anonymous validate.
  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests().length).toBeGreaterThan(0);
  expect(new Set(recorder.apiRequests())).toEqual(new Set(["GET /api/v1/published-flows", "GET /api/v1/published-flows/:slug", VALIDATE]));
});

test("the recorder catches a request outside the allowlist, which is exact (the guard's own check)", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page);
  // Strings, evaluated in the page: the E2E code is typechecked without DOM types.
  // Another /api/ read; an allowed path by another method; an allowed path
  // with a query; a web-origin path by a method other than GET or HEAD; and
  // another origin.
  await page.evaluate(`Promise.all([
    fetch("/api/v1/auth/me"),
    fetch("/API/v1/auth/me"),
    fetch("/api/public/v1/validate/anonymous"),
    fetch("/api/v1/published-flows?x=1"),
    fetch("/%61pi/v1/auth/me"),
    fetch("/login.data"),
    fetch("/app"),
    fetch("/editor/abc.js"),
    fetch("/playground", { method: "POST" }),
    // Another origin, a real server's (port 9, as before, is one Firefox and WebKit block before any request).
    fetch(${JSON.stringify(`${E2E_POSTHOG_STUB_URL}/`)}, { mode: "no-cors" }),
  ].map((sending) => sending.catch(() => undefined)))`);
  for (const expected of [
    `GET ${E2E_SAAS_WEB_URL} /api/v1/auth/me`,
    // Case aside, an /api/ request too.
    `GET ${E2E_SAAS_WEB_URL} /API/v1/auth/me`,
    `GET ${E2E_SAAS_WEB_URL} /api/public/v1/validate/anonymous`,
    `GET ${E2E_SAAS_WEB_URL} /api/v1/published-flows`,
    // Encoded, an /api/ request still.
    `GET ${E2E_SAAS_WEB_URL} /%61pi/v1/auth/me`,
    // Another page's data read: the visitor sent off the playground.
    `GET ${E2E_SAAS_WEB_URL} /login.data`,
    // Another page by fetch.
    `GET ${E2E_SAAS_WEB_URL} /app`,
    // A signed-in page's path ending in .js: a server render, not a file.
    `GET ${E2E_SAAS_WEB_URL} /editor/abc.js`,
    `POST ${E2E_SAAS_WEB_URL} /playground`,
    `GET ${E2E_POSTHOG_STUB_URL} /`,
  ]) {
    await expect.poll(() => recorder.outside(), { message: expected }).toContain(expected);
  }
  expect(recorder.apiRequests()).toEqual([]);
});

test("the recorder's rules: decoded paths, the playground's own pages, assets, server renders, leaving", async ({
  context,
}) => {
  const at = (
    path: string,
    kind: RecordedPlaygroundRequest["kind"],
    method = "GET",
    more: Partial<RecordedPlaygroundRequest> = {},
  ): RecordedPlaygroundRequest => ({ method, origin: E2E_SAAS_WEB_URL, path, kind, ...more });
  // `/api/` however it is spelled: encoded once or twice, in another case.
  // One malformed escape leaves the rest decoded.
  for (const path of ["/%61pi/v1/auth/me", "/%2561pi/v1/auth/me", "/%41PI/v1/auth/me", "/api%2Fv1/auth/me", "/%61pi/v1/auth/me%ZZ"]) {
    expect(isWithinPlaygroundInvariant(at(path, "other"), false), path).toBe(false);
  }
  // The playground's own documents and data reads; another page's are outside.
  for (const path of ["/playground", "/playground/flows/x", "/playground.data", "/playground/editor.data", "/public-editor", "/public-editor.data"]) {
    expect(isWithinPlaygroundInvariant(at(path, path.endsWith(".data") ? "data" : "document"), false), path).toBe(true);
  }
  for (const path of ["/login", "/register", "/app", "/app.data", "/_root.data", "/playgroundx", "/public-editor/x"]) {
    expect(isWithinPlaygroundInvariant(at(path, path.endsWith(".data") ? "data" : "document"), false), path).toBe(false);
  }
  // The web's own files, by resource type, are the web's own anywhere on its origin; Vite's development paths,
  // React Router's route discovery and the static schemas too. Any other fetch only of a playground page.
  expect(isWithinPlaygroundInvariant(at("/assets/app.js", "asset", "GET", { type: "script" }), false)).toBe(true);
  for (const path of ["/@vite/client", "/node_modules/.vite/deps/react.js", "/__manifest", "/schemas/otelcol-contrib/v0.162.0.json"]) {
    expect(isWithinPlaygroundInvariant(at(path, "other", "GET", { type: "fetch" }), false), path).toBe(true);
  }
  // A script or style file by its extension only when loaded as one: a script, a style, or a worker's script
  // (WebKit reports it as "xhr"; told by the context's workers).
  expect(isWithinPlaygroundInvariant(at("/app/lib/editor/yaml.worker.ts", "other", "GET", { type: "xhr", worker: true }), false)).toBe(true);
  expect(isWithinPlaygroundInvariant(at("/assets/editor.worker-abc123.js", "other", "GET", { type: "xhr", worker: true }), false)).toBe(true);
  expect(isWithinPlaygroundInvariant(at("/app/lib/editor/yaml.worker.ts", "other", "GET", { type: "xhr" }), false)).toBe(false);
  expect(isWithinPlaygroundInvariant(at("/app/root.tsx", "other", "GET", { type: "script" }), false)).toBe(true);
  for (const path of ["/editor/x.js", "/fleet-management/x.css"]) {
    // As a document and as a fetch: a signed-in page's path, whatever its extension.
    expect(isWithinPlaygroundInvariant(at(path, "document", "GET", { type: "document" }), false), `document ${path}`).toBe(false);
    expect(isWithinPlaygroundInvariant(at(path, "other", "GET", { type: "fetch" }), false), `fetch ${path}`).toBe(false);
  }
  // A server render outside the playground's pages, whatever was asked and its type: an HTML answer or a redirect.
  expect(isWithinPlaygroundInvariant(at("/editor/x.js", "other", "GET", { type: "script", response: { status: 200, html: true } }), false)).toBe(false);
  expect(isWithinPlaygroundInvariant(at("/assets/x.js", "other", "GET", { type: "fetch", response: { status: 200, html: true } }), false)).toBe(false);
  expect(isWithinPlaygroundInvariant(at("/assets/x.png", "asset", "GET", { type: "image", response: { status: 302, html: false } }), false)).toBe(false);
  expect(isWithinPlaygroundInvariant(at("/playground/flows", "document", "GET", { type: "document", response: { status: 200, html: true } }), false)).toBe(true);
  // A cached file's 304 is no redirect.
  expect(isWithinPlaygroundInvariant(at("/assets/app.js", "asset", "GET", { type: "script", response: { status: 304, html: false } }), false)).toBe(true);
  for (const path of ["/app", "/app/configurations", "/login", "/"]) {
    expect(isWithinPlaygroundInvariant(at(path, "other", "GET", { type: "fetch" }), false), path).toBe(false);
  }
  expect(isWithinPlaygroundInvariant(at("/playground/flows", "other", "GET", { type: "fetch" }), false)).toBe(true);
  // With analytics on, the PostHog stub's origin only: any other origin is still outside.
  expect(isWithinPlaygroundInvariant({ method: "GET", origin: E2E_POSTHOG_STUB_URL, path: "/e/", kind: "other", type: "fetch" }, true)).toBe(true);
  expect(isWithinPlaygroundInvariant({ method: "GET", origin: "http://elsewhere.invalid", path: "/", kind: "other", type: "fetch" }, true)).toBe(false);
  expect(decodedPath("/%252561pi")).toBe("/api");
  expect(decodedPath("/%E0%A4%A")).toBe("/%E0%A4%A");
  expect(decodedPath("/%61pi/v1/auth/me%ZZ")).toBe("/api/v1/auth/me%ZZ");
  expect(decodedPath("/%E2%9C%93%61")).toBe("/✓a");

  // A request recorded before leave() is still listed; after it, nothing is recorded.
  const recorder = recordPlaygroundRequests(context);
  const page = await context.newPage();
  await page.goto("/playground");
  await page.evaluate(`fetch("/app").catch(() => undefined)`);
  await expect.poll(() => recorder.outside()).toContain(`GET ${E2E_SAAS_WEB_URL} /app`);
  recorder.leave();
  const before = recorder.requests.length;
  await page.goto("/login");
  expect(recorder.requests.length).toBe(before);
  expect(recorder.outside()).toContain(`GET ${E2E_SAAS_WEB_URL} /app`);
  await page.close();
});

test("the shell, the editor's frame and the public editor are masked like the signed-in shell", async ({ page }) => {
  await openPlayground(page);
  await expect(cards(page)).toHaveCount(10);
  // Collect, leave for about:blank, then assert (nothing can fail on a page showing text).
  const body = await within(page.evaluate<string>(`document.body.className`), 5_000, "");
  const places = await within(maskedPlacesOf(page, ["K8s Production Gateway", "Acme Observability", "Cost Filters — OTTL"]), 5_000, []);
  // The editors' surface masks <body> once mounted, whatever the page inside it.
  const bodyMasked = `document.body.classList.contains("ph-mask") && document.body.classList.contains("tf-app")`;
  await openPlayground(page, "/playground/editor");
  await page.waitForFunction(bodyMasked);
  const editorBody = await within(page.evaluate<string>(`document.body.className`), 5_000, "");
  await openPlayground(page, "/public-editor");
  await page.waitForFunction(bodyMasked);
  const publicBody = await within(page.evaluate<string>(`document.body.className`), 5_000, "");
  await page.goto("about:blank");

  for (const className of [body, editorBody, publicBody]) {
    expect(className.split(" ")).toEqual(expect.arrayContaining(["tf-app", "ph-mask"]));
  }
  expect(places).toHaveLength(3);
  for (const place of places) {
    expect(place.masked).toBeGreaterThan(0);
    expect(place.unmasked).toBe(0);
    expect(place.inAttributes).toBe(0);
  }
});

test("the theme: Navy shown as Navy, remembered in the playground's key, never the telflo_theme cookie", async ({ page, context }) => {
  await openPlayground(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("class", "dark");
  const theme = page.getByRole("group", { name: "Theme" });
  await theme.getByRole("button", { name: "Navy" }).click();
  await expect(html).toHaveAttribute("class", "dark navy");
  await expect(theme.getByRole("button", { name: "Navy" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate<string | null>(`window.localStorage.getItem("telflo-playground-theme")`)).toBe("navy");

  await page.reload();
  await waitForHydration(page);
  await expect(html).toHaveAttribute("class", "dark navy");
  await openPlayground(page, "/playground/editor");
  await expect(html).toHaveAttribute("class", "dark navy");

  await openPlayground(page);
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await expect(html).toHaveAttribute("class", "");
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain(THEME_COOKIE_NAME);
});

test("phones: the shell's strip in place of the sidebar, and the editors' phone page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openPlayground(page);
  await expect(sidebar(page)).toBeHidden();
  const strip = page.getByRole("navigation", { name: "Playground pages" });
  await expect(strip.getByRole("link", { name: "Configurations" })).toHaveAttribute("aria-current", "page");
  await expect(cards(page)).toHaveCount(10);

  await openPlayground(page, "/playground/editor");
  await expect(page.getByText("The editor is best viewed on larger screens such as laptop or computer browsers.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to playground" })).toHaveAttribute("href", "/playground");
  await expect(page.getByRole("heading", { level: 1, name: "Playground editor" })).toHaveCount(0);
  await openPlayground(page, "/public-editor");
  await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
});

test("a first desktop visit: the welcome dialog, then the tour over the list, the editor and fleet", async ({ page, context }) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  await firstVisit(page);
  await expect(welcomeDialog(page)).toBeVisible();
  await expect(welcomeDialog(page)).toContainText("This is the full product running on sample data.");
  await expect(welcomeDialog(page).getByRole("button", { name: "I'll explore on my own" })).toBeVisible();
  await welcomeDialog(page).getByRole("button", { name: /^Show me around/ }).click();
  await expect(welcomeDialog(page)).toHaveCount(0);

  // The list's stage, then the hand-over to the first sample's editor.
  await nextFrom(page, "Every collector config in one place");
  await nextFrom(page, "Start from a blank canvas");
  await nextFrom(page, "Let's open a sample");
  await page.waitForURL(`**/playground/editor/${GATEWAY_ID}`);

  // The editor's stage (never the editor's own tour), then the hand-over to fleet.
  await nextFrom(page, "Your pipeline, not a wall of YAML");
  await nextFrom(page, "The component catalog");
  await nextFrom(page, "Configure with forms, not syntax");
  await nextFrom(page, "It's still just standard YAML");
  await expect(tourTitle(page)).toHaveText("Test changes before they ship");
  await expect(page.getByRole("tab", { name: "Testing", exact: true }).first()).toHaveAttribute("aria-selected", "true");
  await page.locator(".driver-popover-next-btn").click();
  await nextFrom(page, "Configs are half the story");
  await page.waitForURL("**/playground/fleet-management");

  // Fleet's stage, on the fleets' table; Finish ends it.
  await expect(tourTitle(page)).toHaveText("Roll out configs over OpAMP");
  await expect(page.locator(".driver-active-element")).toHaveJSProperty("tagName", "TABLE");
  await page.locator(".driver-popover-next-btn").click();
  await expect(tourTitle(page)).toHaveText("That's the loop: build, test, roll out");
  await expect(page.locator(".driver-popover-next-btn")).toHaveText("Finish");
  await page.locator(".driver-popover-next-btn").click();
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  expect(await page.evaluate<string | null>(`window.localStorage.getItem(${JSON.stringify(TOUR_COMPLETED_KEY)})`)).toBe("true");
  expect(await page.evaluate<string | null>(`window.sessionStorage.getItem("telflo-playground-tour-stage")`)).toBeNull();
  expect(await page.evaluate<string | null>(`window.localStorage.getItem("telflo-tour-completed")`)).toBeNull();

  // Seen: the list never offers it again.
  await firstVisit(page);
  await expectNoWelcomeDialog(page);

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests().every((name) => name === "POST /api/public/v1/validate/anonymous")).toBe(true);
});

test("Take the tour again: on the list, and from another page", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPlayground(page);
  await expectNoWelcomeDialog(page);
  await page.getByRole("searchbox", { name: "Search configurations" }).fill("ottl");
  await expect(cards(page)).toHaveCount(1);

  await page.getByRole("button", { name: "Take the tour" }).click();
  await expect(tourTitle(page)).toHaveText("Every collector config in one place");
  await expect(cards(page)).toHaveCount(10);
  await page.keyboard.press("Escape");
  await expect(page.locator(".driver-popover")).toHaveCount(0);

  await sidebar(page).getByRole("link", { name: "Fleet" }).click();
  await page.waitForURL("**/playground/fleet-management");
  await page.getByRole("button", { name: "Take the tour" }).click();
  await page.waitForURL(/\/playground$/);
  await expect(tourTitle(page)).toHaveText("Every collector config in one place");

  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
});

test("the welcome dialog: I'll explore on my own is remembered; none on a phone", async ({ page }) => {
  await firstVisit(page);
  await welcomeDialog(page).getByRole("button", { name: "I'll explore on my own" }).click();
  await expect(welcomeDialog(page)).toHaveCount(0);
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await page.reload();
  await waitForHydration(page);
  await expectNoWelcomeDialog(page);

  // A phone, nothing stored: no dialog, and no Take the tour.
  await page.evaluate(`window.localStorage.clear()`);
  await page.setViewportSize({ width: 375, height: 800 });
  await firstVisit(page);
  await expectNoWelcomeDialog(page);
  await expect(page.getByRole("button", { name: "Take the tour" })).toBeHidden();
  expect(await page.evaluate<string | null>(`window.localStorage.getItem(${JSON.stringify(TOUR_COMPLETED_KEY)})`)).toBeNull();
});

analyticsTest.describe("with analytics on", () => {
  // On a first visit the cookie banner asks first; a modal Welcome dialog
  // over it would leave neither answerable. A real mouse click on Allow all
  // answers it, and the Welcome dialog opens then.
  analyticsTest("a first visit: the banner's Allow all takes a mouse click, then the playground's Welcome dialog opens", async ({ page }) => {
    await page.goto("/playground");
    await waitForHydration(page);
    const banner = page.getByRole("dialog", { name: "Telflo uses cookies" });
    await expect(banner).toBeVisible();
    // The list has arrived behind the banner (hidden from the accessibility tree by it, so counted in the DOM), and
    // for about a second after it no Welcome dialog opens over the banner.
    await expect(page.locator("h3")).toHaveCount(10);
    const welcomeInDom = page.locator('[role="dialog"]', { hasText: "Welcome to the Telflo playground" });
    const seen: number[] = [];
    await expect
      .poll(
        async () => {
          seen.push(await welcomeInDom.count());
          return seen.length;
        },
        { intervals: [100], timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(10);
    expect(Math.max(...seen)).toBe(0);
    await banner.getByRole("button", { name: "Allow all" }).click();
    await expect(banner).toHaveCount(0);
    await expect(welcomeDialog(page)).toBeVisible();
  });

  analyticsTest("a first visit to the public editor: Allow all by mouse, then its Welcome dialog", async ({ page }) => {
    await page.goto("/public-editor");
    await waitForHydration(page);
    const banner = page.getByRole("dialog", { name: "Telflo uses cookies" });
    await expect(banner).toBeVisible();
    const welcome = page.getByRole("dialog", { name: "Welcome to Telflo" });
    // For about a second after the page has hydrated, no Welcome dialog opens over the banner.
    const welcomeInDom = page.locator('[role="dialog"]', { hasText: "Welcome to Telflo" }).filter({ hasNotText: "cookies" });
    const seen: number[] = [];
    await expect
      .poll(
        async () => {
          seen.push(await welcomeInDom.count());
          return seen.length;
        },
        { intervals: [100], timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(10);
    expect(Math.max(...seen)).toBe(0);
    await banner.getByRole("button", { name: "Allow all" }).click();
    await expect(banner).toHaveCount(0);
    await expect(welcome).toBeVisible();
  });

  analyticsTest("after consent, only the web, the allowlist's /api/ requests and PostHog's origin", async ({ page, context }) => {
    const recorder = recordPlaygroundRequests(context, { analytics: true });
    await asReturningVisitor(context);
    await page.goto("/playground");
    await waitForHydration(page);
    await page.getByRole("dialog", { name: "Telflo uses cookies" }).getByRole("button", { name: "Allow all" }).click();
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(10);
    await page.getByRole("navigation", { name: "Playground", exact: true }).getByRole("link", { name: "Fleet" }).click();
    await page.waitForURL("**/playground/fleet-management");
    await page.goto("/public-editor");
    await waitForHydration(page);
    expect(recorder.outside()).toEqual([]);
  });
});

// The walk: one walk per area, serial (the anonymous validate's one check
// in flight per address is real in tests), each opening every page of its
// area and EVERY locked action there, the install entries included — its
// prompt seen with its own words, then closed — under the request recorder:
// nothing outside the playground's request invariant, and exactly the area's
// allowlisted `/api/` requests. A signed-in visitor, entering from /app in
// the same tab (its user store filled), walks the server fleet too and sees
// the same. Locked actions the sample can't offer (a visitor's own test
// file's Delete; Compare's "Create an OTTL rule", behind the locked Compare;
// a fleet's Unarchive and "New default token", every sample fleet active
// with a valid default token; the setup guide's Assign and Install, every
// step done on the sample) are covered by their component tests.

const PROD_FLEET_ID = "44444444-0000-4000-8000-000000000001";
const WALK_PASSWORD = "a-sufficiently-long-walk-password";
const K8S_FLEET_ID = "44444444-0000-4000-8000-000000000004";
const VALIDATE = "POST /api/public/v1/validate/anonymous";

/** Clicks `control`, expects the sign-up prompt with `words` and nothing else on top, and closes it with Keep exploring. */
async function expectLockedAt(page: Page, control: Locator, words: string): Promise<void> {
  await control.click();
  await expect(signupPrompt(page)).toContainText(`To ${words}, create a free account.`);
  await signupPrompt(page).getByRole("button", { name: "Keep exploring" }).click();
  await expect(signupPrompt(page)).toHaveCount(0);
}

/** Clicks the first component on the canvas clear of the toolbox and within the window (one may sit under the toolbox). */
async function clickVisibleComponent(page: Page): Promise<void> {
  const toolbox = await page.locator('[data-tour-step="toolbox"]').boundingBox();
  const size = page.viewportSize()!;
  const nodes = page.locator(".react-flow__node:not(.react-flow__node-pipelineGroup)");
  for (let index = 0; index < (await nodes.count()); index += 1) {
    const box = await nodes.nth(index).boundingBox();
    if (box === null || box.x < (toolbox === null ? 0 : toolbox.x + toolbox.width) || box.x + box.width > size.width || box.y + box.height > size.height) {
      continue;
    }
    await nodes.nth(index).click();
    return;
  }
  throw new Error("no component on the canvas is clear of the toolbox");
}

/** Every field holding a value is inside `ph-no-capture`: named by tag and id, never by value. */
async function expectFieldsMasked(page: Page): Promise<void> {
  expect(await unmaskedFieldsOf(page)).toEqual([]);
}

/**
 * Types a marker into every text field the page shows (Monaco aside: its
 * text is the YAML tab's, inside `ph-no-capture`), checks every field
 * holding a value is masked, then empties them again (on every page of the
 * walk).
 */
async function typeIntoFieldsAndExpectMasked(page: Page): Promise<void> {
  // Every input type a visitor types into, each with a value it takes.
  const markers: Record<string, string> = {
    text: "zqwalk",
    search: "zqwalk",
    password: "zqwalk",
    number: "7",
    email: "zq@walk.example",
    url: "https://walk.example",
    tel: "5550100",
  };
  const selector = ['input:not([type])', ...Object.keys(markers).map((type) => `input[type="${type}"]`), "textarea"].join(", ");
  const fields = page.locator(selector);
  // Each field typed into, with what it held, put back afterwards (never printed).
  const typed: Array<{ index: number; held: string }> = [];
  for (let index = 0; index < (await fields.count()); index += 1) {
    const field = fields.nth(index);
    if (!(await field.isVisible()) || !(await field.isEditable())) continue;
    // The E2E code is typechecked without DOM types: the element as the one method used.
    if (await field.evaluate((element) => (element as unknown as { closest(selector: string): unknown }).closest(".monaco-editor") !== null)) continue;
    const type = ((await field.getAttribute("type")) ?? "text").toLowerCase();
    typed.push({ index, held: await field.inputValue() });
    await field.fill(markers[type] ?? markers.text!);
  }
  await expectFieldsMasked(page);
  for (const { index, held } of typed) await fields.nth(index).fill(held);
}

/**
 * Nothing outside the invariant, and the recorder's `/api/` requests are
 * exactly `names`, each seen (web-first: the editors' first check goes out
 * 1.5 s after the opening).
 */
async function expectExactlyApi(recorder: ReturnType<typeof recordPlaygroundRequests>, names: readonly string[]): Promise<void> {
  await expect.poll(() => names.every((name) => recorder.apiRequests().includes(name))).toBe(true);
  expect(recorder.outside()).toEqual([]);
  expect(new Set(recorder.apiRequests())).toEqual(new Set(names));
}

test.describe("the walk: every page and every locked action, within the allowlist", () => {
  test.describe.configure({ mode: "serial" });

  test("the shell, the configurations and the flows", async ({ page, context }) => {
    test.slow();
    const recorder = recordPlaygroundRequests(context);
    await openPlayground(page);
    await expect(cards(page)).toHaveCount(10);
    for (const [label, words] of [
      ["Variables", "manage your organization's variables"],
      ["Permissions", "manage your team's permissions"],
      ["Settings", "change app settings"],
      ["Learning", "read the learning library"],
    ] as const) {
      await expectLockedAt(page, sidebar(page).getByRole("button", { name: label }), words);
    }
    const card = page.getByRole("button").filter({ has: page.getByRole("heading", { name: "Cost Filters — OTTL" }) });
    await card.hover();
    await expectLockedAt(page, card.getByTitle("Delete"), "manage your own configurations");
    await page.getByTitle("List view").click();
    await expectLockedAt(page, page.getByRole("row").filter({ hasText: "Cost Filters — OTTL" }).getByTitle("Delete"), "manage your own configurations");
    await typeIntoFieldsAndExpectMasked(page);

    await sidebar(page).getByRole("link", { name: "Flows" }).click();
    await page.waitForURL("**/playground/flows");
    await expect(page).toHaveTitle("Flows - Playground - Telflo");
    await expect(page.getByRole("button").filter({ has: page.getByRole("heading", { level: 3 }) }).first()).toBeVisible();
    await typeIntoFieldsAndExpectMasked(page);
    await page.getByRole("button").filter({ has: page.getByRole("heading", { level: 3 }) }).first().click();
    await page.waitForURL(/\/playground\/flows\/[^/]+$/);
    await expect(page).toHaveTitle("Flow - Playground - Telflo");
    await expectLockedAt(page, page.getByRole("button", { name: "Use this flow" }), "start from this flow");
    await typeIntoFieldsAndExpectMasked(page);
    await openPlayground(page, "/playground/flows/log-volume-cost-control");
    await expectLockedAt(page, page.getByRole("button", { name: "Use this flow" }), "start from this flow");

    expect(recorder.outside()).toEqual([]);
    expect(new Set(recorder.apiRequests())).toEqual(new Set(["GET /api/v1/published-flows", "GET /api/v1/published-flows/:slug"]));
  });

  test("the playground editor: a sample and the blank one, the toolbar's locks", async ({ page, context }) => {
    test.slow();
    const recorder = recordPlaygroundRequests(context);
    for (const path of [`/playground/editor/${GATEWAY_ID}`, "/playground/editor"]) {
      await openPlayground(page, path);
      await expect(page).toHaveTitle("Playground Editor - Telflo");
      // The sample's text is checked after the pause (the blank one, empty, isn't).
      if (path !== "/playground/editor") {
        await expect.poll(() => recorder.apiRequests().includes(VALIDATE)).toBe(true);
        // A component's form, its instance name typed, and Add Pipeline's name typed: every field masked.
        await clickVisibleComponent(page);
        await page.getByRole("button", { name: "Advanced: Instance & YAML" }).click();
        await page.getByRole("textbox", { name: "Instance Name" }).fill("walk");
        await expectFieldsMasked(page);
        await page.getByRole("button", { name: "Add pipeline" }).click();
        const addPipeline = page.getByRole("dialog", { name: "Add New Pipeline" });
        await addPipeline.getByLabel("Pipeline Name").fill("traces/walk");
        await expectFieldsMasked(page);
        await page.keyboard.press("Escape");
        await expect(addPipeline).toHaveCount(0);
      }
      await typeIntoFieldsAndExpectMasked(page);
      await expectLockedAt(page, page.getByRole("button", { name: "Publish", exact: true }), "publish a configuration so fleets can deploy it");
      await page.getByRole("combobox", { name: /^Collector version/ }).click();
      await expectLockedAt(page, page.getByRole("option", { name: /0\.161\.0/ }), "validate against a different collector version");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const signIn = page.getByRole("alertdialog", { name: "Sign in to save" });
      await expect(signIn).toBeVisible();
      await signIn.getByRole("button", { name: "Cancel" }).click();
      await expect(signIn).toHaveCount(0);
    }
    await expectExactlyApi(recorder, [VALIDATE]);
  });

  test("the Testing tab: runs, the run dialog, validation and suites", async ({ page, context }) => {
    test.slow();
    const recorder = recordPlaygroundRequests(context);
    await openPlayground(page, `/playground/editor/${GATEWAY_ID}`);
    await page.getByRole("tab", { name: "Testing", exact: true }).click();
    const RUN = "run a test against your config";

    // Runs: a re-run, a run's details and its Compare.
    const rows = page.getByRole("button", { name: /(Success|Validation Failed|Error)$/ });
    await expect(rows).toHaveCount(4);
    await expectLockedAt(page, page.getByRole("button", { name: "Re-run test" }).first(), RUN);
    await rows.first().click();
    await expectLockedAt(page, page.getByRole("button", { name: "Compare input ↔ output" }), "compare a run's input and output");

    // The run dialog: Upload, Paste, a template's view and download, then its Run.
    await page.getByRole("button", { name: "Configure and run" }).click();
    const dialog = page.getByRole("dialog", { name: "Select Test File" });
    await dialog.getByRole("button", { name: "My Files" }).click();
    await expectLockedAt(page, dialog.getByRole("button", { name: "Upload" }), "upload a test file");
    // My Files' Cancel slides back to the choices.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expectLockedAt(page, dialog.getByRole("button", { name: "Paste Text" }), "save a pasted sample");
    await dialog.getByRole("button", { name: "Templates" }).click();
    await expectLockedAt(page, dialog.getByRole("button", { name: "View contents of Kubernetes pod logs" }), "view a template's contents");
    await expectLockedAt(page, dialog.getByRole("button", { name: "Download Kubernetes pod logs" }), "download a template");
    await dialog.getByText("Kubernetes pod logs", { exact: true }).click();
    await dialog.getByRole("button", { name: "OK" }).click();
    await typeIntoFieldsAndExpectMasked(page);
    await expectLockedAt(page, dialog.getByRole("button", { name: "Run", exact: true }), RUN);
    await expect(dialog).toHaveCount(0);

    // Validation: the pipeline's and its rules' writes.
    await page.getByRole("tab", { name: "Validation", exact: true }).click();
    await expectLockedAt(page, page.getByRole("button", { name: "Add validation pipeline" }), "create a validation pipeline");
    await page.getByRole("button", { name: /^logs/ }).click();
    await expectLockedAt(page, page.getByRole("button", { name: "Edit rule 1: service.name present on every record" }), "edit a validation rule");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete rule 1: service.name present on every record" }), "delete a validation rule");
    await expectLockedAt(page, page.getByRole("button", { name: "Add Validation Rule" }), "add a validation rule");
    await expectLockedAt(page, page.getByRole("button", { name: "Add from regex library" }), "add rules from the regex library");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete validation pipeline" }).first(), "delete a validation pipeline");

    // Suites: the suite's and its test configurations' runs and writes.
    await page.getByRole("tab", { name: "Suites", exact: true }).click();
    await expect(page.getByText("Nightly regression", { exact: true })).toBeVisible();
    await expectLockedAt(page, page.getByRole("button", { name: "Add suite" }), "create a test suite");
    await expectLockedAt(page, page.getByRole("button", { name: "Play all tests in parallel" }).first(), "run a test suite against your config");
    await expectLockedAt(page, page.getByRole("button", { name: "Play all tests serially" }).first(), "run a test suite against your config");
    await expectLockedAt(page, page.getByRole("button", { name: "Edit suite" }).first(), "edit a test suite");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete suite" }).first(), "delete a test suite");
    await page.getByText("Nightly regression", { exact: true }).click();
    await expectLockedAt(page, page.getByRole("button", { name: "Run test", exact: true }).first(), RUN);
    await expectLockedAt(page, page.getByRole("button", { name: "Delete test configuration" }).first(), "delete a test configuration");
    await expectLockedAt(page, page.getByRole("button", { name: "Add test configuration" }).first(), "add a test configuration");
    await typeIntoFieldsAndExpectMasked(page);

    await expectExactlyApi(recorder, [VALIDATE]);
  });

  /** The server fleet's walk: the list, the page and every tab's locked actions. */
  /**
   * The setup guide, opened from its toggle: on the sample every step is
   * done (each fleet has collectors), so it offers no Assign or Install of
   * its own; hidden again.
   */
  async function expectSetupGuideDone(page: Page): Promise<void> {
    const toggle = page.getByRole("button", { name: "Setup guide", exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/^Install a (collector|group with Helm)$/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Assign", exact: true })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  }

  /** The server fleet's walk, from the fleet list `enter` opens. */
  async function walkServerFleet(page: Page, enter: () => Promise<void>): Promise<void> {
    await enter();
    await expect(page).toHaveTitle("Fleet Management - Playground - Telflo");
    await expectLockedAt(page, page.getByRole("button", { name: "New Fleet", exact: true }), "connect your own collector fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Rename prod-us-east", exact: true }), "rename a fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Archive prod-us-east", exact: true }), "archive a fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete prod-us-east", exact: true }), "delete a fleet");
    await typeIntoFieldsAndExpectMasked(page);

    await page.getByRole("link", { name: "prod-us-east", exact: true }).click();
    await page.waitForURL(`**/playground/fleet-management/${PROD_FLEET_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "prod-us-east" })).toBeVisible();
    await expectLockedAt(page, page.getByRole("button", { name: "Install collector", exact: true }), "install collectors into your own fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Rename", exact: true }), "rename a fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Archive", exact: true }), "archive a fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete", exact: true }), "delete a fleet");
    await expectSetupGuideDone(page);

    // Collectors: a row's and the selection's writes, the values.
    await expectLockedAt(page, page.getByRole("button", { name: "Edit loving-tortoise", exact: true }), "edit a collector");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete loving-tortoise", exact: true }), "delete a collector");
    await expectLockedAt(page, page.getByRole("button", { name: "Organization values" }).first(), "see your organization's variable values");
    await page.getByRole("checkbox", { name: "Select loving-tortoise" }).check();
    await page.getByRole("checkbox", { name: "Select brave-falcon" }).check();
    const selection = page.getByRole("region", { name: "Selected collectors" });
    await expectLockedAt(page, selection.getByRole("button", { name: "Pin selected collectors" }), "pin collectors to a version");
    await expectLockedAt(page, selection.getByRole("button", { name: "Move to group" }), "move collectors to another group");
    await expectLockedAt(page, selection.getByRole("button", { name: "Delete selected collectors" }), "delete collectors");
    await page.getByRole("checkbox", { name: "Select loving-tortoise" }).uncheck();
    await page.getByRole("checkbox", { name: "Select brave-falcon" }).uncheck();
    // The collector search, typed into (never sent: a search goes on Enter), masked.
    await typeIntoFieldsAndExpectMasked(page);

    // Groups.
    await page.getByRole("tab", { name: "Groups" }).click();
    await page.waitForURL((url) => url.search === "?tab=groups");
    await expectLockedAt(page, page.getByRole("button", { name: "New group", exact: true }), "create a collector group");
    await expectLockedAt(page, page.getByRole("button", { name: "Edit canary", exact: true }), "edit a collector group");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete canary", exact: true }), "delete a collector group");
    await expectLockedAt(page, page.getByRole("button", { name: "Install into canary", exact: true }), "install collectors into your own fleet");
    await typeIntoFieldsAndExpectMasked(page);

    // Tokens, with the install links.
    await page.getByRole("tab", { name: "Tokens" }).click();
    await page.waitForURL((url) => url.search === "?tab=tokens");
    await expectLockedAt(page, page.getByRole("button", { name: "Rotate token", exact: true }), "rotate a fleet's token");
    await expectLockedAt(page, page.getByRole("button", { name: "Reveal the default token", exact: true }), "reveal a fleet token");
    await expectLockedAt(page, page.getByRole("button", { name: "Revoke the default token", exact: true }), "revoke a fleet token");
    await expectLockedAt(page, page.getByRole("button", { name: /^Extend the install link / }).first(), "extend an install link");
    await expectLockedAt(page, page.getByRole("button", { name: /^Revoke the install link / }).first(), "revoke install links");
    await typeIntoFieldsAndExpectMasked(page);
  }

  test("the server fleet: the list, its page and every tab", async ({ page, context }) => {
    test.slow();
    const recorder = recordPlaygroundRequests(context);
    await walkServerFleet(page, () => openPlayground(page, "/playground/fleet-management"));
    expect(recorder.outside()).toEqual([]);
    expect(recorder.apiRequests()).toEqual([]);
  });

  test("a signed-in visitor walks the server fleet and sees the same", async ({ page, context }) => {
    test.slow();
    const user = await seedUser({ password: WALK_PASSWORD });
    await signInThroughApi(page, user);
    await asReturningVisitor(context);
    await page.goto("/app");
    await waitForHydration(page);
    await expect(page.getByRole("heading", { level: 1, name: "Configurations" })).toBeVisible();
    // Into the playground in this tab, so its user store holds the account's organization, as a link would.
    const recorder = recordPlaygroundRequests(context);
    await walkServerFleet(page, async () => {
      await page.evaluate(`window.__reactRouterDataRouter.navigate("/playground/fleet-management")`);
      await page.waitForURL("**/playground/fleet-management");
    });
    // The banner still offers sign-up, and nothing of the account's organization was read.
    await expect(page.getByRole("link", { name: "Create free account" }).first()).toBeVisible();
    expect(recorder.outside()).toEqual([]);
    expect(recorder.apiRequests()).toEqual([]);
  });

  test("the Kubernetes fleet: its page and every tab", async ({ page, context }) => {
    test.slow();
    const recorder = recordPlaygroundRequests(context);
    await openPlayground(page, `/playground/fleet-management/${K8S_FLEET_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: "k8s-prod-us-west" })).toBeVisible();
    await expectLockedAt(page, page.getByRole("button", { name: "Install with Helm", exact: true }), "install collectors into your own cluster");
    await expectLockedAt(page, page.getByRole("button", { name: "Rename", exact: true }), "rename a fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Archive", exact: true }), "archive a fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete", exact: true }), "delete a fleet");
    await expectLockedAt(page, page.getByRole("button", { name: "Edit node-agent", exact: true }), "edit a collector");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete node-agent", exact: true }), "delete a collector");
    await expectSetupGuideDone(page);
    await typeIntoFieldsAndExpectMasked(page);

    await page.getByRole("tab", { name: "Groups" }).click();
    await page.waitForURL((url) => url.search === "?tab=groups");
    await expectLockedAt(page, page.getByRole("button", { name: "Add gateway", exact: true }), "add a gateway to your own cluster");
    await expectLockedAt(page, page.getByRole("button", { name: "Edit payments", exact: true }), "edit a collector group");
    await expectLockedAt(page, page.getByRole("button", { name: "Delete payments", exact: true }), "delete a collector group");
    await expectLockedAt(page, page.getByRole("button", { name: "Install payments", exact: true }), "install collectors into your own cluster");
    await typeIntoFieldsAndExpectMasked(page);

    await page.getByRole("tab", { name: "Tokens" }).click();
    await page.waitForURL((url) => url.search === "?tab=tokens");
    await expectLockedAt(page, page.getByRole("button", { name: "Rotate token", exact: true }), "rotate a fleet's token");
    await expectLockedAt(page, page.getByRole("button", { name: "Reveal the default token", exact: true }), "reveal a fleet token");
    await typeIntoFieldsAndExpectMasked(page);

    expect(recorder.outside()).toEqual([]);
    expect(recorder.apiRequests()).toEqual([]);
  });

  // By keyboard, as WebKit focuses no button a mouse presses: the details'
  // Edit is gone once the prompt opens, so the focus goes back to the row
  // that opened the details, as the details' own close gives it.
  test("after the prompt from a collector's details' Edit collector, the focus is back on the collector's row (keyboard)", async ({ page, context }) => {
    const recorder = recordPlaygroundRequests(context);
    await openPlayground(page, `/playground/fleet-management/${PROD_FLEET_ID}`);
    // A locked control on the page: the prompt's close gives the focus back to it.
    const edit = page.getByRole("button", { name: "Edit loving-tortoise", exact: true });
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(signupPrompt(page)).toContainText("To edit a collector, create a free account.");
    await page.keyboard.press("Escape");
    await expect(signupPrompt(page)).toHaveCount(0);
    await expect(edit).toBeFocused();

    const row = page.getByRole("button", { name: "brave-falcon", exact: true });
    await row.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "brave-falcon" });
    await expect(details).toBeVisible();
    await details.getByRole("button", { name: "Edit collector" }).focus();
    await page.keyboard.press("Enter");
    await expect(signupPrompt(page)).toContainText("To edit a collector, create a free account.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row).toBeFocused();
    expect(recorder.outside()).toEqual([]);
  });

  test("the blank public editor: its Welcome dialog, the toolbar's locks, Save", async ({ page, context }) => {
    test.slow();
    const recorder = recordPlaygroundRequests(context);
    await page.goto("/public-editor");
    await waitForHydration(page);
    await expect(page).toHaveTitle("Public Editor - Telflo");
    const welcome = page.getByRole("dialog", { name: "Welcome to Telflo" });
    await welcome.getByRole("checkbox", { name: "Skip tour" }).check();
    await welcome.getByRole("button", { name: "Use a Template" }).click();
    await expect(welcome).toHaveCount(0);
    await expectLockedAt(page, page.getByRole("button", { name: "Publish", exact: true }), "publish a configuration so fleets can deploy it");
    await page.getByRole("combobox", { name: /^Collector version/ }).click();
    await expectLockedAt(page, page.getByRole("option", { name: /0\.161\.0/ }), "validate against a different collector version");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const signIn = page.getByRole("alertdialog", { name: "Sign in to save" });
    await expect(signIn).toBeVisible();
    await signIn.getByRole("button", { name: "Cancel" }).click();
    // The Example's check sent before its text changes below.
    await expect.poll(() => recorder.apiRequests().includes(VALIDATE)).toBe(true);
    // A component's form: every field it shows, typed into, masked.
    await clickVisibleComponent(page);
    await page.getByRole("button", { name: "Advanced: Instance & YAML" }).click();
    await typeIntoFieldsAndExpectMasked(page);
    await expectExactlyApi(recorder, [VALIDATE]);
  });
});
