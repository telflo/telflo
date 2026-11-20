import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Locator, type Page, type Response } from "@playwright/test";
import {
  addMember,
  findConfigurations,
  seedConfiguration,
  seedUser,
  type SeededMembership,
  type SeededUser,
} from "./support/database.js";
import { versionAddress } from "./support/editor-page.js";
import { E2E_SAAS_WEB_URL, E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, switchOrganizationThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";

// The configurations page at /app, in the browser. Configurations the
// test isn't about creating are seeded by SQL (support/database.ts's
// seedConfiguration), and each test works in organizations of its own, so
// tests and browsers run in parallel. A second person is a second browser
// context, with their own cookie jar.
//
// The search goes to the API 300 ms after typing stops: the tests wait for
// that request or its result, never for the time itself.

const PASSWORD = "correct horse battery staple";
const EMPTY_MESSAGE = "No configurations yet.";
const NO_MATCH_MESSAGE = "Nothing matches your search or filter.";
/** The configurations list's path, whichever organization. */
const LIST_PATH = /^\/api\/v1\/organizations\/[^/]+\/configurations$/;

/**
 * `secondContext`: a second browser, for a second person, with its own
 * cookie jar. Closed when the test ends. In both browsers the editor's tour
 * is marked done (`skipEditorTour`): these tests aren't about it, and it
 * would cover the page on a first visit.
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

/** A full page load of `path`, hydrated. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

/** A reload of the page, hydrated. */
async function reload(page: Page): Promise<void> {
  await page.reload();
  await waitForHydration(page);
}

/** Every configuration card's name, in the grid's order. */
function cardNames(page: Page) {
  return page.locator('[role="button"] h3');
}

/** The card showing the configuration named `name`: a `div role="button"`. */
function card(page: Page, name: string) {
  return page.getByRole("button").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

function searchBox(page: Page) {
  return page.getByPlaceholder("Search configurations…");
}

/** The configurations list's response for the next list request whose query matches `matches`. */
function listResponse(page: Page, matches: (search: URLSearchParams) => boolean): Promise<Response> {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      LIST_PATH.test(url.pathname) &&
      matches(url.searchParams)
    );
  });
}

/**
 * Creates a configuration through the create dialog, opened by `opener`,
 * which then opens its editor.
 */
async function createThroughDialog(page: Page, opener: Locator, name: string, description: string): Promise<void> {
  await opener.click();
  // The start step first: a blank configuration.
  await page.getByRole("dialog", { name: "New configuration" }).getByRole("button", { name: /Blank configuration/ }).click();
  const dialog = page.getByRole("dialog", { name: "Name Your Configuration" });
  await dialog.getByLabel("Configuration Name").fill(name);
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden();
  // At the new configuration's version.
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

/** Back to the list from the sidebar, without a full page load. */
async function backToList(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Configurations", exact: true }).click();
  await expect(page).toHaveURL("/app");
}

/** Deletes the configuration named `name` from its card, through the confirmation dialog. */
async function deleteFromCard(page: Page, name: string): Promise<void> {
  const target = card(page, name);
  await target.hover();
  await target.getByRole("button", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Configuration" });
  await expect(dialog).toContainText(`Are you sure you want to delete "${name}"? This action cannot be undone.`);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * An admin and a contributor of one new group organization, the admin
 * signed in and already in it (still on whatever page is open).
 */
async function seedGroupWithMember(page: Page): Promise<{ admin: SeededUser; member: SeededUser; group: SeededMembership }> {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: member.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);
  return { admin, member, group };
}

test("a new account sees the empty state, creates one from it and one from the header, each opening its editor, and both are listed, newest first", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await open(page, "/app");

  const emptyState = page.getByText(EMPTY_MESSAGE);
  await expect(emptyState).toBeVisible();
  const first = `First ${randomUUID()}`;
  const second = `Second ${randomUUID()}`;

  // The empty state's own button, beside its message; the header's has an id.
  const emptyStateButton = emptyState.locator("..").getByRole("button", { name: "New configuration" });
  await createThroughDialog(page, emptyStateButton, first, "Made from the empty state");
  const [firstRow] = await findConfigurations(user.organizationId);
  expect(page.url()).toBe(`${E2E_WEB_URL}${await versionAddress(firstRow?.id ?? "")}`);
  await backToList(page);
  await expect(cardNames(page)).toHaveText([first]);

  await createThroughDialog(page, page.locator("#createNewConfigurationButton"), second, "Made from the header");
  const [secondRow] = await findConfigurations(user.organizationId);
  expect(page.url()).toBe(`${E2E_WEB_URL}${await versionAddress(secondRow?.id ?? "")}`);
  await backToList(page);

  await expect(cardNames(page)).toHaveText([second, first]);
  await expect(card(page, first)).toContainText("Made from the empty state");
  await expect(emptyState).toBeHidden();
  const rows = await findConfigurations(user.organizationId);
  expect(rows.map((row) => [row.name, row.created_by_user_id, row.deleted_at])).toEqual([
    [second, user.userId, null],
    [first, user.userId, null],
  ]);
});

test("search narrows the list to a match, or to nothing; Mine shows only the member's own", async ({ page }) => {
  const { admin, member, group } = await seedGroupWithMember(page);
  const own = `Production collectors ${randomUUID()}`;
  const others = `Staging gateway ${randomUUID()}`;
  const earlier = new Date(Date.now() - 1_000);
  await seedConfiguration({ organizationId: group.organizationId, createdByUserId: admin.userId, name: own, updatedAt: earlier });
  // Published: the admin sees no other member's draft.
  await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: member.userId,
    name: others,
    published: true,
  });
  await open(page, "/app");
  await expect(cardNames(page)).toHaveText([others, own]);
  // Others' cards name their creator; one's own doesn't.
  await expect(card(page, others)).toContainText(member.email);
  await expect(card(page, own)).not.toContainText(admin.email);

  await searchBox(page).fill("GATEWAY");
  await expect(cardNames(page)).toHaveText([others]);

  await searchBox(page).fill(`no such configuration ${randomUUID()}`);
  await expect(page.getByText(NO_MATCH_MESSAGE)).toBeVisible();
  await expect(cardNames(page)).toHaveCount(0);

  await searchBox(page).fill("");
  await expect(cardNames(page)).toHaveText([others, own]);

  // Mine asks the server for filter=mine.
  const mine = listResponse(page, (search) => search.get("filter") === "mine");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Mine" }).click();
  expect((await mine).status()).toBe(200);
  await expect(cardNames(page)).toHaveText([own]);
});

