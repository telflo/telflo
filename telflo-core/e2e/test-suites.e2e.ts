import { randomUUID } from "node:crypto";
import { expect, test as base, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, TEST_RUN_QUEUE_FULL_MESSAGE } from "@telflo/contracts";
import {
  addMember,
  deleteTestTemplates,
  findConfigurationVersions,
  seedConfiguration,
  seedUser,
  type SeededUser,
} from "./support/database.js";
import { open } from "./support/editor-page.js";
import { heldRuns, releaseHeldRuns, waitForHeldRuns } from "./support/fake-otelcol-testing.js";
import { signInThroughApi, skipEditorTour, switchOrganizationThroughApi } from "./support/session.js";
import {
  configureAndRunButton,
  expectStatus,
  openTestingTab,
  otlpLogs,
  runRows,
  testingTab,
  testRunText,
  type PickedFile,
} from "./support/test-runs-page.js";
import {
  breadcrumb,
  createDefinitionThroughApi,
  createSuiteThroughApi,
  definitionDialog,
  definitionNames,
  definitionRow,
  expandSuite,
  expectBreadcrumbs,
  listDefinitionsThroughApi,
  listRunsThroughApi,
  listSuitesThroughApi,
  nameAndSaveDefinition,
  openSuitesSubtab,
  pasteAndSelectIn,
  pickTemplateIn,
  subtab,
  suiteCard,
  toastWith,
  uploadAndSelectIn,
  uploadTestFileThroughApi,
  versionApiPath,
  type VersionPath,
} from "./support/test-suites-page.js";
import { createTemplateThroughApi, productAdminSession, uniqueTemplateName } from "./support/test-templates-page.js";
import { createVersionFromPicker, versionPath } from "./support/versions-page.js";

// Test suites, in the browser: the Testing tab's Suites subtab, its
// suites and their test configurations (definitions), Play one and both Play
// alls, the runs' "Suite › Configuration" breadcrumb, a version copy, a
// teammate's view of a draft's suites and of a published one's, a
// teammate's own suite on a published one, and the refusals a Play all can
// meet, against the E2E API's dispatcher and the OpenAPI-checked fake tester
// (start-fake-otelcol-testing.ts).
//
// - Each test's text carries a token of its own; with the fake's `slow` marker
//   its runs are held until the test releases them through the fake's control
//   route (support/fake-otelcol-testing.ts), so a Play all's order shows: in
//   parallel all at once, serially one at a time. `collector-failed` makes
//   each run end Error, to show a serial Play all goes on past a failed step.
//   Every test holds at most 3 runs: the browsers' 5 workers stay under the
//   E2E API's 16 at once.
// - The 50-waiting cap is the API suite's: here a page.route answers two of
//   a Play all's three queue requests with the API's 429 and its words
//   and the person sees one toast.
// - Suites and definitions a test isn't about creating are created through
//   the API, as the page's session; the ones it is, through the subtab.
// - A test needing a template has a fresh product admin upload one through
//   the API, named `e2e-<uuid>`, and deletes it as the tables' owner when it
//   ends (templates are global).
// Each test works in organizations of its own, so tests and browsers run in
// parallel. A second person is a second browser context.

const PASSWORD = "correct horse battery staple";

