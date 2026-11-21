import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { findConfigurationVersions } from "./database.js";
import { waitForHydration } from "./session.js";

// The editor page, for the editor's, the builder's, the forms' and the
// versions' browser tests: opening it, reading its text, the lines a test
// expects, and typing in Monaco. One set of helpers for every file.
//
// Monaco in Playwright:
// - Monaco closes quotes and brackets and indents after `:` as it is typed,
//   so a test types a comment line at the top (`typeLineAtTop`).
// - Monaco takes its platform from the user agent, not from the machine:
//   WebKit's device is a Mac (Cmd), Chromium's and Firefox's are Windows
//   (Ctrl). Playwright's `ControlOrMeta` follows the machine instead, so the
//   keys are chosen from the page's user agent (`platformKeys`).
// - Monaco draws only the lines in view, so what it shows is read from its
//   drawn lines (`shownLines`).

/** A full page load of `path`, hydrated. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

export function unsavedBadge(page: Page): Locator {
  return page.getByText("Unsaved", { exact: true });
}

export function saveButton(page: Page): Locator {
  return page.getByRole("button", { name: "Save", exact: true });
}

export function undoButton(page: Page): Locator {
  return page.getByRole("button", { name: "Undo (Ctrl+Z)" });
}

export function tab(page: Page, name: "Configuration" | "YAML"): Locator {
  return page.getByRole("tab", { name, exact: true });
}

/** Where the viewport is: React Flow's transform on its viewport element. */
export async function viewport(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  const style = (await page.locator(".react-flow__viewport").getAttribute("style")) ?? "";
  // WebKit writes `translate(0px, 0px)` as `translate(0px)`: y is 0 when missing.
  const match = /translate\(([-\d.e]+)px(?:, ([-\d.e]+)px)?\) scale\(([-\d.e]+)\)/.exec(style);
  if (!match) throw new Error(`the viewport has no transform: ${style}`);
  return { x: Number(match[1]), y: Number(match[2] ?? 0), zoom: Number(match[3]) };
}

/**
 * Waits for the canvas to show its nodes where it will keep them: after the
 * fit on open (or at the remembered viewport), which moves the viewport
 * away from React Flow's default.
 */
export async function waitForCanvas(page: Page): Promise<void> {
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect.poll(async () => viewport(page)).not.toEqual({ x: 0, y: 0, zoom: 1 });
}

/** The center of an element, in the window. */
export async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element isn't shown");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Presses the mouse at `from`, moves to `to` in steps, and releases it. */
export async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  // Inside the window: Firefox mis-sizes a drag that leaves it.
  const size = page.viewportSize();
  for (const point of [from, to]) {
    if (size === null || point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) {
      throw new Error(`a drag point outside the window: ${JSON.stringify(point)}`);
    }
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

/** Opens the panel's YAML tab, where Monaco mounts. */
export async function openYamlTab(page: Page): Promise<void> {
  await tab(page, "YAML").click();
  await expect(tab(page, "YAML")).toHaveAttribute("aria-selected", "true");
}

/** The keys Monaco and the page answer to in this browser: Cmd on a Mac user agent, else Ctrl (Monaco's rule). */
export async function platformKeys(
  page: Page,
): Promise<{ save: string; top: string; bottom: string; selectAll: string; find: string; undo: string }> {
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  const userAgent = await page.evaluate<string>("navigator.userAgent");
  return userAgent.includes("Macintosh")
    ? {
        save: "Meta+S",
        top: "Meta+ArrowUp",
        bottom: "Meta+ArrowDown",
        selectAll: "Meta+A",
        find: "Meta+F",
        undo: "Meta+Z",
      }
    : {
        save: "Control+S",
        top: "Control+Home",
        bottom: "Control+End",
        selectAll: "Control+A",
        find: "Control+F",
        undo: "Control+Z",
      };
}

/**
 * The lines Monaco has drawn, top to bottom, as text: the lines in view.
 * Monaco draws a space as a no-break space.
 */
export function shownLines(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`[...document.querySelectorAll(".monaco-editor .view-lines .view-line")]
    .map((line) => ({ top: parseFloat(line.style.top), text: line.textContent }))
    .sort((a, b) => a.top - b.top)
    .map((line) => line.text.replace(/\\u00a0/g, " "))`);
}

