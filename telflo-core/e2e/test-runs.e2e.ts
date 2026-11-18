import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE,
  TESTING_UNAVAILABLE_MESSAGE,
  VARIABLES_UNAVAILABLE_MESSAGE,
  VARIABLES_UNAVAILABLE_RUN_MESSAGE,
} from "@telflo/contracts";
import { addMember, findConfigurationVersions, seedConfiguration, seedUser, type SeededUser } from "./support/database.js";
import { downloaded } from "./support/downloads.js";
import { open, openYamlTab, tab, typeLineAtTop } from "./support/editor-page.js";
import { releaseHeldRuns, waitForHeldRuns } from "./support/fake-otelcol-testing.js";
import { signInThroughApi, skipEditorTour, switchOrganizationThroughApi } from "./support/session.js";
import {
  ariaContainers,
  clickRun,
  configureAndRunButton,
  expectStatus,
  liveRegionNodes,
  openRunDialog,
  openTestingTab,
  otlpLogs,
  pasteAndSelect,
  rerunButtons,
  results,
  resultsDialog,
  runDialog,
  runDialogTrack,
  runRows,
  selectFromMyFiles,
  testingTab,
  testRunText,
  uploadAndSelect,
  type PickedFile,
} from "./support/test-runs-page.js";
import { versionPath } from "./support/versions-page.js";
import { canaryVariableValue, filledInValue } from "./support/privacy.js";
import { createVariableThroughApi, uniqueVariableName } from "./support/variables.js";

// Test runs (D14a), in the browser: the editor's Testing tab, its run
// dialog, the version's runs and their results, against the E2E API's
// dispatcher and the OpenAPI-checked fake tester (start-fake-otelcol-testing.ts).
//
// - The fake answers by the text: none of its markers, a success whose
//   output (and decoded input) is the input's own bytes; `slow`, held
//   unanswered until the test releases it through the fake's control route
//   (support/fake-otelcol-testing.ts, D14a Ruling 36). Each test's text
//   carries a token of its own, so it releases only its own runs: the
//   browsers' workers share the fake.
// - The E2E API runs 16 at once (Preflight ruling 20), so a run is claimed
//   at once: "Queued" is what the queue's answer shows until the first read
//   of the list, which these tests hold with page.route until they have seen
//   it. "n ahead" is the API suite's.
// - The tester down is a page.route answering the queue 503 (Preflight
//   ruling 20): the real down state is global, and would refuse every
//   worker's runs. The real refusal is the API suite's.
// - Downloads are read back from the browser's own file, byte for byte.
// - Every Monaco here (the viewers, Compare, the paste editor) puts its
//   screen-reader live region in the app shell's one `ph-no-capture` host,
//   which outlives every viewer (Preflight ruling 14, Ruling 48): checked
//   with each one open, and after they close.
// Each test works in organizations of its own, so tests and browsers run in
// parallel. A second person is a second browser context.

const PASSWORD = "correct horse battery staple";

test.use({ viewport: { width: 1440, height: 1000 } });

test.beforeEach(async ({ context }) => {
  await skipEditorTour(context);
});

/** Each page error, as it happens: none is expected anywhere here. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

interface SeededRun {
  user: SeededUser;
  token: string;
  configurationId: string;
  versionId: string;
}

/**
 * A user signed in with a draft configuration in their personal organization,
 * its text testRunText's (a `logs` pipeline) with a token of this test's, and
 * the editor open on its Testing tab.
 */
