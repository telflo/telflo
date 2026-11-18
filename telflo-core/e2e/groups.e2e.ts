import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import type { CollectorGroup } from "@telflo/contracts";
import {
  collectorsThroughApi,
  collectorThroughApi,
  createGroupThroughApi,
  createServerFleetThroughApi,
  enrollCollectors,
  pinThroughApi,
  publishedConfiguration,
} from "./support/collectors.js";
import { seedUser, type SeededUser } from "./support/database.js";
import { enrollFakeCollector } from "./support/fake-opamp-server.js";
import { isGetOf, nextPoll } from "./support/polling.js";
import { attributeHoldersOf, canaryVariableValue, placesOf } from "./support/privacy.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";
import { createVariableGroupThroughApi, createVariableThroughApi, setOverrideThroughApi, uniqueVariableName } from "./support/variables.js";

// A server fleet's Groups tab (D17b-2 decision 35; Preflight ruling 16), in
// the browser, against the E2E API and its fake opamp-server. Each test works
// in an organization of its own (a new user's), so tests and browsers run in
// parallel. Fleets, groups and published versions are made through the API
// as the page's session (support/collectors.ts), collectors through the
// fake's control port, before the page reads them, but for the group made
// while the page polls: that test drives the page's clock (`nextPoll`,
// support/polling.ts). What reaches a collector is read back through the
// API: its `resolution` (its pin, else its group's published version).

const PASSWORD = "correct horse battery staple";
/** The fleet's groups: the tab's reads and polls (GET) and the create (POST). */
const GROUPS_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/groups$/;
/** One group's path: its PATCH and its DELETE. */
const GROUP_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/groups\/[^/]+$/;
const isGroupsRead = isGetOf(GROUPS_PATH);
const NAME_TAKEN = "Another of the fleet's collector groups has this name.";
const HINT_VERSION = "The group's collectors that aren't pinned are sent this version on their next poll; pinned ones keep their pin.";
const HINT_NOTHING =
  "Releases the published version (e.g. to delete its configuration). Collectors keep running what they have; new installs need a published version.";
const DEFAULT_DESCRIPTION =
  "Change the group's published version, its variable group or its mounts. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.";
/** D17d-1 decision 25's words, conditional since Ruling 56 (both fleet types; a server fleet's without the Helm release's). */
const DELETE_CONSEQUENCES =
  "This deletes the group and its collectors' records. A collector installed into it that is still running keeps the configuration it has, but the fleet refuses its connections from then on: uninstall it, or reinstall it into another group. A collector moved into it from another group rejoins the group it was installed into.";
/** The typed-name input's label: the group's name, bold, between the words (Ruling 70, the owner's Q50). */
const deleteConfirmLabel = (name: string) => `Type ${name} to confirm`;

/** A suffix no other test uses. */
const unique = () => randomUUID().slice(0, 8);

interface FleetSetup {
  user: SeededUser;
  organizationId: string;
  fleetId: string;
  defaultGroupId: string;
}

/** A new user, signed in, with a server fleet of their organization. */
async function signedInWithFleet(page: Page): Promise<FleetSetup> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const { fleet, defaultGroup } = await createServerFleetThroughApi(page, user.organizationId);
  return { user, organizationId: user.organizationId, fleetId: fleet.id, defaultGroupId: defaultGroup.id };
}

/** The fleet's page at its Groups tab, hydrated, the tab's first read of its groups answered. */
async function openGroups(page: Page, fleetId: string): Promise<void> {
  const read = page.waitForResponse((response) => isGroupsRead(response.request()));
  await page.goto(`/fleet-management/${fleetId}?tab=groups`);
  await waitForHydration(page);
  expect((await read).status()).toBe(200);
}

/** The tab's rows: the table's rows holding cells (the header's hold column headers). */
function groupRows(page: Page): Locator {
  return page.getByRole("tabpanel").getByRole("row").filter({ has: page.getByRole("cell") });
}

