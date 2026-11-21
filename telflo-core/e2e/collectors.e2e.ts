import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import {
  collectorsApiPath,
  collectorsThroughApi,
  collectorThroughApi,
  createGroupThroughApi,
  createServerFleetThroughApi,
  enrollCollectors,
  publishedConfiguration,
} from "./support/collectors.js";
import { addMember, seedUser, type SeededUser } from "./support/database.js";
import { enrollFakeCollector, recordFakeCollectorError, setFakeCollectorState } from "./support/fake-opamp-server.js";
import { isGetOf, nextPoll } from "./support/polling.js";
import { canaryVariableValue, placesOf } from "./support/privacy.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";
import { createVariableGroupThroughApi, createVariableThroughApi, setOverrideThroughApi, uniqueVariableName } from "./support/variables.js";

// A server fleet's Collectors tab, in the browser, against the E2E API and its
// fake opamp-server. Each test works in an organization of its own (a new
// user's, or a new group's), so tests and browsers run in parallel. Fleets,
// groups, pins and publishing go through the API as the page's session;
// collectors and errors through the fake's control port
// (support/collectors.ts, support/fake-opamp-server.ts), before the page reads
// them, but for the collector enrolled while the page polls: that test drives
// the page's clock (`nextPoll`, support/polling.ts). Nothing else here
// installs `page.clock`: the bulk move's 429 is waited out in real time.

const PASSWORD = "correct horse battery staple";
/** The fleet's collectors' list (its query aside): the tab's reads and polls. */
const COLLECTORS_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/collectors$/;
/** One collector's path: its PATCH (a move, an edit) and its DELETE. */
const COLLECTOR_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/collectors\/[^/]+$/;
const isCollectorsRead = isGetOf(COLLECTORS_PATH);
const NAME_TAKEN = "Another of the organization's collectors has this name.";
/** An empty fleet's Collectors tab before an install in the visit. */
const INSTALL_FIRST = "Install your first collector";

/** A suffix no other test uses. */
const unique = () => randomUUID().slice(0, 8);

/** A new user, signed in, with a server fleet of their organization. */
async function signedInWithFleet(page: Page): Promise<{ user: SeededUser; organizationId: string; fleetId: string }> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const { fleet } = await createServerFleetThroughApi(page, user.organizationId);
  return { user, organizationId: user.organizationId, fleetId: fleet.id };
}

/** The fleet's page, hydrated, its Collectors tab's first read answered. */
async function openCollectors(page: Page, fleetId: string): Promise<void> {
  const read = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await page.goto(`/fleet-management/${fleetId}`);
  await waitForHydration(page);
  expect((await read).status()).toBe(200);
}

/** The grid's rows (the header's aside). */
function bodyRows(page: Page): Locator {
  return page.locator("tbody tr");
}

/** The collectors' names, in the grid's order. */
async function shownNames(page: Page): Promise<string[]> {
  return bodyRows(page).locator("td:nth-child(2) button").allTextContents();
}

/** The grid shows `names`, in this order; once its rows render (a read's answer comes before them). */
async function expectNames(page: Page, names: string[]): Promise<void> {
  await expect.poll(() => shownNames(page)).toEqual(names);
}

/** The grid shows `names`, in whatever order. */
async function expectNamesInAnyOrder(page: Page, names: string[]): Promise<void> {
  await expect.poll(async () => (await shownNames(page)).sort()).toEqual([...names].sort());
}

/** The row of the collector named `name`. */
function collectorRow(page: Page, name: string): Locator {
  return bodyRows(page).filter({ has: page.getByRole("button", { name, exact: true }) });
}

function pagerText(page: Page): Locator {
  return page.getByText(/^Showing \d+–\d+/);
}

/** A person's read of the list: `act` starts it; its answer awaited. */
async function readAfter(page: Page, act: () => Promise<void>): Promise<void> {
  const read = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await act();
  expect((await read).status()).toBe(200);
}

/** Searches the toolbar's box (on Enter). */
async function search(page: Page, text: string): Promise<void> {
  await readAfter(page, async () => {
    await page.getByRole("searchbox", { name: "Search collectors" }).fill(text);
    await page.getByRole("searchbox", { name: "Search collectors" }).press("Enter");
  });
}

