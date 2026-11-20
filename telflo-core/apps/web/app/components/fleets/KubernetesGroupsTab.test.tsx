import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type CollectorGroup, type Configuration } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { FLEETS_POLL_INTERVAL_MS } from "~/lib/fleets.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember, THEIRS } from "~/test/configurations.js";
import {
  clusterGroup,
  CLUSTER_GROUP_ID,
  collectorGroup,
  configurationVersionListItem,
  CONFIGURATION_ID,
  expectNoAttributeHolds,
  expectNoAttributeHoldsInOpenTooltips,
  FLEET_ID,
  fleetDetail,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  kubernetesAnnotations,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  SECOND_GATEWAY_GROUP_ID,
  serveNoVariables,
} from "~/test/fleets.js";
import { GROUP_DELETE_CONSEQUENCES, GROUP_DELETE_HELM, groupDeleteConfirmLabel } from "./DeleteGroupDialog.js";
import { SETTINGS_CHANGED_MESSAGE } from "./KubernetesGroupDialog.js";
import { KUBERNETES_GROUPS_INTRO, KubernetesGroupsTab } from "./KubernetesGroupsTab.js";
import { KUBERNETES_ROLE_HELP, KUBERNETES_ROLE_HELP_LABELS } from "./KubernetesGroupsTable.js";

/*
 * A Kubernetes-supervisor fleet's Groups tab over the real hook
 * (`useGroupsTab`), the browser client's calls answered by a small fake of
 * the API's groups: the Agent and Cluster rows drawn from the start (the
 * Cluster before its group exists), neither with Delete; a gateway's row
 * with Delete; Assign on the Cluster creating it; Add gateway; Edit's
 * prefill; the role help; the details; the typed-name delete.
 */

const GONE = () => new ApiError("fleet_not_found", "Fleet not found.", { status: 404 });
const UNAVAILABLE = () => new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
const NEW_GROUP_ID = "c0ffee00-0000-4000-8000-0000000000e9";
const V5_ID = "c0ffee00-0000-4000-8000-000000000005";
const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };

/** The gateway "gateways" with its settings: namespace edge, 3 replicas, one volume. */
const gateways = (overrides: Partial<CollectorGroup> = {}) =>
  gatewaysGroup({
    annotations: kubernetesAnnotations({
      namespace: "edge",
      replicas: 3,
      volumes: [{ hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/var/log/app", readOnly: true }],
    }),
    ...overrides,
  });

interface Api {
  groups: CollectorGroup[];
  failures: unknown[];
  hold: Promise<void> | null;
}

let api: Api;

function ordered(groups: CollectorGroup[]): CollectorGroup[] {
  return [...groups].sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1));
}

function serve() {
  serveNoVariables();
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async () => {
    if (api.hold !== null) await api.hold;
    const failure = api.failures.shift();
    if (failure !== undefined) throw failure;
    return { groups: ordered(api.groups) };
  });
  vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [CHECKOUT], nextCursor: null });
  vi.spyOn(apiClient, "getConfigurationVersions").mockResolvedValue({
    versions: [configurationVersionListItem({ id: V5_ID, versionNumber: 5 }), configurationVersionListItem()],
  });
  const assignment = (versionId: string | null | undefined) =>
    versionId === undefined
      ? {}
      : versionId === null
        ? { assignedPublishedVersionId: null, assignedVersion: null }
        : { assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion({ versionId, versionNumber: versionId === V5_ID ? 5 : 4 }) };
  const createCollectorGroup = vi.spyOn(apiClient, "createCollectorGroup").mockImplementation(async (_organizationId, _fleetId, request) => {
    const made = collectorGroup({
      id: request.name === "cluster" ? CLUSTER_GROUP_ID : NEW_GROUP_ID,
      name: request.name,
      isDefault: false,
      annotations: request.annotations ?? null,
      ...assignment(request.assignedVersionId),
    });
    api.groups = [...api.groups, made];
    return made;
  });
  const updateCollectorGroup = vi.spyOn(apiClient, "updateCollectorGroup").mockImplementation(async (_organizationId, _fleetId, groupId, request) => {
    const index = api.groups.findIndex((group) => group.id === groupId);
    api.groups[index] = {
      ...api.groups[index]!,
      ...(request.annotations === undefined ? {} : { annotations: request.annotations }),
      ...assignment(request.assignedVersionId),
    };
    return api.groups[index]!;
  });
  const deleteCollectorGroup = vi.spyOn(apiClient, "deleteCollectorGroup").mockImplementation(async (_organizationId, _fleetId, groupId) => {
    api.groups = api.groups.filter((group) => group.id !== groupId);
    return undefined;
  });
  return { getCollectorGroups, createCollectorGroup, updateCollectorGroup, deleteCollectorGroup };
}