/** `testTemplates`: the ids of the templates a test writes, deleted as the tables' owner when it ends, however it ends. */
const test = base.extend<{ testTemplates: string[] }>({
  context: async ({ context }, use) => {
    await skipEditorTour(context);
    await use(context);
  },
  // eslint-disable-next-line no-empty-pattern
  testTemplates: async ({}, use) => {
    const ids: string[] = [];
    await use(ids);
    await deleteTestTemplates(ids);
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

/** Each page error, as it happens: none is expected anywhere here. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** An OTLP logs file with a unique body, as a person picks it from their disk. */
function logsFile(name = `app-logs-${randomUUID()}.json`): PickedFile {
  return { name, mimeType: "application/json", buffer: Buffer.from(otlpLogs(`hello ${randomUUID()}`)) };
}

/** An OTLP traces envelope: on the `logs` pipeline, the fixture-shape check asks first (F-003). */
function tracesFile(): PickedFile {
  return {
    name: `spans-${randomUUID()}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [] }] }] })),
  };
}

interface SuitesWorkspace extends VersionPath {
  user: SeededUser;
  token: string;
}

/**
 * A user signed in on `page` with a draft configuration in their personal
 * organization, its text testRunText's (a `logs` pipeline) with a token of
 * this test's and the fake's markers asked for. The editor isn't opened.
 */
async function seedWorkspace(page: Page, markers: { slow?: boolean; failed?: boolean } = {}): Promise<SuitesWorkspace> {
  const user = await seedUser({ password: PASSWORD });
  const token = randomUUID();
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Suites ${randomUUID()}`,
    yamlContent: testRunText(token, markers),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, user);
  return { user, token, organizationId: user.organizationId, configurationId: configuration.id, versionId: version!.id };
}

/** A suite named `Suite <uuid>` on the version, with a definition per input (each uploaded to the session's test files first), in order. */
async function seedSuite(page: Page, path: VersionPath, inputs: { name: string; file: PickedFile }[]) {
  const suite = await createSuiteThroughApi(page, path, `Suite ${randomUUID()}`);
  const definitions = [];
  for (const input of inputs) {
    const inputFileId = await uploadTestFileThroughApi(page, path.organizationId, input.file);
    definitions.push(await createDefinitionThroughApi(page, path, suite.id, { name: input.name, inputFileId }));
  }
  return { suite, definitions };
}

/** The editor at the version, on its Testing tab's Suites subtab. */
async function openSuites(page: Page, path: VersionPath): Promise<void> {
  await open(page, versionPath(path.configurationId, path.versionId));
  await openTestingTab(page);
  await openSuitesSubtab(page);
}

/** The fixture-shape question. */
function mismatchDialog(page: Page) {
  return page.getByRole("dialog", { name: "Fixture may not match the receiver" });
}

/** The statuses of the version's runs, newest first, as the API holds them. */
async function runStatuses(page: Page, path: VersionPath): Promise<string[]> {
  return (await listRunsThroughApi(page, path)).map((run) => run.status);
}

/** Waits for the page's next read of the version's runs list (its poll). */
function nextRunsListRead(page: Page) {
  return page.waitForResponse((response) => response.request().method() === "GET" && /\/test-runs$/.test(new URL(response.url()).pathname));
}

test("a suite gets three test configurations, from an upload, a template and a paste; it is renamed and described; a configuration is deleted through its confirmation", async ({
  page,
  playwright,
  testTemplates,
}) => {
  // Three trips through the definition dialog, the last loading the paste
  // editor's Monaco: 17-21 s alone, and once 34 s in Firefox beside four
  // other workers, past the 30 s per-test limit at its paste. Slow triples
  // the limit, a hang guard; every wait inside keeps its own bound.
  test.slow();
  const errors = pageErrors(page);
  const { request } = await productAdminSession(playwright, PASSWORD);
  const templateFile = logsFile(`e2e-template-${randomUUID()}.json`);
  const template = await createTemplateThroughApi(request, {
    name: uniqueTemplateName(),
    receiverType: "otlp",
    signal: "logs",
    file: templateFile,
  }).finally(() => request.dispose());
  testTemplates.push(template.id);
  const path = await seedWorkspace(page);
  await openSuites(page, path);
  const suiteName = `Suite ${randomUUID()}`;
  const uploaded = logsFile();
  const pastedName = `pasted-${randomUUID()}`;
  const sample = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: `pasted ${randomUUID()}` } }] }] }] });

  // The suite, from +.
  await page.getByRole("button", { name: "Add suite", exact: true }).click();
  const created = page.getByRole("dialog", { name: "New suite" });
  await created.getByLabel("Name", { exact: true }).fill(suiteName);
  await created.getByLabel("Description", { exact: true }).fill("Checks the logs pipeline");
  await created.getByRole("button", { name: "Create", exact: true }).click();
  await expect(created).toBeHidden();
  const card = suiteCard(page, suiteName);
  await expect(card).toContainText("Checks the logs pipeline");
  await expandSuite(page, card);
  await expect(card.getByText("No test configurations yet.")).toBeVisible();

  // Its three test configurations: from an upload, a template and a paste.
  const dialog = definitionDialog(page);
  await card.getByRole("button", { name: "Add test configuration" }).click();
  await uploadAndSelectIn(page, dialog, uploaded);
  await nameAndSaveDefinition(dialog, "From an upload", "The uploaded file");
  await expect(definitionRow(card, "From an upload")).toBeVisible();

  await card.getByRole("button", { name: "Add test configuration" }).click();
  // No file is chosen when it opens.
  await expect(dialog.getByText("Selected File: None")).toBeVisible();
  await pickTemplateIn(dialog, template.name);
  await nameAndSaveDefinition(dialog, "From a template");
  await expect(definitionRow(card, "From a template")).toBeVisible();

  await card.getByRole("button", { name: "Add test configuration" }).click();
  await pasteAndSelectIn(page, dialog, pastedName, sample);
  await nameAndSaveDefinition(dialog, "From a paste");
  await expect(definitionNames(card)).toHaveText(["From an upload", "From a template", "From a paste"]);

  // Each kept its own copy of its input, on the pipeline chosen.
  const [suite] = (await listSuitesThroughApi(page, path))!;
  expect(suite).toMatchObject({ name: suiteName, description: "Checks the logs pipeline" });
  expect(
    (await listDefinitionsThroughApi(page, path, suite!.id)).map((definition) => [
      definition.name,
      definition.description,
      definition.inputName,
      definition.pipeline,
      definition.signal,
    ]),
  ).toEqual([
    ["From an upload", "The uploaded file", uploaded.name, "logs", "logs"],
    ["From a template", "", templateFile.name, "logs", "logs"],
    ["From a paste", "", `${pastedName}.json`, "logs", "logs"],
  ]);

  // Renamed and described.
  const renamed = `Renamed ${randomUUID()}`;
  await card.getByRole("button", { name: "Edit suite", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit suite" });
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(suiteName);
  await edit.getByLabel("Name", { exact: true }).fill(renamed);
  await edit.getByLabel("Description", { exact: true }).fill("Now checks everything");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  const renamedCard = suiteCard(page, renamed);
  await expect(renamedCard).toContainText("Now checks everything");
  await expect(suiteCard(page, suiteName)).toHaveCount(0);

  // A configuration deleted, through its confirmation.
  await definitionRow(renamedCard, "From a paste").getByRole("button", { name: "Delete test configuration" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Delete test configuration?" });
  await expect(confirmation).toContainText("Delete the test configuration From a paste?");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(definitionNames(renamedCard)).toHaveText(["From an upload", "From a template"]);

  expect((await listSuitesThroughApi(page, path))!.map((listed) => [listed.name, listed.description])).toEqual([
    [renamed, "Now checks everything"],
  ]);
  expect((await listDefinitionsThroughApi(page, path, suite!.id)).map((definition) => definition.name)).toEqual([
    "From an upload",
    "From a template",
  ]);
  expect(errors).toEqual([]);
});

test("Play one asks first, through the definition's head, when its input doesn't suit the pipeline; it switches to Tests once queued, the run carrying its breadcrumb", async ({
  page,
}) => {
  // Two head reads and their question, two runs, and the switch to Tests and
  // back: 9.3-19.4 s in measured runs (five workers), up to 65% of the 30 s
  // per-test limit. Slow triples the limit, a hang guard; every wait
  // inside keeps its own bound.
  test.slow();
  const errors = pageErrors(page);
  const path = await seedWorkspace(page);
  const traces = tracesFile();
  const logs = logsFile();
  const { suite, definitions } = await seedSuite(page, path, [
    { name: "Spans on logs", file: traces },
    { name: "Logs on logs", file: logs },
  ]);
  await openSuites(page, path);
  const card = suiteCard(page, suite.name);
  await expandSuite(page, card);
  const mismatch = mismatchDialog(page);

  // The definition's input head, read from the API, asks first: Cancel queues nothing and stays on Suites.
  const head = page.waitForResponse((response) => /\/definitions\/[^/]+\/input\/head$/.test(new URL(response.url()).pathname));
  await definitionRow(card, "Spans on logs").getByRole("button", { name: "Run test" }).click();
  expect((await head).status()).toBe(200);
  await expect(mismatch).toBeVisible();
  await expect(mismatch).toContainText("traces");
  await mismatch.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(mismatch).toBeHidden();
  await expect(subtab(page, "Suites")).toHaveAttribute("aria-selected", "true");
  expect(await listRunsThroughApi(page, path)).toEqual([]);

  // Run Anyway queues it: the Tests subtab, its row with the breadcrumb.
  await definitionRow(card, "Spans on logs").getByRole("button", { name: "Run test" }).click();
  await expect(mismatch).toBeVisible();
  await mismatch.getByRole("button", { name: "Run Anyway", exact: true }).click();
  await expect(mismatch).toBeHidden();
  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  await expectStatus(page, "Success");
  await expectBreadcrumbs(page, [breadcrumb(suite.name, "Spans on logs")], "Success");

  // A fixture that suits the pipeline is queued at once.
  await openSuitesSubtab(page);
  await expandSuite(page, suiteCard(page, suite.name));
  await definitionRow(suiteCard(page, suite.name), "Logs on logs").getByRole("button", { name: "Run test" }).click();
  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  await expectBreadcrumbs(page, [breadcrumb(suite.name, "Logs on logs"), breadcrumb(suite.name, "Spans on logs")]);
  await expectStatus(page, "Success");
  await expect(mismatch).toHaveCount(0);

  const runs = await listRunsThroughApi(page, path);
  expect(runs.map((run) => [run.status, run.suiteId, run.suiteName, run.definitionId, run.definitionName, run.inputName])).toEqual([
    ["succeeded", suite.id, suite.name, definitions[1]!.id, "Logs on logs", logs.name],
    ["succeeded", suite.id, suite.name, definitions[0]!.id, "Spans on logs", traces.name],
  ]);
  expect(errors).toEqual([]);
});

test("Play all in parallel queues the suite's three at once, asking nothing, each run with its breadcrumb; a double click still queues three", async ({
  page,
}) => {
  const path = await seedWorkspace(page, { slow: true });
  const names = ["First logs", "Second logs", "Spans"];
  const { suite } = await seedSuite(page, path, [
    { name: names[0]!, file: logsFile() },
    { name: names[1]!, file: logsFile() },
    // A traces envelope on the logs pipeline: a Play all asks no fixture question.
    { name: names[2]!, file: tracesFile() },
  ]);
  await openSuites(page, path);

  await suiteCard(page, suite.name).getByRole("button", { name: "Play all tests in parallel" }).dblclick();

  // All three held at once, by the fake, and no question.
  await waitForHeldRuns(path.token, 3);
  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  await expect(runRows(page)).toHaveCount(3);
  await expect(mismatchDialog(page)).toHaveCount(0);
  await expect(configureAndRunButton(page)).toBeDisabled();
  expect(await heldRuns(path.token)).toBe(3);

  expect(await releaseHeldRuns(path.token)).toBe(3);
  await expect.poll(() => runStatuses(page, path)).toEqual(["succeeded", "succeeded", "succeeded"]);
  // The double click's second click queued nothing more.
  const runs = await listRunsThroughApi(page, path);
  expect(runs.map((run) => run.definitionName).sort()).toEqual([...names].sort());
  expect(runs.every((run) => run.suiteId === suite.id && run.suiteName === suite.name)).toBe(true);
  await expect(runRows(page)).toHaveCount(3);
  for (const name of names) {
    const row = runRows(page).filter({ hasText: breadcrumb(suite.name, name) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Success");
  }
  await expect(configureAndRunButton(page)).toBeEnabled();
  expect(await heldRuns(path.token)).toBe(0);
});

test("Play all serially queues one at a time, in the suite's order, each after the last has ended, each with its breadcrumb", async ({
  page,
}) => {
  // Three runs released one by one, each step waiting for the page's next
  // read of the runs (its poll) as well as the fake: 13.3-22.1 s in measured
  // runs (five workers), up to 74% of the 30 s per-test limit. Slow
  // triples the limit, a hang guard; every wait inside keeps its own bound.
  test.slow();
  const path = await seedWorkspace(page, { slow: true });
  const names = ["Step one", "Step two", "Step three"];
  const { suite } = await seedSuite(
    page,
    path,
    names.map((name) => ({ name, file: logsFile() })),
  );
  await openSuites(page, path);

  await suiteCard(page, suite.name).getByRole("button", { name: "Play all tests serially" }).click();

  await waitForHeldRuns(path.token, 1);
  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  // Across two reads of the version's runs, still the one run, held.
  await nextRunsListRead(page);
  await nextRunsListRead(page);
  expect(await heldRuns(path.token)).toBe(1);
  expect((await listRunsThroughApi(page, path)).map((run) => run.definitionName)).toEqual(["Step one"]);
  await expectBreadcrumbs(page, [breadcrumb(suite.name, "Step one")]);

  // Released one by one: each next step is queued once the last has ended.
  for (const [index, name] of names.slice(1).entries()) {
    expect(await releaseHeldRuns(path.token)).toBe(1);
    await expect.poll(async () => (await listRunsThroughApi(page, path)).length).toBe(index + 2);
    await waitForHeldRuns(path.token, 1);
    await nextRunsListRead(page);
    expect(await heldRuns(path.token)).toBe(1);
    const runs = await listRunsThroughApi(page, path);
    expect(runs.map((run) => [run.definitionName, run.status])).toEqual([
      [name, "running"],
      ...names
        .slice(0, index + 1)
        .reverse()
        .map((earlier) => [earlier, "succeeded"]),
    ]);
  }
  expect(await releaseHeldRuns(path.token)).toBe(1);

  await expect.poll(() => runStatuses(page, path)).toEqual(["succeeded", "succeeded", "succeeded"]);
  expect((await listRunsThroughApi(page, path)).map((run) => run.definitionName)).toEqual(["Step three", "Step two", "Step one"]);
  await expectBreadcrumbs(
    page,
    ["Step three", "Step two", "Step one"].map((name) => breadcrumb(suite.name, name)),
    "Success",
  );
});

test("Play all serially goes on past a step that ends Error: each next one is queued after the failed one ends", async ({ page }) => {
  // Three runs released one by one, as the test above: up to 17.5 s in
  // measured runs (five workers), 58% of the 30 s per-test limit. Slow triples
  // the limit, a hang guard; every wait inside keeps its own bound.
  test.slow();
  const path = await seedWorkspace(page, { slow: true, failed: true });
  const names = ["Fails first", "Fails second", "Fails third"];
  const { suite } = await seedSuite(
    page,
    path,
    names.map((name) => ({ name, file: logsFile() })),
  );
  await openSuites(page, path);

  await suiteCard(page, suite.name).getByRole("button", { name: "Play all tests serially" }).click();

  await waitForHeldRuns(path.token, 1);
  for (const [index] of names.slice(1).entries()) {
    expect(await releaseHeldRuns(path.token)).toBe(1);
    await expect.poll(async () => (await listRunsThroughApi(page, path)).length).toBe(index + 2);
    // The step released ended Error, and the next is under way.
    expect((await runStatuses(page, path)).slice(1)).toEqual(Array(index + 1).fill("failed"));
    await waitForHeldRuns(path.token, 1);
  }
  expect(await releaseHeldRuns(path.token)).toBe(1);

  await expect.poll(() => runStatuses(page, path)).toEqual(["failed", "failed", "failed"]);
  expect((await listRunsThroughApi(page, path)).map((run) => run.definitionName)).toEqual(["Fails third", "Fails second", "Fails first"]);
  await expectBreadcrumbs(
    page,
    ["Fails third", "Fails second", "Fails first"].map((name) => breadcrumb(suite.name, name)),
    "Error",
  );
});

test("a Play all whose queue requests meet the 50-waiting cap shows one toast for the refusals, and queues the rest", async ({ page }) => {
  const errors = pageErrors(page);
  const path = await seedWorkspace(page);
  const { suite, definitions } = await seedSuite(page, path, [
    { name: "Refused one", file: logsFile() },
    { name: "Refused two", file: logsFile() },
    { name: "Queued", file: logsFile() },
  ]);
  const refused = new Set([definitions[0]!.id, definitions[1]!.id]);
  // The API's answer at the cap, for two of the three: the real cap is the
  // API suite's.
  await page.route(/\/test-runs$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !refused.has((request.postDataJSON() as { definitionId?: string }).definitionId ?? "")) {
      return route.fallback();
    }
    return route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "test_run_queue_full", message: TEST_RUN_QUEUE_FULL_MESSAGE } }),
    });
  });
  await openSuites(page, path);

  await suiteCard(page, suite.name).getByRole("button", { name: "Play all tests in parallel" }).click();

  await expect(toastWith(page, `2 of 3 test configurations weren't queued: ${TEST_RUN_QUEUE_FULL_MESSAGE}`)).toBeVisible();
  // One toast, updated in place, not one per refusal.
  await expect(toastWith(page, "of 3 test configuration")).toHaveCount(1);
  await expectStatus(page, "Success");
  await expectBreadcrumbs(page, [breadcrumb(suite.name, "Queued")], "Success");
  await page.unroute(/\/test-runs$/);
  expect((await listRunsThroughApi(page, path)).map((run) => [run.definitionId, run.status])).toEqual([[definitions[2]!.id, "succeeded"]]);
  expect(errors).toEqual([]);
});

