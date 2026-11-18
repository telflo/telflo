import { expect, test as base, type Page } from "@playwright/test";
import { LAST_PRODUCT_ADMIN_MESSAGE, type ProductAdminsResponse } from "@telflo/contracts";
import { grantProductAdmin, revokeProductAdmin, seedUser, type SeededUser } from "./support/database.js";
import { open } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { maskedPlacesOf, within } from "./support/privacy.js";
import {
  addEmailField,
  addProductAdmin,
  openProductAdmins,
  productAdminRow,
  removeButton,
  removeConfirmation,
  removeThroughConfirmation,
} from "./support/product-admins-page.js";
import { signInThroughApi } from "./support/session.js";
import { toastWith } from "./support/validation-pipelines-page.js";

// The Product admins page (D29 decisions 5, 39 and 45), in the browser: a
// product admin adds another by exact email, removes another, removes
// themselves (sent to `/app`), and sees the last-admin refusal's toast.
//
// - The flag is global and parallel workers make admins of their own, so
//   the real last-admin rule is never reachable here: it is the
//   integration suite's and the stack smoke's (Preflight ruling 7). Its UI
//   is shown with a routed 409 only.
// - Each test makes a throwaway second admin, so the one it removes is never
//   the last, finds only its own rows by its own addresses, and revokes
//   every admin it made when it ends, however it ends (`admins`).
// - The page shows other people's emails (synthetic `e2e-<uuid>@example.com`
//   fixtures): the privacy check collects where its own addresses sit, goes
//   to about:blank, then asserts (Preflight ruling 18).

const PASSWORD = "correct horse battery staple";

/** `admins`: every address a test made a product admin, revoked when it ends. */
const test = base.extend<{ admins: string[] }>({
  // eslint-disable-next-line no-empty-pattern
  admins: async ({}, use) => {
    const made: string[] = [];
    await use(made);
    for (const email of made) await revokeProductAdmin(email);
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

/** A product admin of their own, made by the README's SQL and recorded for the revoke; signed in on `page` when given. */
async function productAdmin(admins: string[], page?: Page): Promise<SeededUser> {
  const admin = await seedUser({ password: PASSWORD });
  admins.push(admin.email);
  await grantProductAdmin(admin.email);
  if (page !== undefined) await signInThroughApi(page, admin);
  return admin;
}

/** The product admins' ids as the page's session reads them. */
async function listedIds(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/v1/product-admin/product-admins");
  expect(response.status()).toBe(200);
  return ((await response.json()) as ProductAdminsResponse).items.map((item) => item.id);
}

test("a product admin adds a verified person by exact email: 'Product admin added', their row listed, and the person reaches product admin", async ({
  page,
  browser,
  admins,
}) => {
  await productAdmin(admins, page);
  const person = await seedUser({ password: PASSWORD });
  // Revoked when the test ends from the moment the add may have happened.
  admins.push(person.email);
  await openProductAdmins(page);

  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await addProductAdmin(page, `  ${person.email.toUpperCase()} `);
  await expect(toastWith(page, "Product admin added")).toBeVisible();
  await expect(productAdminRow(page, person.email)).toHaveCount(1);
  await expect(addEmailField(page)).toHaveValue("");
  expect(await listedIds(page)).toContain(person.userId);

  // The person, in a browser of their own, now reaches product admin.
  const context = await browser.newContext({ baseURL: E2E_WEB_URL });
  try {
    const theirs = await context.newPage();
    await signInThroughApi(theirs, person);
    await open(theirs, "/product-admin/product-admins");
    await expect(theirs).toHaveURL(`${E2E_WEB_URL}/product-admin/product-admins`);
    await expect(productAdminRow(theirs, person.email).getByText("(you)", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a product admin removes another through the confirmation: 'Product admin removed', the row gone, the page kept", async ({ page, admins }) => {
  const admin = await productAdmin(admins, page);
  const second = await productAdmin(admins);
  await openProductAdmins(page);

  await expect(productAdminRow(page, admin.email).getByText("(you)", { exact: true })).toBeVisible();
  const row = productAdminRow(page, second.email);
  await expect(row.getByText("(you)", { exact: true })).toHaveCount(0);
  await removeButton(row).click();
  const confirmation = removeConfirmation(page);
  await expect(confirmation.getByText(`Remove ${second.email}'s product-admin role?`, { exact: true })).toBeVisible();
  await confirmation.getByRole("button", { name: "Remove", exact: true }).click();

  await expect(toastWith(page, "Product admin removed")).toBeVisible();
  await expect(confirmation).toBeHidden();
  await expect(productAdminRow(page, second.email)).toHaveCount(0);
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/product-admins`);
  expect(await listedIds(page)).not.toContain(second.userId);
});

test("a product admin removes themselves while another remains: their own words, then /app, and product admin is closed to them", async ({ page, admins }) => {
  const admin = await productAdmin(admins, page);
  // The throwaway second admin: the removal is never of the last.
  await productAdmin(admins);
  await openProductAdmins(page);

  await removeButton(productAdminRow(page, admin.email)).click();
  const confirmation = removeConfirmation(page);
  await expect(
    confirmation.getByText("Remove your own product-admin role? You'll lose access to these pages at once.", { exact: true }),
  ).toBeVisible();
  await confirmation.getByRole("button", { name: "Remove", exact: true }).click();

  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
  await open(page, "/product-admin/product-admins");
  await expect(page).toHaveURL(`${E2E_WEB_URL}/app`);
  expect((await page.request.get("/api/v1/product-admin/product-admins")).status()).toBe(403);
});

test("the last-admin refusal (a routed 409 last_product_admin): decision 5's words in a toast, the confirmation closed, the admin kept", async ({
  page,
  admins,
}) => {
  const admin = await productAdmin(admins, page);
  await openProductAdmins(page);
  // The real rule is unreachable with other workers' admins on the list: the answer is routed (Preflight ruling 7).
  await page.route(`**/api/v1/product-admin/product-admins/${admin.userId}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ error: { code: "last_product_admin", message: LAST_PRODUCT_ADMIN_MESSAGE } }),
    });
  });

  await removeThroughConfirmation(page, productAdminRow(page, admin.email));
  await expect(toastWith(page, "Telflo needs at least one product admin.")).toBeVisible();
  await expect(removeConfirmation(page)).toBeHidden();
  await expect(page).toHaveURL(`${E2E_WEB_URL}/product-admin/product-admins`);
  await expect(productAdminRow(page, admin.email)).toHaveCount(1);
  expect(await listedIds(page)).toContain(admin.userId);
});

