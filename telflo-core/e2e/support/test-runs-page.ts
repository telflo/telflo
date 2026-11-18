import { expect, type Locator, type Page } from "@playwright/test";
import { fakeOtelcolTestingMarker } from "../../apps/api/src/testing/fake-otelcol-testing.js";

// The editor's Testing tab (D14a Tasks 9 and 10) in the browser: its run
// dialog, the version's runs and the selected run's results. Shared by
// test-runs.e2e.ts and the privacy reviews' scratch specs.
//
// The run dialog slides between three slots; the ones slid away are inert
// and hidden from assistive technology, so a role query finds only the
// controls of the slot in view (two "OK" buttons exist at once, one each in
// My Files and Upload).

/** The panel's Testing tab. */
export function testingTab(page: Page): Locator {
  return page.getByRole("tab", { name: "Testing", exact: true });
}

/** Opens the Testing tab and waits for its runs to be read (none yet, or the list). */
export async function openTestingTab(page: Page): Promise<void> {
  await testingTab(page).click();
  await expect(testingTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("status", { name: "Loading test runs" })).toHaveCount(0);
}

/** The Tests subtab's Play: "Configure and run". */
export function configureAndRunButton(page: Page): Locator {
  return page.getByRole("button", { name: "Configure and run", exact: true });
}

/** The run dialog. */
export function runDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Select Test File" });
}

/** The selected run's results. */
export function results(page: Page): Locator {
  return page.getByRole("region", { name: "Test results" });
}

/** Each listed run's ↺. */
export function rerunButtons(page: Page): Locator {
  return page.getByRole("button", { name: "Re-run test", exact: true });
}

/** The listed runs' rows, newest first: each holds its time and status badge, and its ↺. */
export function runRows(page: Page): Locator {
  return page.locator("li").filter({ has: rerunButtons(page) });
}

/** A text the fake tester answers as `marker` says, besides `token` (the control route's: support/fake-otelcol-testing.ts). */
export interface RunTextOptions {
  /** Held by the fake until the test releases it: the run shows Running. */
  slow?: boolean;
  /** Answered by the fake as a collector that failed: the run ends Error (released first, when `slow` too). */
  failed?: boolean;
}

/**
 * A configuration's text with one `logs` pipeline from an OTLP receiver to
 * the debug exporter, tagged with `token` on a comment line so the fake
 * tester's control route can tell this test's runs from others', and with
 * the fake's `slow` and `collector-failed` markers when asked.
 */
export function testRunText(token: string, { slow = false, failed = false }: RunTextOptions = {}): string {
  return [
    `# e2e-run: ${token}`,
    ...(slow ? [fakeOtelcolTestingMarker("slow")] : []),
    ...(failed ? [fakeOtelcolTestingMarker("collector-failed")] : []),
    "receivers:",
    "  otlp:",
    "    protocols:",
    "      http: {}",
    "exporters:",
    "  debug: {}",
    "service:",
    "  pipelines:",
    "    logs:",
    "      receivers: [otlp]",
    "      exporters: [debug]",
    "",
  ].join("\n");
}