async function openSeededTestingTab(page: Page, { slow = false }: { slow?: boolean } = {}): Promise<SeededRun> {
  const user = await seedUser({ password: PASSWORD });
  const token = randomUUID();
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Testing ${randomUUID()}`,
    yamlContent: testRunText(token, { slow }),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await signInThroughApi(page, user);
  await open(page, versionPath(configuration.id, version!.id));
  await openTestingTab(page);
  await expect(page.getByText("No test runs yet for this version.")).toBeVisible();
  return { user, token, configurationId: configuration.id, versionId: version!.id };
}

function runsUrl(run: { user: { organizationId: string }; configurationId: string; versionId: string }): string {
  return `/api/v1/organizations/${run.user.organizationId}/configurations/${run.configurationId}/versions/${run.versionId}/test-runs`;
}

/** An OTLP logs file with a unique body, as a person picks it from their disk. */
function logsFile(name = `app-logs-${randomUUID()}.json`): PickedFile {
  return { name, mimeType: "application/json", buffer: Buffer.from(otlpLogs(`hello ${randomUUID()}`)) };
}

/** Holds every read of the version's runs list until released (the queue's POST and everything else pass). */
async function holdRunsList(page: Page): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const listUrl = /\/test-runs$/;
  await page.route(listUrl, async (route) => {
    if (route.request().method() === "GET") await opened;
    await route.fallback();
  });
  return {
    release: async () => {
      open();
      await page.unroute(listUrl);
    },
  };
}

/** The multipart POST a click sends to `pathSuffix`. */
function multipartRequest(page: Page, pathSuffix: string): Promise<Request> {
  return page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith(pathSuffix));
}

/** The body's part named `name`: its headers and its content, as text. */
function partOf(body: Buffer, boundary: string, name: string): { headers: string; content: string } | undefined {
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const headers = part.slice(0, split);
    if (!new RegExp(`name="${name}"`).test(headers)) continue;
    return { headers, content: part.slice(split + 4).replace(/\r\n$/, "") };
  }
  return undefined;
}

/**
 * Expects a real browser's multipart upload (D14a Ruling 43(4)): the content
 * type the browser wrote, with its boundary (the client never sets it), and
 * the API's 201 for it, naming the file, its type and its exact bytes (size
 * and SHA-256). Where the browser exposes the body to Playwright, the parts
 * are checked too: in the API's order, the file part named and typed.
 * Chromium exposes no multipart body; Firefox exposes it whole, the file's
 * bytes included; WebKit exposes its parts without the file part's bytes
 * (probed in each, D14a Ruling 47). The bytes themselves are checked by the
 * API's size and SHA-256 in every browser.
 */
async function expectMultipartUpload(
  request: Request,
  file: { fileName: string; contentType: string; bytes: Buffer; displayName: string },
): Promise<void> {
  const contentType = request.headers()["content-type"] ?? "";
  const boundary = /^multipart\/form-data; ?boundary=(.+)$/.exec(contentType)?.[1];
  expect(boundary, `content type ${contentType}`).toBeTruthy();
  const response = await request.response();
  expect(response?.status()).toBe(201);
  expect(((await response!.json()) as { file: unknown }).file).toMatchObject({
    displayName: file.displayName,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  });
  const body = request.postDataBuffer();
  test.info().annotations.push({ type: "multipart parts", description: body === null ? "not exposed by this browser" : "checked" });
  if (body === null) return;
  const names = [...body.toString("latin1").matchAll(/Content-Disposition: form-data; name="([^"]+)"/gi)].map((match) => match[1]);
  expect(names).toEqual(["displayName", "description", "file"]);
  expect(partOf(body, boundary!, "displayName")?.content).toBe(file.displayName);
  const filePart = partOf(body, boundary!, "file");
  expect(filePart?.headers).toContain(`filename="${file.fileName}"`);
  expect(filePart?.headers).toMatch(new RegExp(`Content-Type: ${file.contentType.replace("/", "\\/")}`, "i"));
}

/** Reads a run as the page's session: what the API stored. */
async function readRun(page: Page, seeded: SeededRun, runId: string) {
  const response = await page.request.get(`${runsUrl(seeded)}/${runId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { run: Record<string, unknown> & { id: string; status: string; inputName: string } }).run;
}

/** The version's runs as the page's session sees them, newest first. */
async function listRuns(page: Page, seeded: SeededRun): Promise<{ id: string; status: string; queuedByUserId: string }[]> {
  const response = await page.request.get(runsUrl(seeded));
  expect(response.status()).toBe(200);
  return ((await response.json()) as { runs: { id: string; status: string; queuedByUserId: string }[] }).runs;
}

test("an upload runs: Queued, then Running, then Success, with its results, and the browser sends a multipart upload", async ({ page }) => {
  const errors = pageErrors(page);
  const seeded = await openSeededTestingTab(page, { slow: true });
  const file = logsFile();

  await openRunDialog(page);
  const upload = multipartRequest(page, "/test-files");
  await uploadAndSelect(page, file);
  // D14a Ruling 43(4): the browser writes the content type with its boundary
  // (the client never sets it), and the parts go in the API's order.
  await expectMultipartUpload(await upload, { fileName: file.name, contentType: "application/json", bytes: file.buffer, displayName: file.name });

  const list = await holdRunsList(page);
  await clickRun(page);

  await expect(runDialog(page)).toBeHidden();
  await expectStatus(page, "Queued");
  await expect(runRows(page)).toHaveCount(1);
  await expect(runRows(page).first()).toContainText(/Queued/);
  await list.release();

  // The fake holds the run (its text's `slow` marker): Running, and Play and ↺ held meanwhile.
  await waitForHeldRuns(seeded.token);
  await expectStatus(page, "Running");
  await expect(configureAndRunButton(page)).toBeDisabled();
  await expect(rerunButtons(page).first()).toBeDisabled();

  expect(await releaseHeldRuns(seeded.token)).toBe(1);
  await expectStatus(page, "Success");
  await expect(runRows(page).first()).toContainText("Success");
  await expect(configureAndRunButton(page)).toBeEnabled();

  // The results: the pipeline, the texts, the mutation the fake reports, the logs, the files and Compare.
  const shown = results(page);
  await expect(shown.getByText("logs", { exact: true })).toBeVisible();
  for (const link of ["Original YAML", "Test YAML", "Mutations (1)", "Logs"]) {
    await expect(shown.getByRole("button", { name: link, exact: true })).toBeVisible();
  }
  await expect(shown.getByRole("button", { name: file.name, exact: true })).toBeVisible();
  await expect(shown.getByRole("button", { name: "test-output.json", exact: true })).toBeVisible();
  await expect(shown.getByRole("button", { name: "Compare input ↔ output" })).toBeEnabled();
  const [run] = await listRuns(page, seeded);
  expect(run).toMatchObject({ status: "succeeded", queuedByUserId: seeded.user.userId });
  expect(await readRun(page, seeded, run!.id)).toMatchObject({ inputName: file.name, pipeline: "logs", signal: "logs" });
  expect(errors).toEqual([]);
});

