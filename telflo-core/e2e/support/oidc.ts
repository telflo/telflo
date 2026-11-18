import { expect, type Locator, type Page } from "@playwright/test";
import { E2E_OIDC_ISSUER } from "./environment.js";

// Driving the fake OpenID Provider's sign-in form (start-fake-oidc-provider.ts),
// which stands behind the Google button in the browser tests. Each test types
// its own email, so parallel tests never share an identity (D2c Ruling 4).

export interface ProviderIdentity {
  email: string;
  /**
   * The provider's subject. Default: the form's random one. A test that
   * signs the same person in twice passes one, as Google keeps a person's.
   */
  sub?: string;
  /** Default true: the checkbox is left ticked. */
  emailVerified?: boolean;
  /** The Google Workspace domain. Default: none. */
  hd?: string;
}

/** Clicks the page's Google button and waits for the fake provider's form. */
export async function clickGoogle(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Google" }).click();
  await waitForProviderForm(page);
}

/**
 * Starts linking Google from Settings › Account (D21 decision 38): "Link
 * Google", the password prompt when the account has a password (its
 * current password, then "Continue"), and the fake provider's form, where
 * the browser lands from the link start's authorization URL. The test then
 * signs in at the provider (`signInAtProvider`) and comes back to
 * `/settings/account`. `beforeContinue` runs once the password is typed,
 * before "Continue" (a check of the typed field).
 */
export async function startLinkingGoogle(
  page: Page,
  currentPassword?: string,
  beforeContinue?: (field: Locator) => Promise<void>,
): Promise<void> {
  await page.getByRole("button", { name: "Link Google", exact: true }).click();
  if (currentPassword !== undefined) {
    const dialog = page.getByRole("dialog", { name: "Link Google", exact: true });
    const field = dialog.getByLabel("Current Password");
    await field.fill(currentPassword);
    if (beforeContinue !== undefined) await beforeContinue(field);
    await dialog.getByRole("button", { name: "Continue" }).click();
  }
  await waitForProviderForm(page);
}

/** Waits for the browser to reach the fake provider's sign-in form. */
async function waitForProviderForm(page: Page): Promise<void> {
  await page.waitForURL(`${E2E_OIDC_ISSUER}/authorize?**`);
  await expect(page.getByRole("heading", { name: "Fake OIDC provider" })).toBeVisible();
}

/** Fills in the fake provider's form as `identity` and signs in. */
export async function signInAtProvider(
  page: Page,
  { email, sub, emailVerified = true, hd }: ProviderIdentity,
): Promise<void> {
  await page.getByLabel("Email", { exact: true }).fill(email);
  if (sub !== undefined) await page.getByLabel("Subject").fill(sub);
  await page.getByLabel("Email verified").setChecked(emailVerified);
  if (hd !== undefined) await page.getByLabel("Hosted domain").fill(hd);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Refuses at the fake provider, as a person who cancels at Google does. */
export async function denyAtProvider(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Deny" }).click();
}
