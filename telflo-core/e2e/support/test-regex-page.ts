import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import type { TestRegex } from "@telflo/contracts";
import { E2E_TEST_REGEX_NAME_PREFIX } from "./database.js";
import { open } from "./editor-page.js";
import { E2E_WEB_URL } from "./environment.js";
import { adminNavItems } from "./test-templates-page.js";

// The regex library for the browser tests: the product admin's
// /product-admin/test-regex page and its dialogs, a validation pipeline
// card's "Add from regex library" picker, and the library's API as the
// page's session.
//
// The library is global, as test templates are: every parallel test sees
// what another wrote. So each test names its own entries `e2e-<uuid>…`,
// asserts only on its own rows and the seeded ones it reads (never a count,
// the empty state or the list's order), and deletes its own by id as the
// tables' owner when it ends (deleteTestRegexes).

/** A regex library entry name no other test uses, with the clean-up's prefix. */
export function uniqueRegexName(): string {
  return `${E2E_TEST_REGEX_NAME_PREFIX}${randomUUID()}`;
}

/** Opens product admin from the sidebar's Product Admin item (Flows, its home), then Test Regex from its nav. */
export async function openTestRegexAdmin(page: Page): Promise<void> {
  await open(page, "/app");
  await page.getByRole("link", { name: "Product Admin" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/flows`);
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
  await adminNavItems(page).filter({ hasText: "Test Regex" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/test-regex`);
  await expect(page.getByRole("heading", { level: 1, name: "Test Regex", exact: true })).toBeVisible();
  await expect(page.getByText("Loading regexes...")).toHaveCount(0);
}

/** The admin page's table row of the entry named `name`. */
export function adminRegexRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
}

/** The admin page's create or edit dialog. */
export function regexDialog(page: Page, title: "New Test Regex" | "Edit Test Regex"): Locator {
  return page.getByRole("dialog", { name: title });
}

/** The library as the session (a page's) reads it. */
export async function listTestRegexesThroughApi(page: Page): Promise<TestRegex[]> {
  const response = await page.request.get("/api/v1/test-regexes");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { testRegexes: TestRegex[] }).testRegexes;
}

/** A card's "Add from regex library". */
export function addFromLibraryButton(card: Locator): Locator {
  return card.getByRole("button", { name: "Add from regex library", exact: true });
}

/** The regex library picker. */
export function regexPicker(page: Page): Locator {
  return page.getByRole("dialog", { name: "Add validation rules from regex library" });
}

/** Opens the card's picker (the card expanded) and waits for the library to be read. */
export async function openRegexPicker(card: Locator): Promise<Locator> {
  await addFromLibraryButton(card).click();
  const picker = regexPicker(card.page());
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("status", { name: "Loading test regexes" })).toHaveCount(0);
  return picker;
}

/** The picker's checkbox for the entry named `name` (labeled by its name). */
export function pickerCheckbox(picker: Locator, name: string): Locator {
  return picker.getByRole("checkbox", { name, exact: true });
}

/** The picker's row of the entry named `name`: its checkbox, name, description, regex and category. */
export function pickerRow(picker: Locator, name: string): Locator {
  // `has` is queried inside each row: a locator from the page, never one from the dialog.
  return picker.getByRole("listitem").filter({ has: picker.page().getByRole("checkbox", { name, exact: true }) });
}
