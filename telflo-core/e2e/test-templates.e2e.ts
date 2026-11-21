import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Page, type Request } from "@playwright/test";
import { TEST_FILE_MAXIMUM_BYTES, type TestTemplate } from "@telflo/contracts";
import {
  deleteTestTemplates,
  findConfigurationVersions,
  findTestTemplateIdsByName,
  grantProductAdmin,
  revokeProductAdmin,
  seedConfiguration,
  seedUser,
  type SeededUser,
} from "./support/database.js";
import { downloaded } from "./support/downloads.js";
import { open } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { signInThroughApi, skipEditorTour, waitForHydration } from "./support/session.js";
import {
  ariaContainers,
  clickRun,
  expectStatus,
  openRunDialog,
  openTestingTab,
  otlpLogs,
  runDialog,
  runRows,
  testRunText,
  type PickedFile,
} from "./support/test-runs-page.js";
import {
  breadcrumb,
  createDefinitionThroughApi,
  createSuiteThroughApi,
  definitionDialog,
  definitionRow,
  expandSuite,
  expectBreadcrumbs,
  listDefinitionsThroughApi,
  listRunsThroughApi,
  nameAndSaveDefinition,
  openSuitesSubtab,
  pickTemplateIn,
  readRunThroughApi,
  subtab,
  suiteCard,
  templateRow,
  toastWith,
  versionApiPath,
  type VersionPath,
} from "./support/test-suites-page.js";
import {
  ADMIN_NAV_ITEMS,
  adminNavItems,
  adminTemplateRow,
  chooseOption,
  createTemplateThroughApi,
  listTemplatesThroughApi,
  openTestTemplatesAdmin,
  productAdminSession,
  templateDialog,
  uniqueTemplateName,
} from "./support/test-templates-page.js";
import { versionPath } from "./support/versions-page.js";

// Test templates, in the browser: product admin's Test Templates page
// (its nav, the dialog's checks and refusals, create, edit and delete, and
// its gate for everyone else, a revoked admin included), and a member's
// Templates step in the run dialog and the definition dialog (the filters,
// the viewer, the download, a pick that runs), and a template deleted after
// a definition copied it.
//
// Templates are global, as flows are: every parallel test sees what another
// wrote. Each test names its own `e2e-<uuid>`, asserts only on its own rows
// (never a count, never the empty state), and deletes them as the tables'
// owner when it ends, however it ends (`testTemplates`). Each admin is a fresh
// user, made one by the README's SQL. The runs go to the OpenAPI-checked fake
// tester, which answers a text with none of its markers with a success whose
// output is the input.

const PASSWORD = "correct horse battery staple";

/**
 * The templates a test writes, deleted as the tables' owner when it ends:
 * by id, and by name for one created through the page, whose id the test
 * only learns after the Create (each name `e2e-…`, its own).
 */
interface TestTemplates {
  ids: string[];
  names: string[];
}

/** `testTemplates`: the templates a test writes, deleted when it ends. `secondContext`: a second person's browser. */
const test = base.extend<{ testTemplates: TestTemplates; secondContext: BrowserContext }>({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
  secondContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: E2E_WEB_URL, viewport: { width: 1440, height: 1000 } });
    await skipEditorTour(context);
    await use(context);
    await context.close();
  },
  // eslint-disable-next-line no-empty-pattern
  testTemplates: async ({}, use) => {
    const written: TestTemplates = { ids: [], names: [] };
    await use(written);
    const named = await findTestTemplateIdsByName(written.names);
    await deleteTestTemplates([...new Set([...written.ids, ...named])]);
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

/** Each page error, as it happens: none is expected anywhere here. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** An OTLP logs file whose record's body is `body`, named `e2e-template-<uuid>.json`. */
function templateFile(body = `template ${randomUUID()}`): PickedFile {
  return { name: `e2e-template-${randomUUID()}.json`, mimeType: "application/json", buffer: Buffer.from(otlpLogs(body)) };
}

/** A product admin of their own, signed in on `page`. */
async function signedInProductAdmin(page: Page): Promise<SeededUser> {
  const admin = await seedUser({ password: PASSWORD });
  await grantProductAdmin(admin.email);
  await signInThroughApi(page, admin);
  return admin;
}

/** A member signed in on `page` with a draft configuration of their own (testRunText's `logs` pipeline), the editor open on its Testing tab. */
async function openMembersTestingTab(page: Page): Promise<VersionPath> {
  const member = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: member.organizationId,
    createdByUserId: member.userId,
    name: `Templates ${randomUUID()}`,
    yamlContent: testRunText(randomUUID()),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, member);
  await open(page, versionPath(configuration.id, version!.id));
  await openTestingTab(page);
  return { organizationId: member.organizationId, configurationId: configuration.id, versionId: version!.id };
}