const onFleetGone = vi.fn();
const onFleetChanged = vi.fn();

function renderTab(label = "prod", extra: Partial<Parameters<typeof KubernetesGroupsTab>[0]> = {}) {
  const fleet = fleetDetail({ type: "kubernetes-supervisor", label });
  const Stub = createRoutesStub([
    { path: "/", Component: () => <KubernetesGroupsTab fleet={fleet} onFleetGone={onFleetGone} onFleetChanged={onFleetChanged} {...extra} /> },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

async function poll(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
}

type User = ReturnType<typeof userEvent.setup>;

const button = (name: string) => screen.getByRole("button", { name });
const rowOf = (name: string) => button(`More about ${name}`).closest("tr") as HTMLElement;
const rowTexts = () =>
  screen
    .getAllByRole("row", { hidden: true })
    .slice(1)
    .map((row) => [...row.querySelectorAll("td")].slice(0, 6).map((cell) => cell.textContent));

async function pickVersion(user: User, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole("combobox", { name: "Configuration" }));
  await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
  await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v5"));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  onFleetGone.mockClear();
  onFleetChanged.mockClear();
  api = { groups: [collectorGroup(), gateways()], failures: [], hold: null };
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

describe("KubernetesGroupsTab's states", () => {
  it('shows "Loading groups…" until the first read answers, then the rows', async () => {
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    serve();
    renderTab();
    expect(await screen.findByText("Loading groups…")).toBeInTheDocument();
    api.hold = null;
    await act(async () => release());
    expect(await screen.findByText("gateways")).toBeInTheDocument();
  });

  it('shows a failed first load ("Failed to load groups") with Try again, which reads again', async () => {
    api.failures = [UNAVAILABLE()];
    const { getCollectorGroups } = serve();
    const user = renderTab();
    expect(await screen.findByText("Failed to load groups")).toBeInTheDocument();
    await user.click(button("Try again"));
    expect(await screen.findByText("gateways")).toBeInTheDocument();
    expect(getCollectorGroups).toHaveBeenCalledTimes(2);
  });

  it("calls onFleetGone on a fleet found gone, with no toast", async () => {
    api.failures = [GONE()];
    const error = vi.spyOn(toast, "error");
    serve();
    renderTab();
    await waitFor(() => expect(onFleetGone).toHaveBeenCalledTimes(1));
    expect(error).not.toHaveBeenCalled();
  });

  it('shows the intro, "Add gateway" and "Refresh groups", in their exact words', async () => {
    serve();
    renderTab();
    await screen.findByText("gateways");
    expect(KUBERNETES_GROUPS_INTRO).toBe(
      "Each group is a Helm-installed collector workload: Agent runs one collector on each node, Cluster one pod for cluster-wide metrics, and each gateway pool a set of collectors that receive telemetry from the others. Collectors pick up their group's published version on their next poll.",
    );
    expect(screen.getByText(KUBERNETES_GROUPS_INTRO)).toBeInTheDocument();
    expect(button("Add gateway")).toBeEnabled();
    expect(button("Refresh groups")).toBeEnabled();
    expect(document.body).not.toHaveTextContent(/deploy group|deployment|Default|New group|\binstall\b/i);
  });
});

describe("KubernetesGroupsTab's rows", () => {
  it("draws the Agent, the Cluster before its group exists, then the gateways in the API's order, with each column", async () => {
    api.groups = [collectorGroup(), gateways(), gatewaysGroup({ id: SECOND_GATEWAY_GROUP_ID, name: "alpha", annotations: null })];
    serve();
    renderTab();
    await screen.findByText("gateways");
    expect(screen.getAllByRole("columnheader").map((each) => each.textContent)).toEqual([
      "Group",
      "Namespace",
      "Published version",
      "Variable group",
      "Volumes",
      "Replicas",
      "More",
      "Actions",
    ]);
    expect(rowTexts()).toEqual([
      ["Agent", "—", expect.stringMatching(/^Nothing assigned/), "Organization values", "—", "—"],
      ["Cluster", "—", expect.stringMatching(/^Nothing assigned/), "Organization values", "—", "—"],
      ["Gateway alpha", "—", "checkout-otel @v4", "Organization values", "—", "—"],
      ["Gateway gateways", "edge", "checkout-otel @v4", "Organization values", "1", "3"],
    ]);
  });

  it("names each row's actions by Agent, Cluster or the gateway's name: Assign or Edit, More, and Delete on a gateway only", async () => {
    api.groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }), gateways()];
    serve();
    renderTab();
    await screen.findByText("gateways");
    expect(within(rowOf("Agent")).getAllByRole("button").map((each) => each.textContent)).toEqual(["", "Organization values", "More", "Edit"]);
    expect(button("Edit Agent").className).not.toContain("bg-primary");
    expect(within(rowOf("Cluster")).getAllByRole("button").map((each) => each.textContent)).toEqual(["", "Organization values", "More", "Assign"]);
    expect(button("Assign Cluster").className).toContain("bg-primary");
    expect(within(rowOf("gateways")).getAllByRole("button").map((each) => each.textContent)).toEqual([
      "",
      "Organization values",
      "More",
      "Edit",
      "Delete",
    ]);
    expect(button("Delete gateways")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete (Agent|Cluster)$/ })).toBeNull();
  });

  it("gives the Cluster's group, once it exists, no Delete either, and reads roles from the group, never the stored role", async () => {
    api.groups = [
      collectorGroup({ annotations: kubernetesAnnotations({ role: "cluster", replicas: undefined }) }),
      clusterGroup({ annotations: kubernetesAnnotations({ role: "cluster", namespace: "obs", replicas: undefined }) }),
      gateways(),
    ];
    serve();
    renderTab();
    await screen.findByText("gateways");
    expect(rowTexts().map((cells) => cells[0])).toEqual(["Agent", "Cluster", "Gateway gateways"]);
    // The Agent's stored role is another's: the row is still the Agent's (its settings shown, its next save writes node).
    expect(rowTexts()[0]!.slice(1)).toEqual(["telflo-collectors", expect.stringMatching(/^Nothing assigned/), "Organization values", "0", "—"]);
    expect(rowTexts()[1]![1]).toBe("obs");
    expect(within(rowOf("Cluster")).queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("shows dashes for a gateway's settings Telflo can't read (replicas past 1,000), its role still a gateway's", async () => {
    api.groups = [collectorGroup(), gateways({ annotations: { telflo: { kubernetes: { role: "gateway", namespace: "edge", replicas: 5000, volumes: [] } } } })];
    serve();
    renderTab();
    await screen.findByText("gateways");
    expect(rowTexts()[2]).toEqual(["Gateway gateways", "—", "checkout-otel @v4", "Organization values", "—", "—"]);
  });

  it("opens each role's help: fixed labels, the Cluster's a StatefulSet", async () => {
    serve();
    const user = renderTab();
    await screen.findByText("gateways");
    expect(KUBERNETES_ROLE_HELP_LABELS).toEqual({ node: "What is an Agent?", cluster: "What is a Cluster?", gateway: "What is a Gateway?" });
    for (const role of ["node", "cluster", "gateway"] as const) {
      const trigger = button(KUBERNETES_ROLE_HELP_LABELS[role]);
      expect(trigger).toHaveAttribute("title", KUBERNETES_ROLE_HELP_LABELS[role]);
      await user.click(trigger);
      expect(await screen.findByText(KUBERNETES_ROLE_HELP[role])).toBeInTheDocument();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByText(KUBERNETES_ROLE_HELP[role])).toBeNull());
    }
    expect(KUBERNETES_ROLE_HELP.cluster).toBe(
      "Runs as a single-replica StatefulSet: one collector for the cluster. Collects cluster-wide telemetry such as Kubernetes events and cluster-level metrics.",
    );
    expect(KUBERNETES_ROLE_HELP.node).toBe(
      "Runs as a DaemonSet: one collector on each node. Collects node-local telemetry such as host metrics and container and pod logs, and data from the workloads on that node.",
    );
    expect(KUBERNETES_ROLE_HELP.gateway).toBe(
      "A pool of collectors that receive telemetry from the Agent and Cluster collectors, then process it and export it to your backends.",
    );
  });
});