test("a pasted sample is saved to My Files, selected and run, sent as a multipart sample typed by its format", async ({ page }) => {
  const errors = pageErrors(page);
  const seeded = await openSeededTestingTab(page);
  const name = `pasted-${randomUUID()}`;
  const sample = JSON.stringify({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: `pasted ${randomUUID()}` } }] }] }],
  });

  await openRunDialog(page);
  const saved = multipartRequest(page, "/test-files/samples");
  await pasteAndSelect(page, name, sample);
  await expectMultipartUpload(await saved, { fileName: `${name}.json`, contentType: "application/json", bytes: Buffer.from(sample), displayName: name });
  // The paste editor's live region is the page's one, in the shell's replay-blocked host (Ruling 48).
  expect(await ariaContainers(page)).toEqual([{ blocked: true, inShellHost: true }]);

  await clickRun(page);

  await expectStatus(page, "Success");
  await expect(results(page).getByRole("button", { name: `${name}.json`, exact: true })).toBeVisible();
  // The sample is in My Files, for the next run.
  await openRunDialog(page);
  await runDialog(page).getByRole("button", { name: "My Files", exact: true }).click();
  await expect(runDialog(page).getByRole("button", { name, exact: true })).toBeVisible();
  const [run] = await listRuns(page, seeded);
  const downloadedInput = await page.request.get(`${runsUrl(seeded)}/${run!.id}/files/input`);
  expect(await downloadedInput.text()).toBe(sample);
  expect(errors).toEqual([]);
});

