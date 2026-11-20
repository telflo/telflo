import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import type { CollectorGroup, KubernetesAnnotations } from "@telflo/contracts";
import {
  collectorsThroughApi,
  createFleetThroughApi,
  createGroupThroughApi,
  enrollKubernetesPod,
  publishedConfiguration,
} from "./support/collectors.js";
import { seedUser, type SeededUser } from "./support/database.js";
import { isGetOf } from "./support/polling.js";
import { attributeHoldersOf, placesOf } from "./support/privacy.js";
import { signInThroughApi, waitForHydration } from "./support/session.js";
import { createVariableGroupThroughApi } from "./support/variables.js";

// A Kubernetes-supervisor fleet's page, in the browser, against the E2E API
// and its fake opamp-server. Each test works in an organization of its own (a
// new user's), so tests and browsers run in parallel. Fleets, groups and
// published versions are made through the API as the page's session
// (support/collectors.ts), collectors through the fake's control port with
// their group and the attributes the collector image reports
// (`enrollKubernetesPod`), before the page reads them. What the page sends is
// read from its requests; what the fake then holds, through the API.
//
// Privacy: a group's namespace, a gateway's name, a volume's paths and a
// collector's node name are configuration text: never in an attribute but a
// dialog's own input's value, inside `ph-no-capture` (support/privacy.ts).

const PASSWORD = "correct horse battery staple";
/** The fleet's groups: the tab's reads and polls (GET) and the create (POST). */
const GROUPS_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/groups$/;
/** One group's path: its PATCH and its DELETE. */
const GROUP_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/groups\/[^/]+$/;
/** The fleet's collectors' list (its query aside): the Collectors tab's reads and polls. */
const COLLECTORS_PATH = /^\/api\/v1\/organizations\/[^/]+\/fleets\/[^/]+\/collectors$/;
const isGroupsRead = isGetOf(GROUPS_PATH);
const isCollectorsRead = isGetOf(COLLECTORS_PATH);
/** The namespace a group's dialog starts from (the contracts' KUBERNETES_DEFAULT_NAMESPACE). */
const DEFAULT_NAMESPACE = "telflo-collectors";
/** The delete dialog's consequences, and a Kubernetes fleet's Helm line. */
const DELETE_CONSEQUENCES =
  "This deletes the group and its collectors' records. A collector installed into it that is still running keeps the configuration it has, but the fleet refuses its connections from then on: uninstall it, or reinstall it into another group. A collector moved into it from another group rejoins the group it was installed into.";
const DELETE_HELM = "Uninstall the group's Helm release in your cluster.";
/** The typed-name input's label: the group's name, bold, between the words. */
const deleteConfirmLabel = (name: string) => `Type ${name} to confirm`;
/** The canary note under a Kubernetes fleet's Pin selects. */
const PIN_NOTE = "A rescheduled pod is a new collector: it follows its group again.";
/** The only attribute a dialog's field may hold its text in: its input's value, inside ph-no-capture. */
const INPUT_VALUE = "INPUT value true";

/** A suffix no other test uses: lowercase hex, so a gateway's name and a namespace stay DNS labels. */
const unique = () => randomUUID().slice(0, 8);

/** The settings the API requires in a Kubernetes group's annotations, as the page writes them. */
function kubernetesAnnotations(settings: KubernetesAnnotations): Record<string, unknown> {
  return { telflo: { kubernetes: settings } };
}

interface FleetSetup {
  user: SeededUser;
  organizationId: string;
  fleetId: string;
  defaultGroupId: string;
}

/** A new user, signed in, with a Kubernetes-supervisor fleet of their organization. */
async function signedInWithKubernetesFleet(page: Page): Promise<FleetSetup> {
  const user = await seedUser({ password: PASSWORD });
  await signInThroughApi(page, user);
  const { fleet, defaultGroup } = await createFleetThroughApi(page, user.organizationId, "kubernetes-supervisor");
  return { user, organizationId: user.organizationId, fleetId: fleet.id, defaultGroupId: defaultGroup.id };
}

/** The fleet's page at its Groups tab, hydrated, the tab's first read of its groups answered. */
async function openGroups(page: Page, fleetId: string): Promise<void> {
  const read = page.waitForResponse((response) => isGroupsRead(response.request()));
  await page.goto(`/fleet-management/${fleetId}?tab=groups`);
  await waitForHydration(page);
  expect((await read).status()).toBe(200);
}

