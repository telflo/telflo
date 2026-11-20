import { randomUUID } from "node:crypto";
import { expect, test as base, type Page, type Response } from "@playwright/test";
import { findStoredTheme, seedConfiguration, seedUser } from "./support/database.js";
import { open, openYamlTab, waitForCanvas } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import {
  expireAccessToken,
  navigateToSearch,
  savePreferencesThroughApi,
  serverHtmlClass,
  setThemeCookie,
  signInThroughApi,
  skipEditorTour,
  themeCookie,
  waitForHydration,
} from "./support/session.js";

// The theme: Light, Dark or Navy, Dark by default, in the server's HTML
// before the first paint. A signed-in page renders the stored theme; the
// auth screens the theme this browser was last told (the `telflo_theme`
// cookie on a full load); every other page `dark`. A change in Appearance
// applies at once, with no reload, to the shell, the canvas, every open
// Monaco and the toasts.
//
// - "No flash" is read with JavaScript off (support/session.ts's
//   serverHtmlClass): a second context with the first's cookies, so no script
//   of the page can have set the class.
// - An open Monaco is shown to follow a change made in a SECOND tab of the
//   same browser, while its page stays mounted: the editor's tab then
//   navigates to its own address with a search, which revalidates the
//   signed-in layout as any navigation does, and the same `.monaco-editor`
//   element is still there. Going back to the page would mount a new
//   Monaco and prove nothing.
// - Colors are read as computed styles once transitions have settled
//   (`toHaveCSS` retries until they have).

const PASSWORD = "correct horse battery staple";
const PREFERENCES_PATH = "/api/v1/auth/me/preferences";
const REFRESH_PATH = "/api/v1/auth/refresh";
const PREFERENCES_FAILED = "Failed to update preferences";

/** A pipeline, so the canvas draws nodes. */
const PIPELINE_YAML = [
  "receivers:",
  "  otlp:",
  "    protocols:",
  "      grpc: {}",
  "exporters:",
  "  debug: {}",
  "service:",
  "  pipelines:",
  "    traces:",
  "      receivers: [otlp]",
  "      exporters: [debug]",
  "",
].join("\n");

/**
 * What each theme paints, as computed colors: the shell's floor
 * (`body.tf-app`, the theme's background token, app.css), the canvas's
 * background (React Flow's, app.css), Monaco's code surface
 * (lib/editor/monaco-themes.ts; Light's is Monaco's built-in `vs`) and a
 * toast (the popover token, which the Toaster gives sonner).
 */
const COLOURS = {
  dark: { shell: "rgb(16, 19, 23)", canvas: "rgb(13, 16, 20)", monaco: "rgb(20, 24, 29)", toast: "rgb(27, 32, 39)" },
  navy: { shell: "rgb(12, 21, 36)", canvas: "rgb(10, 17, 32)", monaco: "rgb(15, 26, 46)", toast: "rgb(22, 35, 58)" },
  // Light's Monaco is Monaco's own `vs`: its background, #fffffe.
  light: { monaco: "rgb(255, 255, 254)" },
} as const;

const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

function html(page: Page) {
  return page.locator("html");
}

function themeButton(page: Page, name: "Light" | "Dark" | "Navy") {
  return page.getByRole("button", { name, exact: true });
}

function isPreferencesWrite(response: Response): boolean {
  return response.request().method() === "PATCH" && new URL(response.url()).pathname === PREFERENCES_PATH;
}

/** Answers the page's next preferences PATCH with a 500, once; the rest go through. */
async function failNextPreferencesWrite(page: Page): Promise<void> {
  let failed = false;
  await page.route(`**${PREFERENCES_PATH}`, async (route) => {
    if (failed || route.request().method() !== "PATCH") return route.fallback();
    failed = true;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal_error", message: "Something went wrong." } }),
    });
  });
}

/**
 * Holds the requests matching `url` that `page` sends from now on, until
 * `release`. `sent` resolves once the first one is held.
 */
async function holdRequests(
  page: Page,
  url: string,
  method: string,
): Promise<{ sent: Promise<void>; release: () => void }> {
  let markSent: () => void = () => {};
  const sent = new Promise<void>((resolve) => {
    markSent = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    markSent();
    await released;
    await route.continue();
  });
  return { sent, release };
}

