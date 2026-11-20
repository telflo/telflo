import { randomUUID } from "node:crypto";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import {
  findCollectorVersions,
  findConfigurations,
  findConfigurationVersions,
  findDefaultCollectorDistribution,
  seedConfiguration,
  seedUser,
  type SeededUser,
} from "./support/database.js";
import {
  expectShownFromTop,
  open,
  openYamlTab,
  saveButton,
  typeLineAtTop,
  unsavedBadge,
} from "./support/editor-page.js";
import { fakeSnapshots } from "./support/fake-opamp-server.js";
import { signInThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";
import { createVersionFromPicker, versionPath, versionTrigger } from "./support/versions-page.js";

// Collector versions and distributions, in the browser: the create dialog's
// Distribution dropdown; the list's distribution tag on the cards and in the
// Distribution column; the toolbar's locked distribution and its collector
// version picker, whose pick is an unsaved change Save stores; the picker
// read-only on a published version; a new version carrying the pin on screen
// (an unsaved pick included), and the published version's banner carrying
// the published pin; publishing sending the pin to the opamp-server (the
// OpenAPI-checked fake, read back through fakeSnapshots); the pin following
// whoever last picked it across two tabs; and the toolbar fitting beside the
// expanded sidebar at 1280 px, nothing over its neighbour.
//
// The catalogue is the one the sync wrote into telflo_platform_e2e_test from
// catalog/, read here (support/database.ts), never written: its tables are
// global, so a fixture row would be every test's, and a row the files don't
// list would make the next run's sync refuse to start the E2E API. A
// deprecated pin's picker is covered by the web's component tests
// (CollectorVersionSelect.test.tsx); validation.e2e.ts opens a version pinned
// to the catalogue's first deprecated row, found by query. The versions a test
// picks are the catalogue's, by position (the default, and an older offered
// one), never a hard-coded release.
//
// Configurations are seeded by SQL; each test works in an organization of
// its own, so tests and browsers run in parallel. The words are written
// out here: the browser tests don't import the web app's modules.

const PASSWORD = "correct horse battery staple";
const V1_YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";

const DISTRIBUTION_SHORT_LABEL = "Otel Contrib";
const DISTRIBUTION_LOCK_LABEL = `Distribution: ${DISTRIBUTION_SHORT_LABEL} (locked at creation)`;
const DISTRIBUTION_LOCKED_TOOLTIP = "Set when this configuration was created.";
const DISTRIBUTION_LOCK_NOTE =
  "Which collector build this configuration is for. This is locked once the configuration is created.";
const tagTooltip = (label: string) => `Built for ${label} — chosen when this configuration was created.`;
const PUBLISHED_MESSAGE = "Configuration published successfully";
const SAVED_MESSAGE = "Saved configuration";
const CREATE_FROM_PUBLISHED = "Create a new version from it";
const publishedVersionMessage = (versionNumber: number) => `Version ${versionNumber} is published and can't be changed.`;

/**
 * In every browser the editor's tour is marked done (`skipEditorTour`):
 * these tests aren't about it, and it would cover the page on a first visit.
 */
const test = base.extend({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

// ── The catalogue ──────────────────────────────────────────────────────────

interface Catalogue {
  distribution: string;
  /** The distribution's label, as the pickers' lists and the tag's tooltip say it. */
  label: string;
  /** The distribution's default version: a new configuration's version 1 pin. */
  defaultVersion: string;
  /** An offered version older than the default, newest first: what a test picks. */
  older: string[];
}

/** The default distribution and its offered versions, as the sync wrote them. */
async function readCatalogue(): Promise<Catalogue> {
  const distribution = await findDefaultCollectorDistribution();
  const versions = await findCollectorVersions(distribution.id);
  const defaultVersion = versions.find((version) => version.is_default)!.version;
  const older = versions.filter((version) => !version.deprecated && !version.is_default).map((version) => version.version);
  // A test picks two versions other than the default, so the catalogue must offer at least three.
  expect(older.length).toBeGreaterThanOrEqual(2);
  return { distribution: distribution.id, label: distribution.label, defaultVersion, older };
}

// ── The page ───────────────────────────────────────────────────────────────

/** The toolbar's collector version picker, named "Collector version" and the version it shows. */
function collectorVersionPicker(page: Page): Locator {
  return page.getByRole("combobox", { name: /^Collector version / });
}

/** The toolbar's locked distribution. */
function lockedDistribution(page: Page): Locator {
  return page.getByLabel(DISTRIBUTION_LOCK_LABEL, { exact: true });
}

/** Picks `version` from the toolbar's collector version picker. */
async function pickCollectorVersion(page: Page, version: string): Promise<void> {
  await collectorVersionPicker(page).click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await list.getByRole("option", { name: `v${version}` }).click();
  await expect(list).toBeHidden();
}

/** The picker shows `version` (and nothing else after it, as a deprecated pin would). */
async function expectPickerShows(page: Page, version: string): Promise<void> {
  await expect(collectorVersionPicker(page)).toHaveAccessibleName(`Collector version v${version}`);
}

/** The toolbar's distribution: its compact name, its lock, and the tooltip it says on focus. */
async function expectDistributionLocked(page: Page): Promise<void> {
  const distribution = lockedDistribution(page);
  await expect(distribution).toBeVisible();
  await expect(distribution).toHaveText(DISTRIBUTION_SHORT_LABEL);
  await expect(distribution.locator("svg.lucide-lock")).toBeVisible();
  await distribution.focus();
  await expect(page.getByRole("tooltip")).toHaveText(DISTRIBUTION_LOCKED_TOOLTIP);
}

/** The toolbar's Publish. */
function publishButton(page: Page): Locator {
  return page.getByRole("button", { name: "Publish", exact: true }).and(page.locator("[title]"));
}

/** A toast saying `text`. */
function toastWith(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

/** Publishes the open version through the toolbar's Publish and its dialog, and waits for the toast. */
async function publishThroughDialog(page: Page): Promise<void> {
  await publishButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Publish Configuration" });
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(toastWith(page, PUBLISHED_MESSAGE)).toBeVisible();
}

/** The card showing the configuration named `name`: a `div role="button"`. */
function card(page: Page, name: string): Locator {
  return page.getByRole("button").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

/** A distribution tag: its compact name, in an element whose title is the tag's tooltip. */
function distributionTag(scope: Locator): Locator {
  return scope.locator("[title]").filter({ hasText: DISTRIBUTION_SHORT_LABEL });
}

// ── Seeding ────────────────────────────────────────────────────────────────

/** A user signed in with a draft configuration of their personal organization, version 1 pinned to `collectorVersion` (default: the catalogue's default). */
async function seedSignedInDraft(
  page: Page,
  { collectorVersion, published = false }: { collectorVersion?: string; published?: boolean } = {},
): Promise<{ user: SeededUser; configurationId: string; versionId: string }> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Collectors ${randomUUID()}`,
    yamlContent: V1_YAML,
    published,
    ...(collectorVersion === undefined ? {} : { collectorVersion }),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, user);
  return { user, configurationId: configuration.id, versionId: version!.id };
}

// ── The tests ──────────────────────────────────────────────────────────────

test("creating a configuration: the dialog's Distribution shows Contrib, preselected, with its lock note; it is created on Contrib at the default version; the list shows its tag on the card and in the Distribution column", async ({
  page,
}) => {
  const catalogue = await readCatalogue();
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await open(page, "/app");

  await page.locator("#createNewConfigurationButton").click();
  // The start step first: a blank configuration.
  await page.getByRole("dialog", { name: "New configuration" }).getByRole("button", { name: /Blank configuration/ }).click();
  const dialog = page.getByRole("dialog", { name: "Name Your Configuration" });
  const distribution = dialog.getByRole("combobox", { name: "Distribution", exact: true });
  await expect(distribution).toHaveText(DISTRIBUTION_SHORT_LABEL);
  await expect(distribution).toHaveAccessibleDescription(DISTRIBUTION_LOCK_NOTE);
  await distribution.click();
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options).toHaveCount(1);
  const contrib = options.filter({ hasText: catalogue.label });
  await expect(contrib).toHaveAttribute("aria-selected", "true");
  await expect(contrib).toContainText("Default");
  await contrib.click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(distribution).toHaveText(DISTRIBUTION_SHORT_LABEL);

  const name = `Contrib collectors ${randomUUID()}`;
  await dialog.getByLabel("Configuration Name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();

  const [created] = await findConfigurations(user.organizationId);
  expect(created).toMatchObject({ name, collector_distribution: catalogue.distribution });
  const [version] = await findConfigurationVersions(created!.id);
  expect(version).toMatchObject({ collector_distribution: catalogue.distribution, collector_version: catalogue.defaultVersion });
  await expectDistributionLocked(page);
  await expectPickerShows(page, catalogue.defaultVersion);
  await expect(collectorVersionPicker(page)).toBeEnabled();

  // The list: the tag on the card, after its status, with its fixed tooltip.
  await page.getByRole("link", { name: "Configurations", exact: true }).click();
  await expect(page).toHaveURL("/app");
  await expect(distributionTag(card(page, name))).toHaveAttribute("title", tagTooltip(catalogue.label));

  // And in the table's Distribution column.
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("columnheader", { name: "Distribution", exact: true })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(distributionTag(row)).toHaveAttribute("title", tagTooltip(catalogue.label));
});

test("switching a draft's collector version: the pick is unsaved until Save stores it with the text, and a reload keeps it", async ({
  page,
}) => {
  const catalogue = await readCatalogue();
  const picked = catalogue.older[0]!;
  const { configurationId, versionId } = await seedSignedInDraft(page);
  await open(page, versionPath(configurationId, versionId));
  await expectPickerShows(page, catalogue.defaultVersion);
  await expect(unsavedBadge(page)).toBeHidden();

  await pickCollectorVersion(page, picked);

  await expectPickerShows(page, picked);
  await expect(unsavedBadge(page)).toBeVisible();
  // On screen only: the database still holds the saved pin.
  expect((await findConfigurationVersions(configurationId))[0]).toMatchObject({ collector_version: catalogue.defaultVersion });

  await saveButton(page).click();
  await expect(unsavedBadge(page)).toBeHidden();
  await expect
    .poll(async () => (await findConfigurationVersions(configurationId))[0]?.collector_version)
    .toBe(picked);
  expect((await findConfigurationVersions(configurationId))[0]).toMatchObject({ yaml_content: V1_YAML, published_at: null });

  await page.reload();
  await waitForHydration(page);
  await expectPickerShows(page, picked);
  await expect(unsavedBadge(page)).toBeHidden();
  await expect(collectorVersionPicker(page)).toBeEnabled();
});

test("a published version's collector version picker is read-only, showing its pin, and its distribution shows its lock", async ({
  page,
}) => {
  const catalogue = await readCatalogue();
  const pin = catalogue.older[0]!;
  const { configurationId, versionId } = await seedSignedInDraft(page, { collectorVersion: pin, published: true });
  await open(page, versionPath(configurationId, versionId));
  await expect(page.getByRole("button", { name: CREATE_FROM_PUBLISHED, exact: true })).toBeVisible();

  await expectPickerShows(page, pin);
  await expect(collectorVersionPicker(page)).toBeDisabled();
  await expectDistributionLocked(page);
  // A click opens nothing.
  await collectorVersionPicker(page).click({ force: true });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(unsavedBadge(page)).toBeHidden();
  expect((await findConfigurationVersions(configurationId))[0]).toMatchObject({ collector_version: pin });
});

test("Create New Version carries the pin on screen: a clean version's saved pin, then an unsaved pick with the unsaved text, and the source keeps its own", async ({
  page,
}) => {
  const catalogue = await readCatalogue();
  const [saved, picked] = [catalogue.older[0]!, catalogue.older[1]!];
  const { configurationId, versionId } = await seedSignedInDraft(page, { collectorVersion: saved });
  await open(page, versionPath(configurationId, versionId));
  await expectPickerShows(page, saved);

  // A clean version: the new one has its saved pin.
  await createVersionFromPicker(page);
  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(2);
  const [, second] = await findConfigurationVersions(configurationId);
  expect(second).toMatchObject({ version_number: 2, collector_version: saved, yaml_content: V1_YAML });
  await expect(page).toHaveURL(versionPath(configurationId, second!.id));
  await expect(versionTrigger(page)).toContainText("v2: Version 2");
  await expectPickerShows(page, saved);

  // An unsaved pick and unsaved text: the new version has both, and v2 neither.
  await pickCollectorVersion(page, picked);
  await openYamlTab(page);
  await expectShownFromTop(page, ["receivers:"]);
  const typed = `# typed before the create ${randomUUID()}`;
  await typeLineAtTop(page, typed);
  await expect(unsavedBadge(page)).toBeVisible();

  await createVersionFromPicker(page);

  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(3);
  const [first, unchanged, third] = await findConfigurationVersions(configurationId);
  expect(third).toMatchObject({ version_number: 3, collector_version: picked, yaml_content: `${typed}\n${V1_YAML}` });
  expect(unchanged).toMatchObject({ id: second!.id, collector_version: saved, yaml_content: V1_YAML });
  expect(first).toMatchObject({ id: versionId, collector_version: saved, yaml_content: V1_YAML });
  await expect(page).toHaveURL(versionPath(configurationId, third!.id));
  await expect(versionTrigger(page)).toContainText("v3: Version 3");
  await expectPickerShows(page, picked);
  // Its saved pin is what was sent: clean.
  await expect(unsavedBadge(page)).toBeHidden();
});

test("the published version's banner's \"Create a new version from it\" carries the published pin into an editable version", async ({
  page,
}) => {
  const catalogue = await readCatalogue();
  const pin = catalogue.older[1]!;
  const { configurationId, versionId } = await seedSignedInDraft(page, { collectorVersion: pin, published: true });
  await open(page, versionPath(configurationId, versionId));
  await expectPickerShows(page, pin);
  await expect(collectorVersionPicker(page)).toBeDisabled();

  await page.getByRole("button", { name: CREATE_FROM_PUBLISHED, exact: true }).click();

  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(2);
  const [published, created] = await findConfigurationVersions(configurationId);
  expect(created).toMatchObject({ version_number: 2, collector_version: pin, yaml_content: V1_YAML, published_at: null });
  expect(published).toMatchObject({ id: versionId, collector_version: pin });
  await expect(page).toHaveURL(versionPath(configurationId, created!.id));
  await expect(versionTrigger(page)).toContainText("v2: Version 2");
  await expectPickerShows(page, pin);
  await expect(collectorVersionPicker(page)).toBeEnabled();
  await expect(unsavedBadge(page)).toBeHidden();
});

test("publishing sends the pin: an unsaved pick is saved first, and the opamp-server's publication holds the configuration's distribution and that version", async ({
  page,
}) => {
  const catalogue = await readCatalogue();
  const picked = catalogue.older[0]!;
  const { user, configurationId, versionId } = await seedSignedInDraft(page);
  await open(page, versionPath(configurationId, versionId));
  await expectPickerShows(page, catalogue.defaultVersion);

  await pickCollectorVersion(page, picked);
  await expect(unsavedBadge(page)).toBeVisible();

  await expect(publishButton(page)).toBeEnabled();
  await publishButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Publish Configuration" });
  await expect(dialog).toContainText("Your unsaved changes will be saved first.");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: PUBLISHED_MESSAGE })).toBeVisible();

  await expect(unsavedBadge(page)).toBeHidden();
  await expectPickerShows(page, picked);
  await expect(collectorVersionPicker(page)).toBeDisabled();
  const [version] = await findConfigurationVersions(configurationId);
  expect(version).toMatchObject({ collector_distribution: catalogue.distribution, collector_version: picked, yaml_content: V1_YAML });
  expect(version!.publication_id).not.toBeNull();
  expect(await fakeSnapshots(user.organizationId, configurationId)).toEqual([
    {
      publicationId: version!.publication_id,
      versionId,
      versionNumber: 1,
      yaml: V1_YAML,
      collector: { distribution: catalogue.distribution, version: picked },
    },
  ]);
});

