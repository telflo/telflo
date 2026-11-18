import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test as base, type BrowserContext, type Dialog, type Page } from "@playwright/test";
import {
  STARTER_CONFIGURATION_DESCRIPTION,
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
} from "../apps/api/src/modules/configurations/starter-configuration.js";
import {
  addMember,
  findConfigurations,
  findConfigurationVersions,
  findMemberships,
  findUsersByEmail,
  seedConfiguration,
  seedConfigurationVersion,
  seedUser,
  uniqueEmail,
  type SeededUser,
} from "./support/database.js";
import {
  expectShownFromTop,
  open,
  openYamlTab,
  platformKeys,
  shownLines,
  typeLineAtTop,
  versionAddress,
} from "./support/editor-page.js";
import { E2E_SAAS_WEB_URL, E2E_WEB_URL } from "./support/environment.js";
import { clickGoogle, signInAtProvider } from "./support/oidc.js";
import { signInThroughApi, switchOrganizationThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";

// The configuration editor at /editor/{id} (D8), in the browser. The
// configurations it opens are seeded by SQL (support/database.ts's
// seedConfiguration, with their version 1), except the starter, which only
// createAccount makes (Preflight ruling 12), and the one the create dialog
// makes. Each test works in organizations of its own, so tests and browsers
// run in parallel. A second person is a second browser context.
//
// Monaco in Playwright (Preflight ruling 13; the helpers are
// support/editor-page.ts's, shared with the other browser tests, D9d Ruling
// 57):
// - Monaco closes quotes and brackets and indents after `:` as it is typed,
//   so the tests type a comment line, `# edited <uuid>`, at the top, and
//   expect exactly it and a newline before the original text.
// - Monaco takes its platform from the user agent, not from the machine:
//   WebKit's device is a Mac (Cmd), Chromium's and Firefox's are Windows
//   (Ctrl). Playwright's `ControlOrMeta` follows the machine instead, so the
//   keys are chosen from the page's user agent (`platformKeys`).
// - A headless browser never shows its save dialog, so the tests check that
//   Cmd/Ctrl+S's default was prevented.
// - Monaco draws only the lines in view, so what it shows is read from its
//   drawn lines (`shownLines`), and the whole text from the database or the
//   download.
// - The panel opens on Configuration since D9a, and Monaco mounts only when
//   the YAML tab opens (Radix doesn't mount a tab's content until it is
//   shown), so the tests open the YAML tab after each full page load
//   (D9a Preflight ruling 7). Typing enters manual edit mode, which locks the
//   canvas; saving saves the typed text (D9a decision 2).

const PASSWORD = "correct horse battery staple";
const ORIGINAL_YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";
const NOT_FOUND_MESSAGE = "Configuration not found";

/**
 * `secondContext`: a second browser, for a second person, with its own
 * cookie jar. Closed when the test ends. In both browsers the editor's tour
 * is marked done (`skipEditorTour`): these tests aren't about it, and it
 * would cover the page on a first visit (D9a decision 14).
 */
const test = base.extend<{ secondContext: BrowserContext }>({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
  secondContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: E2E_WEB_URL });
    await skipEditorTour(context);
    await use(context);
    await context.close();
  },
});

/** Opens `/editor/{id}` in a full page load, opens the YAML tab, and waits for Monaco to show the text's first line. */
async function openEditor(page: Page, configurationId: string, firstLine: string): Promise<void> {
  await open(page, `/editor/${configurationId}`);
  await openYamlTab(page);
  await expectShownFromTop(page, [firstLine]);
}

/** The only version's YAML, as the database holds it. */
async function storedYaml(configurationId: string): Promise<string | undefined> {
  const versions = await findConfigurationVersions(configurationId);
  expect(versions.map((version) => version.version_number)).toEqual([1]);
  return versions[0]?.yaml_content;
}

function unsavedBadge(page: Page) {
  return page.getByText("Unsaved", { exact: true });
}

function saveButton(page: Page) {
  return page.getByRole("button", { name: "Save", exact: true });
}

function nameHeading(page: Page, name: string) {
  return page.getByRole("heading", { level: 1, name, exact: true });
}

/** The sidebar's link to the list: a navigation inside the app. */
function configurationsLink(page: Page) {
  return page.getByRole("link", { name: "Configurations", exact: true });
}

/** The right-hand panel. */
function panel(page: Page) {
  return page.locator('[data-tour-step="editor-right-panel"]');
}

