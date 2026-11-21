import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request, type Response } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type EnrollmentTokenRevealedResponse,
  type EnrollmentTokenRotatedResponse,
  type FleetCreatedResponse,
} from "@telflo/contracts";
import { expectBearersOnlyInNoCapture } from "./support/bearers.js";
import { createFleetThroughApi, createServerFleetThroughApi, revokeThroughApi } from "./support/collectors.js";
import { addMember, seedUser, type SeededUser } from "./support/database.js";
import { enrollFakeCollector, recordFakeTokenEvents } from "./support/fake-opamp-server.js";
import { isGetOf, nextPoll } from "./support/polling.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";

// A server fleet's Tokens tab, and a Kubernetes-supervisor fleet's new
// default token words, in the browser, against the E2E API and its fake
// opamp-server. Each test works in an organization of its own (a new user's,
// or a new group's), so tests and browsers run in parallel. Fleets, rotations
// and revokes the test isn't about are made through the API as the page's
// session (`page.request`, the CSRF header set); collectors on a token, and a
// history to page through, through the fake's control port
// (support/fake-opamp-server.ts), before the page reads them, but for the
// events seeded while the page polls: that test drives the page's clock
// (`nextPoll`, support/polling.ts).
//
// The E2E API runs with test limits (start-api.ts), so the bearer replies'
// 10 a minute never binds here (the web tests cover it). A bearer, taken
// from the reply the page was sent, is shown only inside `ph-no-capture`
// (support/bearers.ts) and is gone from the page once its dialog closes.
// Dates are formatted in the page, as the screens format them
// (`formatDateTime`), in the browser's own time zone.

const PASSWORD = "correct horse battery staple";
const FLEET_PATH = "/api/v1/organizations/[^/]+/fleets/[^/]+";
const TOKENS_PATH = new RegExp(`^${FLEET_PATH}/tokens$`);
const EVENTS_PATH = new RegExp(`^${FLEET_PATH}/tokens/events$`);
const ROTATE_PATH = new RegExp(`^${FLEET_PATH}/tokens/rotate$`);
const REVEAL_PATH = new RegExp(`^${FLEET_PATH}/tokens/[^/]+/reveal$`);
const REVOKE_PATH = new RegExp(`^${FLEET_PATH}/tokens/[^/]+/revoke$`);
const NEW_DEFAULT_PATH = new RegExp(`^${FLEET_PATH}/tokens/default$`);
const LINKS_PATH = new RegExp(`^${FLEET_PATH}/quick-deploy-links$`);
/** The tab's reads and polls: the tokens, the history's first page and the install links'. */
const isTokensRead = isGetOf(TOKENS_PATH);
const isEventsRead = isGetOf(EVENTS_PATH);
const isLinksRead = isGetOf(LINKS_PATH);
const CSRF = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const DAY_MS = 86_400_000;

const ROTATED_NO_ACTION =
  "No action required: running collectors are handed the new token on one of their next polls, and the default token is unchanged.";
const REVEAL_WORDS =
  "Anyone holding this token can enroll collectors in this fleet and receive the configuration they are sent. Each reveal is recorded in the token history.";
const ROTATE_REFUSED_ALONE =
  "Collectors holding it are refused within 10 seconds and stay refused until their supervisors restart; they then come back through the default token.";
const ONLY_VALID_ROTATE =
  "This is the fleet's only valid rotate token. Revoking it suspends the fleet: collectors that enroll or restart are sent no configuration until you rotate again.";
const DEFAULT_REVOKE =
  "Collectors still on the default token (those that don't accept connection settings, and every collector while the fleet is suspended) are refused within 10 seconds. New collectors can no longer enroll with it, and collectors whose supervisors restart are refused (they present it). You can then issue a new default token and re-run the install command on each host.";
const SUSPENDED_BANNER =
  "This fleet has no valid rotate token. Collectors that enroll or restart are sent no configuration, and collectors holding a revoked or expired rotate token are refused until their supervisors restart. Rotate to issue a new one: collectors on the default token that accept connection settings are handed it on one of their next polls.";
/** The banner's name (`TokenBanner`'s TOKEN_BANNER_LABEL). */
const TOKEN_BANNER_LABEL = "Rotate token notice";
const NO_PREDECESSOR_FORM = "The fleet has no valid rotate token: the new one is current at once.";
const NO_PREDECESSOR_RESULT = "The fleet had no valid rotate token: the new one is current at once.";
const NEW_DEFAULT_DESCRIPTION =
  "Issues a new default token for installing collectors. The revoked one stays revoked: collectors whose supervisors restart with it are refused until their install command is re-run with the new token.";
const NEW_DEFAULT_RESULT = "It is shown now only; Reveal gives it again. Re-run the install command on each host that used the revoked token.";
const CONTAINER_REINSTALL =
  "On a container host, remove the old container first (docker rm -f telflo-collector); keep the telflo-opamp volume to keep the same collector.";