test("the search text goes to the API, never into the address bar", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  const secret = `Private ${randomUUID()}`;
  await seedConfiguration({ organizationId: user.organizationId, createdByUserId: user.userId, name: secret });
  await seedConfiguration({ organizationId: user.organizationId, createdByUserId: user.userId, name: `Other ${randomUUID()}` });
  await signInThroughApi(page, user);
  await open(page, "/app");
  await expect(cardNames(page)).toHaveCount(2);

  const searched = listResponse(page, (search) => search.get("q") === secret);
  await searchBox(page).fill(secret);
  expect((await searched).status()).toBe(200);
  await expect(cardNames(page)).toHaveText([secret]);

  expect(page.url()).toBe(`${E2E_WEB_URL}/app`);
  for (const fragment of [secret, encodeURIComponent(secret), secret.split(" ")[1] ?? secret]) {
    expect(page.url()).not.toContain(fragment);
  }
});

test("the toggle switches to the list, which stays after a reload", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  const name = `Listed ${randomUUID()}`;
  const { organizationId, userId } = user;
  await seedConfiguration({ organizationId, createdByUserId: userId, name, description: "Shown in a row" });
  await signInThroughApi(page, user);
  await open(page, "/app");
  await expect(cardNames(page)).toHaveText([name]);
  await expect(page.getByRole("table")).toBeHidden();

  await page.getByRole("button", { name: "List view" }).click();

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("Shown in a row");
  await expect(row).toContainText(`${user.email}(you)`);
  await expect(cardNames(page)).toHaveCount(0);

  await reload(page);

  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  await expect(cardNames(page)).toHaveCount(0);
});

test("deleting from a card removes it, still gone after a reload, and sets its row's deleted_at", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  const kept = `Kept ${randomUUID()}`;
  const deleted = `Deleted ${randomUUID()}`;
  const earlier = new Date(Date.now() - 1_000);
  await seedConfiguration({ organizationId: user.organizationId, createdByUserId: user.userId, name: kept, updatedAt: earlier });
  const target = await seedConfiguration({ organizationId: user.organizationId, createdByUserId: user.userId, name: deleted });
  await signInThroughApi(page, user);
  await open(page, "/app");
  await expect(cardNames(page)).toHaveText([deleted, kept]);

  await deleteFromCard(page, deleted);

  await expect(cardNames(page)).toHaveText([kept]);
  await reload(page);
  await expect(cardNames(page)).toHaveText([kept]);
  const row = (await findConfigurations(user.organizationId)).find((candidate) => candidate.id === target.id);
  expect(row?.deleted_at).toBeInstanceOf(Date);
});

