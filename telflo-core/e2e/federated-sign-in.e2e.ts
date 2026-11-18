import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { E2E_SAAS_TERMS_VERSION } from "./support/environment.js";
// The SaaS pair (D36-1 Preflight ruling 16): open registration, the Terms, the playground and the anonymous reads.
import { test } from "./support/saas.js";
import { findIdentities, findMemberships, findUsersByEmail, seedUser, uniqueEmail } from "./support/database.js";
import { clickGoogle, denyAtProvider, signInAtProvider } from "./support/oidc.js";
import { waitForHydration } from "./support/session.js";

// Signing in and creating accounts with Google (D2c), against the fake
// OpenID Provider the E2E API's Google settings name (start-fake-oidc-provider.ts).
// Each test types its own email into the fake's form.

const PASSWORD = "correct horse battery staple";
const OAUTH_FAILED = "Social login failed. Please try again or use email/password.";
const OAUTH_EMAIL_UNVERIFIED =
  "This Google account can't be used to sign in. Sign up with your email address instead.";

function termsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Updated Terms of Service" });
}

/** Opens a page and waits for React, as every full page load must (D2b Ruling 11). */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

test("a new user from /register lands on /app behind the terms dialog; Accept makes the shell usable, and a reload shows no dialog", async ({
  page,
}) => {
  const email = uniqueEmail("gmail.com");
  await open(page, "/register");

  // The register form's own terms checkbox is left alone: the dialog asks.
  await clickGoogle(page);
  await signInAtProvider(page, { email });

  await page.waitForURL("/app");
  await waitForHydration(page);
  const dialog = termsDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("I agree to the Terms of Service and Privacy Policy").check();
  await dialog.getByRole("button", { name: "Accept" }).click();
  await expect(dialog).toBeHidden();

  // The shell answers: its organization popover opens.
  // The personal organization, named by the email alone (Q263).
  await expect(page.getByTitle("Switch organization")).toContainText(email);
  await expect(page.getByTitle("Switch organization")).not.toContainText("workspace");
  await page.getByTitle("Switch organization").click();
  await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();

  await page.reload();
  await waitForHydration(page);
  await expect(page.getByTitle("Switch organization")).toBeVisible();
  await expect(termsDialog(page)).toHaveCount(0);

  const users = await findUsersByEmail(email);
  expect(users).toHaveLength(1);
  const [user] = users;
  expect(user?.password_hash).toBeNull();
  expect(user?.email_verified_at).not.toBeNull();
  expect(user?.accepted_terms_version).toBe(E2E_SAAS_TERMS_VERSION);
  const identities = await findIdentities(user?.id ?? "");
  expect(identities).toHaveLength(1);
  expect(identities[0]).toMatchObject({ provider: "google", email });
  expect(await findMemberships(user?.id ?? "")).toHaveLength(1);
});

test("a new user who cancels the terms dialog lands on /login signed out, and signing in with Google again shows the dialog again", async ({
  page,
}) => {
  const identity = { email: uniqueEmail("gmail.com"), sub: randomUUID() };
  await open(page, "/register");
  await clickGoogle(page);
  await signInAtProvider(page, identity);
  await page.waitForURL("/app");
  await waitForHydration(page);

  await termsDialog(page).getByRole("button", { name: "Cancel" }).click();

  await expect(page).toHaveURL("/login");
  await expect(page.getByText("Logged out successfully")).toBeVisible();
  expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);

  await clickGoogle(page);
  await signInAtProvider(page, identity);
  await page.waitForURL("/app");
  await waitForHydration(page);
  await expect(termsDialog(page)).toBeVisible();
  // Still the one account.
  expect(await findUsersByEmail(identity.email)).toHaveLength(1);
});

test("an existing verified password user who signs in with Google on /login lands on /app as the same user, with no dialog", async ({
  page,
}) => {
  const seeded = await seedUser({ password: PASSWORD, email: uniqueEmail("gmail.com") });
  await open(page, "/login");

  await clickGoogle(page);
  await signInAtProvider(page, { email: seeded.email });

  await page.waitForURL("/app");
  await waitForHydration(page);
  await expect(page.getByTitle("Switch organization")).toContainText(seeded.organizationName);
  await expect(termsDialog(page)).toHaveCount(0);

  const users = await findUsersByEmail(seeded.email);
  expect(users.map((user) => user.id)).toEqual([seeded.userId]);
  // Linked, not taken over: the password still stands.
  expect(users[0]?.password_hash).not.toBeNull();
  const identities = await findIdentities(seeded.userId);
  expect(identities).toHaveLength(1);
  expect(identities[0]).toMatchObject({ provider: "google", email: seeded.email });
});

