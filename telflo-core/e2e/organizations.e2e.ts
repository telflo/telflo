import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { addMember, seedUser, type SeededMembership, type SeededUser } from "./support/database.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { memberRow } from "./support/permissions.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";

// Organizations, membership and switching, in the browser. These tests add a
// second member by SQL (support/database.ts's addMember), since joining is
// not what they test; invitations.e2e.ts joins through the invitations. A
// second person is a second browser context: their own cookie jar, signed in
// on their own.

const PASSWORD = "correct horse battery staple";

/**
 * `secondContext`: a second browser, for a second person, with its own
 * cookie jar. Closed when the test ends.
 */
const test = base.extend<{ secondContext: BrowserContext }>({
  secondContext: async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: E2E_WEB_URL });
    await use(context);
    await context.close();
  },
});

/** The sidebar footer's popover trigger, which shows the active organization. */
function organizationSwitcher(page: Page) {
  return page.getByTitle("Switch organization");
}

/** The signed-in shell at /app, with `organizationName` in the sidebar footer. */
async function expectInOrganization(page: Page, organizationName: string): Promise<void> {
  await expect(page).toHaveURL("/app");
  await expect(organizationSwitcher(page)).toContainText(organizationName);
}

/** A full page load of `path`, hydrated. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

/**
 * The page's next client-side navigation: the sidebar's Configurations link,
 * to /app. The signed-in layout's loader runs on every navigation, so it
 * asks the API again.
 */
async function navigate(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Configurations" }).click();
}

/** Switches from the sidebar footer's popover, as a person does. */
async function switchFromPopover(page: Page, organizationName: string): Promise<void> {
  await organizationSwitcher(page).click();
  await page.getByRole("dialog").getByRole("button", { name: organizationName }).click();
}

/**
 * A second person in `context`, signed in and moved to `organizationId`
 * through the API, on /app.
 */
async function openAsSecondPerson(context: BrowserContext, user: SeededUser, organizationId: string): Promise<Page> {
  const page = await context.newPage();
  await signInThroughApi(page, user);
  await switchOrganizationThroughApi(page, organizationId);
  await open(page, "/app");
  return page;
}

/**
 * An admin and a second member of one new group organization, the admin
 * signed in and already in it (still on whatever page is open).
 */
async function seedGroupWithMember(
  page: Page,
  memberRole: "admin" | "contributor",
): Promise<{ admin: SeededUser; member: SeededUser; group: SeededMembership }> {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: member.userId, organizationId: group.organizationId, role: memberRole });
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);
  return { admin, member, group };
}

