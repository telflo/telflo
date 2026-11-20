import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { createServerFleetThroughApi, publishedConfiguration, updateGroupThroughApi } from "./support/collectors.js";
import { seedConfiguration, seedUser, type SeededUser } from "./support/database.js";
import { attributeHoldersOf, canaryVariableValue, placesOf, storageHolding, urlsHolding } from "./support/privacy.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";
import {
  createVariableThroughApi,
  uniqueVariableName,
  variableGroupsApiPath,
  variableGroupThroughApi,
  variablesApiPath,
  variablesThroughApi,
} from "./support/variables.js";

// The Variables pages, in the browser, against the E2E API and its fake
// opamp-server, which holds the organization's variables, variable groups
// and overrides, and guards a variable or a variable group in use. Each test
// works in an organization of its own (a new user's), so tests and browsers
// run in parallel. Variables, groups, fleets and published versions the page
// doesn't make itself are made through the API as the page's session
// (support/variables.ts, support/collectors.ts), before the page reads them.
//
// Privacy: a value is configuration text, shown only as text inside
// `ph-no-capture`, in no attribute but a dialog's own input's value; a
// name, a description and a group's name are text in the masked shell,
// never in an attribute, a URL, a page title or browser storage; the search
// is the page's state, never in the address (no `?q=`).
//
// The words are the web app's, written out here.

const PASSWORD = "correct horse battery staple";
const NOTE = "Referenced in configurations as ${org:NAME}.";
/** Each page's warning. */
const VARIABLES_WARNING =
  "Not for secrets. Keep passwords, tokens and keys in environment variables (${env:NAME}), set when you install. Test runs use these values in place of ${org:NAME}, and each run keeps its Test YAML and the collector's logs, values included, with its results.";
const VARIABLE_GROUPS_WARNING =
  "Not for secrets. Keep passwords, tokens and keys in environment variables (${env:NAME}), set when you install.";
const HOW_VARIABLE_GROUPS_WORK =
  "A variable group overrides some of your organization's values, such as one region's endpoint. A collector group uses one in its Edit dialog, and a single collector can be pinned to its own. Each collector receives every variable from its pinned variable group, else its collector group's, else the organization's. A variable the group doesn't override keeps the organization's value.";
/** The only attribute a dialog's field may hold its text in: its input's value, inside ph-no-capture. */
const INPUT_VALUE = "INPUT value true";
/** A configuration's text referencing `name`, which a published version can hold. */
const referencingYaml = (name: string) =>
  `receivers:\n  otlp:\n    protocols:\n      grpc: {}\nprocessors:\n  attributes/e2e:\n    actions:\n      - key: e2e.tag\n        value: \${org:${name}}\n        action: insert\nexporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [attributes/e2e]\n      exporters: [debug]\n`;

/** A suffix no other test uses. */
const unique = () => randomUUID().slice(0, 8);

/** A new user, signed in. */
async function signedIn(page: Page): Promise<SeededUser> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  return user;
}

/** Every request URL the page sends from now on: no name, value or search may be in one. */
function recordUrls(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

/** The page at `path`, hydrated, its read of `apiPath` (the variables, or the variable groups) answered. */
async function openPage(page: Page, path: string, apiPath: string): Promise<void> {
  const read = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === apiPath);
  await page.goto(path);
  await waitForHydration(page);
  expect((await read).status()).toBe(200);
}

/** The table's rows holding cells (the header's hold column headers). */
function bodyRows(page: Page): Locator {
  return page.getByRole("row").filter({ has: page.getByRole("cell") });
}

/** The row of the variable (or the variable group) named `name`: the one holding its name as a cell's text. */
function rowOf(page: Page, name: string): Locator {
  return bodyRows(page).filter({ has: page.getByText(name, { exact: true }) });
}

/** The attributes holding `text`, each "{TAG} {attribute} {inside ph-no-capture}" (attributeHoldersOf, for one text). */
async function attributeHolders(page: Page, text: string): Promise<string[]> {
  return (await attributeHoldersOf(page, [text]))[0]!;
}