test("a fixture that doesn't suit the pipeline asks first: Cancel queues nothing, Run Anyway queues it and it runs", async ({ page }) => {
  const seeded = await openSeededTestingTab(page);
  // A traces envelope for the logs pipeline: F-003.
  const traces: PickedFile = {
    name: `spans-${randomUUID()}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [] }] }] })),
  };
  await openRunDialog(page);
  await uploadAndSelect(page, traces);
  const mismatch = page.getByRole("dialog", { name: "Fixture may not match the receiver" });

  await clickRun(page);
  await expect(mismatch).toBeVisible();
  await expect(mismatch).toContainText("traces");
  await mismatch.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(mismatch).toBeHidden();
  await expect(page.getByText("No test runs yet for this version.")).toBeVisible();
  expect(await listRuns(page, seeded)).toEqual([]);

  await openRunDialog(page);
  await expect(runDialog(page).getByText(`Selected File: ${traces.name}`)).toBeVisible();
  await clickRun(page);
  await expect(mismatch).toBeVisible();
  await mismatch.getByRole("button", { name: "Run Anyway", exact: true }).click();

  await expect(mismatch).toBeHidden();
  await expectStatus(page, "Success");
  expect(await listRuns(page, seeded)).toHaveLength(1);
});

test("each viewer and Compare open with no page error, Monaco's live region in the shell's block, and download the exact bytes, UTF-16 too", async ({
  page,
}) => {
  // Each viewer's and Compare's Monaco, and their downloads: 13.2-18.6 s in
  // D14b Task 9's full runs (five workers), 12.7-22.7 s in D14b's final fix
  // wave's runs of the four files it touched, up to 76% of the 30 s
  // per-test limit. Slow triples the limit, a hang guard; every wait inside
  // keeps its own bound.
  test.slow();
  const errors = pageErrors(page);
  const seeded = await openSeededTestingTab(page);
  // UTF-16LE with its byte-order mark: kept as bytes end to end (Preflight ruling 14).
  const text = otlpLogs(`utf-16 ${randomUUID()} é ✓`);
  const utf16: PickedFile = {
    name: `utf16-${randomUUID()}.json`,
    mimeType: "application/json",
    buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
  };
  await openRunDialog(page);
  await uploadAndSelect(page, utf16);
  await clickRun(page);
  // Its first bytes don't read as JSON in UTF-8, so the check asks: run it anyway.
  const mismatch = page.getByRole("dialog", { name: "Fixture may not match the receiver" });
  await expect(mismatch).toBeVisible();
  await mismatch.getByRole("button", { name: "Run Anyway", exact: true }).click();
  await expectStatus(page, "Success");
  const [listed] = await listRuns(page, seeded);
  const run = await readRun(page, seeded, listed!.id);
  const shown = results(page);

  /** Opens a viewer from the results, checks it, and closes it. */
  const view = async (open: string, title: string | RegExp, check: (dialog: ReturnType<typeof resultsDialog>) => Promise<void>) => {
    await shown.getByRole("button", { name: open, exact: true }).click();
    const dialog = resultsDialog(page, title);
    await expect(dialog).toBeVisible();
    await check(dialog);
    expect(errors).toEqual([]);
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog).toBeHidden();
  };
  /**
   * The Monaco inside `dialog` shows `words`, and the page's one live region
   * is in the shell's replay-blocked host (Ruling 48), not in the dialog,
   * which takes its own with it when it closes.
   */
  const monacoShows = async (dialog: ReturnType<typeof resultsDialog>, words: string) => {
    await expect(dialog.locator(".monaco-editor .view-lines")).toContainText(words);
    expect(await ariaContainers(page)).toEqual([{ blocked: true, inShellHost: true }]);
  };

  await view("Original YAML", "Original YAML", (dialog) => monacoShows(dialog, `e2e-run: ${seeded.token}`));
  await view("Test YAML", "Test YAML (after sandbox mutations)", (dialog) => monacoShows(dialog, `e2e-run: ${seeded.token}`));
  await view("Mutations (1)", "Sandbox mutations", async (dialog) => {
    await expect(dialog).toContainText("R-001");
  });
  await view("Logs", "Collector logs (stderr)", async (dialog) => {
    await monacoShows(dialog, "payloads sent");
    const logs = await downloaded(page, () => dialog.getByRole("button", { name: "Download", exact: true }).click());
    expect(logs.name).toBe("collector-logs.txt");
    expect(logs.bytes.toString("utf8")).toBe(String(run.logs).trim());
  });
  // The input, decoded from UTF-16 for the viewer, downloads as its own bytes.
  await view(utf16.name, utf16.name, async (dialog) => {
    await monacoShows(dialog, "resourceLogs");
    await expect(dialog.locator(".monaco-editor .view-lines")).toContainText("é ✓");
    const input = await downloaded(page, () => dialog.getByRole("button", { name: "Download", exact: true }).click());
    expect(input.name).toBe(utf16.name);
    expect(input.bytes.equals(utf16.buffer)).toBe(true);
  });
  await view("test-output.json", "Test output", async (dialog) => {
    await monacoShows(dialog, "resourceLogs");
    const output = await downloaded(page, () => dialog.getByRole("button", { name: "Download", exact: true }).click());
    expect(output.name).toBe("test-output.json");
    expect(output.bytes.equals(utf16.buffer)).toBe(true);
  });
  await view("Compare input ↔ output", "Compare input ↔ output", async (dialog) => {
    const diff = dialog.locator(".monaco-diff-editor");
    await expect(diff).toBeVisible();
    await expect(diff.locator(".editor.original .view-lines")).toContainText("é ✓");
    await expect(diff.locator(".editor.modified .view-lines")).toContainText("é ✓");
    expect(await ariaContainers(page)).toEqual([{ blocked: true, inShellHost: true }]);
  });
  // Every viewer closed: the live region is still in the page, in the shell's host.
  expect(await ariaContainers(page)).toEqual([{ blocked: true, inShellHost: true }]);

  // The file rows' own downloads, outside the viewers.
  const fromRow = await downloaded(page, () => shown.getByRole("button", { name: `Download ${utf16.name}`, exact: true }).click());
  expect(fromRow.bytes.equals(utf16.buffer)).toBe(true);
  const outputFromRow = await downloaded(page, () => shown.getByRole("button", { name: "Download test-output.json", exact: true }).click());
  expect(outputFromRow.bytes.equals(utf16.buffer)).toBe(true);
  expect(errors).toEqual([]);
});

test("Compare shows the OTLP sent in beside the OTLP that came out", async ({ page }) => {
  await openSeededTestingTab(page);
  const body = `compare ${randomUUID()}`;
  await openRunDialog(page);
  await uploadAndSelect(page, { name: `compare-${randomUUID()}.json`, mimeType: "application/json", buffer: Buffer.from(otlpLogs(body)) });
  await clickRun(page);
  await expectStatus(page, "Success");

  await results(page).getByRole("button", { name: "Compare input ↔ output" }).click();
  const dialog = resultsDialog(page, "Compare input ↔ output");
  const diff = dialog.locator(".monaco-diff-editor");
  await expect(diff).toBeVisible();
  // Pretty-printed, both sides: the fake's output is its input.
  await expect(diff.locator(".editor.original .view-lines")).toContainText(`"stringValue": "${body}"`);
  await expect(diff.locator(".editor.modified .view-lines")).toContainText(`"stringValue": "${body}"`);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toBeHidden();
});

test("↺ re-runs a run from its own input against the current text, and the list shows both", async ({ page }) => {
  const seeded = await openSeededTestingTab(page);
  const file = logsFile();
  await openRunDialog(page);
  await uploadAndSelect(page, file);
  await clickRun(page);
  await expectStatus(page, "Success");
  const [first] = await listRuns(page, seeded);

  await rerunButtons(page).first().click();

  await expect(runRows(page)).toHaveCount(2);
  await expectStatus(page, "Success");
  await expect(runRows(page).nth(0)).toContainText("Success");
  await expect(runRows(page).nth(1)).toContainText("Success");
  const runs = await listRuns(page, seeded);
  expect(runs).toHaveLength(2);
  const rerun = await readRun(page, seeded, runs[0]!.id);
  expect(rerun.id).not.toBe(first!.id);
  expect(rerun).toMatchObject({ inputName: file.name, pipeline: "logs", yaml: testRunText(seeded.token) });
  const input = await page.request.get(`${runsUrl(seeded)}/${rerun.id}/files/input`);
  expect((await input.body()).equals(file.buffer)).toBe(true);
});

test("the Testing tab is disabled in manual edit mode, as Configuration is, and enabled again after Undo All", async ({ page }) => {
  await openSeededTestingTab(page);
  await openYamlTab(page);

  await typeLineAtTop(page, "# typed");

  await expect(page.getByText("Entered manual edit mode")).toBeVisible();
  await expect(tab(page, "Configuration")).toBeDisabled();
  await expect(testingTab(page)).toBeDisabled();

  await page.getByRole("button", { name: "Undo All" }).click();

  await expect(tab(page, "Configuration")).toBeEnabled();
  await expect(testingTab(page)).toBeEnabled();
  await openTestingTab(page);
  await expect(configureAndRunButton(page)).toBeEnabled();
});

test("a teammate sees nothing of a draft's runs, and everything once it is published: the run, its input, and a re-run of it", async ({
  page,
  browser,
}) => {
  // Two people, each opening the editor, a run, a viewer's Monaco and a
  // re-run: 15.4-22.7 s in D14b Task 9's full runs (five workers), and once
  // 32.2 s; 19.3-35.7 s in D14b's final fix wave's runs of the four files it
  // touched, three times past the 30 s per-test limit. Slow triples the
  // limit, a hang guard; every wait inside keeps its own bound.
  test.slow();
  const authorErrors = pageErrors(page);
  const author = await seedUser({ password: PASSWORD });
  const teammate = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: author.userId, role: "admin" });
  await addMember({ userId: teammate.userId, organizationId: group.organizationId, role: "contributor" });
  const token = randomUUID();
  const configuration = await seedConfiguration({
    organizationId: group.organizationId,
    createdByUserId: author.userId,
    name: `Shared testing ${randomUUID()}`,
    yamlContent: testRunText(token),
  });
  const [version] = await findConfigurationVersions(configuration.id);
  const seeded = { user: { organizationId: group.organizationId }, configurationId: configuration.id, versionId: version!.id };
  const file = logsFile();

  // The author runs a test on the draft.
  await signInThroughApi(page, author);
  await switchOrganizationThroughApi(page, group.organizationId);
  await open(page, versionPath(configuration.id, version!.id));
  await openTestingTab(page);
  await openRunDialog(page);
  await uploadAndSelect(page, file);
  await clickRun(page);
  await expectStatus(page, "Success");

  // The teammate: the draft isn't theirs to open, and its runs aren't listed to them.
  const teammateContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await skipEditorTour(teammateContext);
    const other = await teammateContext.newPage();
    const errors = pageErrors(other);
    await signInThroughApi(other, teammate);
    await switchOrganizationThroughApi(other, group.organizationId);
    expect((await other.request.get(runsUrl(seeded))).status()).toBe(404);
    await open(other, versionPath(configuration.id, version!.id));
    // The page has loaded, saying so (Ruling 47): the missing tab is no blank page's.
    await expect(other.getByText("Configuration not found")).toBeVisible();
    await expect(testingTab(other)).toHaveCount(0);

    // Published, the run is everyone's: listed, its results and input open, and re-run by the teammate.
    const published = await page.request.post(
      `/api/v1/organizations/${group.organizationId}/configurations/${configuration.id}/versions/${version!.id}/publish`,
      { headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } },
    );
    expect(published.status()).toBe(200);
    await open(other, versionPath(configuration.id, version!.id));
    await openTestingTab(other);
    await expect(runRows(other)).toHaveCount(1);
    await runRows(other).first().getByRole("button").first().click();
    await expectStatus(other, "Success");
    await results(other).getByRole("button", { name: file.name, exact: true }).click();
    const viewer = resultsDialog(other, file.name);
    await expect(viewer.locator(".monaco-editor .view-lines")).toContainText("resourceLogs");
    await viewer.getByRole("button", { name: "Close", exact: true }).first().click();

    await rerunButtons(other).first().click();

    await expect(runRows(other)).toHaveCount(2);
    await expectStatus(other, "Success");
    const runs = (await (await other.request.get(runsUrl(seeded))).json()) as { runs: { queuedByUserId: string; status: string }[] };
    expect(runs.runs.map((run) => [run.queuedByUserId, run.status])).toEqual([
      [teammate.userId, "succeeded"],
      [author.userId, "succeeded"],
    ]);
    expect(errors).toEqual([]);
    // The author's page, which opened the editor and ran the first test.
    expect(authorErrors).toEqual([]);
  } finally {
    await teammateContext.close();
  }
});

test("with the tester down, the queue's refusal is shown with its words and nothing is queued", async ({ page }) => {
  const seeded = await openSeededTestingTab(page);
  await openRunDialog(page);
  await uploadAndSelect(page, logsFile());
  // The API's answer while the tester is down (decision 12), from the route:
  // the real down state is global (Preflight ruling 20).
  await page.route(/\/test-runs$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "testing_unavailable", message: TESTING_UNAVAILABLE_MESSAGE } }),
    });
  });

  await clickRun(page);

  await expect(page.getByText(TESTING_UNAVAILABLE_MESSAGE, { exact: true })).toBeVisible();
  await expect(runDialog(page)).toBeVisible();
  await expect(runDialog(page).getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  await expect(page.getByText("No test runs yet for this version.")).toBeVisible();
  await page.unroute(/\/test-runs$/);
  expect(await listRuns(page, seeded)).toEqual([]);
});

test("each slide of the run dialog moves the keyboard's focus into the slot slid in", async ({ page }) => {
  await openSeededTestingTab(page);
  const dialog = await openRunDialog(page);
  /** The focused element's tag and text. */
  const focusedControl = () =>
    page.evaluate<string>(`(() => { const element = document.activeElement; return element ? element.tagName + ":" + (element.textContent ?? "").trim() : ""; })()`);
  // Safari's Tab reaches only text fields unless "Tab to all controls" is on;
  // Option+Tab reaches every control. WebKit's device is a Mac.
  const tabKey = (await page.evaluate<string>("navigator.userAgent")).includes("Macintosh") ? "Alt+Tab" : "Tab";
  /** Presses Enter on the button named `name`, reached with Tab from where the focus is (the slots slid away are inert). */
  const pressByKeyboard = async (name: string) => {
    const visited: string[] = [await focusedControl()];
    for (let presses = 0; presses < 20 && visited.at(-1) !== `BUTTON:${name}`; presses++) {
      await page.keyboard.press(tabKey);
      visited.push(await focusedControl());
    }
    expect(visited.at(-1), `Tab visited ${JSON.stringify(visited)}`).toBe(`BUTTON:${name}`);
    await page.keyboard.press("Enter");
  };

  /** Once the slide has settled, the track's box hasn't scrolled and the slot slid in shows whole (D14a Ruling 46). */
  const expectSlidWhole = async () => {
    await expect.poll(() => runDialogTrack(page)).toEqual({ scrollLeft: 0, slotInView: true });
  };

  // My Files are read as the dialog opens, and Upload is held until they are
  // (read twice in development, under React's strict mode): a first visit
  // waits for them, so the slides below find Upload enabled.
  await pressByKeyboard("My Files");
  await expect(dialog.getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
  await pressByKeyboard("Cancel");
  await expect(dialog.getByRole("combobox", { name: "Test Pipeline" })).toBeFocused();

  await pressByKeyboard("My Files");
  // My Files with none yet: its first control is Upload.
  await expect(dialog.getByRole("button", { name: "Upload", exact: true })).toBeFocused();
  await expectSlidWhole();

  await page.keyboard.press("Enter");
  // The upload panel: its first control is the name.
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await expectSlidWhole();

  await pressByKeyboard("Cancel");
  await expect(dialog.getByRole("button", { name: "Upload", exact: true })).toBeFocused();
  await expectSlidWhole();

  await pressByKeyboard("Cancel");
  // The main view: its first control is the pipeline.
  await expect(dialog.getByRole("combobox", { name: "Test Pipeline" })).toBeFocused();
  await expectSlidWhole();

  await pressByKeyboard("Paste Text");
  // The paste panel: Format is held while it's empty, so the name comes first.
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await expectSlidWhole();

  // Monaco keeps Tab for itself (it indents) once the paste editor has
  // loaded, so its Cancel is clicked: the slide moves the focus all the same.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Test Pipeline" })).toBeFocused();
  await expectSlidWhole();
});

// Selected again from My Files after a full reload: a file from an earlier
// session, its head read from the API for the fixture-shape check (D14a
// Ruling 43(1)).
test("a file uploaded in an earlier session is still in My Files and runs", async ({ page }) => {
  const seeded = await openSeededTestingTab(page);
  const file = logsFile();
  await openRunDialog(page);
  await uploadAndSelect(page, file);
  await runDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();

  await open(page, versionPath(seeded.configurationId, seeded.versionId));
  await openTestingTab(page);
  await openRunDialog(page);
  await runDialog(page).getByRole("button", { name: "My Files", exact: true }).click();
  await selectFromMyFiles(page, file.name);
  await clickRun(page);

  await expectStatus(page, "Success");
});

// After a full reload nothing of a file's head is in memory: the
// fixture-shape check reads it from the API, through either head (D14a
// Rulings 43(1), 46, 47): a file picked from My Files (GET
// …/test-files/:fileId/head) and a re-run's input (GET
// …/test-runs/:runId/files/input/head). A traces envelope on the logs
// pipeline asks first through both.
test("after a reload, a file that doesn't suit the pipeline asks first through both heads: from My Files, and through ↺", async ({ page }) => {
  // An upload, a run, a reload and two heads' questions: 12.9-18.4 s in D14b
  // Task 9's full runs (five workers), 11.8-22.3 s in D14b's final fix
  // wave's runs of the four files it touched, up to 74% of the 30 s
  // per-test limit. Slow triples the limit, a hang guard; every wait inside
  // keeps its own bound.
  test.slow();
  const seeded = await openSeededTestingTab(page);
  const traces: PickedFile = {
    name: `spans-${randomUUID()}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [] }] }] })),
  };
  const mismatch = page.getByRole("dialog", { name: "Fixture may not match the receiver" });
  await openRunDialog(page);
  await uploadAndSelect(page, traces);
  await clickRun(page);
  await expect(mismatch).toBeVisible();
  await mismatch.getByRole("button", { name: "Run Anyway", exact: true }).click();
  await expectStatus(page, "Success");

  await open(page, versionPath(seeded.configurationId, seeded.versionId));
  await openTestingTab(page);
  await expect(runRows(page)).toHaveCount(1);

  // The test file's head, read from the API.
  await openRunDialog(page);
  await runDialog(page).getByRole("button", { name: "My Files", exact: true }).click();
  await selectFromMyFiles(page, traces.name);
  const fileHead = page.waitForResponse((response) => /\/test-files\/[^/]+\/head$/.test(new URL(response.url()).pathname));
  await clickRun(page);
  expect((await fileHead).status()).toBe(200);
  await expect(mismatch).toBeVisible();
  await expect(mismatch).toContainText("traces");
  await mismatch.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(mismatch).toBeHidden();

  // The run's input head, read from the API, for ↺.
  const inputHead = page.waitForResponse((response) => /\/test-runs\/[^/]+\/files\/input\/head$/.test(new URL(response.url()).pathname));
  await rerunButtons(page).first().click();
  expect((await inputHead).status()).toBe(200);
  await expect(mismatch).toBeVisible();
  await expect(mismatch).toContainText("traces");
  await mismatch.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(mismatch).toBeHidden();
  expect(await listRuns(page, seeded)).toHaveLength(1);
});

