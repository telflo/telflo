import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request, type Response } from "@playwright/test";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type EnrollmentTokenRevealedResponse,
  type FleetCreatedResponse,
  type FleetsPage,
  type FleetType,
} from "@telflo/contracts";
import { expectBearersOnlyInNoCapture } from "./support/bearers.js";
import { addMember, seedUser, type SeededUser } from "./support/database.js";
import { enrollFakeCollector, setFakeCollectorState } from "./support/fake-opamp-server.js";
import { isGetOf, nextPoll } from "./support/polling.js";
import { signInThroughApi, switchOrganizationThroughApi, waitForHydration } from "./support/session.js";

// The fleet list and the fleet's page (D17a decision 30; Preflight rulings 6,
// 16 and 19), in the browser, against the E2E API and its fake
// opamp-server. Each test works in an organization of its own (a new user's,
// or a new group's), so tests and browsers run in parallel. Fleets the test
// isn't about creating are made through the API (`page.request`, the CSRF
// header set); the empty state needs none (the fake answers an organization
// it doesn't know 404, which the API answers as an empty page).
//
// Collectors are enrolled, and their last-seen time set, through the fake's
// control port (support/fake-opamp-server.ts). The list polls every 15 s:
// those tests drive the page's clock (`page.clock`, installed before the
// page loads, at the real now, since the fake runs on real time), advance
// it with `runFor`, one second at a time until the poll's request goes out,
// never `fastForward` (WebKit's skipped a guarded tick), and wait for the
// poll's response, not only its visible effect (`nextPoll`, support/polling.ts).
//
// A bearer is shown only inside `ph-no-capture` (replay records nothing of
// it), and is gone from the page once Done closes the dialog.

const PASSWORD = "correct horse battery staple";
/** The fleet list's path, whichever organization: its reads (GET) and the create (POST). */
const FLEETS_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets$/;
/** The list's poll: a read of the fleet list. */
const isFleetsPoll = isGetOf(FLEETS_PATH);
const REVEAL_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/tokens\/[^/]+\/reveal$/;
const LABEL_TAKEN = "Another of the organization's fleets has this label.";

/** A label no other test uses. */
function aLabel(prefix = "edge"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** A new user, signed in (still on whatever page is open). */
async function signedIn(page: Page): Promise<SeededUser> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  return user;
}

/** A full page load of `path`, hydrated. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForHydration(page);
}

/** A fleet made through the API, as the page's own create would: its 201 answer. */
async function createFleetThroughApi(
  page: Page,
  organizationId: string,
  label: string,
  type: FleetType = "server",
): Promise<FleetCreatedResponse> {
  const response = await page.request.post(`/api/v1/organizations/${organizationId}/fleets`, {
    data: { label, type, rotateExpiresAt: null },
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as FleetCreatedResponse;
}

/** Every fleet of the organization, read through the API (the first page is enough here). */
async function fleetsThroughApi(page: Page, organizationId: string): Promise<FleetsPage["fleets"]> {
  const response = await page.request.get(`/api/v1/organizations/${organizationId}/fleets`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as FleetsPage).fleets;
}

function isFleetsRead(response: Response): boolean {
  return response.request().method() === "GET" && FLEETS_PATH.test(new URL(response.url()).pathname);
}

function isCreate(request: Request): boolean {
  return request.method() === "POST" && FLEETS_PATH.test(new URL(request.url()).pathname);
}

/** The list's row for the fleet labelled `label`. */
function fleetRow(page: Page, label: string): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("link", { name: label, exact: true }) });
}