async function panelWidth(page: Page): Promise<number | undefined> {
  return (await panel(page).boundingBox())?.width;
}

/** A user with a configuration named `name` in their personal organization, holding `yamlContent`, signed in. */
async function seedSignedInWithConfiguration(
  page: Page,
  { name = `Edited ${randomUUID()}`, yamlContent = ORIGINAL_YAML }: { name?: string; yamlContent?: string } = {},
): Promise<{ user: SeededUser; configurationId: string; name: string }> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name,
    yamlContent,
  });
  await signInThroughApi(page, user);
  return { user, configurationId: configuration.id, name };
}

/**
 * Records, for every Cmd/Ctrl+S the page receives from now on, whether its
 * default (the browser's save dialog) was prevented, once the event has been
 * through every listener. Read with `savesPrevented`.
 */
async function recordSaveKeys(page: Page): Promise<void> {
  await page.evaluate(`
    window.__saveKeysPrevented = [];
    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        setTimeout(() => window.__saveKeysPrevented.push(event.defaultPrevented));
      }
    }, true);
  `);
}

function savesPrevented(page: Page): Promise<boolean[]> {
  return page.evaluate<boolean[]>("window.__saveKeysPrevented");
}

test.describe("with a window tall enough for Monaco to draw the whole starter", () => {
  // On the SaaS pair (D36-1 Preflight ruling 16): a Google sign-up behind the Terms dialog.
  test.use({ viewport: { width: 1280, height: 1400 }, baseURL: E2E_SAAS_WEB_URL });

  test("a new account lists its Initial Configuration, and opening it shows the starter YAML in Monaco", async ({ page }) => {
    // Only createAccount makes the starter: a Google sign-up through the fake provider.
    const email = uniqueEmail("gmail.com");
    await open(page, "/register");
    await clickGoogle(page);
    await signInAtProvider(page, { email });
    await page.waitForURL("/app");
    await waitForHydration(page);
    const terms = page.getByRole("dialog", { name: "Updated Terms of Service" });
    await terms.getByLabel("I agree to the Terms of Service and Privacy Policy").check();
    await terms.getByRole("button", { name: "Accept" }).click();
    await expect(terms).toBeHidden();

    const card = page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: STARTER_CONFIGURATION_NAME, exact: true }) });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(STARTER_CONFIGURATION_DESCRIPTION);

    await card.getByRole("heading", { name: STARTER_CONFIGURATION_NAME, exact: true }).click();

    const [user] = await findUsersByEmail(email);
    const [membership] = await findMemberships(user?.id ?? "");
    const [configuration] = await findConfigurations(membership?.organization_id ?? "");
    await expect(page).toHaveURL(await versionAddress(configuration?.id ?? ""));
    await expect(nameHeading(page, STARTER_CONFIGURATION_NAME)).toBeVisible();
    // The panel's three tabs: Testing since D14a (decision 21).
    await expect(page.getByRole("tab")).toHaveText(["Configuration", "YAML", "Testing"]);
    await expect(page.getByRole("tab", { name: "Configuration" })).toHaveAttribute("aria-selected", "true");
    await openYamlTab(page);
    // Every line, the last one empty: the starter ends in one newline.
    await expect.poll(() => shownLines(page)).toEqual(STARTER_CONFIGURATION_YAML.split("\n"));
    await expect(unsavedBadge(page)).toBeHidden();
    await expect(saveButton(page)).toBeDisabled();
  });
});

test("typing into Monaco and saving with the button clears Unsaved; a reload shows the saved text, and the version holds it exactly", async ({
  page,
}) => {
  const { configurationId } = await seedSignedInWithConfiguration(page);
  await openEditor(page, configurationId, "receivers:");
  await expect(saveButton(page)).toBeDisabled();
  const edit = `# edited ${randomUUID()}`;

  await typeLineAtTop(page, edit);

  await expect(unsavedBadge(page)).toBeVisible();
  await saveButton(page).click();

  await expect(page.getByText("Saved configuration")).toBeVisible();
  await expect(unsavedBadge(page)).toBeHidden();
  await expect(saveButton(page)).toBeDisabled();
  expect(await storedYaml(configurationId)).toBe(`${edit}\n${ORIGINAL_YAML}`);

  await page.reload();
  await waitForHydration(page);
  await openYamlTab(page);
  await expectShownFromTop(page, [edit, "receivers:", "  otlp:"]);
  await expect(unsavedBadge(page)).toBeHidden();
});

