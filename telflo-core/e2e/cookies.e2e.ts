import { expect, test } from "@playwright/test";
import { ACCESS_COOKIE_NAME } from "../apps/api/src/modules/sessions/cookies.js";
import { findSessions, seedUser } from "./support/database.js";
import { expireAccessToken, signInThroughApi, signInThroughForm, waitForHydration } from "./support/session.js";

// The access cookie outlives its token: the browser keeps it for the refresh
// token's lifetime, so an idle browser still presents the expired token and
// the API can answer access_token_expired, or name the session to revoke on
// logout.

const PASSWORD = "correct horse battery staple";

/** The E2E API leaves TELFLO_REFRESH_TOKEN_TTL_DAYS to its default. */
const REFRESH_TOKEN_TTL_DAYS = 30;
const DAY_SECONDS = 24 * 60 * 60;

test("after sign-in, the browser keeps the access cookie for the refresh token's 30 days", async ({ page, context }) => {
  const user = await seedUser({ password: PASSWORD });

  const signedInAtSeconds = Date.now() / 1000;
  await signInThroughForm(page, user);

  const cookie = (await context.cookies()).find((candidate) => candidate.name === ACCESS_COOKIE_NAME);
  expect(cookie).toBeDefined();
  // `expires` is in seconds since the epoch; a session cookie would be -1.
  const expectedExpiry = signedInAtSeconds + REFRESH_TOKEN_TTL_DAYS * DAY_SECONDS;
  expect(Math.abs(cookie!.expires - expectedExpiry)).toBeLessThanOrEqual(60);
});

test("after the access token expires, Logout still revokes the session with reason logout", async ({
  page,
  context,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  await page.goto("/app");
  await waitForHydration(page);
  await expect(page.getByTitle("Switch organization")).toBeVisible();

  // What the browser holds after 16 idle minutes on this page.
  await expireAccessToken(context);

  await page.getByTitle("Switch organization").click();
  await page.getByRole("button", { name: "Logout" }).click();

  await expect(page).toHaveURL("/login");
  const sessions = await findSessions(user.userId);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.revoked_at).not.toBeNull();
  expect(sessions[0]?.revoked_reason).toBe("logout");
});