/** Picks `option` in the Select named `name`, within `scope`. */
async function choose(page: Page, scope: Page | Locator, name: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

test("an empty fleet shows the install state, and a collector enrolled appears within one poll", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  // The page's clock, at the real now (the fake's): installed before the page loads.
  await page.clock.install();
  await openCollectors(page, fleetId);
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText(INSTALL_FIRST)).toBeVisible();
  await expect(panel.getByText("Run one copy-paste command on a host; the collector connects with this fleet's token and appears here.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Install collector" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);

  const name = `first-${unique()}`;
  await enrollFakeCollector(organizationId, fleetId, { name, reported: { ip: "10.20.30.40" } });
  // A snapshot before the poll: the page doesn't read the collector until it.
  expect(await panel.getByText(INSTALL_FIRST).count()).toBe(1);
  await nextPoll(page, isCollectorsRead);
  await expect(collectorRow(page, name)).toBeVisible();
  await expect(collectorRow(page, name)).toContainText("10.20.30.40");
  await expect(collectorRow(page, name)).toContainText("Default");
  await expect(panel.getByText(INSTALL_FIRST)).toHaveCount(0);
});

test("pages through 120 collectors with Prev and Next, 50 a page, with the total; Prev shows the same collectors again", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const prefix = `page-${unique()}`;
  await enrollCollectors(organizationId, fleetId, prefix, 120);
  await openCollectors(page, fleetId);
  const prev = page.getByRole("button", { name: "Prev", exact: true });
  const next = page.getByRole("button", { name: "Next", exact: true });

  await expect(pagerText(page)).toHaveText("Showing 1–50 of 120");
  await expect(bodyRows(page)).toHaveCount(50);
  await expect(prev).toBeDisabled();
  const first = await shownNames(page);

  await readAfter(page, () => next.click());
  await expect(pagerText(page)).toHaveText("Showing 51–100 of 120");
  await expect(bodyRows(page)).toHaveCount(50);
  const second = await shownNames(page);

  await readAfter(page, () => next.click());
  await expect(pagerText(page)).toHaveText("Showing 101–120 of 120");
  await expect(bodyRows(page)).toHaveCount(20);
  await expect(next).toBeDisabled();
  const third = await shownNames(page);

  // Every collector once: the pages hold no name twice and leave none out (their order isn't asserted).
  const every = Array.from({ length: 120 }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`);
  expect([...first, ...second, ...third].sort()).toEqual(every);

  await readAfter(page, () => prev.click());
  await expect(pagerText(page)).toHaveText("Showing 51–100 of 120");
  await expectNamesInAnyOrder(page, second);
  await readAfter(page, () => prev.click());
  await expect(pagerText(page)).toHaveText("Showing 1–50 of 120");
  await expectNamesInAnyOrder(page, first);
  await expect(prev).toBeDisabled();
});

test("searches by name and by IP, and filters by group, with no total while searched or filtered", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const groupName = `gateways-${unique()}`;
  const group = await createGroupThroughApi(page, organizationId, fleetId, groupName);
  await enrollFakeCollector(organizationId, fleetId, { name: "alpha-one", reported: { ip: "10.1.0.1" } });
  await enrollFakeCollector(organizationId, fleetId, { name: "alpha-two", groupId: group.id, reported: { ip: "10.1.0.2" } });
  await enrollFakeCollector(organizationId, fleetId, { name: "beta-one", groupId: group.id, reported: { ip: "10.9.9.9" } });
  await openCollectors(page, fleetId);
  await expect(pagerText(page)).toHaveText("Showing 1–3 of 3");

  // By name.
  await search(page, "alpha");
  await expectNamesInAnyOrder(page, ["alpha-one", "alpha-two"]);
  await expect(pagerText(page)).toHaveText("Showing 1–2");
  // By IP.
  await search(page, "10.9.9.9");
  await expectNames(page, ["beta-one"]);
  await expect(pagerText(page)).toHaveText("Showing 1–1");
  // Nothing matching.
  await search(page, "gamma");
  await expect(page.getByText("No collectors match “gamma”.")).toBeVisible();
  // The box emptied: everything, with the total.
  await search(page, "");
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(pagerText(page)).toHaveText("Showing 1–3 of 3");

  // By group.
  await readAfter(page, () => choose(page, page, "Filter by group", groupName));
  await expectNamesInAnyOrder(page, ["alpha-two", "beta-one"]);
  await expect(pagerText(page)).toHaveText("Showing 1–2");
  for (const name of ["alpha-two", "beta-one"]) await expect(collectorRow(page, name)).toContainText(groupName);
  // Searched within the group.
  await search(page, "beta");
  await expectNames(page, ["beta-one"]);
  await search(page, "");
  await readAfter(page, () => choose(page, page, "Filter by group", "All groups"));
  await expect(bodyRows(page)).toHaveCount(3);
  await expect(pagerText(page)).toHaveText("Showing 1–3 of 3");
});

test("sorts by name and by last seen, each header alternating ascending and descending", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const now = Date.now();
  // Enrolled b, a, c; last seen 3, 1 and 2 minutes ago.
  await enrollFakeCollector(organizationId, fleetId, { name: "sort-b", lastSeenAt: new Date(now - 3 * 60_000) });
  await enrollFakeCollector(organizationId, fleetId, { name: "sort-a", lastSeenAt: new Date(now - 60_000) });
  await enrollFakeCollector(organizationId, fleetId, { name: "sort-c", lastSeenAt: new Date(now - 2 * 60_000) });
  await openCollectors(page, fleetId);
  await expect(bodyRows(page)).toHaveCount(3);
  const nameHeader = page.getByRole("columnheader", { name: "Name" });
  const lastSeenHeader = page.getByRole("columnheader", { name: "Last seen" });

  await readAfter(page, () => nameHeader.getByRole("button").click());
  await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
  await expectNames(page, ["sort-a", "sort-b", "sort-c"]);
  await readAfter(page, () => nameHeader.getByRole("button").click());
  await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
  await expectNames(page, ["sort-c", "sort-b", "sort-a"]);

  // Last seen, ascending first: the longest unseen first.
  await readAfter(page, () => lastSeenHeader.getByRole("button").click());
  await expect(lastSeenHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(nameHeader).not.toHaveAttribute("aria-sort");
  await expectNames(page, ["sort-b", "sort-c", "sort-a"]);
  // Status follows the liveness: seen 3 minutes ago, Unknown; Last seen the time alone.
  await expect(collectorRow(page, "sort-b").locator("td").nth(5)).toHaveText("Unknown (unknown: last seen 2–5 minutes ago)");
  await expect(collectorRow(page, "sort-b").locator("td").nth(8)).toHaveText(/^3 minutes ago \(/);
  await readAfter(page, () => lastSeenHeader.getByRole("button").click());
  await expect(lastSeenHeader).toHaveAttribute("aria-sort", "descending");
  await expectNames(page, ["sort-a", "sort-c", "sort-b"]);
});

test("a collector's details: its rows, attributes and error history, no imported configuration, the private text only inside ph-no-capture", async ({
  page,
}) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const canary = unique();
  const name = `details-${canary}`;
  const attributeValue = `canary-attribute-${canary}`;
  const firstError = `canary-error-one-${canary}`;
  const secondError = `canary-error-two-${canary}`;
  const applyError = `canary-apply-error-${canary}`;
  const collector = await enrollFakeCollector(organizationId, fleetId, {
    name,
    reported: { collectorVersion: "0.162.0", ip: "10.0.0.7", hostIp: "192.168.1.7", attributes: { "host.name": attributeValue } },
  });
  // Nothing assigned: it runs its own file, whose apply it reports failing.
  await setFakeCollectorState(organizationId, collector.id, {
    effective: { sha256: "a".repeat(64), status: "failed", error: applyError },
  });
  await recordFakeCollectorError(organizationId, collector.id, { message: firstError, reportedAt: new Date(Date.now() - 120_000) });
  await recordFakeCollectorError(organizationId, collector.id, { message: secondError, reportedAt: new Date(Date.now() - 60_000) });
  await openCollectors(page, fleetId);

  // Status its liveness (just enrolled: Online), Configuration its sync, Last seen plain text with no dot.
  const status = collectorRow(page, name).locator("td").nth(5).locator("[tabindex='0']");
  await expect(status).toHaveText("Online (online: seen in the last minute)");
  await status.hover();
  await expect(page.getByRole("tooltip")).toHaveText("online: seen in the last minute");
  await expect(collectorRow(page, name).locator("td").nth(6)).toHaveText(/^Nothing assigned \(nothing assigned: no pin, /);
  await expect(collectorRow(page, name).locator("td").nth(8).locator("[aria-hidden='true']")).toHaveCount(0);
  // Dismissed (Radix keeps a hovered tooltip open while the pointer may be on its way to it).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();

  // Nothing sent: the grid's Version dash says so on hover, a tooltip in fixed words.
  const version = collectorRow(page, name).locator("td").nth(7).locator("[tabindex='0']");
  await expect(version).toHaveText("— (Nothing sent yet: it runs its own file.)");
  await version.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Nothing sent yet: it runs its own file.");

  await collectorRow(page, name).getByRole("button", { name, exact: true }).click();
  const details = page.getByRole("dialog", { name });
  await expect(details).toContainText("Collector details");
  await expect(details).toContainText("192.168.1.7");
  // The Status row its liveness, the Configuration row its sync.
  const detailValue = (label: string) => details.getByText(label, { exact: true }).locator("xpath=following-sibling::div[1]");
  await expect(detailValue("Status")).toHaveText("OnlineSeen in the last minute.");
  await expect(detailValue("Configuration")).toContainText("Nothing assigned");
  await expect(details).toContainText(
    "No pin, and no published version on its group; it keeps running what it has: its own file, or the last published version it was sent.",
  );
  // Its Effective Version: a dash, its meaning under it.
  await expect(details).toContainText("—Nothing sent yet: it runs its own file.");
  await expect(details).not.toContainText(/import/i);
  await expect(details.getByRole("button", { name: "View YAML" })).toHaveCount(0);
  await expect(details.getByText(applyError)).toBeVisible();
  // The history, newest first.
  const history = details.locator("section", { has: page.getByRole("heading", { name: "Error history" }) });
  await expect(history.locator("pre")).toHaveText([secondError, firstError]);
  const attributes = details.locator("section", { has: page.getByRole("heading", { name: "Reported attributes" }) });
  await expect(attributes).toContainText("host.name");
  await expect(attributes).toContainText(attributeValue);

  // Each private text as text inside ph-no-capture only, in no attribute.
  expect(await placesOf(page, [attributeValue, firstError, secondError, applyError])).toEqual(
    [attributeValue, firstError, secondError, applyError].map(() => ({ inside: 1, outside: 0, inAttributes: 0 })),
  );
  // The name shows in the masked shell as text, in no attribute.
  expect((await placesOf(page, [name]))[0]!.inAttributes).toBe(0);

  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
});

test("edits a collector: a taken name refused; renamed, moved and pinned to a published version in one save; then unpinned", async ({
  page,
}) => {
  const { user, organizationId, fleetId } = await signedInWithFleet(page);
  const groupName = `moved-${unique()}`;
  const configurationName = `edge-config-${unique()}`;
  const group = await createGroupThroughApi(page, organizationId, fleetId, groupName);
  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  const edited = await enrollFakeCollector(organizationId, fleetId, { name: "edit-me" });
  await enrollFakeCollector(organizationId, fleetId, { name: "taken-name" });
  await openCollectors(page, fleetId);

  await page.getByRole("button", { name: "Edit edit-me", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit collector" });
  const nameField = dialog.getByRole("textbox", { name: "Name" });
  await expect(nameField).toHaveValue("edit-me");
  await expect(dialog.getByRole("button", { name: "OK" })).toBeDisabled();

  // A name another collector holds: refused under the Name, the dialog open.
  await nameField.fill("taken-name");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(NAME_TAKEN);
  await expect(nameField).toHaveAttribute("aria-invalid", "true");

  // Renamed, moved and pinned: one PATCH.
  await nameField.fill("edited");
  await choose(page, dialog, "Group", groupName);
  await choose(page, dialog, "Pin", "A published version");
  await choose(page, dialog, "Configuration", configurationName);
  await expect(dialog.getByRole("combobox", { name: "Version" })).toHaveText(/@v1/);
  await expect(dialog.getByText("It is sent this configuration on its next poll.")).toBeVisible();
  const patches: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && COLLECTOR_PATH.test(new URL(request.url()).pathname)) patches.push(request);
  });
  const reloaded = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(page.getByText("Collector updated")).toBeVisible();
  await expect(dialog).toBeHidden();
  await reloaded;
  expect(patches.map((request) => request.postDataJSON() as unknown)).toEqual([
    { name: "edited", groupId: group.id, pin: { kind: "version", versionId } },
  ]);
  await expect(collectorRow(page, "edited")).toContainText(groupName);
  await expect(collectorRow(page, "edit-me")).toHaveCount(0);
  expect(await collectorThroughApi(page, organizationId, fleetId, edited.id)).toMatchObject({
    name: "edited",
    groupId: group.id,
    pin: { kind: "version", versionId },
  });

  // Unpinned: "Follow the group".
  await page.getByRole("button", { name: "Edit edited", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Pin" })).toHaveText("A published version");
  await choose(page, dialog, "Pin", "Follow the group");
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await collectorThroughApi(page, organizationId, fleetId, edited.id)).pin).toBeNull();
  // Exactly one more PATCH: the unpin, null.
  expect(patches.map((request) => request.postDataJSON() as unknown)).toEqual([
    { name: "edited", groupId: group.id, pin: { kind: "version", versionId } },
    { pin: null },
  ]);
});

test("deletes a collector's record from its row", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  await enrollFakeCollector(organizationId, fleetId, { name: "doomed" });
  const kept = await enrollFakeCollector(organizationId, fleetId, { name: "kept" });
  await openCollectors(page, fleetId);

  await page.getByRole("button", { name: "Delete doomed", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete collector record" });
  await expect(dialog).toContainText("You are deleting the record of doomed. If the collector keeps polling, it enrolls again as a new collector");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted record for doomed")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(collectorRow(page, "doomed")).toHaveCount(0);
  await expect(collectorRow(page, "kept")).toBeVisible();
  expect((await collectorsThroughApi(page, organizationId, fleetId)).map((each) => each.id)).toEqual([kept.id]);
});

test("pins the selected collectors to a published version in one request", async ({ page }) => {
  const { user, organizationId, fleetId } = await signedInWithFleet(page);
  const configurationName = `bulk-config-${unique()}`;
  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  const [first, second, third] = await enrollCollectors(organizationId, fleetId, "bulk", 3);
  await openCollectors(page, fleetId);

  await page.getByRole("checkbox", { name: "Select bulk-000" }).click();
  await page.getByRole("checkbox", { name: "Select bulk-001" }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Pin selected collectors" }).click();
  const dialog = page.getByRole("dialog", { name: "Pin collectors" });
  // Both choices start at "Leave as is": Pin waits until one moves.
  await expect(dialog.getByRole("button", { name: "Pin 2" })).toBeDisabled();
  await choose(page, dialog, "Published version", "A published version");
  await choose(page, dialog, "Configuration", configurationName);
  await expect(dialog.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
  const pins: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/collectors/pin")) pins.push(request);
  });
  const reloaded = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await dialog.getByRole("button", { name: "Pin 2" }).click();
  await expect(page.getByText("Pinned 2 collectors.", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await reloaded;
  // Exactly one request for both, in the grid's order (newest first; collectors enrolled within one millisecond tie, broken by id).
  expect(pins).toHaveLength(1);
  const sent = pins[0]!.postDataJSON() as { collectorIds: string[]; pin: unknown };
  // The variable group left as is: no field for it.
  expect(Object.keys(sent).sort()).toEqual(["collectorIds", "pin"]);
  expect(sent.pin).toEqual({ kind: "version", versionId });
  expect([...sent.collectorIds].sort()).toEqual([first!.id, second!.id].sort());

  const held = await Promise.all([first!, second!, third!].map(async (each) => (await collectorThroughApi(page, organizationId, fleetId, each.id)).pin));
  expect(held).toEqual([
    expect.objectContaining({ kind: "version", versionId }),
    expect.objectContaining({ kind: "version", versionId }),
    null,
  ]);
});

test("moves the selected collectors one at a time, waiting out a 429's Retry-After and trying that collector again", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const groupName = `destination-${unique()}`;
  const group = await createGroupThroughApi(page, organizationId, fleetId, groupName);
  const enrolled = await enrollCollectors(organizationId, fleetId, "mover", 3);
  await openCollectors(page, fleetId);

  // The collectors' PATCH only (bulk pin's POST …/collectors/pin matches the path too): the first answered 429, retry after 1 s.
  // Each PATCH's time as the route sees it: the retry must come after the Retry-After, not at once.
  const patches: Array<{ collectorId: string; body: unknown; at: number }> = [];
  let limited = false;
  await page.route(
    (url) => COLLECTOR_PATH.test(url.pathname),
    async (route) => {
      const request = route.request();
      if (request.method() !== "PATCH") return route.fallback();
      patches.push({ collectorId: new URL(request.url()).pathname.split("/").at(-1)!, body: request.postDataJSON() as unknown, at: Date.now() });
      if (limited) return route.fallback();
      limited = true;
      return route.fulfill({
        status: 429,
        headers: { "retry-after": "1" },
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "rate_limited", message: "Too many attempts. Please wait and try again." } }),
      });
    },
  );

  await page.getByRole("checkbox", { name: "Select all on this page" }).click();
  await expect(page.getByText("3 selected")).toBeVisible();
  await page.getByRole("button", { name: "Move to group" }).click();
  const dialog = page.getByRole("dialog", { name: "Move collectors" });
  await choose(page, dialog, "Group", groupName);
  await dialog.getByRole("button", { name: "Move 3" }).click();
  // The wait shows while the 429's Retry-After runs.
  await expect(dialog.getByText("Moving 1 of 3… (waiting 1 second: too many requests)")).toBeVisible();
  await expect(dialog.getByText("Moved 3")).toBeVisible();

  // Four PATCHes: the first collector's twice (the 429, then its retry), then each other's once.
  // The grid's order (its default: newest first), as the run sends them.
  const idOf = new Map(enrolled.map((each) => [each.name, each.id]));
  const order = (await shownNames(page)).map((name) => idOf.get(name));
  expect(patches.map((each) => each.collectorId)).toEqual([order[0], order[0], order[1], order[2]]);
  expect(patches.map((each) => each.body)).toEqual(Array(4).fill({ groupId: group.id }));
  // The retry came once the Retry-After's second had passed (probed: 1,004–1,019 ms; 13 ms when not waited out).
  expect(patches[1]!.at - patches[0]!.at).toBeGreaterThanOrEqual(950);

  const reloaded = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
  for (const each of ["mover-000", "mover-001", "mover-002"]) await expect(collectorRow(page, each)).toContainText(groupName);
  expect((await collectorsThroughApi(page, organizationId, fleetId)).map((each) => each.groupId)).toEqual(Array(3).fill(group.id));
});

test("deletes the selected collectors one at a time, then closes on Close", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const [kept] = await enrollCollectors(organizationId, fleetId, "batch", 3);
  await openCollectors(page, fleetId);

  await page.getByRole("checkbox", { name: "Select batch-001" }).click();
  await page.getByRole("checkbox", { name: "Select batch-002" }).click();
  // The selection bar's Delete (the header's deletes the fleet).
  await page.getByRole("button", { name: "Delete selected collectors" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete collectors" });
  await expect(dialog).toContainText("You are deleting the records of 2 collectors. If a collector keeps polling");
  await dialog.getByRole("button", { name: "Delete 2" }).click();
  await expect(dialog.getByText("Deleted 2")).toBeVisible();
  const reloaded = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
  await expectNames(page, ["batch-000"]);
  expect((await collectorsThroughApi(page, organizationId, fleetId)).map((each) => each.id)).toEqual([kept!.id]);
});

test("a contributor renames a collector of the group's fleet", async ({ page }) => {
  const admin = await seedUser({ password: PASSWORD });
  const contributor = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId });
  await addMember({ userId: contributor.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, contributor);
  await switchOrganizationThroughApi(page, group.organizationId);
  const { fleet } = await createServerFleetThroughApi(page, group.organizationId);
  const collector = await enrollFakeCollector(group.organizationId, fleet.id, { name: "team-collector" });
  await openCollectors(page, fleet.id);

  await page.getByRole("button", { name: "Edit team-collector", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit collector" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("team-collector-renamed");
  const patched = page.waitForResponse((response) => response.request().method() === "PATCH" && COLLECTOR_PATH.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "OK" }).click();
  const response = await patched;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).pathname).toBe(`${collectorsApiPath(group.organizationId, fleet.id)}/${collector.id}`);
  await expect(page.getByText("Collector updated")).toBeVisible();
  await expect(collectorRow(page, "team-collector-renamed")).toBeVisible();
});

/** The grid's Variable group cell of the collector named `name`: the pin's, else its group's, else "Organization values". */
function variableGroupCell(page: Page, name: string): Locator {
  return collectorRow(page, name).locator("td").nth(4);
}

// The Pin's Variable group, in its dialog, the column, the details' rows and the values dialog.
test("the Pin's Variable group: Follow group by default; one chosen is sent alone and wins over the group's in the grid, the details and the values; Follow group sends null", async ({
  page,
}) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const token = unique();
  const endpoint = uniqueVariableName("ENDPOINT");
  const region = uniqueVariableName("REGION");
  const endpointValue = canaryVariableValue(`endpoint-${token}`);
  const regionValue = canaryVariableValue(`region-${token}`);
  const groupValue = canaryVariableValue(`group-${token}`);
  const pinnedValue = canaryVariableValue(`pinned-${token}`);
  const endpointVariable = await createVariableThroughApi(page, organizationId, endpoint, endpointValue);
  await createVariableThroughApi(page, organizationId, region, regionValue);
  const groupVariables = await createVariableGroupThroughApi(page, organizationId, `eu-edge-${token}`);
  const pinnedVariables = await createVariableGroupThroughApi(page, organizationId, `pinned-${token}`);
  await setOverrideThroughApi(page, organizationId, groupVariables.id, endpointVariable.id, groupValue);
  await setOverrideThroughApi(page, organizationId, pinnedVariables.id, endpointVariable.id, pinnedValue);
  const group = await createGroupThroughApi(page, organizationId, fleetId, `eu-${token}`, { variableGroupId: groupVariables.id });
  const pinned = await enrollFakeCollector(organizationId, fleetId, { name: "eu-collector", groupId: group.id });
  await enrollFakeCollector(organizationId, fleetId, { name: "default-collector" });
  await openCollectors(page, fleetId);
  await expect(page.getByRole("columnheader", { name: "Variable group", exact: true })).toBeVisible();
  await expect(variableGroupCell(page, "eu-collector")).toHaveText(groupVariables.name);
  await expect(variableGroupCell(page, "default-collector")).toHaveText("Organization values");
  const patches: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && COLLECTOR_PATH.test(new URL(request.url()).pathname)) patches.push(request);
  });

  // The Pin's choice starts at its group's: "Follow group (eu-edge-…)", then the variable groups.
  await page.getByRole("button", { name: "Edit eu-collector", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit collector" });
  const select = dialog.getByRole("combobox", { name: "Variable group", exact: true });
  await expect(select).toHaveText(`Follow group (${groupVariables.name})`);
  await expect(dialog.getByRole("button", { name: "OK" })).toBeDisabled();
  await select.click();
  await expect(page.getByRole("option")).toHaveText([`Follow group (${groupVariables.name})`, groupVariables.name, pinnedVariables.name]);
  await page.getByRole("option", { name: pinnedVariables.name, exact: true }).click();
  expect((await placesOf(page, [groupVariables.name, pinnedVariables.name])).map((each) => each.inAttributes)).toEqual([0, 0]);
  const reloaded = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(page.getByText("Collector updated")).toBeVisible();
  await expect(dialog).toBeHidden();
  await reloaded;
  // Only what changed: the pinned variable group.
  expect(patches.map((request) => request.postDataJSON() as unknown)).toEqual([{ pinnedVariableGroupId: pinnedVariables.id }]);
  expect((await collectorThroughApi(page, organizationId, fleetId, pinned.id)).pinnedVariableGroupId).toBe(pinnedVariables.id);
  // The pin's wins over the group's.
  await expect(variableGroupCell(page, "eu-collector")).toHaveText(pinnedVariables.name);
  await expect(variableGroupCell(page, "default-collector")).toHaveText("Organization values");

  // The details: the pinned one, and the effective one, which opens each variable's value and where it comes from.
  await collectorRow(page, "eu-collector").getByRole("button", { name: "eu-collector", exact: true }).click();
  const details = page.getByRole("dialog", { name: "eu-collector" });
  const detailValue = (label: string) => details.getByText(label, { exact: true }).locator("xpath=following-sibling::div[1]");
  await expect(detailValue("Pinned variable group")).toHaveText(pinnedVariables.name);
  await expect(detailValue("Variable group")).toHaveText(pinnedVariables.name);
  await detailValue("Variable group").getByRole("button", { name: pinnedVariables.name, exact: true }).click();
  const values = page.getByRole("dialog", { name: "Variable values" });
  // A level's row (a term and its value); its words are also a value's source, so the term is found as a term.
  const levelValue = (label: string) => values.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
  await expect(levelValue("Pinned variable group")).toHaveText(pinnedVariables.name);
  await expect(levelValue("Group's variable group")).toHaveText(groupVariables.name);
  const valueRow = (variable: string) => values.getByRole("row").filter({ has: page.getByText(variable, { exact: true }) });
  await expect(valueRow(endpoint).locator("code")).toHaveText(pinnedValue);
  await expect(valueRow(endpoint).getByRole("cell").nth(2)).toHaveText("Pinned variable group");
  await expect(valueRow(region).locator("code")).toHaveText(regionValue);
  await expect(valueRow(region).getByRole("cell").nth(2)).toHaveText("Organization value");
  // The values as text inside ph-no-capture only; the group's override, overridden by the pin's, nowhere.
  expect(await placesOf(page, [pinnedValue, regionValue, groupValue, endpointValue])).toEqual([
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
  ]);
  await page.keyboard.press("Escape");
  await expect(values).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // Follow group again: null, alone.
  await page.getByRole("button", { name: "Edit eu-collector", exact: true }).click();
  await expect(select).toHaveText(pinnedVariables.name);
  await choose(page, dialog, "Variable group", `Follow group (${groupVariables.name})`);
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(dialog).toBeHidden();
  await expect(variableGroupCell(page, "eu-collector")).toHaveText(groupVariables.name);
  expect(patches.map((request) => request.postDataJSON() as unknown)).toEqual([{ pinnedVariableGroupId: pinnedVariables.id }, { pinnedVariableGroupId: null }]);
  expect((await collectorThroughApi(page, organizationId, fleetId, pinned.id)).pinnedVariableGroupId).toBeNull();
});

// The bulk pin's two choices, both starting at "Leave as is"; its toasts.
test("the bulk pin's Version and Variable group both start at Leave as is: Pin waits; each sends only what moved, a follow as null, its toast naming what changed", async ({
  page,
}) => {
  const { user, organizationId, fleetId } = await signedInWithFleet(page);
  const token = unique();
  const variableGroup = await createVariableGroupThroughApi(page, organizationId, `bulk-values-${token}`);
  const configurationName = `bulk-vars-${token}`;
  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  const [first, second, third] = await enrollCollectors(organizationId, fleetId, "vg", 3);
  await openCollectors(page, fleetId);
  const pins: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/collectors/pin")) pins.push(request);
  });
  const dialog = page.getByRole("dialog", { name: "Pin collectors" });

  /** Selects the first two collectors and opens the bulk pin: both choices at Leave as is, Pin disabled. */
  const openBulkPin = async () => {
    for (const name of ["vg-000", "vg-001"]) await page.getByRole("checkbox", { name: `Select ${name}` }).check();
    await expect(page.getByText("2 selected")).toBeVisible();
    await page.getByRole("button", { name: "Pin selected collectors" }).click();
    await expect(dialog.getByRole("combobox", { name: "Published version", exact: true })).toHaveText("Leave as is");
    await expect(dialog.getByRole("combobox", { name: "Variable group", exact: true })).toHaveText("Leave as is");
    await expect(dialog.getByRole("button", { name: "Pin 2" })).toBeDisabled();
  };
  /** Pins, expecting `toast`; the request it sent, once the grid has read again. */
  const pin = async (toast: string) => {
    const reloaded = page.waitForResponse((response) => isCollectorsRead(response.request()));
    await dialog.getByRole("button", { name: "Pin 2" }).click();
    await expect(page.getByText(toast, { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    await reloaded;
    const sent = pins.at(-1)!.postDataJSON() as Record<string, unknown> & { collectorIds: string[] };
    expect([...sent.collectorIds].sort()).toEqual([first!.id, second!.id].sort());
    return sent;
  };
  const pinnedVariableGroups = async () =>
    Promise.all([first!, second!, third!].map(async (each) => (await collectorThroughApi(page, organizationId, fleetId, each.id)).pinnedVariableGroupId));

  // The variable group alone: no pin field.
  await openBulkPin();
  await choose(page, dialog, "Variable group", variableGroup.name);
  await expect(dialog.getByRole("button", { name: "Pin 2" })).toBeEnabled();
  const set = await pin("Variable group set on 2 collectors.");
  expect(Object.keys(set).sort()).toEqual(["collectorIds", "pinnedVariableGroupId"]);
  expect(set.pinnedVariableGroupId).toBe(variableGroup.id);
  expect(await pinnedVariableGroups()).toEqual([variableGroup.id, variableGroup.id, null]);
  await expect(variableGroupCell(page, "vg-000")).toHaveText(variableGroup.name);
  await expect(variableGroupCell(page, "vg-002")).toHaveText("Organization values");

  // Follow each collector's group: null.
  await openBulkPin();
  await choose(page, dialog, "Variable group", "Follow each collector's group");
  const followed = await pin("2 collectors follow their group's variable group.");
  expect(followed).toEqual({ collectorIds: expect.any(Array), pinnedVariableGroupId: null });
  expect(await pinnedVariableGroups()).toEqual([null, null, null]);
  await expect(variableGroupCell(page, "vg-000")).toHaveText("Organization values");

  // Both moved: the pin and the variable group, in one request.
  await openBulkPin();
  await choose(page, dialog, "Published version", "A published version");
  await choose(page, dialog, "Configuration", configurationName);
  await expect(dialog.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
  await choose(page, dialog, "Variable group", variableGroup.name);
  const both = await pin("Pin and variable group set on 2 collectors.");
  expect(both).toEqual({ collectorIds: expect.any(Array), pin: { kind: "version", versionId }, pinnedVariableGroupId: variableGroup.id });
  expect(pins).toHaveLength(3);
  expect(await pinnedVariableGroups()).toEqual([variableGroup.id, variableGroup.id, null]);
  expect((await collectorThroughApi(page, organizationId, fleetId, third!.id)).pin).toBeNull();

  // The Version alone to Follow each collector's group: the pin null, no variable group field; today's toast.
  await openBulkPin();
  await choose(page, dialog, "Published version", "Follow each collector's group");
  const unpinned = await pin("Unpinned 2 collectors.");
  expect(unpinned).toEqual({ collectorIds: expect.any(Array), pin: null });
  expect(Object.hasOwn(unpinned, "pinnedVariableGroupId")).toBe(false);
  expect(pins).toHaveLength(4);
  const after = await Promise.all([first!, second!].map((each) => collectorThroughApi(page, organizationId, fleetId, each.id)));
  expect(after.map((each) => [each.pin, each.pinnedVariableGroupId])).toEqual([
    [null, variableGroup.id],
    [null, variableGroup.id],
  ]);
});
