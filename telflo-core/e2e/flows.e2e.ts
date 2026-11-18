import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { loadFlowsMigration } from "@telflo/db/testing";
import {
  deleteTestFlows,
  E2E_FLOW_SLUG_PREFIX,
  findCollectorVersions,
  findConfigurations,
  findDefaultCollectorDistribution,
  findFlow,
  grantProductAdmin,
  insertTestFlow,
  revokeProductAdmin,
  seedUser,
  type SeededUser,
} from "./support/database.js";
import { editorText, open, storedVersion, versionAddress } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";
import { createVariableThroughApi, uniqueVariableName } from "./support/variables.js";

// Flows (D12), in the browser, signed in: "Use this flow" from a flow's
// page in the product and "Start from a flow" in the create dialog, each
// opening the editor on a copy holding the flow's text byte for byte and its
// pin; and product admin's flows page (create, edit, hide and show, delete,
// the security check), with its gate for everyone else. And the edges (D12
// Ruling 36): a copy of a flow whose pin the catalogue retired moves to the
// default and says so (decision 16); a hidden flow's page is a 404 for a
// non-admin; and a product admin whose flag is cleared mid-visit. The
// public library and the landing's showcase left with the marketing site
// (D36-1 decision 20).
//
// The seeded flows are global setup's (migration 1700000000026's rows, put
// back after the truncation), read here from the migration's constant and
// never written. A test that writes flows gives each an `e2e-` slug, asserts
// only on its own, never on a count, and deletes them as the tables' owner
// when it ends, however it ends (D12 Preflight ruling 13): the flows table is
// global, so every parallel test sees what another wrote.
//
// The words are the web app's, written out here.

const PASSWORD = "correct horse battery staple";

/** The seeded flow on the one pin that isn't the catalogue's default (0.159.0), so a copy on the default would show. */
const OFF_DEFAULT_SLUG = "clickhouse-failover-gateway-s3-overflow";
/** A seeded flow, which every gallery lists (so a gallery has rendered). */
const TABLE_ONLY_SLUG = "log-volume-cost-control";

/** A flow a test writes: its pipelines make it a traces flow. */
const TEST_FLOW_YAML =
  "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  debug: {}\n" +
  "service:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n";
/** The same with a literal credential, which the security check blocks (flow_lint's hardcoded-credential). */
const SECRET_FLOW_YAML =
  "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  otlp_http:\n    endpoint: ${env:OTLP_ENDPOINT}\n" +
  "    api_key: e2e-literal-key\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp_http]\n";
const HARDCODED_CREDENTIAL_MESSAGE =
  "'api_key' contains a literal value. Publishing this would share your own credential — replace it with ${env:...}.";

/**
 * `secondContext`: a second browser, for a second person, with its own
 * cookie jar, closed when the test ends. `testFlows`: the `e2e-` slugs a test
 * writes, deleted when it ends. The editor's tour is marked done in both
 * browsers (`skipEditorTour`): these tests aren't about it.
 */
const test = base.extend<{ secondContext: BrowserContext; testFlows: string[] }>({
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
  // eslint-disable-next-line no-empty-pattern
  testFlows: async ({}, use) => {
    const slugs: string[] = [];
    await use(slugs);
    await deleteTestFlows(slugs);
  },
});

/** The seeded flows, as the migration holds them. */
async function seededFlows() {
  return (await loadFlowsMigration()).seededFlows;
}

async function seededFlow(slug: string) {
  const flow = (await seededFlows()).find((candidate) => candidate.slug === slug);
  if (!flow) throw new Error(`no seeded flow ${slug}`);
  return flow;
}

/** A new `e2e-` slug, recorded for the clean-up. */
function newTestFlowSlug(testFlows: string[]): string {
  const slug = `${E2E_FLOW_SLUG_PREFIX}${randomUUID()}`;
  testFlows.push(slug);
  return slug;
}

// ── A copy of a flow ───────────────────────────────────────────────────────

/** The toolbar's collector version picker, named "Collector version" and the version it shows. */
function collectorVersionPicker(page: Page): Locator {
  return page.getByRole("combobox", { name: /^Collector version / });
}

/** A card in the gallery or the create dialog's picker: a `div role="button"` with the flow's name. */
function flowCard(scope: Page | Locator, name: string): Locator {
  // The inner locator is matched inside each button, so it starts from the page, not from `scope`.
  const page = "page" in scope ? scope.page() : scope;
  return scope.getByRole("button").filter({ has: page.getByRole("heading", { level: 3, name, exact: true }) });
}

