import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { STARTER_CONFIGURATION_YAML } from "../apps/api/src/modules/configurations/starter-configuration.js";
import {
  addMember,
  findConfigurations,
  findConfigurationVersions,
  seedConfiguration,
  seedConfigurationVersion,
  seedUser,
  type SeededMembership,
  type SeededUser,
} from "./support/database.js";
import {
  editorText,
  expectShownFromTop,
  open,
  openYamlTab,
  saveButton,
  tab,
  typeLineAtTop,
  unsavedBadge,
  waitForCanvas,
} from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { collectorOf, fakeSnapshots } from "./support/fake-opamp-server.js";
import { signInThroughApi, skipEditorTour, switchOrganizationThroughApi } from "./support/session.js";
import { openPicker, versionList, versionPath, versionRow, versionTrigger } from "./support/versions-page.js";

// Publishing, in the browser: the editor's Publish and its dialog, saving
// first; the published version locked, its banner and the new version it
// makes; the picker's lock; the list's badges and filter; what a teammate
// sees and may delete; a tab that didn't see a publish; and a clean tab that
// didn't see a teammate's save. The API is the E2E API and the opamp-server
// the OpenAPI-checked fake (start-fake-opamp-server.ts), whose snapshots are
// read back through its own management API (fakeSnapshots). Configurations
// are seeded by SQL (support/database.ts); one the fake must hold a snapshot
// of is published through the API or the editor, never seeded as published.
// Each test works in organizations of its own, so tests and browsers run in
// parallel; another person, or the same person in another browser, is
// another context.
//
// The words are written out here: the browser tests don't import the web
// app's modules.

const PASSWORD = "correct horse battery staple";
const V1_YAML = "receivers:\n  otlp:\n    protocols:\n      grpc: {}\n";
const V2_YAML = "exporters:\n  debug: {}\n";
const STARTER_FIRST_LINE = STARTER_CONFIGURATION_YAML.split("\n")[0]!;

const PUBLISH_TOOLTIP = "Publish this version so fleets can deploy it.";
const ALREADY_PUBLISHED_TOOLTIP = "Already published";
const EMPTY_VERSION_MESSAGE = "An empty version can't be published.";
const SAVED_FIRST_MESSAGE = "Your unsaved changes will be saved first.";
const PUBLISHED_MESSAGE = "Configuration published successfully";
const CREATE_FROM_PUBLISHED = "Create a new version from it";
const IMMUTABLE_LABEL = "Published versions are immutable";
const publishDialogMessage = (number: number) =>
  `This will publish version ${number}, making it available to your organization members and fleet management.`;
const alreadyPublishedMessage = (number: number) => `Version ${number} is already published.`;
const PUBLISH_CHANGED_MESSAGE = "This version changed while it was being published. Try again.";
const publishedVersionMessage = (number: number) => `Version ${number} is published and can't be changed.`;

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

// ── The page ───────────────────────────────────────────────────────────────

/** The toolbar's Publish. */
function publishButton(page: Page): Locator {
  return page.getByRole("button", { name: "Publish", exact: true }).and(page.locator("[title]"));
}

function publishDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Publish Configuration" });
}

/** The banner's sentence over a published version (a toast can say the same: this is the banner's). */
function bannerText(page: Page, versionNumber: number): Locator {
  return page.locator("p").filter({ hasText: publishedVersionMessage(versionNumber) });
}

function createFromPublishedButton(page: Page): Locator {
  return page.getByRole("button", { name: CREATE_FROM_PUBLISHED, exact: true });
}

/** The toasts holding `message`. */
function toastWith(page: Page, message: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: message });
}