describe("KubernetesGroupsTab's dialogs", () => {
  it("opens a row's More: the details, the Cluster's id a dash before its group exists", async () => {
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "More about gateways" }));
    let dialog = await screen.findByRole("dialog", { name: "gateways" });
    expect(within(dialog).getByText("Group details")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("GroupGateway gatewaysNamespaceedge");
    expect(dialog).toHaveTextContent("/var/log/app → /var/log/app (Directory, read-only)");
    expect(dialog).toHaveTextContent("Replicas3");
    expect(within(dialog).getByText(GATEWAYS_GROUP_ID)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(button("More about Cluster"));
    dialog = await screen.findByRole("dialog", { name: "Cluster" });
    expect(dialog).toHaveTextContent("GroupClusterNamespace—Published versionNothing assigned");
    expect(dialog).toHaveTextContent("Replicas—Collector Group ID—");
    expect(within(dialog).queryByRole("button", { name: "Copy collector group id" })).toBeNull();
  });

  it("assigns the Cluster before its group exists: one POST named cluster, the row then reads Edit", async () => {
    const { createCollectorGroup, updateCollectorGroup } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Assign Cluster" }));
    const dialog = await screen.findByRole("dialog", { name: "Assign a published version to Cluster" });
    await pickVersion(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createCollectorGroup).toHaveBeenCalledWith(
      GROUP_ID,
      FLEET_ID,
      { name: "cluster", assignedVersionId: V5_ID, annotations: { telflo: { kubernetes: { role: "cluster", namespace: "telflo-collectors", volumes: [] } } } },
      expect.anything(),
    );
    expect(updateCollectorGroup).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Edit Cluster" })).toBeInTheDocument();
    expect(rowTexts()[1]).toEqual(["Cluster", "telflo-collectors", "checkout-otel @v5", "Organization values", "0", "—"]);
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    // The row keeps its key across its first Assign: the focus goes back to the button that opened it, now its Edit.
    await waitFor(() => expect(document.activeElement).toBe(button("Edit Cluster")));
  });

  it("adds a gateway with its replicas; the row follows", async () => {
    const { createCollectorGroup } = serve();
    const user = renderTab();
    await screen.findByText("gateways");
    await user.click(button("Add gateway"));
    const dialog = await screen.findByRole("dialog", { name: "Add gateway" });
    const name = within(dialog).getByRole("textbox", { name: "Gateway name" });
    await user.clear(name);
    await user.type(name, "traces");
    const replicas = within(dialog).getByRole("spinbutton", { name: "Replicas" });
    await user.clear(replicas);
    await user.type(replicas, "2");
    await pickVersion(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createCollectorGroup.mock.calls[0]![2]).toEqual({
      name: "traces",
      assignedVersionId: V5_ID,
      annotations: { telflo: { kubernetes: { role: "gateway", namespace: "telflo-collectors", replicas: 2, volumes: [] } } },
    });
    expect(await screen.findByRole("button", { name: "More about traces" })).toBeInTheDocument();
    expect(rowTexts()[3]).toEqual(["Gateway traces", "telflo-collectors", "checkout-otel @v5", "Organization values", "0", "2"]);
  });

  it("edits a gateway: prefilled, the namespace warning, saved with the settings", async () => {
    const { updateCollectorGroup } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Edit gateways" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit gateways" });
    const namespace = within(dialog).getByRole("textbox", { name: "Namespace" });
    expect(namespace).toHaveValue("edge");
    await user.clear(namespace);
    await user.type(namespace, "obs");
    expect(dialog).toHaveTextContent("A Helm release already installed keeps running in edge: uninstall it there after installing into obs.");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateCollectorGroup.mock.calls[0]![3]).toEqual({
      annotations: kubernetesAnnotations({
        namespace: "obs",
        replicas: 3,
        volumes: [{ hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/var/log/app", readOnly: true }],
      }),
    });
    await waitFor(() => expect(rowTexts()[2]![1]).toBe("obs"));
  });

  it("deletes a gateway once its name is typed, with the Helm release's words, then reloads the groups and the fleet", async () => {
    const { getCollectorGroups, deleteCollectorGroup } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Delete gateways" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete gateways" });
    expect(dialog).toHaveTextContent(`${GROUP_DELETE_CONSEQUENCES} ${GROUP_DELETE_HELM}`);
    const confirm = within(dialog).getByLabelText(groupDeleteConfirmLabel("gateways"));
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    await user.type(confirm, "gateway");
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    await user.type(confirm, "s");
    const reads = getCollectorGroups.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteCollectorGroup).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.anything());
    await waitFor(() => expect(getCollectorGroups).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("gateways")).toBeNull());
    // The focus goes to the first row's button, the Agent's.
    await waitFor(() => expect(document.activeElement).toBe(button("Assign Agent")));
  });

  it.each([
    ["the details", "More about Agent", "dialog"],
    ["the assign", "Assign Cluster", "dialog"],
    ["the edit", "Edit gateways", "dialog"],
    ["Add gateway", "Add gateway", "dialog"],
    ["the delete", "Delete gateways", "alertdialog"],
  ] as const)("returns the focus to the opener after %s closes by Escape, and closes it when the organization changes", async (_which, opener, role) => {
    serve();
    const user = renderTab();
    await screen.findByText("gateways");
    await user.click(button(opener));
    await screen.findByRole(role);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button(opener)));

    await user.click(button(opener));
    await screen.findByRole(role);
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
  });

  it("pauses the polls while a dialog is open", async () => {
    const { getCollectorGroups } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Edit gateways" }));
    await screen.findByRole("dialog");
    const reads = getCollectorGroups.mock.calls.length;
    await poll();
    expect(getCollectorGroups).toHaveBeenCalledTimes(reads);
  });

  it("keeps an open dialog's snapshot while the tab reads its groups again under it", async () => {
    const calls = serve();
    const user = renderTab();
    await screen.findByText("gateways");
    // Another member saves the gateway's settings; the tab hasn't polled.
    api.groups = [collectorGroup(), gateways({ annotations: kubernetesAnnotations({ namespace: "theirs", replicas: 7 }) })];
    await user.click(button("Edit gateways"));
    const dialog = await screen.findByRole("dialog", { name: "Edit gateways" });
    const replicas = within(dialog).getByRole("spinbutton", { name: "Replicas" });
    await user.clear(replicas);
    await user.type(replicas, "4");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(SETTINGS_CHANGED_MESSAGE)).toBeInTheDocument();
    // The tab's re-read (after the save's own) lands while the dialog is open: the rows follow, the dialog doesn't.
    await waitFor(() => expect(calls.getCollectorGroups).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(rowTexts()[2]![1]).toBe("theirs"));
    expect(within(dialog).getByRole("textbox", { name: "Namespace" })).toHaveValue("edge");
    // A second save still compares against the opening's settings: refused again, nothing written.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.getCollectorGroups).toHaveBeenCalledTimes(5));
    expect(calls.updateCollectorGroup).not.toHaveBeenCalled();
  });
});