/**
 * The editor opened on the user's only configuration, made from `flow`:
 * at its version's address; the stored version 1 holds the flow's text byte
 * for byte, its distribution and its pin; the configuration records the
 * flow's slug; the editor's text (its YAML tab's Download) is the flow's; the
 * toolbar's picker shows the pin.
 */
async function expectCopyOfFlow(
  page: Page,
  user: SeededUser,
  name: string,
  flow: { slug: string; yaml_content: string; collector_distribution: string; collector_version: string },
): Promise<void> {
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  const configurations = await findConfigurations(user.organizationId);
  expect(configurations.map((row) => [row.name, row.source_flow_slug, row.collector_distribution])).toEqual([
    [name, flow.slug, flow.collector_distribution],
  ]);
  const configurationId = configurations[0]!.id;
  expect(page.url()).toBe(`${E2E_WEB_URL}${await versionAddress(configurationId)}`);
  const version = await storedVersion(configurationId);
  expect(version.yaml_content === flow.yaml_content).toBe(true);
  expect(version).toMatchObject({
    collector_distribution: flow.collector_distribution,
    collector_version: flow.collector_version,
    published_at: null,
  });

  await expect(collectorVersionPicker(page)).toHaveAccessibleName(`Collector version v${flow.collector_version}`);
  expect((await editorText(page)) === flow.yaml_content).toBe(true);
}

test("Use this flow, from the gallery's flow page, opens the editor on a copy with the flow's text byte for byte and its pin", async ({
  page,
}) => {
  const flow = await seededFlow(OFF_DEFAULT_SLUG);
  expect(flow.collector_version).toBe("0.159.0");
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);

  await open(page, "/app/flows");
  await expect(page.getByRole("heading", { level: 1, name: "Flows", exact: true })).toBeVisible();
  await page.getByPlaceholder("Search flows…").fill(flow.name);
  await flowCard(page, flow.name).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/app/flows/${flow.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: flow.name })).toBeVisible();

  await page.getByRole("button", { name: "Use this flow" }).click();
  const dialog = page.getByRole("dialog", { name: "Use this flow" });
  await expect(dialog.getByLabel("Configuration name")).toHaveValue(flow.name);
  await expect(dialog.getByLabel("Description")).toHaveValue(flow.summary);
  await expect(dialog.getByText(`pinned to collector v${flow.collector_version}`, { exact: true })).toBeVisible();
  await expect(dialog.getByText(/no longer offered/)).toHaveCount(0);
  const name = `From a flow ${randomUUID()}`;
  await dialog.getByLabel("Configuration name").fill(name);
  await dialog.getByRole("button", { name: "Create configuration" }).click();

  await expectCopyOfFlow(page, user, name, flow);
});

test("Start from a flow, in the create dialog (start, browse, pick, name, Create), opens the editor on a copy with the flow's text byte for byte and its pin", async ({
  page,
}) => {
  const flow = await seededFlow(OFF_DEFAULT_SLUG);
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await open(page, "/app");

  await page.locator("#createNewConfigurationButton").click();
  const start = page.getByRole("dialog", { name: "New configuration" });
  // The count is the flows read when the dialog opened; others' `e2e-` flows may be among them.
  await expect(start.getByRole("button", { name: /Start from a flow/ })).toContainText(/\d+ prebuilt configurations/);
  await start.getByRole("button", { name: /Start from a flow/ }).click();

  const browse = page.getByRole("dialog", { name: "Start from a flow" });
  await browse.getByPlaceholder("Search flows…").fill(flow.name);
  await flowCard(browse, flow.name).click();

  const naming = page.getByRole("dialog", { name: "Name Your Configuration" });
  await expect(naming).toContainText(`Based on ${flow.name}. Your copy is independent — editing it won't affect the flow.`);
  await expect(naming.getByLabel("Configuration Name")).toHaveValue(flow.name);
  await expect(naming.getByLabel("Description")).toHaveValue(flow.summary);
  await expect(naming.getByText(/set by this flow/)).toHaveText(`Otel Contrib · collector v${flow.collector_version} — set by this flow`);
  await expect(naming.getByRole("combobox", { name: "Distribution" })).toHaveCount(0);
  const name = `Started from a flow ${randomUUID()}`;
  await naming.getByLabel("Configuration Name").fill(name);
  await naming.getByRole("button", { name: "Create", exact: true }).click();
  await expect(naming).toBeHidden();

  await expectCopyOfFlow(page, user, name, flow);
});