// ── The pin follows whoever last picked it ─────────────────────────────────

test("a tab that never touched the picker saves its text after a teammate picked and saved another version: no pin is sent, the teammate's stays, and the tab then shows it, clean", async ({
  page,
  context,
}) => {
  const catalogue = await readCatalogue();
  const [loaded, teammates] = [catalogue.older[0]!, catalogue.older[1]!];
  const { configurationId, versionId } = await seedSignedInDraft(page, { collectorVersion: loaded });
  const path = versionPath(configurationId, versionId);
  const ana = page;
  const ben = await context.newPage();
  for (const tab of [ana, ben]) {
    await open(tab, path);
    await expectPickerShows(tab, loaded);
  }

  // Ben picks another version and saves it.
  await pickCollectorVersion(ben, teammates);
  await saveButton(ben).click();
  await expect(unsavedBadge(ben)).toBeHidden();
  await expect.poll(async () => (await findConfigurationVersions(configurationId))[0]?.collector_version).toBe(teammates);

  // Ana, who never saw it and never touched her picker, types and saves.
  await openYamlTab(ana);
  await expectShownFromTop(ana, ["receivers:"]);
  const typed = `# typed by a tab that never picked ${randomUUID()}`;
  await typeLineAtTop(ana, typed);
  await expectPickerShows(ana, loaded);
  await saveButton(ana).click();
  await expect(toastWith(ana, SAVED_MESSAGE)).toBeVisible();

  // Her text, Ben's pin: and her picker follows it, clean.
  expect((await findConfigurationVersions(configurationId))[0]).toMatchObject({
    yaml_content: `${typed}\n${V1_YAML}`,
    collector_version: teammates,
  });
  await expectPickerShows(ana, teammates);
  await expect(unsavedBadge(ana)).toBeHidden();
});