/** A Kubernetes-supervisor fleet's words (the chart's checksum/token rolls the pods). */
const NEW_DEFAULT_DESCRIPTION_KUBERNETES =
  "Issues a new default token for installing collectors. The revoked one stays revoked: pods that start with it are refused until their group's Helm release is upgraded with the new token.";
const NEW_DEFAULT_RESULT_KUBERNETES =
  "It is shown now only; Reveal gives it again. Run each group's Install with Helm again: its pods restart with the new token.";
const GRACE_PAST = "Grace period end must be in the future.";
const GRACE_AFTER_EXPIRY = "Grace period end must be on or before the new token's expiry.";

/** A suffix no other test uses. */
const unique = () => randomUUID().slice(0, 8);

interface FleetSetup {
  user: SeededUser;
  organizationId: string;
  fleetId: string;
  created: FleetCreatedResponse;
}

/** A new user, signed in, with a server fleet of their organization (its rotate token expiring at `rotateExpiresAt`, else never). */
async function signedInWithFleet(page: Page, rotateExpiresAt: string | null = null): Promise<FleetSetup> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const created = await createServerFleetThroughApi(page, user.organizationId, undefined, rotateExpiresAt);
  return { user, organizationId: user.organizationId, fleetId: created.fleet.id, created };
}

/** The fleet's page at its Tokens tab, hydrated, the tab's first reads (the tokens, the history, the install links) answered. */
async function openTokens(page: Page, fleetId: string): Promise<void> {
  const tokens = page.waitForResponse((response) => isTokensRead(response.request()));
  const events = page.waitForResponse((response) => isEventsRead(response.request()));
  const links = page.waitForResponse((response) => isLinksRead(response.request()));
  await page.goto(`/fleet-management/${fleetId}?tab=tokens`);
  await waitForHydration(page);
  expect((await tokens).status()).toBe(200);
  expect((await events).status()).toBe(200);
  expect((await links).status()).toBe(200);
}

function isPostTo(path: RegExp): (response: Response) => boolean {
  return (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname);
}

function panel(page: Page): Locator {
  return page.getByRole("tabpanel");
}

/** The tokens table's rows, newest first. */
function tokenRows(page: Page): Locator {
  return panel(page)
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Kind" }) })
    .locator("tbody tr");
}

/** The rows of one kind ("Default" or "Rotate"), newest first. */
function rowsOfKind(page: Page, kind: "Default" | "Rotate"): Locator {
  return tokenRows(page).filter({ has: page.locator("td:first-child", { hasText: new RegExp(`^${kind}$`) }) });
}

/** A row's cell: 0 Kind, 1 Created, 2 Expires, 3 Status, 4 Active in the last 5 minutes, 5 actions. */
function cell(row: Locator, index: number): Locator {
  return row.locator("td").nth(index);
}

/** The history's rows, newest first. */
function historyRows(page: Page): Locator {
  return panel(page)
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Event" }) })
    .locator("tbody tr");
}

/** The history's column (1 Event, 2 Token, 3 By) for its first `count` rows. */
async function historyColumn(page: Page, column: number, count: number): Promise<string[]> {
  return (await historyRows(page).locator(`td:nth-child(${column + 1})`).allTextContents()).slice(0, count);
}

/** The header's "Rotate token" (the banner's, when shown, is inside the banner, after it). */
function headerRotate(page: Page): Locator {
  return panel(page).getByRole("button", { name: "Rotate token", exact: true }).first();
}

/**
 * The rotate-before-expiry banner, by its name: a `region` landmark rendered only when there is a banner, with
 * no live semantics. Behind a dialog it is hidden from the tree, so not found.
 */
function bannerOf(page: Page): Locator {
  return panel(page).getByRole("region", { name: TOKEN_BANNER_LABEL, exact: true });
}

/** An instant's date as the screens' `formatDateTime` begins it (its options less the time), formatted in the page. */
async function formattedDate(page: Page, iso: string): Promise<string> {
  const options = { month: "short", day: "numeric", year: "numeric" };
  return page.evaluate<string>(`new Date(${JSON.stringify(iso)}).toLocaleDateString("en-US", ${JSON.stringify(options)})`);
}

/** An instant as the screens' `formatDateTime` shows it, formatted in the page. */
async function formatted(page: Page, iso: string): Promise<string> {
  const options = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
  return page.evaluate<string>(`new Date(${JSON.stringify(iso)}).toLocaleString("en-US", ${JSON.stringify(options)})`);
}

/** The page's local date `days` days from today, as a date input's value. */
async function localDate(page: Page, days: number): Promise<string> {
  return page.evaluate<string>(`(() => {
    const today = new Date();
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ${days}, 12);
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  })()`);
}