test("Use this flow on a flow pinned where the catalogue no longer offers opens the editor on a copy on the default, and says so first (D12 decision 16)", async ({
  page,
  testFlows,
}) => {
  const distribution = await findDefaultCollectorDistribution();
  const versions = await findCollectorVersions(distribution.id);
  const retired = versions.find((version) => version.deprecated)?.version;
  const defaultVersion = versions.find((version) => version.is_default)?.version;
  if (retired === undefined || defaultVersion === undefined) throw new Error("the catalogue's default distribution has no deprecated or no default version");
  // The API refuses a retired pin, so the flow is written as the tables' owner: one pinned before the version was retired.
  const slug = newTestFlowSlug(testFlows);
  const flowName = `E2E retired-pin flow ${randomUUID()}`;
  await insertTestFlow({
    slug,
    name: flowName,
    yaml: TEST_FLOW_YAML,
    signals: ["traces"],
    collectorDistribution: distribution.id,
    collectorVersion: retired,
    published: true,
  });
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);

  await open(page, `/app/flows/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: flowName })).toBeVisible();
  await page.getByRole("button", { name: "Use this flow" }).click();
  const dialog = page.getByRole("dialog", { name: "Use this flow" });
  await expect(
    dialog.getByText(`This flow was built for collector v${retired}, which is no longer offered; your copy will use v${defaultVersion}.`, { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(`pinned to collector v${defaultVersion}`, { exact: true })).toBeVisible();
  const name = `From a retired-pin flow ${randomUUID()}`;
  await dialog.getByLabel("Configuration name").fill(name);
  await dialog.getByRole("button", { name: "Create configuration" }).click();

  await expectCopyOfFlow(page, user, name, {
    slug,
    yaml_content: TEST_FLOW_YAML,
    collector_distribution: distribution.id,
    collector_version: defaultVersion,
  });
  // The flow keeps its pin: only the copy moved.
  expect(await findFlow(slug)).toMatchObject({ collector_version: retired });
});

// ── The dead ends ──────────────────────────────────────────────────────────

/** The 404 page (root's error boundary), answered with a 404 to the document request. */
async function expectNotFoundPage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "404", exact: true })).toBeVisible();
  await expect(page.getByText("The requested page could not be found.", { exact: true })).toBeVisible();
}

test("a signed-in user who isn't a product admin, at a hidden e2e- flow's page in the product, gets the 404 page, with nothing of the flow; a product admin gets the flow", async ({
  page,
  secondContext,
  testFlows,
}) => {
  const distribution = await findDefaultCollectorDistribution();
  const defaultVersion = (await findCollectorVersions(distribution.id)).find((version) => version.is_default)!.version;
  const slug = newTestFlowSlug(testFlows);
  const name = `E2E hidden flow ${randomUUID()}`;
  await insertTestFlow({
    slug,
    name,
    yaml: TEST_FLOW_YAML,
    signals: ["traces"],
    collectorDistribution: distribution.id,
    collectorVersion: defaultVersion,
    published: false,
  });
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);

  await expectNotFoundPage(page, `/app/flows/${slug}`);
  await waitForHydration(page);
  expect(await page.content()).not.toContain(name);
  await expect(page.getByRole("button", { name: "Use this flow" })).toHaveCount(0);

  // The same address, for a product admin: the flow is there, hidden.
  const adminPage = await secondContext.newPage();
  await signedInProductAdmin(adminPage);
  await open(adminPage, `/app/flows/${slug}`);
  await expect(adminPage.getByRole("heading", { level: 1, name })).toBeVisible();
});

// ── Product admin ──────────────────────────────────────────────────────────

/** A toast saying `text`. */
function toastWith(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

/** The admin table's row for the flow with this slug. */
function adminRow(page: Page, slug: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("cell", { name: slug, exact: true }) });
}

/** A product admin, by the README's SQL, signed in on `page`. */
async function signedInProductAdmin(page: Page): Promise<SeededUser> {
  const admin = await seedUser({ password: PASSWORD });
  await grantProductAdmin(admin.email);
  await signInThroughApi(page, admin);
  return admin;
}

/** Opens product admin's flows page from the sidebar's Product Admin item (`/product-admin` goes on to its Flows page). */
async function openAdminFromSidebar(page: Page): Promise<void> {
  await open(page, "/app");
  await page.getByRole("link", { name: "Product Admin" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/flows`);
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Flows", exact: true })).toBeVisible();
}