/** The list's filter: "All fleets", "Active" or "Archived". */
async function chooseFilter(page: Page, label: "All fleets" | "Active" | "Archived"): Promise<void> {
  const read = page.waitForResponse(isFleetsRead);
  await page.getByRole("combobox").filter({ hasText: /^(All fleets|Active|Archived)$/ }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await read;
}

/** Opens the type chooser from `opener` and picks a type: that type's create dialog. */
async function openCreateDialog(page: Page, opener: Locator, type: FleetType): Promise<Locator> {
  await opener.click();
  const chooser = page.getByRole("dialog", { name: "Create a new fleet" });
  await chooser.getByText(type === "server" ? "Linux servers & VMs" : "Kubernetes (Helm)", { exact: true }).click();
  await expect(chooser).toBeHidden();
  return page.getByRole("dialog", { name: type === "server" ? "New server fleet" : "New Kubernetes Supervisor Fleet" });
}

/** The tokens step of a create: both bearers shown, only in `ph-no-capture`. */
async function expectTokensShown(page: Page, bearers: string[]): Promise<Locator> {
  const created = page.getByRole("dialog", { name: "Fleet created" });
  await expect(created).toBeVisible();
  await expect(created).toContainText("Copy them now: this dialog won't show them again.");
  for (const bearer of bearers) await expect(created.locator(".ph-no-capture", { hasText: bearer })).toBeVisible();
  await expectBearersOnlyInNoCapture(page, bearers);
  return created;
}

/**
 * Copies a bearer with its button: read back from the clipboard where a
 * test may grant that (Chromium); elsewhere the button's "Copied", which
 * says the write succeeded.
 */
async function copyBearer(page: Page, browserName: string, button: Locator, bearer: string): Promise<void> {
  if (browserName === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await button.click();
  await expect(button).toHaveText("Copied");
  if (browserName === "chromium") expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe(bearer);
  await expect(page.getByText("Failed to copy to clipboard")).toHaveCount(0);
}

/** Done: the dialog closes on the fleet's page, and no bearer is left in the page. */
async function doneOnFleetPage(page: Page, created: Locator, fleetId: string, label: string, bearers: string[]): Promise<void> {
  await created.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleetId}`);
  await expect(page.getByRole("heading", { level: 1, name: label, exact: true })).toBeVisible();
  await expect(created).toBeHidden();
  const content = await page.content();
  for (const bearer of bearers) expect(content).not.toContain(bearer);
}

test("a new organization sees the first-run card, with New Fleet in the header and in the card", async ({ page }) => {
  await signedIn(page);
  await open(page, "/fleet-management");

  await expect(page.getByRole("heading", { name: "Create your first fleet" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Fleets" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Fleet" })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "editor" })).toHaveAttribute("href", "/app");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page).toHaveTitle("Fleets - Telflo");
});

test("creates a server fleet from the empty state: both bearers shown once in ph-no-capture, copied, gone after Done, which opens its page", async ({
  page,
  browserName,
}) => {
  const user = await signedIn(page);
  await open(page, "/fleet-management");
  const label = aLabel();

  const dialog = await openCreateDialog(page, page.getByRole("button", { name: "New Fleet" }).last(), "server");
  await dialog.getByLabel("Name").fill(label);
  const answered = page.waitForResponse((response) => isCreate(response.request()));
  await dialog.getByRole("button", { name: "Create fleet" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  const { fleet, tokens } = (await response.json()) as FleetCreatedResponse;
  expect(fleet).toMatchObject({ label, type: "server", status: "active" });
  expect(response.request().postDataJSON()).toEqual({ id: fleet.id, label, type: "server", rotateExpiresAt: null });
  const bearers = [tokens.default.bearer, tokens.rotate.bearer];

  const created = await expectTokensShown(page, bearers);
  await expect(page.getByText(`Fleet "${label}" created`)).toBeVisible();

  await copyBearer(page, browserName, created.getByRole("button", { name: "Copy default token" }), tokens.default.bearer);

  await doneOnFleetPage(page, created, fleet.id, label, bearers);
  await expect(page.getByText("Supervisor", { exact: true })).toBeVisible();

  // Listed, once.
  await page.getByRole("link", { name: "Fleets", exact: true }).first().click();
  await expect(fleetRow(page, label)).toHaveCount(1);
  await expect(fleetRow(page, label)).toContainText("Supervisor");
  expect((await fleetsThroughApi(page, user.organizationId)).map((each) => each.id)).toEqual([fleet.id]);
});

test("creates a Kubernetes Supervisor fleet from the header, its bearers shown once, and Done opens its page", async ({
  page,
  browserName,
}) => {
  const user = await signedIn(page);
  const existing = await createFleetThroughApi(page, user.organizationId, aLabel("existing"));
  await open(page, "/fleet-management");
  await expect(fleetRow(page, existing.fleet.label)).toBeVisible();
  const label = aLabel("cluster");

  // The header's New Fleet: the only one once a fleet is listed.
  await expect(page.getByRole("button", { name: "New Fleet" })).toHaveCount(1);
  const dialog = await openCreateDialog(page, page.getByRole("button", { name: "New Fleet" }), "kubernetes-supervisor");
  // No Token expiry for this type.
  await expect(dialog.getByLabel("Token expiry")).toHaveCount(0);
  await dialog.getByLabel("Name").fill(label);
  const answered = page.waitForResponse((response) => isCreate(response.request()));
  await dialog.getByRole("button", { name: "Create fleet" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  const { fleet, tokens } = (await response.json()) as FleetCreatedResponse;
  expect(fleet).toMatchObject({ label, type: "kubernetes-supervisor" });
  const bearers = [tokens.default.bearer, tokens.rotate.bearer];

  const created = await expectTokensShown(page, bearers);
  await copyBearer(page, browserName, created.getByRole("button", { name: "Copy rotate token" }), tokens.rotate.bearer);

  await doneOnFleetPage(page, created, fleet.id, label, bearers);
  await expect(page.getByText("K8s Supervisor", { exact: true })).toBeVisible();
});

test("a create whose reply is lost is retried with the same id: the API answers 200, both bearers are revealed, and there is one fleet", async ({
  page,
}) => {
  const user = await signedIn(page);
  await open(page, "/fleet-management");
  const label = aLabel();

  // The first create reaches the API (the fleet is made), and its reply is lost.
  const creates: Request[] = [];
  let lost = false;
  // The lost reply's status, kept here and asserted in the test's own flow, not inside the handler.
  let lostStatus: number | undefined;
  await page.route((url) => FLEETS_PATH.test(url.pathname), async (route) => {
    if (!isCreate(route.request())) return route.fallback();
    creates.push(route.request());
    if (lost) return route.fallback();
    lost = true;
    const made = await route.fetch();
    lostStatus = made.status();
    await route.abort("failed");
  });

  const dialog = await openCreateDialog(page, page.getByRole("button", { name: "New Fleet" }).first(), "server");
  await dialog.getByLabel("Name").fill(label);
  await dialog.getByRole("button", { name: "Create fleet" }).click();
  await expect(dialog).toContainText("The fleet may or may not have been created. Trying again won't make a second one.");
  await expect(dialog.getByLabel("Name")).toBeDisabled();
  expect(lostStatus).toBe(201);

  // The retry's reveals, as they answer.
  const reveals: Response[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "POST" && REVEAL_PATH.test(new URL(response.url()).pathname)) reveals.push(response);
  });
  const retried = page.waitForResponse((response) => isCreate(response.request()));
  await dialog.getByRole("button", { name: "Try again" }).click();
  expect((await retried).status()).toBe(200);
  const created = page.getByRole("dialog", { name: "Fleet created" });
  await expect(created).toBeVisible();

  expect(creates).toHaveLength(2);
  const [first, second] = creates.map((request) => request.postDataJSON() as { id: string; label: string; type: string });
  expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).toEqual(first);

  const fleets = await fleetsThroughApi(page, user.organizationId);
  expect(fleets.map((each) => ({ id: each.id, label: each.label }))).toEqual([{ id: first?.id, label }]);

  // Both of its tokens, revealed afresh: the bearers the reveals answered, shown once in ph-no-capture.
  expect(reveals.map((response) => response.status())).toEqual([200, 200]);
  const revealed = await Promise.all(reveals.map((response) => response.json() as Promise<EnrollmentTokenRevealedResponse>));
  expect(revealed.map((each) => each.token.kind).sort()).toEqual(["default", "rotate"]);
  const bearers = revealed.map((each) => each.token.bearer);
  await expectTokensShown(page, bearers);
  await doneOnFleetPage(page, created, first!.id, label, bearers);
});

test("renames a fleet from its row: a label another fleet holds is refused under the Name, then a free one is listed", async ({ page }) => {
  const user = await signedIn(page);
  const taken = aLabel("taken");
  const label = aLabel();
  await createFleetThroughApi(page, user.organizationId, taken);
  await createFleetThroughApi(page, user.organizationId, label);
  await open(page, "/fleet-management");
  await expect(fleetRow(page, label)).toBeVisible();

  await page.getByRole("button", { name: `Rename ${label}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename fleet" });
  const name = dialog.getByLabel("Name");
  await expect(name).toHaveValue(label);
  await name.fill(taken);
  await dialog.getByRole("button", { name: "Save" }).click();
  // Under the field, the dialog open, nothing renamed.
  await expect(dialog.getByRole("alert")).toHaveText(LABEL_TAKEN);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toBeVisible();

  const renamed = aLabel("renamed");
  await name.fill(renamed);
  const reloaded = page.waitForResponse(isFleetsRead);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await reloaded;
  await expect(fleetRow(page, renamed)).toBeVisible();
  await expect(fleetRow(page, label)).toHaveCount(0);
  await expect(fleetRow(page, taken)).toBeVisible();
  expect((await fleetsThroughApi(page, user.organizationId)).map((each) => each.label).sort()).toEqual([renamed, taken].sort());
});