/** The last millisecond of a local date in the page (the next day's start less 1 ms), as ISO 8601. */
async function endOfLocalDay(page: Page, date: string): Promise<string> {
  const [year, month, day] = date.split("-").map(Number);
  return page.evaluate<string>(`new Date(new Date(${year}, ${month! - 1}, ${day! + 1}).getTime() - 1).toISOString()`);
}

/** A rotation through the API, as the page's session. */
async function rotateThroughApi(
  page: Page,
  organizationId: string,
  fleetId: string,
  body: { expiresAt: string | null; graceEndsAt: string },
): Promise<EnrollmentTokenRotatedResponse["token"]> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/tokens/rotate`, {
    data: body,
    headers: CSRF,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as EnrollmentTokenRotatedResponse).token;
}

/** The page's content no longer holds `bearer`. */
async function expectBearerGone(page: Page, bearer: string): Promise<void> {
  expect(await page.content()).not.toContain(bearer);
}

/**
 * A reveal's bearer, masked at first (its whole text nowhere in the
 * dialog), then shown whole inside `ph-no-capture` after its box's Show
 * (named "Show " plus the token's noun).
 */
async function showMaskedBearer(dialog: Locator, bearer: string, noun: string): Promise<void> {
  await expect(dialog).not.toContainText(bearer);
  await dialog.getByRole("button", { name: `Show ${noun}`, exact: true }).click();
  await expect(dialog.locator(".ph-no-capture", { hasText: bearer })).toBeVisible();
}

test("the table's statuses: Valid, Current, Being replaced until its date, Revoked and Expired, with each token's active collectors", async ({
  page,
}) => {
  const { organizationId, fleetId, created } = await signedInWithFleet(page);
  // The create's rotate token, rotated with a grace a few seconds out: it expires once they pass.
  const shortGrace = new Date(Date.now() + 3_000).toISOString();
  const second = await rotateThroughApi(page, organizationId, fleetId, { expiresAt: null, graceEndsAt: shortGrace });
  expect(second.predecessorId).toBe(created.tokens.rotate.id);
  // The second rotated with 10 days' grace (then revoked), the third with 12 days' (being replaced), the fourth current.
  const third = await rotateThroughApi(page, organizationId, fleetId, {
    expiresAt: null,
    graceEndsAt: new Date(Date.now() + 10 * DAY_MS).toISOString(),
  });
  const replacedUntil = new Date(Date.now() + 12 * DAY_MS).toISOString();
  const fourth = await rotateThroughApi(page, organizationId, fleetId, { expiresAt: null, graceEndsAt: replacedUntil });
  expect([third.predecessorId, fourth.predecessorId]).toEqual([second.id, third.id]);
  await revokeThroughApi(page, organizationId, fleetId, second.id);
  // Collectors seen now: one on the current token, two on the default token.
  await enrollFakeCollector(organizationId, fleetId, { name: `current-${unique()}`, tokenId: fourth.id });
  await enrollFakeCollector(organizationId, fleetId, { name: `default-a-${unique()}` });
  await enrollFakeCollector(organizationId, fleetId, { name: `default-b-${unique()}` });
  // The short grace passed (a condition, not a sleep of a guessed length).
  await expect.poll(() => Date.now(), { intervals: [250] }).toBeGreaterThan(Date.parse(shortGrace) + 250);
  await openTokens(page, fleetId);

  await expect(tokenRows(page)).toHaveCount(5);
  const defaultRow = rowsOfKind(page, "Default");
  await expect(cell(defaultRow, 3)).toHaveText("Valid");
  await expect(cell(defaultRow, 2)).toContainText("Never");
  await expect(cell(defaultRow, 4)).toHaveText("2 collectors");

  // Rotate tokens, newest first: the fourth, third, second and the create's.
  const rotate = rowsOfKind(page, "Rotate");
  await expect(rotate).toHaveCount(4);
  await expect(cell(rotate.nth(0), 3)).toHaveText("Current");
  await expect(cell(rotate.nth(0), 4)).toHaveText("1 collector");
  await expect(cell(rotate.nth(1), 3)).toHaveText(`Being replaceduntil ${await formatted(page, replacedUntil)}`);
  await expect(cell(rotate.nth(1), 2)).toContainText("11d left");
  await expect(cell(rotate.nth(2), 3)).toHaveText("Revoked");
  await expect(cell(rotate.nth(3), 3)).toHaveText("Expired");
  await expect(cell(rotate.nth(3), 2)).toContainText("Expired");
  await expect(cell(rotate.nth(3), 4)).toHaveText("0 collectors");

  // Reveal and Revoke on a valid token only.
  for (const row of [defaultRow, rotate.nth(0), rotate.nth(1)]) {
    await expect(cell(row, 5).getByRole("button")).toHaveText(["Reveal", "Revoke"]);
  }
  for (const row of [rotate.nth(2), rotate.nth(3)]) await expect(cell(row, 5).getByRole("button")).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Reveal the default token", exact: true })).toBeVisible();

  // Install links, between the tokens and the History: none made yet.
  await expect(panel(page).getByRole("heading", { name: "Install links" })).toBeVisible();
  await expect(panel(page).getByText("No install links for this fleet yet.")).toBeVisible();
  await expect(panel(page).getByText("Links appear here when you make a Quick Deploy command in the install dialog.")).toBeVisible();
});

test("reveals the default token and a rotate token: each bearer only inside ph-no-capture, gone after Done, and each reveal in the history", async ({
  page,
}) => {
  const { user, fleetId } = await signedInWithFleet(page);
  await openTokens(page, fleetId);
  await expect.poll(() => historyColumn(page, 1, 3)).toEqual(["Issued", "Issued"]);

  for (const kind of ["default", "rotate"] as const) {
    const answered = page.waitForResponse(isPostTo(REVEAL_PATH));
    const reloaded = page.waitForResponse((response) => isEventsRead(response.request()));
    await panel(page)
      .getByRole("button", { name: kind === "default" ? "Reveal the default token" : /^Reveal the rotate token created / })
      .click();
    const dialog = page.getByRole("dialog", { name: kind === "default" ? "Default token" : "Rotate token" });
    const response = await answered;
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    const { token } = (await response.json()) as EnrollmentTokenRevealedResponse;
    expect(token.kind).toBe(kind);
    await expect(dialog).toContainText(REVEAL_WORDS);
    await showMaskedBearer(dialog, token.bearer, `${kind} token`);
    await expect(dialog.getByRole("button", { name: kind === "default" ? "Copy default token" : "Copy rotate token" })).toBeVisible();
    await expectBearersOnlyInNoCapture(page, [token.bearer]);
    // The tab reloads behind the dialog: the history gains the reveal.
    await reloaded;

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await expectBearerGone(page, token.bearer);
  }

  // Newest first, each by the person: the rotate token's reveal, the default token's, then the create's two.
  await expect.poll(() => historyColumn(page, 1, 4)).toEqual(["Revealed", "Revealed", "Issued", "Issued"]);
  const tokens = await historyColumn(page, 2, 2);
  expect(tokens[0]).toMatch(/^Rotate token created /);
  expect(tokens[1]).toBe("Default token");
  expect(await historyColumn(page, 3, 4)).toEqual(Array(4).fill(user.email));
});

test("rotates with a preset and a grace: the grace's checks, the request's instants, the result's bearer only in ph-no-capture, the table and the history after", async ({
  page,
}) => {
  const { user, fleetId, created } = await signedInWithFleet(page);
  await openTokens(page, fleetId);
  // No banner: the rotate token never expires.
  await expect(bannerOf(page)).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Rotate token", exact: true })).toHaveCount(1);

  await headerRotate(page).click();
  const dialog = page.getByRole("dialog", { name: "Rotate token" });
  const submit = dialog.getByRole("button", { name: "Rotate token" });
  // The presets: 1 year by default.
  await expect(dialog.getByRole("radio", { name: "1 year" })).toBeChecked();
  for (const [preset, days] of [
    ["Never", null],
    ["2 years", 730],
    ["180 days", 180],
  ] as const) {
    await dialog.getByRole("radio", { name: preset }).check();
    if (days === null) await expect(dialog.getByText("The new token never expires.")).toBeVisible();
    else {
      // The date's day, month and year (its minute moves with the clock).
      const day = await formattedDate(page, new Date(Date.now() + days * DAY_MS).toISOString());
      await expect(dialog.getByText(/^New token expires .+\.$/)).toContainText(`New token expires ${day}`);
    }
  }

  // The grace: today + 30 days by default; past the 180 days' expiry, or before today, refused.
  const grace = dialog.getByLabel("Current token stops working on");
  await expect(grace).toHaveValue(await localDate(page, 30));
  await grace.fill(await localDate(page, 200));
  await expect(dialog.getByRole("alert")).toHaveText(GRACE_AFTER_EXPIRY);
  await expect(submit).toBeDisabled();
  await grace.fill(await localDate(page, -1));
  await expect(dialog.getByRole("alert")).toHaveText(GRACE_PAST);
  await expect(submit).toBeDisabled();
  const graceDate = await localDate(page, 10);
  await grace.fill(graceDate);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeEnabled();

  const answered = page.waitForResponse(isPostTo(ROTATE_PATH));
  const before = Date.now();
  await submit.click();
  const response = await answered;
  const after = Date.now();
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const sent = response.request().postDataJSON() as { expiresAt: string; graceEndsAt: string };
  // 180 days from the submit's now; the grace the end of the chosen local day.
  expect(Date.parse(sent.expiresAt)).toBeGreaterThanOrEqual(before + 180 * DAY_MS - 1_000);
  expect(Date.parse(sent.expiresAt)).toBeLessThanOrEqual(after + 180 * DAY_MS);
  expect(sent.graceEndsAt).toBe(await endOfLocalDay(page, graceDate));
  const { token } = (await response.json()) as EnrollmentTokenRotatedResponse;
  expect(token.predecessorId).toBe(created.tokens.rotate.id);

  // The result: the bearer once, inside ph-no-capture; the replaced token stops at the grace (it never expired).
  const result = page.getByRole("dialog", { name: "Token rotated" });
  await expect(result).toContainText(ROTATED_NO_ACTION);
  await expect(result.locator(".ph-no-capture", { hasText: token.bearer })).toBeVisible();
  await expectBearersOnlyInNoCapture(page, [token.bearer]);
  const graceShown = await formatted(page, sent.graceEndsAt);
  await expect(result).toContainText(`The token it replaces stops working on ${graceShown}.`);
  await result.getByRole("button", { name: "Done" }).click();
  await expect(result).toBeHidden();
  await expectBearerGone(page, token.bearer);

  // The new token current; the old one being replaced until the grace.
  const rotate = rowsOfKind(page, "Rotate");
  await expect(rotate).toHaveCount(2);
  await expect(cell(rotate.nth(0), 3)).toHaveText("Current");
  await expect(cell(rotate.nth(1), 3)).toHaveText(`Being replaceduntil ${graceShown}`);
  // The history: the rotation's two events (one instant: either order), then the create's, all by the person.
  await expect.poll(async () => (await historyColumn(page, 1, 2)).sort()).toEqual(["Issued", "Rotated"]);
  expect(await historyColumn(page, 1, 4)).toHaveLength(4);
  expect((await historyColumn(page, 1, 4)).slice(2)).toEqual(["Issued", "Issued"]);
  expect(await historyColumn(page, 3, 4)).toEqual(Array(4).fill(user.email));
});

test("revokes: the default token's and the only rotate token's words with their active counts; the fleet suspended, then rotated from the banner", async ({
  page,
}) => {
  const { user, organizationId, fleetId, created } = await signedInWithFleet(page);
  await enrollFakeCollector(organizationId, fleetId, { name: `on-default-${unique()}` });
  for (const name of ["a", "b"]) {
    await enrollFakeCollector(organizationId, fleetId, { name: `on-rotate-${name}-${unique()}`, tokenId: created.tokens.rotate.id });
  }
  await openTokens(page, fleetId);
  // No banner: nothing of it rendered, hidden or not.
  await expect(bannerOf(page)).toHaveCount(0);
  await expect(panel(page).getByRole("region", { name: TOKEN_BANNER_LABEL, exact: true, includeHidden: true })).toHaveCount(0);
  const rotateRow = rowsOfKind(page, "Rotate");
  await expect(cell(rotateRow, 4)).toHaveText("2 collectors");
  await expect(cell(rowsOfKind(page, "Default"), 4)).toHaveText("1 collector");

  // The default token's: what refusing it does, its count; canceled.
  await panel(page).getByRole("button", { name: "Revoke the default token", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Revoke this token?" });
  await expect(dialog).toContainText(DEFAULT_REVOKE);
  await expect(dialog).toContainText("1 collector seen in the last 5 minutes is on it.");
  await expect(dialog).not.toContainText(ONLY_VALID_ROTATE);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // The only valid rotate token's: refused until a restart (no other to hand over), its count, the suspension.
  await panel(page).getByRole("button", { name: /^Revoke the rotate token created / }).click();
  await expect(dialog).toContainText(ROTATE_REFUSED_ALONE);
  await expect(dialog).toContainText("2 collectors seen in the last 5 minutes are on it.");
  await expect(dialog).toContainText(ONLY_VALID_ROTATE);
  const revoked = page.waitForResponse(isPostTo(REVOKE_PATH));
  await dialog.getByRole("button", { name: "Revoke token" }).click();
  expect((await revoked).status()).toBe(200);
  await expect(page.getByText("Token revoked")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(cell(rotateRow, 3)).toHaveText("Revoked");
  await expect(cell(rotateRow, 5).getByRole("button")).toHaveCount(0);

  // Suspended: the banner, and the strip's tile.
  await expect(bannerOf(page)).toContainText(SUSPENDED_BANNER);
  await expect(page.getByRole("link", { name: "Suspended (open the Tokens tab)", exact: true })).toBeVisible();
  await expect.poll(() => historyColumn(page, 1, 3)).toEqual(["Revoked", "Issued", "Issued"]);
  expect((await historyColumn(page, 3, 1))[0]).toBe(user.email);

  // Rotated from the banner's button: no grace to choose; the new token is current at once.
  await expect(panel(page).getByRole("button", { name: "Rotate token", exact: true })).toHaveCount(2);
  await bannerOf(page).getByRole("button", { name: "Rotate token", exact: true }).click();
  const rotateDialog = page.getByRole("dialog", { name: "Rotate token" });
  await expect(rotateDialog).toContainText(NO_PREDECESSOR_FORM);
  // Behind the dialog, the banner and its button are hidden from the tree (no aria-live for hideOthers to skip).
  await expect(page.getByRole("region", { name: TOKEN_BANNER_LABEL, exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: TOKEN_BANNER_LABEL, exact: true, includeHidden: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Rotate token", exact: true })).toHaveCount(1);
  await expect(rotateDialog.getByRole("button", { name: "Rotate token", exact: true })).toHaveCount(1);
  await expect(rotateDialog.getByLabel("Current token stops working on")).toHaveCount(0);
  const answered = page.waitForResponse(isPostTo(ROTATE_PATH));
  await rotateDialog.getByRole("button", { name: "Rotate token" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  // The default grace still sent: the end of today + 30 days.
  const sentGrace = (response.request().postDataJSON() as { graceEndsAt: string }).graceEndsAt;
  expect(sentGrace).toBe(await endOfLocalDay(page, await localDate(page, 30)));
  const { token } = (await response.json()) as EnrollmentTokenRotatedResponse;
  expect(token.predecessorId).toBeNull();
  const result = page.getByRole("dialog", { name: "Token rotated" });
  await expect(result).toContainText(NO_PREDECESSOR_RESULT);
  await expectBearersOnlyInNoCapture(page, [token.bearer]);
  await result.getByRole("button", { name: "Done" }).click();
  await expect(result).toBeHidden();
  await expectBearerGone(page, token.bearer);

  // No longer suspended: the banner gone, nothing of it left.
  await expect(bannerOf(page)).toHaveCount(0);
  await expect(panel(page).getByRole("region", { name: TOKEN_BANNER_LABEL, exact: true, includeHidden: true })).toHaveCount(0);
  await expect(cell(rowsOfKind(page, "Rotate").nth(0), 3)).toHaveText("Current");
  await expect.poll(() => historyColumn(page, 1, 4)).toEqual(["Issued", "Revoked", "Issued", "Issued"]);
});

// A revoked default token followed by a new one.
test("issues a new default token after the default token is revoked: its bearer only inside ph-no-capture, the button gone, both default tokens named by their dates", async ({
  page,
}) => {
  const { user, organizationId, fleetId, created } = await signedInWithFleet(page);
  await revokeThroughApi(page, organizationId, fleetId, created.tokens.default.id);
  await openTokens(page, fleetId);
  const newDefault = panel(page).getByRole("button", { name: "New default token", exact: true });
  await expect(newDefault).toBeEnabled();
  await expect(cell(rowsOfKind(page, "Default"), 3)).toHaveText("Revoked");

  await newDefault.click();
  const dialog = page.getByRole("dialog", { name: "New default token" });
  await expect(dialog).toContainText(NEW_DEFAULT_DESCRIPTION);
  const answered = page.waitForResponse(isPostTo(NEW_DEFAULT_PATH));
  const reloaded = page.waitForResponse((response) => isTokensRead(response.request()));
  await dialog.getByRole("button", { name: "Issue token" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const { token } = (await response.json()) as EnrollmentTokenRevealedResponse;
  expect(token).toMatchObject({ kind: "default", expiresAt: null });
  await expect(dialog.locator(".ph-no-capture", { hasText: token.bearer })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy default token" })).toBeVisible();
  await expect(dialog).toContainText(NEW_DEFAULT_RESULT);
  await expectBearersOnlyInNoCapture(page, [token.bearer]);
  // The tab reloads behind the dialog: a valid default token again, so the button goes.
  await reloaded;
  await expect(page.getByRole("button", { name: "New default token", exact: true, includeHidden: true })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expectBearerGone(page, token.bearer);
  // The focus on the first row action: the new default token's Reveal, named by its date (two default tokens).
  const defaults = rowsOfKind(page, "Default");
  await expect(defaults).toHaveCount(2);
  await expect(cell(defaults.nth(0), 3)).toHaveText("Valid");
  await expect(cell(defaults.nth(1), 3)).toHaveText("Revoked");
  const reveal = cell(defaults.nth(0), 5).getByRole("button", { name: /^Reveal the default token created / });
  await expect(reveal).toBeFocused();
  await expect(panel(page).getByRole("button", { name: "Reveal the default token", exact: true })).toHaveCount(0);

  // The history: the issue, by the person, each default token by its date (made within the test's minute, the same date).
  await expect.poll(() => historyColumn(page, 1, 4)).toEqual(["Issued", "Revoked", "Issued", "Issued"]);
  expect(await historyColumn(page, 2, 2)).toEqual([expect.stringMatching(/^Default token created /), expect.stringMatching(/^Default token created /)]);
  expect((await historyColumn(page, 3, 1))[0]).toBe(user.email);

  // A second issue through the API is refused: the fleet has a valid default token.
  const again = await page.request.post(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/tokens/default`, { headers: CSRF });
  expect(again.status()).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("enrollment_token_default_exists");
});