/** Waits until Monaco shows `lines` from its first line on. */
export async function expectShownFromTop(page: Page, lines: string[]): Promise<void> {
  await expect.poll(async () => (await shownLines(page)).slice(0, lines.length)).toEqual(lines);
}

/**
 * Types `line` and a newline at the top of Monaco's text: Monaco then holds
 * `${line}\n` before what it held. Typed, never `keyboard.insertText` of
 * text holding a newline, which lands twice in Firefox (the paste
 * helpers' samples are one line of JSON).
 */
export async function typeLineAtTop(page: Page, line: string): Promise<void> {
  // The model's first line, first column, by Go to Line, in every browser. In WebKit, with the focus given to
  // Monaco's textarea rather than by a click, Cmd+Up didn't reach the model's top (probed: a line typed after it
  // landed on line 28 of the starter, while after Go to Line it landed on line 1).
  await goToLine(page, 1);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/**
 * Gives Monaco the keyboard focus through its input area, with no click
 * on its lines: a center click retried after a scroll (sticky-scroll rows
 * on top) could land where nothing takes the focus. The focus and its
 * check retry together until Monaco says it is focused.
 */
export async function focusMonaco(page: Page): Promise<void> {
  await expect(async () => {
    // Its input element: the EditContext node where the browser has the API (Chromium), else the textarea.
    await page.locator(".monaco-editor .native-edit-context, .monaco-editor textarea.inputarea").first().focus();
    await expect(page.locator(".monaco-editor.focused")).toHaveCount(1, { timeout: 1_000 });
  }).toPass();
}

/**
 * Puts Monaco's cursor on line `lineNumber` (1-based) by keyboard: Go to
 * Line (Ctrl+G, on every platform). Unlike a click on a drawn line, it
 * doesn't depend on where Monaco has scrolled.
 */
export async function goToLine(page: Page, lineNumber: number): Promise<void> {
  await focusMonaco(page);
  await page.keyboard.press("Control+g");
  const quickInput = page.locator(".quick-input-widget input");
  await expect(quickInput).toBeFocused();
  await page.keyboard.type(String(lineNumber));
  await page.keyboard.press("Enter");
  await expect(quickInput).toBeHidden();
}

/**
 * Puts Monaco's cursor at the end of line `lineNumber` (1-based): Go to Line,
 * then End. A click aimed at a line's drawn end missed it on CI's WebKit
 * (Linux), where Monaco was scrolled sideways after Undo All.
 */
export async function cursorAtEndOfLine(page: Page, lineNumber: number): Promise<void> {
  await goToLine(page, lineNumber);
  await page.keyboard.press("End");
}

/** The editor's whole text, as the YAML tab's Download saves it. Leaves the YAML tab open. */
export async function editorText(page: Page): Promise<string> {
  await openYamlTab(page);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download YAML configuration" }).click();
  const download = await downloaded;
  return readFile(await download.path(), "utf8");
}

/** The only version, as the database holds it. */
export async function storedVersion(configurationId: string) {
  const versions = await findConfigurationVersions(configurationId);
  expect(versions.map((version) => version.version_number)).toEqual([1]);
  return versions[0]!;
}

/**
 * The editor's address at the configuration's only version: `/editor/{id}`
 * replaces itself with it.
 */
export async function versionAddress(configurationId: string): Promise<string> {
  const { id } = await storedVersion(configurationId);
  return `/editor/${configurationId}/${id}`;
}

/** `lines` with `added` after the `occurrence`-th line reading `after`. */
export function insertAfter(lines: readonly string[], after: string, added: readonly string[], occurrence = 1): string[] {
  const index = nthIndex(lines, after, occurrence);
  return [...lines.slice(0, index + 1), ...added, ...lines.slice(index + 1)];
}

/** `lines` with the `occurrence`-th line reading `old` replaced by `replacement`. */
export function replaceLine(lines: readonly string[], old: string, replacement: string, occurrence = 1): string[] {
  const index = nthIndex(lines, old, occurrence);
  return [...lines.slice(0, index), replacement, ...lines.slice(index + 1)];
}

export function nthIndex(lines: readonly string[], line: string, occurrence: number): number {
  let seen = 0;
  const index = lines.findIndex((candidate) => candidate === line && ++seen === occurrence);
  if (index < 0) throw new Error(`no line ${JSON.stringify(line)} (occurrence ${occurrence})`);
  return index;
}

/** A text's lines, for comparing line by line. */
export function linesOf(text: string): string[] {
  return text.split("\n");
}
