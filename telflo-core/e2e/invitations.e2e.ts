import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import {
  addMember,
  expireInvitation,
  findMemberships,
  findUsersByEmail,
  seedUser,
  uniqueEmail,
  type SeededMembership,
} from "./support/database.js";
import { E2E_SAAS_WEB_URL, E2E_WEB_URL } from "./support/environment.js";
import { emailSubjectsTo, linkFrom, waitForEmail } from "./support/mail.js";
import { clickGoogle, signInAtProvider } from "./support/oidc.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";

// Organization invitations, in the browser: an admin invites from the
// Invited tab, the invitee follows the emailed link to /accept-invitation
// and joins by whichever path fits them, and lands in the organization with
// the welcome callout. The admin is a second browser context (`inviter`),
// with their own cookie jar; `page` is the invitee's.
//
// Every invitation goes through the E2E API and Mailpit, so the link a test
// opens is the one the email carries. Each test invites its own addresses
// into its own organization (`group-<uuid>`, no quotes, since the subject
// goes into Mailpit's search), so tests and browsers run in parallel.

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new and long enough password";
const INVALID_LINK_MESSAGE = "Invalid or expired invite link. Please ask your admin to resend the invitation.";
const EXPIRED_LINK_MESSAGE = "This invitation link has expired. Please ask your admin to resend the invitation.";

function invitationSubject(organizationName: string): string {
  return `You've been invited to join ${organizationName} on Telflo`;
}

interface Inviter {
  /** The admin's page, in a browser of their own, on no page yet. */
  page: Page;
  /** The group organization they administer, and invite to. */
  group: SeededMembership;
}

/**
 * An admin of a new group organization, signed in and switched into it, in a
 * browser context of their own, which `close` ends.
 */
async function newInviter(browser: Browser, baseURL: string): Promise<Inviter & { close: () => Promise<void> }> {
  const admin = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);
  return { page, group, close: () => context.close() };
}

/**
 * `inviter`: `newInviter`'s admin, closed when the test ends, on the test's
 * pair (its baseURL: the default pair's, or the SaaS pair's in a describe
 * that uses it), so the API that emails the link names that pair's web server.
 */
const test = base.extend<{ inviter: Inviter }>({
  inviter: async ({ browser, baseURL }, use) => {
    const { close, ...inviter } = await newInviter(browser, baseURL ?? E2E_WEB_URL);
    await use(inviter);
    await close();
  },
});

