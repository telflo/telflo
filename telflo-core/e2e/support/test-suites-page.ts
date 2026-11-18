import { expect, type Locator, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, type TestDefinition, type TestRunDetail, type TestSuite } from "@telflo/contracts";
import { runRows, type PickedFile } from "./test-runs-page.js";

// The Testing tab's Suites subtab (D14b Tasks 6 and 7) in the browser: its
// suites' cards, their definitions, the definition dialog ("New test
// configuration", which shares the run dialog's panel), Play one and the
// Play alls; and the suites' API, for tests about something after creating.
// Shared by test-suites.e2e.ts, test-templates.e2e.ts and the privacy
// reviews' scratch specs.
//
// The definition dialog slides between three slots, as the run dialog does
// (support/test-runs-page.ts); the ones slid away are inert and hidden from
// assistive technology. Its main view has a Name field, and so do the upload
// and paste panels, so a field is found in the slot in view (`shownSlot`).

/** Where a version's suites live: its organization, configuration and version. */
export interface VersionPath {
  organizationId: string;
  configurationId: string;
  versionId: string;
}

/** The version's address in the API. */
export function versionApiPath({ organizationId, configurationId, versionId }: VersionPath): string {
  return `/api/v1/organizations/${organizationId}/configurations/${configurationId}/versions/${versionId}`;
}

const CSRF = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };

/** The Testing tab's subtab. */
export function subtab(page: Page, name: "Tests" | "Validation" | "Suites"): Locator {
  return page.getByRole("tab", { name, exact: true });
}

/** Opens the Suites subtab (the Testing tab already open) and waits for its suites to be read. */
export async function openSuitesSubtab(page: Page): Promise<void> {
  await subtab(page, "Suites").click();
  await expect(subtab(page, "Suites")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("status", { name: "Loading test suites" })).toHaveCount(0);
}

/** The suite card whose header shows `name`. */
export function suiteCard(page: Page, name: string): Locator {
  return page.locator("li").filter({ has: page.locator("button[aria-expanded]", { hasText: name }) });
}

/** Expands the card (if it isn't) and waits for its definitions to be read. */
export async function expandSuite(page: Page, card: Locator): Promise<void> {
  const header = card.locator("button[aria-expanded]");
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByRole("status", { name: "Loading test configurations" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Add test configuration" })).toBeVisible();
}

/** A definition's row in an expanded card, by its name. */
export function definitionRow(card: Locator, name: string): Locator {
  return card
    .locator("li")
    .filter({ has: card.page().getByRole("button", { name: "Run test", exact: true }) })
    .filter({ has: card.page().getByText(name, { exact: true }) });
}

/** The definitions' names in an expanded card, in its order. */
export function definitionNames(card: Locator): Locator {
  return card
    .locator("li")
    .filter({ has: card.page().getByRole("button", { name: "Run test", exact: true }) })
    .locator("span[id]");
}

/** The definition dialog. */
export function definitionDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "New test configuration" });
}

/** The slot of a sliding dialog (the run dialog or the definition dialog) in view: the one that isn't inert. */
export function shownSlot(dialog: Locator): Locator {
  return dialog.locator("[data-run-dialog-slot]:not([inert])");
}

/** In an open sliding dialog: My Files, Upload, the file picked and uploaded, then highlighted and confirmed, back on the main view with it selected. */
export async function uploadAndSelectIn(page: Page, dialog: Locator, file: PickedFile): Promise<void> {
  await dialog.getByRole("button", { name: "My Files", exact: true }).click();
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Upload Test File" })).toBeVisible();
  await shownSlot(dialog).locator('input[type="file"]').setInputFiles(file);
  await expect(shownSlot(dialog).getByLabel("Name", { exact: true })).toHaveValue(file.name);
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("File uploaded", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: file.name, exact: true }).click();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog.getByText(`Selected File: ${file.name}`)).toBeVisible();
}

