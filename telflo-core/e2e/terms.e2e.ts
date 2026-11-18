import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { expect, type Page } from "@playwright/test";
// The SaaS pair (D36-1 Preflight ruling 16): open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { E2E_SAAS_WEB_URL } from "./support/environment.js";
import { findIdentities, findUsersByEmail, seedUser, uniqueEmail } from "./support/database.js";
import { clickGoogle, signInAtProvider } from "./support/oidc.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// The terms dialog in the signed-in layout (D2c decision 6): shown whenever
// the user's accepted terms version isn't the current one.

const PASSWORD = "correct horse battery staple";

function termsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Updated Terms of Service" });
}

test("a user whose accepted terms version is old sees the dialog on /app", async ({ page }) => {
  const user = await seedUser({ password: PASSWORD, termsVersion: "2025-01-01" });
  await signInThroughApi(page, user);

  await page.goto("/app");
  await waitForHydration(page);

  await expect(termsDialog(page)).toBeVisible();
});

test("a Google sign-in that takes over an unverified password account lands behind the dialog, and the old password fails (Ruling 14)", async ({
  page,
  playwright,
}) => {
  // Accepted the current terms, but never confirmed the address: whoever
  // registered it may not own it, so their acceptance doesn't carry over.
  const seeded = await seedUser({ password: PASSWORD, email: uniqueEmail("gmail.com"), verified: false });
  await page.goto("/login");
  await waitForHydration(page);

  await clickGoogle(page);
  await signInAtProvider(page, { email: seeded.email });

  await page.waitForURL("/app");
  await waitForHydration(page);
  await expect(termsDialog(page)).toBeVisible();

  const users = await findUsersByEmail(seeded.email);
  expect(users.map((user) => user.id)).toEqual([seeded.userId]);
  expect(users[0]?.password_hash).toBeNull();
  expect(users[0]?.accepted_terms_version).toBeNull();
  expect(await findIdentities(seeded.userId)).toHaveLength(1);

  // A fresh cookie jar, so the Google session doesn't stand in for the answer.
  const request = await playwright.request.newContext({ baseURL: E2E_SAAS_WEB_URL });
  try {
    const response = await request.post("/api/v1/auth/sessions", {
      data: { email: seeded.email, password: PASSWORD },
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_credentials" } });
  } finally {
    await request.dispose();
  }
});

test("from the terms dialog, the site's Terms of Service URL opens in a new tab, and the dialog stays, unticked (Ruling 20; D36-1 decision 32)", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD, termsVersion: "2025-01-01" });
  await signInThroughApi(page, user);
  await page.goto("/app");
  await waitForHydration(page);
  const dialog = termsDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/home/privacy-policy");

  const [terms] = await Promise.all([
    context.waitForEvent("page"),
    dialog.getByRole("link", { name: "Terms of Service" }).click(),
  ]);
  await terms.waitForLoadState();

  // TELFLO_TERMS_URL: telflo-site's page, which nothing serves in the browser tests (the web app answers its 404).
  expect(new URL(terms.url()).pathname).toBe("/home/terms-of-service");
  await terms.close();

  // The first tab hasn't moved: the dialog is there, its box unticked.
  expect(new URL(page.url()).pathname).toBe("/app");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("I agree to the Terms of Service and Privacy Policy")).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Accept" })).toBeDisabled();
});