/** The product admin's "Show hidden flows" switch on the signed-in gallery (Ruling 42). */
function showHiddenFlows(page: Page): Locator {
  return page.getByRole("switch", { name: "Show hidden flows", exact: true });
}

/**
 * Whether a signed-in gallery has the flow named `name`, on a fresh load,
 * beside a seeded one (so it rendered). A product admin's gallery is read
 * with its "Show hidden flows" switch as the visit starts, off (`showHidden`
 * false), or after switching it on; anyone else's has no switch.
 */
async function expectGallery(
  page: Page,
  name: string,
  listed: boolean,
  { productAdmin = false, showHidden = false }: { productAdmin?: boolean; showHidden?: boolean } = {},
): Promise<void> {
  await open(page, "/app/flows");
  const seeded = await seededFlow(TABLE_ONLY_SLUG);
  await expect(flowCard(page, seeded.name)).toHaveCount(1);
  if (productAdmin) {
    await waitForHydration(page);
    await expect(showHiddenFlows(page)).not.toBeChecked();
    if (showHidden) {
      await showHiddenFlows(page).click();
      await expect(showHiddenFlows(page)).toBeChecked();
    }
  } else {
    await expect(showHiddenFlows(page)).toHaveCount(0);
  }
  await expect(flowCard(page, name)).toHaveCount(listed ? 1 : 0);
}

/**
 * A flow the signed-in product admin creates through the API, as the dialog
 * does, for tests about something after creating: on the catalogue's default
 * pin, with the test flow's text, `published` or hidden.
 */
async function createFlowThroughApi(
  page: Page,
  { slug, name, published }: { slug: string; name: string; published: boolean },
): Promise<void> {
  const distribution = await findDefaultCollectorDistribution();
  const defaultVersion = (await findCollectorVersions(distribution.id)).find((version) => version.is_default)!.version;
  const response = await page.request.post("/api/v1/flows", {
    data: {
      slug,
      name,
      summary: "Made by a browser test.",
      description: "Made by a browser test.",
      signals: ["traces"],
      tags: [],
      yaml: TEST_FLOW_YAML,
      collectorDistribution: distribution.id,
      collectorVersion: defaultVersion,
      sourceUrl: null,
      authorName: null,
      sortOrder: 0,
      published,
    },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(201);
}

test("a product admin creates an e2e- flow in the dialog, edits it, and deletes it through its confirmation", async ({
  page,
  testFlows,
}) => {
  await signedInProductAdmin(page);
  await openAdminFromSidebar(page);

  // Create.
  const slug = newTestFlowSlug(testFlows);
  const name = `E2E flow ${randomUUID()}`;
  await page.getByRole("button", { name: "New flow" }).first().click();
  const create = page.getByRole("dialog", { name: "New flow" });
  await create.getByLabel("Name", { exact: true }).fill(name);
  await create.getByLabel("URL slug").fill(slug);
  await create.getByLabel("Summary").fill("Made by a browser test.");
  await create.getByLabel("Configuration YAML").fill(TEST_FLOW_YAML);
  // The signals are derived from the pipelines.
  await expect(create.getByText("traces", { exact: true })).toBeVisible();
  await create.getByRole("button", { name: "Create flow" }).click();
  await expect(create).toBeHidden();
  await expect(toastWith(page, "Flow created")).toBeVisible();
  await expect(adminRow(page, slug)).toContainText(name);
  await expect(adminRow(page, slug).getByRole("switch")).toBeChecked();
  const created = await findFlow(slug);
  expect(created).toMatchObject({ name, summary: "Made by a browser test.", published: true, signals: ["traces"] });
  expect(created?.yaml_content === TEST_FLOW_YAML).toBe(true);

  // Edit: a new name and summary, the rest kept.
  const renamed = `E2E flow renamed ${randomUUID()}`;
  await adminRow(page, slug).getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit flow" });
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(edit.getByLabel("URL slug")).toHaveValue(slug);
  await edit.getByLabel("Name", { exact: true }).fill(renamed);
  await edit.getByLabel("Summary").fill("Edited by a browser test.");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await expect(toastWith(page, "Flow updated")).toBeVisible();
  await expect(adminRow(page, slug)).toContainText(renamed);
  const edited = await findFlow(slug);
  expect(edited).toMatchObject({ id: created!.id, slug, name: renamed, summary: "Edited by a browser test.", published: true });
  expect(edited?.yaml_content === TEST_FLOW_YAML).toBe(true);

  // Delete, through its confirmation.
  await adminRow(page, slug).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: `Delete “${renamed}”?` });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toastWith(page, "Flow deleted")).toBeVisible();
  await expect(adminRow(page, slug)).toHaveCount(0);
  expect(await findFlow(slug)).toBeUndefined();
});

