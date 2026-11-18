import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Locator, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type TestRunSignal,
  type TestTemplate,
  type TestTemplateReceiverType,
} from "@telflo/contracts";
import { E2E_TEMPLATE_NAME_PREFIX, grantProductAdmin, seedUser, type SeededUser } from "./database.js";
import { open } from "./editor-page.js";
import { E2E_WEB_URL } from "./environment.js";
import type { PickedFile } from "./test-runs-page.js";

// Test templates (D14b Tasks 5, 7 and 8) for the browser tests: the product
// admin's /product-admin/test-templates page, and the templates' API as a
// product admin, for tests about what members do with a template.
//
// Templates are global, as flows are: every parallel test sees what another
// wrote. So each test names its own `e2e-<uuid>`, asserts only on its own
// rows (never a count or the empty state), and deletes them as the tables'
// owner when it ends (deleteTestTemplates, D14b Preflight ruling 27).

/** A template name no other test uses, with the clean-up's prefix. */
export function uniqueTemplateName(): string {
  return `${E2E_TEMPLATE_NAME_PREFIX}${randomUUID()}`;
}

/** A product admin of their own (a fresh user, by the README's SQL) and an API session of theirs, outside any page. */
export interface ProductAdminSession {
  admin: SeededUser;
  request: APIRequestContext;
}

/** A fresh product admin signed in to an API session of its own; the caller disposes of `request`. */
export async function productAdminSession(playwright: PlaywrightWorkerArgs["playwright"], password: string): Promise<ProductAdminSession> {
  const admin = await seedUser({ password });
  await grantProductAdmin(admin.email);
  const request = await playwright.request.newContext({ baseURL: E2E_WEB_URL });
  const response = await request.post("/api/v1/auth/sessions", {
    data: { email: admin.email, password },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(200);
  return { admin, request };
}

/** Uploads a template as the admin's session, as the admin page's dialog does; its parts in the API's only order. */
export async function createTemplateThroughApi(
  request: APIRequestContext,
  {
    name,
    description = "",
    receiverType,
    signal,
    file,
  }: { name: string; description?: string; receiverType: TestTemplateReceiverType; signal: TestRunSignal; file: PickedFile },
): Promise<TestTemplate> {
  const response = await request.post("/api/v1/test-templates", {
    multipart: { name, description, receiverType, signal, file },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { template: TestTemplate }).template;
}

/** The live templates as the session (a page's, or an API session) reads them. */
export async function listTemplatesThroughApi(request: APIRequestContext): Promise<TestTemplate[]> {
  const response = await request.get("/api/v1/test-templates");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { templates: TestTemplate[] }).templates;
}

/** The admin page's table row of the template named `name`. */
export function adminTemplateRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
}

/** The admin page's create or edit dialog. */
export function templateDialog(page: Page, title: "New Test Template" | "Edit Test Template"): Locator {
  return page.getByRole("dialog", { name: title });
}

/**
 * The admin nav's items as their text reads, in order (D29 decision 36,
 * Preflight ruling 14): User Feedback with its pending count (any integer,
 * or none when it couldn't be read: other workers' feedback moves it), then
 * the other pages in their order, then Product admins.
 */
export const ADMIN_NAV_ITEMS: Array<string | RegExp> = [
  /^User Feedback\s*\d*$/,
  "Test Templates",
  "Test Regex",
  "Library",
  "Flows",
  "Users",
  "Product admins",
];

/** The admin page's nav, its items in order (ADMIN_NAV_ITEMS). */
export function adminNavItems(page: Page): Locator {
  return page
    .getByRole("navigation")
    .filter({ has: page.getByRole("button", { name: "Test Templates", exact: true }) })
    .getByRole("button");
}

/** Opens product admin from the sidebar's Product Admin item (Flows, its home), then Test Templates from its nav. */
export async function openTestTemplatesAdmin(page: Page): Promise<void> {
  await open(page, "/app");
  await page.getByRole("link", { name: "Product Admin" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/flows`);
  await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible();
  await adminNavItems(page).filter({ hasText: "Test Templates" }).click();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/test-templates`);
  await expect(page.getByRole("heading", { level: 1, name: "Test Templates", exact: true })).toBeVisible();
  await expect(page.getByText("Loading templates...")).toHaveCount(0);
}

/** Chooses `option` in the Radix select named `name` inside `scope`. */
export async function chooseOption(page: Page, scope: Locator, name: string, option: string): Promise<void> {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(scope.getByRole("combobox", { name, exact: true })).toContainText(option);
}