test("a second member of the organization, an admin, sees the first's published configuration and deletes it", async ({
  page,
  secondContext,
}) => {
  // The first member, a contributor, publishes; the admin sees it and, as
  // an admin, may delete it. `page` is the admin's.
  const { member, group } = await seedGroupWithMember(page);
  const name = `Shared ${randomUUID()}`;
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: member.userId,
    name,
    published: true,
  });
  const memberPage = await secondContext.newPage();
  await signInThroughApi(memberPage, member);
  await switchOrganizationThroughApi(memberPage, group.organizationId);
  await open(memberPage, "/app");
  await expect(cardNames(memberPage)).toHaveText([name]);

  await open(page, "/app");
  await expect(card(page, name)).toContainText(member.email);

  await deleteFromCard(page, name);

  await expect(page.getByText(EMPTY_MESSAGE)).toBeVisible();
  const [row] = await findConfigurations(group.organizationId);
  expect(row?.id).toBe(configuration.id);
  expect(row?.deleted_at).toBeInstanceOf(Date);
  await reload(memberPage);
  await expect(memberPage.getByText(EMPTY_MESSAGE)).toBeVisible();
});

test("with 60 configurations, the first 50 show, and Load more brings the rest, then disappears", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  const run = randomUUID();
  // Configuration 01 is the newest, a second apart, so the order is the names'.
  const names = Array.from({ length: 60 }, (_, index) => `Configuration ${String(index + 1).padStart(2, "0")} ${run}`);
  const newest = Date.now();
  await Promise.all(
    names.map((name, index) =>
      seedConfiguration({
        organizationId: user.organizationId,
        createdByUserId: user.userId,
        name,
        updatedAt: new Date(newest - index * 1_000),
      }),
    ),
  );
  await signInThroughApi(page, user);
  await open(page, "/app");

  await expect(cardNames(page)).toHaveText(names.slice(0, 50));
  const loadMore = page.getByRole("button", { name: "Load more" });

  await loadMore.click();

  await expect(cardNames(page)).toHaveText(names);
  await expect(loadMore).toBeHidden();
});

test("switching organization shows the other organization's configurations", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  // Signed in before joining the group: the session starts in the personal organization.
  await signInThroughApi(page, user);
  const group = await addMember({ userId: user.userId });
  const personal = `Personal ${randomUUID()}`;
  const grouped = `Group ${randomUUID()}`;
  await seedConfiguration({ organizationId: user.organizationId, createdByUserId: user.userId, name: personal });
  await seedConfiguration({ organizationId: group.organizationId, createdByUserId: user.userId, name: grouped });
  await open(page, "/app");
  await expect(cardNames(page)).toHaveText([personal]);

  await page.getByTitle("Switch organization").click();
  await page.getByRole("dialog").getByRole("button", { name: group.organizationName }).click();

  await expect(page.getByTitle("Switch organization")).toContainText(group.organizationName);
  await expect(cardNames(page)).toHaveText([grouped]);
});

// The SaaS pair: the Terms asked.
test.describe("on the SaaS pair", () => {
  test.use({ baseURL: E2E_SAAS_WEB_URL });

  test("a user whose terms are out of date sees the terms dialog, and once they accept, the list loads", async ({ page }) => {
    const user = await seedUser({ password: PASSWORD, termsVersion: "2025-01-01" });
    const name = `Behind the terms ${randomUUID()}`;
    await seedConfiguration({ organizationId: user.organizationId, createdByUserId: user.userId, name });
    await signInThroughApi(page, user);
    const listRequests: string[] = [];
    page.on("request", (request) => {
      if (LIST_PATH.test(new URL(request.url()).pathname)) listRequests.push(request.url());
    });
    await open(page, "/app");

    const dialog = page.getByRole("dialog", { name: "Updated Terms of Service" });
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Loading configurations…")).toBeAttached();
    // The page doesn't ask for the list while the dialog is open.
    expect(listRequests).toEqual([]);

    const listed = listResponse(page, () => true);
    await dialog.getByLabel("I agree to the Terms of Service and Privacy Policy").check();
    await dialog.getByRole("button", { name: "Accept" }).click();

    await expect(dialog).toBeHidden();
    expect((await listed).status()).toBe(200);
    await expect(cardNames(page)).toHaveText([name]);
  });
});

test("clicking a card goes to /editor/{id}, which names its version", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  const name = `Opened ${randomUUID()}`;
  const configuration = await seedConfiguration({ organizationId: user.organizationId, createdByUserId: user.userId, name });
  await signInThroughApi(page, user);
  await open(page, "/app");

  await card(page, name).getByRole("heading", { name, exact: true }).click();

  // `/editor/{id}` replaces itself with the version's address.
  await expect(page).toHaveURL(await versionAddress(configuration.id));
  // The seeded version 1 opens with it.
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
});