test("a tab with typed text and no pick, refused because a teammate picked another version and published: it shows the published pin, and the banner's create carries it with the text", async ({
  page,
  context,
}) => {
  const catalogue = await readCatalogue();
  const published = catalogue.older[0]!;
  const { configurationId, versionId } = await seedSignedInDraft(page);
  const path = versionPath(configurationId, versionId);
  const ana = page;
  const ben = await context.newPage();
  for (const tab of [ana, ben]) {
    await open(tab, path);
    await expectPickerShows(tab, catalogue.defaultVersion);
  }
  await openYamlTab(ana);
  await expectShownFromTop(ana, ["receivers:"]);
  const typed = `# typed before the teammate published ${randomUUID()}`;
  await typeLineAtTop(ana, typed);
  await expect(unsavedBadge(ana)).toBeVisible();

  // Ben picks, saves and publishes.
  await pickCollectorVersion(ben, published);
  await saveButton(ben).click();
  await expect(unsavedBadge(ben)).toBeHidden();
  await publishThroughDialog(ben);

  // Ana's save is refused; her editor locks, showing the published pin, her text kept.
  await saveButton(ana).click();
  await expect(toastWith(ana, publishedVersionMessage(1))).toBeVisible();
  await expectPickerShows(ana, published);
  await expect(collectorVersionPicker(ana)).toBeDisabled();
  await expectShownFromTop(ana, [typed, "receivers:"]);

  // The banner's create carries her text and the published pin.
  await ana.getByRole("button", { name: CREATE_FROM_PUBLISHED, exact: true }).click();
  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(2);
  const [first, created] = await findConfigurationVersions(configurationId);
  expect(first).toMatchObject({ id: versionId, collector_version: published, yaml_content: V1_YAML });
  expect(created).toMatchObject({ version_number: 2, collector_version: published, yaml_content: `${typed}\n${V1_YAML}` });
  await expect(ana).toHaveURL(versionPath(configurationId, created!.id));
  await expectPickerShows(ana, published);
  await expect(collectorVersionPicker(ana)).toBeEnabled();
});

