import { expect, type Locator, type Page } from "@playwright/test";
import { STARTER_CONFIGURATION_NAME } from "../../apps/api/src/modules/configurations/starter-configuration.js";
import { HISTORY_THROTTLE_MS } from "../../apps/web/app/lib/stores/history-throttle.js";
import { seedConfiguration, seedUser } from "./database.js";
import { editorText, linesOf, open, tab, undoButton, unsavedBadge, waitForCanvas } from "./editor-page.js";
import { signInThroughApi } from "./session.js";

// The component forms' browser tests (D9d, after D9c's
// forms-kubernetes-logs.e2e.ts): a seeded configuration opened in the
// editor, a component's form shown with a section open, the text read and
// waited for, a toast, and Undo.
//
// The text is read by the YAML tab's Download and always polled (a form's
// typing is written 300 ms after the last keystroke or on blur, and Monaco's
// model can trail it; D9a Ruling 42). Reading it opens the YAML tab, which
// hides the form; the Configuration tab keeps it, its open sections and its
// cards' expansion (D9c Ruling 86), so each step shows the component again.

const PASSWORD = "correct horse battery staple";

export type NodeType = "receiver" | "processor" | "exporter" | "connector";

/** A user with a configuration holding `lines`, signed in; the editor open on it, its canvas drawn. */
export async function openSeeded(page: Page, lines: readonly string[]): Promise<void> {
  const user = await seedUser({ password: PASSWORD });
  const configuration = await seedConfiguration({
    organizationId: user.organizationId,
    createdByUserId: user.userId,
    name: STARTER_CONFIGURATION_NAME,
    yamlContent: lines.join("\n"),
  });
  await signInThroughApi(page, user);
  await open(page, `/editor/${configuration.id}`);
  await waitForCanvas(page);
}

/** The canvas node of `type` whose card reads `label` exactly: the first, where a component is drawn in several pipelines. */
export function componentNode(page: Page, type: NodeType, label: string): Locator {
  return page
    .locator(`.react-flow__node-${type}`)
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
}

/** A section's header button, by its title (its name also holds its count). */
export function sectionHeader(page: Page, title: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}\\s*\\d*$`) });
}

/**
 * Selects a component and shows its form in the Configuration tab (clicking
 * the node already selected doesn't switch tabs, so the tab is clicked too),
 * then opens the form's `section` if it isn't open: sections stay open
 * across a look at the YAML tab (D9c Ruling 86).
 */
export async function showComponent(page: Page, type: NodeType, label: string, section?: string): Promise<void> {
  await componentNode(page, type, label).click();
  await tab(page, "Configuration").click();
  await expect(tab(page, "Configuration")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 3, name: label, exact: true })).toBeVisible();
  if (section !== undefined) {
    const header = sectionHeader(page, section);
    if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Waits until the editor's text reads `lines`, line by line. */
export async function expectLines(page: Page, lines: readonly string[]): Promise<void> {
  await expect.poll(async () => linesOf(await editorText(page))).toEqual(lines);
}

/** Undoes the last change and waits for the text to read `lines`. */
export async function undoTo(page: Page, lines: readonly string[]): Promise<void> {
  await undoButton(page).click();
  await expectLines(page, lines);
}

/** Undoes the last change and waits for the text to read `lines` again, as it was opened: nothing unsaved. */
export async function undoToOpened(page: Page, lines: readonly string[]): Promise<void> {
  await undoTo(page, lines);
  await expect(unsavedBadge(page)).toBeHidden();
}

/**
 * Lets the history's run end, so the next form change to the same
 * component is an undo entry of its own (a test that undoes step by step).
 */
export async function afterHistoryRun(page: Page): Promise<void> {
  await page.waitForTimeout(HISTORY_THROTTLE_MS + 200);
}

/** Replaces a field's text and leaves it, which writes at once. */
export async function retype(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.blur();
}

/** Opens a Radix select by its trigger and chooses the option named `option`. */
export async function choose(page: Page, trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** The toasts holding `message`. */
export function toastWith(page: Page, message: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: message });
}

/** The editor's right panel, where the form shows (the canvas has buttons of the same names). */
export function rightPanel(page: Page): Locator {
  return page.locator('[data-tour-step="editor-right-panel"]');
}

/** A cascade's toast (D9d decision 7), once; no inline alert in the panel holds the message. */
export async function expectAdjusted(page: Page, message: string): Promise<void> {
  await expect(toastWith(page, message)).toHaveCount(1);
  await expect(rightPanel(page).getByText(message, { exact: true })).toHaveCount(0);
}

/** The sortable list's live region: dnd-kit announces each step of a drag there, by the items' ids. */
export function dragAnnouncements(page: Page): Locator {
  return page.locator('[id^="DndLiveRegion"]');
}

/** The cards' drag handles, in order. */
export function dragHandles(page: Page): Locator {
  return page.getByRole("button", { name: "Drag to reorder" });
}
