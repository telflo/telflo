import { expect, type Locator, type Page } from "@playwright/test";

// The editor's version picker and its dialogs, for the versions' browser
// tests. The Monaco helpers those tests type with are editor-page.ts's,
// shared with the editor's and the builder's.

/** The editor's address at a version. */
export function versionPath(configurationId: string, versionId: string): string {
  return `/editor/${configurationId}/${versionId}`;
}

/** The picker's trigger, named by "Version:" and the version it shows. */
export function versionTrigger(page: Page): Locator {
  return page.getByRole("combobox", { name: /^Version:/ });
}

/** The picker's open list. */
export function versionList(page: Page): Locator {
  return page.getByRole("listbox");
}

/** The open list's row of version `versionNumber`, by its `v{n}`. */
export function versionRow(page: Page, versionNumber: number): Locator {
  return versionList(page)
    .getByRole("option")
    .filter({ has: page.getByText(`v${versionNumber}`, { exact: true }) });
}

/** Opens the picker with the pointer; returns its list. */
export async function openPicker(page: Page): Promise<Locator> {
  await versionTrigger(page).click();
  await expect(versionList(page)).toBeVisible();
  return versionList(page);
}

/** Chooses version `versionNumber` from the picker. */
export async function chooseVersion(page: Page, versionNumber: number): Promise<void> {
  await openPicker(page);
  await versionRow(page, versionNumber).click();
  await expect(versionList(page)).toBeHidden();
}

/** "Create New Version" from the picker, named `label` (none when empty), through the Copy Version dialog. */
export async function createVersionFromPicker(page: Page, label = ""): Promise<void> {
  await openPicker(page);
  await versionList(page).getByRole("button", { name: "Create New Version" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy Version" });
  const field = dialog.getByLabel("Version name (optional)");
  // Focused when it opens, by the pointer too: `fill` would focus it regardless.
  await expect(field).toBeFocused();
  if (label !== "") await field.fill(label);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * A "last saved" date as the picker shows it: `toLocaleDateString()` in the
 * page, from the stored row's time, never Node's "today", whose time zone
 * and locale may differ from the browser's.
 */
export function shownDate(page: Page, updatedAt: Date): Promise<string> {
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  return page.evaluate<string>(`new Date(${JSON.stringify(updatedAt.toISOString())}).toLocaleDateString()`);
}