// A modal dialog hides the rest of the page from assistive technology
// (Radix's hideOthers), keeping only what carries aria-live. The shell's slot
// for Monaco's live region carries aria-live="off" (D14a Ruling 52), so a
// dialog whose editor is the page's first Monaco (the YAML tab never opened)
// still announces: checked for the paste editor, a viewer and Compare, each
// after a fresh load.
test("Monaco's live region stays audible and replay-blocked under each dialog whose editor is the page's first", async ({ page }) => {
  // A run, then three fresh loads of the editor, each loading Monaco: 14.4-
  // 24.2 s in D14b Task 9's full runs (five workers); 16.8-35.5 s in D14b's
  // final fix wave's runs of the four files it touched, once past the 30 s
  // per-test limit. Slow triples the limit, a hang guard; every wait inside
  // keeps its own bound.
  test.slow();
  const errors = pageErrors(page);
  const seeded = await openSeededTestingTab(page);
  const file = logsFile();
  await openRunDialog(page);
  await uploadAndSelect(page, file);
  await clickRun(page);
  await expectStatus(page, "Success");

  /** A fresh load of the editor on its Testing tab: no Monaco yet. */
  const reload = async () => {
    await open(page, versionPath(seeded.configurationId, seeded.versionId));
    await openTestingTab(page);
    await expect(runRows(page)).toHaveCount(1);
    expect(await liveRegionNodes(page)).toEqual([]);
  };
  /** The page's live nodes, with a dialog open: there, none hidden, all replay-blocked. */
  const expectAudible = async () => {
    await expect.poll(async () => (await liveRegionNodes(page)).length).toBeGreaterThan(0);
    const nodes = await liveRegionNodes(page);
    expect(nodes.filter((node) => node.hidden)).toEqual([]);
    expect(nodes.filter((node) => !node.blocked)).toEqual([]);
  };

  // The paste editor.
  await reload();
  const dialog = await openRunDialog(page);
  await dialog.getByRole("button", { name: "Paste Text", exact: true }).click();
  await expect(dialog.locator(".monaco-editor")).toBeVisible();
  await expectAudible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // A viewer.
  await reload();
  await runRows(page).first().getByRole("button").first().click();
  await expectStatus(page, "Success");
  await results(page).getByRole("button", { name: file.name, exact: true }).click();
  const viewer = resultsDialog(page, file.name);
  await expect(viewer.locator(".monaco-editor .view-lines")).toContainText("resourceLogs");
  await expectAudible();
  await viewer.getByRole("button", { name: "Close", exact: true }).first().click();

  // Compare.
  await reload();
  await runRows(page).first().getByRole("button").first().click();
  await expectStatus(page, "Success");
  await results(page).getByRole("button", { name: "Compare input ↔ output" }).click();
  const compare = resultsDialog(page, "Compare input ↔ output");
  await expect(compare.locator(".monaco-diff-editor")).toBeVisible();
  await expectAudible();
  expect(errors).toEqual([]);
});

