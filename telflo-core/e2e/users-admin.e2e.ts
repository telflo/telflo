import { expect, test as base, type Page } from "@playwright/test";
import { addMember, findUsersByEmail, grantProductAdmin, revokeProductAdmin, seedUser, type SeededUser } from "./support/database.js";
import { open } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { maskedPlacesOf, recordToasts, toastsHolding, within } from "./support/privacy.js";
import { signInThroughApi } from "./support/session.js";
import { confirmField, deleteButton, deleteDialog, openUsers, searchBox, searchFor, userRow } from "./support/users-admin-page.js";
import { toastWith } from "./support/validation-pipelines-page.js";

// The Users page (D29 decisions 3, 9, 29, 38 and 45), in the browser: a
// product admin finds people by their address and by their group's name,
// sees why a delete is blocked, and deletes a person after typing their
// email; the person's other browser is signed out on its next request.
//
// - The page lists every account in the e2e database, parallel workers'
//   included: each test finds only its own people by searching for their
//   own addresses or group (never a count or the list's order).
// - Each test's product admin is made with grantProductAdmin and revoked
//   when the test ends, however it ends (`admins`).
// - The page shows other people's emails and organization names
//   (synthetic `e2e-<uuid>@example.com` fixtures): the privacy check
//   collects, goes to about:blank, then asserts (Preflight ruling 18).

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

/** A product admin of their own, made by the README's SQL, recorded for the revoke, and signed in on `page`. */
async function productAdmin(admins: string[], page: Page): Promise<SeededUser> {
  const admin = await seedUser({ password: PASSWORD });
  admins.push(admin.email);
  await grantProductAdmin(admin.email);
  await signInThroughApi(page, admin);
  return admin;
}

test("finds people by their address and by their group's name, case aside, and says when nothing matches", async ({ page, admins }) => {
  await productAdmin(admins, page);
  const byAddress = await seedUser({ password: PASSWORD });
  const inGroup = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: inGroup.userId });
  await openUsers(page);

  await searchFor(page, byAddress.email.toUpperCase());
  await expect(userRow(page, byAddress.email)).toHaveCount(1);
  await expect(userRow(page, inGroup.email)).toHaveCount(0);
  // The term never reaches the address bar.
  expect(page.url()).toBe(`${E2E_WEB_URL}/product-admin/users`);

  await searchFor(page, group.organizationName);
  await expect(userRow(page, inGroup.email)).toHaveCount(1);
  await expect(userRow(page, byAddress.email)).toHaveCount(0);

  await searchFor(page, `${byAddress.email}-nobody`);
  await expect(page.getByText("No users match the filter", { exact: true })).toBeVisible();
});