// ── The toolbar fits ───────────────────────────────────────────────────────

interface ToolbarMeasure {
  mainLeft: number;
  mainRight: number;
  mainScrollWidth: number;
  mainClientWidth: number;
  save: { left: number; right: number };
  publish: { left: number; right: number };
  nameTruncated: boolean;
}

/** Where the toolbar's Save and Publish lie, and whether the editor's `main` scrolls sideways. */
function measureToolbar(page: Page): Promise<ToolbarMeasure> {
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  return page.evaluate<ToolbarMeasure>(`(() => {
    const main = document.querySelector("main");
    const buttons = [...document.querySelectorAll("button")];
    const sides = (text) => {
      const box = buttons.find((button) => button.textContent.trim() === text).getBoundingClientRect();
      return { left: box.left, right: box.right };
    };
    const box = main.getBoundingClientRect();
    const name = document.querySelector("h1#configuration_name");
    return {
      mainLeft: box.left,
      mainRight: box.right,
      mainScrollWidth: main.scrollWidth,
      mainClientWidth: main.clientWidth,
      save: sides("Save"),
      publish: sides("Publish"),
      nameTruncated: name.scrollWidth > name.clientWidth,
    };
  })()`);
}

/** Save and Publish lie inside `main`, which doesn't scroll sideways. */
async function expectToolbarFits(page: Page): Promise<void> {
  const shown = await measureToolbar(page);
  expect(shown.mainScrollWidth).toBeLessThanOrEqual(shown.mainClientWidth);
  for (const button of [shown.save, shown.publish]) {
    expect(button.left).toBeGreaterThanOrEqual(shown.mainLeft);
    expect(button.right).toBeLessThanOrEqual(shown.mainRight);
  }
}