// ── Organization variables (D20 decision 13; Preflight rulings 28 and 29) ──

/**
 * A run's text referencing the organization variable `name` (`${org:NAME}`),
 * testRunText's `logs` pipeline with a processor inserting it, and a token
 * of the test's own.
 */
function variableRunText(token: string, name: string): string {
  return [
    `# e2e-run: ${token}`,
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      http: {}",
    "processors:",
    "  attributes/e2e:",
    "    actions:",
    "      - key: e2e.tag",
    `        value: \${org:${name}}`,
    "        action: insert",
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [otlp]",
    "      processors: [attributes/e2e]",
    "      exporters: [debug]",
    "",
  ].join("\n");
}

interface SeededVariableRun extends SeededRun {
  name: string;
  value: string;
  text: string;
}

/**
 * A user signed in with an organization variable (its value a canary
 * holding a `$`) and a draft configuration whose text references it, the
 * editor open on its Testing tab.
 */
async function openTestingTabWithVariable(page: Page): Promise<SeededVariableRun> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const token = randomUUID();
  const name = uniqueVariableName("E2E_TAG");
  const value = canaryVariableValue(token.slice(0, 8));
  await createVariableThroughApi(page, user.organizationId, name, value);
  const text = variableRunText(token, name);
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: `Testing ${randomUUID()}`,
    yamlContent: text,
  });
  const [version] = await findConfigurationVersions(configuration.id);
  await open(page, versionPath(configuration.id, version!.id));
  await openTestingTab(page);
  await expect(page.getByText("No test runs yet for this version.")).toBeVisible();
  return { user, token, configurationId: configuration.id, versionId: version!.id, name, value, text };
}

