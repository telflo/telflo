import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { STARTER_CONFIGURATION_YAML } from "../apps/api/src/modules/configurations/starter-configuration.js";
import {
  addMember,
  findConfigurationVersions,
  findConfigurationVersionSelection,
  seedConfiguration,
  seedConfigurationVersion,
  seedUser,
  type SeededUser,
} from "./support/database.js";
import {
  expectShownFromTop,
  open,
  openYamlTab,
  saveButton,
  typeLineAtTop,
  undoButton,
  unsavedBadge,
  waitForCanvas,
} from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, skipEditorTour, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";
import {
  chooseVersion,
  createVersionFromPicker,
  openPicker,
  shownDate,
  versionList,
  versionPath,
  versionRow,
  versionTrigger,
} from "./support/versions-page.js";

// A configuration's versions in the editor, in the browser: the
// version in the address, the picker, creating and renaming a version,
// switching through the Unsaved Changes guard, and the selection each
// person's `/editor/{id}` opens. Configurations and their versions are seeded
// by SQL (support/database.ts), except those the picker creates. Each test
// works in organizations of its own, so tests and browsers run in parallel.
// Another browser, for the same person or another, is another context.

const PASSWORD = "correct horse battery staple";
const V1_YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";
const V2_YAML = "exporters:\n  debug: {}\n";

/**
 * `newContext`: another browser with its own cookie jar, the tour marked
 * done, closed when the test ends. In every browser the editor's tour is
 * marked done (`skipEditorTour`): these tests aren't about it, and it would
 * cover the page on a first visit.
 */
const test = base.extend<{ newContext: () => Promise<BrowserContext> }>({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
  newContext: async ({ browser }, use) => {
    const opened: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext({ baseURL: E2E_WEB_URL });
      await skipEditorTour(context);
      opened.push(context);
      return context;
    });
    for (const context of opened) await context.close();
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

interface Seeded {
  user: SeededUser;
  configurationId: string;
  name: string;
  /** The versions' ids, by number. */
  versionIds: Record<number, string>;
}

/**
 * A user signed in with a configuration of their personal organization: its
 * version 1 holding `v1Yaml`, and, with `v2Yaml`, a version 2 holding it.
 */
async function seedSignedIn(page: Page, { v1Yaml = V1_YAML, v2Yaml }: { v1Yaml?: string; v2Yaml?: string } = {}): Promise<Seeded> {
  const user = await seedUser({ password: PASSWORD });
  const name = `Versioned ${randomUUID()}`;
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name,
    yamlContent: v1Yaml,
  });
  const [first] = await findConfigurationVersions(configuration.id);
  const versionIds: Record<number, string> = { 1: first!.id };
  if (v2Yaml !== undefined) {
    const second = await seedConfigurationVersion({
      configurationId: configuration.id,
      organizationId: user.organizationId,
      createdByUserId: user.userId,
      versionNumber: 2,
      yamlContent: v2Yaml,
    });
    versionIds[2] = second.id;
  }
  await signInThroughApi(page, user);
  return { user, configurationId: configuration.id, name, versionIds };
}

/** Opens `path` in a full page load, opens the YAML tab, and waits for Monaco's first line. */
async function openAtYaml(page: Page, path: string, firstLine: string): Promise<void> {
  await open(page, path);
  await openYamlTab(page);
  await expectShownFromTop(page, [firstLine]);
}

/** The stored versions' YAML, by number. */
async function storedYamls(configurationId: string): Promise<Record<number, string>> {
  const versions = await findConfigurationVersions(configurationId);
  return Object.fromEntries(versions.map((version) => [version.version_number, version.yaml_content]));
}

/** Waits until the database holds `versionId` as the person's selection of the configuration. */
async function expectSelected(userId: string, configurationId: string, versionId: string): Promise<void> {
  await expect.poll(async () => (await findConfigurationVersionSelection(userId, configurationId))?.version_id).toBe(versionId);
}

test("from the list, a configuration opens at its version's address", async ({ page }) => {
  const { configurationId, name, versionIds } = await seedSignedIn(page);
  await open(page, "/app");

  await page
    .getByRole("button")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .getByRole("heading", { name, exact: true })
    .click();

  await expect(page).toHaveURL(versionPath(configurationId, versionIds[1]!));
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  await expect(versionTrigger(page)).toContainText("v1: Version 1");
});

