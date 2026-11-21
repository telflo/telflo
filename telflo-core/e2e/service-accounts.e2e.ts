import { randomUUID } from "node:crypto";
import { expect, test as base, type BrowserContext, type Locator, type Page, type Response } from "@playwright/test";
import {
  API_TOKEN_PATTERN,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  INVALID_API_TOKEN_MESSAGE,
  type CreatedApiTokenResponse,
  type ServiceAccountResponse,
} from "@telflo/contracts";
import { expectBearersOnlyInNoCapture } from "./support/bearers.js";
import { addMember, expireApiToken, seedConfiguration, seedUser, type SeededUser } from "./support/database.js";
import { E2E_WEB_URL } from "./support/environment.js";
import { memberRow } from "./support/permissions.js";
import { attributeHoldersOf, placesOf, recordRequestUrls, recordToasts, storageHolding, toastsHolding, urlsHolding } from "./support/privacy.js";
import {
  createApiTokenThroughApi,
  createServiceAccountThroughApi,
  deleteServiceAccountThroughApi,
  whoami,
  type WhoAmIAnswer,
} from "./support/service-accounts.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";

// Settings › Service Accounts and the public surface's /whoami, in the
// browser, against the E2E API. Each test works in an organization of its own
// (a new user's, or a new group's), so tests and browsers run in parallel.
//
// A `tf_` token is a secret. Every token here is built by the API at run
// time and read from the create's reply (`page.waitForResponse`, or
// `page.request`'s for a token the test isn't about), never written in this
// file. No assertion prints one: a token is never given to `hasText` or
// `getByText` (Playwright prints them), and anything that could hold a
// token or its prefix (a reply's body, the page, URLs, toasts, storage) is
// checked with booleans before it is compared. A failed run's trace holds
// the reply, and so an e2e-only token: the recorded residue.
//
// A service account's name and address, and a token's name, are
// organization content: visible text inside the masked shell only, never
// in an attribute, a URL, a toast, the page's title or browser storage.
// The tests use canary names and look for them there.

const PASSWORD = "correct horse battery staple";
const ACCOUNT_PATH = "/api/v1/organizations/[^/]+/service-accounts";
const CREATE_ACCOUNT_PATH = new RegExp(`^${ACCOUNT_PATH}$`);
const TOKENS_PATH = new RegExp(`^${ACCOUNT_PATH}/[^/]+/api-tokens$`);
const REVEAL_WORDS = "This is the only time you'll see it. If you lose it, revoke this token and create a new one.";
const CONFIRM_LABEL = "This cannot be undone. Type the account's name to confirm.";
const KEPT_WORDS =
  "Configurations, configuration versions, validation pipelines and rules, and test suites and runs it created are kept; configurations and their versions still show its address as their creator.";

/** A suffix no other test uses. */
const unique = () => randomUUID().slice(0, 8);

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

/** A full page load of `path`, hydrated. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

function isPostTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname);
}

/** The Settings nav's item (a button, as every item). */
function navItem(page: Page, label: string): Locator {
  return page.getByRole("navigation").getByRole("button", { name: label, exact: true });
}

/** The list's row for the account named `name`, by its link. */
function accountRow(page: Page, name: string): Locator {
  return page.locator("tbody tr").filter({ has: page.getByRole("link", { name, exact: true }) });
}

/** The account page's token row named `name`. */
function tokenRow(page: Page, name: string): Locator {
  return page.locator("tbody tr").filter({ has: page.getByText(name, { exact: true }) });
}

function revealDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Copy your token" });
}

/** A token's prefix: its first 11 characters. */
function prefixOf(token: string): string {
  return token.slice(0, 11);
}

/**
 * "Create token" on the account's page, as an admin does: the name, write
 * access when asked, the expiry's days when given. The reply is 201 and
 * `no-store`, its token of the right shape (checked as booleans); the
 * reveal opens. Answers the token.
 */
