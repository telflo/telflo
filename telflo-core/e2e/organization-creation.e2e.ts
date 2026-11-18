import { expect, test as base, type Page } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  INVITATION_SIGN_IN_ONLY_MESSAGE,
  ORGANIZATION_CREATION_RESTRICTED_MESSAGE,
  PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE,
} from "@telflo/contracts";
import {
  grantProductAdmin,
  revokeProductAdmin,
  seedInvitation,
  seedUser,
  setOrganizationCreation,
  uniqueEmail,
} from "./support/database.js";
import { open } from "./support/editor-page.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { openProductAdmins } from "./support/product-admins-page.js";
import { signInThroughApi } from "./support/session.js";
import { toastWith } from "./support/validation-pipelines-page.js";

// Who may bring new people in (D36-1 decisions 51 and 52; Q252), on the
// default pair (invite-only, the open source's default):
//
// - A product admin turns on "Only product admins can create
//   organizations" on the Product admins page: an ordinary account's
//   Create Organization is then disabled with the reason, and the API
//   refuses its create; turned off again, it is offered again.
// - A personal organization sends no invitation (Q268, decision 57): its
//   Invited page offers no Invite Member, saying why, and the API refuses
//   an invite. One left from when the site was open can't make an
//   account: the accept page offers sign-in only, saying why, and the
//   registration is refused.
//
// The switch is one global row and other specs create organizations, so
// this spec runs alone, after every other spec, one browser at a time (the
// `*-exclusive` projects, playwright.config.ts's EXCLUSIVE_SPECS; Ruling
// 360). It starts from the browser tests' baseline, off (global-setup.ts's
// truncation), not a fresh install's default, on (Q259): the `admins`
// fixture sets that baseline before its test and puts it back however the
// test ends (the invitation's test doesn't depend on the switch).
// Run it alone with `--project chromium-exclusive --no-deps`.

const PASSWORD = "correct horse battery staple";

/** `admins`: every address a test made a product admin, revoked when it ends; the switch is off when it starts and again then too. */
const test = base.extend<{ admins: string[] }>({
  // eslint-disable-next-line no-empty-pattern
  admins: async ({}, use) => {
    const made: string[] = [];
    await setOrganizationCreation("everyone");
    try {
      await use(made);
    } finally {
      await setOrganizationCreation("everyone");
      for (const email of made) await revokeProductAdmin(email);
    }
  },
});

test.use({ viewport: { width: 1440, height: 1000 } });

const switchOf = (page: Page) => page.getByRole("switch", { name: "Only product admins can create organizations" });

/** POST /api/v1/organizations as the page's session: the status only. */
async function createThroughApi(page: Page, name: string): Promise<number> {
  const response = await page.request.post("/api/v1/organizations", {
    data: { name },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  return response.status();
}

test("a product admin keeps creating organizations to product admins and back: the person's Create Organization is disabled with the reason, and the API refuses it", async ({
  page,
  browser,
  admins,
}) => {
  const admin = await seedUser({ password: PASSWORD });
  admins.push(admin.email);
  await grantProductAdmin(admin.email);
  await signInThroughApi(page, admin);
  await openProductAdmins(page);
  await expect(switchOf(page)).not.toBeChecked();

  const personContext = await browser.newContext();
  try {
    const personPage = await personContext.newPage();
    await signInThroughApi(personPage, await seedUser({ password: PASSWORD }));
    await open(personPage, "/settings/organization");
    await expect(personPage.getByRole("button", { name: "Create Organization" })).toBeEnabled();

    // On: nothing else runs meanwhile (the exclusive projects).
    await switchOf(page).click();
    await expect(toastWith(page, "Only product admins can create organizations now")).toBeVisible();
    await expect(switchOf(page)).toBeChecked();
    expect(await createThroughApi(personPage, `E2E Refused ${Date.now()}`)).toBe(403);
    await personPage.reload();
    await expect(personPage.getByRole("button", { name: "Create Organization" })).toBeDisabled();
    await expect(personPage.getByText(ORGANIZATION_CREATION_RESTRICTED_MESSAGE, { exact: true })).toBeVisible();

    // Off again.
    await switchOf(page).click();
    await expect(toastWith(page, "Anyone with an account can create organizations now")).toBeVisible();
    await expect(switchOf(page)).not.toBeChecked();
    await personPage.reload();
    await expect(personPage.getByRole("button", { name: "Create Organization" })).toBeEnabled();
  } finally {
    await personContext.close();
  }
});

test("a personal organization sends no invitation: no Invite Member, the API refuses; one left from an open site can't make an account: the accept page offers sign-in only, saying why, and the registration is refused", async ({
  page,
  browser,
}) => {
  const inviter = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, inviter);

  // The Invited page says why in Invite Member's place (D36-1 decision 57, Q268).
  await open(page, "/org-admin");
  await expect(page.getByText(PERSONAL_ORGANIZATION_INVITATIONS_DISABLED_MESSAGE, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite Member" })).toHaveCount(0);
  // The request made anyway is refused.
  const sent = await page.request.post(`/api/v1/organizations/${inviter.organizationId}/invitations`, {
    data: { email: uniqueEmail(), role: "contributor" },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  const sentCode = ((await sent.json()) as { error?: { code?: string } }).error?.code;
  expect({ status: sent.status(), code: sentCode }).toEqual({ status: 403, code: "personal_organization_invitations_disabled" });

  // An invitation left from when the site was open (decision 52 is its backstop).
  const stranger = uniqueEmail();
  const token = await seedInvitation({ organizationId: inviter.organizationId, email: stranger });
  // A personal workspace named by its owner's email is "<email>'s organization" (D36-1 Q264).
  expect(inviter.organizationName).toBe(inviter.email.toLowerCase());

  const visitorContext = await browser.newContext({ baseURL: E2E_WEB_URL });
  try {
    const visitor = await visitorContext.newPage();
    await visitor.goto(`/accept-invitation#token=${token}`);
    await expect(visitor.getByRole("button", { name: "Sign In & Join" })).toBeVisible();
    await expect(
      visitor.getByRole("heading", { name: `Sign in to join ${inviter.organizationName}'s organization`, exact: true }),
    ).toBeVisible();
    await expect(visitor.getByText(INVITATION_SIGN_IN_ONLY_MESSAGE, { exact: true })).toBeVisible();
    await expect(visitor.getByRole("button", { name: "Create Account & Join" })).toHaveCount(0);
    await expect(visitor.getByLabel("Confirm Password")).toHaveCount(0);

    // The registration itself, as a visitor's browser would send it.
    const registered = await visitor.request.post("/api/v1/invitation-registrations", {
      data: { token, password: PASSWORD },
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
    const status = registered.status();
    const code = ((await registered.json()) as { error?: { code?: string } }).error?.code;
    await visitor.goto("about:blank");
    expect({ status, code }).toEqual({ status: 403, code: "registration_not_open" });
  } finally {
    await visitorContext.close();
  }
});