/** The fleet's page at its Collectors tab, hydrated, the tab's first read of its collectors answered. */
async function openCollectors(page: Page, fleetId: string): Promise<void> {
  const read = page.waitForResponse((response) => isCollectorsRead(response.request()));
  await page.goto(`/fleet-management/${fleetId}`);
  await waitForHydration(page);
  expect((await read).status()).toBe(200);
}

/** The Groups tab's rows: the table's rows holding cells (the header's hold column headers). */
function groupRows(page: Page): Locator {
  return page.getByRole("tabpanel").getByRole("row").filter({ has: page.getByRole("cell") });
}

/** The rows shown, in the table's order: each row's More is named for its row ("More about {Agent | Cluster | name}"). */
async function expectShownRows(page: Page, names: readonly string[]): Promise<void> {
  const more = groupRows(page).getByRole("button", { name: /^More about / });
  await expect(more).toHaveCount(names.length);
  for (const [index, name] of names.entries()) await expect(more.nth(index)).toHaveAccessibleName(`More about ${name}`);
}

/** The Groups tab's row named `name` (Agent, Cluster or a gateway's name): the one whose More is named for it. */
function groupRow(page: Page, name: string): Locator {
  return groupRows(page).filter({ has: page.getByRole("button", { name: `More about ${name}`, exact: true }) });
}

/** A Groups tab row's cell by column: Group 0 (the role's badge, then a gateway's name), Namespace 1, Published version 2, Variable group 3, Volumes 4, Replicas 5. */
function groupCell(page: Page, name: string, column: number): Locator {
  return groupRow(page, name).getByRole("cell").nth(column);
}

/** The Collectors grid's row of the collector named `name`. */
function collectorRow(page: Page, name: string): Locator {
  return page.locator("tbody tr").filter({ has: page.getByRole("button", { name, exact: true }) });
}

/** A Collectors grid row's cell by column, on a Kubernetes fleet: Name 1, IP Address 2, Group 3 (the role's badge, then a gateway's name), Variable group 4, Status 5, Configuration 6, Version 7, Last seen 8. */
function collectorCell(page: Page, name: string, column: number): Locator {
  return collectorRow(page, name).locator("td").nth(column);
}