test("with JavaScript off, a signed-in page's HTML carries the stored theme, and /login the cookie's after Logout", async ({
  page,
  context,
  browser,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);

  // No choice yet: Dark, the default, and the cookie the sign-in set says so.
  expect(await themeCookie(context)).toBe("dark");
  expect(await serverHtmlClass(browser, context, "/app")).toEqual({ url: `${E2E_WEB_URL}/app`, htmlClass: "dark" });

  await savePreferencesThroughApi(page, { theme: "navy" });
  expect(await themeCookie(context)).toBe("navy");
  expect(await serverHtmlClass(browser, context, "/app")).toEqual({ url: `${E2E_WEB_URL}/app`, htmlClass: "dark navy" });
  expect(await serverHtmlClass(browser, context, "/settings")).toEqual({
    url: `${E2E_WEB_URL}/settings/appearance`,
    htmlClass: "dark navy",
  });

  // Logout's client-side way to /login keeps the theme (the remembered value)…
  await open(page, "/app");
  await expect(html(page)).toHaveAttribute("class", "dark navy");
  await page.getByTitle("Switch organization").click();
  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL("/login");
  await expect(html(page)).toHaveAttribute("class", "dark navy");

  // …and the cookie, which Logout never clears, gives a full load of /login the same.
  expect(await themeCookie(context)).toBe("navy");
  expect(await serverHtmlClass(browser, context, "/login")).toEqual({ url: `${E2E_WEB_URL}/login`, htmlClass: "dark navy" });

  // A browser that was never told a theme: Dark.
  const stranger = await browser.newContext({ baseURL: E2E_WEB_URL });
  try {
    expect(await serverHtmlClass(browser, stranger, "/login")).toEqual({ url: `${E2E_WEB_URL}/login`, htmlClass: "dark" });
  } finally {
    await stranger.close();
  }
});

test("Appearance changes the class before the save answers; the cookie then holds the word, a reload paints it at once, and a failed save restores the theme", async ({
  page,
  context,
  browser,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);

  // Settings opens on Appearance, from the server and from the Sidebar.
  await open(page, "/settings");
  await expect(page).toHaveURL("/settings/appearance");
  await open(page, "/app");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL("/settings/appearance");
  await expect(themeButton(page, "Dark")).toHaveAttribute("aria-pressed", "true");
  await expect(html(page)).toHaveAttribute("class", "dark");

  // The class changes while the save is still held: before any answer.
  const held = await holdRequests(page, `**${PREFERENCES_PATH}`, "PATCH");
  await themeButton(page, "Light").click();
  await held.sent;
  await expect(html(page)).toHaveAttribute("class", "");
  await expect(themeButton(page, "Light")).toHaveAttribute("aria-pressed", "true");
  expect(await themeCookie(context)).toBe("dark");
  expect(await findStoredTheme(user.userId)).toBeUndefined();

  const answered = page.waitForResponse(isPreferencesWrite);
  held.release();
  expect((await answered).status()).toBe(200);
  await page.unroute(`**${PREFERENCES_PATH}`);
  await expect.poll(() => themeCookie(context)).toBe("light");
  expect(await findStoredTheme(user.userId)).toBe("light");

  // No flash: the server's HTML already carries Light, and so does a reload.
  expect((await serverHtmlClass(browser, context, "/settings/appearance")).htmlClass).toBe("");
  await page.reload();
  await waitForHydration(page);
  await expect(html(page)).toHaveAttribute("class", "");
  await expect(themeButton(page, "Light")).toHaveAttribute("aria-pressed", "true");

  // A save the API refuses: the theme goes back, with a toast.
  await failNextPreferencesWrite(page);
  const refused = page.waitForResponse(isPreferencesWrite);
  await themeButton(page, "Navy").click();
  expect((await refused).status()).toBe(500);
  await expect(page.getByText(PREFERENCES_FAILED, { exact: true })).toBeVisible();
  await expect(html(page)).toHaveAttribute("class", "");
  await expect(themeButton(page, "Light")).toHaveAttribute("aria-pressed", "true");
  await expect(themeButton(page, "Navy")).toHaveAttribute("aria-pressed", "false");
  expect(await themeCookie(context)).toBe("light");
  expect(await findStoredTheme(user.userId)).toBe("light");
});