test("Cmd (WebKit) or Ctrl+S saves, inside Monaco and outside it, and the browser's own save is prevented each time", async ({
  page,
}) => {
  const { configurationId } = await seedSignedInWithConfiguration(page);
  await openEditor(page, configurationId, "receivers:");
  await recordSaveKeys(page);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  const keys = await platformKeys(page);
  const first = `# edited ${randomUUID()}`;
  const second = `# edited again ${randomUUID()}`;

  // Inside Monaco: its own command saves.
  await typeLineAtTop(page, first);
  await expect(unsavedBadge(page)).toBeVisible();
  await page.keyboard.press(keys.save);

  await expect(unsavedBadge(page)).toBeHidden();
  await expect.poll(() => storedYaml(configurationId)).toBe(`${first}\n${ORIGINAL_YAML}`);

  // Outside Monaco: the page's own listener saves.
  await typeLineAtTop(page, second);
  await expect(unsavedBadge(page)).toBeVisible();
  // The canvas, under manual edit mode's overlay.
  await page.getByText("In Manual Edit Mode. Exit Manual Edit mode to resume canvas updates.").click();
  await page.keyboard.press(keys.save);

  await expect(unsavedBadge(page)).toBeHidden();
  await expect.poll(() => storedYaml(configurationId)).toBe(`${second}\n${first}\n${ORIGINAL_YAML}`);
  await expect.poll(() => savesPrevented(page)).toEqual([true, true]);
  expect(dialogs).toEqual([]);
});

test("a YAML syntax error shows Monaco's error marker and the validation alert, and fixing it clears both", async ({
  page,
}) => {
  const { configurationId } = await seedSignedInWithConfiguration(page, { yamlContent: "" });
  await openEditor(page, configurationId, "");
  const keys = await platformKeys(page);
  const alert = page.getByRole("alert").filter({ hasText: "YAML Validation Error" });

  // A nested mapping in a compact one: monaco-yaml's worker marks it.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type("key: nested: value");

  await expect(alert).toContainText("1 validation error");
  await expect(page.locator(".monaco-editor .squiggly-error").first()).toBeVisible();

  await page.keyboard.press(keys.selectAll);
  await page.keyboard.type("key: value");

  await expect(alert).toBeHidden();
  await expect(page.locator(".monaco-editor .squiggly-error")).toHaveCount(0);
});

/**
 * The attributes, anywhere in the document (shadow roots included), whose
 * value holds `text`: replay records attributes unmasked (ADR 0024).
 */