test("keeps the admins' emails masked: visible text inside ph-mask or ph-no-capture only, never an attribute, the title or the address; the typed email inside ph-no-capture", async ({
  page,
  admins,
}) => {
  const admin = await productAdmin(admins, page);
  const second = await productAdmin(admins);
  const person = await seedUser({ password: PASSWORD });
  await openProductAdmins(page);
  await expect(productAdminRow(page, second.email)).toHaveCount(1);
  await addEmailField(page).fill(person.email);
  await removeButton(productAdminRow(page, second.email)).click();
  await expect(removeConfirmation(page)).toBeVisible();

  // Collect, go to about:blank, then assert: no page showing anyone's email is open when an assertion can fail.
  const emails = [admin.email, second.email, person.email];
  const empty = emails.map(() => ({ masked: -1, unmasked: -1, inAttributes: -1 }));
  const places = await within(maskedPlacesOf(page, emails), 5_000, empty);
  const fieldInsideNoCapture = await within(
    page.evaluate(`(() => {
      const field = document.querySelector("input[name=email]");
      return field !== null && field.closest(".ph-no-capture") !== null && !field.hasAttribute("placeholder");
    })()`) as Promise<boolean>,
    5_000,
    false,
  );
  const address = page.url();
  await page.goto("about:blank");

  expect(places.map((place) => place.masked > 0), "each admin's email shown, masked").toEqual([true, true, false]);
  expect(places.map((place) => place.unmasked), "unmasked text nodes holding an email").toEqual([0, 0, 0]);
  expect(places.map((place) => place.inAttributes), "attributes (and the title) holding an email").toEqual([0, 0, 0]);
  expect(fieldInsideNoCapture, "the typed email's field inside ph-no-capture, with no placeholder").toBe(true);
  expect(emails.some((email) => address.includes(email) || address.includes(encodeURIComponent(email))), "an email in the address").toBe(false);
});
