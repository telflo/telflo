import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { API_TOKEN_PATTERN, INVALID_API_TOKEN_MESSAGE, type CreatedApiTokenResponse } from "@telflo/contracts";
import { seedUser } from "./support/database.js";
import { attributeHoldersOf, recordRequestUrls, recordToasts, storageHolding, toastsHolding, urlsHolding } from "./support/privacy.js";
import { createPersonalApiTokenThroughApi, PERSONAL_API_TOKENS_API_PATH, whoami, type WhoAmIAnswer } from "./support/service-accounts.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// Settings › Account's "API tokens": a person's own `tf_` token made on the
// page, shown once and copied by its button, used as a CLI uses it (a
// cookieless request context at the E2E API, with X-Telflo-Org), then revoked
// on the page.
//
// A token is a secret: built by the API at run time and read from the
// create's reply, never written here and never printed. No page that holds or
// shows a token is open when an assertion can fail (Playwright writes the
// page's ARIA snapshot to error-context.md): while the reveal is open the
// test only COLLECTS booleans, closes it, goes to about:blank, and asserts
// there. A token's name is the person's content: visible text in the masked
// shell only.
//
// Recorded residue: a failed run's trace holds the reply, and the source of
// the page.evaluate that counts where the token sits, which names it. Both
// are e2e-only tokens.

const PASSWORD = "correct horse battery staple";
const REVEAL_WORDS = "This is the only time you'll see it. If you lose it, revoke this token and create a new one.";

/** The token row named `name`: the Account page's one table is the API tokens card's. */
function tokenRow(page: Page, name: string): Locator {
  return page.locator("tbody tr").filter({ has: page.getByText(name, { exact: true }) });
}

function isTokenCreate(response: Response): boolean {
  return response.request().method() === "POST" && new URL(response.url()).pathname === PERSONAL_API_TOKENS_API_PATH;
}

/** An answer's text holds neither the token's body nor its prefix: checked before anything compares the answer. */
function expectNoTokenIn(answer: WhoAmIAnswer, token: string): void {
  expect(answer.text.includes(token.slice(3)), "the answer holds the token").toBe(false);
  expect(answer.text.includes(token.slice(0, 11)), "the answer holds the token's prefix").toBe(false);
}

async function openAccount(page: Page): Promise<void> {
  await page.goto("/settings/account");
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name: "API tokens", exact: true })).toBeVisible();
}

