import { expect, type Locator, type Page } from "@playwright/test";
import { open } from "./editor-page.js";
import { E2E_WEB_URL } from "./environment.js";
import { adminNavItems } from "./test-templates-page.js";

// The Product admins page (D29 decisions 5, 39 and 45) for the browser
// tests: `/product-admin/product-admins`, its list, "Add product admin" and
// the Remove confirmation.
//
// The product-admin flag is global: every parallel worker's admins are on
// the list. So each test finds only its own rows, by its own seeded
// addresses (never a count, the list's order or "the whole list"), makes a
// throwaway second admin so the one it removes is never the last, and
// revokes every admin it made when it ends (D29 Preflight ruling 18).

/** Opens product admin from the sidebar's Product Admin item (Flows, its home), then Product admins from its nav. */
export async function openProductAdmins(page: Page): Promise<void> {
  await open(page, "/app");
  await page.getByRole("link", { name: "Product Admin" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/flows`);
  await adminNavItems(page).filter({ hasText: "Product admins" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/product-admins`);
  await expect(page.getByRole("heading", { level: 1, name: "Product admins", exact: true })).toBeVisible();
  await expect(page.getByText("Loading product admins...")).toHaveCount(0);
}

/** The list's row of the admin with this exact email (the Email cell's own text). */
export function productAdminRow(page: Page, email: string): Locator {
  return page.getByRole("row").filter({ has: page.locator("td:first-child > span").getByText(email, { exact: true }) });
}

/** A row's Remove (named "Remove product admin" and the row's email, through aria-labelledby). */
export function removeButton(row: Locator): Locator {
  return row.getByRole("button", { name: /^Remove product admin / });
}

/** The Remove confirmation. */
export function removeConfirmation(page: Page): Locator {
  return page.getByRole("dialog", { name: "Remove product admin" });
}

/** "Add product admin"'s email field. */
export function addEmailField(page: Page): Locator {
  return page.getByLabel("Email", { exact: true });
}

/** Types `email` into "Add product admin" and presses Add. */
export async function addProductAdmin(page: Page, email: string): Promise<void> {
  await addEmailField(page).fill(email);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

/** Opens `row`'s Remove and confirms it. */
export async function removeThroughConfirmation(page: Page, row: Locator): Promise<void> {
  await removeButton(row).click();
  const confirmation = removeConfirmation(page);
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
}