function attributesHolding(page: Page, text: string): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    const text = ${JSON.stringify(text)};
    const found = [];
    const walk = (root) => {
      for (const element of root.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (attribute.value.includes(text)) found.push(element.tagName + "[" + attribute.name + "]");
        }
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    };
    walk(document);
    return found;
  })()`);
}

/** Monaco's parts found in the page, each with whether it is inside replay's blocked element (`ph-no-capture`). */
function monacoPartsBlocked(page: Page): Promise<{ part: string; blocked: boolean }[]> {
  return page.evaluate<{ part: string; blocked: boolean }[]>(`["monaco-editor", "suggest-widget", "monaco-hover", "find-widget", "monaco-aria-container"]
    .flatMap((part) => [...document.querySelectorAll("." + part)]
      .map((element) => ({ part, blocked: element.closest(".ph-no-capture") !== null })))`);
}

test("Monaco's suggestions never put the configuration's words in an attribute, and the editor is blocked from replay (ADR 0024)", async ({
  page,
}) => {
  // A word only the configuration holds. Monaco's word-based suggestions
  // offered it, each suggestion row's aria-label naming it ("<word>, Text").
  const word = `zqmarker${randomUUID().replace(/-/g, "")}`;
  const { configurationId } = await seedSignedInWithConfiguration(page, {
    yamlContent: `${ORIGINAL_YAML}processors:\n  ${word}: {}\n`,
  });
  await openEditor(page, configurationId, "receivers:");
  const keys = await platformKeys(page);
  const suggestions = page.locator(".monaco-editor .suggest-widget");

  // Typing the word's start at the end of the text: Monaco suggests as it's typed.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press(keys.bottom);
  await page.keyboard.press("Enter");
  await page.keyboard.type(word.slice(0, 6));
  // And asked for (Ctrl+Space in every browser).
  await page.keyboard.press("Control+Space");

  await expect(suggestions).toBeVisible();
  await expect(suggestions.locator(".monaco-list-row, .message").filter({ visible: true }).first()).toBeVisible();
  expect(await attributesHolding(page, word)).toEqual([]);

  // Monaco's find widget is inside the editor too.
  await page.keyboard.press("Escape");
  await page.keyboard.press(keys.find);
  await expect(page.locator(".monaco-editor .find-widget")).toBeVisible();

  const parts = await monacoPartsBlocked(page);
  expect(parts.map((p) => p.part)).toEqual(expect.arrayContaining(["monaco-editor", "suggest-widget", "find-widget", "monaco-aria-container"]));
  expect(parts.filter((p) => !p.blocked)).toEqual([]);
  expect(await attributesHolding(page, word)).toEqual([]);
});

test("renaming from the toolbar: Enter saves the name, and the list shows it", async ({ page }) => {
  const { user, configurationId, name } = await seedSignedInWithConfiguration(page);
  await openEditor(page, configurationId, "receivers:");
  const renamed = `Renamed ${randomUUID()}`;

  await nameHeading(page, name).hover();
  await page.getByRole("button", { name: "Rename configuration" }).click();
  const field = page.getByRole("textbox", { name: "Configuration name" });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(name);
  await field.fill(renamed);
  await field.press("Enter");

  await expect(page.getByText("Configuration updated")).toBeVisible();
  await expect(nameHeading(page, renamed)).toBeVisible();
  await expect(field).toBeHidden();
  const [row] = await findConfigurations(user.organizationId);
  expect(row?.name).toBe(renamed);

  await configurationsLink(page).click();

  await expect(page).toHaveURL("/app");
  await expect(page.getByRole("heading", { name: renamed, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
});

test("Copy puts the editor's text on the clipboard, and Download saves it as config.yaml", async ({
  page,
  context,
  browserName,
}) => {
  const { configurationId } = await seedSignedInWithConfiguration(page);
  await openEditor(page, configurationId, "receivers:");
  // The editor's text, unsaved, is what they take.
  const edit = `# edited ${randomUUID()}`;
  await typeLineAtTop(page, edit);
  const expected = `${edit}\n${ORIGINAL_YAML}`;

  // Only Chromium lets a test grant reading the clipboard back; elsewhere
  // the toast, which says the write succeeded, is the check.
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy YAML to clipboard" }).click();

  await expect(page.getByText("Configuration copied to clipboard")).toBeVisible();
  if (browserName === "chromium") {
    expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe(expected);
  }

  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download YAML configuration" }).click();
  const download = await downloaded;

  expect(download.suggestedFilename()).toBe("config.yaml");
  expect(await readFile(await download.path(), "utf8")).toBe(expected);
  await expect(page.getByText("Configuration downloaded")).toBeVisible();
});