test("a personal token: created and shown once, copied by its button, /whoami as the person with X-Telflo-Org, then revoked on the page", async ({
  page,
  context,
  browserName,
  playwright,
}) => {
  const person = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, person);
  const urls = recordRequestUrls(context);
  const toasts = await recordToasts(page);
  const name = `Canary personal ${randomUUID().slice(0, 8)}`;

  await openAccount(page);
  await expect(page.getByText("No tokens yet.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "A personal token acts as you, with your role, in every organization you belong to: send the organization's id in the X-Telflo-Org header (GET /api/public/v1/orgs lists your organizations and their ids). Organization admins can't see or revoke it.",
      { exact: true },
    ),
  ).toBeVisible();

  // The create: the name typed inside ph-no-capture, in no attribute.
  await page.getByRole("button", { name: "Create token" }).click();
  const dialog = page.getByRole("dialog", { name: "Create API token" });
  await dialog.getByLabel("Name").fill(name);
  expect(await attributeHoldersOf(page, [name])).toEqual([[]]);
  await expect(dialog.locator(".ph-no-capture").getByLabel("Name")).toHaveCount(1);
  await dialog.getByRole("checkbox", { name: "Allow write access" }).check();
  await dialog.getByLabel("Current password").fill(PASSWORD);
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const answered = page.waitForResponse(isTokenCreate);
  await dialog.getByRole("button", { name: "Create token" }).click();
  const response = await answered;

  // --- The reveal is open: collect booleans only, nothing that can fail here. ---
  const status = response.status();
  const cacheControl = response.headers()["cache-control"];
  const { token } = (await response.json()) as CreatedApiTokenResponse;
  const reveal = page.getByRole("dialog", { name: "Copy your token" });
  await reveal.getByText(REVEAL_WORDS, { exact: true }).waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  const placed = await page
    .evaluate<{ inside: number; outside: number; splitOutside: boolean; inAttributes: number; inTitle: boolean }>(`(() => {
    const token = ${JSON.stringify(token)};
    const outsideBody = document.body.cloneNode(true);
    for (const each of outsideBody.querySelectorAll(".ph-no-capture")) each.remove();
    let inside = 0;
    let outside = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!node.textContent.includes(token)) continue;
      if (node.parentElement && node.parentElement.closest(".ph-no-capture")) inside += 1;
      else outside += 1;
    }
    let inAttributes = 0;
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) if (attribute.value.includes(token)) inAttributes += 1;
    }
    return { inside, outside, splitOutside: outsideBody.textContent.includes(token), inAttributes, inTitle: document.title.includes(token) };
  })()`)
    .catch(() => null);
  const copyButton = reveal.getByRole("button", { name: "Copy token" });
  await copyButton.click().catch(() => undefined);
  const copied = await copyButton
    .getByText("Copied", { exact: true })
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true, () => false);
  const clipboard = browserName === "chromium" ? await page.evaluate<string>("navigator.clipboard.readText()").catch(() => "") : token;
  const clipboardHoldsToken = clipboard === token;
  await reveal.getByRole("button", { name: "Done" }).click().catch(() => undefined);
  const revealClosed = await reveal.waitFor({ state: "hidden", timeout: 5_000 }).then(() => true, () => false);
  // A failed read (a closed page) is "not gone": the assertion below fails after about:blank.
  const pageAfterDone = await page.content().catch(() => null);
  const goneAfterDone = pageAfterDone !== null && !pageAfterDone.includes(token) && !pageAfterDone.includes(token.slice(3));
  await page.goto("about:blank");
  // --- No page holds the token now: assert what was collected. ---
  expect(status).toBe(201);
  expect(cacheControl).toBe("no-store");
  expect(API_TOKEN_PATTERN.test(token), "the reply carries a tf_ token").toBe(true);
  expect(placed).toEqual({ inside: 1, outside: 0, splitOutside: false, inAttributes: 0, inTitle: false });
  expect(copied, "the copy button said Copied").toBe(true);
  expect(clipboardHoldsToken, "the clipboard holds the token").toBe(true);
  expect(revealClosed, "Done closed the reveal").toBe(true);
  expect(goneAfterDone, "the token gone from the page after Done").toBe(true);

  // The copied token, as a CLI sends it: no organization → null; the person's own → its id; another → the one 403.
  const bare = await whoami(playwright, clipboardHoldsToken ? clipboard : token);
  expectNoTokenIn(bare, token);
  expect(bare.status).toBe(200);
  expect(bare.cacheControl).toBe("no-store");
  expect(bare.body).toEqual({ organizationId: null, tokenName: name, access: "write", kind: "person" });
  const inOrganization = await whoami(playwright, token, { organizationId: person.organizationId });
  expectNoTokenIn(inOrganization, token);
  expect(inOrganization.body).toEqual({ organizationId: person.organizationId, tokenName: name, access: "write", kind: "person" });
  const elsewhere = await whoami(playwright, token, { organizationId: randomUUID() });
  expectNoTokenIn(elsewhere, token);
  expect(elsewhere.status).toBe(403);
  expect((elsewhere.body as { error: { code: string } }).error.code).toBe("organization_access_denied");

  // The list, read again: the row by its name and prefix (masked text), write; nothing but the prefix of the token.
  await openAccount(page);
  const row = tokenRow(page, name);
  await expect(row).toBeVisible();
  const rowText = (await row.textContent()) ?? "";
  expect(rowText.includes(`${token.slice(0, 11)}…`), "the row shows the token's prefix").toBe(true);
  expect(rowText.includes(token.slice(11)), "the row holds more than the prefix").toBe(false);
  await expect(row.locator("td").nth(2).getByText("Read & Write", { exact: true })).toBeVisible();
  expect(await attributeHoldersOf(page, [name])).toEqual([[]]);

  // Revoke, with the confirmation; the token stops working on the next request.
  await page.getByRole("button", { name: `Revoke token ${name}` }).click();
  const confirm = page.getByRole("alertdialog", { name: `Revoke token ${name}?` });
  await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText("Token revoked", { exact: true })).toBeVisible();
  await expect(page.getByText("No tokens yet.", { exact: true })).toBeVisible();
  const refused = await whoami(playwright, token, { organizationId: person.organizationId });
  expectNoTokenIn(refused, token);
  expect(refused.status).toBe(401);
  expect(refused.body).toEqual({ error: { code: "invalid_api_token", message: INVALID_API_TOKEN_MESSAGE } });

  // The name and the token nowhere else: no toast, no URL, no browser storage.
  expect(toastsHolding(toasts, [name, token.slice(3), token.slice(0, 11)])).toEqual([]);
  expect(urlsHolding(urls, [name, token.slice(3)])).toEqual([]);
  expect(await storageHolding(page, [name, token.slice(3)])).toEqual([]);
});

test("a token made elsewhere is listed by its prefix, and its X-Telflo-Org is checked on /whoami: a malformed one is 400", async ({ page, playwright }) => {
  const person = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, person);
  const name = `Canary listed ${randomUUID().slice(0, 8)}`;
  const { token } = await createPersonalApiTokenThroughApi(page, { name, access: "read", expiresInDays: 30, currentPassword: PASSWORD });

  const malformed = await whoami(playwright, token, { organizationId: "not-an-organization" });
  expectNoTokenIn(malformed, token);
  expect(malformed.status).toBe(400);
  expect((malformed.body as { error: { code: string } }).error.code).toBe("organization_required");

  await openAccount(page);
  const row = tokenRow(page, name);
  await expect(row.locator("td").nth(2).getByText("Read", { exact: true })).toBeVisible();
  await expect(row.locator("td").nth(3).getByText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
  const rowText = (await row.textContent()) ?? "";
  expect(rowText.includes(token.slice(11)), "the row holds more than the prefix").toBe(false);
});