/** The page's request matching `method` and `path`, once sent. */
function nextRequest(page: Page, method: string, path: RegExp): Promise<Request> {
  return page.waitForRequest((request) => request.method() === method && path.test(new URL(request.url()).pathname));
}

test("the Variables page: the note and the empty state; Add, Edit and the search, the value only inside ph-no-capture, in no attribute, URL or storage", async ({
  page,
}) => {
  const user = await signedIn(page);
  const urls = recordUrls(page);
  const token = unique();
  const name = uniqueVariableName("OTLP_EP");
  const value = canaryVariableValue(token);
  const description = `Where the gateway sends ${token}`;
  const edited = canaryVariableValue(`edited-${token}`);

  // The Sidebar's "Variables" leads to /variables (default 19).
  await page.goto("/app");
  await waitForHydration(page);
  const listRead = page.waitForResponse((response) => new URL(response.url()).pathname === variablesApiPath(user.organizationId));
  await page.getByRole("link", { name: "Variables", exact: true }).click();
  await page.waitForURL("/variables");
  expect((await listRead).status()).toBe(200);
  await expect(page).toHaveTitle("Variables - Telflo");
  await expect(page.getByRole("heading", { level: 1, name: "Variables" })).toBeVisible();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toHaveText(VARIABLES_WARNING);
  // The left nav: links, the page shown marked.
  const nav = page.getByRole("navigation", { name: "Variables pages" });
  await expect(nav.getByRole("link", { name: "Variables", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Variable groups", exact: true })).toHaveAttribute("href", "/variables/groups");
  await expect(nav.getByRole("link", { name: "Variable groups", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No organization variables yet", { exact: true })).toBeVisible();

  // Add: the name upper-cased as typed, the value kept as typed, a description.
  await page.getByRole("button", { name: "Add variable" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add variable" });
  await dialog.getByLabel("Name", { exact: true }).pressSequentially(name.toLowerCase());
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(dialog.getByText(`Use in configurations as \${org:${name}}`, { exact: true })).toBeVisible();
  await dialog.getByLabel("Value", { exact: true }).fill(value);
  await dialog.getByLabel("Description (optional)", { exact: true }).fill(description);
  // The typed value in no attribute but its input's value, inside ph-no-capture.
  expect(await attributeHolders(page, value)).toEqual([INPUT_VALUE]);
  const created = nextRequest(page, "POST", /\/variables$/);
  await dialog.getByRole("button", { name: "Add variable", exact: true }).click();
  const post = await created;
  expect((await post.response())?.status()).toBe(201);
  expect(post.postDataJSON()).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name, value, description });
  await expect(page.getByText("Variable added", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();

  // Listed: the name with its description beneath, the value in full, who changed it.
  const row = rowOf(page, name);
  await expect(row).toBeVisible();
  await expect(row).toContainText(description);
  await expect(row.locator("code")).toHaveText(value);
  await expect(row).toContainText(`by ${user.email}`);
  // The value as text inside ph-no-capture only; the name and the description text in the masked shell
  // (the name also in the row's hidden Edit and Delete labels), none in an attribute or the title.
  expect(await placesOf(page, [value, name, description])).toEqual([
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 0, outside: 3, inAttributes: 0 },
    { inside: 0, outside: 1, inAttributes: 0 },
  ]);

  // The search runs in the page, over the name, the description and the value: never in the address or storage.
  const search = page.getByRole("searchbox", { name: "Search variables" });
  await expect(page.locator(".ph-no-capture").filter({ has: search })).toHaveCount(1);
  await search.fill(token);
  await expect(row).toBeVisible();
  await search.fill(`nothing-${token}`);
  await expect(page.getByText("No variables match your search", { exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await search.fill("");
  await expect(row).toBeVisible();

  // Edit: the value alone sent.
  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit variable" });
  await expect(edit.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(edit.getByLabel("Value", { exact: true })).toHaveValue(value);
  await expect(edit.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await edit.getByLabel("Value", { exact: true }).fill(edited);
  const patched = nextRequest(page, "PATCH", /\/variables\/[^/]+$/);
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  expect((await patched).postDataJSON()).toEqual({ value: edited });
  await expect(page.getByText("Variable saved", { exact: true })).toBeVisible();
  await expect(edit).toBeHidden();
  await expect(row.locator("code")).toHaveText(edited);
  expect(await variablesThroughApi(page, user.organizationId)).toMatchObject([{ name, value: edited, description }]);

  // Nothing of it in an address the page sent, in browser storage, or in the title.
  const secrets = [value, edited, name, description, token];
  expect(urlsHolding(urls, secrets)).toEqual([]);
  expect(await storageHolding(page, secrets)).toEqual([]);
  await expect(page).toHaveTitle("Variables - Telflo");
});

test("a variable a used published version references: its delete is refused with the use listed and its drafts warned of; once unused, it deletes", async ({
  page,
}) => {
  const user = await signedIn(page);
  const { organizationId } = user;
  const token = unique();
  const name = uniqueVariableName("GATEWAY");
  const value = canaryVariableValue(token);
  const variable = await createVariableThroughApi(page, organizationId, name, value);
  const configurationName = `edge-config-${token}`;
  const draftName = `draft-config-${token}`;
  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName, { yaml: referencingYaml(name) });
  // A configuration whose current draft references the name (default 21's warning): unpublished.
  await seedConfiguration({ organizationId, createdByUserId: user.userId, name: draftName, yamlContent: referencingYaml(name) });
  const fleetLabel = `edge-${token}`;
  const { fleet, defaultGroup } = await createServerFleetThroughApi(page, organizationId, fleetLabel);
  await updateGroupThroughApi(page, organizationId, fleet.id, defaultGroup.id, { assignedVersionId: versionId });
  await openPage(page, "/variables", variablesApiPath(organizationId));

  await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete variable" });
  await expect(dialog.getByText(`\${org:${name}}`, { exact: true })).toBeVisible();
  // The drafts read as the dialog opens: a warning, not a refusal.
  const drafts = dialog.getByRole("status");
  await expect(drafts).toHaveText(`Drafts using ${name}: ${draftName}`);
  const refused = page.waitForResponse((response) => response.request().method() === "DELETE");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await refused).status()).toBe(409);
  // The opamp-server's 409, its use named with the platform's names: the version and the group in its fleet.
  await expect(dialog.getByText("Used by these published versions:", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveText([`${configurationName} v1 (Default in ${fleetLabel})`]);
  await expect(dialog).toBeVisible();
  // The use and the drafts as text inside ph-no-capture only, in no attribute.
  expect(await placesOf(page, [configurationName, draftName, fleetLabel])).toEqual([
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 1, outside: 0, inAttributes: 0 },
  ]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await variablesThroughApi(page, organizationId)).map((each) => each.id)).toEqual([variable.id]);

  // Unused once its group releases the version: deleted.
  await updateGroupThroughApi(page, organizationId, fleet.id, defaultGroup.id, { assignedVersionId: null });
  await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(`Drafts using ${name}: ${draftName}`);
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Variable deleted", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(rowOf(page, name)).toHaveCount(0);
  await expect(page.getByText("No organization variables yet", { exact: true })).toBeVisible();
  expect(await variablesThroughApi(page, organizationId)).toEqual([]);
});

test("the Variable groups page: Add a group, listed by its counts; its page lists every variable with its value and source; Override and Reset; its delete refused while a collector group uses it", async ({
  page,
}) => {
  const user = await signedIn(page);
  const { organizationId } = user;
  const token = unique();
  const endpoint = uniqueVariableName("ENDPOINT");
  const region = uniqueVariableName("REGION");
  const endpointValue = canaryVariableValue(`endpoint-${token}`);
  const regionValue = canaryVariableValue(`region-${token}`);
  const overrideValue = canaryVariableValue(`override-${token}`);
  await createVariableThroughApi(page, organizationId, endpoint, endpointValue);
  await createVariableThroughApi(page, organizationId, region, regionValue, "The deployment's region");
  const urls = recordUrls(page);
  await openPage(page, "/variables/groups", variableGroupsApiPath(organizationId));
  await expect(page).toHaveTitle("Variable groups - Telflo");
  await expect(page.getByText("No variable groups yet", { exact: true })).toBeVisible();
  // The warning under the header, "How variable groups work" below the list.
  await expect(page.getByRole("note")).toHaveText(VARIABLE_GROUPS_WARNING);
  await expect(page.getByText("How variable groups work", { exact: true })).toBeVisible();
  await expect(page.getByText(HOW_VARIABLE_GROUPS_WORK, { exact: true })).toBeVisible();

  // Add: fixed title and toast, the name and the description as typed.
  const groupName = `eu-edge ${token}`;
  const groupDescription = `The EU's edge ${token}`;
  await page.getByRole("button", { name: "Add variable group" }).first().click();
  const add = page.getByRole("dialog", { name: "Add variable group" });
  await add.getByLabel("Name", { exact: true }).fill(groupName);
  await add.getByLabel("Description (optional)", { exact: true }).fill(groupDescription);
  const created = nextRequest(page, "POST", /\/variable-groups$/);
  await add.getByRole("button", { name: "Add variable group", exact: true }).click();
  const post = await created;
  expect(post.postDataJSON()).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: groupName, description: groupDescription });
  await expect(page.getByText("Variable group added", { exact: true })).toBeVisible();
  await expect(add).toBeHidden();
  const groupId = (post.postDataJSON() as { id: string }).id;

  // Listed: no override yet, unused, a link to its page by id.
  const listed = rowOf(page, groupName);
  await expect(listed.getByRole("cell").nth(1)).toHaveText("0");
  await expect(listed.getByRole("cell").nth(2)).toHaveText("Unused");
  await expect(listed).toContainText(groupDescription);
  await expect(listed.getByRole("link", { name: groupName, exact: true })).toHaveAttribute("href", `/variables/groups/${groupId}`);
  // The name and the description as text in the masked shell (the name also in the row's hidden Edit and Delete
  // labels), in no attribute.
  expect(await placesOf(page, [groupName, groupDescription])).toEqual([
    { inside: 0, outside: 3, inAttributes: 0 },
    { inside: 0, outside: 1, inAttributes: 0 },
  ]);

  // Its page: every organization variable, the organization's value and its source.
  const pageRead = page.waitForResponse((response) => new URL(response.url()).pathname === `${variableGroupsApiPath(organizationId)}/${groupId}`);
  await listed.getByRole("link", { name: groupName, exact: true }).click();
  await page.waitForURL(`/variables/groups/${groupId}`);
  expect((await pageRead).status()).toBe(200);
  await expect(page).toHaveTitle("Variable group - Telflo");
  await expect(page.getByRole("heading", { level: 2, name: groupName })).toBeVisible();
  // The left nav keeps "Variable groups" marked on a group's page.
  await expect(page.getByRole("navigation", { name: "Variables pages" }).getByRole("link", { name: "Variable groups", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("0 overrides · Unused", { exact: false })).toBeVisible();
  // The heading and the description: text in the masked shell, in no attribute (the page's title is fixed words).
  expect(await placesOf(page, [groupName, groupDescription])).toEqual([
    { inside: 0, outside: 1, inAttributes: 0 },
    { inside: 0, outside: 1, inAttributes: 0 },
  ]);
  for (const [name, organizationValue] of [
    [endpoint, endpointValue],
    [region, regionValue],
  ] as const) {
    await expect(rowOf(page, name).locator("code")).toHaveText(organizationValue);
    await expect(rowOf(page, name).getByRole("cell").nth(2)).toHaveText("Organization value");
    await expect(page.getByRole("button", { name: `Reset ${name}`, exact: true })).toHaveCount(0);
  }

  // Override: the group's value, sent alone; its source and who changed it.
  await page.getByRole("button", { name: `Override ${endpoint}`, exact: true }).click();
  const override = page.getByRole("dialog", { name: "Override value" });
  await expect(override.getByText(`\${org:${endpoint}}`, { exact: true })).toBeVisible();
  await expect(override).toContainText(`Organization value: ${endpointValue}`);
  await override.getByLabel("Value in this group", { exact: true }).fill(overrideValue);
  expect(await attributeHolders(page, overrideValue)).toEqual([INPUT_VALUE]);
  const put = nextRequest(page, "PUT", /\/variable-groups\/[^/]+\/overrides\/[^/]+$/);
  await override.getByRole("button", { name: "Save", exact: true }).click();
  expect((await put).postDataJSON()).toEqual({ value: overrideValue });
  await expect(page.getByText("Override saved", { exact: true })).toBeVisible();
  await expect(override).toBeHidden();
  await expect(rowOf(page, endpoint).locator("code")).toHaveText(overrideValue);
  await expect(rowOf(page, endpoint).getByRole("cell").nth(2)).toContainText("Override");
  await expect(rowOf(page, endpoint).getByRole("cell").nth(2)).toContainText(`by ${user.email}`);
  await expect(rowOf(page, region).getByRole("cell").nth(2)).toHaveText("Organization value");
  await expect(page.getByText("1 override · Unused", { exact: false })).toBeVisible();
  // Each value as text inside ph-no-capture only (the organization's beside the override is gone with the dialog).
  expect(await placesOf(page, [overrideValue, endpointValue, regionValue])).toEqual([
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
    { inside: 1, outside: 0, inAttributes: 0 },
  ]);
  expect((await variableGroupThroughApi(page, organizationId, groupId)).overrides).toMatchObject([{ value: overrideValue }]);

  // A collector group uses it: the list counts it, and its delete is refused with the group named.
  const fleetLabel = `edge-${token}`;
  const { fleet, defaultGroup } = await createServerFleetThroughApi(page, organizationId, fleetLabel);
  await updateGroupThroughApi(page, organizationId, fleet.id, defaultGroup.id, { variableGroupId: groupId });
  await page.getByRole("link", { name: "All variable groups", exact: true }).click();
  await page.waitForURL("/variables/groups");
  await expect(rowOf(page, groupName).getByRole("cell").nth(1)).toHaveText("1");
  await expect(rowOf(page, groupName).getByRole("cell").nth(2)).toHaveText("1 collector group");
  await page.getByRole("button", { name: `Delete ${groupName}`, exact: true }).click();
  const remove = page.getByRole("alertdialog", { name: "Delete variable group" });
  const refused = page.waitForResponse((response) => response.request().method() === "DELETE");
  await remove.getByRole("button", { name: "Delete", exact: true }).click();
  expect((await refused).status()).toBe(409);
  await expect(remove.getByText("Used by:", { exact: true })).toBeVisible();
  await expect(remove.getByRole("listitem")).toHaveText([`Default in ${fleetLabel}`]);
  await remove.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(remove).toBeHidden();

  // Reset, from its page: the organization's value again.
  await rowOf(page, groupName).getByRole("link", { name: groupName, exact: true }).click();
  await page.waitForURL(`/variables/groups/${groupId}`);
  await page.getByRole("button", { name: `Reset ${endpoint}`, exact: true }).click();
  const reset = page.getByRole("alertdialog", { name: "Reset override" });
  const deleted = nextRequest(page, "DELETE", /\/variable-groups\/[^/]+\/overrides\/[^/]+$/);
  await reset.getByRole("button", { name: "Reset", exact: true }).click();
  await deleted;
  await expect(page.getByText("Override reset", { exact: true })).toBeVisible();
  await expect(reset).toBeHidden();
  await expect(rowOf(page, endpoint).locator("code")).toHaveText(endpointValue);
  await expect(rowOf(page, endpoint).getByRole("cell").nth(2)).toHaveText("Organization value");
  await expect(page.getByText("0 overrides · 1 collector group", { exact: false })).toBeVisible();

  // The group's name and the values in no address the page sent, and nothing in storage.
  const secrets = [groupName, groupDescription, endpointValue, regionValue, overrideValue, endpoint, region];
  expect(urlsHolding(urls, secrets)).toEqual([]);
  expect(await storageHolding(page, secrets)).toEqual([]);
  // Made through the page and the API: the fake holds it, its override reset.
  expect(await variableGroupThroughApi(page, organizationId, groupId)).toMatchObject({
    variableGroup: { name: groupName, description: groupDescription, overrideCount: 0 },
    overrides: [],
  });
});