/** Publishes the open version from the toolbar, through the dialog, which says what it should. */
async function publishThroughDialog(page: Page, versionNumber: number, { dirty }: { dirty: boolean }): Promise<void> {
  await expect(publishButton(page)).toBeEnabled();
  await expect(publishButton(page)).toHaveAttribute("title", PUBLISH_TOOLTIP);
  await publishButton(page).click();
  const dialog = publishDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(publishDialogMessage(versionNumber));
  if (dirty) await expect(dialog).toContainText(SAVED_FIRST_MESSAGE);
  else await expect(dialog).not.toContainText(SAVED_FIRST_MESSAGE);
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The editor shows version `versionNumber` locked: the banner, Save and Publish off. */
async function expectLocked(page: Page, versionNumber: number): Promise<void> {
  await expect(bannerText(page, versionNumber)).toBeVisible();
  await expect(createFromPublishedButton(page)).toBeEnabled();
  await expect(saveButton(page)).toBeDisabled();
  await expect(publishButton(page)).toBeDisabled();
  await expect(publishButton(page)).toHaveAttribute("title", ALREADY_PUBLISHED_TOOLTIP);
}

/** The canvas node of `type` whose card reads `label` exactly: the first, where a component is drawn in several pipelines. */
function componentNode(page: Page, type: string, label: string): Locator {
  return page
    .locator(`.react-flow__node-${type}`)
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
}

/** Every configuration card's name, in the grid's order. */
function cardNames(page: Page): Locator {
  return page.locator('[role="button"] h3');
}

/** The card showing the configuration named `name`: a `div role="button"`. */
function card(page: Page, name: string): Locator {
  return page.getByRole("button").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

/** Chooses a filter from the list's one combobox. */
async function chooseFilter(page: Page, filter: "All configurations" | "Mine" | "Published"): Promise<void> {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: filter, exact: true }).click();
}

// ── Seeding ────────────────────────────────────────────────────────────────

interface SeededDraft {
  user: SeededUser;
  configurationId: string;
  versionId: string;
}

/** A user signed in with a draft configuration of their personal organization, its version 1 holding `yamlContent`. */
async function seedSignedInDraft(page: Page, yamlContent = V1_YAML): Promise<SeededDraft> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Gateway collectors ${randomUUID()}`,
    yamlContent,
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, user);
  return { user, configurationId: configuration.id, versionId: version!.id };
}

/** An admin and two contributors of one new group organization; nobody signed in. */
async function seedGroup(): Promise<{
  admin: SeededUser;
  author: SeededUser;
  teammate: SeededUser;
  group: SeededMembership;
}> {
  const admin = await seedUser({ password: PASSWORD });
  const author = await seedUser({ password: PASSWORD });
  const teammate = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: author.userId, organizationId: group.organizationId, role: "contributor" });
  await addMember({ userId: teammate.userId, organizationId: group.organizationId, role: "contributor" });
  return { admin, author, teammate, group };
}

/** `user` signed in on `page` and active in the organization. */
async function signedInto(page: Page, user: SeededUser, organizationId: string): Promise<void> {
  await signInThroughApi(page, user);
  await switchOrganizationThroughApi(page, organizationId);
}

/** Publishes a version through the E2E API as the page's session, for tests about something else. */
async function publishThroughApi(page: Page, organizationId: string, configurationId: string, versionId: string): Promise<void> {
  const response = await page.request.post(
    `/api/v1/organizations/${organizationId}/configurations/${configurationId}/versions/${versionId}/publish`,
    { headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } },
  );
  expect(response.status()).toBe(200);
}

// ── The tests ──────────────────────────────────────────────────────────────

test("publishing a saved version: the dialog's words, the toast, the editor locked, and exactly one snapshot of the saved text in the opamp-server", async ({
  page,
}) => {
  const { user, configurationId, versionId } = await seedSignedInDraft(page);
  await open(page, versionPath(configurationId, versionId));
  await openYamlTab(page);
  await expectShownFromTop(page, ["receivers:"]);
  await expect(unsavedBadge(page)).toBeHidden();

  // Cancel publishes nothing.
  await publishButton(page).click();
  await publishDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(publishDialog(page)).toBeHidden();
  await expect(publishButton(page)).toBeEnabled();

  await publishThroughDialog(page, 1, { dirty: false });

  await expect(toastWith(page, PUBLISHED_MESSAGE)).toBeVisible();
  await expectLocked(page, 1);
  await expect(versionTrigger(page)).toContainText("v1: Version 1");
  const [version] = await findConfigurationVersions(configurationId);
  expect(version).toMatchObject({ id: versionId, yaml_content: V1_YAML, published_by_user_id: user.userId });
  expect(version!.published_at).toBeInstanceOf(Date);
  expect(await fakeSnapshots(user.organizationId, configurationId)).toEqual([
    { publicationId: version!.publication_id, versionId, versionNumber: 1, yaml: V1_YAML, collector: collectorOf(version!) },
  ]);

  // Monaco takes no typing: the text and the editor stay as they were.
  await typeLineAtTop(page, "# typed into a published version");
  await expectShownFromTop(page, ["receivers:"]);
  await expect(unsavedBadge(page)).toBeHidden();
  expect(await editorText(page)).toBe(V1_YAML);
});

test("publishing with unsaved changes says they'll be saved first, then saves and publishes exactly the typed text", async ({
  page,
}) => {
  const { user, configurationId, versionId } = await seedSignedInDraft(page);
  await open(page, versionPath(configurationId, versionId));
  await openYamlTab(page);
  await expectShownFromTop(page, ["receivers:"]);
  const typed = `# typed before publishing ${randomUUID()}`;
  await typeLineAtTop(page, typed);
  await expect(unsavedBadge(page)).toBeVisible();

  await publishThroughDialog(page, 1, { dirty: true });

  await expect(toastWith(page, PUBLISHED_MESSAGE)).toBeVisible();
  await expect(unsavedBadge(page)).toBeHidden();
  await expectLocked(page, 1);
  await expectShownFromTop(page, [typed, "receivers:"]);
  const expected = `${typed}\n${V1_YAML}`;
  const [version] = await findConfigurationVersions(configurationId);
  expect(version).toMatchObject({ yaml_content: expected });
  expect(version!.publication_id).not.toBeNull();
  expect(await fakeSnapshots(user.organizationId, configurationId)).toEqual([
    { publicationId: version!.publication_id, versionId, versionNumber: 1, yaml: expected, collector: collectorOf(version!) },
  ]);
});