/** Picks `option` in the Select named `name`, within `scope`. */
async function choose(page: Page, scope: Locator, name: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** Picks the configuration's version 1 in a group dialog's published version picker. */
async function pickVersion(page: Page, dialog: Locator, configurationName: string): Promise<void> {
  await choose(page, dialog, "Configuration", configurationName);
  await expect(dialog.getByRole("combobox", { name: "Version", exact: true })).toHaveText(/@v1/);
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

test("a new Kubernetes fleet shows the Agent and the Cluster, neither deletable; the Cluster's Assign creates `cluster`, the Agent's saves its namespace and a volume; the Cluster's Edit warns of a namespace change", async ({
  page,
}) => {
  const { user, organizationId, fleetId, defaultGroupId } = await signedInWithKubernetesFleet(page);
  const canary = unique();
  const configurationName = `k8s-otel-${canary}`;
  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  await openGroups(page, fleetId);
  const panel = page.getByRole("tabpanel");

  // Both rows at once, the Cluster before its group exists; nothing deletable, nothing assigned.
  await expectShownRows(page, ["Agent", "Cluster"]);
  // One Group column: the Agent and the Cluster their badge alone.
  await expect(groupCell(page, "Agent", 0)).toHaveText("Agent");
  await expect(groupCell(page, "Cluster", 0)).toHaveText("Cluster");
  for (const role of ["Agent", "Cluster"]) {
    await expect(groupRow(page, role)).toContainText("Nothing assigned");
    await expect(panel.getByRole("button", { name: `Assign ${role}`, exact: true })).toBeVisible();
  }
  await expect(panel.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
  const writes = recordWrites(page);

  // The Cluster's Assign: one POST named `cluster`, its settings under telflo.kubernetes.
  await panel.getByRole("button", { name: "Assign Cluster", exact: true }).click();
  const cluster = page.getByRole("dialog", { name: "Assign a published version to Cluster" });
  await expect(cluster.getByLabel("Namespace", { exact: true })).toHaveValue(DEFAULT_NAMESPACE);
  await expect(cluster.getByLabel("Replicas", { exact: true })).toHaveCount(0);
  await expect(cluster.getByLabel("Gateway name", { exact: true })).toHaveCount(0);
  await expect(cluster.getByRole("button", { name: "Assign", exact: true })).toBeDisabled();
  await pickVersion(page, cluster, configurationName);
  // A recipe: the node's path at the same path, read-only; the common paths a disclosure, closed at the opening.
  const recipesToggle = cluster.getByRole("button", { name: "Common Volume Paths", exact: true });
  await expect(recipesToggle).toHaveAttribute("aria-expanded", "false");
  // The panel by the toggle's aria-controls (a role query skips hidden elements, so it couldn't show it hidden): there, hidden.
  const recipesPanel = cluster.locator(`[id="${await recipesToggle.getAttribute("aria-controls")}"]`);
  await expect(recipesPanel).toBeAttached();
  await expect(recipesPanel).toBeHidden();
  await recipesToggle.click();
  await expect(recipesToggle).toHaveAttribute("aria-expanded", "true");
  await expect(recipesPanel).toBeVisible();
  const recipes = cluster.getByRole("group", { name: "Common Volume Paths" });
  await recipes.getByRole("button", { name: /^\/var\/log\/journal / }).click();
  await expect(cluster.getByLabel("Host path", { exact: true })).toHaveValue("/var/log/journal");
  await expect(cluster.getByLabel("Mount path", { exact: true })).toHaveValue("/var/log/journal");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && GROUPS_PATH.test(new URL(response.url()).pathname));
  await cluster.getByRole("button", { name: "Assign", exact: true }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByText("Group created")).toBeVisible();
  await expect(cluster).toBeHidden();
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([
    [
      "POST",
      {
        name: "cluster",
        assignedVersionId: versionId,
        annotations: kubernetesAnnotations({
          role: "cluster",
          namespace: DEFAULT_NAMESPACE,
          volumes: [{ hostPath: "/var/log/journal", hostPathType: "Directory", mountPath: "/var/log/journal", readOnly: true }],
        }),
      },
    ],
  ]);
  // Its row now its group's: the version, the namespace, one volume, Edit; still no Delete.
  await expectShownRows(page, ["Agent", "Cluster"]);
  await expect(groupRow(page, "Cluster").getByRole("link", { name: `${configurationName} @v1` })).toBeVisible();
  await expect(groupCell(page, "Cluster", 1)).toHaveText(DEFAULT_NAMESPACE);
  await expect(groupCell(page, "Cluster", 4)).toHaveText("1");
  await expect(panel.getByRole("button", { name: "Edit Cluster", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Delete/ })).toHaveCount(0);

  // The Agent's Assign: a namespace and a volume of its own, one PATCH of the Default group, role node, no name.
  await expect(page.getByText("Group created")).toBeHidden();
  await panel.getByRole("button", { name: "Assign Agent", exact: true }).click();
  const agent = page.getByRole("dialog", { name: "Assign a published version to Agent" });
  // The Agent's recipes leave out the path its chart mounts itself.
  await agent.getByRole("button", { name: "Common Volume Paths", exact: true }).click();
  const agentRecipes = agent.getByRole("group", { name: "Common Volume Paths" });
  await expect(agentRecipes.getByRole("button", { name: /^\/var\/log\/journal / })).toBeVisible();
  await expect(agentRecipes.getByRole("button", { name: /^\/var\/log\/pods / })).toHaveCount(0);
  const namespace = `ns-${canary}`;
  const hostPath = `/data/host-${canary}`;
  const mountPath = `/mnt/mount-${canary}`;
  await pickVersion(page, agent, configurationName);
  await agent.getByLabel("Namespace", { exact: true }).fill(namespace);
  // A first save, nothing saved before: the Agent installs into the default namespace until then (the facts'), so
  // the warning names it, with telflo-node's uninstall there; the Agent's in the order Helm accepts, uninstall
  // first (its release owns the cluster-wide ClusterRole).
  await expect(
    agent.getByText(
      `A Helm release already installed keeps running in ${DEFAULT_NAMESPACE}: uninstall it there first, then install into ${namespace}. Helm refuses the new install while that release exists: it owns the Agent's cluster-wide role. The Agent's state is kept on each node, outside any namespace, so its collectors stay the same.`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect.poll(() => agent.getByRole("button", { name: "Copy uninstall command", exact: true }).locator("xpath=..").locator("code").textContent()).toBe(
    `helm uninstall 'telflo-node' -n '${DEFAULT_NAMESPACE}'`,
  );
  await agent.getByRole("button", { name: "Add volume", exact: true }).click();
  const host = agent.getByLabel("Host path", { exact: true });
  await expect(host).toBeFocused();
  await host.fill(hostPath);
  await agent.getByLabel("Mount path", { exact: true }).fill(mountPath);
  await choose(page, agent, "Type", "DirectoryOrCreate");
  await expect(agent.getByRole("checkbox", { name: "Read-only", exact: true })).toBeChecked();
  // The typed settings in no attribute but their own inputs' values, inside ph-no-capture.
  expect(await attributeHoldersOf(page, [namespace, hostPath, mountPath])).toEqual([[INPUT_VALUE], [INPUT_VALUE], [INPUT_VALUE]]);
  await agent.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(agent).toBeHidden();
  expect(writes).toHaveLength(2);
  const patch = writes[1]!;
  expect(patch.method()).toBe("PATCH");
  expect(new URL(patch.url()).pathname).toMatch(new RegExp(`/groups/${defaultGroupId}$`));
  const sent = patch.postDataJSON() as Record<string, unknown>;
  expect(sent).toEqual({
    assignedVersionId: versionId,
    annotations: kubernetesAnnotations({
      role: "node",
      namespace,
      volumes: [{ hostPath, hostPathType: "DirectoryOrCreate", mountPath, readOnly: true }],
    }),
  });
  expect(Object.hasOwn(sent, "name")).toBe(false);
  await expect(groupCell(page, "Agent", 1)).toHaveText(namespace);
  await expect(groupCell(page, "Agent", 4)).toHaveText("1");
  await expect(panel.getByRole("button", { name: "Edit Agent", exact: true })).toBeVisible();

  // Shown as text in the masked shell (the namespace) or not at all (the paths), in no attribute.
  expect(await placesOf(page, [namespace, hostPath, mountPath])).toEqual([
    { inside: 0, outside: 1, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
  ]);

  // The Cluster's Edit (its group has the published version its Assign gave it): a new namespace warns in the order
  // Helm accepts (uninstall first, its release owns the cluster-wide role) and what happens to its collector (its state
  // stays on its volume in the old namespace), with telflo-cluster's uninstall there.
  await expect(page.getByText("Group updated")).toBeHidden();
  await panel.getByRole("button", { name: "Edit Cluster", exact: true }).click();
  const clusterEdit = page.getByRole("dialog", { name: "Edit Cluster" });
  const clusterNamespace = clusterEdit.getByLabel("Namespace", { exact: true });
  await expect(clusterNamespace).toHaveValue(DEFAULT_NAMESPACE);
  await expect(clusterEdit.getByText(/^A Helm release already installed/)).toHaveCount(0);
  const clusterMoved = `cl-${canary}`;
  await clusterNamespace.fill(clusterMoved);
  const clusterWarning = `A Helm release already installed keeps running in ${DEFAULT_NAMESPACE}: uninstall it there first, then install into ${clusterMoved}. Helm refuses the new install while that release exists: it owns the Cluster's cluster-wide role. The Cluster's state stays on its volume in ${DEFAULT_NAMESPACE}, so in ${clusterMoved} it enrolls again as a new collector (the old one goes offline).`;
  await expect(clusterEdit.getByText(clusterWarning, { exact: true })).toBeVisible();
  await expect(clusterNamespace).toHaveAccessibleDescription(clusterWarning);
  const clusterUninstall = `helm uninstall 'telflo-cluster' -n '${DEFAULT_NAMESPACE}'`;
  await expect
    .poll(() => clusterEdit.getByRole("button", { name: "Copy uninstall command", exact: true }).locator("xpath=..").locator("code").textContent())
    .toBe(clusterUninstall);
  // The warning and the command as text inside ph-no-capture only; the new namespace in no attribute but the input's value.
  expect(await placesOf(page, [clusterWarning, clusterUninstall])).toEqual([
    { inside: 1, outside: 0, inAttributes: 0 },
    { inside: 1, outside: 0, inAttributes: 0 },
  ]);
  expect(await attributeHoldersOf(page, [clusterMoved])).toEqual([[INPUT_VALUE]]);
  // Closed unsaved: nothing written.
  await page.keyboard.press("Escape");
  await expect(clusterEdit).toBeHidden();
  expect(writes).toHaveLength(2);
});

test("adds a gateway with replicas and its address; its Edit warns of a namespace change; its typed-name delete deletes its collectors", async ({
  page,
}) => {
  const { user, organizationId, fleetId, defaultGroupId } = await signedInWithKubernetesFleet(page);
  const canary = unique();
  const configurationName = `gw-otel-${canary}`;
  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  await openGroups(page, fleetId);
  const panel = page.getByRole("tabpanel");
  const writes = recordWrites(page);

  // Add gateway: its name (prefilled), namespace and replicas; the address follows what is typed.
  await panel.getByRole("button", { name: "Add gateway", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add gateway" });
  const nameField = add.getByLabel("Gateway name", { exact: true });
  await expect(nameField).toHaveValue("gateway");
  await expect(add).toContainText("Apps send telemetry to:");
  await expect(add).toContainText(`http://gateway.${DEFAULT_NAMESPACE}.svc.cluster.local:4318`);
  const name = `gw-${canary}`;
  const namespace = `ns-${canary}`;
  await nameField.fill(name);
  await add.getByLabel("Namespace", { exact: true }).fill(namespace);
  await add.getByLabel("Replicas", { exact: true }).fill("3");
  await expect(add).toContainText(`http://${name}.${namespace}.svc.cluster.local:4318`);
  await expect(add).toContainText(`${name}.${namespace}.svc.cluster.local:4317`);
  await pickVersion(page, add, configurationName);
  // The name and namespace in no attribute but their inputs' values; the address as text inside ph-no-capture.
  expect(await attributeHoldersOf(page, [name, namespace])).toEqual([[INPUT_VALUE], [INPUT_VALUE]]);
  expect((await placesOf(page, [`${name}.${namespace}.svc.cluster.local`]))[0]).toEqual({ inside: 2, outside: 0, inAttributes: 0 });
  const created = page.waitForResponse((response) => response.request().method() === "POST" && GROUPS_PATH.test(new URL(response.url()).pathname));
  await add.getByRole("button", { name: "Create", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const { group } = (await response.json()) as { group: CollectorGroup };
  await expect(page.getByText("Group created")).toBeVisible();
  await expect(add).toBeHidden();
  const settings: KubernetesAnnotations = { role: "gateway", namespace, replicas: 3, volumes: [] };
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([
    ["POST", { name, assignedVersionId: versionId, annotations: kubernetesAnnotations(settings) }],
  ]);
  // Listed after the Agent and the Cluster: its role, name, namespace and replicas; Edit and Delete.
  await expectShownRows(page, ["Agent", "Cluster", name]);
  await expect(groupCell(page, name, 0)).toHaveText(`Gateway ${name}`);
  await expect(groupCell(page, name, 1)).toHaveText(namespace);
  await expect(groupCell(page, name, 5)).toHaveText("3");
  await expect(panel.getByRole("button", { name: `Delete ${name}`, exact: true })).toBeVisible();
  // A row now: the gateway's name and its namespace as the row's text only, in no attribute (its controls labeled by ids).
  expect(await attributeHoldersOf(page, [name, namespace])).toEqual([[], []]);

  // Its Edit: no name field (it can't change); a new namespace warns that an installed release stays in the old one.
  await expect(page.getByText("Group created")).toBeHidden();
  await panel.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(edit.getByLabel("Gateway name", { exact: true })).toHaveCount(0);
  const namespaceField = edit.getByLabel("Namespace", { exact: true });
  await expect(namespaceField).toHaveValue(namespace);
  await expect(edit.getByLabel("Replicas", { exact: true })).toHaveValue("3");
  await expect(edit.getByText(/^A Helm release already installed/)).toHaveCount(0);
  const moved = `ns2-${canary}`;
  await namespaceField.fill(moved);
  const warning = `A Helm release already installed keeps running in ${namespace}: uninstall it there after installing into ${moved}. Its pods come back in ${moved} as new collectors (the old ones go offline).`;
  await expect(edit.getByText(warning, { exact: true })).toBeVisible();
  await expect(namespaceField).toHaveAccessibleDescription(warning);
  await expect(edit).toContainText(`http://${name}.${moved}.svc.cluster.local:4318`);
  // The warning repeats both namespaces as text inside ph-no-capture; the namespaces in no attribute but the input's value.
  expect(await attributeHoldersOf(page, [moved])).toEqual([[INPUT_VALUE]]);
  expect((await placesOf(page, [warning]))[0]).toEqual({ inside: 1, outside: 0, inAttributes: 0 });
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Group updated")).toBeVisible();
  await expect(edit).toBeHidden();
  // One PATCH of the settings alone (the version unchanged), never a name.
  expect(writes.map((request) => request.method())).toEqual(["POST", "PATCH"]);
  expect(new URL(writes[1]!.url()).pathname).toMatch(new RegExp(`/groups/${group.id}$`));
  expect(writes[1]!.postDataJSON()).toEqual({ annotations: kubernetesAnnotations({ ...settings, namespace: moved }) });
  await expect(groupCell(page, name, 1)).toHaveText(moved);

  // Two pods of the gateway, one of the Agent's.
  const doomed = await Promise.all(
    ["a", "b"].map((pod) =>
      enrollKubernetesPod(organizationId, fleetId, { name: `${name}-${pod}`, groupId: group.id, nodeName: `node-${canary}`, namespace: moved }),
    ),
  );
  const kept = await enrollKubernetesPod(organizationId, fleetId, {
    name: `agent-${canary}`,
    groupId: defaultGroupId,
    nodeName: `node-${canary}`,
    namespace: DEFAULT_NAMESPACE,
  });

  // The typed-name delete: the Helm line; Delete disabled until the name is typed exactly.
  await expect(page.getByText("Group updated")).toBeHidden();
  await panel.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: `Delete ${name}` });
  await expect(dialog).toContainText(`${DELETE_CONSEQUENCES} ${DELETE_HELM}`);
  const confirm = dialog.getByLabel(deleteConfirmLabel(name), { exact: true });
  const remove = dialog.getByRole("button", { name: "Delete", exact: true });
  await expect(confirm).toHaveValue("");
  await expect(remove).toBeDisabled();
  for (const wrong of [name.slice(0, -1), name.toUpperCase(), `${name}x`]) {
    await confirm.fill(wrong);
    await expect(remove).toBeDisabled();
  }
  await confirm.fill(name);
  await expect(remove).toBeEnabled();
  // The typed text in no attribute: the input is uncontrolled, inside ph-no-capture.
  await expect(confirm).not.toHaveAttribute("value");
  await expect(dialog.locator(".ph-no-capture").getByLabel(deleteConfirmLabel(name), { exact: true })).toBeVisible();
  // The name shown bold in the label, inside ph-no-capture with the input; no placeholder.
  await expect(dialog.locator(".ph-no-capture label .font-bold")).toHaveText(name);
  await expect(confirm).not.toHaveAttribute("placeholder");
  // Nor the namespace, nor the name the typed text matches (the row's, the title's text).
  expect(await attributeHoldersOf(page, [moved, name])).toEqual([[], []]);
  await remove.click();
  await expect(page.getByText("Group deleted")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expectShownRows(page, ["Agent", "Cluster"]);
  expect(writes.map((request) => request.method())).toEqual(["POST", "PATCH", "DELETE"]);
  expect(new URL(writes[2]!.url()).pathname).toMatch(new RegExp(`/groups/${group.id}$`));

  // The gateway's collectors are deleted with it; the Agent's stays.
  const remaining = await collectorsThroughApi(page, organizationId, fleetId);
  expect(remaining.map((each) => each.id)).toEqual([kept.id]);
  expect(doomed.map((each) => remaining.some((left) => left.id === each.id))).toEqual([false, false]);
});

test("collectors of each role: the one Group column, the Node row in the details, the canary note in Edit and bulk pin, no name, namespace or node in an attribute", async ({
  page,
}) => {
  const { organizationId, fleetId, defaultGroupId } = await signedInWithKubernetesFleet(page);
  const canary = unique();
  const gatewayName = `gw-${canary}`;
  const namespace = `ns-${canary}`;
  const nodeName = `node-${canary}`;
  const clusterGroup = await createGroupThroughApi(page, organizationId, fleetId, "cluster", {
    annotations: kubernetesAnnotations({ role: "cluster", namespace, volumes: [] }),
  });
  const gateway = await createGroupThroughApi(page, organizationId, fleetId, gatewayName, {
    annotations: kubernetesAnnotations({ role: "gateway", namespace, replicas: 2, volumes: [] }),
  });
  const agentPod = `agent-${canary}`;
  const clusterPod = `cluster-${canary}`;
  const gatewayPod = `${gatewayName}-0`;
  for (const [name, groupId] of [
    [agentPod, defaultGroupId],
    [clusterPod, clusterGroup.id],
    [gatewayPod, gateway.id],
  ] as const) {
    await enrollKubernetesPod(organizationId, fleetId, { name, groupId, nodeName, namespace });
  }
  await openCollectors(page, fleetId);

  // One Group column, where a server fleet's is: the role's badge, then a gateway's name.
  await expect(page.getByRole("columnheader")).toHaveText([
    "",
    "Name",
    "IP Address",
    "Group",
    "Variable group",
    "Status",
    "Configuration",
    "Version",
    "Last seen",
    "Actions",
  ]);
  await expect(collectorCell(page, agentPod, 3)).toHaveText("Agent");
  await expect(collectorCell(page, clusterPod, 3)).toHaveText("Cluster");
  await expect(collectorCell(page, gatewayPod, 3)).toHaveText(`Gateway ${gatewayName}`);
  // Status the pod's liveness (just enrolled: Online), Configuration its sync (nothing assigned), Last seen plain text, no dot.
  for (const pod of [agentPod, clusterPod, gatewayPod]) {
    await expect(collectorCell(page, pod, 5)).toHaveText("Online (online: seen in the last minute)");
    await expect(collectorCell(page, pod, 6)).toHaveText(/^Nothing assigned \(nothing assigned: /);
    await expect(collectorCell(page, pod, 8)).toHaveText(/^\d+ seconds? ago \(/);
    await expect(collectorCell(page, pod, 8).locator("[aria-hidden='true']")).toHaveCount(0);
  }
  // The node and the namespace aren't in the grid; the gateway's name is text in the masked shell; none in an attribute.
  expect(await placesOf(page, [gatewayName, namespace, nodeName])).toEqual([
    // Its column's cell, and its pod's name (gw-…-0) in the name button and the row's hidden Select/Edit/Delete labels.
    { inside: 0, outside: 5, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
    { inside: 0, outside: 0, inAttributes: 0 },
  ]);

  // The details: the Node row after UID, inside ph-no-capture; the Group row names the Agent by its role.
  await collectorRow(page, agentPod).getByRole("button", { name: agentPod, exact: true }).click();
  const details = page.getByRole("dialog", { name: agentPod });
  const node = details.getByText("Node", { exact: true }).locator("xpath=following-sibling::div[1]");
  await expect(node).toHaveText(nodeName);
  await expect(node.locator(".ph-no-capture")).toHaveText(nodeName);
  await expect(details.getByText("Group", { exact: true }).locator("xpath=following-sibling::div[1]")).toHaveText("Agent");
  // Each row a label and its value, side by side: the Node's label comes right after the UID's value.
  await expect(details.getByText("UID", { exact: true }).locator("xpath=following-sibling::div[2]")).toHaveText("Node");
  // The node name as text inside ph-no-capture only (the Node row, the reported attributes), in no attribute.
  expect(await placesOf(page, [nodeName, namespace])).toEqual([
    { inside: 2, outside: 0, inAttributes: 0 },
    { inside: 1, outside: 0, inAttributes: 0 },
  ]);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // Edit: the Group select names the Agent, the Cluster, then the gateway; the canary note describes the Pin select.
  await page.getByRole("button", { name: `Edit ${agentPod}`, exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit collector" });
  const groupSelect = edit.getByRole("combobox", { name: "Group", exact: true });
  await expect(groupSelect).toHaveText("Agent");
  await expect(edit.getByRole("combobox", { name: "Pin", exact: true })).toHaveAccessibleDescription(PIN_NOTE);
  await expect(edit.getByText(PIN_NOTE, { exact: true })).toBeVisible();
  await groupSelect.click();
  await expect(page.getByRole("option")).toHaveText(["Agent", "Cluster", gatewayName]);
  expect((await placesOf(page, [gatewayName]))[0]!.inAttributes).toBe(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden();

  // Bulk pin: the same note under its Published version select (the Version choice).
  await page.getByRole("checkbox", { name: `Select ${clusterPod}` }).click();
  await page.getByRole("checkbox", { name: `Select ${gatewayPod}` }).click();
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Pin selected collectors" }).click();
  const bulk = page.getByRole("dialog", { name: "Pin collectors" });
  await expect(bulk.getByRole("combobox", { name: "Published version", exact: true })).toHaveAccessibleDescription(PIN_NOTE);
  await expect(bulk.getByText(PIN_NOTE, { exact: true })).toBeVisible();
  expect((await placesOf(page, [gatewayName, namespace, nodeName])).map((each) => each.inAttributes)).toEqual([0, 0, 0]);
  await page.keyboard.press("Escape");
  await expect(bulk).toBeHidden();
});

// On a Kubernetes-supervisor fleet: the group dialog's Variable group, created with the group and cleared.
test("the Cluster's Assign creates its group with the variable group chosen; its column names it; its Edit's None sends null", async ({ page }) => {
  const { user, organizationId, fleetId } = await signedInWithKubernetesFleet(page);
  const canary = unique();
  const configurationName = `k8s-vars-${canary}`;
  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, configurationName);
  const variableGroupName = `cluster-values-${canary}`;
  const variableGroup = await createVariableGroupThroughApi(page, organizationId, variableGroupName);
  await openGroups(page, fleetId);
  const panel = page.getByRole("tabpanel");
  await expect(groupCell(page, "Agent", 3)).toHaveText("Organization values");
  const writes = recordWrites(page);

  await panel.getByRole("button", { name: "Assign Cluster", exact: true }).click();
  const cluster = page.getByRole("dialog", { name: "Assign a published version to Cluster" });
  await pickVersion(page, cluster, configurationName);
  const select = cluster.getByRole("combobox", { name: "Variable group", exact: true });
  await expect(select).toHaveText("None (organization values)");
  await choose(page, cluster, "Variable group", variableGroupName);
  // The name inside ph-no-capture, in no attribute.
  await expect(select).toHaveClass(/(^|\s)ph-no-capture(\s|$)/);
  expect(await attributeHoldersOf(page, [variableGroupName])).toEqual([[]]);
  // As text, inside ph-no-capture only: the trigger's value and the hidden native <select>'s option Radix renders in the form.
  expect(await placesOf(page, [variableGroupName])).toEqual([{ inside: 2, outside: 0, inAttributes: 0 }]);
  await cluster.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByText("Group created")).toBeVisible();
  await expect(cluster).toBeHidden();
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])).toEqual([
    [
      "POST",
      {
        name: "cluster",
        assignedVersionId: versionId,
        annotations: kubernetesAnnotations({ role: "cluster", namespace: DEFAULT_NAMESPACE, volumes: [] }),
        variableGroupId: variableGroup.id,
      },
    ],
  ]);
  await expect(groupCell(page, "Cluster", 3)).toHaveText(variableGroupName);
  await expect(groupCell(page, "Agent", 3)).toHaveText("Organization values");
  expect(await placesOf(page, [variableGroupName])).toEqual([{ inside: 1, outside: 0, inAttributes: 0 }]);

  // Its details' Variable group row (default 25): the group's.
  await panel.getByRole("button", { name: "More about Cluster", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Cluster" });
  await expect(details.getByText("Variable group", { exact: true }).locator("xpath=following-sibling::div[1]")).toHaveText(variableGroupName);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // Its Edit opens on it; None sends null, alone. The toast's timer pauses
  // while the pointer rests on it (sonner), which in WebKit's layout is where
  // the closed dialog left the pointer: move it away before waiting.
  await page.mouse.move(0, 0);
  await expect(page.getByText("Group created")).toBeHidden();
  await panel.getByRole("button", { name: "Edit Cluster", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit Cluster" });
  await expect(edit.getByRole("combobox", { name: "Variable group", exact: true })).toHaveText(variableGroupName);
  await choose(page, edit, "Variable group", "None (organization values)");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(groupCell(page, "Cluster", 3)).toHaveText("Organization values");
  expect(writes.map((request) => [request.method(), request.postDataJSON() as unknown])[1]).toEqual(["PATCH", { variableGroupId: null }]);
  expect(writes).toHaveLength(2);
  expect(((await groupsThroughApi(page, organizationId, fleetId)).find((group) => group.name === "cluster"))?.variableGroupId).toBeNull();
});

/** The fleet's collector groups, read through the API. */
async function groupsThroughApi(page: Page, organizationId: string, fleetId: string): Promise<CollectorGroup[]> {
  const response = await page.request.get(`/api/v1/organizations/${organizationId}/fleets/${fleetId}/groups`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { groups: CollectorGroup[] }).groups;
}