// A Kubernetes-supervisor fleet's new default token names its groups' Helm releases, whose upgrade restarts the pods
// (the chart's checksum/token), in place of the hosts' install command.
test("a Kubernetes-supervisor fleet's new default token: its description and result in the Helm words exactly, the bearer only inside ph-no-capture, gone after Done", async ({
  page,
}) => {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const { organizationId } = user;
  const created = await createFleetThroughApi(page, organizationId, "kubernetes-supervisor");
  const fleetId = created.fleet.id;
  await revokeThroughApi(page, organizationId, fleetId, created.tokens.default.id);
  await openTokens(page, fleetId);
  await expect(cell(rowsOfKind(page, "Default"), 3)).toHaveText("Revoked");

  await panel(page).getByRole("button", { name: "New default token", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New default token" });
  await expect(dialog).toHaveAccessibleDescription(NEW_DEFAULT_DESCRIPTION_KUBERNETES);
  const answered = page.waitForResponse(isPostTo(NEW_DEFAULT_PATH));
  await dialog.getByRole("button", { name: "Issue token" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  const { token } = (await response.json()) as EnrollmentTokenRevealedResponse;
  await expect(dialog.getByRole("button", { name: "Copy default token" })).toBeVisible();
  await expectBearersOnlyInNoCapture(page, [token.bearer]);
  // The result's words exactly, and none of a server fleet's (the hosts' install command, the container's).
  await expect(dialog.getByText(NEW_DEFAULT_RESULT_KUBERNETES, { exact: true })).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(NEW_DEFAULT_DESCRIPTION_KUBERNETES);
  await expect(dialog.getByText(NEW_DEFAULT_RESULT, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(CONTAINER_REINSTALL, { exact: true })).toHaveCount(0);
  await expect(dialog).not.toContainText("install command");

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expectBearerGone(page, token.bearer);
});

test("the strip's Token tile opens the Tokens tab, whose banner warns of the rotate token's expiry; rotating from it ends the warning", async ({
  page,
}) => {
  // Five days and an hour: "in 5 days" and "5d left" while the test runs.
  const expiresAt = new Date(Date.now() + 5 * DAY_MS + 60 * 60_000).toISOString();
  const { fleetId, created } = await signedInWithFleet(page, expiresAt);
  await page.goto(`/fleet-management/${fleetId}`);
  await waitForHydration(page);
  await expect(page.getByRole("tab", { name: "Collectors" })).toHaveAttribute("aria-selected", "true");

  const tokensRead = page.waitForResponse((response) => isTokensRead(response.request()));
  await page.getByRole("link", { name: "5d left (open the Tokens tab)", exact: true }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleetId}?tab=tokens`);
  await expect(page.getByRole("tab", { name: "Tokens" })).toHaveAttribute("aria-selected", "true");
  expect((await tokensRead).status()).toBe(200);

  const listedExpiry = created.tokens.rotate.expiresAt!;
  const expiryShown = await formatted(page, listedExpiry);
  await expect(bannerOf(page)).toContainText(
    `The fleet's rotate token expires in 5 days (${expiryShown}). Rotate it before then: collectors still holding it when it expires are refused until their supervisors restart.`,
  );
  // The header's Rotate token and the banner's.
  await expect(panel(page).getByRole("button", { name: "Rotate token", exact: true })).toHaveCount(2);

  await bannerOf(page).getByRole("button", { name: "Rotate token", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rotate token" });
  // The default grace (30 days) is after the current token's own expiry: it stops then.
  await expect(dialog).toContainText(
    `The current token expires ${expiryShown} on its own: a later date doesn't keep it working past then.`,
  );
  const answered = page.waitForResponse(isPostTo(ROTATE_PATH));
  await dialog.getByRole("button", { name: "Rotate token" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  const { token } = (await response.json()) as EnrollmentTokenRotatedResponse;
  expect(token.predecessorId).toBe(created.tokens.rotate.id);
  const result = page.getByRole("dialog", { name: "Token rotated" });
  // Its own expiry, sooner than the grace: a rotation never lengthens a token's life.
  await expect(result).toContainText(`The token it replaces stops working on ${expiryShown}.`);
  await expectBearersOnlyInNoCapture(page, [token.bearer]);
  await result.getByRole("button", { name: "Done" }).click();
  await expect(result).toBeHidden();

  // The new token expires in a year: no banner.
  await expect(bannerOf(page)).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Rotate token", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: /^1y/ })).toBeVisible();
});

test("the history pages 50 at a time with Load more; a poll re-reads its first page, but leaves it alone after Load more until a refresh", async ({
  page,
}) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  await recordFakeTokenEvents(organizationId, fleetId, { count: 60 });
  // The page's clock, at the real now (the fake's): installed before the page loads.
  await page.clock.install();
  await openTokens(page, fleetId);
  await expect(historyRows(page)).toHaveCount(50);
  const loadMore = panel(page).getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();
  // Seeded events: revealed, by no one.
  expect(await historyColumn(page, 3, 1)).toEqual(["—"]);

  // While only the first page is shown, a poll reads it again: an event recorded meanwhile shows at the top.
  const first = `first-${unique()}@example.com`;
  await recordFakeTokenEvents(organizationId, fleetId, { count: 1, event: "issued", actor: { id: randomUUID(), email: first } });
  expect(await panel(page).getByText(first).count()).toBe(0);
  await nextPoll(page, [isTokensRead, isEventsRead]);
  await expect(historyRows(page).first()).toContainText(first);
  await expect(historyRows(page)).toHaveCount(50);

  // Load more: the rest (the 60 seeded, the one recorded since and the create's two), each once; no next page.
  const more = page.waitForResponse((response) => isEventsRead(response.request()));
  await loadMore.click();
  const moreResponse = await more;
  expect(moreResponse.status()).toBe(200);
  expect(new URL(moreResponse.url()).searchParams.get("cursor")).not.toBeNull();
  await expect(historyRows(page)).toHaveCount(63);
  await expect(loadMore).toHaveCount(0);
  // The seeded 60 (spread over their last 60 ms, which may reach back past the create's), the one since and the create's two.
  const counts = (events: string[]) => ({
    issued: events.filter((each) => each === "Issued").length,
    revealed: events.filter((each) => each === "Revealed").length,
  });
  await expect.poll(async () => counts(await historyColumn(page, 1, 63))).toEqual({ issued: 3, revealed: 60 });

  // A poll now reads the tokens only: the history is left as it is.
  const second = `second-${unique()}@example.com`;
  await recordFakeTokenEvents(organizationId, fleetId, { count: 1, event: "issued", actor: { id: randomUUID(), email: second } });
  const historyReads: Request[] = [];
  page.on("request", (request) => {
    if (isEventsRead(request)) historyReads.push(request);
  });
  // Two polls: a history read the first poll began late (after its tokens' reply) shows by the second's end.
  await nextPoll(page, isTokensRead);
  await nextPoll(page, isTokensRead);
  expect(
    historyReads.map((request) => request.url()),
    "the history reads during two polls",
  ).toEqual([]);
  await expect(historyRows(page)).toHaveCount(63);
  expect(await panel(page).getByText(second).count()).toBe(0);

  // The refresh reads the tokens and the history from the top.
  const refreshed = page.waitForResponse((response) => isEventsRead(response.request()));
  await panel(page).getByRole("button", { name: "Refresh tokens" }).click();
  const refreshedResponse = await refreshed;
  expect(new URL(refreshedResponse.url()).searchParams.get("cursor")).toBeNull();
  await expect(historyRows(page).first()).toContainText(second);
  await expect(historyRows(page)).toHaveCount(50);
  await expect(loadMore).toBeVisible();
});

test("a contributor reveals the group's fleet's default token, the reveal recorded by their email", async ({ page }) => {
  const admin = await seedUser({ password: PASSWORD });
  const contributor = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId });
  await addMember({ userId: contributor.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, contributor);
  await switchOrganizationThroughApi(page, group.organizationId);
  const { fleet } = await createServerFleetThroughApi(page, group.organizationId);
  await openTokens(page, fleet.id);

  const answered = page.waitForResponse(isPostTo(REVEAL_PATH));
  await panel(page).getByRole("button", { name: "Reveal the default token", exact: true }).click();
  const response = await answered;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).pathname).toMatch(new RegExp(`^/api/v1/organizations/${group.organizationId}/fleets/${fleet.id}/tokens/`));
  const { token } = (await response.json()) as EnrollmentTokenRevealedResponse;
  const dialog = page.getByRole("dialog", { name: "Default token" });
  await showMaskedBearer(dialog, token.bearer, "default token");
  await expectBearersOnlyInNoCapture(page, [token.bearer]);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expectBearerGone(page, token.bearer);

  await expect.poll(() => historyColumn(page, 1, 1)).toEqual(["Revealed"]);
  expect(await historyColumn(page, 3, 1)).toEqual([contributor.email]);
});