test("a run's text is saved as written, ${org:NAME} and all, while the tester gets it filled in: its Test YAML holds the value with its $ doubled", async ({
  page,
}) => {
  const errors = pageErrors(page);
  const seeded = await openTestingTabWithVariable(page);
  const reference = `\${org:${seeded.name}}`;
  const filled = filledInValue(seeded.value);
  await openRunDialog(page);
  await uploadAndSelect(page, logsFile());
  const queued = page.waitForRequest((request) => request.method() === "POST" && /\/test-runs$/.test(new URL(request.url()).pathname));
  await clickRun(page);
  // The browser sends the text as written: the value is the API's to fill in.
  expect(((await queued).postDataJSON() as { yaml: string }).yaml).toBe(seeded.text);
  await expectStatus(page, "Success");

  // Saved and returned as written: the reference, never the value.
  const [listed] = await listRuns(page, seeded);
  const run = await readRun(page, seeded, listed!.id);
  expect(run.yaml).toBe(seeded.text);
  expect(String(run.yaml)).not.toContain(seeded.value);

  const shown = results(page);
  /** Opens a viewer from the results; its Monaco's text, checked by `check`; then closes it. */
  const view = async (open: string, title: string, check: (lines: Locator) => Promise<void>) => {
    await shown.getByRole("button", { name: open, exact: true }).click();
    const dialog = resultsDialog(page, title);
    await expect(dialog).toBeVisible();
    await check(dialog.locator(".monaco-editor .view-lines"));
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await expect(dialog).toBeHidden();
  };
  // The Original YAML: the run's text, the reference as written.
  await view("Original YAML", "Original YAML", async (lines) => {
    await expect(lines).toContainText(`value: ${reference}`);
    await expect(lines).not.toContainText(seeded.value);
    await expect(lines).not.toContainText(filled);
  });
  // The Test YAML, what the fake tester answers from the text it received (Preflight ruling 29): the value filled in,
  // its $ doubled so the collector reads it literally; no reference left.
  await view("Test YAML", "Test YAML (after sandbox mutations)", async (lines) => {
    await expect(lines).toContainText(`value: ${filled}`);
    await expect(lines).not.toContainText(reference);
  });
  expect(errors).toEqual([]);
});

