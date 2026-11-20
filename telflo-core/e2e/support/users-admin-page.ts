import { expect, type Locator, type Page } from "@playwright/test";
import { open } from "./editor-page.js";
import { E2E_WEB_URL } from "./environment.js";
import { adminNavItems } from "./test-templates-page.js";

// The Users page for the browser tests: `/product-admin/users`, its search,
// its rows and the delete dialog.
//
// The page lists every account in the e2e database, parallel workers'
// included: a test finds only its own people, by searching for their own
// addresses or their own group's name, never by counts, the list's order
// or "the whole list".

/** Opens product admin from the sidebar's Product Admin item (Flows, its home), then Users from its nav. */
export async function openUsers(page: Page): Promise<void> {
  await open(page, "/app");
  await page.getByRole("link", { name: "Product Admin" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/flows`);
  await adminNavItems(page).filter({ hasText: /^Users$/ }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/users`);
  await expect(page.getByRole("heading", { level: 1, name: "Users", exact: true })).toBeVisible();
  await expect(page.getByText("Loading users...")).toHaveCount(0);
}

/** The filter box ("Filter by email or organization..."). */
export function searchBox(page: Page): Locator {
  return page.getByRole("searchbox", { name: "Filter by email or organization" });
}

/**
 * Searches for `term` and waits for the page to show that search's answer:
 * the request the pause sends (`q`, never in the address), then the rows.
 */
export async function searchFor(page: Page, term: string): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/product-admin/users" &&
      new URL(response.url()).searchParams.get("q") === term.trim() &&
      response.request().method() === "GET",
  );
  await searchBox(page).fill(term);
  expect((await answered).status()).toBe(200);
  await expect(page.getByText("Refreshing...")).toHaveCount(0);
}

/** The list's row of the person with this exact email (the Email cell's own text). */
export function userRow(page: Page, email: string): Locator {
  return page.getByRole("row").filter({ has: page.locator("td:first-child > span").getByText(email, { exact: true }) });
}

/** A row's Delete (named "Delete" and the row's email, through aria-labelledby). */
export function deleteButton(row: Locator): Locator {
  return row.getByRole("button", { name: /^Delete / });
}

/** The delete's dialog: a block's ("Cannot delete user") or the type-to-confirm ("Nuclear delete: …"). */
export function deleteDialog(page: Page): Locator {
  return page.getByRole("alertdialog");
}

/** The type-to-confirm field, labeled by its sentence. */
export function confirmField(page: Page): Locator {
  return deleteDialog(page).getByRole("textbox", { name: "This cannot be undone. Type the user's email to confirm." });
}