test("Create New Version with a name: the picker shows v2 with the name, the creator's email and its date; the address is v2's; the database has both", async ({
  page,
}) => {
  const { user, configurationId, versionIds } = await seedSignedIn(page);
  await open(page, `/editor/${configurationId}`);
  await expect(page).toHaveURL(versionPath(configurationId, versionIds[1]!));
  const label = `Tail sampling ${randomUUID().slice(0, 8)}`;

  await createVersionFromPicker(page, label);

  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(2);
  const [first, second] = await findConfigurationVersions(configurationId);
  expect(first).toMatchObject({ id: versionIds[1], version_number: 1, label: null, yaml_content: V1_YAML });
  expect(second).toMatchObject({ version_number: 2, label, yaml_content: V1_YAML, created_by_user_id: user.userId });
  await expect(page).toHaveURL(versionPath(configurationId, second!.id));
  await expect(versionTrigger(page)).toContainText(`v2: ${label}`);
  await expect(unsavedBadge(page)).toBeHidden();

  await openPicker(page);
  await expect(versionList(page).getByRole("option")).toHaveCount(2);
  const row = versionRow(page, 2);
  await expect(row).toContainText(label);
  await expect(row).toContainText(`v2 · ${user.email} · ${await shownDate(page, second!.updated_at)}`);
  await expect(row).toHaveAttribute("data-state", "checked");
  // Highest first.
  await expect(versionList(page).getByRole("option").first()).toContainText(label);
  await expect(versionRow(page, 1)).toContainText("Version 1");
  await expect(versionRow(page, 1)).toContainText(`v1 · ${user.email} · ${await shownDate(page, first!.updated_at)}`);
  await page.keyboard.press("Escape");
  await expect(versionList(page)).toBeHidden();
});

test("a version created while dirty holds the unsaved text, and switching back to v1 shows v1's saved text", async ({ page }) => {
  const { configurationId, versionIds } = await seedSignedIn(page);
  await openAtYaml(page, versionPath(configurationId, versionIds[1]!), "receivers:");
  const typed = `# typed before the create ${randomUUID()}`;
  await typeLineAtTop(page, typed);
  await expect(unsavedBadge(page)).toBeVisible();

  await createVersionFromPicker(page);

  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(2);
  const [, created] = await findConfigurationVersions(configurationId);
  await expect(page).toHaveURL(versionPath(configurationId, created!.id));
  await expect(versionTrigger(page)).toContainText("v2: Version 2");
  await expectShownFromTop(page, [typed, "receivers:"]);
  // Its saved text is what was sent: clean.
  await expect(unsavedBadge(page)).toBeHidden();
  expect(await storedYamls(configurationId)).toEqual({ 1: V1_YAML, 2: `${typed}\n${V1_YAML}` });

  await chooseVersion(page, 1);

  await expect(page).toHaveURL(versionPath(configurationId, versionIds[1]!));
  await expect(versionTrigger(page)).toContainText("v1: Version 1");
  await expectShownFromTop(page, ["receivers:"]);
  await expect(unsavedBadge(page)).toBeHidden();
});

test("switching while dirty asks with Unsaved Changes: Cancel stays, Discard Changes switches, Save & Continue saves, then switches", async ({
  page,
}) => {
  // Every way out of Unsaved Changes, typing into Monaco twice: over 30 s on WebKit in CI.
  test.slow();
  const { configurationId, versionIds } = await seedSignedIn(page, { v2Yaml: V2_YAML });
  const v1 = versionPath(configurationId, versionIds[1]!);
  const v2 = versionPath(configurationId, versionIds[2]!);
  await openAtYaml(page, v1, "receivers:");
  const dialog = page.getByRole("alertdialog", { name: "Unsaved Changes" });
  const discarded = `# discarded ${randomUUID()}`;
  const kept = `# kept ${randomUUID()}`;

  await typeLineAtTop(page, discarded);
  await chooseVersion(page, 2);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(v1);
  await expect(unsavedBadge(page)).toBeVisible();
  await expectShownFromTop(page, [discarded, "receivers:"]);

  await chooseVersion(page, 2);
  await dialog.getByRole("button", { name: "Discard Changes" }).click();

  await expect(page).toHaveURL(v2);
  await expect(versionTrigger(page)).toContainText("v2: Version 2");
  await expectShownFromTop(page, ["exporters:"]);
  await expect(unsavedBadge(page)).toBeHidden();
  expect(await storedYamls(configurationId)).toEqual({ 1: V1_YAML, 2: V2_YAML });

  await chooseVersion(page, 1);
  await expect(page).toHaveURL(v1);
  await expectShownFromTop(page, ["receivers:"]);
  await typeLineAtTop(page, kept);
  await chooseVersion(page, 2);
  await dialog.getByRole("button", { name: "Save & Continue" }).click();

  await expect(page).toHaveURL(v2);
  await expectShownFromTop(page, ["exporters:"]);
  await expect(unsavedBadge(page)).toBeHidden();
  expect(await storedYamls(configurationId)).toEqual({ 1: `${kept}\n${V1_YAML}`, 2: V2_YAML });
});