/** The groups shown, in the table's order: each row's More is named for its group ("More about {name}"). */
async function expectShownNames(page: Page, names: readonly string[]): Promise<void> {
  const more = groupRows(page).getByRole("button", { name: /^More about / });
  await expect(more).toHaveCount(names.length);
  for (const [index, name] of names.entries()) await expect(more.nth(index)).toHaveAccessibleName(`More about ${name}`);
}

/** The row of the group named `name`: the one whose More is named for it. */
function groupRow(page: Page, name: string): Locator {
  return groupRows(page).filter({ has: page.getByRole("button", { name: `More about ${name}`, exact: true }) });
}

/** Picks `option` in the Select named `name`, within `scope`. */
async function choose(page: Page, scope: Locator, name: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** Every group write's request (POST, PATCH, DELETE) from now on, in order. */
function recordWrites(page: Page): Request[] {
  const writes: Request[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && (GROUPS_PATH.test(path) || GROUP_PATH.test(path))) writes.push(request);
  });
  return writes;
}

test("creates a group with a published version, which reaches a collector of the group; its details name it", async ({ page }) => {
  const { user, organizationId, fleetId } = await signedInWithFleet(page);
  const configurationName = `db-otel-${unique()}`;
  const { configurationId, versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  await openGroups(page, fleetId);
  // Default only, nothing assigned.
  await expectShownNames(page, ["Default"]);
  await expect(groupRow(page, "Default")).toContainText("Nothing assigned");
  const writes = recordWrites(page);

  await page.getByRole("tabpanel").getByRole("button", { name: "New group" }).click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await expect(dialog).toContainText(
    "A group gives its collectors one published version. Collectors that aren't pinned are sent it on their next poll.",
  );
  // A new group requires a published version (Ruling 34): the picker alone, no choice, no Nothing assigned,
  // and no visible "Published version" heading (Ruling 36): its group keeps the name by aria-label.
  await expect(dialog.getByRole("group", { name: "Published version", exact: true })).toBeVisible();
  await expect(dialog.getByText("Published version", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Published version", exact: true })).toHaveCount(0);
  await expect(dialog).not.toContainText("Nothing assigned");
  // No version picked yet: Create waits.
  const name = `db-hosts-${unique()}`;
  await dialog.getByRole("textbox", { name: "Name" }).fill(`  ${name} `);
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
  await choose(page, dialog, "Configuration", configurationName);
  await expect(dialog.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
  await expect(dialog.getByText(HINT_VERSION)).toBeVisible();

  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && GROUPS_PATH.test(new URL(response.url()).pathname),
  );
  const reloaded = page.waitForResponse((response) => isGroupsRead(response.request()));
  await dialog.getByRole("button", { name: "Create" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { group } = (await response.json()) as { group: CollectorGroup };
  await expect(page.getByText("Group created")).toBeVisible();
  await expect(dialog).toBeHidden();
  await reloaded;
  // One POST, the name trimmed, the version's id.
  expect(writes.map((request) => request.postDataJSON() as unknown)).toEqual([{ name, assignedVersionId: versionId }]);

  // Listed after Default, its version linked to the editor; Edit now, not Assign.
  await expectShownNames(page, ["Default", name]);
  const link = groupRow(page, name).getByRole("link", { name: `${configurationName} @v1` });
  await expect(link).toHaveAttribute("href", `/editor/${configurationId}/${versionId}`);
  await expect(page.getByRole("button", { name: `Edit ${name}`, exact: true })).toBeVisible();

  // A collector installed into it is sent that version: its group's, resolved.
  const collector = await enrollFakeCollector(organizationId, fleetId, { name: `db-${unique()}`, groupId: group.id });
  expect((await collectorThroughApi(page, organizationId, fleetId, collector.id)).resolution).toMatchObject({
    from: "groupVersion",
    version: { configurationId, versionId, configurationName },
  });

  // Its details: the name as the title, the published version, the id.
  await page.getByRole("button", { name: `More about ${name}`, exact: true }).click();
  const details = page.getByRole("dialog", { name });
  await expect(details).toContainText("Group details");
  await expect(details).toContainText(`${configurationName} @v1`);
  await expect(details).toContainText(group.id);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
});

test("renames a group: a name another group holds is refused under the Name; the new name is sent trimmed and listed", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const name = `alpha-${unique()}`;
  const taken = `beta-${unique()}`;
  const group = await createGroupThroughApi(page, organizationId, fleetId, name);
  await createGroupThroughApi(page, organizationId, fleetId, taken);
  await openGroups(page, fleetId);
  await expect(groupRow(page, name)).toBeVisible();
  const writes = recordWrites(page);

  // Nothing assigned: its button reads Assign, as does the dialog's submit.
  await page.getByRole("button", { name: `Assign ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Assign a published version to ${name}` });
  const nameField = dialog.getByRole("textbox", { name: "Name" });
  await expect(nameField).toHaveValue(name);
  // Nothing changed yet.
  await expect(dialog.getByRole("button", { name: "Assign" })).toBeDisabled();

  await nameField.fill(taken);
  await dialog.getByRole("button", { name: "Assign" }).click();
  // Under the field, the dialog open, nothing renamed.
  await expect(dialog.getByRole("alert")).toHaveText(NAME_TAKEN);
  await expect(nameField).toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toBeVisible();

  const renamed = `gamma-${unique()}`;
  await nameField.fill(` ${renamed}  `);
  const reloaded = page.waitForResponse((response) => isGroupsRead(response.request()));
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(dialog).toBeHidden();
  await reloaded;
  // The refused PATCH and the rename: a name alone, trimmed.
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([
    ["PATCH", { name: taken }],
    ["PATCH", { name: renamed }],
  ]);
  expect(new URL(writes[1]!.url()).pathname).toMatch(new RegExp(`/groups/${group.id}$`));
  // Default first, then by name: beta before gamma.
  await expectShownNames(page, ["Default", taken, renamed]);
  await expect(groupRow(page, name)).toHaveCount(0);
});

test("assigns a group a published version, which its unpinned collectors take and a pinned one doesn't; then clears it", async ({
  page,
}) => {
  const { user, organizationId, fleetId } = await signedInWithFleet(page);
  const configurationName = `gateway-otel-${unique()}`;
  const pinnedName = `pinned-otel-${unique()}`;
  const { configurationId, versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  const pinnedTo = await publishedConfiguration(page, organizationId, user.userId, pinnedName);
  const name = `gateways-${unique()}`;
  const group = await createGroupThroughApi(page, organizationId, fleetId, name);
  const [unpinned, pinned] = await enrollCollectors(organizationId, fleetId, `gw-${unique()}`, 2, { groupId: group.id });
  await pinThroughApi(page, organizationId, fleetId, pinned!.id, { kind: "version", versionId: pinnedTo.versionId });
  await openGroups(page, fleetId);
  await expect(groupRow(page, name)).toContainText("Nothing assigned");
  const writes = recordWrites(page);

  // Assign.
  await page.getByRole("button", { name: `Assign ${name}`, exact: true }).click();
  const assign = page.getByRole("dialog", { name: `Assign a published version to ${name}` });
  // The picker alone, as New group's (Ruling 72, the owner's): no choice, no Nothing assigned, no visible heading.
  await expect(assign.getByRole("group", { name: "Published version", exact: true })).toBeVisible();
  await expect(assign.getByRole("combobox", { name: "Published version", exact: true })).toHaveCount(0);
  await expect(assign.getByText("Published version", { exact: true })).toHaveCount(0);
  await expect(assign).not.toContainText("Nothing assigned");
  await expect(assign.getByRole("button", { name: "Assign" })).toBeDisabled();
  await choose(page, assign, "Configuration", configurationName);
  await expect(assign.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
  await expect(assign.getByText(HINT_VERSION)).toBeVisible();
  await assign.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(assign).toBeHidden();
  await expect(groupRow(page, name).getByRole("link", { name: `${configurationName} @v1` })).toBeVisible();
  // The same button, now Edit.
  await expect(page.getByRole("button", { name: `Edit ${name}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Assign ${name}`, exact: true })).toHaveCount(0);

  // The unpinned collector takes the group's version; the pinned one keeps its pin.
  expect((await collectorThroughApi(page, organizationId, fleetId, unpinned!.id)).resolution).toMatchObject({
    from: "groupVersion",
    version: { configurationId, versionId },
  });
  expect((await collectorThroughApi(page, organizationId, fleetId, pinned!.id)).resolution).toMatchObject({
    from: "pinnedVersion",
    version: { versionId: pinnedTo.versionId },
  });

  // Clear: Nothing assigned.
  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(edit.getByRole("combobox", { name: "Published version", exact: true })).toHaveText("A published version");
  await expect(edit.getByRole("button", { name: "Save" })).toBeDisabled();
  await choose(page, edit, "Published version", "Nothing assigned");
  await expect(edit.getByText(HINT_NOTHING)).toBeVisible();
  await expect(edit.getByRole("combobox", { name: "Configuration", exact: true })).toHaveCount(0);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(groupRow(page, name)).toContainText("Nothing assigned");
  await expect(page.getByRole("button", { name: `Assign ${name}`, exact: true })).toBeVisible();

  // One PATCH each: the version's id, then null.
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([
    ["PATCH", { assignedVersionId: versionId }],
    ["PATCH", { assignedVersionId: null }],
  ]);
  // The unpinned collector has nothing resolved (it keeps running what it has); the pinned one still its pin.
  expect((await collectorThroughApi(page, organizationId, fleetId, unpinned!.id)).resolution).toBeNull();
  expect((await collectorThroughApi(page, organizationId, fleetId, pinned!.id)).resolution).toMatchObject({ from: "pinnedVersion" });
});

test("the Default group can't be renamed or deleted, and a group made elsewhere appears within one poll", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  // The page's clock, at the real now (the fake's): installed before the page loads.
  await page.clock.install();
  await openGroups(page, fleetId);
  const row = groupRow(page, "Default");
  await expect(row.getByText("Default", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Delete Default", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Delete" })).toHaveCount(0);

  await page.getByRole("button", { name: "Assign Default", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Assign a published version to Default" });
  await expect(dialog).toContainText(DEFAULT_DESCRIPTION);
  const nameField = dialog.getByRole("textbox", { name: "Name" });
  await expect(nameField).toHaveValue("Default");
  await expect(nameField).not.toBeEditable();
  await expect(dialog.getByText("The Default group can't be renamed.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Assign" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Made through the API while the tab is open: the next poll lists it.
  const name = `elsewhere-${unique()}`;
  await createGroupThroughApi(page, organizationId, fleetId, name);
  expect(await groupRow(page, name).count()).toBe(0);
  await nextPoll(page, isGroupsRead);
  await expect(groupRow(page, name)).toBeVisible();
  await expectShownNames(page, ["Default", name]);
  await expect(page.getByRole("button", { name: `Delete ${name}`, exact: true })).toBeVisible();
});

// D17c-1 decision 32 (Preflight ruling 30): a group's mounts, written into its annotations through the API.
test("adds a mount to the Default group in its dialog: the messages first, then annotations alone sent; it opens on its mounts, and removing them sends null", async ({
  page,
}) => {
  const { fleetId, defaultGroupId } = await signedInWithFleet(page);
  await openGroups(page, fleetId);
  const writes = recordWrites(page);

  await page.getByRole("button", { name: "Assign Default", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Assign a published version to Default" });
  const disclosure = dialog.getByRole("button", { name: "Mounts (for the container install)", exact: true });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByRole("button", { name: "Add mount", exact: true })).toBeHidden();
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await dialog.getByRole("button", { name: "Add mount", exact: true }).click();
  const host = dialog.getByRole("textbox", { name: "Host path", exact: true });
  const container = dialog.getByRole("textbox", { name: "Container path", exact: true });
  await expect(host).toBeFocused();
  await expect(host).toHaveAttribute("placeholder", "/var/log/nginx");
  await expect(dialog.getByRole("checkbox", { name: "Read-only", exact: true })).toBeChecked();
  await host.fill("/var/log/nginx");
  await container.fill("/app/logs");
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expect(container).toHaveAccessibleDescription("Use a path outside /app: the image keeps its own files there.");
  expect(writes).toEqual([]);

  // Inside ph-no-capture, the paths in no attribute but their inputs' value.
  await container.fill("/var/log/nginx");
  expect(
    await page.evaluate<string[]>(`(() => {
      const holders = [];
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (!attribute.value.includes("/var/log/nginx") || (attribute.name === "placeholder" && attribute.value === "/var/log/nginx")) continue;
          holders.push(element.tagName + " " + attribute.name + " " + (element.closest(".ph-no-capture") !== null));
        }
      }
      return holders;
    })()`),
  ).toEqual(["INPUT value true", "INPUT value true"]);

  // The tab's re-read after the save: the save's own read of the group (Ruling 61) answers before its PATCH is sent.
  const reloaded = page.waitForResponse((response) => isGroupsRead(response.request()) && writes.length > 0);
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(dialog).toBeHidden();
  // The tab's re-read answered: a dialog opened before it would show the group as it was, without its mount.
  expect((await reloaded).status()).toBe(200);
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([
    ["PATCH", { annotations: { telflo: { dockerMounts: [{ hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true }] } } }],
  ]);
  expect(new URL(writes[0]!.url()).pathname).toMatch(new RegExp(`/groups/${defaultGroupId}$`));

  // Opened again: the disclosure open on its mount (read back through the API), once the save's toast is gone
  // (it slides in at the bottom right and overlaps only the row button's bottom edge: the wait is insurance).
  await expect(page.getByText("Group updated")).toBeHidden();
  await page.getByRole("button", { name: "Assign Default", exact: true }).click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(host).toHaveValue("/var/log/nginx");
  await expect(container).toHaveValue("/var/log/nginx");
  await dialog.getByRole("button", { name: "Remove mount 1", exact: true }).click();
  await expect(host).toHaveCount(0);
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expect(dialog).toBeHidden();
  expect(writes.map((request) => request.postDataJSON() as unknown)[1]).toEqual({ annotations: null });
});

test("deletes a group once its name is typed: its collectors are deleted with it", async ({ page }) => {
  const { organizationId, fleetId } = await signedInWithFleet(page);
  const name = `doomed-${unique()}`;
  const kept = `kept-${unique()}`;
  const group = await createGroupThroughApi(page, organizationId, fleetId, name);
  const keptGroup = await createGroupThroughApi(page, organizationId, fleetId, kept);
  const doomed = await enrollCollectors(organizationId, fleetId, `doomed-${unique()}`, 2, { groupId: group.id });
  const stays = await enrollFakeCollector(organizationId, fleetId, { name: `stays-${unique()}`, groupId: keptGroup.id });
  await openGroups(page, fleetId);
  await expect(groupRow(page, name)).toBeVisible();
  const writes = recordWrites(page);

  await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}` });
  await expect(dialog).toContainText(DELETE_CONSEQUENCES);
  await expect(dialog).not.toContainText("Helm");
  // D17d-1 decision 3: Delete is disabled until the group's name is typed exactly (Preflight ruling 30).
  const confirm = dialog.getByLabel(deleteConfirmLabel(name), { exact: true });
  const remove = dialog.getByRole("button", { name: "Delete", exact: true });
  await expect(confirm).toHaveValue("");
  await expect(remove).toBeDisabled();
  await confirm.fill(name.toUpperCase());
  await expect(remove).toBeDisabled();
  await confirm.fill(` ${name} `);
  await expect(remove).toBeEnabled();
  // The typed text is in no attribute: the input is uncontrolled, inside ph-no-capture.
  await expect(confirm).not.toHaveAttribute("value");
  await expect(dialog.locator(".ph-no-capture").getByLabel(deleteConfirmLabel(name), { exact: true })).toBeVisible();
  // The name shown bold in the label, inside ph-no-capture with the input; no placeholder (Ruling 70).
  await expect(dialog.locator(".ph-no-capture label .font-bold")).toHaveText(name);
  await expect(confirm).not.toHaveAttribute("placeholder");
  expect(await attributeHoldersOf(page, [name])).toEqual([[]]);
  await remove.click();
  await expect(page.getByText("Group deleted")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(groupRow(page, name)).toHaveCount(0);
  await expectShownNames(page, ["Default", kept]);
  expect(writes.map((request) => request.method())).toEqual(["DELETE"]);
  expect(new URL(writes[0]!.url()).pathname).toMatch(new RegExp(`/groups/${group.id}$`));

  // Its collectors are deleted with it (D17d-1 decision 3); the other group's stays.
  const groupOf = new Map((await collectorsThroughApi(page, organizationId, fleetId)).map((each) => [each.id, each.groupId]));
  expect(doomed.map((each) => groupOf.has(each.id))).toEqual([false, false]);
  expect(groupOf.get(stays.id)).toBe(keptGroup.id);
  expect(groupOf.size).toBe(1);
});

/** A configuration's text referencing `${org:name}` for each of `names`, which a published version can hold. */
function referencingYaml(names: readonly string[]): string {
  const actions = names.map((name, index) => `      - key: e2e.tag${index}\n        value: \${org:${name}}\n        action: insert\n`).join("");
  return `receivers:\n  otlp:\n    protocols:\n      grpc: {}\nprocessors:\n  attributes/e2e:\n    actions:\n${actions}exporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [attributes/e2e]\n      exporters: [debug]\n`;
}

// D20 default 23 (the group dialog's choice) and default 25 (the column, the details' row, the values dialog).
test("a group's Variable group: chosen in its dialog and sent alone, shown in its column and details and opening its values; Variables used and the 422 name an undefined variable; None clears it", async ({
  page,
}) => {
  const { user, organizationId, fleetId } = await signedInWithFleet(page);
  const token = unique();
  const endpoint = uniqueVariableName("ENDPOINT");
  const region = uniqueVariableName("REGION");
  const missing = uniqueVariableName("MISSING");
  const endpointValue = canaryVariableValue(`endpoint-${token}`);
  const regionValue = canaryVariableValue(`region-${token}`);
  const overrideValue = canaryVariableValue(`override-${token}`);
  const endpointVariable = await createVariableThroughApi(page, organizationId, endpoint, endpointValue);
  await createVariableThroughApi(page, organizationId, region, regionValue);
  const variableGroupName = `eu-edge-${token}`;
  const variableGroup = await createVariableGroupThroughApi(page, organizationId, variableGroupName);
  await setOverrideThroughApi(page, organizationId, variableGroup.id, endpointVariable.id, overrideValue);
  const definedName = `defined-otel-${token}`;
  const undefinedName = `undefined-otel-${token}`;
  const defined = await publishedConfiguration(page, organizationId, user.userId, definedName, { yaml: referencingYaml([endpoint]) });
  const undefinedVersion = await publishedConfiguration(page, organizationId, user.userId, undefinedName, { yaml: referencingYaml([endpoint, missing]) });
  const name = `vars-${token}`;
  const group = await createGroupThroughApi(page, organizationId, fleetId, name);
  await openGroups(page, fleetId);
  // No variable group: the organization's values.
  await expect(groupRow(page, name).getByRole("cell").nth(2)).toHaveText("Organization values");
  const writes = recordWrites(page);

  // Chosen in its dialog: the variable group alone sent.
  await page.getByRole("button", { name: `Assign ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Assign a published version to ${name}` });
  const select = dialog.getByRole("combobox", { name: "Variable group", exact: true });
  await expect(select).toHaveText("None (organization values)");
  await select.click();
  await expect(page.getByRole("option")).toHaveText(["None (organization values)", variableGroupName]);
  await page.getByRole("option", { name: variableGroupName, exact: true }).click();
  await expect(select).toHaveText(variableGroupName);
  // Its name inside ph-no-capture, in no attribute.
  await expect(select).toHaveClass(/(^|\s)ph-no-capture(\s|$)/);
  expect(await attributeHoldersOf(page, [variableGroupName])).toEqual([[]]);
  // As text, inside ph-no-capture only: the trigger's value and the hidden native <select>'s option Radix renders in the form.
  expect(await placesOf(page, [variableGroupName])).toEqual([{ inside: 2, outside: 0, inAttributes: 0 }]);
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([["PATCH", { variableGroupId: variableGroup.id }]]);
  expect(new URL(writes[0]!.url()).pathname).toMatch(new RegExp(`/groups/${group.id}$`));

  // Its column names it; its values: the override, else the organization's value.
  const cell = groupRow(page, name).getByRole("cell").nth(2);
  await expect(cell).toHaveText(variableGroupName);
  await cell.getByRole("button", { name: variableGroupName, exact: true }).click();
  const values = page.getByRole("dialog", { name: "Variable values" });
  const valueRow = (variable: string) => values.getByRole("row").filter({ has: page.getByText(variable, { exact: true }) });
  await expect(valueRow(endpoint).locator("code")).toHaveText(overrideValue);
  await expect(valueRow(endpoint).getByRole("cell").nth(2)).toHaveText("Override");
  await expect(valueRow(region).locator("code")).toHaveText(regionValue);
  await expect(valueRow(region).getByRole("cell").nth(2)).toHaveText("Organization value");
  // Every value as text inside ph-no-capture only; the group's name in no attribute.
  expect(await placesOf(page, [overrideValue, regionValue, endpointValue, variableGroupName])).toEqual([
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
    { inside: 2, outside: 0, inAttributes: 0 },
  ]);
  await page.keyboard.press("Escape");
  await expect(values).toBeHidden();

  // Its details' row.
  await page.getByRole("button", { name: `More about ${name}`, exact: true }).click();
  const details = page.getByRole("dialog", { name });
  await expect(details.getByText("Variable group", { exact: true }).locator("xpath=following-sibling::div[1]")).toHaveText(variableGroupName);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // A version referencing a name no variable has: Variables used lists it before Save, and the 422 names it.
  await page.getByRole("button", { name: `Assign ${name}`, exact: true }).click();
  await expect(select).toHaveText(variableGroupName);
  await choose(page, dialog, "Configuration", undefinedName);
  await expect(dialog.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
  await expect(dialog.getByText("Not defined in your organization's variables:", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole("status").getByRole("listitem")).toHaveText([missing]);
  const refused = page.waitForResponse((response) => response.request().method() === "PATCH" && GROUP_PATH.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Assign" }).click();
  expect((await refused).status()).toBe(422);
  await expect(dialog).toBeVisible();
  // The 422's names beside Variables used's: both inside ph-no-capture.
  await expect(dialog.getByRole("listitem").filter({ hasText: missing })).toHaveCount(2);
  expect(await placesOf(page, [missing])).toEqual([{ inside: 2, outside: 0, inAttributes: 0 }]);

  // A version whose every name is defined, and None: both sent, the variable group as null.
  await choose(page, dialog, "Configuration", definedName);
  await expect(dialog.getByText("Uses 1 organization variable, all defined.", { exact: true })).toBeVisible();
  await choose(page, dialog, "Variable group", "None (organization values)");
  await dialog.getByRole("button", { name: "Assign" }).click();
  await expect(dialog).toBeHidden();
  await expect(cell).toHaveText("Organization values");
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([
    ["PATCH", { variableGroupId: variableGroup.id }],
    ["PATCH", { assignedVersionId: undefinedVersion.versionId }],
    ["PATCH", { assignedVersionId: defined.versionId, variableGroupId: null }],
  ]);
});