async function createTokenOnPage(
  page: Page,
  { name, write, expiresInDays }: { name: string; write: boolean; expiresInDays?: number },
): Promise<string> {
  await page.getByRole("button", { name: "Create token" }).click();
  const dialog = page.getByRole("dialog", { name: "Create API token" });
  await dialog.getByLabel("Name").fill(name);
  if (write) await dialog.getByRole("checkbox", { name: "Allow write access" }).check();
  if (expiresInDays !== undefined) await dialog.getByLabel("Expires in (days, optional)").fill(String(expiresInDays));
  const answered = page.waitForResponse(isPostTo(TOKENS_PATH));
  await dialog.getByRole("button", { name: "Create token" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const { token } = (await response.json()) as CreatedApiTokenResponse;
  expect(API_TOKEN_PATTERN.test(token), "the reply carries a tf_ token").toBe(true);
  await expect(dialog).toBeHidden();
  await expect(revealDialog(page)).toBeVisible();
  // Its words by an element of their own: a matcher on the dialog would print its text, the token's too.
  await expect(revealDialog(page).getByText(REVEAL_WORDS, { exact: true })).toBeVisible();
  return token;
}

/**
 * The token is nowhere in the page any more, nor its prefix outside the
 * list's text: the serialized document (every text, attribute and the
 * title), checked as booleans.
 */
async function expectTokenGone(page: Page, token: string): Promise<void> {
  const html = await page.content();
  expect(html.includes(token), "the page holds the token").toBe(false);
  expect(html.includes(token.slice(3)), "the page holds the token's body").toBe(false);
}

/**
 * Copies the token with the reveal's button: the button says "Copied" in
 * every browser; in Chromium the clipboard, granted, is read back and
 * compared as a boolean.
 */
async function copyToken(page: Page, browserName: string, token: string): Promise<void> {
  if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const button = revealDialog(page).getByRole("button", { name: "Copy token" });
  await button.click();
  // By its own text, not the button's: the button sits in the token's box, and a text matcher prints what it received.
  await expect(button.getByText("Copied", { exact: true })).toBeVisible();
  if (browserName === "chromium") {
    const held = await page.evaluate<string>("navigator.clipboard.readText()");
    expect(held === token, "the clipboard holds the token").toBe(true);
  }
  await expect(page.getByText("Failed to copy to clipboard")).toHaveCount(0);
}

/** An answer's text holds neither the token nor its prefix: checked before anything compares the answer. */
function expectNoTokenIn(answer: WhoAmIAnswer, tokens: string[]): void {
  for (const token of tokens) {
    expect(answer.text.includes(token.slice(3)), "the answer holds a token").toBe(false);
    expect(answer.text.includes(prefixOf(token)), "the answer holds a token's prefix").toBe(false);
  }
}

/** `/whoami` accepted `token`: 200, no-store, who it is. */
function expectWhoAmI(answer: WhoAmIAnswer, token: string, expected: { organizationId: string; tokenName: string; access: string }): void {
  expectNoTokenIn(answer, [token]);
  expect(answer.status).toBe(200);
  expect(answer.cacheControl).toBe("no-store");
  expect(answer.body).toEqual({ ...expected, kind: "service_account" });
}

/** `/whoami` refused `token` with the one 401. */
function expectRefused(answer: WhoAmIAnswer, token: string): void {
  expectNoTokenIn(answer, [token]);
  expect(answer.status).toBe(401);
  expect(answer.wwwAuthenticate).toBe("Bearer");
  expect(answer.body).toEqual({ error: { code: "invalid_api_token", message: INVALID_API_TOKEN_MESSAGE } });
}

/**
 * For each of `texts`: the text nodes holding it outside any `ph-mask`
 * element, and whether `<body>` is masked (the shell's portals: decision
 * 49). Evaluated as a string, as the E2E code has no DOM types.
 */
async function outsideMask(page: Page, texts: string[]): Promise<{ bodyMasked: boolean; outside: number[] }> {
  return page.evaluate(`(() => {
    const texts = ${JSON.stringify(texts)};
    const outside = texts.map((text) => {
      let count = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!node.textContent.includes(text)) continue;
        if (!node.parentElement || node.parentElement.closest(".ph-mask") === null) count += 1;
      }
      return count;
    });
    return { bodyMasked: document.body.classList.contains("ph-mask"), outside };
  })()`);
}

/** Each of `texts` is on the page, as text only, inside the masked shell: no attribute (nor the title) holds it. */
async function expectMaskedTextOnly(page: Page, texts: string[]): Promise<void> {
  const places = await placesOf(page, texts);
  for (const [index, place] of places.entries()) {
    expect(place.inside + place.outside, `${texts[index]} on the page`).toBeGreaterThan(0);
    expect(place.inAttributes, `${texts[index]} in an attribute`).toBe(0);
  }
  expect(await outsideMask(page, texts)).toEqual({ bodyMasked: true, outside: texts.map(() => 0) });
}

/** A new user signed in, admin of their personal organization. */
async function signedInAdmin(page: Page): Promise<SeededUser> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  return user;
}

test("the round trip: create an account, rename it, a write token shown once and copied, /whoami as it, a second token, the first revoked", async ({
  page,
  context,
  browserName,
  playwright,
}) => {
  const admin = await signedInAdmin(page);
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  const id = unique();
  const accountName = `Canary account ${id}`;
  const renamed = `Canary renamed ${id}`;
  const firstName = `Canary token ${id}`;
  const secondName = `Canary second ${id}`;

  await open(page, "/settings/service-accounts");
  await expect(navItem(page, "Service Accounts")).toBeVisible();
  await expect(page.getByText("No service accounts yet.")).toBeVisible();

  // Create: the name typed inside ph-no-capture, in no attribute.
  await page.getByRole("button", { name: "Create service account" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create service account" });
  const nameField = createDialog.getByLabel("Name");
  await expect(createDialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await nameField.fill(accountName);
  expect(await attributeHoldersOf(page, [accountName])).toEqual([[]]);
  await expect(createDialog.locator(".ph-no-capture").getByLabel("Name")).toHaveCount(1);
  const created = page.waitForResponse(isPostTo(CREATE_ACCOUNT_PATH));
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  const { serviceAccount } = (await createdResponse.json()) as ServiceAccountResponse;
  const address = serviceAccount.email;
  expect(address).toMatch(new RegExp(`^canary-account-${id}-[0-9a-f]{8}@service-accounts\\.telflo\\.invalid$`));
  await expect(createDialog).toBeHidden();
  await expect(page.getByText("Service account created", { exact: true })).toBeVisible();

  // The list: its name (a link by id), its creator, no tokens; masked text only.
  const row = accountRow(page, accountName);
  await expect(row).toContainText(admin.email);
  await expect(row.locator("td").nth(3)).toHaveText("0");
  await expect(page.getByRole("button", { name: `Delete service account ${accountName}` })).toBeVisible();
  await expectMaskedTextOnly(page, [accountName]);

  // The account's page, by id; the nav's item still current.
  await row.getByRole("link", { name: accountName }).click();
  await expect(page).toHaveURL(`/settings/service-accounts/${serviceAccount.id}`);
  await expect(page.getByText(address, { exact: true })).toBeVisible();
  await expect(navItem(page, "Service Accounts").locator("span.bg-brand")).toHaveCount(1);
  await expect(page.getByText("No tokens yet.")).toBeVisible();
  await expectMaskedTextOnly(page, [accountName, address]);

  // Rename: the field prefilled by its property, never an attribute.
  await page.getByRole("button", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename service account" });
  await expect(renameDialog.getByLabel("Name")).toHaveValue(accountName);
  expect(await attributeHoldersOf(page, [accountName])).toEqual([[]]);
  await renameDialog.getByLabel("Name").fill(renamed);
  expect(await attributeHoldersOf(page, [renamed])).toEqual([[]]);
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(renameDialog).toBeHidden();
  await expect(page.getByText("Service account renamed", { exact: true })).toBeVisible();
  await expect(page.getByText(renamed, { exact: true })).toBeVisible();
  // The address is kept.
  await expect(page.getByText(address, { exact: true })).toBeVisible();

  // A write token with an expiry: shown once, inside ph-no-capture, copied.
  const first = await createTokenOnPage(page, { name: firstName, write: true, expiresInDays: 30 });
  await expectBearersOnlyInNoCapture(page, [first]);
  await copyToken(page, browserName, first);
  await revealDialog(page).getByRole("button", { name: "Done" }).click();
  await expect(revealDialog(page)).toBeHidden();
  await expectTokenGone(page, first);

  // The list, read again once the reveal closed: the token by its prefix, write, an expiry date.
  const firstRow = tokenRow(page, firstName);
  await expect(firstRow).toBeVisible();
  const firstRowText = (await firstRow.textContent()) ?? "";
  expect(firstRowText.includes(`${prefixOf(first)}…`), "the row shows the token's prefix").toBe(true);
  expect(firstRowText.includes(first.slice(11)), "the row holds more than the prefix").toBe(false);
  // The row holds the prefix: its cells are matched by their own words, which prints none of it.
  await expect(firstRow.locator("td").nth(2).getByText("Read & Write", { exact: true })).toBeVisible();
  await expect(firstRow.locator("td").nth(3).getByText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
  await expect(firstRow.getByText("Expired")).toHaveCount(0);
  await expect(firstRow.locator("td").nth(4).getByText("Never", { exact: true })).toBeVisible();

  // /whoami with it, from a client holding no cookie.
  expectWhoAmI(await whoami(playwright, first), first, { organizationId: admin.organizationId, tokenName: firstName, access: "write" });

  // A second token (read, never expiring), then the first revoked.
  const second = await createTokenOnPage(page, { name: secondName, write: false });
  await expectBearersOnlyInNoCapture(page, [second]);
  await revealDialog(page).getByRole("button", { name: "Done" }).click();
  await expectTokenGone(page, second);
  const secondRow = tokenRow(page, secondName);
  await expect(secondRow.locator("td").nth(2).getByText("Read", { exact: true })).toBeVisible();
  await expect(secondRow.locator("td").nth(3).getByText("Never", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Revoke token ${firstName}` }).click();
  const revokeDialog = page.getByRole("alertdialog", { name: `Revoke token ${firstName}?` });
  await expect(revokeDialog).toContainText("Any client using it loses access immediately.");
  await revokeDialog.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(revokeDialog).toBeHidden();
  await expect(page.getByText("Token revoked", { exact: true })).toBeVisible();
  await expect(tokenRow(page, firstName)).toHaveCount(0);
  await expect(tokenRow(page, secondName)).toBeVisible();

  expectRefused(await whoami(playwright, first), first);
  expectWhoAmI(await whoami(playwright, second), second, {
    organizationId: admin.organizationId,
    tokenName: secondName,
    access: "read",
  });

  // Back on the list: the new name, one token.
  await page.getByRole("link", { name: "Service Accounts" }).click();
  await expect(page).toHaveURL("/settings/service-accounts");
  await expect(accountRow(page, renamed).locator("td").nth(3)).toHaveText("1");
  await expect(accountRow(page, accountName)).toHaveCount(0);

  // The tokens and their prefixes: in no URL, toast or storage (counts only, so nothing prints).
  const tokens = [first, second];
  const tokenTexts = tokens.flatMap((token) => [token.slice(3), prefixOf(token)]);
  expect(urlsHolding(urls, tokenTexts).length, "URLs holding a token or its prefix").toBe(0);
  expect(toastsHolding(toasts, tokenTexts).length, "toasts holding a token or its prefix").toBe(0);
  expect((await storageHolding(page, tokenTexts)).length, "storage holding a token or its prefix").toBe(0);
  await expectTokenGone(page, first);
  await expectTokenGone(page, second);
  // The names and the address: in no URL, toast or storage; the toasts are fixed words.
  const names = [accountName, renamed, address, address.split("@")[0]!, firstName, secondName];
  expect(urlsHolding(urls, names)).toEqual([]);
  expect(toastsHolding(toasts, names)).toEqual([]);
  expect(await storageHolding(page, names)).toEqual([]);
  expect(toasts).toEqual(["Service account created", "Service account renamed", "Token revoked"]);
  expect(await page.title()).toBe("Settings - Telflo");
});

test("the reveal closed by Escape, an outside click or its X: the token leaves the page, and the list is read again only once it has closed", async ({
  page,
  playwright,
}) => {
  const admin = await signedInAdmin(page);
  const account = await createServiceAccountThroughApi(page, admin.organizationId, `Closing ${unique()}`);
  await open(page, `/settings/service-accounts/${account.id}`);
  await expect(page.getByText("No tokens yet.")).toBeVisible();

  // The guard: from the create's click until the test closes the reveal, any
  // read of the token list fails the test, not a count taken at one moment.
  // It is recorded as a soft failure as it is routed (the request still goes
  // on, so the page behaves as it would), and the list of such reads, fixed
  // words only, is checked once the reveal has closed.
  let guarding: string | null = null;
  const readsWhileOpen: string[] = [];
  await page.route(
    (url) => TOKENS_PATH.test(url.pathname),
    async (route) => {
      if (route.request().method() === "GET" && guarding !== null) {
        readsWhileOpen.push(guarding);
        expect.soft(guarding, "the token list was read while the reveal was open").toBeNull();
      }
      await route.fallback();
    },
  );

  const closings: Array<[string, () => Promise<void>]> = [
    ["Escape", () => page.keyboard.press("Escape")],
    ["an outside click", () => page.mouse.click(5, 5)],
    ["the X", () => revealDialog(page).getByRole("button", { name: "Close" }).click()],
  ];
  for (const [way, close] of closings) {
    const name = `Closed by ${way} ${unique()}`;
    // Armed before the create: a read the create's answer set off counts.
    guarding = way;
    const token = await createTokenOnPage(page, { name, write: false });
    await expectBearersOnlyInNoCapture(page, [token]);
    await expect(tokenRow(page, name)).toHaveCount(0);
    const reread = page.waitForResponse((response) => response.request().method() === "GET" && TOKENS_PATH.test(new URL(response.url()).pathname));
    guarding = null;
    await close();
    await expect(revealDialog(page), way).toBeHidden();
    expect(readsWhileOpen, "token-list reads while the reveal was open").toEqual([]);
    expect((await reread).status()).toBe(200);
    await expect(tokenRow(page, name)).toBeVisible();
    await expectTokenGone(page, token);
    expectWhoAmI(await whoami(playwright, token), token, { organizationId: admin.organizationId, tokenName: name, access: "read" });
  }
});

test("a token expired in the database shows Expired and answers 401", async ({ page, playwright }) => {
  const admin = await signedInAdmin(page);
  const account = await createServiceAccountThroughApi(page, admin.organizationId, `Expiring ${unique()}`);
  const name = `Expiring token ${unique()}`;
  const { tokenId, token } = await createApiTokenThroughApi(page, admin.organizationId, account.id, {
    name,
    access: "read",
    expiresInDays: 1,
  });
  expectWhoAmI(await whoami(playwright, token), token, { organizationId: admin.organizationId, tokenName: name, access: "read" });

  await expireApiToken({ organizationId: admin.organizationId, tokenId });

  await open(page, `/settings/service-accounts/${account.id}`);
  const row = tokenRow(page, name);
  await expect(row.getByText("Expired", { exact: true })).toBeVisible();
  // Expired but not revoked: still listed and counted.
  await expect(page.locator("dd").filter({ hasText: /^1$/ })).toHaveCount(1);
  expectRefused(await whoami(playwright, token), token);
  await expectTokenGone(page, token);
});

test("typing the name deletes the account: its token answers 401, and its configuration still shows its address", async ({
  page,
  playwright,
}) => {
  const admin = await signedInAdmin(page);
  const toasts = await recordToasts(page);
  const name = `Canary deleted ${unique()}`;
  const account = await createServiceAccountThroughApi(page, admin.organizationId, name);
  const { token } = await createApiTokenThroughApi(page, admin.organizationId, account.id, {
    name: `Deleted token ${unique()}`,
    access: "write",
    expiresInDays: null,
  });
  // Published: an admin sees no other member's draft.
  const configurationName = `Made by the account ${unique()}`;
  await seedConfiguration({ organizationId: admin.organizationId, createdByUserId: account.id, name: configurationName, published: true });

  await open(page, "/settings/service-accounts");
  await expect(accountRow(page, name).locator("td").nth(3)).toHaveText("1");
  await page.getByRole("button", { name: `Delete service account ${name}` }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete service account: ${name}` });
  await expect(dialog).toContainText("Its token will stop working immediately, and it will be removed from this organization.");
  await expect(dialog).toContainText(KEPT_WORDS);
  const confirm = dialog.getByLabel(CONFIRM_LABEL);
  const deleteButton = dialog.getByRole("button", { name: "Permanently delete" });
  await expect(deleteButton).toBeDisabled();
  await confirm.fill(`${name} not quite`);
  await expect(deleteButton).toBeDisabled();
  await confirm.fill(name);
  await expect(deleteButton).toBeEnabled();
  // The typed name: inside ph-no-capture, in no attribute.
  await expect(dialog.locator(".ph-no-capture").getByLabel(CONFIRM_LABEL)).toHaveCount(1);
  expect(await attributeHoldersOf(page, [name])).toEqual([[]]);
  await deleteButton.click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Service account deleted", { exact: true })).toBeVisible();
  await expect(page.getByText("No service accounts yet.")).toBeVisible();
  expectRefused(await whoami(playwright, token), token);

  // Its page is gone; its work is kept, with its address as the creator.
  await open(page, `/settings/service-accounts/${account.id}`);
  await expect(page.getByText("Service account not found.")).toBeVisible();
  await open(page, "/app");
  const card = page.getByRole("button").filter({ has: page.getByRole("heading", { name: configurationName, exact: true }) });
  await expect(card).toContainText(account.email);
  expect(toastsHolding(toasts, [name, account.email])).toEqual([]);
});

test("Permissions lists no service account, live or deleted, and its counts leave them out", async ({ page }) => {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  const removed = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: member.userId, organizationId: group.organizationId, role: "contributor" });
  await addMember({ userId: removed.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);
  // A person removed, so the Deleted table has a row to show beside the accounts' absence.
  const removal = await page.request.delete(`/api/v1/organizations/${group.organizationId}/members/${removed.userId}`, {
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(removal.status()).toBe(204);
  const live = await createServiceAccountThroughApi(page, group.organizationId, `Live ${unique()}`);
  const deleted = await createServiceAccountThroughApi(page, group.organizationId, `Gone ${unique()}`);
  await deleteServiceAccountThroughApi(page, group.organizationId, deleted.id);

  await open(page, "/org-admin/active-members");
  await expect(memberRow(page, admin.email)).toBeVisible();
  await expect(memberRow(page, member.email)).toBeVisible();
  await expect(memberRow(page, live.email)).toHaveCount(0);
  await expect(memberRow(page, deleted.email)).toHaveCount(0);
  const count = (label: string) =>
    page.getByRole("button", { name: new RegExp(`^${label}`) }).locator("span", { hasText: /^\d+$/ });
  await expect(count("Active")).toHaveText("2");
  await expect(count("Deleted")).toHaveText("1");
  await expect(count("Invited")).toHaveText("0");

  await page.getByRole("button", { name: /^Deleted/ }).click();
  await expect(page).toHaveURL("/org-admin/deleted-members");
  // The table has rendered: the removed person's row is there.
  await expect(memberRow(page, removed.email)).toBeVisible();
  await expect(memberRow(page, live.email)).toHaveCount(0);
  await expect(memberRow(page, deleted.email)).toHaveCount(0);
  await expect(page.getByText(live.email)).toHaveCount(0);
  await expect(page.getByText(deleted.email)).toHaveCount(0);
});

test("a contributor sees no Service Accounts item, and both pages send them to Settings without asking the API", async ({
  page,
  secondContext,
}) => {
  const admin = await seedUser({ password: PASSWORD });
  const member = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId, role: "admin" });
  await addMember({ userId: member.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, admin);
  await switchOrganizationThroughApi(page, group.organizationId);
  const account = await createServiceAccountThroughApi(page, group.organizationId, `Hidden ${unique()}`);

  // The admin of the group sees the item.
  await open(page, "/settings/appearance");
  await expect(navItem(page, "Service Accounts")).toBeVisible();

  const memberPage = await secondContext.newPage();
  const urls = recordRequestUrls(secondContext);
  await signInThroughApi(memberPage, member);
  await switchOrganizationThroughApi(memberPage, group.organizationId);
  await open(memberPage, "/settings/appearance");
  await expect(navItem(memberPage, "Organization")).toBeVisible();
  await expect(navItem(memberPage, "Service Accounts")).toHaveCount(0);

  for (const path of ["/settings/service-accounts", `/settings/service-accounts/${account.id}`]) {
    await memberPage.goto(path);
    await expect(memberPage, path).toHaveURL("/settings/appearance");
    await expect(memberPage.getByText(account.name)).toHaveCount(0);
  }
  expect(urls.filter((url) => new URL(url).pathname.startsWith("/api/") && url.includes("/service-accounts"))).toEqual([]);
});