test("a published version is locked: Monaco takes no typing, a node still opens its form disabled, and the banner's button opens a new, editable version carrying its text", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Locked ${randomUUID()}`,
    yamlContent: STARTER_CONFIGURATION_YAML,
    published: true,
  });
  const [published] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, user);
  await open(page, versionPath(configuration.id, published!.id));
  await waitForCanvas(page);
  await expectLocked(page, 1);

  // Inspection still works: a node is selected, and its form shows, disabled.
  await componentNode(page, "receiver", "OTLP").click();
  await tab(page, "Configuration").click();
  await expect(page.getByRole("heading", { level: 3, name: "OTLP", exact: true })).toBeVisible();
  const endpoint = page.locator("#grpc-endpoint");
  await expect(endpoint).toHaveValue("0.0.0.0:4317");
  await expect(endpoint).toBeDisabled();

  await openYamlTab(page);
  await expectShownFromTop(page, [STARTER_FIRST_LINE]);
  await typeLineAtTop(page, "# typed into a published version");
  await expectShownFromTop(page, [STARTER_FIRST_LINE]);
  await expect(unsavedBadge(page)).toBeHidden();
  expect(await editorText(page)).toBe(STARTER_CONFIGURATION_YAML);

  await createFromPublishedButton(page).click();

  await expect.poll(async () => (await findConfigurationVersions(configuration.id)).length).toBe(2);
  const [first, second] = await findConfigurationVersions(configuration.id);
  expect(second).toMatchObject({
    version_number: 2,
    label: null,
    yaml_content: STARTER_CONFIGURATION_YAML,
    published_at: null,
    publication_id: null,
  });
  // The published version is as it was.
  expect(first).toEqual(published);
  await expect(page).toHaveURL(versionPath(configuration.id, second!.id));
  await expect(versionTrigger(page)).toContainText("v2: Version 2");
  await expect(bannerText(page, 2)).toHaveCount(0);
  await expect(page.locator("p").filter({ hasText: "is published and can't be changed." })).toHaveCount(0);
  await expect(publishButton(page)).toBeEnabled();

  await openYamlTab(page);
  const typed = `# typed into the new version ${randomUUID()}`;
  await typeLineAtTop(page, typed);
  await expectShownFromTop(page, [typed, STARTER_FIRST_LINE]);
  await expect(unsavedBadge(page)).toBeVisible();
  await expect(saveButton(page)).toBeEnabled();
});