test("creating an organization lands in it, with its name in the sidebar footer; switching back from the popover returns to the personal organization", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const name = `Org ${randomUUID()}`;
  await signInThroughApi(page, user);
  await open(page, "/settings/organization");

  await page.getByRole("button", { name: "Create Organization" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Organization" });
  await dialog.getByLabel("Organization Name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expectInOrganization(page, name);
  await expect(dialog).toBeHidden();

  await switchFromPopover(page, user.organizationName);

  await expectInOrganization(page, user.organizationName);
  // The new organization is still listed, to switch back to.
  await organizationSwitcher(page).click();
  await expect(page.getByRole("dialog").getByRole("button", { name })).toBeVisible();
});

test("after a switch in one tab, the other tab's next navigation shows the new organization, still signed in", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  // Signed in before joining the group: the session starts in the personal organization.
  await signInThroughApi(page, user);
  const group = await addMember({ userId: user.userId });
  const otherTab = await context.newPage();
  for (const tab of [page, otherTab]) {
    await open(tab, "/app");
    await expectInOrganization(tab, user.organizationName);
  }

  await switchFromPopover(page, group.organizationName);
  await expectInOrganization(page, group.organizationName);

  // The other tab still shows what it last loaded until it navigates.
  await expect(organizationSwitcher(otherTab)).toContainText(user.organizationName);
  await navigate(otherTab);

  await expectInOrganization(otherTab, group.organizationName);
});

test("a removed member's next navigation lands in their personal organization, still signed in; once restored, they can switch back", async ({
  page,
  secondContext,
}) => {
  const { member, group } = await seedGroupWithMember(page, "contributor");
  const memberPage = await openAsSecondPerson(secondContext, member, group.organizationId);
  await expectInOrganization(memberPage, group.organizationName);

  await open(page, "/org-admin/active-members");
  await memberRow(page, member.email).getByRole("button", { name: "Delete", exact: true }).click();
  const removeDialog = page.getByRole("alertdialog", { name: "Remove Member" });
  await removeDialog.getByRole("button", { name: "Delete Member" }).click();
  await expect(page.getByText(`${member.email} has been removed from the organization`)).toBeVisible();

  await navigate(memberPage);

  await expectInOrganization(memberPage, member.organizationName);
  await organizationSwitcher(memberPage).click();
  const memberPopover = memberPage.getByRole("dialog");
  await expect(memberPopover.getByRole("button", { name: member.organizationName })).toBeVisible();
  await expect(memberPopover.getByRole("button", { name: group.organizationName })).toBeHidden();
  await memberPage.keyboard.press("Escape");

  await page.getByRole("button", { name: "Deleted" }).click();
  await memberRow(page, member.email).getByRole("button", { name: "Restore" }).click();
  const restoreDialog = page.getByRole("alertdialog", { name: "Restore Member" });
  await restoreDialog.getByRole("button", { name: "Restore Member" }).click();
  await expect(page.getByText(`${member.email} has been restored to the organization`)).toBeVisible();

  await navigate(memberPage);
  await switchFromPopover(memberPage, group.organizationName);

  await expectInOrganization(memberPage, group.organizationName);
});

test("after an admin changes a member's role to contributor, the member's Permissions item disappears on their next navigation", async ({
  page,
  secondContext,
}) => {
  const { member, group } = await seedGroupWithMember(page, "admin");
  const memberPage = await openAsSecondPerson(secondContext, member, group.organizationId);
  await expect(memberPage.getByRole("link", { name: "Permissions" })).toBeVisible();

  await open(page, "/org-admin/active-members");
  await memberRow(page, member.email).getByRole("button", { name: "admin", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change Role" });
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Contributor" }).click();
  await dialog.getByRole("button", { name: "Update Role" }).click();
  await expect(page.getByText(`${member.email} role changed to contributor`)).toBeVisible();

  await navigate(memberPage);

  await expectInOrganization(memberPage, group.organizationName);
  await expect(memberPage.getByRole("link", { name: "Permissions" })).toBeHidden();
});

test("deleting an organization while another member is in it leaves both in their personal organizations", async ({
  page,
  secondContext,
}) => {
  const { admin, member, group } = await seedGroupWithMember(page, "contributor");
  const memberPage = await openAsSecondPerson(secondContext, member, group.organizationId);
  await expectInOrganization(memberPage, group.organizationName);

  await open(page, "/settings/organization");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit Organization" }).getByRole("button", { name: "Delete Organization" }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete Organization" });
  const confirm = confirmation.getByRole("button", { name: "Delete Organization" });
  await expect(confirm).toBeDisabled();
  await confirmation.getByLabel("Organization name").fill(group.organizationName);
  await confirm.click();

  await expect(page.getByText(`${group.organizationName} has been deleted`)).toBeVisible();
  await expectInOrganization(page, admin.organizationName);

  await navigate(memberPage);

  await expectInOrganization(memberPage, member.organizationName);
});

test("a contributor visiting /org-admin lands on /app", async ({ page }) => {
  const admin = await seedUser({ password: PASSWORD });
  const contributor = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId });
  await addMember({ userId: contributor.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, contributor);
  await switchOrganizationThroughApi(page, group.organizationId);

  await open(page, "/org-admin");

  await expectInOrganization(page, group.organizationName);
  await expect(page.getByRole("link", { name: "Permissions" })).toBeHidden();
});