for (const redirectTo of ["/app", "/app?from=google"]) {
  test(`/login?redirectTo=${encodeURIComponent(redirectTo)}, through Google, lands on ${redirectTo}`, async ({ page }) => {
    const seeded = await seedUser({ password: PASSWORD, email: uniqueEmail("gmail.com") });
    await open(page, `/login?redirectTo=${encodeURIComponent(redirectTo)}`);

    await clickGoogle(page);
    await signInAtProvider(page, { email: seeded.email });

    await page.waitForURL(redirectTo);
    await waitForHydration(page);
    await expect(page.getByTitle("Switch organization")).toContainText(seeded.organizationName);
  });
}

test("Deny at the provider lands on /login with the social-login message, redirectTo kept", async ({ page }) => {
  await open(page, "/login?redirectTo=%2Fapp");

  await clickGoogle(page);
  await denyAtProvider(page);

  await page.waitForURL((url) => url.pathname === "/login" && url.searchParams.get("error") === "oauth_failed");
  expect(new URL(page.url()).searchParams.get("redirectTo")).toBe("/app");
  expect(page.url()).toContain("redirectTo=%2Fapp");
  await waitForHydration(page);
  await expect(page.getByRole("alert")).toHaveText(OAUTH_FAILED);
  // The Google button still carries redirectTo for another try.
  await expect(page.getByRole("link", { name: "Google" })).toHaveAttribute(
    "href",
    "/api/v1/auth/oidc/google?redirectTo=%2Fapp",
  );
});

test("an unverified provider email gets the can't-be-used message, and no user is created", async ({ page }) => {
  const email = uniqueEmail("gmail.com");
  await open(page, "/register");

  await clickGoogle(page);
  await signInAtProvider(page, { email, emailVerified: false });

  await page.waitForURL((url) => url.pathname === "/login" && url.searchParams.get("error") === "oauth_email_unverified");
  await waitForHydration(page);
  await expect(page.getByRole("alert")).toHaveText(OAUTH_EMAIL_UNVERIFIED);
  expect(await findUsersByEmail(email)).toEqual([]);
});

test("a non-Gmail provider email with no hosted domain gets the same message, and no user is created (Ruling 7)", async ({
  page,
}) => {
  const email = uniqueEmail("example.com");
  await open(page, "/login");

  await clickGoogle(page);
  await signInAtProvider(page, { email });

  await page.waitForURL((url) => url.pathname === "/login" && url.searchParams.get("error") === "oauth_email_unverified");
  await waitForHydration(page);
  await expect(page.getByRole("alert")).toHaveText(OAUTH_EMAIL_UNVERIFIED);
  expect(await findUsersByEmail(email)).toEqual([]);
});

for (const path of ["/login", "/register"]) {
  test(`Back from the provider leaves ${path} usable, not Redirecting... (Ruling 16)`, async ({ page }) => {
    await open(page, path);

    await clickGoogle(page);
    await page.goBack();

    // Restored from the back/forward cache or loaded afresh, either way the
    // form must be usable.
    await expect(page).toHaveURL(path);
    await waitForHydration(page);
    const google = page.getByRole("link", { name: "Google" });
    await expect(google).toBeVisible();
    await expect(google).not.toHaveAttribute("aria-disabled");
    await expect(page.getByRole("link", { name: "Redirecting..." })).toHaveCount(0);
    await expect(page.getByLabel("Email", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();

    // And the button works again.
    await clickGoogle(page);
  });
}

// The browsers here never restore these pages from the back/forward cache
// (the dev server's HMR WebSocket makes them ineligible), so the test above
// passes with or without the fix. This one proves the fix in each browser:
// the start endpoint answers 204, so the click leaves the page where it is,
// "Redirecting...", and a persisted pageshow is what a restore fires.
for (const path of ["/login", "/register"]) {
  test(`${path} restored from the back/forward cache (a persisted pageshow) is usable again (Ruling 16)`, async ({
    page,
  }) => {
    await page.route("**/api/v1/auth/oidc/google*", (route) => route.fulfill({ status: 204 }));
    await open(page, path);

    await page.getByRole("link", { name: "Google" }).click();
    await expect(page.getByRole("link", { name: "Redirecting..." })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();

    // A string, evaluated in the page: the E2E code is typechecked without DOM types.
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))`);

    const google = page.getByRole("link", { name: "Google" });
    await expect(google).toBeVisible();
    await expect(google).not.toHaveAttribute("aria-disabled");
    await expect(page.getByLabel("Email", { exact: true })).toBeEnabled();
  });
}