test("archives a fleet from its row, the filter shows Active and Archived apart, and unarchives it; deletes another from its row", async ({
  page,
}) => {
  const user = await signedIn(page);
  const kept = aLabel("kept");
  const archived = aLabel("archived");
  const doomed = aLabel("doomed");
  for (const label of [kept, archived, doomed]) await createFleetThroughApi(page, user.organizationId, label);
  await open(page, "/fleet-management");
  await expect(fleetRow(page, doomed)).toBeVisible();
  await expect(page.getByRole("combobox").filter({ hasText: /^(All fleets|Active|Archived)$/ })).toHaveText("All fleets");

  // Archive.
  await page.getByRole("button", { name: `Archive ${archived}`, exact: true }).click();
  const archiveDialog = page.getByRole("alertdialog", { name: "Archive fleet" });
  await expect(archiveDialog).toContainText(`Archive ${archived}?`);
  await archiveDialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(archiveDialog).toBeHidden();
  await expect(fleetRow(page, archived).getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Unarchive ${archived}`, exact: true })).toBeVisible();

  // The filter.
  await chooseFilter(page, "Active");
  await expect(fleetRow(page, kept)).toBeVisible();
  await expect(fleetRow(page, doomed)).toBeVisible();
  await expect(fleetRow(page, archived)).toHaveCount(0);
  await chooseFilter(page, "Archived");
  await expect(fleetRow(page, archived)).toBeVisible();
  await expect(page.getByRole("link", { name: /^(kept|doomed)-/ })).toHaveCount(0);

  // Unarchive, from the Archived filter: it leaves it.
  await page.getByRole("button", { name: `Unarchive ${archived}`, exact: true }).click();
  const unarchiveDialog = page.getByRole("alertdialog", { name: "Unarchive fleet" });
  await unarchiveDialog.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(unarchiveDialog).toBeHidden();
  await expect(page.getByText("No archived fleets.")).toBeVisible();
  await chooseFilter(page, "Active");
  await expect(fleetRow(page, archived)).toBeVisible();
  await expect(fleetRow(page, archived).getByText("Archived", { exact: true })).toHaveCount(0);

  // Delete, from the list.
  await page.getByRole("button", { name: `Delete ${doomed}`, exact: true }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: "Delete fleet" });
  await expect(deleteDialog).toContainText(`You are permanently deleting ${doomed}.`);
  await deleteDialog.getByRole("button", { name: "Delete fleet" }).click();
  await expect(deleteDialog).toBeHidden();
  await expect(page.getByText(`Deleted fleet ${doomed}`)).toBeVisible();
  await expect(fleetRow(page, doomed)).toHaveCount(0);
  await expect(fleetRow(page, kept)).toBeVisible();
  const left = await fleetsThroughApi(page, user.organizationId);
  expect(left.map((each) => ({ label: each.label, status: each.status })).sort((a, b) => a.label.localeCompare(b.label))).toEqual(
    [
      { label: archived, status: "active" },
      { label: kept, status: "active" },
    ].sort((a, b) => a.label.localeCompare(b.label)),
  );
});

test("a collector enrolled through the control port appears within one poll, and Last Seen follows its last-seen time", async ({ page }) => {
  const user = await signedIn(page);
  const label = aLabel();
  const { fleet } = await createFleetThroughApi(page, user.organizationId, label);
  // The page's clock, at the real now (the fake's): installed before the page loads.
  await page.clock.install();
  await open(page, "/fleet-management");
  const row = fleetRow(page, label);
  await expect(row.getByText("No collectors")).toHaveCount(2);
  await expect(row.getByRole("cell").nth(5)).toHaveText("—");

  const collector = await enrollFakeCollector(user.organizationId, fleet.id);
  // A snapshot before the poll: the page doesn't read the collector until it.
  expect(await row.getByText("No collectors").count()).toBe(2);
  await nextPoll(page, isFleetsPoll);
  await expect(row.getByText("1/1")).toBeVisible();
  await expect(row.getByText("No collectors")).toHaveCount(0);
  await expect(row.getByRole("cell").nth(5)).toHaveText(/^\d+ seconds? ago$/);

  // Last seen three minutes before the page's now, as the next poll reads it.
  const pageNow = await page.evaluate<number>("Date.now()");
  await setFakeCollectorState(user.organizationId, collector.id, { lastSeenAt: new Date(pageNow - 3 * 60_000) });
  await nextPoll(page, isFleetsPoll);
  await expect(row.getByRole("cell").nth(5)).toHaveText("3 minutes ago");
});

test("the fleet's page: its header, its tabs in ?tab=, and Fleet not found for an id it can't have, with no request for a malformed one", async ({
  page,
}) => {
  const user = await signedIn(page);
  const label = aLabel();
  const { fleet } = await createFleetThroughApi(page, user.organizationId, label);

  // From the list, by the fleet's link.
  await open(page, "/fleet-management");
  await page.getByRole("link", { name: label, exact: true }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}`);
  await expect(page.getByRole("heading", { level: 1, name: label, exact: true })).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Fleet - Telflo");
  await expect(page.getByRole("tab", { name: "Collectors" })).toHaveAttribute("aria-selected", "true");
  // A server fleet's Collectors tab (D17b-1): an empty fleet's install state (D17c-1); its Groups tab (D17b-2) its groups.
  await expect(page.getByRole("tabpanel").getByText("Install your first collector")).toBeVisible();

  await page.getByRole("tab", { name: "Groups" }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}?tab=groups`);
  await expect(page.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").getByRole("button", { name: "New group" })).toBeVisible();
  await page.getByRole("tab", { name: "Tokens" }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}?tab=tokens`);
  await expect(page.getByRole("tab", { name: "Tokens" })).toHaveAttribute("aria-selected", "true");

  // One entry per click: Back returns to Groups, then to the page as it opened.
  await page.goBack();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}?tab=groups`);
  await expect(page.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}`);
  await expect(page.getByRole("tab", { name: "Collectors" })).toHaveAttribute("aria-selected", "true");

  // Collectors deletes the param.
  await page.getByRole("tab", { name: "Tokens" }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}?tab=tokens`);
  await expect(page.getByRole("tab", { name: "Tokens" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Collectors" }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}`);
  await expect(page.getByRole("tab", { name: "Collectors" })).toHaveAttribute("aria-selected", "true");

  // The strip's Token tile links to the Tokens tab (D17b-2 decision 22): the fleet's tokens.
  await page.getByRole("link", { name: "Never (open the Tokens tab)", exact: true }).click();
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}?tab=tokens`);
  await expect(page.getByRole("tab", { name: "Tokens" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Fleet tokens" })).toBeVisible();
  await expect(page.getByRole("tabpanel").getByRole("button", { name: "Reveal the default token" })).toBeVisible();

  // A full load at a tab; an unknown one is dropped.
  await open(page, `/fleet-management/${fleet.id}?tab=groups`);
  await expect(page.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  await open(page, `/fleet-management/${fleet.id}?tab=settings`);
  await expect(page).toHaveURL(`/fleet-management/${fleet.id}`);
  await expect(page.getByRole("tab", { name: "Collectors" })).toHaveAttribute("aria-selected", "true");

  // An id the organization doesn't have: read, and not found.
  await open(page, `/fleet-management/${randomUUID()}`);
  await expect(page.getByRole("heading", { name: "Fleet not found" })).toBeVisible();

  // A malformed id: not found, and never sent.
  const sent: string[] = [];
  page.on("request", (request) => sent.push(request.url()));
  await open(page, "/fleet-management/not-a-uuid");
  await expect(page.getByRole("heading", { name: "Fleet not found" })).toBeVisible();
  await expect(page.getByText("It may have been deleted, or you may not have access.")).toBeVisible();
  // No fleet read reached the API, the malformed id's least of all (the page and its route's manifest name it, as they must).
  const apiRequests = sent.map((url) => new URL(url)).filter((url) => url.pathname.startsWith("/api/"));
  expect(apiRequests.filter((url) => url.href.includes("not-a-uuid"))).toEqual([]);
  expect(apiRequests.filter((url) => /^\/api\/v1\/organizations\/[^/]+\/fleets\//.test(url.pathname))).toEqual([]);
  await page.getByRole("link", { name: "Fleets", exact: true }).first().click();
  await expect(page).toHaveURL("/fleet-management");
});

test("a contributor creates a fleet in the group and deletes it from the fleet's page", async ({ page }) => {
  const admin = await seedUser({ password: PASSWORD });
  const contributor = await seedUser({ password: PASSWORD });
  const group = await addMember({ userId: admin.userId });
  await addMember({ userId: contributor.userId, organizationId: group.organizationId, role: "contributor" });
  await signInThroughApi(page, contributor);
  await switchOrganizationThroughApi(page, group.organizationId);
  await open(page, "/fleet-management");
  await expect(page.getByRole("heading", { name: "Create your first fleet" })).toBeVisible();
  const label = aLabel();

  const dialog = await openCreateDialog(page, page.getByRole("button", { name: "New Fleet" }).first(), "server");
  await dialog.getByLabel("Name").fill(label);
  const answered = page.waitForResponse((response) => isCreate(response.request()));
  await dialog.getByRole("button", { name: "Create fleet" }).click();
  const response = await answered;
  expect(response.status()).toBe(201);
  expect(new URL(response.url()).pathname).toBe(`/api/v1/organizations/${group.organizationId}/fleets`);
  const { fleet, tokens } = (await response.json()) as FleetCreatedResponse;
  const created = await expectTokensShown(page, [tokens.default.bearer, tokens.rotate.bearer]);
  await doneOnFleetPage(page, created, fleet.id, label, [tokens.default.bearer, tokens.rotate.bearer]);

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: "Delete fleet" });
  await deleteDialog.getByRole("button", { name: "Delete fleet" }).click();
  // Back on the list, empty again.
  await expect(page).toHaveURL("/fleet-management");
  await expect(page.getByText(`Deleted fleet ${label}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create your first fleet" })).toBeVisible();
  expect(await fleetsThroughApi(page, group.organizationId)).toEqual([]);
});