// No gateway name, namespace, path, fleet label or typed text in any attribute.
describe("KubernetesGroupsTab's privacy", () => {
  it("holds no gateway name, namespace, path, configuration name or typed text in an attribute: rows, tooltips, help, each dialog open", async () => {
    const gatewayName = "canary-gw-5e21";
    const namespace = "canary-ns-a0c3";
    const agentNamespace = "canary-agent-ns-77de";
    const hostPath = "/srv/canary-host-d9b4";
    const mountPath = "/canary-mount-31f0";
    const configurationName = "canary-configuration-08bb";
    const fleetLabel = "canary-fleet-4c1a";
    const typed = "canary-gw-5e2";
    api.groups = [
      collectorGroup({ annotations: kubernetesAnnotations({ role: "node", namespace: agentNamespace, replicas: undefined }) }),
      gatewaysGroup({
        name: gatewayName,
        assignedVersion: publishedVersion({ configurationName }),
        annotations: kubernetesAnnotations({ namespace, replicas: 2, volumes: [{ hostPath, hostPathType: "Directory", mountPath, readOnly: false }] }),
      }),
    ];
    serve();
    const user = renderTab(fleetLabel);
    await screen.findByText(gatewayName);
    expect(screen.getByRole("table")).toHaveTextContent(namespace);
    const canaries = [gatewayName, namespace, agentNamespace, hostPath, mountPath, configurationName, fleetLabel];
    for (const text of canaries) expectNoAttributeHolds(text);
    // The Agent's and the Cluster's Nothing assigned, the gateway's published version (the help popovers are opened below).
    const versionCells = screen.getAllByRole("row").slice(1).map((row) => row.querySelectorAll("td")[2]!);
    for (const text of canaries) {
      let opened = 0;
      for (const cell of versionCells) opened += await expectNoAttributeHoldsInOpenTooltips(text, cell);
      expect(opened).toBe(3);
    }
    for (const label of ["What is an Agent?", "What is a Cluster?", "What is a Gateway?"]) {
      await user.click(screen.getAllByRole("button", { name: label })[0]!);
      await screen.findByRole("dialog");
      for (const text of canaries) expectNoAttributeHolds(text);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    /** Only an input's value inside ph-no-capture may hold a canary (a controlled field's). */
    const outsideInputs = (text: string) => {
      const holders: string[] = [];
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (!attribute.value.includes(text)) continue;
          if (element.tagName === "INPUT" && attribute.name === "value" && element.closest(".ph-no-capture") !== null) continue;
          holders.push(`${element.tagName} ${attribute.name}`);
        }
      }
      return holders;
    };
    for (const opener of [`More about ${gatewayName}`, "More about Agent", "More about Cluster", `Edit ${gatewayName}`, "Assign Agent", "Assign Cluster", "Add gateway"]) {
      await user.click(button(opener));
      const dialog = await screen.findByRole("dialog");
      if (opener === `Edit ${gatewayName}`) {
        await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v4"));
        const nsField = within(dialog).getByRole("textbox", { name: "Namespace" });
        await user.clear(nsField);
        await user.type(nsField, `${namespace}-x`);
        await user.click(within(dialog).getByRole("combobox", { name: "Type" }));
        await screen.findAllByRole("option");
        for (const text of canaries) expect(outsideInputs(text), text).toEqual([]);
        await user.keyboard("{Escape}");
      }
      for (const text of canaries) expect(outsideInputs(text), text).toEqual([]);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    await user.click(button(`Delete ${gatewayName}`));
    const deleting = await screen.findByRole("alertdialog");
    await user.type(within(deleting).getByLabelText(groupDeleteConfirmLabel(gatewayName)), typed);
    expect(within(deleting).getByLabelText(groupDeleteConfirmLabel(gatewayName))).toHaveValue(typed);
    for (const text of [...canaries, typed]) expectNoAttributeHolds(text);
  });
});