test("explains a block without offering a delete: a member of a group someone else is in, with the group's name and the role", async ({
  page,
  admins,
}) => {
  await productAdmin(admins, page);
  const person = await seedUser({ password: PASSWORD });
  const colleague = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: person.userId, role: "contributor" });
  await addMember({ userId: colleague.userId, organizationId: group.organizationId });
  await openUsers(page);
  await searchFor(page, person.email);

  await deleteButton(userRow(page, person.email)).click();
  const dialog = deleteDialog(page);
  await expect(dialog.getByRole("heading", { name: "Cannot delete user", exact: true })).toBeVisible();
  // Collected as a boolean, asserted on about:blank (decision 45, D23-2 Ruling 144).
  const sentence = `${person.email} is a member of organization ${group.organizationName} (contributor). Remove them from the organization before deleting this account.`;
  const explains = await within(
    dialog.textContent().then((text) => (text ?? "").replace(/\s+/g, " ").includes(sentence)),
    5_000,
    false,
  );
  await expect(dialog.getByRole("button", { name: "Permanently delete" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.goto("about:blank");
  expect(explains, "the member block's sentence around the email, the group's name and the role").toBe(true);
  expect((await findUsersByEmail(person.email))[0]?.deleted_at).toBeNull();
});

test("deletes a person after their email is typed: the toast, the row gone, and their other browser signed out on its next request", async ({
  page,
  browser,
  admins,
}) => {
  await productAdmin(admins, page);
  const toasts = await recordToasts(page);
  const person = await seedUser({ password: PASSWORD });
  const theirs = await browser.newContext({ baseURL: E2E_WEB_URL });
  try {
    const theirPage = await theirs.newPage();
    await signInThroughApi(theirPage, person);
    await open(theirPage, "/app");
    await expect(theirPage).toHaveURL(`${E2E_WEB_URL}/app`);

    await openUsers(page);
    await searchFor(page, person.email);
    await deleteButton(userRow(page, person.email)).click();
    const dialog = deleteDialog(page);
    await expect(dialog.getByRole("heading", { name: `Nuclear delete: ${person.email}`, exact: true })).toBeVisible();
    const permanently = dialog.getByRole("button", { name: "Permanently delete", exact: true });
    await expect(permanently).toBeDisabled();
    await confirmField(page).fill(person.email.slice(0, -1));
    await expect(permanently).toBeDisabled();
    await confirmField(page).fill(`  ${person.email} `);
    await permanently.click();

    await expect(toastWith(page, "Account permanently deleted")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(userRow(page, person.email)).toHaveCount(0);
    await expect(searchBox(page)).toBeFocused();
    // Read again from the server: the same search finds no one.
    const reread = page.waitForResponse((response) => new URL(response.url()).searchParams.get("q") === person.email);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    expect((await reread).status()).toBe(200);
    await expect(page.getByText("No users match the filter", { exact: true })).toBeVisible();
    const rows = await findUsersByEmail(person.email);
    expect(rows.length, "the address is free: no account holds it").toBe(0);

    // Their browser: its next request is refused, and its next navigation lands on sign-in.
    expect((await theirPage.request.get("/api/v1/auth/me")).status()).toBe(401);
    await theirPage.getByRole("link", { name: "Configurations", exact: true }).click();
    await expect(theirPage).toHaveURL("/login?redirectTo=%2Fapp");
  } finally {
    await theirs.close();
  }
  // Counted, asserted on about:blank (decision 45, D23-2 Ruling 144).
  const toastsWithTheEmail = toastsHolding(toasts, [person.email]).length;
  await page.goto("about:blank");
  expect(toastsWithTheEmail, "toasts holding the email").toBe(0);
});

test("keeps other people's emails and organization names masked: visible text inside ph-mask only, never an attribute, the title or the address; the search and the typed confirmation inside ph-no-capture", async ({
  page,
  admins,
}) => {
  await productAdmin(admins, page);
  const person = await seedUser({ password: PASSWORD });
  const blocked = await seedUser({ password: PASSWORD });
  const colleague = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: blocked.userId });
  await addMember({ userId: colleague.userId, organizationId: group.organizationId });
  await openUsers(page);

  // A search matching both (their group, and the person's address by a second search), the block open, then the confirmation typed.
  await searchFor(page, group.organizationName);
  await deleteButton(userRow(page, blocked.email)).click();
  await expect(deleteDialog(page).getByRole("heading", { name: "Cannot delete user", exact: true })).toBeVisible();
  const blockPlaces = await within(maskedPlacesOf(page, [blocked.email, group.organizationName]), 5_000, [
    { masked: -1, unmasked: -1, inAttributes: -1 },
    { masked: -1, unmasked: -1, inAttributes: -1 },
  ]);
  await deleteDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await searchFor(page, person.email);
  await deleteButton(userRow(page, person.email)).click();
  await confirmField(page).fill(person.email);
  const confirmPlaces = await within(maskedPlacesOf(page, [person.email]), 5_000, [{ masked: -1, unmasked: -1, inAttributes: -1 }]);
  const fieldsInsideNoCapture = await within(
    page.evaluate(`(() => {
      const search = document.querySelector("input[type=search]");
      const confirm = document.querySelector("[role=alertdialog] input");
      return [search, confirm].map((field) => field !== null && field.closest(".ph-no-capture") !== null && !field.hasAttribute("value"));
    })()`) as Promise<boolean[]>,
    5_000,
    [false, false],
  );
  const confirmHasNoPlaceholder = await within(
    page.evaluate(`!document.querySelector("[role=alertdialog] input").hasAttribute("placeholder")`) as Promise<boolean>,
    5_000,
    false,
  );
  const address = page.url();
  await page.goto("about:blank");

  expect(blockPlaces.map((place) => place.masked > 0), "the blocked person's email and group shown, masked").toEqual([true, true]);
  expect(blockPlaces.map((place) => place.unmasked), "unmasked text nodes").toEqual([0, 0]);
  expect(blockPlaces.map((place) => place.inAttributes), "attributes (and the title)").toEqual([0, 0]);
  expect(confirmPlaces.map((place) => place.masked > 0), "the person's email shown, masked").toEqual([true]);
  expect(confirmPlaces.map((place) => place.unmasked), "unmasked text nodes").toEqual([0]);
  expect(confirmPlaces.map((place) => place.inAttributes), "attributes (and the title)").toEqual([0]);
  expect(fieldsInsideNoCapture, "the search and the confirmation inside ph-no-capture, with no value attribute").toEqual([true, true]);
  expect(confirmHasNoPlaceholder, "the confirmation without a placeholder").toBe(true);
  const texts = [person.email, blocked.email, group.organizationName];
  expect(texts.some((text) => address.includes(text) || address.includes(encodeURIComponent(text))), "personal data in the address").toBe(false);
});
