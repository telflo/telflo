import { expect, test } from "@playwright/test";
import { seedUser } from "./support/database.js";
import { linkFrom, waitForEmail } from "./support/mail.js";
import { signInThroughForm, waitForHydration } from "./support/session.js";

// Resending the confirmation email from the sign-in form (D3; deferred by
// D2a).

const PASSWORD = "correct horse battery staple";
const CONFIRMATION_SUBJECT = "Confirm your Telflo email address";

test("an unconfirmed user resends the confirmation email from sign-in, confirms from its link, and signs in", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD, verified: false });

  await page.goto("/login");
  await waitForHydration(page);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page.getByText("Email not confirmed")).toBeVisible();
  await expect(page.getByText("Didn't receive the confirmation email?")).toBeVisible();
  await page.getByRole("button", { name: "Resend" }).click();
  await expect(page.getByText("Confirmation email sent — check your inbox.")).toBeVisible();

  const link = linkFrom(await waitForEmail({ to: user.email, subject: CONFIRMATION_SUBJECT }), "/verify-email");
  await page.goto(link);
  await waitForHydration(page);
  await expect(page.getByText("Your email address is confirmed")).toBeVisible();

  await signInThroughForm(page, user);
  await expect(page).toHaveURL("/app");
});