/** In an open sliding dialog: Paste Text, the name, the sample inserted as one text, Use Sample, back on the main view with it selected. */
export async function pasteAndSelectIn(page: Page, dialog: Locator, displayName: string, sample: string): Promise<void> {
  await dialog.getByRole("button", { name: "Paste Text", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Paste Test Sample" })).toBeVisible();
  await shownSlot(dialog).getByLabel("Name", { exact: true }).fill(displayName);
  const editor = dialog.locator(".monaco-editor");
  await expect(editor).toBeVisible();
  await editor.locator(".view-lines").click();
  await expect(dialog.locator(".monaco-editor.focused")).toHaveCount(1);
  await page.keyboard.insertText(sample);
  await expect(dialog.getByRole("button", { name: "Use Sample", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Use Sample", exact: true }).click();
  await expect(page.getByText("Sample saved to My Files", { exact: true })).toBeVisible();
  await expect(dialog.getByText(`Selected File: ${displayName}`)).toBeVisible();
}

/** The Templates step's row of the template named `name` (the row highlights it). */
export function templateRow(dialog: Locator, name: string): Locator {
  return dialog.getByRole("button", { name, exact: true });
}

/** In an open sliding dialog: Templates, the template named `name` highlighted, OK, back on the main view with it selected. */
export async function pickTemplateIn(dialog: Locator, name: string): Promise<void> {
  await dialog.getByRole("button", { name: "Templates", exact: true }).click();
  await templateRow(dialog, name).click();
  await expect(templateRow(dialog, name)).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog.getByText(`Selected File: ${name}`)).toBeVisible();
}

/** In the definition dialog's main view, its input chosen: the name and description, then OK; the dialog closes. */
export async function nameAndSaveDefinition(dialog: Locator, name: string, description = ""): Promise<void> {
  await shownSlot(dialog).getByLabel("Name", { exact: true }).fill(name);
  if (description !== "") await shownSlot(dialog).getByLabel("Description", { exact: true }).fill(description);
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The breadcrumb a suite's run carries in its row: "Suite › Configuration". */
export function breadcrumb(suiteName: string, definitionName: string): string {
  return `${suiteName} › ${definitionName}`;
}

/** Exactly as many run rows as `breadcrumbs`, newest first, each showing its breadcrumb (and `status`, when given). */
export async function expectBreadcrumbs(page: Page, breadcrumbs: string[], status?: "Success" | "Error"): Promise<void> {
  await expect(runRows(page)).toHaveCount(breadcrumbs.length);
  for (const [index, words] of breadcrumbs.entries()) {
    await expect(runRows(page).nth(index)).toContainText(words);
    if (status !== undefined) await expect(runRows(page).nth(index)).toContainText(status);
  }
}

/** A toast by its text. */
export function toastWith(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

// ── The API, as the page's session ────────────────────────────────────────

/** Uploads a test file to the session's organization, as the run dialog does; resolves to its id. */
export async function uploadTestFileThroughApi(page: Page, organizationId: string, file: PickedFile): Promise<string> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/test-files`, {
    multipart: { displayName: file.name, description: "", file },
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { file: { id: string } }).file.id;
}

/** Creates a suite on the version, as the Suites subtab does. */
export async function createSuiteThroughApi(page: Page, path: VersionPath, name: string, description = ""): Promise<TestSuite> {
  const response = await page.request.post(`${versionApiPath(path)}/test-suites`, { data: { name, description }, headers: CSRF });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { suite: TestSuite }).suite;
}

/** Creates a definition in the suite from one of the session's test files or a template, on the `logs` pipeline, as the definition dialog does. */
export async function createDefinitionThroughApi(
  page: Page,
  path: VersionPath,
  suiteId: string,
  { name, inputFileId, templateId }: { name: string; inputFileId?: string; templateId?: string },
): Promise<TestDefinition> {
  const response = await page.request.post(`${versionApiPath(path)}/test-suites/${suiteId}/definitions`, {
    data: {
      ...(inputFileId === undefined ? {} : { inputFileId }),
      ...(templateId === undefined ? {} : { templateId }),
      name,
      pipeline: "logs",
      signal: "logs",
      durationSeconds: 5,
    },
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { definition: TestDefinition }).definition;
}

/** The version's suites as the page's session sees them; null when the API answers 404 (a draft not theirs). */
export async function listSuitesThroughApi(page: Page, path: VersionPath): Promise<TestSuite[] | null> {
  const response = await page.request.get(`${versionApiPath(path)}/test-suites`);
  if (response.status() === 404) return null;
  expect(response.status()).toBe(200);
  return ((await response.json()) as { suites: TestSuite[] }).suites;
}

/** The suite's definitions as the page's session sees them. */
export async function listDefinitionsThroughApi(page: Page, path: VersionPath, suiteId: string): Promise<TestDefinition[]> {
  const response = await page.request.get(`${versionApiPath(path)}/test-suites/${suiteId}/definitions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { definitions: TestDefinition[] }).definitions;
}

/** A listed run's fields these tests read. */
export interface ListedRun {
  id: string;
  status: string;
  queuedByUserId: string;
  inputName: string;
  suiteId: string | null;
  suiteName: string | null;
  definitionId: string | null;
  definitionName: string | null;
}

/** The version's runs as the page's session sees them, newest first. */
export async function listRunsThroughApi(page: Page, path: VersionPath): Promise<ListedRun[]> {
  const response = await page.request.get(`${versionApiPath(path)}/test-runs`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { runs: ListedRun[] }).runs;
}

/** One run as the page's session reads it. */
export async function readRunThroughApi(page: Page, path: VersionPath, runId: string): Promise<TestRunDetail> {
  const response = await page.request.get(`${versionApiPath(path)}/test-runs/${runId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { run: TestRunDetail }).run;
}
