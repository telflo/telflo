import { expect, type Page } from "@playwright/test";
// The SaaS pair (D36-1 Preflight ruling 16): open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { openYamlTab, platformKeys, typeLineAtTop } from "./support/editor-page.js";
import { recordPlaygroundRequests, sampled } from "./support/playground.js";
import { storageHolding } from "./support/privacy.js";
import { waitForHydration } from "./support/session.js";

// The blank public editor with NO account (D31-1 decisions 3, 7, 15, 16, 18,
// 22, 29 and 38; Q210; Preflight rulings 5 and 18): the Welcome dialog shows
// until a choice is made (its flag, read on the next visit), Start from
// Scratch and Use a Template (its example on Contrib 0.162.0), the
// editor tour from it, D27's anonymous validate marking an error and
// clearing it, Save staging the edit and opening "Sign in to save", and the
// phone page. Each test records its requests: none falls outside decision
// 22's invariant. The words are the spec's, written out here: the browser
// tests don't import the web app's modules. Every text asserted is the page's
// own, the example's or the test's own marker.

const PIN = "0.162.0";
const WELCOME = "Welcome to Telflo";
const STAGED_KEY = "telflo-playground-staged-edit";
const WELCOME_KEY = "telflo-public-editor-welcome-done";

const validText = (version: string) => `config valid · v${version}`;
const errorsText = (count: number, version: string) => `${count} ${count === 1 ? "error" : "errors"} · v${version}`;

function welcome(page: Page) {
  return page.getByRole("dialog", { name: WELCOME });
}

async function openPublicEditor(page: Page): Promise<void> {
  await page.goto("/public-editor");
  await waitForHydration(page);
}

/** Chooses in the Welcome dialog, the tour skipped unless `tour`. */
async function start(page: Page, choice: "Start from Scratch" | "Use a Template", { tour = false } = {}): Promise<void> {
  await expect(welcome(page)).toBeVisible();
  if (!tour) await welcome(page).getByRole("checkbox", { name: "Skip tour" }).check();
  await welcome(page).getByRole("button", { name: choice }).click();
  await expect(welcome(page)).toHaveCount(0);
}

// Text goes into Monaco as the signed-in specs type it, one line at the top
// (support/editor-page.ts's typeLineAtTop): Playwright's insertText of text
// holding a newline lands twice in Firefox, in every editor, signed in too,
// while typing and a real paste land once (Ruling 306).

/**
 * The keys a visit may leave in browser storage (decision 18, Ruling 301):
 * the Welcome dialog's flag, the theme word and the tour flags. Never the
 * text shown or typed.
 */
const NAMED_STORAGE_KEYS = new Set([
  `localStorage ${WELCOME_KEY}`,
  "localStorage telflo-playground-theme",
  "localStorage telflo-tour-completed",
  "localStorage telflo-playground-tour-completed",
  "sessionStorage telflo-playground-tour-stage",
]);

/** Every localStorage and sessionStorage key, as "{store} {key}" (fixed names: no value is read). */
function storageKeys(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`[["localStorage", window.localStorage], ["sessionStorage", window.sessionStorage]].flatMap(
    ([label, store]) => Array.from({ length: store.length }, (_, index) => label + " " + store.key(index)),
  )`);
}

function stored(page: Page, key: string): Promise<boolean> {
  return page.evaluate<boolean>(`window.localStorage.getItem(${JSON.stringify(key)}) !== null`);
}

test.describe.configure({ mode: "serial" });