test("the picker shows a lock instead of the pencil on a published version's row, and says Published", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Picked ${randomUUID()}`,
    yamlContent: V1_YAML,
    published: true,
  });
  const draft = await seedConfigurationVersion({
    configurationId: configuration.id,
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    versionNumber: 2,
    yamlContent: V2_YAML,
  });
  await signInThroughApi(page, user);
  await open(page, versionPath(configuration.id, draft.id));
  await expect(versionTrigger(page)).toContainText("v2: Version 2");

  await openPicker(page);

  const published = versionRow(page, 1);
  await expect(published.getByRole("img", { name: IMMUTABLE_LABEL, exact: true })).toHaveAttribute("title", IMMUTABLE_LABEL);
  await expect(published.getByRole("button", { name: "Rename version" })).toHaveCount(0);
  await expect(published.getByText("Published", { exact: true })).toBeVisible();
  const editable = versionRow(page, 2);
  await expect(editable.getByRole("button", { name: "Rename version" })).toBeVisible();
  await expect(editable.getByRole("img", { name: IMMUTABLE_LABEL })).toHaveCount(0);
  await expect(editable.getByText("Published", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(versionList(page)).toBeHidden();
});

test("the list shows Published and Draft on cards and in the Status column, and its three filters each show theirs", async ({
  page,
}) => {
  const { admin, author: teammate, group } = await seedGroup();
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000);
  const seed = (createdByUserId: string, name: string, secondsAgo: number, published: boolean) =>
    seedConfiguration({ organizationId: group.organizationId, createdByUserId, name, updatedAt: at(secondsAgo), published });
  const ownDraft = `Alpha ${randomUUID()}`;
  const ownPublished = `Bravo ${randomUUID()}`;
  const teammatesPublished = `Charlie ${randomUUID()}`;
  const teammatesDraft = `Delta ${randomUUID()}`;
  await seed(admin.userId, ownDraft, 4, false);
  await seed(admin.userId, ownPublished, 3, true);
  await seed(teammate.userId, teammatesPublished, 2, true);
  await seed(teammate.userId, teammatesDraft, 1, false);
  await signedInto(page, admin, group.organizationId);
  await open(page, "/app");

  // Newest first; the teammate's draft is nobody else's to see.
  await expect(cardNames(page)).toHaveText([teammatesPublished, ownPublished, ownDraft]);
  for (const [name, status] of [
    [teammatesPublished, "Published"],
    [ownPublished, "Published"],
    [ownDraft, "Draft"],
  ] as const) {
    await expect(card(page, name).getByText(status, { exact: true })).toBeVisible();
    await expect(card(page, name).getByText(status === "Published" ? "Draft" : "Published", { exact: true })).toHaveCount(0);
  }

  await chooseFilter(page, "Mine");
  await expect(cardNames(page)).toHaveText([ownPublished, ownDraft]);
  await chooseFilter(page, "Published");
  await expect(cardNames(page)).toHaveText([teammatesPublished, ownPublished]);
  await chooseFilter(page, "All configurations");
  await expect(cardNames(page)).toHaveText([teammatesPublished, ownPublished, ownDraft]);
  await expect(page.getByText(teammatesDraft)).toHaveCount(0);

  await page.getByRole("button", { name: "List view" }).click();

  await expect(page.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
  const row = (name: string) => page.getByRole("row").filter({ hasText: name });
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(row(teammatesPublished).getByText("Published", { exact: true })).toBeVisible();
  await expect(row(ownPublished).getByText("Published", { exact: true })).toBeVisible();
  await expect(row(ownDraft).getByText("Draft", { exact: true })).toBeVisible();
  await chooseFilter(page, "Published");
  await expect(row(ownDraft)).toHaveCount(0);
  await expect(row(ownPublished)).toBeVisible();
  await expect(row(teammatesPublished)).toBeVisible();
});

test("a teammate doesn't see the author's draft, sees and opens the published one but can't delete it; an admin deletes it, and the opamp-server then holds none of its snapshots", async ({
  page,
  newContext,
}) => {
  const { admin, author, teammate, group } = await seedGroup();
  const draftName = `Private draft ${randomUUID()}`;
  const publishedName = `Shared ${randomUUID()}`;
  const draft = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    name: draftName,
    yamlContent: V1_YAML,
  });
  const shared = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    name: publishedName,
    yamlContent: V1_YAML,
    updatedAt: new Date(Date.now() - 1_000),
  });
  const [first] = await findConfigurationVersions(shared.id);
  // The author publishes version 1, then a version 2: two snapshots.
  await signedInto(page, author, group.organizationId);
  await publishThroughApi(page, group.organizationId, shared.id, first!.id);
  const second = await seedConfigurationVersion({
    configurationId: shared.id,
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    versionNumber: 2,
    yamlContent: V2_YAML,
  });
  await publishThroughApi(page, group.organizationId, shared.id, second.id);
  expect((await fakeSnapshots(group.organizationId, shared.id)).map((snapshot) => snapshot.versionNumber).sort()).toEqual([1, 2]);

  const teammatePage = await (await newContext()).newPage();
  await signedInto(teammatePage, teammate, group.organizationId);
  await open(teammatePage, "/app");
  await expect(cardNames(teammatePage)).toHaveText([publishedName]);
  await expect(card(teammatePage, publishedName).getByText("Published", { exact: true })).toBeVisible();
  await expect(card(teammatePage, publishedName)).toContainText(author.email);
  await card(teammatePage, publishedName).hover();
  await expect(card(teammatePage, publishedName).getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

  // The draft's address answers as if it didn't exist.
  await open(teammatePage, `/editor/${draft.id}`);
  await expect(teammatePage.getByText("Configuration not found")).toBeVisible();
  await expect(teammatePage.locator(".monaco-editor")).toHaveCount(0);

  // The published one opens, at its newest version, locked.
  await open(teammatePage, "/app");
  await card(teammatePage, publishedName).getByRole("heading", { name: publishedName, exact: true }).click();
  await expect(teammatePage).toHaveURL(versionPath(shared.id, second.id));
  await expect(teammatePage.getByRole("heading", { level: 1, name: publishedName, exact: true })).toBeVisible();
  await expectLocked(teammatePage, 2);

  const adminPage = await (await newContext()).newPage();
  await signedInto(adminPage, admin, group.organizationId);
  await open(adminPage, "/app");
  await expect(cardNames(adminPage)).toHaveText([publishedName]);
  const target = card(adminPage, publishedName);
  await target.hover();
  await target.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = adminPage.getByRole("dialog", { name: "Delete Configuration" });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(cardNames(adminPage)).toHaveCount(0);
  const row = (await findConfigurations(group.organizationId)).find((candidate) => candidate.id === shared.id);
  expect(row?.deleted_at).toBeInstanceOf(Date);
  // The clean-up runs after the response.
  await expect.poll(async () => (await fakeSnapshots(group.organizationId, shared.id)).length).toBe(0);
  // The draft is untouched, and still the author's alone.
  expect((await findConfigurations(group.organizationId)).find((candidate) => candidate.id === draft.id)?.deleted_at).toBeNull();
});

test("a tab that didn't see the publish: its Publish says the version is already published, its Save that it can't be changed, and both lock it, the unsaved text kept for a new version", async ({
  page,
  context,
}) => {
  // Three tabs, each opening the editor, then a publish, a refused publish, a
  // refused save and a create: 22–29 s on CI's WebKit, and once 31.6 s, past
  // the 30 s per-test limit at its last step. Slow triples the limit, a hang
  // guard; every wait inside keeps its own bound.
  test.slow();
  const { user, configurationId, versionId } = await seedSignedInDraft(page);
  const path = versionPath(configurationId, versionId);
  const publishingTab = page;
  const publishTab = await context.newPage();
  const saveTab = await context.newPage();
  for (const tabPage of [publishingTab, publishTab, saveTab]) {
    await open(tabPage, path);
    await openYamlTab(tabPage);
    await expectShownFromTop(tabPage, ["receivers:"]);
  }
  const typed = `# typed in a tab that didn't see the publish ${randomUUID()}`;
  await typeLineAtTop(saveTab, typed);
  await expect(unsavedBadge(saveTab)).toBeVisible();

  await publishThroughDialog(publishingTab, 1, { dirty: false });
  await expect(toastWith(publishingTab, PUBLISHED_MESSAGE)).toBeVisible();
  await expectLocked(publishingTab, 1);

  // Publish from the tab that still shows a draft.
  await publishThroughDialog(publishTab, 1, { dirty: false });
  await expect(toastWith(publishTab, alreadyPublishedMessage(1))).toBeVisible();
  await expectLocked(publishTab, 1);

  // Save from the tab with unsaved text: refused, locked, the text kept.
  await saveButton(saveTab).click();
  await expect(toastWith(saveTab, publishedVersionMessage(1))).toBeVisible();
  await expectLocked(saveTab, 1);
  await expectShownFromTop(saveTab, [typed, "receivers:"]);

  // One publish, of the saved text: the refused ones put nothing.
  const [version] = await findConfigurationVersions(configurationId);
  expect(version!.yaml_content).toBe(V1_YAML);
  expect(await fakeSnapshots(user.organizationId, configurationId)).toEqual([
    { publicationId: version!.publication_id, versionId, versionNumber: 1, yaml: V1_YAML, collector: collectorOf(version!) },
  ]);

  // Nothing typed is lost: the new version carries it.
  await createFromPublishedButton(saveTab).click();
  await expect.poll(async () => (await findConfigurationVersions(configurationId)).length).toBe(2);
  const [, created] = await findConfigurationVersions(configurationId);
  expect(created).toMatchObject({ version_number: 2, yaml_content: `${typed}\n${V1_YAML}`, published_at: null });
  await expect(saveTab).toHaveURL(versionPath(configurationId, created!.id));
  await expect(bannerText(saveTab, 1)).toHaveCount(0);
});

