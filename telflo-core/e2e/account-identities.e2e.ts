import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  findIdentities,
  findSessions,
  findUsersByEmail,
  removePassword,
  seedIdentity,
  seedUser,
  uniqueEmail,
} from "./support/database.js";
import { open } from "./support/editor-page.js";
import { E2E_OIDC_ISSUER, E2E_WEB_URL } from "./support/environment.js";
import { waitForEmail } from "./support/mail.js";
import { clickGoogle, signInAtProvider, startLinkingGoogle } from "./support/oidc.js";
import {
  attributeHoldersOf,
  recordRequestUrls,
  recordToasts,
  storageHolding,
  toastsHolding,
  urlsHolding,
} from "./support/privacy.js";
import { signInThroughForm, waitForHydration } from "./support/session.js";

// Settings › Account's sign-in methods, against the fake OpenID Provider the
// E2E API's Google settings name (start-fake-oidc-provider.ts,
// E2E_OIDC_ISSUER). Linking is by the provider's subject, whatever its email:
// each test's Google account has an address of its own, unlike the account's,
// so the card's "Linked as …" and a later Google sign-in show it was linked
// by `sub`.
//
// The card is hidden when no provider is configured and the account has no
// identity; the E2E API always configures the fake provider, so that case is
// covered by the web's unit tests (SignInMethodsCard.test.tsx and
// routes/settings.account.test.tsx, "hidden with no provider and no
// identity"), not here.
//
// Privacy: the account's email and the linked identity's email
// are visible text only, never in an attribute, a URL (the link's way back
// carries a fixed code), a toast or browser storage.

const PASSWORD = "correct horse battery staple";
const WRONG_PASSWORD = "not the right password at all";
const LINKED = "Google sign-in linked.";
const IDENTITY_IN_USE = "That Google account is already linked to another Telflo account.";

function linkButton(page: Page) {
  return page.getByRole("button", { name: "Link Google", exact: true });
}

function unlinkButton(page: Page) {
  return page.getByRole("button", { name: "Unlink Google", exact: true });
}

function linkedAs(page: Page, email: string) {
  return page.getByText(`Linked as ${email} on `);
}

/**
 * Notes, for the report, whether the page came back from the back/forward
 * cache (`pageshow`'s `persisted`) or was loaded again: browsers differ, and
 * Playwright's Chromium runs without the cache.
 */
async function noteHowThePageCameBack(page: Page): Promise<void> {
  const restored = await page.evaluate<boolean>("window.__e2eRestoredFromCache === true");
  test.info().annotations.push({ type: "back-forward cache", description: restored ? "restored" : "loaded again" });
}

const RECORD_PAGESHOW = `window.addEventListener("pageshow", (event) => { window.__e2eRestoredFromCache = event.persisted; })`;

/** Back from a link's round trip: `/settings/account?link=<code>`, the code removed with `replace`. */
async function backOnAccount(page: Page): Promise<void> {
  await page.waitForURL(`${E2E_WEB_URL}/settings/account`);
  await waitForHydration(page);
}

test("linking a Google account with another email: the password prompt, the round trip, the card, the email, and a later Google sign-in into the account", async ({
  page,
  context,
  browser,
}) => {
  const user = await seedUser({ password: PASSWORD });
  const google = { email: uniqueEmail("gmail.com"), sub: randomUUID() };
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  await signInThroughForm(page, user);
  await open(page, "/settings/account");
  await expect(page.getByText("Sign-in methods", { exact: true })).toBeVisible();
  await expect(linkButton(page)).toBeEnabled();

  // While typed, the password is in the field's value alone (the positive control), in no attribute.
  await startLinkingGoogle(page, PASSWORD, async (field) => {
    await expect(field).toHaveValue(PASSWORD);
    expect(await attributeHoldersOf(page, [PASSWORD])).toEqual([[]]);
  });
  await signInAtProvider(page, google);
  await backOnAccount(page);

  await expect(page.getByText(LINKED, { exact: true })).toBeVisible();
  await expect(linkedAs(page, google.email)).toBeVisible();
  await expect(unlinkButton(page)).toBeVisible();
  await expect(linkButton(page)).toHaveCount(0);

  // Linked by subject; no session started, no account made for the Google address.
  const identities = await findIdentities(user.userId);
  expect(identities).toHaveLength(1);
  expect(identities[0]).toMatchObject({ provider: "google", provider_subject: google.sub, email: google.email });
  expect(await findSessions(user.userId)).toHaveLength(1);
  expect(await findUsersByEmail(google.email)).toEqual([]);

  const email = await waitForEmail({ to: user.email, subject: "Google sign-in was linked to your Telflo account" });
  expect(email).toContain(`${E2E_WEB_URL}/settings/account`);
  expect(email).not.toContain(google.email);

  // The account's email and the identity's: visible text only. The password went in the
  // link start's body alone: in no URL of the round trip, no toast, no storage, no attribute.
  const canaries = [user.email, google.email];
  expect(await attributeHoldersOf(page, [...canaries, PASSWORD])).toEqual([[], [], []]);
  expect(await storageHolding(page, [...canaries, PASSWORD])).toEqual([]);
  expect(urlsHolding(urls, [...canaries, PASSWORD])).toEqual([]);
  expect(toastsHolding(toasts, [...canaries, PASSWORD])).toEqual([]);
  expect(urls.some((url) => new URL(url).searchParams.get("link") === "linked")).toBe(true);

  // A later Google sign-in, in another browser, lands in this account.
  const later = await browser.newContext({ baseURL: E2E_WEB_URL });
  try {
    const laterPage = await later.newPage();
    await open(laterPage, "/login");
    await clickGoogle(laterPage);
    await signInAtProvider(laterPage, google);
    await laterPage.waitForURL("/app");
    await waitForHydration(laterPage);
    await expect(laterPage.getByTitle("Switch organization")).toContainText(user.organizationName);
  } finally {
    await later.close();
  }
  expect(await findSessions(user.userId)).toHaveLength(2);
  expect(await findUsersByEmail(google.email)).toEqual([]);
});