/** An OTLP/JSON logs document holding one record whose body is `body`. */
export function otlpLogs(body: string): string {
  return `${JSON.stringify(
    {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "e2e" } }] },
          scopeLogs: [{ scope: {}, logRecords: [{ timeUnixNano: "1700000000000000000", body: { stringValue: body } }] }],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** A file as Playwright's setInputFiles takes it. */
export interface PickedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** Opens the run dialog from the toolbar's Play. */
export async function openRunDialog(page: Page): Promise<Locator> {
  await configureAndRunButton(page).click();
  const dialog = runDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * In the open run dialog: My Files, Upload, the file picked, OK (the upload),
 * then the file highlighted in My Files and OK, back on the main view with it
 * selected. The display name is the file's name unless `displayName` is given.
 */
export async function uploadAndSelect(page: Page, file: PickedFile, displayName = file.name): Promise<void> {
  const dialog = runDialog(page);
  await dialog.getByRole("button", { name: "My Files", exact: true }).click();
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Upload Test File" })).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles(file);
  const name = dialog.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue(file.name);
  if (displayName !== file.name) await name.fill(displayName);
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("File uploaded", { exact: true })).toBeVisible();
  await selectFromMyFiles(page, displayName);
}

/** In My Files (open in the run dialog): highlights the file named `displayName` and confirms, back on the main view with it selected. */
export async function selectFromMyFiles(page: Page, displayName: string): Promise<void> {
  const dialog = runDialog(page);
  await dialog.getByRole("button", { name: displayName, exact: true }).click();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog.getByText(`Selected File: ${displayName}`)).toBeVisible();
}

/**
 * In the open run dialog: Paste Text, the name, the sample typed into the
 * paste editor (inserted as one text, so Monaco closes no quote or bracket),
 * then Use Sample, back on the main view with the saved sample selected.
 */
export async function pasteAndSelect(page: Page, displayName: string, sample: string): Promise<void> {
  const dialog = runDialog(page);
  await dialog.getByRole("button", { name: "Paste Text", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Paste Test Sample" })).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill(displayName);
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

/** The dialog's Run, for the file and pipeline it shows. */
export async function clickRun(page: Page): Promise<void> {
  await runDialog(page).getByRole("button", { name: "Run", exact: true }).click();
}

/** Waits until the selected run's results show `status` in its header ("Queued" may carry its place). */
export async function expectStatus(page: Page, status: "Queued" | "Running" | "Success" | "Error"): Promise<void> {
  await expect(results(page).getByText(status === "Queued" ? /^Queued( \(\d+ ahead\))?$/ : new RegExp(`^${status}$`))).toBeVisible();
}

/** A results dialog (a viewer, Compare, the mutations) by its title. */
export function resultsDialog(page: Page, title: string | RegExp): Locator {
  return page.getByRole("dialog", { name: title });
}

/**
 * Where every Monaco screen-reader live region (`.monaco-aria-container`) in
 * the page is: whether it sits inside a `ph-no-capture` block (D14a
 * Preflight ruling 14), and inside the app shell's one host, shared by every
 * Monaco and never removed (`[data-monaco-aria-host]`, Ruling 48). Only
 * regions attached to the page are found. Read in the page, as a string: the
 * E2E code is typechecked without DOM types.
 */
export function ariaContainers(page: Page): Promise<{ blocked: boolean; inShellHost: boolean }[]> {
  return page.evaluate<{ blocked: boolean; inShellHost: boolean }[]>(`[...document.querySelectorAll(".monaco-aria-container")].map((element) => ({
    blocked: element.closest(".ph-no-capture") !== null,
    inShellHost: element.closest("[data-monaco-aria-host]") !== null,
  }))`);
}

/**
 * Monaco's live nodes in the page (each `.monaco-aria-container` and its
 * alert and status nodes): whether one, or an ancestor, is hidden from
 * assistive technology (`aria-hidden="true"`, as a modal dialog's
 * `hideOthers` sets on the rest of the page), and whether it sits in a
 * `ph-no-capture` block (D14a Rulings 48, 52). Read in the page, as a
 * string: the E2E code is typechecked without DOM types.
 */
export function liveRegionNodes(page: Page): Promise<{ node: string; hidden: boolean; blocked: boolean }[]> {
  return page.evaluate<{ node: string; hidden: boolean; blocked: boolean }[]>(
    `[...document.querySelectorAll(".monaco-aria-container, .monaco-aria-container .monaco-alert, .monaco-aria-container .monaco-status")].map((element) => ({
      node: String(element.className),
      hidden: element.closest('[aria-hidden="true"]') !== null,
      blocked: element.closest(".ph-no-capture") !== null,
    }))`,
  );
}

/**
 * The run dialog's sliding track: its clipping box's horizontal scroll, and
 * whether the slot in view (the one not inert) lies wholly inside the box.
 * D14a Ruling 46: focusing a control in a slot still off to the side must
 * not scroll the box, or the slid-in panel ends part hidden.
 */
export function runDialogTrack(page: Page): Promise<{ scrollLeft: number; slotInView: boolean }> {
  return page.evaluate<{ scrollLeft: number; slotInView: boolean }>(`(() => {
    const slots = [...document.querySelectorAll('[role="dialog"] [data-run-dialog-slot]')];
    const box = slots[0].parentElement.parentElement;
    const shown = slots.find((slot) => !slot.hasAttribute("inert"));
    const outer = box.getBoundingClientRect();
    const inner = shown.getBoundingClientRect();
    return { scrollLeft: box.scrollLeft, slotInView: inner.left >= outer.left - 1 && inner.right <= outer.right + 1 };
  })()`);
}