test("the refresh placeholder renders the cookie's theme, then the stored one once /me answers", async ({
  page,
  context,
  browser,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await savePreferencesThroughApi(page, { theme: "navy" });
  // This browser was last told Light; the account holds Navy.
  await setThemeCookie(context, "light");
  await expireAccessToken(context);

  // The server can't refresh, so it renders the placeholder in the cookie's theme.
  expect(await serverHtmlClass(browser, context, "/app")).toEqual({ url: `${E2E_WEB_URL}/app`, htmlClass: "" });

  // In the browser, the refresh is held while the placeholder shows: read
  // before releasing it, since the refresh sets the cookie again.
  const held = await holdRequests(page, `**${REFRESH_PATH}`, "POST");
  await page.goto("/app");
  await held.sent;
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await expect(html(page)).toHaveAttribute("class", "");

  held.release();
  await expect(page.getByTitle("Switch organization")).toBeVisible();
  await expect(html(page)).toHaveAttribute("class", "dark navy");
  await expect.poll(() => themeCookie(context)).toBe("navy");
});

test("a change in Appearance applies at once to the shell and a toast, and in a tab left open to its canvas and the same Monaco", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Theme ${randomUUID()}`,
    yamlContent: PIPELINE_YAML,
  });

  // The editor, its canvas and its YAML tab open, in Dark.
  await open(page, `/editor/${configuration.id}`);
  await waitForCanvas(page);
  await openYamlTab(page);
  await expect(page.locator(".monaco-editor")).toBeVisible();
  // Kept in the page, not marked in the DOM: the element itself, to compare later.
  await page.evaluate(`window.__e2eMonaco = document.querySelector(".monaco-editor")`);
  await expect(html(page)).toHaveAttribute("class", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", COLOURS.dark.shell);
  await expect(page.locator(".react-flow__background")).toHaveCSS("background-color", COLOURS.dark.canvas);
  await expect(page.locator(".monaco-editor").first()).toHaveCSS("background-color", COLOURS.dark.monaco);

  // Appearance in a second tab, with a toast showing in Dark: a save the API refuses.
  const settings = await context.newPage();
  await open(settings, "/settings/appearance");
  await failNextPreferencesWrite(settings);
  await themeButton(settings, "Light").click();
  const toast = settings.locator("[data-sonner-toast]").filter({ hasText: PREFERENCES_FAILED });
  await expect(toast).toBeVisible();
  await expect(html(settings)).toHaveAttribute("class", "dark");
  await expect(toast).toHaveCSS("background-color", COLOURS.dark.toast);

  // Navy: the shell and the toast still showing follow at once.
  const saved = settings.waitForResponse(isPreferencesWrite);
  await themeButton(settings, "Navy").click();
  await expect(html(settings)).toHaveAttribute("class", "dark navy");
  await expect(settings.locator("body")).toHaveCSS("background-color", COLOURS.navy.shell);
  await expect(toast).toHaveCSS("background-color", COLOURS.navy.toast);
  expect((await saved).status()).toBe(200);

  // The editor's tab, never left: its next navigation brings Navy to the
  // shell, the canvas and the Monaco that was already open.
  await navigateToSearch(page, "?theme-check=1");
  await expect(html(page)).toHaveAttribute("class", "dark navy");
  await expect(page.locator("body")).toHaveCSS("background-color", COLOURS.navy.shell);
  await expect(page.locator(".react-flow__background")).toHaveCSS("background-color", COLOURS.navy.canvas);
  await expect(page.locator(".monaco-editor").first()).toHaveCSS("background-color", COLOURS.navy.monaco);
  expect(
    await page.evaluate<boolean>(
      `window.__e2eMonaco.isConnected && window.__e2eMonaco === document.querySelector(".monaco-editor")`,
    ),
  ).toBe(true);

  // Light: the same Monaco leaves telflo-navy for Monaco's own `vs`,
  // since Monaco's theme is global and Light sets it too.
  const savedLight = settings.waitForResponse(isPreferencesWrite);
  await themeButton(settings, "Light").click();
  await expect(html(settings)).toHaveAttribute("class", "");
  expect((await savedLight).status()).toBe(200);
  await navigateToSearch(page, "?theme-check=2");
  await expect(html(page)).toHaveAttribute("class", "");
  await expect(page.locator(".monaco-editor").first()).toHaveCSS("background-color", COLOURS.light.monaco);
  expect(
    await page.evaluate<boolean>(
      `window.__e2eMonaco.isConnected && window.__e2eMonaco === document.querySelector(".monaco-editor")`,
    ),
  ).toBe(true);
});

for (const theme of ["light", "navy"] as const) {
  test(`a ${theme} account's Monaco paints its own theme from its first frame, never Dark's`, async ({ page }) => {
    const user = await seedUser({ password: PASSWORD });
    await signInThroughApi(page, user);
    await savePreferencesThroughApi(page, { theme });
    const configuration = await seedConfiguration({
      organizationId: user.organizationId,
      createdByUserId: user.userId,
      name: `Theme ${randomUUID()}`,
      yamlContent: PIPELINE_YAML,
    });

    // Every frame, before it paints: Monaco's background, each change once.
    await page.addInitScript(`(() => {
      window.__e2eMonacoBackgrounds = [];
      const sample = () => {
        const editor = document.querySelector(".monaco-editor");
        if (editor !== null) {
          const colour = getComputedStyle(editor).backgroundColor;
          const seen = window.__e2eMonacoBackgrounds;
          if (seen[seen.length - 1] !== colour) seen.push(colour);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })()`);
    await open(page, `/editor/${configuration.id}`);
    await openYamlTab(page);
    await expect(page.locator(".monaco-editor").first()).toHaveCSS("background-color", COLOURS[theme].monaco);

    const seen = () => page.evaluate<string[]>("window.__e2eMonacoBackgrounds");
    await expect.poll(seen).toContain(COLOURS[theme].monaco);
    expect(await seen()).not.toContain(COLOURS.dark.monaco);
    expect(await seen()).toEqual([COLOURS[theme].monaco]);
  });
}

test("a page that isn't found stays dark whatever the account's theme", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await savePreferencesThroughApi(page, { theme: "light" });

  await open(page, "/settings/appearance");
  await expect(html(page)).toHaveAttribute("class", "");
  // Outside every layout: root's 404.
  const response = await page.goto(`/no-such-page-${randomUUID()}`);
  expect(response?.status()).toBe(404);
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "404", exact: true })).toBeVisible();
  await expect(html(page)).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html(page)).not.toHaveClass(/navy/);
});