test("the Welcome dialog shows until a choice is made, and not on the next visit", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPublicEditor(page);
  await expect(page).toHaveTitle("Public Editor - Telflo");
  await expect(welcome(page)).toContainText("Build OpenTelemetry Collector configurations visually. How would you like to start?");
  // Escape doesn't dismiss it, said once it has had about a second to close (Ruling 304); a reload shows it again:
  // nothing chosen yet.
  await page.keyboard.press("Escape");
  const states = await sampled(() => welcome(page).getAttribute("data-state"), 10);
  expect(states.every((state) => state === "open")).toBe(true);
  expect(await stored(page, WELCOME_KEY)).toBe(false);
  await page.reload();
  await waitForHydration(page);
  await expect(welcome(page)).toBeVisible();

  await start(page, "Start from Scratch");
  await expect(page.getByRole("heading", { level: 1, name: "Untitled configuration" })).toBeVisible();
  // No canvas pill on the public editor (Q209 parity, Ruling 304).
  await expect(page.getByText("Build and validate freely — Save to keep your work.")).toHaveCount(0);
  // No Testing tab, no playground shell.
  await expect(page.getByRole("tab", { name: "YAML", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Testing", exact: true })).toHaveCount(0);
  await expect(page.getByText("You're in the playground")).toHaveCount(0);
  expect(await stored(page, WELCOME_KEY)).toBe(true);

  await page.reload();
  await waitForHydration(page);
  await expect(page.getByRole("heading", { level: 1, name: "Untitled configuration" })).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
  expect(recorder.outside()).toEqual([]);
});

test("Use a Template opens its example on Contrib 0.162.0; the anonymous validate marks an error typed in it and clears it", async ({
  page,
  context,
}) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  await openPublicEditor(page);
  await start(page, "Use a Template");
  await expect(page.getByRole("heading", { level: 1, name: "Example Pipeline" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: `Collector version v${PIN}` })).toBeVisible();
  await openYamlTab(page);
  await expect(page.getByText(validText(PIN), { exact: true })).toBeVisible();

  await typeLineAtTop(page, "connectors: {unknown_zqpublic: {}}");
  await expect(page.getByRole("button", { name: errorsText(1, PIN), exact: true })).toBeVisible();

  // The line out again: the text the validate last called valid.
  await page.keyboard.press((await platformKeys(page)).top);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Backspace");
  await expect(page.getByText(validText(PIN), { exact: true })).toBeVisible();

  // A pick of another version is locked (Q210).
  await page.getByRole("combobox", { name: `Collector version v${PIN}` }).click();
  await page.getByRole("option", { name: /v0\.161\.0/ }).click();
  const prompt = page.getByRole("dialog", { name: "This is a sample workspace" });
  await expect(prompt).toContainText("To validate against a different collector version, create a free account.");
  await prompt.getByRole("button", { name: "Keep exploring" }).click();
  await expect(page.getByRole("combobox", { name: `Collector version v${PIN}` })).toBeVisible();

  expect(recorder.outside()).toEqual([]);
  expect(new Set(recorder.apiRequests())).toEqual(new Set(["POST /api/public/v1/validate/anonymous"]));
});

test("after the Example and typing, browser storage holds only the named keys, none holding the Example's or the typed text (Ruling 301)", async ({
  page,
  context,
}) => {
  test.slow();
  const recorder = recordPlaygroundRequests(context);
  const checks = () => recorder.apiRequests().filter((name) => name === "POST /api/public/v1/validate/anonymous").length;
  await openPublicEditor(page);
  await start(page, "Use a Template");
  await openYamlTab(page);
  await expect(page.getByText(validText(PIN), { exact: true })).toBeVisible();
  const before = checks();
  const canary = `zqstored${Date.now().toString(36)}`;
  await typeLineAtTop(page, `# ${canary}`);
  // A fresh check of the typed text (so the editor has taken it in) before storage is read (Ruling 304).
  await expect.poll(checks).toBeGreaterThan(before);
  await expect(page.getByText(validText(PIN), { exact: true })).toBeVisible();
  const keys = await storageKeys(page);
  // The Example's own host, and the typed marker: booleans only.
  const holding = await storageHolding(page, [canary, "otelcol.acme.example"]);
  await page.goto("about:blank");

  expect(keys.filter((key) => !NAMED_STORAGE_KEYS.has(key))).toEqual([]);
  expect(keys.includes(`localStorage ${WELCOME_KEY}`)).toBe(true);
  expect(holding.length).toBe(0);
});

test("the Welcome dialog's tour: the editor tour starts, with no version-history step", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPublicEditor(page);
  await start(page, "Use a Template", { tour: true });
  const popover = page.locator(".driver-popover");
  await expect(popover.getByText("Component Toolbox", { exact: true })).toBeVisible();
  // To the end: its last step is the toolbar's actions (no version picker here). Each step: its title read once
  // it shows, Next pressed, then the next step's title waited for before anything else is read (Ruling 313: a
  // look between steps found neither Next nor Get Started). At most 12 steps.
  const title = popover.locator(".driver-popover-title");
  let reachedEnd = false;
  for (let step = 0; step < 12; step += 1) {
    await expect(title).toBeVisible();
    const shown = await title.textContent();
    if ((await popover.getByRole("button", { name: "Get Started" }).count()) > 0) {
      reachedEnd = true;
      break;
    }
    await popover.getByRole("button", { name: "Next" }).click();
    await expect(title).not.toHaveText(shown ?? "");
  }
  expect(reachedEnd).toBe(true);
  await expect(popover.getByText("Toolbar Actions", { exact: true })).toBeVisible();
  await expect(page.getByText("Version History", { exact: true })).toHaveCount(0);
  await popover.getByRole("button", { name: "Get Started" }).click();
  await expect(popover).toHaveCount(0);
  expect(recorder.outside()).toEqual([]);
});

test("Save stages the edit in this browser and opens 'Sign in to save'; Publish is locked", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await openPublicEditor(page);
  await start(page, "Use a Template");
  expect(await stored(page, STAGED_KEY)).toBe(false);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const signIn = page.getByRole("alertdialog", { name: "Sign in to save" });
  await expect(signIn).toBeVisible();
  await expect(signIn.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?redirectTo=%2Fapp");
  await expect(signIn.getByRole("link", { name: "Create free account" })).toHaveAttribute("href", "/register");
  expect(await stored(page, STAGED_KEY)).toBe(true);

  await signIn.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "This is a sample workspace" })).toBeVisible();
  expect(recorder.outside()).toEqual([]);
});

test("a phone gets the phone page: no editor, no Welcome dialog, nothing checked", async ({ page, context }) => {
  const recorder = recordPlaygroundRequests(context);
  await page.setViewportSize({ width: 375, height: 800 });
  await openPublicEditor(page);
  await expect(page.getByText("The editor is best viewed on larger screens such as laptop or computer browsers.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await expect(welcome(page)).toHaveCount(0);
  // Nothing checked, past the 1.5 s pause after which an opened text would be (Ruling 304).
  const checked = await sampled(() => recorder.apiRequests().length > 0, 20);
  expect(checked.some(Boolean)).toBe(false);
  expect(recorder.outside()).toEqual([]);
  expect(recorder.apiRequests()).toEqual([]);
});