/** A full page load of `path`, hydrated. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

/** Invites `email` as a contributor through the API, as the admin's session. */
async function inviteThroughApi(adminPage: Page, organizationId: string, email: string): Promise<void> {
  const response = await adminPage.request.post(`/api/v1/organizations/${organizationId}/invitations`, {
    data: { email, role: "contributor" },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(201);
}

/**
 * The accept link in the newest invitation email to `email`, once `count`
 * of them have arrived. Its token is in the fragment.
 */
async function invitationLink(email: string, organizationName: string, count = 1): Promise<string> {
  const text = await waitForEmail({ to: email, subject: invitationSubject(organizationName), count });
  const link = linkFrom(text, "/accept-invitation");
  expect(new URL(link).search).toBe("");
  expect(new URL(link).hash).toMatch(/^#token=[A-Za-z0-9_-]+$/);
  return link;
}

/** The token in a link's `#token=…` fragment. */
function tokenOf(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  if (!token) throw new Error(`no token in ${link}`);
  return token;
}

/** The admin invites `email` and the test reads the link from the email. */
async function invite(adminPage: Page, group: SeededMembership, email: string): Promise<string> {
  await inviteThroughApi(adminPage, group.organizationId, email);
  return invitationLink(email, group.organizationName);
}

/** An invitation's row on the Invited tab. */
function invitationRow(page: Page, email: string) {
  return page.getByRole("row").filter({ hasText: email });
}

/** The sidebar footer's popover trigger, which shows the active organization. */
function organizationSwitcher(page: Page) {
  return page.getByTitle("Switch organization");
}

/**
 * Landed in the organization after joining: `/app` with `joined_org`
 * removed, the organization in the sidebar footer, and the welcome callout
 * on the switcher, which "Got it" closes.
 */
async function expectJoined(page: Page, organizationName: string): Promise<void> {
  await expect(page).toHaveURL("/app");
  await expect(organizationSwitcher(page)).toContainText(organizationName);
  await expect(page.getByText(`Welcome to the ${organizationName} organization`)).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByText(`Welcome to the ${organizationName} organization`)).toBeHidden();
}

/** The user at `email` is an active member of the organization, in `role`. */
async function expectMember(email: string, organizationId: string, role: "admin" | "contributor"): Promise<void> {
  const [user] = await findUsersByEmail(email);
  if (!user) throw new Error(`no user at ${email}`);
  const memberships = await findMemberships(user.id);
  expect(memberships.find((membership) => membership.organization_id === organizationId)).toMatchObject({
    role,
    deleted_at: null,
  });
}

/**
 * Creates the account from the "Join {organization} on Telflo" form already
 * open, on the default pair: the open source's defaults ask for no Terms,
 * so there is no checkbox to tick, nor a divider.
 */
async function createAccountAndJoin(page: Page, password: string): Promise<void> {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password", { exact: true }).fill(password);
  await expect(page.getByRole("checkbox", { name: /I agree to the/ })).toHaveCount(0);
  await expect(page.getByText("Usage policies", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create Account & Join" }).click();
}

test("an admin invites two addresses at once from the dialog; both are listed on the Invited tab, and both emails arrive", async ({
  inviter: { page, group },
}) => {
  const first = uniqueEmail();
  const second = uniqueEmail();
  await open(page, "/org-admin");
  await expect(page.getByText("No pending invitations")).toBeVisible();

  await page.getByRole("button", { name: "Invite Member" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite Members" });
  await dialog.getByLabel("Email Addresses").fill(`${first}, ${second}`);
  await dialog.getByRole("button", { name: "Send Invitations" }).click();
  await expect(dialog.getByText("Invitations Sent")).toBeVisible();
  // The dialog stays open on success, and hides the page behind it from
  // assistive technology until it closes.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  for (const email of [first, second]) {
    await expect(invitationRow(page, email)).toContainText("contributor");
  }
  await expect(page.getByRole("button", { name: /^Invited/ })).toHaveText(/^Invited\s*2$/);

  for (const email of [first, second]) {
    await invitationLink(email, group.organizationName);
  }
});

test("a new address opens the link, creates an account, and lands in the organization with the callout; no verification email", async ({
  page,
  inviter: { page: adminPage, group },
}) => {
  const email = uniqueEmail();
  const link = await invite(adminPage, group, email);

  await open(page, link);
  await expect(page.getByRole("heading", { name: `Join ${group.organizationName} on Telflo` })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await createAccountAndJoin(page, NEW_PASSWORD);

  await expectJoined(page, group.organizationName);
  await expectMember(email, group.organizationId, "contributor");
  const [user] = await findUsersByEmail(email);
  // The link proved the mailbox: verified, and nothing asks to confirm it.
  expect(user?.email_verified_at).not.toBeNull();
  expect(await emailSubjectsTo(email)).toEqual([invitationSubject(group.organizationName)]);
});

test("an existing account, signed out, opens the link, signs in with its password from the page, and joins", async ({
  page,
  inviter: { page: adminPage, group },
}) => {
  const invitee = await seedUser({ password: PASSWORD });
  const link = await invite(adminPage, group, invitee.email);

  await open(page, link);
  await expect(page.getByRole("heading", { name: `Sign in to join ${group.organizationName}` })).toBeVisible();
  const email = page.getByLabel("Email");
  await expect(email).toHaveValue(invitee.email);
  await expect(email).not.toBeEditable();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In & Join" }).click();

  await expectJoined(page, group.organizationName);
  await expectMember(invitee.email, group.organizationId, "contributor");
});

test("an existing account already signed in as the invited address accepts with one click", async ({
  page,
  inviter: { page: adminPage, group },
}) => {
  const invitee = await seedUser({ password: PASSWORD });
  const link = await invite(adminPage, group, invitee.email);
  await signInThroughApi(page, invitee);

  await open(page, link);
  await expect(page.getByRole("heading", { name: `Join ${group.organizationName}`, exact: true })).toBeVisible();
  await expect(page.getByText("You've been invited with the contributor role.")).toBeVisible();
  await page.getByRole("button", { name: "Accept Invitation" }).click();

  await expectJoined(page, group.organizationName);
  await expectMember(invitee.email, group.organizationId, "contributor");
});

test("signed in as another address, the link refuses with the invited address; after Sign out, signing in as the invited address joins", async ({
  page,
  inviter: { page: adminPage, group },
}) => {
  const invitee = await seedUser({ password: PASSWORD });
  const other = await seedUser({ password: PASSWORD });
  const link = await invite(adminPage, group, invitee.email);
  await signInThroughApi(page, other);

  await open(page, link);
  await expect(
    page.getByText(`This invitation was sent to ${invitee.email}. Sign in with that address to accept it.`),
  ).toBeVisible();
  await expect(page.getByText(`Signed in as ${other.email}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept Invitation" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page.getByRole("heading", { name: `Sign in to join ${group.organizationName}` })).toBeVisible();
  expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);
  await expect(page.getByLabel("Email")).toHaveValue(invitee.email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign In & Join" }).click();

  await expectJoined(page, group.organizationName);
  await expectMember(invitee.email, group.organizationId, "contributor");
  const [otherUser] = await findUsersByEmail(other.email);
  expect(
    (await findMemberships(otherUser?.id ?? "")).some((membership) => membership.organization_id === group.organizationId),
  ).toBe(false);
});

// The SaaS pair: the Terms asked; the inviter on the same pair, so the emailed link is its web server's.
test.describe("on the SaaS pair", () => {
  test.use({ baseURL: E2E_SAAS_WEB_URL });

  test("a new Google account joins from the link: it comes back to the page, accepts, accepts the terms, and sees the callout", async ({
    page,
    inviter: { page: adminPage, group },
  }) => {
    const email = uniqueEmail("gmail.com");
    const link = await invite(adminPage, group, email);

    await open(page, link);
    await expect(page.getByRole("heading", { name: `Join ${group.organizationName} on Telflo` })).toBeVisible();
    // The token stays in this tab's sessionStorage, never in the Google link.
    await expect(page.getByRole("link", { name: "Google" })).toHaveAttribute(
      "href",
      "/api/v1/auth/oidc/google?redirectTo=%2Faccept-invitation",
    );
    await clickGoogle(page);
    await signInAtProvider(page, { email });

    await page.waitForURL("/accept-invitation");
    await waitForHydration(page);
    await expect(page.getByRole("heading", { name: `Join ${group.organizationName}`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept Invitation" }).click();

    // A new Google account has the terms still to accept; the callout waits.
    const termsDialog = page.getByRole("dialog", { name: "Updated Terms of Service" });
    await expect(termsDialog).toBeVisible();
    await expect(page).toHaveURL(/\/app\?joined_org=/);
    await termsDialog.getByLabel("I agree to the Terms of Service and Privacy Policy").check();
    await termsDialog.getByRole("button", { name: "Accept" }).click();
    await expect(termsDialog).toBeHidden();

    await expectJoined(page, group.organizationName);
    await expectMember(email, group.organizationId, "contributor");
  });
});

test("after a resend, the first link shows the invalid-link message and the second one works", async ({
  page,
  context,
  inviter: { page: adminPage, group },
}) => {
  const email = uniqueEmail();
  const firstLink = await invite(adminPage, group, email);

  await open(adminPage, "/org-admin");
  await invitationRow(adminPage, email).getByRole("button", { name: "Resend" }).click();
  await expect(adminPage.getByText("Invitation resent")).toBeVisible();
  const secondLink = await invitationLink(email, group.organizationName, 2);
  expect(tokenOf(secondLink)).not.toBe(tokenOf(firstLink));

  await open(page, firstLink);
  await expect(page.getByText(INVALID_LINK_MESSAGE)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Telflo" })).toBeVisible();

  // The second link from the email, in a new tab, as a mail client opens it.
  const secondPage = await context.newPage();
  await open(secondPage, secondLink);
  await expect(secondPage.getByRole("heading", { name: `Join ${group.organizationName} on Telflo` })).toBeVisible();
  await createAccountAndJoin(secondPage, NEW_PASSWORD);

  await expectJoined(secondPage, group.organizationName);
  await expectMember(email, group.organizationId, "contributor");
});

test("after the admin cancels the invitation, its link shows the invalid-link message", async ({
  page,
  inviter: { page: adminPage, group },
}) => {
  const email = uniqueEmail();
  const link = await invite(adminPage, group, email);

  await open(adminPage, "/org-admin");
  await invitationRow(adminPage, email).getByRole("button", { name: "Cancel", exact: true }).click();
  const dialog = adminPage.getByRole("alertdialog", { name: "Cancel Invitation" });
  await dialog.getByRole("button", { name: "Cancel Invitation" }).click();
  await expect(adminPage.getByText(`Invitation cancelled for ${email}`)).toBeVisible();
  await expect(invitationRow(adminPage, email)).toHaveCount(0);

  await open(page, link);

  await expect(page.getByText(INVALID_LINK_MESSAGE)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Telflo" })).toHaveAttribute("href", "/app");
});

test("an expired invitation's link shows the expired message, and the Invited tab says Expired", async ({
  page,
  inviter: { page: adminPage, group },
}) => {
  const email = uniqueEmail();
  const link = await invite(adminPage, group, email);
  await expireInvitation({ organizationId: group.organizationId, email });

  await open(page, link);

  await expect(page.getByText(EXPIRED_LINK_MESSAGE)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Telflo" })).toHaveAttribute("href", "/app");

  await open(adminPage, "/org-admin");
  await expect(invitationRow(adminPage, email)).toContainText("Expired");
});

test("the link's token is gone from the address bar once the page has loaded, and no request carries it in its URL", async ({
  page,
  inviter: { page: adminPage, group },
}) => {
  const email = uniqueEmail();
  const link = await invite(adminPage, group, email);
  const token = tokenOf(link);
  const requestUrls: string[] = [];
  page.on("request", (request) => requestUrls.push(request.url()));

  await open(page, link);
  await expect(page.getByRole("heading", { name: `Join ${group.organizationName} on Telflo` })).toBeVisible();

  expect(new URL(page.url()).pathname).toBe("/accept-invitation");
  expect(new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain(token);
  expect(requestUrls.length).toBeGreaterThan(0);
  expect(requestUrls.filter((url) => url.includes(token))).toEqual([]);
});

test("a second link opened in the tab already on the accept page shows the second invitation, and leaves the address bar clean", async ({
  page,
  browser,
  inviter: { page: adminPage, group },
}) => {
  const firstLink = await invite(adminPage, group, uniqueEmail());
  // The second invitation is to another organization, from its own admin.
  const other = await newInviter(browser, E2E_WEB_URL);
  let secondLink: string;
  try {
    secondLink = await invite(other.page, other.group, uniqueEmail());
  } finally {
    await other.close();
  }

  await open(page, firstLink);
  await expect(page.getByRole("heading", { name: `Join ${group.organizationName} on Telflo` })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");

  // Pasting the second link into this tab changes only the fragment: no load.
  // A string, evaluated in the page: the E2E code is typechecked without DOM types.
  await page.evaluate(`window.location.hash = ${JSON.stringify(new URL(secondLink).hash)}`);

  await expect(page.getByRole("heading", { name: `Join ${other.group.organizationName} on Telflo` })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain(tokenOf(secondLink));
  await createAccountAndJoin(page, NEW_PASSWORD);

  await expectJoined(page, other.group.organizationName);
});