test("a product admin hides an e2e- flow they created: it leaves every gallery, the admin's listing it only with Show hidden flows on", async ({
  page,
  secondContext,
  testFlows,
}) => {
  await signedInProductAdmin(page);
  const slug = newTestFlowSlug(testFlows);
  const name = `E2E flow ${randomUUID()}`;
  await createFlowThroughApi(page, { slug, name, published: true });
  const member = await seedUser({ password: PASSWORD });
  const memberPage = await secondContext.newPage();
  await signInThroughApi(memberPage, member);

  // Visible: in a non-admin's gallery.
  await expectGallery(memberPage, name, true);

  await openAdminFromSidebar(page);
  await page.getByRole("switch", { name: `Hide ${name} from the gallery` }).click();
  await expect(toastWith(page, "Flow hidden")).toBeVisible();
  await expect(page.getByRole("switch", { name: `Show ${name} on the gallery` })).not.toBeChecked();
  expect(await findFlow(slug)).toMatchObject({ published: false });

  await expectGallery(memberPage, name, false);
  // A product admin's gallery is everyone's until they switch Show hidden flows on (Ruling 42).
  await expectGallery(page, name, false, { productAdmin: true });
  await expectGallery(page, name, true, { productAdmin: true, showHidden: true });
});

test("a product admin shows a hidden e2e- flow they created again: it returns to every gallery, the admin's with Show hidden flows off", async ({
  page,
  secondContext,
  testFlows,
}) => {
  await signedInProductAdmin(page);
  const slug = newTestFlowSlug(testFlows);
  const name = `E2E flow ${randomUUID()}`;
  await createFlowThroughApi(page, { slug, name, published: false });
  const member = await seedUser({ password: PASSWORD });
  const memberPage = await secondContext.newPage();
  await signInThroughApi(memberPage, member);

  // Hidden: not in a non-admin's gallery, nor in the admin's until they switch Show hidden flows on (Ruling 42).
  await expectGallery(memberPage, name, false);
  await expectGallery(page, name, false, { productAdmin: true });
  await expectGallery(page, name, true, { productAdmin: true, showHidden: true });

  await openAdminFromSidebar(page);
  await page.getByRole("switch", { name: `Show ${name} on the gallery` }).click();
  await expect(toastWith(page, "Flow is now visible")).toBeVisible();
  await expect(page.getByRole("switch", { name: `Hide ${name} from the gallery` })).toBeChecked();
  expect(await findFlow(slug)).toMatchObject({ published: true });

  await expectGallery(memberPage, name, true);
  await expectGallery(page, name, true, { productAdmin: true });
});