/** Where `locator` starts and ends across the page. */
async function sidesOf(locator: Locator): Promise<{ left: number; right: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { left: box!.x, right: box!.x + box!.width };
}

/**
 * Nothing in the toolbar lies over its neighbour: the collector
 * version picker ends before the version picker starts, and the Unsaved
 * badge, while the editor is dirty, before the locked distribution.
 */
async function expectNoOverlap(page: Page, { dirty }: { dirty: boolean }): Promise<void> {
  expect((await sidesOf(collectorVersionPicker(page))).right).toBeLessThanOrEqual(
    (await sidesOf(versionTrigger(page))).left,
  );
  if (dirty) {
    expect((await sidesOf(unsavedBadge(page))).right).toBeLessThanOrEqual((await sidesOf(lockedDistribution(page))).left);
  }
}

for (const width of [1280, 1440]) {
  test(`at ${width}×800 beside the expanded sidebar, with a 47-character name, the toolbar fits clean and with a pick: Save and Publish inside the page, nothing scrolling sideways, nothing overlapping`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const catalogue = await readCatalogue();
    const user = await seedUser({ password: PASSWORD });
    const name = `Production monitoring ${randomUUID()}`.slice(0, 47);
    expect(name).toHaveLength(47);
    const configuration = await seedConfiguration({
      organizationId: user.organizationId,
      createdByUserId: user.userId,
      name,
      yamlContent: V1_YAML,
    });
    const [version] = await findConfigurationVersions(configuration.id);
    await signInThroughApi(page, user);
    await open(page, versionPath(configuration.id, version!.id));
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expectPickerShows(page, catalogue.defaultVersion);

    // Clean: the whole name is the heading's, though the row shows it cut short.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(saveButton(page)).toBeVisible();
    await expect(publishButton(page)).toBeVisible();
    await expectToolbarFits(page);
    await expectNoOverlap(page, { dirty: false });
    // "Collector:" gives way below the widest screens; the picker keeps its name.
    await expect(page.getByText("Collector:", { exact: true })).toBeHidden();

    // With a pick: the Unsaved badge too.
    await pickCollectorVersion(page, catalogue.older[0]!);
    await expect(unsavedBadge(page)).toBeVisible();
    await expect(saveButton(page)).toBeEnabled();
    await expectToolbarFits(page);
    await expectNoOverlap(page, { dirty: true });
    expect((await measureToolbar(page)).nameTruncated).toBe(true);
    // "Version:" gives way too, still the version picker's name, which narrows to 10 rem.
    await expect(versionTrigger(page)).toHaveAccessibleName(/^Version: v1: /);
    expect(Math.round((await sidesOf(versionTrigger(page))).right - (await sidesOf(versionTrigger(page))).left)).toBe(160);
  });
}