test("with the organization's variables unreadable, the queue's 503 is shown with its words, the run dialog kept open", async ({ page }) => {
  await openTestingTabWithVariable(page);
  // The API's words for the queue's 503 (the variables routes' and Validate's, one family: Ruling 78).
  const message = VARIABLES_UNAVAILABLE_MESSAGE;
  await openRunDialog(page);
  await uploadAndSelect(page, logsFile());
  // The API's answer when the opamp-server can't give the values (D20 Preflight ruling 28), from the route: the
  // browser tests' opamp-server is shared, and can't be made unreachable for one test.
  await page.route(/\/test-runs$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "variables_unavailable", message } }),
    });
  });

  await clickRun(page);

  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(runDialog(page)).toBeVisible();
  await expect(runDialog(page).getByRole("button", { name: "Run", exact: true })).toBeEnabled();
  // Nothing listed on the page: the route answered for the API, so the API's own refusal (and that it queues
  // nothing) is its suite's (test-runs' routes and service tests), not this one's.
  await expect(page.getByText("No test runs yet for this version.")).toBeVisible();
  await page.unroute(/\/test-runs$/);
});

for (const [code, message] of [
  ["variables_unavailable", VARIABLES_UNAVAILABLE_RUN_MESSAGE],
  ["filled_in_too_long", TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE],
] as const) {
  test(`a run that ended ${code} at its dispatch shows its words as the run's error`, async ({ page }) => {
    const seeded = await openTestingTabWithVariable(page);
    // The dispatcher's endings (D20 Preflight ruling 28): the values unreadable, or too long once filled in, between
    // the queue and the dispatch, which a browser test can't time. The run's reads are answered as the API answers
    // such a run, from the route: the real reply with the ending's status, code and words.
    await page.route(/\/test-runs(\/[^/]+)?$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as { run?: Record<string, unknown>; runs?: Record<string, unknown>[] };
      // As failureResults() leaves such a run: the code and the words, nothing from a tester that was never asked.
      const ended = (run: Record<string, unknown>) => {
        const failed: Record<string, unknown> = { ...run, status: "failed", errorCode: code };
        if ("errorMessage" in run) {
          failed.errorMessage = message;
          for (const field of [
            "mutatedYaml",
            "mutations",
            "compatibility",
            "logs",
            "timings",
            "outputSizeBytes",
            "outputTruncated",
            "decodedInputSizeBytes",
            "decodedInputTruncated",
            "validationResults",
          ]) {
            failed[field] = null;
          }
        }
        return failed;
      };
      if (body.run !== undefined) body.run = ended(body.run);
      if (body.runs !== undefined) body.runs = body.runs.map(ended);
      return route.fulfill({ response, json: body });
    });
    await openRunDialog(page);
    await uploadAndSelect(page, logsFile());
    await clickRun(page);

    // The run's error, its words as the API gave them (no list of known codes), and its row's status.
    await expect(results(page).getByText(message, { exact: true })).toBeVisible();
    await expect(runRows(page).first()).toContainText("Error");
    // Nothing the tester would have answered: no Test YAML, no mutations, no output.
    await expect(results(page).getByRole("button", { name: "Test YAML", exact: true })).toHaveCount(0);
    await expect(results(page).getByRole("button", { name: /^Mutations/ })).toHaveCount(0);
    await expect(results(page).getByRole("button", { name: "test-output.json", exact: true })).toHaveCount(0);
    await page.unroute(/\/test-runs(\/[^/]+)?$/);
    expect((await listRuns(page, seeded)).length).toBe(1);
  });
}