test("a product admin's security check says a clean YAML has no blocking issue, and lists a literal api_key as a block finding", async ({
  page,
}) => {
  await signedInProductAdmin(page);
  await openAdminFromSidebar(page);

  await page.getByRole("button", { name: "New flow" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New flow" });
  const yaml = dialog.getByLabel("Configuration YAML");
  const check = dialog.getByRole("button", { name: "Run security check" });

  await yaml.fill(TEST_FLOW_YAML);
  await check.click();
  await expect(dialog.getByText("No blocking issues.", { exact: true })).toBeVisible();

  // A change clears the findings; the check runs on the new text.
  await yaml.fill(SECRET_FLOW_YAML);
  await expect(dialog.getByText("No blocking issues.", { exact: true })).toHaveCount(0);
  await check.click();
  const finding = dialog.locator(".ph-no-capture > div").filter({ hasText: HARDCODED_CREDENTIAL_MESSAGE });
  await expect(finding).toHaveText(`.exporters.otlp_http.api_key ${HARDCODED_CREDENTIAL_MESSAGE}`);
  // A block finding: its mark is the failure colour, and it comes first.
  await expect(finding.locator("svg")).toHaveClass(/text-fail/);
  await expect(dialog.locator(".ph-no-capture > div").first()).toHaveText(`.exporters.otlp_http.api_key ${HARDCODED_CREDENTIAL_MESSAGE}`);
  await expect(dialog.getByText("No blocking issues.", { exact: true })).toHaveCount(0);

  // Advisory: nothing is saved by the check, and Cancel leaves.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("a signed-in user who isn't a product admin, at /product-admin/flows, lands on /app and never sees the admin shell", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);

  // The document request is answered with the redirect: nothing of the page is sent.
  const response = await page.request.get("/product-admin/flows", { maxRedirects: 0 });
  expect([response.status(), response.headers()["location"]]).toEqual([302, "/app"]);

  // In the browser, every change to the page is watched from before the first byte.
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  await page.addInitScript(`
    window.__adminShellSeen = false;
    new MutationObserver(() => {
      if ((document.body?.textContent ?? "").includes("Admin Dashboard")) window.__adminShellSeen = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  `);
  await page.goto("/product-admin/flows");
  await waitForHydration(page);

  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
  await expect(page.locator("#createNewConfigurationButton")).toBeVisible();
  await expect(page.getByRole("link", { name: "Flows", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Product Admin" })).toHaveCount(0);
  expect(await page.evaluate<boolean>("window.__adminShellSeen")).toBe(false);
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);
});

test("a product admin whose flag is cleared mid-visit, then switching a flow's visibility, lands on /app with no admin shell, and the flow is unchanged", async ({
  page,
  testFlows,
}) => {
  const admin = await signedInProductAdmin(page);
  const slug = newTestFlowSlug(testFlows);
  const name = `E2E flow ${randomUUID()}`;
  await createFlowThroughApi(page, { slug, name, published: true });
  await openAdminFromSidebar(page);
  const visible = page.getByRole("switch", { name: `Hide ${name} from the gallery` });
  await expect(visible).toBeChecked();

  // An operator clears the flag (the README's SQL), while the page is open.
  await revokeProductAdmin(admin.email);
  await visible.click();

  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
  await expect(page.locator("#createNewConfigurationButton")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Flows", exact: true })).toHaveCount(0);
  await expect(toastWith(page, "Flow hidden")).toHaveCount(0);
  expect(await findFlow(slug)).toMatchObject({ published: true });
});

// D20 default 28 (Preflight ruling 31): "Define these in your organization's variables" marks each name.
test("a flow's page in the product marks each organization variable its text references as defined or not defined in the organization", async ({
  page,
  testFlows,
}) => {
  const distribution = await findDefaultCollectorDistribution();
  const defaultVersion = (await findCollectorVersions(distribution.id)).find((version) => version.is_default)!.version;
  const defined = uniqueVariableName("E2E_DEFINED");
  const missing = uniqueVariableName("E2E_MISSING");
  const slug = newTestFlowSlug(testFlows);
  const name = `E2E variables flow ${randomUUID()}`;
  await insertTestFlow({
    slug,
    name,
    yaml:
      "receivers:\n  otlp:\n    protocols:\n      grpc: {}\nexporters:\n  otlp_http:\n" +
      `    endpoint: \${org:${defined}}\n    headers:\n      x-tenant: \${org:${missing}}\n` +
      "service:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [otlp_http]\n",
    signals: ["traces"],
    collectorDistribution: distribution.id,
    collectorVersion: defaultVersion,
    published: true,
  });
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await createVariableThroughApi(page, user.organizationId, defined, "https://otlp.example.com");

  await open(page, `/app/flows/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  // The chips are the list right after the section's lead line (the page gives the list no role or id of its own).
  const lead = page.getByText("Define these in your organization's variables — an unset one is delivered to the collector as-is, not as an error", {
    exact: true,
  });
  await expect(lead).toHaveCount(1);
  // Each name's chip: the name, then its mark (fixed words), sorted by name.
  const chips = lead.locator("xpath=following-sibling::div[1]/span");
  await expect(chips).toHaveText([`${defined}defined`, `${missing}not defined`]);
  await expect(chips.filter({ hasText: defined }).locator("code")).toHaveText(defined);
  await expect(chips.filter({ hasText: missing }).locator("code")).toHaveText(missing);
});