test("a version created from one with a suite carries the suite and its configurations, which run there from their own copy of the input, still after the first version's suite is deleted", async ({
  page,
}) => {
  const path = await seedWorkspace(page);
  const file = logsFile();
  const { suite, definitions } = await seedSuite(page, path, [{ name: "Carried over", file }]);
  await open(page, versionPath(path.configurationId, path.versionId));

  await createVersionFromPicker(page);

  await expect.poll(async () => (await findConfigurationVersions(path.configurationId)).length).toBe(2);
  const [, second] = await findConfigurationVersions(path.configurationId);
  await expect(page).toHaveURL(versionPath(path.configurationId, second!.id));
  const copy: VersionPath = { ...path, versionId: second!.id };
  const [copiedSuite] = (await listSuitesThroughApi(page, copy))!;
  expect(copiedSuite).toMatchObject({ name: suite.name, versionId: second!.id });
  expect(copiedSuite!.id).not.toBe(suite.id);
  const [copiedDefinition] = await listDefinitionsThroughApi(page, copy, copiedSuite!.id);
  expect(copiedDefinition).toMatchObject({ name: "Carried over", inputName: file.name, pipeline: "logs" });
  expect(copiedDefinition!.id).not.toBe(definitions[0]!.id);

  // The first version's suite deleted, its configuration with it: the input
  // the copy shares stays while the copy's configuration uses it.
  const deleted = await page.request.delete(`${versionApiPath(path)}/test-suites/${suite.id}`, {
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(deleted.status()).toBe(204);
  expect(await listSuitesThroughApi(page, path)).toEqual([]);
  expect((await page.request.get(`${versionApiPath(path)}/test-suites/${suite.id}/definitions`)).status()).toBe(404);

  await openTestingTab(page);
  await openSuitesSubtab(page);
  const card = suiteCard(page, suite.name);
  await expandSuite(page, card);
  await definitionRow(card, "Carried over").getByRole("button", { name: "Run test" }).click();

  await expect(subtab(page, "Tests")).toHaveAttribute("aria-selected", "true");
  await expectStatus(page, "Success");
  await expectBreadcrumbs(page, [breadcrumb(suite.name, "Carried over")], "Success");
  const runs = await listRunsThroughApi(page, copy);
  expect(runs.map((run) => [run.suiteId, run.definitionId, run.inputName])).toEqual([[copiedSuite!.id, copiedDefinition!.id, file.name]]);
  // It ran the bytes uploaded for the first version's configuration, exactly.
  const input = await page.request.get(`${versionApiPath(copy)}/test-runs/${runs[0]!.id}/files/input`);
  expect(input.status()).toBe(200);
  expect((await input.body()).equals(file.buffer)).toBe(true);
  // The first version ran nothing.
  expect(await listRunsThroughApi(page, path)).toEqual([]);
  // Its suite stays deleted, the copy's untouched.
  expect(await listSuitesThroughApi(page, path)).toEqual([]);
  expect((await listSuitesThroughApi(page, copy))!.map((listed) => listed.id)).toEqual([copiedSuite!.id]);
});

test("a teammate sees nothing of a draft's suites, and runs the author's once published, still after the author deletes the file it came from", async ({
  page,
  browser,
}) => {
  // Two people, a draft's refusal, then two runs from the teammate's page:
  // 9.4-17.5 s in measured runs (five workers), up to 58% of the 30 s
  // per-test limit. Slow triples the limit, a hang guard; every wait inside
  // keeps its own bound.
  test.slow();
  const author = await seedUser({ password: PASSWORD });
  const teammate = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: author.userId, role: "admin" });
  await addMember({ userId: teammate.userId, organizationId: group.organizationId, role: "contributor" });
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    name: `Shared suites ${randomUUID()}`,
    yamlContent: testRunText(randomUUID()),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  const path: VersionPath = { organizationId: group.organizationId, configurationId: configuration.id, versionId: version!.id };
  const file = logsFile();

  // The author's suite, on the draft, from their own test file.
  await signInThroughApi(page, author);
  await switchOrganizationThroughApi(page, group.organizationId);
  const inputFileId = await uploadTestFileThroughApi(page, group.organizationId, file);
  const suite = await createSuiteThroughApi(page, path, `Suite ${randomUUID()}`);
  const definition = await createDefinitionThroughApi(page, path, suite.id, { name: "The author's", inputFileId });

  const teammateContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await skipEditorTour(teammateContext);
    const other = await teammateContext.newPage();
    const errors = pageErrors(other);
    await signInThroughApi(other, teammate);
    await switchOrganizationThroughApi(other, group.organizationId);

    // A draft: nothing of it, its suites included.
    expect(await listSuitesThroughApi(other, path)).toBeNull();
    expect((await other.request.get(`${versionApiPath(path)}/test-suites/${suite.id}/definitions`)).status()).toBe(404);
    await open(other, versionPath(configuration.id, version!.id));
    await expect(other.getByText("Configuration not found")).toBeVisible();
    await expect(testingTab(other)).toHaveCount(0);

    // Published: the teammate sees the suite and runs the author's configuration.
    const published = await page.request.post(`${versionApiPath(path)}/publish`, { headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } });
    expect(published.status()).toBe(200);
    await openSuites(other, path);
    const card = suiteCard(other, suite.name);
    await expandSuite(other, card);
    await definitionRow(card, "The author's").getByRole("button", { name: "Run test" }).click();
    await expect(subtab(other, "Tests")).toHaveAttribute("aria-selected", "true");
    await expectStatus(other, "Success");
    await expectBreadcrumbs(other, [breadcrumb(suite.name, "The author's")], "Success");

    // The author deletes the test file the configuration came from: it kept its own copy.
    const deleted = await page.request.delete(`/api/v1/organizations/${group.organizationId}/test-files/${inputFileId}`, {
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
    expect(deleted.status()).toBe(204);
    await openSuitesSubtab(other);
    await expandSuite(other, suiteCard(other, suite.name));
    await definitionRow(suiteCard(other, suite.name), "The author's").getByRole("button", { name: "Run test" }).click();
    await expect(subtab(other, "Tests")).toHaveAttribute("aria-selected", "true");
    await expect(runRows(other)).toHaveCount(2);
    await expect.poll(() => runStatuses(other, path)).toEqual(["succeeded", "succeeded"]);

    const runs = await listRunsThroughApi(other, path);
    expect(runs.map((run) => [run.queuedByUserId, run.definitionId, run.inputName])).toEqual([
      [teammate.userId, definition.id, file.name],
      [teammate.userId, definition.id, file.name],
    ]);
    expect(errors).toEqual([]);
  } finally {
    await teammateContext.close();
  }
});