test("a Google account already linked to another Telflo account is refused with identity_in_use's words", async ({ page, context }) => {
  const owner = await seedUser({ password: PASSWORD });
  const google = { email: uniqueEmail("gmail.com"), sub: randomUUID() };
  await seedIdentity({ userId: owner.userId, subject: google.sub, email: google.email });
  const user = await seedUser({ password: PASSWORD });
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  await signInThroughForm(page, user);
  await open(page, "/settings/account");

  await startLinkingGoogle(page, PASSWORD);
  await signInAtProvider(page, google);
  await backOnAccount(page);

  await expect(page.getByText(IDENTITY_IN_USE, { exact: true })).toBeVisible();
  await expect(linkButton(page)).toBeEnabled();
  expect(await findIdentities(user.userId)).toEqual([]);
  expect(await findIdentities(owner.userId)).toHaveLength(1);

  // The way back carries the fixed code alone; the toast is fixed words.
  const wayBack = urls.filter((url) => {
    const address = new URL(url);
    return address.origin === E2E_WEB_URL && address.pathname === "/settings/account" && address.search !== "";
  });
  expect(wayBack.length).toBeGreaterThan(0);
  for (const url of wayBack) expect(new URL(url).search).toBe("?link=identity_in_use");
  const canaries = [user.email, owner.email, google.email, PASSWORD];
  expect(toasts).toContain(IDENTITY_IN_USE);
  expect(toastsHolding(toasts, canaries)).toEqual([]);
  expect(urlsHolding(urls, canaries)).toEqual([]);
});

test("unlinking Google asks for the current password, removes the sign-in, keeps the session, and emails", async ({ page, context }) => {
  const user = await seedUser({ password: PASSWORD });
  const google = { email: uniqueEmail("gmail.com"), sub: randomUUID() };
  await seedIdentity({ userId: user.userId, subject: google.sub, email: google.email });
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  await signInThroughForm(page, user);
  await open(page, "/settings/account");
  await expect(linkedAs(page, google.email)).toBeVisible();

  await unlinkButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Unlink Google", exact: true });
  const field = dialog.getByLabel("Current Password");
  // The fake provider stands in for Google at Google's issuer: it re-links by email.
  await expect(dialog).toContainText(
    "If your Telflo address is this Google account's address, signing in with Google links it again.",
  );
  // A wrong password: the API's fixed words under the field, which is emptied. While typed, each
  // password is in the field's value alone (the positive control), in no attribute.
  await field.fill(WRONG_PASSWORD);
  await expect(field).toHaveValue(WRONG_PASSWORD);
  expect(await attributeHoldersOf(page, [WRONG_PASSWORD])).toEqual([[]]);
  await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(dialog.getByText("The current password is incorrect.", { exact: true })).toBeVisible();
  await expect(field).toHaveValue("");
  expect(await findIdentities(user.userId)).toHaveLength(1);

  await field.fill(PASSWORD);
  await expect(field).toHaveValue(PASSWORD);
  expect(await attributeHoldersOf(page, [PASSWORD])).toEqual([[]]);
  await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(page.getByText("Google sign-in removed.", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(linkButton(page)).toBeEnabled();
  await expect(linkedAs(page, google.email)).toHaveCount(0);

  expect(await findIdentities(user.userId)).toEqual([]);
  const sessions = await findSessions(user.userId);
  expect(sessions.map((session) => session.revoked_at)).toEqual([null]);
  const email = await waitForEmail({ to: user.email, subject: "Google sign-in was removed from your Telflo account" });
  expect(email).not.toContain(google.email);
  expect(email).toContain("If your Telflo address is this Google account's address, signing in with Google links it again.");

  const canaries = [user.email, google.email];
  expect(await attributeHoldersOf(page, canaries)).toEqual([[], []]);
  expect(await storageHolding(page, canaries)).toEqual([]);
  expect(urlsHolding(urls, canaries)).toEqual([]);
  expect(toastsHolding(toasts, canaries)).toEqual([]);
});

// Back from the provider's page must leave Settings › Account usable, whether
// the page comes back from the back/forward cache or is loaded again.
test("Back from the provider during a link with the password prompt leaves the page usable", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  await page.addInitScript(RECORD_PAGESHOW);
  await signInThroughForm(page, user);
  await open(page, "/settings/account");

  await startLinkingGoogle(page, PASSWORD);
  await page.goBack();
  await page.waitForURL(`${E2E_WEB_URL}/settings/account`);
  await noteHowThePageCameBack(page);

  const dialog = page.getByRole("dialog", { name: "Link Google", exact: true });
  // Either the dialog is gone, or it can at least be cancelled.
  if ((await dialog.count()) > 0 && (await dialog.isVisible())) {
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(linkButton(page)).toBeEnabled();
  expect(new URL(page.url()).origin).not.toBe(E2E_OIDC_ISSUER);
});

test("Back from the provider during a password-less account's link leaves the page usable", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD });
  await page.addInitScript(RECORD_PAGESHOW);
  await signInThroughForm(page, user);
  // Password-less from here on, its session kept: the link starts with no prompt.
  await removePassword(user.userId);
  await open(page, "/settings/account");
  await expect(page.getByText("Set a Password", { exact: true })).toBeVisible();

  await startLinkingGoogle(page);
  await page.goBack();
  await page.waitForURL(`${E2E_WEB_URL}/settings/account`);
  await noteHowThePageCameBack(page);

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(linkButton(page)).toBeEnabled();
});
