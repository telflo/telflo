import { expect, test, type Page } from "@playwright/test";
import { seedUser, type SeededUser } from "./support/database.js";
import { linkFrom, waitForEmail } from "./support/mail.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";

// Password reset (D3): "Forgot password?" emails a single-use link; setting a
// new password from it revokes every session (decision 5) and sends the user
// to sign in; a used link is refused with a way to request another.

const OLD_PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new and long enough password";
const RESET_SUBJECT = "Reset your Telflo password";

/** From `/login`, through "Forgot password?", to the emailed reset link. */
async function requestResetLink(page: Page, user: SeededUser): Promise<string> {
  await page.goto("/login");
  await waitForHydration(page);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL("/forgot-password");

  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Send Reset Link" }).click();
  await expect(
    page.getByText("If an account exists with this email, you will receive a password reset link shortly."),
  ).toBeVisible();

  const link = linkFrom(await waitForEmail({ to: user.email, subject: RESET_SUBJECT }), "/reset-password");
  // The token is in the fragment, which the browser never sends (Ruling 14).
  expect(new URL(link).search).toBe("");
  expect(new URL(link).hash).toMatch(/^#token=[A-Za-z0-9_-]+$/);
  return link;
}

/** The token in a reset link's `#token=…` fragment. */
function tokenOf(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  if (!token) throw new Error(`no token in ${link}`);
  return token;
}

/** Opens the link and submits a new password; stays on the reset page. */
async function submitNewPassword(page: Page, link: string, password: string): Promise<void> {
  await page.goto(link);
  await waitForHydration(page);
  // The show/hide toggles are also labelled "…password", so match exactly.
  await page.getByLabel("New Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Update Password" }).click();
}

/** Fills and submits the sign-in form on the `/login` page already open. */
async function submitSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
}

test("a reset from the emailed link sets the new password, refuses the old one, and signs out the other browser", async ({
  page,
  browser,
}) => {
  const user = await seedUser({ password: OLD_PASSWORD });

  // Signed in elsewhere, with the shell open.
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await signInThroughApi(otherPage, user);
  await otherPage.goto("/app");
  await waitForHydration(otherPage);
  await expect(otherPage).toHaveURL("/app");

  const link = await requestResetLink(page, user);
  await submitNewPassword(page, link, NEW_PASSWORD);
  await expect(page.getByText("Password updated successfully! Redirecting...")).toBeVisible();
  await expect(page).toHaveURL("/login");

  // The old password first: a signed-in visitor to /login goes to /app, so
  // it can't be tried after the new one (Preflight ruling 6).
  await submitSignIn(page, user.email, OLD_PASSWORD);
  await expect(page.getByText("Invalid login credentials")).toBeVisible();
  await submitSignIn(page, user.email, NEW_PASSWORD);
  await page.waitForURL("/app");

  // The other browser's session was revoked, and every request checks the
  // session row (D2a decision 4), so its still-valid access token is refused
  // at once: the reload lands on sign-in.
  await otherPage.reload();
  await expect(otherPage).toHaveURL("/login?redirectTo=%2Fapp");

  await otherContext.close();
});

test("a used reset link is refused on submit, with a link to request a new one", async ({ page }) => {
  const user = await seedUser({ password: OLD_PASSWORD });
  const link = await requestResetLink(page, user);
  await submitNewPassword(page, link, NEW_PASSWORD);
  await expect(page).toHaveURL("/login");

  await submitNewPassword(page, link, "yet another sufficiently long password");

  await expect(page.getByText("That reset link is invalid or has expired. Request a new one.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
});

test("the link's token never reaches a server in a URL or header; only the reset's body carries it", async ({
  page,
}) => {
  const user = await seedUser({ password: OLD_PASSWORD });
  const link = await requestResetLink(page, user);
  const token = tokenOf(link);

  // Every request from opening the link to the reset's answer: the page
  // itself, its scripts and styles, and the API calls.
  const requests: { url: string; headers: Record<string, string>; method: string; body: string | null }[] = [];
  page.on("request", (request) => {
    requests.push({
      url: request.url(),
      headers: request.headers(),
      method: request.method(),
      body: request.postData(),
    });
  });

  await submitNewPassword(page, link, NEW_PASSWORD);
  await expect(page.getByText("Password updated successfully! Redirecting...")).toBeVisible();

  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) {
    expect(request.url).not.toContain(token);
    for (const value of Object.values(request.headers)) expect(value).not.toContain(token);
  }
  const resets = requests.filter(
    (request) => request.method === "POST" && new URL(request.url).pathname === "/api/v1/auth/password-resets",
  );
  expect(resets).toHaveLength(1);
  expect(JSON.parse(resets[0]!.body ?? "{}")).toMatchObject({ token });
});