test("on a published version, a teammate creates a suite, renames and describes it, adds a test configuration and deletes the suite, through the subtab", async ({
  page,
  browser,
}) => {
  // Two people, the teammate's page through the suite dialog twice, the
  // definition dialog's upload and a delete confirmation, each write checked
  // through the API: 9.3-18.8 s in measured runs, up to 63% of the 30 s
  // per-test limit. Slow triples the limit, a hang guard; every wait inside
  // keeps its own bound.
  test.slow();
  const author = await seedUser({ password: PASSWORD });
  const teammate = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: author.userId, role: "admin" });
  await addMember({ userId: teammate.userId, organizationId: group.organizationId, role: "contributor" });
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    name: `Teammate's suites ${randomUUID()}`,
    yamlContent: testRunText(randomUUID()),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  const path: VersionPath = { organizationId: group.organizationId, configurationId: configuration.id, versionId: version!.id };

  // The author publishes it; the author's session reads what the teammate writes.
  await signInThroughApi(page, author);
  await switchOrganizationThroughApi(page, group.organizationId);
  const published = await page.request.post(`${versionApiPath(path)}/publish`, { headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } });
  expect(published.status()).toBe(200);

  const teammateContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await skipEditorTour(teammateContext);
    const other = await teammateContext.newPage();
    const errors = pageErrors(other);
    await signInThroughApi(other, teammate);
    await switchOrganizationThroughApi(other, group.organizationId);
    await openSuites(other, path);

    // Created, from +.
    const suiteName = `Suite ${randomUUID()}`;
    await other.getByRole("button", { name: "Add suite", exact: true }).click();
    const created = other.getByRole("dialog", { name: "New suite" });
    await created.getByLabel("Name", { exact: true }).fill(suiteName);
    await created.getByRole("button", { name: "Create", exact: true }).click();
    await expect(created).toBeHidden();
    await expect(suiteCard(other, suiteName)).toBeVisible();
    const [suite] = (await listSuitesThroughApi(page, path))!;
    expect(suite).toMatchObject({ name: suiteName, description: "", versionId: version!.id, createdByUserId: teammate.userId });

    // Renamed and described.
    const renamed = `Renamed ${randomUUID()}`;
    await suiteCard(other, suiteName).getByRole("button", { name: "Edit suite", exact: true }).click();
    const edit = other.getByRole("dialog", { name: "Edit suite" });
    await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(suiteName);
    await edit.getByLabel("Name", { exact: true }).fill(renamed);
    await edit.getByLabel("Description", { exact: true }).fill("The teammate's checks");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(edit).toBeHidden();
    const card = suiteCard(other, renamed);
    await expect(card).toContainText("The teammate's checks");
    expect((await listSuitesThroughApi(page, path))!.map((listed) => [listed.id, listed.name, listed.description])).toEqual([
      [suite!.id, renamed, "The teammate's checks"],
    ]);

    // A test configuration, from the teammate's own upload.
    const file = logsFile();
    await expandSuite(other, card);
    await card.getByRole("button", { name: "Add test configuration" }).click();
    await uploadAndSelectIn(other, definitionDialog(other), file);
    await nameAndSaveDefinition(definitionDialog(other), "The teammate's", "Added on a published version");
    await expect(definitionNames(card)).toHaveText(["The teammate's"]);
    expect(
      (await listDefinitionsThroughApi(page, path, suite!.id)).map((definition) => [
        definition.name,
        definition.description,
        definition.inputName,
        definition.pipeline,
        definition.createdByUserId,
      ]),
    ).toEqual([["The teammate's", "Added on a published version", file.name, "logs", teammate.userId]]);

    // Deleted, through its confirmation, its configuration with it.
    await card.getByRole("button", { name: "Delete suite", exact: true }).click();
    const confirmation = other.getByRole("alertdialog", { name: "Delete test suite?" });
    await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(card).toHaveCount(0);
    await expect(other.getByText("No suites yet. Click + to create one.")).toBeVisible();
    expect(await listSuitesThroughApi(page, path)).toEqual([]);
    expect((await page.request.get(`${versionApiPath(path)}/test-suites/${suite!.id}/definitions`)).status()).toBe(404);

    // The version is still published: suites are test material, not its published content.
    const read = await page.request.get(versionApiPath(path));
    expect(read.status()).toBe(200);
    const { publishedAt } = ((await published.json()) as { version: { publishedAt: string | null } }).version;
    expect(publishedAt).not.toBeNull();
    expect(((await read.json()) as { version: { publishedAt: string | null } }).version.publishedAt).toBe(publishedAt);
    expect(errors).toEqual([]);
  } finally {
    await teammateContext.close();
  }
});

test("deleting a suite asks first, naming the suite; Cancel keeps it, Delete removes it and its configurations", async ({ page }) => {
  const path = await seedWorkspace(page);
  const { suite } = await seedSuite(page, path, [{ name: "Goes with it", file: logsFile() }]);
  await openSuites(page, path);
  const card = suiteCard(page, suite.name);
  const confirmation = page.getByRole("alertdialog", { name: "Delete test suite?" });

  await card.getByRole("button", { name: "Delete suite", exact: true }).click();
  await expect(confirmation).toContainText(`Really delete the test suite ${suite.name} and all related test definitions?`);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(card).toBeVisible();
  // Focus back on the button that opened it, not on <body>.
  await expect(card.getByRole("button", { name: "Delete suite", exact: true })).toBeFocused();

  await card.getByRole("button", { name: "Delete suite", exact: true }).click();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(confirmation).toBeHidden();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("No suites yet. Click + to create one.")).toBeVisible();
  expect(await listSuitesThroughApi(page, path)).toEqual([]);
  expect((await page.request.get(`${versionApiPath(path)}/test-suites/${suite.id}/definitions`)).status()).toBe(404);
});