test("renaming v2 while v1 is open shows the name in v2's row, leaves v1 open, and a reload keeps it", async ({ page }) => {
  const { configurationId, versionIds } = await seedSignedIn(page, { v2Yaml: V2_YAML });
  const v1 = versionPath(configurationId, versionIds[1]!);
  await open(page, v1);
  const label = `Baseline ${randomUUID().slice(0, 8)}`;

  // Another row's pencil than the open one's: choosing its row would open v2.
  await openPicker(page);
  await versionRow(page, 2).getByRole("button", { name: "Rename version" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename Version" });
  const field = dialog.getByLabel("Version name");
  // Focused when it opens, by the pointer too: `fill` would focus it regardless.
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Version 2");
  await field.fill(label);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Version renamed")).toBeVisible();
  // The focus is back on the trigger, not the page's body.
  await expect(versionTrigger(page)).toBeFocused();
  // The pencil chose nothing: v1 is still open, at its address.
  await expect(versionTrigger(page)).toContainText("v1: Version 1");
  await expect(page).toHaveURL(v1);
  await openPicker(page);
  await expect(versionRow(page, 2)).toContainText(label);
  await expect(versionRow(page, 1)).toContainText("Version 1");
  await expect(versionRow(page, 1)).toHaveAttribute("data-state", "checked");
  await page.keyboard.press("Escape");
  const [first, second] = await findConfigurationVersions(configurationId);
  expect([first?.label, second?.label]).toEqual([null, label]);

  await page.reload();
  await waitForHydration(page);

  await expect(versionTrigger(page)).toContainText("v1: Version 1");
  await openPicker(page);
  await expect(versionRow(page, 2)).toContainText(label);
});

test("/editor/{id} opens the version last selected, after a reload and in a second browser signed in as the same person; another member gets the newest", async ({
  page,
  newContext,
}) => {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: member.userId, organizationId: group.organizationId, role: "contributor" });
  // Published (its version 1), so the other member sees it.
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: admin.userId,
    name: `Shared ${randomUUID()}`,
    yamlContent: V1_YAML,
    published: true,
  });
  const [first] = await findConfigurationVersions(configuration.id);
  const second = await seedConfigurationVersion({
    configurationId: configuration.id,
    organizationId: group.organizationId,
    createdByUserId: admin.userId,
    versionNumber: 2,
    yamlContent: V2_YAML,
  });
  const latest = `/editor/${configuration.id}`;
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);

  // No selection yet: the newest, which becomes the selection.
  await open(page, latest);
  await expect(page).toHaveURL(versionPath(configuration.id, second.id));
  await expectSelected(admin.userId, configuration.id, second.id);
  await chooseVersion(page, 1);
  await expect(page).toHaveURL(versionPath(configuration.id, first!.id));
  await expectSelected(admin.userId, configuration.id, first!.id);

  await open(page, latest);
  await expect(page).toHaveURL(versionPath(configuration.id, first!.id));
  await expect(versionTrigger(page)).toContainText("v1: Version 1");

  const sameAdmin = await (await newContext()).newPage();
  await signInThroughApi(sameAdmin, admin);
  await switchOrganizationThroughApi(sameAdmin, group.organizationId);
  await open(sameAdmin, latest);
  await expect(sameAdmin).toHaveURL(versionPath(configuration.id, first!.id));
  await expect(versionTrigger(sameAdmin)).toContainText("v1: Version 1");

  const memberPage = await (await newContext()).newPage();
  await signInThroughApi(memberPage, member);
  await switchOrganizationThroughApi(memberPage, group.organizationId);
  await open(memberPage, latest);
  await expect(memberPage).toHaveURL(versionPath(configuration.id, second.id));
  await expect(versionTrigger(memberPage)).toContainText("v2: Version 2");
  await expectSelected(member.userId, configuration.id, second.id);
  // The member's selection is theirs: the admin's is still v1.
  expect((await findConfigurationVersionSelection(admin.userId, configuration.id))?.version_id).toBe(first!.id);
});