/** The POSTs of a template upload the page sends from now on. */
function templateUploads(page: Page): Request[] {
  const sent: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/test-templates") sent.push(request);
  });
  return sent;
}

test("a product admin's nav lists User Feedback, Test Templates, Test Regex, Library, Flows, Users, then Product admins; a template is created (after each check's words), edited and deleted", async ({
  page,
  testTemplates,
}) => {
  const errors = pageErrors(page);
  await signedInProductAdmin(page);
  await openTestTemplatesAdmin(page);
  await expect(adminNavItems(page)).toHaveText(ADMIN_NAV_ITEMS);
  const name = uniqueTemplateName();
  // Deleted by name when the test ends, even if it fails between the Create and finding the id.
  testTemplates.names.push(name);
  const file = templateFile();

  // Create: each check's words first.
  await page.getByRole("button", { name: "New Template", exact: true }).click();
  const created = templateDialog(page, "New Test Template");
  await created.getByRole("button", { name: "Create", exact: true }).click();
  await expect(created.getByRole("alert")).toHaveText([
    "Please enter a name.",
    "Please select a receiver type.",
    "Please select a signal type.",
    "Please choose a file.",
  ]);
  await created.getByLabel("Name", { exact: true }).fill(name);
  await chooseOption(page, created, "Receiver type", "OTLP");
  await chooseOption(page, created, "Signal type", "Logs");
  await created.getByLabel("Description", { exact: true }).fill("A sample of logs");
  await created.locator('input[type="file"]').setInputFiles(file);
  await expect(created.getByText(file.name, { exact: true })).toBeVisible();
  await expect(created.getByRole("alert")).toHaveCount(0);
  await created.getByRole("button", { name: "Create", exact: true }).click();

  await expect(created).toBeHidden();
  await expect(toastWith(page, "Template created")).toBeVisible();
  const row = adminTemplateRow(page, name);
  await expect(row).toContainText("OTLP");
  await expect(row).toContainText("Logs");
  const template = (await listTemplatesThroughApi(page.request)).find((listed) => listed.name === name);
  // Deleted when the test ends from the moment it is found, even if a check below fails.
  if (template !== undefined) testTemplates.ids.push(template.id);
  expect(template).toMatchObject({
    name,
    description: "A sample of logs",
    receiverType: "otlp",
    signal: "logs",
    fileName: file.name,
    sizeBytes: file.buffer.length,
  });

  // Edit: its name, description and signal; its file stays.
  const renamed = uniqueTemplateName();
  testTemplates.names.push(renamed);
  await row.getByRole("button", { name, exact: true }).click();
  const edit = templateDialog(page, "Edit Test Template");
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(edit.locator('input[type="file"]')).toHaveCount(0);
  await edit.getByLabel("Name", { exact: true }).fill(renamed);
  await edit.getByLabel("Description", { exact: true }).fill("Now metrics");
  await chooseOption(page, edit, "Signal type", "Metrics");
  await edit.getByRole("button", { name: "Save", exact: true }).click();

  await expect(edit).toBeHidden();
  await expect(toastWith(page, "Template updated")).toBeVisible();
  await expect(adminTemplateRow(page, renamed)).toContainText("Metrics");
  await expect(adminTemplateRow(page, name)).toHaveCount(0);
  expect((await listTemplatesThroughApi(page.request)).find((listed) => listed.id === template!.id)).toMatchObject({
    name: renamed,
    description: "Now metrics",
    receiverType: "otlp",
    signal: "metrics",
    fileName: file.name,
  });

  // Delete, through its confirmation; the focus goes to New Template.
  await adminTemplateRow(page, renamed).getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete Test Template" });
  await expect(confirmation).toContainText(renamed);
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(confirmation).toBeHidden();
  await expect(toastWith(page, "Template deleted")).toBeVisible();
  await expect(adminTemplateRow(page, renamed)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Template", exact: true })).toBeFocused();
  expect((await listTemplatesThroughApi(page.request)).some((listed) => listed.id === template!.id)).toBe(false);
  expect(errors).toEqual([]);
});

test("the template dialog refuses a file of another type and one over 10 MiB in their words, and sends nothing", async ({ page }) => {
  await signedInProductAdmin(page);
  await openTestTemplatesAdmin(page);
  const uploads = templateUploads(page);
  await page.getByRole("button", { name: "New Template", exact: true }).click();
  const dialog = templateDialog(page, "New Test Template");
  const name = uniqueTemplateName();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await chooseOption(page, dialog, "Receiver type", "OTLP");
  await chooseOption(page, dialog, "Signal type", "Logs");
  const fileInput = dialog.locator('input[type="file"]');

  await fileInput.setInputFiles({ name: "readings.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") });
  await expect(dialog.getByRole("alert")).toHaveText(["Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used."]);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeVisible();

  await fileInput.setInputFiles({
    name: "huge.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(TEST_FILE_MAXIMUM_BYTES + 1, 0x20),
  });
  await expect(dialog.getByRole("alert")).toHaveText(["The file is larger than 10 MiB."]);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeVisible();

  // Exactly 10 MiB is allowed.
  await fileInput.setInputFiles({
    name: "just-fits.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(TEST_FILE_MAXIMUM_BYTES, 0x20),
  });
  await expect(dialog.getByText("just-fits.json", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(uploads).toEqual([]);
  await expect(adminTemplateRow(page, name)).toHaveCount(0);
});

test("someone not a product admin, at the Test Templates page, lands on /app; an admin revoked mid-visit, moving between the two pages, lands on /app", async ({
  page,
  secondContext,
}) => {
  // A member: the document request is answered with the redirect.
  const member = await seedUser({ password: PASSWORD });
  const memberPage = await secondContext.newPage();
  const memberErrors = pageErrors(memberPage);
  await signInThroughApi(memberPage, member);
  const response = await memberPage.request.get("/product-admin/test-templates", { maxRedirects: 0 });
  expect([response.status(), response.headers()["location"]]).toEqual([302, "/app"]);
  await memberPage.goto("/product-admin/test-templates");
  await waitForHydration(memberPage);
  await expect(memberPage).toHaveURL(`${E2E_WEB_URL}/app`);
  await expect(memberPage.locator("#createNewConfigurationButton")).toBeVisible();
  await expect(memberPage.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);

  // An admin, revoked on Test Templates, moving to Flows.
  const admin = await signedInProductAdmin(page);
  await openTestTemplatesAdmin(page);
  await revokeProductAdmin(admin.email);
  await adminNavItems(page).filter({ hasText: "Flows" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
  await expect(page.locator("#createNewConfigurationButton")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);

  // And back: granted again, on Flows, revoked, moving to Test Templates.
  await grantProductAdmin(admin.email);
  await open(page, "/product-admin/flows");
  await expect(page.getByRole("heading", { level: 1, name: "Flows", exact: true })).toBeVisible();
  await revokeProductAdmin(admin.email);
  await adminNavItems(page).filter({ hasText: "Test Templates" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
  await expect(page.locator("#createNewConfigurationButton")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Test Templates", exact: true })).toHaveCount(0);
  expect(memberErrors).toEqual([]);
});

test("a member filters the templates, views one (its text in the replay block), downloads its exact bytes by its file name, and picks it for a run and for a test configuration", async ({
  page,
  playwright,
  testTemplates,
}) => {
  // The run dialog's Templates step, its filters, a Monaco viewer, a
  // download, a run, then the Suites subtab and the definition dialog:
  // 10.3-21 s in measured runs (five workers), up to 70% of the 30 s per-test
  // limit. Slow triples the limit, a hang guard; every wait inside keeps
  // its own bound.
  test.slow();
  const errors = pageErrors(page);
  const body = `template ${randomUUID()}`;
  const logsBytes = templateFile(body);
  const metricsBytes = templateFile();
  const { request } = await productAdminSession(playwright, PASSWORD);
  let logs: TestTemplate;
  let metrics: TestTemplate;
  try {
    logs = await createTemplateThroughApi(request, { name: uniqueTemplateName(), receiverType: "otlp", signal: "logs", file: logsBytes });
    testTemplates.ids.push(logs.id);
    metrics = await createTemplateThroughApi(request, {
      name: uniqueTemplateName(),
      receiverType: "hostmetrics",
      signal: "metrics",
      file: metricsBytes,
    });
    testTemplates.ids.push(metrics.id);
  } finally {
    await request.dispose();
  }
  const path = await openMembersTestingTab(page);
  const dialog = await openRunDialog(page);
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(templateRow(dialog, logs.name)).toBeVisible();
  await expect(templateRow(dialog, metrics.name)).toBeVisible();

  // The filters, by label: only this test's rows are looked at.
  await chooseOption(page, dialog, "Receiver Type", "OTLP");
  await expect(templateRow(dialog, logs.name)).toBeVisible();
  await expect(templateRow(dialog, metrics.name)).toHaveCount(0);
  await chooseOption(page, dialog, "Receiver Type", "Any");
  await chooseOption(page, dialog, "Signal Type", "Metrics");
  await expect(templateRow(dialog, metrics.name)).toBeVisible();
  await expect(templateRow(dialog, logs.name)).toHaveCount(0);
  await chooseOption(page, dialog, "Signal Type", "Any");
  await expect(templateRow(dialog, logs.name)).toBeVisible();

  // Viewed: its text, in a replay-blocked dialog, Monaco's live region in the shell's host.
  await dialog.getByRole("button", { name: `View contents of ${logs.name}`, exact: true }).click();
  const viewer = page.getByRole("dialog", { name: logs.name });
  await expect(viewer.locator(".monaco-editor .view-lines")).toContainText(body);
  await expect(viewer).toHaveClass(/(^|\s)ph-no-capture(\s|$)/);
  expect(await ariaContainers(page)).toEqual([{ blocked: true, inShellHost: true }]);
  await viewer.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(viewer).toBeHidden();

  // Downloaded: the exact bytes, named by the template's own file name.
  const download = await downloaded(page, () => dialog.getByRole("button", { name: `Download ${logs.name}`, exact: true }).click());
  expect(download.name).toBe(logsBytes.name);
  expect(download.bytes.equals(logsBytes.buffer)).toBe(true);

  // Picked for a run: it runs from the template's bytes, named by its file name.
  await templateRow(dialog, logs.name).click();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog.getByText(`Selected File: ${logs.name}`)).toBeVisible();
  await clickRun(page);
  await expect(runDialog(page)).toBeHidden();
  await expectStatus(page, "Success");
  const [run] = await listRunsThroughApi(page, path);
  expect(await readRunThroughApi(page, path, run!.id)).toMatchObject({ inputName: logsBytes.name, pipeline: "logs", suiteName: null });
  const input = await page.request.get(`${versionApiPath(path)}/test-runs/${run!.id}/files/input`);
  expect((await input.body()).equals(logsBytes.buffer)).toBe(true);

  // Picked for a test configuration, which runs it.
  const suite = await createSuiteThroughApi(page, path, `Suite ${randomUUID()}`);
  await openSuitesSubtab(page);
  const card = suiteCard(page, suite.name);
  await expandSuite(page, card);
  await card.getByRole("button", { name: "Add test configuration" }).click();
  await pickTemplateIn(definitionDialog(page), logs.name);
  await nameAndSaveDefinition(definitionDialog(page), "From the template");
  await definitionRow(card, "From the template").getByRole("button", { name: "Run test" }).click();
  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  await expect(runRows(page)).toHaveCount(2);
  await expect(runRows(page).first()).toContainText(breadcrumb(suite.name, "From the template"));
  await expectStatus(page, "Success");
  const [fromDefinition] = await listRunsThroughApi(page, path);
  expect(fromDefinition).toMatchObject({ status: "succeeded", inputName: logsBytes.name, definitionName: "From the template" });
  expect(errors).toEqual([]);
});

test("a template the admin deletes leaves the list, and a test configuration made from it still runs", async ({
  page,
  playwright,
  secondContext,
  testTemplates,
}) => {
  // Two people, the admin's page opening product admin and deleting through
  // its confirmation, then a run and the run dialog's Templates step:
  // 5.9-18 s in measured runs (five workers), up to 59% of the 30 s per-test
  // limit. Slow triples the limit, a hang guard; every wait inside keeps
  // its own bound.
  test.slow();
  const { request } = await productAdminSession(playwright, PASSWORD);
  const file = templateFile();
  let doomed: TestTemplate;
  let kept: TestTemplate;
  try {
    doomed = await createTemplateThroughApi(request, { name: uniqueTemplateName(), receiverType: "otlp", signal: "logs", file });
    testTemplates.ids.push(doomed.id);
    kept = await createTemplateThroughApi(request, {
      name: uniqueTemplateName(),
      receiverType: "otlp",
      signal: "logs",
      file: templateFile(),
    });
    testTemplates.ids.push(kept.id);
  } finally {
    await request.dispose();
  }
  const path = await openMembersTestingTab(page);
  const suite = await createSuiteThroughApi(page, path, `Suite ${randomUUID()}`);
  await createDefinitionThroughApi(page, path, suite.id, { name: "Made from it", templateId: doomed.id });

  // The admin deletes it on their page.
  const adminPage = await secondContext.newPage();
  const adminErrors = pageErrors(adminPage);
  await signedInProductAdmin(adminPage);
  await openTestTemplatesAdmin(adminPage);
  await adminTemplateRow(adminPage, doomed.name).getByRole("button", { name: "Delete", exact: true }).click();
  const confirmation = adminPage.getByRole("dialog", { name: "Delete Test Template" });
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(adminTemplateRow(adminPage, doomed.name)).toHaveCount(0);
  await expect(adminTemplateRow(adminPage, kept.name)).toBeVisible();

  // The configuration made from it runs, from its own copy.
  await openSuitesSubtab(page);
  const card = suiteCard(page, suite.name);
  await expandSuite(page, card);
  await definitionRow(card, "Made from it").getByRole("button", { name: "Run test" }).click();
  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  await expectStatus(page, "Success");
  await expectBreadcrumbs(page, [breadcrumb(suite.name, "Made from it")], "Success");
  const [run] = await listRunsThroughApi(page, path);
  expect(run).toMatchObject({ status: "succeeded", inputName: file.name });
  const input = await page.request.get(`${versionApiPath(path)}/test-runs/${run!.id}/files/input`);
  expect((await input.body()).equals(file.buffer)).toBe(true);
  expect((await listDefinitionsThroughApi(page, path, suite.id)).map((definition) => definition.inputName)).toEqual([file.name]);

  // Gone from the member's Templates step, beside one still there.
  const dialog = await openRunDialog(page);
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await expect(templateRow(dialog, kept.name)).toBeVisible();
  await expect(templateRow(dialog, doomed.name)).toHaveCount(0);
  expect(adminErrors).toEqual([]);
});