test("creating a configuration from the list lands on /editor/{id}/{versionId} with an empty YAML tab", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await open(page, "/app");
  const name = `Created ${randomUUID()}`;

  await page.locator("#createNewConfigurationButton").click();
  // The start step first (D12 Preflight ruling 8): a blank configuration.
  await page.getByRole("dialog", { name: "New configuration" }).getByRole("button", { name: /Blank configuration/ }).click();
  const dialog = page.getByRole("dialog", { name: "Name Your Configuration" });
  await dialog.getByLabel("Configuration Name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  // `/editor/{id}` replaces itself with its version's address (D10 decision 9).
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  const [created] = await findConfigurations(user.organizationId);
  expect(page.url()).toBe(`${E2E_WEB_URL}${await versionAddress(created?.id ?? "")}`);
  await expect(nameHeading(page, name)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Configuration" })).toHaveAttribute("aria-selected", "true");
  await openYamlTab(page);
  await expect.poll(() => shownLines(page)).toEqual([""]);
  await expect(unsavedBadge(page)).toBeHidden();
  expect(await storedYaml(created?.id ?? "")).toBe("");
});

test("the toolbox, the canvas and the panel sit side by side, in that order", async ({ page }) => {
  const { configurationId } = await seedSignedInWithConfiguration(page);
  await open(page, `/editor/${configurationId}`);

  const toolbox = await page.locator('[data-tour-step="toolbox"]').boundingBox();
  const canvas = await page.locator('[data-tour-step="canvas"]').boundingBox();
  const right = await panel(page).boundingBox();
  if (toolbox === null || canvas === null || right === null) throw new Error("a column isn't shown");
  expect(toolbox.width).toBeCloseTo(240, 0);
  expect(canvas.x).toBeCloseTo(toolbox.x + toolbox.width, 0);
  expect(right.x).toBeCloseTo(canvas.x + canvas.width, 0);
  await expect(page.locator('[data-tour-step="toolbox"]').getByText("Components", { exact: true })).toBeVisible();
  await expect(page.locator('[data-tour-step="canvas"] .react-flow')).toBeVisible();
});

test("the panel collapses to its rail, expands from the rail's button and from its YAML icon, and its handle drags it within 320 px and the centre's room", async ({
  page,
}) => {
  const { configurationId } = await seedSignedInWithConfiguration(page);
  await openEditor(page, configurationId, "receivers:");
  const monaco = page.locator(".monaco-editor");
  await expect.poll(() => panelWidth(page)).toBe(400);

  // The toolbox has its own Collapse panel.
  await panel(page).getByRole("button", { name: "Collapse panel" }).click();

  await expect.poll(() => panelWidth(page)).toBe(44);
  await expect(page.getByRole("tab", { name: "YAML" })).toBeHidden();
  await expect(monaco).toBeHidden();

  await panel(page).getByRole("button", { name: "Expand panel" }).click();

  await expect.poll(() => panelWidth(page)).toBe(400);
  await expect(monaco).toBeVisible();

  await panel(page).getByRole("button", { name: "Collapse panel" }).click();
  await expect.poll(() => panelWidth(page)).toBe(44);
  await panel(page).getByRole("button", { name: "YAML", exact: true }).click();

  await expect.poll(() => panelWidth(page)).toBe(400);
  await expect(page.getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
  await expect(monaco).toBeVisible();

  // The panel sits flush against the window's right edge, so its width is
  // the distance from the pointer to that edge, within its bounds.
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("the page has no viewport");
  const centreLeft = (await page.locator('[data-tour-step="canvas"]').boundingBox())?.x ?? 0;
  const dragHandleTo = async (x: number) => {
    const handle = await panel(page).locator(".cursor-col-resize").boundingBox();
    if (handle === null) throw new Error("the panel has no drag handle");
    const y = handle.y + handle.height / 2;
    await page.mouse.move(handle.x + handle.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 5 });
    await page.mouse.up();
  };

  // Within the room the toolbox leaves the centre at 1280 px.
  await dragHandleTo(viewport.width - 450);
  await expect.poll(() => panelWidth(page)).toBe(450);

  await dragHandleTo(viewport.width - 100);
  await expect.poll(() => panelWidth(page)).toBe(320);

  // Dragged all the way left: 800 px at most, and the centre keeps 320 px.
  await dragHandleTo(0);
  await expect.poll(() => panelWidth(page)).toBe(Math.min(800, viewport.width - centreLeft - 320));
});

test("while dirty, a sidebar link opens Unsaved Changes: Cancel stays, Discard Changes leaves unsaved, Save & Continue saves and leaves", async ({
  page,
}) => {
  const { configurationId } = await seedSignedInWithConfiguration(page);
  await openEditor(page, configurationId, "receivers:");
  const dialog = page.getByRole("alertdialog", { name: "Unsaved Changes" });
  const discarded = `# discarded ${randomUUID()}`;
  const kept = `# kept ${randomUUID()}`;

  await typeLineAtTop(page, discarded);
  await configurationsLink(page).click();
  await expect(dialog).toContainText("You have unsaved changes that will be lost. What would you like to do?");

  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(await versionAddress(configurationId));
  await expect(unsavedBadge(page)).toBeVisible();
  await expectShownFromTop(page, [discarded, "receivers:"]);

  await configurationsLink(page).click();
  await dialog.getByRole("button", { name: "Discard Changes" }).click();

  await expect(page).toHaveURL("/app");
  expect(await storedYaml(configurationId)).toBe(ORIGINAL_YAML);

  await openEditor(page, configurationId, "receivers:");
  await typeLineAtTop(page, kept);
  await configurationsLink(page).click();
  await dialog.getByRole("button", { name: "Save & Continue" }).click();

  await expect(page).toHaveURL("/app");
  expect(await storedYaml(configurationId)).toBe(`${kept}\n${ORIGINAL_YAML}`);
});

test("while dirty, switching organization and Logout each show their refusal and do nothing", async ({ page }) => {
  const { user, configurationId } = await seedSignedInWithConfiguration(page);
  const group = await addMember({ userId: user.userId });
  await openEditor(page, configurationId, "receivers:");
  await typeLineAtTop(page, `# edited ${randomUUID()}`);
  await expect(unsavedBadge(page)).toBeVisible();
  const switcher = page.getByTitle("Switch organization");
  const refusal = page.getByRole("dialog", { name: "Unsaved changes", exact: true });

  await switcher.click();
  await page.getByRole("dialog").getByRole("button", { name: group.organizationName }).click();

  await expect(refusal).toContainText("You have unsaved changes in the editor. Save them before switching organizations.");
  await refusal.getByRole("button", { name: "OK" }).click();
  await expect(refusal).toBeHidden();
  await expect(page).toHaveURL(await versionAddress(configurationId));
  await expect(switcher).toContainText(user.organizationName);
  await expect(unsavedBadge(page)).toBeVisible();

  await switcher.click();
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(refusal).toContainText("You have unsaved changes in the editor. Save them before signing out.");
  await refusal.getByRole("button", { name: "OK" }).click();
  await expect(refusal).toBeHidden();
  await expect(page).toHaveURL(await versionAddress(configurationId));
  await expect(unsavedBadge(page)).toBeVisible();

  // Neither reached the API: still signed in, in the personal organization.
  const me = await page.request.get("/api/v1/auth/me");
  expect(me.status()).toBe(200);
  expect(((await me.json()) as { organization: { id: string } }).organization.id).toBe(user.organizationId);
});

test("while dirty, leaving the page asks the browser's beforeunload question; once saved, it leaves without asking", async ({
  page,
  browserName,
}) => {
  const { configurationId } = await seedSignedInWithConfiguration(page);
  await openEditor(page, configurationId, "receivers:");
  await typeLineAtTop(page, `# edited ${randomUUID()}`);
  await expect(unsavedBadge(page)).toBeVisible();

  const asked = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const dialog: Dialog = await asked;

  expect(dialog.type()).toBe("beforeunload");
  // Stay on the page, with the text.
  await dialog.dismiss();
  await expect(unsavedBadge(page)).toBeVisible();
  expect(page.isClosed()).toBe(false);

  await saveButton(page).click();
  await expect(unsavedBadge(page)).toBeHidden();
  // Playwright's WebKit never finishes a close with runBeforeUnload that no
  // dialog answers: a clean /login page never closes, and with two pages open
  // it closes both. So only Chromium and Firefox show the clean page leaving.
  if (browserName === "webkit") return;
  const dialogs: string[] = [];
  page.on("dialog", (unexpected) => {
    dialogs.push(unexpected.type());
    void unexpected.accept();
  });
  const closed = page.waitForEvent("close");
  await page.close({ runBeforeUnload: true });
  await closed;
  expect(dialogs).toEqual([]);
});

test("a second member opens the first's published configuration and saves its draft version, and the first sees the change after a reload", async ({
  page,
  secondContext,
}) => {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: member.userId, organizationId: group.organizationId, role: "contributor" });
  // Published, so the member sees it (D11b decision 1); its version 1 can't
  // be changed (decision 4), so both open, and the member saves, the draft
  // version 2, the newest.
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: admin.userId,
    name: `Shared ${randomUUID()}`,
    yamlContent: ORIGINAL_YAML,
    published: true,
  });
  await seedConfigurationVersion({
    configurationId: configuration.id,
    organizationId: group.organizationId,
    createdByUserId: admin.userId,
    versionNumber: 2,
    yamlContent: ORIGINAL_YAML,
  });
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);
  await openEditor(page, configuration.id, "receivers:");

  const memberPage = await secondContext.newPage();
  await signInThroughApi(memberPage, member);
  await switchOrganizationThroughApi(memberPage, group.organizationId);
  await openEditor(memberPage, configuration.id, "receivers:");
  const edit = `# edited by the member ${randomUUID()}`;
  await typeLineAtTop(memberPage, edit);
  await saveButton(memberPage).click();
  await expect(unsavedBadge(memberPage)).toBeHidden();
  const [published, draft] = await findConfigurationVersions(configuration.id);
  expect([published?.yaml_content, draft?.yaml_content]).toEqual([ORIGINAL_YAML, `${edit}\n${ORIGINAL_YAML}`]);

  await page.reload();
  await waitForHydration(page);
  await openYamlTab(page);

  await expectShownFromTop(page, [edit, "receivers:"]);
});

test("an unknown configuration id shows Configuration not found, which links back to the list", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);

  await open(page, `/editor/${randomUUID()}`);

  await expect(page.getByText(NOT_FOUND_MESSAGE)).toBeVisible();
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await page.getByRole("link", { name: "Back to configurations" }).click();
  await expect(page).toHaveURL("/app");
});