test('an unknown version\'s address shows "Version not found", and "Open the latest version" opens one', async ({ page }) => {
  const { configurationId, name, versionIds } = await seedSignedIn(page, { v2Yaml: V2_YAML });

  await open(page, versionPath(configurationId, randomUUID()));

  await expect(page.getByText("Version not found")).toBeVisible();
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to configurations" })).toHaveAttribute("href", "/app");
  await page.getByRole("link", { name: "Open the latest version" }).click();

  await expect(page).toHaveURL(versionPath(configurationId, versionIds[2]!));
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  await expect(versionTrigger(page)).toContainText("v2: Version 2");
});

test("after a switch, Undo has nothing to undo", async ({ page }) => {
  const { configurationId, versionIds } = await seedSignedIn(page, {
    v1Yaml: STARTER_CONFIGURATION_YAML,
    v2Yaml: STARTER_CONFIGURATION_YAML,
  });
  await open(page, versionPath(configurationId, versionIds[1]!));
  await waitForCanvas(page);
  await expect(undoButton(page)).toBeDisabled();

  await page.getByRole("button", { name: "Add pipeline" }).click();
  const addPipeline = page.getByRole("dialog", { name: "Add New Pipeline" });
  await addPipeline.getByLabel("Pipeline Name").fill("traces/extra");
  await addPipeline.getByRole("button", { name: "Create Pipeline" }).click();
  await expect(addPipeline).toBeHidden();
  await expect(undoButton(page)).toBeEnabled();
  // Saved, so the switch isn't held, with the history still there to lose.
  await saveButton(page).click();
  await expect(unsavedBadge(page)).toBeHidden();
  await expect(undoButton(page)).toBeEnabled();

  await chooseVersion(page, 2);

  await expect(page).toHaveURL(versionPath(configurationId, versionIds[2]!));
  await expect(versionTrigger(page)).toContainText("v2: Version 2");
  await waitForCanvas(page);
  await expect(undoButton(page)).toBeDisabled();
  expect(await storedYamls(configurationId)).toEqual({
    1: `${STARTER_CONFIGURATION_YAML}    traces/extra:\n`,
    2: STARTER_CONFIGURATION_YAML,
  });
});

test("by keyboard alone, a row's pencil renames its version and Create New Version creates one", async ({ page }) => {
  const { configurationId, versionIds } = await seedSignedIn(page, { v2Yaml: V2_YAML });
  const v1 = versionPath(configurationId, versionIds[1]!);
  await open(page, v1);
  const renamed = `Keyboard ${randomUUID().slice(0, 8)}`;
  const created = `Created by keyboard ${randomUUID().slice(0, 8)}`;
  const trigger = versionTrigger(page);
  // v2's pencil, while v1 is open: Enter on it must not choose its row.
  const pencil = versionRow(page, 2).getByRole("button", { name: "Rename version" });
  const create = versionList(page).getByRole("button", { name: "Create New Version" });

  await trigger.focus();
  await page.keyboard.press("Enter");
  // The open row has focus; up is v2's row; Tab goes to its pencil, then to Create New Version, and Shift+Tab back.
  await expect(versionRow(page, 1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(versionRow(page, 2)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(pencil).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(create).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(pencil).toBeFocused();
  await page.keyboard.press("Enter");

  const rename = page.getByRole("dialog", { name: "Rename Version" });
  const field = rename.getByLabel("Version name");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Version 2");
  // A native field follows the machine's keys, not the user agent's (Monaco's).
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(renamed);
  await expect(field).toHaveValue(renamed);
  await page.keyboard.press("Enter");
  await expect(rename).toBeHidden();
  // The focus is back on the trigger, where the keyboard goes on from.
  await expect(trigger).toBeFocused();
  // The pencil chose nothing: v1 is still open, at its address, and v2's row has the name.
  await expect(trigger).toContainText("v1: Version 1");
  await expect(page).toHaveURL(v1);

  await page.keyboard.press("Enter");
  await expect(versionRow(page, 2)).toContainText(renamed);
  await expect(versionRow(page, 1)).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");

  const copy = page.getByRole("dialog", { name: "Copy Version" });
  await expect(copy.getByLabel("Version name (optional)")).toBeFocused();
  await page.keyboard.type(created);
  await page.keyboard.press("Enter");
  await expect(copy).toBeHidden();

  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(3);
  const versions = await findConfigurationVersions(configurationId);
  expect(versions.map((version) => [version.version_number, version.label])).toEqual([
    [1, null],
    [2, renamed],
    [3, created],
  ]);
  await expect(page).toHaveURL(versionPath(configurationId, versions[2]!.id));
  await expect(trigger).toContainText(`v3: ${created}`);
  await expect(trigger).toBeFocused();
});
