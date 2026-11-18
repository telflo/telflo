import { randomUUID } from "node:crypto";
import { expect, test as base, type Page, type Response } from "@playwright/test";
import { seedConfiguration, seedUser, type SeededUser } from "./support/database.js";
import { expectShownFromTop, goToLine, open, openYamlTab, platformKeys, shownLines } from "./support/editor-page.js";
import { navigateToSearch, savePreferencesThroughApi, signInThroughApi, skipEditorTour } from "./support/session.js";

// The editor preferences (D21 decisions 6, 28 and 31): set in Settings ›
// Editor, they reach every open Monaco without a reload. Monaco is read from
// the DOM (Preflight ruling 39): the font size from the drawn lines' computed
// style, the minimap from its width, and the tab size by pressing Tab, since
// the width a Tab inserts is the model's (Preflight rulings 30 and 31: the
// model's tabSize and indentSize are set explicitly; the text's own
// indentation never decides them).
//
// The preference is changed in a SECOND tab while the editor's tab stays open;
// the editor's tab then navigates to its own address with a search, which
// revalidates the signed-in layout as any navigation does, and the same
// `.monaco-editor` element is still there (Preflight ruling 51).

const PASSWORD = "correct horse battery staple";
const PREFERENCES_PATH = "/api/v1/auth/me/preferences";
/** Indented by 2, as the YAML generator writes: Monaco would detect 2 from it. */
const ORIGINAL_YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";

const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

function isPreferencesWrite(response: Response): boolean {
  return response.request().method() === "PATCH" && new URL(response.url()).pathname === PREFERENCES_PATH;
}

async function seededEditor(user: SeededUser): Promise<string> {
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Preferences ${randomUUID()}`,
    yamlContent: ORIGINAL_YAML,
  });
  return configuration.id;
}

/** Opens the editor's YAML tab and keeps its Monaco element in the page, to compare later. */
async function openYamlEditor(page: Page, configurationId: string): Promise<void> {
  await open(page, `/editor/${configurationId}`);
  await openYamlTab(page);
  await expectShownFromTop(page, ["receivers:"]);
  await page.evaluate(`window.__e2eMonaco = document.querySelector(".monaco-editor")`);
}

async function expectSameMonaco(page: Page): Promise<void> {
  expect(
    await page.evaluate<boolean>(
      `window.__e2eMonaco.isConnected && window.__e2eMonaco === document.querySelector(".monaco-editor")`,
    ),
  ).toBe(true);
}

function fontSize(page: Page): Promise<string> {
  return page.evaluate<string>(`getComputedStyle(document.querySelector(".monaco-editor .view-lines")).fontSize`);
}

function minimapWidth(page: Page): Promise<number> {
  return page.evaluate<number>(
    `(() => { const minimap = document.querySelector(".monaco-editor .minimap"); return minimap === null ? 0 : minimap.getBoundingClientRect().width; })()`,
  );
}

/** Presses Tab at the start of the first line and answers what the line became; undoes it. */
async function firstLineAfterTab(page: Page): Promise<string> {
  await goToLine(page, 1);
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await expect.poll(async () => (await shownLines(page))[0]).not.toBe("receivers:");
  const line = (await shownLines(page))[0] ?? "";
  await page.keyboard.press((await platformKeys(page)).undo);
  await expectShownFromTop(page, ["receivers:"]);
  return line;
}

/** Chooses `option` in Settings › Editor's Select named `name`, and waits for its save. */
async function choose(page: Page, name: "YAML Indentation" | "Font Size", option: string): Promise<void> {
  const saved = page.waitForResponse(isPreferencesWrite);
  await page.getByRole("combobox", { name }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("combobox", { name })).toHaveText(option);
}

test("4 spaces and 15px chosen in Settings in another tab reach the open YAML editor, the same Monaco", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const configurationId = await seededEditor(user);

  // The defaults (contracts): 13px, and Tab inserts 2.
  await openYamlEditor(page, configurationId);
  expect(await fontSize(page)).toBe("13px");
  expect(await firstLineAfterTab(page)).toBe("  receivers:");

  const settings = await context.newPage();
  await open(settings, "/settings/editor");
  await choose(settings, "YAML Indentation", "4 spaces");
  await choose(settings, "Font Size", "15px");

  await navigateToSearch(page, "?preferences-check=1");
  await expect.poll(() => fontSize(page)).toBe("15px");
  expect(await firstLineAfterTab(page)).toBe("    receivers:");
  await expectSameMonaco(page);
});

test("with 4 spaces stored, turning the minimap on and changing the font size leaves Tab at 4 (no re-detection from the text)", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await savePreferencesThroughApi(page, { editor: { tabSize: 4 } });
  const configurationId = await seededEditor(user);

  await openYamlEditor(page, configurationId);
  expect(await minimapWidth(page)).toBe(0);
  expect(await firstLineAfterTab(page)).toBe("    receivers:");

  // Other options change on the open editor: the minimap (off by default) and the font size.
  const settings = await context.newPage();
  await open(settings, "/settings/editor");
  const saved = settings.waitForResponse(isPreferencesWrite);
  await settings.getByRole("switch", { name: "Show Minimap" }).click();
  expect((await saved).status()).toBe(200);
  await choose(settings, "Font Size", "16px");

  await navigateToSearch(page, "?preferences-check=1");
  await expect.poll(() => minimapWidth(page)).toBeGreaterThan(0);
  await expect.poll(() => fontSize(page)).toBe("16px");
  await expectSameMonaco(page);
  // The text is indented by 2, yet Tab still inserts the preference's 4.
  expect(await firstLineAfterTab(page)).toBe("    receivers:");
});