test("a new configuration's empty version can't be published while its text is empty; text typed over it is saved first, then published", async ({
  page,
}) => {
  const { user, configurationId, versionId } = await seedSignedInDraft(page, "");
  await open(page, versionPath(configurationId, versionId));
  await openYamlTab(page);
  await expect(page.locator(".monaco-editor")).toBeVisible();

  await expect(publishButton(page)).toBeDisabled();
  await expect(publishButton(page)).toHaveAttribute("title", EMPTY_VERSION_MESSAGE);

  // Typed but unsaved: Publish saves it first.
  const typed = `# a first line ${randomUUID()}`;
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type(typed);
  await expect(unsavedBadge(page)).toBeVisible();

  await publishThroughDialog(page, 1, { dirty: true });

  await expect(toastWith(page, PUBLISHED_MESSAGE)).toBeVisible();
  await expect(unsavedBadge(page)).toBeHidden();
  await expectLocked(page, 1);
  const [version] = await findConfigurationVersions(configurationId);
  expect(version).toMatchObject({ yaml_content: typed });
  expect(await fakeSnapshots(user.organizationId, configurationId)).toEqual([
    { publicationId: version!.publication_id, versionId, versionNumber: 1, yaml: typed, collector: collectorOf(version!) },
  ]);
});

test("a clean tab that didn't see a teammate's save: its Publish is refused, the editor shows the newer text, nothing is published, and Publish again publishes it", async ({
  page,
  newContext,
}) => {
  const { author, teammate, group } = await seedGroup();
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    name: `Shared drafts ${randomUUID()}`,
    yamlContent: V1_YAML,
    published: true,
  });
  const draft = await seedConfigurationVersion({
    configurationId: configuration.id,
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    versionNumber: 2,
    yamlContent: V2_YAML,
  });
  const path = versionPath(configuration.id, draft.id);
  const authorPage = page;
  await signedInto(authorPage, author, group.organizationId);
  const teammatePage = await (await newContext()).newPage();
  await signedInto(teammatePage, teammate, group.organizationId);
  for (const tabPage of [authorPage, teammatePage]) {
    await open(tabPage, path);
    await openYamlTab(tabPage);
    await expectShownFromTop(tabPage, ["exporters:"]);
  }

  // The teammate saves v2 (a published configuration's drafts are shared).
  const typed = `# the teammate's save ${randomUUID()}`;
  await typeLineAtTop(teammatePage, typed);
  await saveButton(teammatePage).click();
  await expect(unsavedBadge(teammatePage)).toBeHidden();
  const saved = `${typed}\n${V2_YAML}`;
  await expect.poll(async () => (await findConfigurationVersions(configuration.id))[1]?.yaml_content).toBe(saved);

  // The author's tab is clean and still shows the text it loaded.
  await expect(unsavedBadge(authorPage)).toBeHidden();
  await expectShownFromTop(authorPage, ["exporters:"]);
  await publishThroughDialog(authorPage, 2, { dirty: false });

  await expect(toastWith(authorPage, PUBLISH_CHANGED_MESSAGE)).toBeVisible();
  await expectShownFromTop(authorPage, [typed, "exporters:"]);
  await expect(unsavedBadge(authorPage)).toBeHidden();
  await expect(bannerText(authorPage, 2)).toHaveCount(0);
  await expect(versionTrigger(authorPage)).toContainText("v2: Version 2");
  await expect(authorPage).toHaveURL(path);
  const [, refused] = await findConfigurationVersions(configuration.id);
  expect(refused).toMatchObject({ id: draft.id, yaml_content: saved, published_at: null, publication_id: null });
  expect(await fakeSnapshots(group.organizationId, configuration.id)).toEqual([]);

  // Now the tab has seen it: Publish again publishes the teammate's save.
  await publishThroughDialog(authorPage, 2, { dirty: false });
  await expect(toastWith(authorPage, PUBLISHED_MESSAGE)).toBeVisible();
  await expectLocked(authorPage, 2);
  const [, published] = await findConfigurationVersions(configuration.id);
  expect(published).toMatchObject({ yaml_content: saved, published_by_user_id: author.userId });
  expect(await fakeSnapshots(group.organizationId, configuration.id)).toEqual([
    { publicationId: published!.publication_id, versionId: draft.id, versionNumber: 2, yaml: saved, collector: collectorOf(published!) },
  ]);
});