// A row's Install opens the route's Helm install dialog.
describe("KubernetesGroupsTab's row Install", () => {
  it("offers each row's Install before Assign or Edit, named by Agent, Cluster or the gateway's name, asking the route with the row", async () => {
    api.groups = [
      collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }),
      gateways({ id: SECOND_GATEWAY_GROUP_ID, name: "alpha", assignedVersion: null }),
      gateways({ id: "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", name: "broken", annotations: { telflo: { kubernetes: 7 } } }),
      // A name that isn't a gateway's (written around the platform): the facts would refuse it.
      gateways({ id: "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e", name: "Not_A_Gateway" }),
      gateways(),
    ];
    serve();
    const onInstall = vi.fn();
    const user = renderTab("prod", { onInstall });
    const agent = await screen.findByRole("button", { name: "Install Agent" });
    expect([...rowOf("Agent").querySelectorAll("td:last-child button")].map((each) => each.textContent)).toEqual(["Install", "Edit"]);
    expect([...rowOf("gateways").querySelectorAll("td:last-child button")].map((each) => each.textContent)).toEqual(["Install", "Edit", "Delete"]);
    // Disabled with their reasons: the Cluster before its group exists, a deleted configuration's version, unreadable settings.
    const reasons = {
      Cluster: "Assign a published version first.",
      alpha: "This group's published version belongs to a deleted configuration. Assign another first.",
      broken: "This group's Kubernetes settings can't be read: save them in Edit first.",
      Not_A_Gateway: "This group's Kubernetes settings can't be read: save them in Edit first.",
    };
    for (const [name, reason] of Object.entries(reasons)) {
      const disabled = screen.getByRole("button", { name: `Install ${name}` });
      expect(disabled).toHaveAttribute("aria-disabled", "true");
      expect(disabled).toHaveAccessibleDescription(`(${reason})`);
    }
    await user.click(agent);
    expect(onInstall).toHaveBeenCalledWith({ role: "node", group: api.groups[0] }, agent);
    await user.click(screen.getByRole("button", { name: "Install Cluster" }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("holds no gateway name in an attribute with each row's Install shown, enabled and disabled, its reason's tooltip open", async () => {
    const enabled = "canary-install-on-1a2b";
    const unassigned = "canary-install-off-3c4d";
    const unreadable = "canary-install-bad-5e6f";
    api.groups = [
      collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }),
      gateways({ id: SECOND_GATEWAY_GROUP_ID, name: unassigned, assignedPublishedVersionId: null, assignedVersion: null }),
      gateways({ id: "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", name: unreadable, annotations: { telflo: { kubernetes: 7 } } }),
      gateways({ name: enabled }),
    ];
    serve();
    renderTab("prod", { onInstall: vi.fn() });
    expect(await screen.findByRole("button", { name: `Install ${enabled}` })).toBeEnabled();
    const canaries = [enabled, unassigned, unreadable];
    for (const text of canaries) expectNoAttributeHolds(text);
    for (const [name, reason] of [
      [unassigned, "Assign a published version first."],
      [unreadable, "This group's Kubernetes settings can't be read: save them in Edit first."],
    ] as const) {
      const disabled = screen.getByRole("button", { name: `Install ${name}` });
      expect(disabled).toHaveAttribute("aria-disabled", "true");
      act(() => disabled.focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
      for (const text of canaries) expectNoAttributeHolds(text);
      act(() => disabled.blur());
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    }
  });

  it("offers no Install without onInstall (an archived fleet)", async () => {
    serve();
    renderTab();
    await screen.findByRole("button", { name: "More about Agent" });
    expect(screen.queryByRole("button", { name: /^Install / })).toBeNull();
  });

  it("reads its groups again when the route's groupsChanged moves, not on its first render", async () => {
    const { getCollectorGroups } = serve();
    const fleet = fleetDetail({ type: "kubernetes-supervisor" });
    function Harness() {
      const [changed, setChanged] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setChanged((value) => value + 1)}>
            changed elsewhere
          </button>
          <KubernetesGroupsTab fleet={fleet} onFleetGone={onFleetGone} onFleetChanged={onFleetChanged} groupsChanged={changed} />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/", Component: Harness }]);
    render(<Stub initialEntries={["/"]} />);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "More about Agent" });
    expect(getCollectorGroups).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "changed elsewhere" }));
    await waitFor(() => expect(getCollectorGroups).toHaveBeenCalledTimes(2));
  });
});
