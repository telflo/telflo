import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import {
  annotationsWithKubernetes,
  FLEETS_UNAVAILABLE_MESSAGE,
  KUBERNETES_AGENT_LOG_PATH_TAKEN,
  KUBERNETES_MOUNT_PATH_TWICE,
  KUBERNETES_REPLICAS_MESSAGE,
  KUBERNETES_VOLUME_NAME_TWICE,
  type CollectorGroup,
  type Configuration,
  type ConfigurationsPage,
  type ConfigurationVersionListItem,
  type CreateCollectorGroupRequest,
  type UpdateCollectorGroupRequest,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { answerFor, GROUP_ID, PERSONAL_ID, signedInMember, THEIRS, versionFixture } from "~/test/configurations.js";
import {
  clusterGroup,
  collectorGroup,
  configurationVersionListItem,
  CONFIGURATION_ID,
  DEFAULT_GROUP_ID,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  kubernetesAnnotations,
  kubernetesSettings,
  expectNoAttributeHolds,
  publishedVersion,
  serveNoVariables,
} from "~/test/fleets.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { forgetVariableGroupNames } from "~/lib/variable-group-display.js";
import { organizationVariable, variableGroup } from "~/test/variables.js";
import { GROUP_NOT_FOUND_MESSAGE, HINT_VERSION, SAVE_GROUP_FAILED_MESSAGE } from "./GroupDialog.js";
import { AGENT_LOG_MOUNT_HINT, VOLUME_RECIPES_LABEL } from "./VolumesEditor.js";
import {
  ADD_GATEWAY_DESCRIPTION,
  CLUSTER_SET_UP_MEANWHILE,
  EDIT_GATEWAY_DESCRIPTION,
  EDIT_KUBERNETES_DESCRIPTION,
  FORM_DETAIL_KEY,
  GATEWAY_ADDRESS_LABEL,
  kubernetesDetailKey,
  KubernetesGroupDialog,
  KUBERNETES_UNREADABLE,
  namespaceChangeWarning,
  NO_SETTINGS_PROBLEMS,
  replicasOf,
  SETTINGS_CHANGED_MESSAGE,
  settingsProblemsOf,
  type KubernetesGroupTarget,
} from "./KubernetesGroupDialog.js";

/*
 * A Kubernetes fleet's group dialog (D17d-1 decisions 6, 17, 18 and 24;
 * Preflight rulings 11–13, 24 and 31–37): Assign on the Cluster before its
 * group exists creating it (one POST named cluster, never a PATCH), Add
 * gateway with a name, replicas and the address preview, Edit's prefill
 * (namespace, replicas, volumes), the name and namespace rules (with D17d-1's
 * words and limits), and the volumes' recipes and warnings
 * (`VolumesEditor.test.tsx`). `GroupDialog.test.tsx` covers the picker's and
 * the refusals' shared behaviour in depth; the cases here pin this dialog's
 * own use of them.
 */

const refusal = (code: string, message: string, status: number, options: { details?: unknown } = {}) =>
  new ApiError(code, message, { status, ...options });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const NAME_TAKEN_WORDS = "Another of the fleet's collector groups has this name.";
const NAME_TAKEN = () => refusal("collector_group_name_taken", NAME_TAKEN_WORDS, 409);
/** A 400 naming fields, as `modules/fleets/errors.ts` writes them (instancePath "/" + segments). */
const invalid = (...details: Array<[string, string]>) =>
  refusal("invalid_request", "The request was not valid.", 400, {
    details: details.map(([path, message]) => ({
      keyword: "custom",
      instancePath: `/${path.split(".").join("/")}`,
      schemaPath: "#/custom",
      params: { issue: { code: "custom", path: path.split(".").map((each) => (/^\d+$/.test(each) ? Number(each) : each)), message } },
      message,
    })),
  });

const V5_ID = "c0ffee00-0000-4000-8000-000000000005";
const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };

/** The Agent (the fleet's Default group) with nothing assigned and no settings saved. */
const agentRow = (group: CollectorGroup = collectorGroup()): KubernetesGroupTarget => ({ role: "node", group });
const clusterBeforeRow = (): KubernetesGroupTarget => ({ role: "cluster", group: null });
const addRow = (): KubernetesGroupTarget => ({ role: "gateway", group: null });
/** The gateway "gateways", assigned checkout-otel @v4, with its settings saved. */
const gatewaysRow = (overrides: Partial<CollectorGroup> = {}): KubernetesGroupTarget => ({
  role: "gateway",
  group: gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "edge", replicas: 3 }), ...overrides }),
});

type Answer = "saved" | "hang" | Error;

interface Api {
  versions: ConfigurationVersionListItem[];
  answers: Answer[];
  creates: CreateCollectorGroupRequest[];
  updates: Array<{ groupId: string; request: UpdateCollectorGroupRequest }>;
  signals: Array<AbortSignal | undefined>;
  /** What a settings save reads again; null: the group as the dialog opened with it. */
  freshGroups: CollectorGroup[] | Error | null;
}

let api: Api;
let openedGroup: CollectorGroup | null = null;

function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
  });
}

function answer(signal: AbortSignal | undefined): Promise<CollectorGroup> {
  const next = api.answers.shift() ?? "saved";
  if (next === "saved") return Promise.resolve(gatewaysGroup());
  if (next === "hang") return hang(signal);
  return Promise.reject(next);
}

function serve() {
  serveNoVariables();
  const getConfigurations = vi.spyOn(apiClient, "getConfigurations").mockImplementation(async (organizationId): Promise<ConfigurationsPage> => {
    expect(organizationId).toBe(GROUP_ID);
    return { items: [CHECKOUT], nextCursor: null };
  });
  vi.spyOn(apiClient, "getConfigurationVersions").mockImplementation(async () => ({ versions: api.versions }));
  const createCollectorGroup = vi.spyOn(apiClient, "createCollectorGroup").mockImplementation((organizationId, fleetId, request, options = {}) => {
    expect([organizationId, fleetId]).toEqual([GROUP_ID, FLEET_ID]);
    api.creates.push(request);
    api.signals.push(options.signal);
    return answer(options.signal);
  });
  const updateCollectorGroup = vi.spyOn(apiClient, "updateCollectorGroup").mockImplementation((organizationId, fleetId, groupId, request, options = {}) => {
    expect([organizationId, fleetId]).toEqual([GROUP_ID, FLEET_ID]);
    api.updates.push({ groupId, request });
    api.signals.push(options.signal);
    return answer(options.signal);
  });
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async (organizationId, fleetId, options = {}) => {
    expect([organizationId, fleetId]).toEqual([GROUP_ID, FLEET_ID]);
    api.signals.push(options.signal);
    if (api.freshGroups instanceof Error) throw api.freshGroups;
    return { groups: api.freshGroups ?? (openedGroup === null ? [] : [openedGroup]) };
  });
  return { getConfigurations, createCollectorGroup, updateCollectorGroup, getCollectorGroups };
}

let spies: ReturnType<typeof serve>;

/** The dialog open for `target` in GROUP_ID, on a page that can reopen it, switch organization and replace the row (a poll). */
async function renderDialog(target: KubernetesGroupTarget, { replaced }: { replaced?: KubernetesGroupTarget } = {}) {
  openedGroup = target.group;
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    const [row, setRow] = useState(target);
    return (
      <>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <button type="button" onClick={() => replaced !== undefined && setRow(replaced)}>
          Replace
        </button>
        <KubernetesGroupDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          target={row}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  const user = userEvent.setup();
  await screen.findByRole("dialog");
  await waitFor(() => expect(spies.getConfigurations).toHaveBeenCalled());
  return { user, onOpenChange, onChanged, loader };
}

type User = ReturnType<typeof userEvent.setup>;

const dialog = () => screen.getByRole("dialog");
const submit = () => screen.getByRole("button", { name: /^(Create|Assign|Save|Saving…)$/ });
const combobox = (name: string) => screen.getByRole("combobox", { name });
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const replicas = () => screen.getByRole("spinbutton", { name: "Replicas" }) as HTMLInputElement;

async function retype(user: User, element: HTMLElement, to: string) {
  await user.clear(element);
  if (to !== "") await user.type(element, to);
}

/** Picks checkout-otel; its newest version (v5) is chosen once read. */
async function pickVersion(user: User) {
  await user.click(combobox("Configuration"));
  await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
  await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v5"));
}

beforeEach(() => {
  vi.restoreAllMocks();
  api = {
    versions: [configurationVersionListItem({ id: V5_ID, versionNumber: 5 }), configurationVersionListItem()],
    answers: [],
    creates: [],
    updates: [],
    signals: [],
    freshGroups: null,
  };
  spies = serve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("KubernetesGroupDialog's titles and words (decision 24)", () => {
  it.each([
    ["Add gateway", addRow(), "Add gateway", ADD_GATEWAY_DESCRIPTION, "Create"],
    ["the Cluster before its group exists", clusterBeforeRow(), "Assign a published version to Cluster", EDIT_KUBERNETES_DESCRIPTION, "Assign"],
    ["the Agent with nothing assigned", agentRow(), "Assign a published version to Agent", EDIT_KUBERNETES_DESCRIPTION, "Assign"],
    [
      "the Cluster assigned",
      { role: "cluster", group: clusterGroup({ assignedPublishedVersionId: "p", assignedVersion: publishedVersion() }) } as KubernetesGroupTarget,
      "Edit Cluster",
      EDIT_KUBERNETES_DESCRIPTION,
      "Save",
    ],
    ["a gateway assigned", gatewaysRow(), "Edit gateways", EDIT_GATEWAY_DESCRIPTION, "Save"],
    ["a gateway with nothing assigned", gatewaysRow({ assignedPublishedVersionId: null, assignedVersion: null }), "Assign a published version to gateways", EDIT_GATEWAY_DESCRIPTION, "Assign"],
  ] as const)("titles %s, with its description and submit", async (_why, target, title, description, words) => {
    await renderDialog(target);
    expect(screen.getByRole("dialog", { name: title })).toHaveAccessibleDescription(description);
    expect(submit()).toHaveTextContent(words);
  });

  it("says the descriptions' words exactly", () => {
    expect(ADD_GATEWAY_DESCRIPTION).toBe(
      "Create a named gateway pool and give it a published version. Its name can't change later: its Helm release is named after it.",
    );
    expect(EDIT_KUBERNETES_DESCRIPTION).toBe(
      "Change the group's published version, variable group, namespace or volumes. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.",
    );
    expect(EDIT_GATEWAY_DESCRIPTION).toBe(
      "Change the group's published version, variable group, namespace, replicas or volumes. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.",
    );
  });

  // D18 Ruling 27: the order Helm accepts, per role. The Agent's and the Cluster's release owns their cluster-scoped
  // ClusterRole and binding, so an install into the new namespace is refused while it exists; a gateway owns none.
  // Ruling 42: each role's warning says what happens to its collectors.
  it("says the namespace warning's words exactly for each role", () => {
    expect(namespaceChangeWarning("node", "old-ns", "new-ns")).toBe(
      "A Helm release already installed keeps running in old-ns: uninstall it there first, then install into new-ns. Helm refuses the new install while that release exists: it owns the Agent's cluster-wide role. The Agent's state is kept on each node, outside any namespace, so its collectors stay the same.",
    );
    expect(namespaceChangeWarning("cluster", "old-ns", "new-ns")).toBe(
      "A Helm release already installed keeps running in old-ns: uninstall it there first, then install into new-ns. Helm refuses the new install while that release exists: it owns the Cluster's cluster-wide role. The Cluster's state stays on its volume in old-ns, so in new-ns it enrolls again as a new collector (the old one goes offline).",
    );
    expect(namespaceChangeWarning("gateway", "old-ns", "new-ns")).toBe(
      "A Helm release already installed keeps running in old-ns: uninstall it there after installing into new-ns. Its pods come back in new-ns as new collectors (the old ones go offline).",
    );
  });

  it("offers a gateway's name only on Add gateway, and Replicas and the address only to a gateway", async () => {
    await renderDialog(agentRow());
    expect(screen.queryByRole("textbox", { name: "Gateway name" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Replicas" })).toBeNull();
    expect(dialog()).not.toHaveTextContent(GATEWAY_ADDRESS_LABEL);
    expect(field("Namespace")).toHaveValue("telflo-collectors");
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });
});

describe("KubernetesGroupDialog's Add gateway (decisions 18 and 24; Preflight ruling 12)", () => {
  it("creates a gateway: its name, version, namespace, replicas and volumes in one POST, trimmed, then toasts, closes and reloads", async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = await renderDialog(addRow());
    expect(field("Gateway name")).toHaveValue("gateway");
    expect(field("Gateway name")).toHaveAttribute("placeholder", "traces-sampling");
    expect(field("Namespace")).toHaveValue("telflo-collectors");
    expect(replicas()).toHaveValue(1);
    expect(submit()).toBeDisabled();
    await retype(user, field("Gateway name"), "  traces-sampling ");
    await retype(user, field("Namespace"), " observability ");
    await retype(user, replicas(), "3");
    await user.click(screen.getByRole("button", { name: "Add volume" }));
    await user.type(screen.getByRole("textbox", { name: "Host path" }), " /var/log/app ");
    await user.type(screen.getByRole("textbox", { name: "Mount path" }), "/var/log/app");
    await pickVersion(user);
    await user.click(submit());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([
      {
        name: "traces-sampling",
        assignedVersionId: V5_ID,
        annotations: {
          telflo: {
            kubernetes: {
              role: "gateway",
              namespace: "observability",
              replicas: 3,
              volumes: [{ hostPath: "/var/log/app", hostPathType: "Directory", mountPath: "/var/log/app", readOnly: true }],
            },
          },
        },
      },
    ]);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
    expect(spies.getCollectorGroups).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Group created");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the gateway's in-cluster address from its name and namespace as typed, placeholders for blanks", async () => {
    const { user } = await renderDialog(addRow());
    const address = () => screen.getByText(GATEWAY_ADDRESS_LABEL).parentElement!;
    expect(address()).toHaveTextContent(
      `${GATEWAY_ADDRESS_LABEL}http://gateway.telflo-collectors.svc.cluster.local:4318gateway.telflo-collectors.svc.cluster.local:4317`,
    );
    await retype(user, field("Gateway name"), "edge");
    await retype(user, field("Namespace"), "");
    expect(address()).toHaveTextContent("http://edge.<namespace>.svc.cluster.local:4318edge.<namespace>.svc.cluster.local:4317");
    await retype(user, field("Gateway name"), "");
    expect(address()).toHaveTextContent("http://<name>.<namespace>.svc.cluster.local:4318");
  });

  it.each([
    ["a reserved name", "telflo-cluster", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
    ["cluster", "cluster", "node, cluster, telflo-node and telflo-cluster are reserved: choose another name."],
    ["upper case", "Edge", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
    ["a leading digit", "1edge", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
    ["a trailing hyphen", "edge-", "Use lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."],
    ["53 characters", "a".repeat(53), "Gateway name must be 52 characters or fewer."],
  ])("blocks %s, its words under the name, nothing sent", async (_why, name, words) => {
    const { user } = await renderDialog(addRow());
    fireEvent.change(field("Gateway name"), { target: { value: name } });
    await pickVersion(user);
    await user.click(submit());
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(field("Gateway name")).toHaveAttribute("aria-invalid", "true");
    expect(field("Gateway name")).toHaveAccessibleDescription(words);
    expect(spies.createCollectorGroup).not.toHaveBeenCalled();
  });

  it("keeps Create disabled without a name or a version; takes 52 characters", async () => {
    const { user, onChanged } = await renderDialog(addRow());
    await pickVersion(user);
    await retype(user, field("Gateway name"), "   ");
    expect(submit()).toBeDisabled();
    await retype(user, field("Gateway name"), `e${"x".repeat(51)}`);
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates[0]!.name).toHaveLength(52);
  });

  it("shows a taken name under the name, and clears it on typing", async () => {
    api.answers = [NAME_TAKEN()];
    const { user } = await renderDialog(addRow());
    await pickVersion(user);
    await user.click(submit());
    expect(await screen.findByText(NAME_TAKEN_WORDS)).toBeInTheDocument();
    expect(field("Gateway name")).toHaveAccessibleDescription(NAME_TAKEN_WORDS);
    await user.type(field("Gateway name"), "-2");
    expect(screen.queryByText(NAME_TAKEN_WORDS)).toBeNull();
  });
});

describe("KubernetesGroupDialog's Cluster before its group exists (Preflight ruling 31)", () => {
  it("assigns by one POST named cluster with its version and settings: no replicas, no address", async () => {
    const { user, onChanged } = await renderDialog(clusterBeforeRow());
    expect(screen.queryByRole("spinbutton", { name: "Replicas" })).toBeNull();
    expect(dialog()).not.toHaveTextContent(GATEWAY_ADDRESS_LABEL);
    expect(submit()).toBeDisabled();
    await pickVersion(user);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([
      { name: "cluster", assignedVersionId: V5_ID, annotations: { telflo: { kubernetes: { role: "cluster", namespace: "telflo-collectors", volumes: [] } } } },
    ]);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
  });

  it("on a taken name (set up meanwhile), says so, reads the tab again and keeps the submit disabled: never a PATCH", async () => {
    api.answers = [NAME_TAKEN()];
    const { user, onChanged, onOpenChange } = await renderDialog(clusterBeforeRow());
    await pickVersion(user);
    await user.click(submit());
    expect(await screen.findByText(CLUSTER_SET_UP_MEANWHILE)).toBeInTheDocument();
    expect(CLUSTER_SET_UP_MEANWHILE).toBe("The Cluster was set up meanwhile: close and reopen to see it.");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(submit()).toBeDisabled();
    expect(spies.createCollectorGroup).toHaveBeenCalledTimes(1);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
  });

  it("after an unknown outcome, a retry answering a taken name (the first try made it) says the Cluster was set up", async () => {
    api.answers = [UNAVAILABLE(), NAME_TAKEN()];
    const { user } = await renderDialog(clusterBeforeRow());
    await pickVersion(user);
    await user.click(submit());
    expect(await screen.findByText(FLEETS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    await user.click(submit());
    expect(await screen.findByText(CLUSTER_SET_UP_MEANWHILE)).toBeInTheDocument();
    expect(api.creates.map((each) => each.name)).toEqual(["cluster", "cluster"]);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
  });
});

describe("KubernetesGroupDialog's saves of a group that exists (Preflight rulings 24 and 32)", () => {
  it("the Agent's first save writes its settings (role node) with its version, merged into the group read again", async () => {
    const agent = collectorGroup({ annotations: { other: { kept: true } } });
    const { user, onChanged } = await renderDialog(agentRow(agent));
    await pickVersion(user);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([
      {
        groupId: DEFAULT_GROUP_ID,
        request: {
          assignedVersionId: V5_ID,
          annotations: { other: { kept: true }, telflo: { kubernetes: { role: "node", namespace: "telflo-collectors", volumes: [] } } },
        },
      },
    ]);
    // The read and the write under the one hang guard.
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1);
    expect(api.signals[0]).toBe(api.signals[1]);
  });

  it("prefills a gateway's settings; a version change alone sends it alone and reads nothing", async () => {
    const { user, onChanged } = await renderDialog(gatewaysRow());
    expect(field("Namespace")).toHaveValue("edge");
    expect(replicas()).toHaveValue(3);
    expect(combobox("Configuration")).toHaveTextContent("checkout-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    expect(submit()).toBeDisabled();
    await user.click(combobox("Version"));
    await user.click(await screen.findByRole("option", { name: /@v5/ }));
    expect(screen.getByText(HINT_VERSION)).toBeInTheDocument();
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { assignedVersionId: V5_ID } }]);
    expect(spies.getCollectorGroups).not.toHaveBeenCalled();
  });

  it("sends a settings change merged into the fresh annotations, another client's key kept, a stray dockerMounts dropped, never a name", async () => {
    const opened = gatewaysRow();
    api.freshGroups = [
      { ...opened.group!, annotations: { ...kubernetesAnnotations({ namespace: "edge", replicas: 3 }), theirs: [1, 2] } },
    ];
    const { user, onChanged } = await renderDialog(opened);
    await retype(user, replicas(), "5");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([
      {
        groupId: GATEWAYS_GROUP_ID,
        request: { annotations: { other: { kept: true }, theirs: [1, 2], telflo: { kubernetes: kubernetesSettings({ namespace: "edge", replicas: 5 }) } } },
      },
    ]);
    // A stray dockerMounts (a server group's) is dropped by the merge.
    expect(annotationsWithKubernetes({ telflo: { dockerMounts: [] } }, kubernetesSettings())).toEqual({ telflo: { kubernetes: kubernetesSettings() } });
  });

  it("refuses a settings save when another member saved the group's settings since the opening: the words, nothing written, the tab read again", async () => {
    const opened = gatewaysRow();
    api.freshGroups = [{ ...opened.group!, annotations: kubernetesAnnotations({ namespace: "edge", replicas: 4 }) }];
    const { user, onChanged, onOpenChange } = await renderDialog(opened);
    await retype(user, field("Namespace"), "edge-2");
    await user.click(submit());
    expect(await screen.findByText(SETTINGS_CHANGED_MESSAGE)).toBeInTheDocument();
    expect(SETTINGS_CHANGED_MESSAGE).toBe("This group's settings changed since you opened it: close and reopen to see them.");
    expect(api.updates).toEqual([]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('toasts "Group not found", closes and reloads when the fresh read no longer holds the group', async () => {
    const error = vi.spyOn(toast, "error");
    api.freshGroups = [collectorGroup()];
    const { user, onChanged, onOpenChange } = await renderDialog(gatewaysRow());
    await retype(user, replicas(), "2");
    await user.click(submit());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(error).toHaveBeenCalledWith(GROUP_NOT_FOUND_MESSAGE);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.updates).toEqual([]);
  });

  it("shows a failed fresh read's words with nothing written, and the save tries again", async () => {
    api.freshGroups = UNAVAILABLE();
    const { user, onChanged } = await renderDialog(gatewaysRow());
    await retype(user, replicas(), "2");
    await user.click(submit());
    expect(await screen.findByText(FLEETS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(api.updates).toEqual([]);
    api.freshGroups = null;
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toHaveLength(1);
  });

  it("warns of a namespace change only when the namespace differs from the one saved", async () => {
    const { user } = await renderDialog(gatewaysRow());
    expect(screen.queryByText(/keeps running in/)).toBeNull();
    await retype(user, field("Namespace"), " observability ");
    expect(screen.getByText(namespaceChangeWarning("gateway", "edge", "observability"))).toBeInTheDocument();
    expect(field("Namespace")).toHaveAccessibleDescription(namespaceChangeWarning("gateway", "edge", "observability"));
    // D17d-2 decision 4 (the owner's Q54); Preflight ruling 31: the old namespace's uninstall, quoted, in a copy box.
    const copy = screen.getByRole("button", { name: "Copy uninstall command" });
    expect(copy.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    await retype(user, field("Namespace"), "edge");
    expect(screen.queryByText(/keeps running in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy uninstall command" })).toBeNull();
  });

  // D17d-2 Ruling 44: the Agent installs before its first save into the default namespace (the API's helmFactsOf), so a
  // change from it is a change from where its release runs.
  it("warns of a namespace change from the default for the Agent with none saved (before its first save), with its uninstall there", async () => {
    const { user } = await renderDialog(agentRow());
    expect(field("Namespace")).toHaveValue("telflo-collectors");
    expect(screen.queryByText(/keeps running in/)).toBeNull();
    await retype(user, field("Namespace"), "observability");
    expect(screen.getByText(namespaceChangeWarning("node", "telflo-collectors", "observability"))).toBeInTheDocument();
    expect(field("Namespace")).toHaveAccessibleDescription(namespaceChangeWarning("node", "telflo-collectors", "observability"));
    const copy = screen.getByRole("button", { name: "Copy uninstall command" });
    expect(copy.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe("helm uninstall 'telflo-node' -n 'telflo-collectors'");
    await retype(user, field("Namespace"), "telflo-collectors");
    expect(screen.queryByText(/keeps running in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy uninstall command" })).toBeNull();
  });

  // D18 Ruling 27: the Cluster's words are its own (uninstall first; its state on a volume in the old namespace).
  it("warns the Cluster of a namespace change in its own words, with its uninstall in the namespace saved", async () => {
    const { user } = await renderDialog({
      role: "cluster",
      group: clusterGroup({
        assignedPublishedVersionId: "p",
        assignedVersion: publishedVersion(),
        annotations: kubernetesAnnotations({ role: "cluster", namespace: "metrics", replicas: undefined }),
      }),
    });
    expect(field("Namespace")).toHaveValue("metrics");
    expect(screen.queryByText(/keeps running in/)).toBeNull();
    await retype(user, field("Namespace"), "observability");
    const words = namespaceChangeWarning("cluster", "metrics", "observability");
    expect(words).not.toBe(namespaceChangeWarning("node", "metrics", "observability"));
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(field("Namespace")).toHaveAccessibleDescription(words);
    const copy = screen.getByRole("button", { name: "Copy uninstall command" });
    expect(copy.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe("helm uninstall 'telflo-cluster' -n 'metrics'");
    await retype(user, field("Namespace"), "metrics");
    expect(screen.queryByText(/keeps running in/)).toBeNull();
  });

  it.each([
    ["Add gateway", addRow()],
    ["the Cluster's Assign before its group exists", clusterBeforeRow()],
    ["a gateway with no settings saved (nothing installed from it)", { role: "gateway", group: gatewaysGroup() } satisfies KubernetesGroupTarget],
    // Ruling 49: the groups the Helm facts refuse (nothing installed from them): no sentence, since there is no command.
    ["a gateway whose stored role is the Agent's", gatewaysRow({ annotations: kubernetesAnnotations({ role: "node", namespace: "edge", replicas: undefined }) })],
    ["the Agent whose stored role is a gateway's", agentRow(collectorGroup({ annotations: kubernetesAnnotations({ namespace: "edge" }) }))],
    ["a gateway named telflo-node (reserved: the Agent's release)", gatewaysRow({ name: "telflo-node" })],
    ["a gateway named Not_A_Gateway", gatewaysRow({ name: "Not_A_Gateway" })],
  ])("warns of no namespace change on %s", async (_why, target) => {
    const { user } = await renderDialog(target);
    await retype(user, field("Namespace"), "observability");
    expect(screen.queryByText(/keeps running in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy uninstall command" })).toBeNull();
  });

  it("says settings Telflo can't read are replaced by a save, its fields from the defaults; Save enabled at the opening writes them (Ruling 58)", async () => {
    const opened = gatewaysRow({ annotations: { telflo: { kubernetes: { role: "gateway", namespace: "Not A Label", volumes: [] } } } });
    const { user, onChanged } = await renderDialog(opened);
    expect(screen.getByText(KUBERNETES_UNREADABLE)).toBeInTheDocument();
    expect(KUBERNETES_UNREADABLE).toBe("This group's Kubernetes settings were saved in a form Telflo can't read. Saving here replaces them.");
    expect(field("Namespace")).toHaveValue("telflo-collectors");
    expect(replicas()).toHaveValue(1);
    expect(screen.queryByText(/keeps running in/)).toBeNull();
    // What is stored differs from the defaults shown: saving them is a change.
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    expect(submit()).toHaveTextContent("Save");
    expect(submit()).toBeEnabled();
    // Typed away from the defaults and back: still enabled.
    await retype(user, replicas(), "2");
    await retype(user, replicas(), "1");
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { annotations: { telflo: { kubernetes: kubernetesSettings() } } } }]);
  });

  it("writes the settings shown with a version save of a group whose settings Telflo can't read", async () => {
    const opened = gatewaysRow({ annotations: { telflo: { kubernetes: { role: "gateway", namespace: "Not A Label", volumes: [] } } } });
    const { user, onChanged } = await renderDialog(opened);
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    await user.click(combobox("Version"));
    await user.click(await screen.findByRole("option", { name: /@v5/ }));
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([
      { groupId: GATEWAYS_GROUP_ID, request: { assignedVersionId: V5_ID, annotations: { telflo: { kubernetes: kubernetesSettings() } } } },
    ]);
  });

  it("opens an assigned Agent with no settings saved with Save enabled, and its save writes the settings shown (role node; Ruling 58)", async () => {
    const agent = collectorGroup({ assignedPublishedVersionId: "p", assignedVersion: publishedVersion(), annotations: { other: { kept: true } } });
    const { user, onChanged } = await renderDialog(agentRow(agent));
    expect(screen.getByRole("dialog", { name: "Edit Agent" })).toBeInTheDocument();
    expect(field("Namespace")).toHaveValue("telflo-collectors");
    expect(submit()).toHaveTextContent("Save");
    expect(submit()).toBeEnabled();
    await retype(user, field("Namespace"), "observability");
    await retype(user, field("Namespace"), "telflo-collectors");
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([
      {
        groupId: DEFAULT_GROUP_ID,
        request: { annotations: { other: { kept: true }, telflo: { kubernetes: { role: "node", namespace: "telflo-collectors", volumes: [] } } } },
      },
    ]);
    // Merged into the group read again: the groups read once, and the write keeps another client's key (no hang guard checked here).
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the Agent", agentRow()],
    ["a gateway", gatewaysRow({ assignedPublishedVersionId: null, assignedVersion: null })],
  ])("keeps %s's Assign disabled until a version is picked, a settings change or not (as the Cluster's: Ruling 53)", async (_why, target) => {
    const { user, onChanged } = await renderDialog(target);
    expect(submit()).toHaveTextContent("Assign");
    expect(submit()).toBeDisabled();
    await retype(user, field("Namespace"), "observability");
    expect(submit()).toBeDisabled();
    await user.click(submit());
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
    await pickVersion(user);
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates[0]!.request.assignedVersionId).toBe(V5_ID);
    expect(api.updates[0]!.request.annotations).toMatchObject({ telflo: { kubernetes: { role: target.role, namespace: "observability" } } });
  });

  it("opens a gateway saved without replicas unchanged: no save by itself, a version save alone; a field's change then writes the replicas shown", async () => {
    const saved = { telflo: { kubernetes: { role: "gateway", namespace: "edge", volumes: [] } } };
    const { user, onChanged } = await renderDialog(gatewaysRow({ annotations: saved }));
    expect(replicas()).toHaveValue(1);
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    expect(submit()).toBeDisabled();
    await user.click(combobox("Version"));
    await user.click(await screen.findByRole("option", { name: /@v5/ }));
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { assignedVersionId: V5_ID } }]);
    expect(spies.getCollectorGroups).not.toHaveBeenCalled();
  });

  it("writes a gateway's role and replicas with the next real settings save (saved without replicas, its stored role another's)", async () => {
    const saved = { telflo: { kubernetes: { role: "node", namespace: "edge", volumes: [] } } };
    const { user, onChanged } = await renderDialog(gatewaysRow({ annotations: saved }));
    expect(submit()).toBeDisabled();
    await retype(user, field("Namespace"), "edge-2");
    expect(submit()).toBeEnabled();
    // Back to what it showed: no change, no save.
    await retype(user, field("Namespace"), "edge");
    expect(submit()).toBeDisabled();
    await retype(user, field("Namespace"), "edge-2");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([
      { groupId: GATEWAYS_GROUP_ID, request: { annotations: { telflo: { kubernetes: { role: "gateway", namespace: "edge-2", replicas: 1, volumes: [] } } } } },
    ]);
  });

  it("keeps the opening's snapshot when the row changes under it (a poll or a reload: D17c-1 Ruling 66)", async () => {
    const opened = gatewaysRow();
    const changed = gatewaysRow({ name: "gateways-renamed", annotations: kubernetesAnnotations({ namespace: "other", replicas: 9 }) });
    const { user, onChanged } = await renderDialog(opened, { replaced: changed });
    // The page behind the modal re-renders with another row (the tab's rows replaced): the dialog keeps its own.
    fireEvent.click(screen.getByRole("button", { name: "Replace", hidden: true }));
    expect(screen.getByRole("dialog", { name: "Edit gateways" })).toBeInTheDocument();
    expect(field("Namespace")).toHaveValue("edge");
    expect(replicas()).toHaveValue(3);
    // The namespace warning and its uninstall are the opening's too (Ruling 40): the release and namespace it opened with.
    await retype(user, field("Namespace"), "observability");
    expect(screen.getByText(namespaceChangeWarning("gateway", "edge", "observability"))).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: "Copy uninstall command" });
    expect(copy.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe("helm uninstall 'gateways' -n 'edge'");
    await retype(user, field("Namespace"), "edge");
    await retype(user, replicas(), "4");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates[0]!.request.annotations).toEqual(kubernetesAnnotations({ namespace: "edge", replicas: 4 }));
  });
});

describe("KubernetesGroupDialog's rules (decision 17; the contracts' words)", () => {
  it.each([
    ["an empty namespace", "", "A namespace is required."],
    ["a namespace with upper case", "Edge", "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number."],
    ["a namespace with an underscore", "my_ns", "Use lowercase letters, numbers, and hyphens; must start and end with a letter or number."],
  ])("blocks %s, its words under the Namespace, nothing sent", async (_why, namespace, words) => {
    const { user } = await renderDialog(gatewaysRow());
    await retype(user, field("Namespace"), namespace);
    await user.click(submit());
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(field("Namespace")).toHaveAttribute("aria-invalid", "true");
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
    expect(spies.getCollectorGroups).not.toHaveBeenCalled();
  });

  it.each([
    ["no replicas", ""],
    ["0 replicas", "0"],
    ["1,001 replicas", "1001"],
  ])("blocks %s, the replicas' words under it", async (_why, value) => {
    const { user } = await renderDialog(gatewaysRow());
    await retype(user, replicas(), value);
    await user.click(submit());
    expect(await screen.findByText(KUBERNETES_REPLICAS_MESSAGE)).toBeInTheDocument();
    expect(replicas()).toHaveAccessibleDescription(KUBERNETES_REPLICAS_MESSAGE);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
  });

  it("reads replicas as a whole number only", () => {
    expect(replicasOf(" 12 ")).toBe(12);
    for (const text of ["", "1.5", "1e3", "-1", "x"]) expect(replicasOf(text)).toBeNaN();
  });

  it("blocks each volume's problems under its field, nothing sent: a path's rule, the same mount path, the same volume name", async () => {
    const { user } = await renderDialog(gatewaysRow());
    for (let index = 0; index < 3; index += 1) await user.click(screen.getByRole("button", { name: "Add volume" }));
    const hosts = screen.getAllByRole("textbox", { name: "Host path" });
    const mounts = screen.getAllByRole("textbox", { name: "Mount path" });
    await user.type(hosts[0]!, "var/log");
    await user.type(mounts[0]!, "/app/x");
    await user.type(hosts[1]!, "/var/log/a");
    await user.type(mounts[1]!, "/var/log/a.b");
    await user.type(hosts[2]!, "/var/log/b");
    await user.type(mounts[2]!, "/var/log/a-b");
    await user.click(submit());
    expect(await screen.findByText("Use an absolute path, starting with /.")).toBeInTheDocument();
    expect(mounts[0]).toHaveAccessibleDescription("Use a path outside /app: the image keeps its own files there.");
    expect(mounts[2]).toHaveAccessibleDescription(KUBERNETES_VOLUME_NAME_TWICE);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
    // Editing a field takes its message away.
    await user.type(hosts[0]!, "/x");
    expect(screen.queryByText("Use an absolute path, starting with /.")).toBeNull();
  });

  it.each([
    ["the Agent", agentRow, true],
    ["the Cluster", clusterBeforeRow, false],
    ["Add gateway", addRow, false],
  ] as const)("shows the Agent's own /var/log/pods mount's hint, or not, on %s (Ruling 65)", async (_label, row, shown) => {
    await renderDialog(row());
    expect(within(dialog()).queryByText(AGENT_LOG_MOUNT_HINT) !== null).toBe(shown);
  });

  it("closes the common volume paths at each opening; a recipe opened adds its row (Ruling 67)", async () => {
    const { user } = await renderDialog(addRow());
    const toggle = () => within(dialog()).getByRole("button", { name: VOLUME_RECIPES_LABEL });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle());
    await user.click(within(screen.getByRole("group", { name: VOLUME_RECIPES_LABEL })).getByRole("button", { name: /^\/var\/log\/journal / }));
    expect(screen.getByRole("textbox", { name: "Host path" })).toHaveValue("/var/log/journal");
    expect(screen.getByRole("textbox", { name: "Host path" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await screen.findByRole("dialog");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: VOLUME_RECIPES_LABEL })).toBeNull();
  });

  it("refuses the Agent a volume at /var/log/pods, which its chart mounts itself, as its Volumes' hint says (Ruling 65)", async () => {
    const { user } = await renderDialog(agentRow());
    expect(screen.getByRole("group", { name: "Volumes" })).toHaveAccessibleDescription(AGENT_LOG_MOUNT_HINT);
    await user.click(screen.getByRole("button", { name: "Add volume" }));
    await user.type(screen.getByRole("textbox", { name: "Host path" }), "/var/log/pods");
    await user.type(screen.getByRole("textbox", { name: "Mount path" }), "/var/log/pods/");
    await pickVersion(user);
    await user.click(submit());
    expect(await screen.findByText(KUBERNETES_AGENT_LOG_PATH_TAKEN)).toBeInTheDocument();
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
  });

  it("maps a 400's details to their fields, never the API's invalid_request words", async () => {
    api.answers = [
      invalid(
        ["annotations.telflo.kubernetes.namespace", "Namespace from the API."],
        ["annotations.telflo.kubernetes.replicas", "Replicas from the API."],
        ["annotations.telflo.kubernetes.volumes.0.mountPath", KUBERNETES_MOUNT_PATH_TWICE],
        ["annotations", "Annotations from the API."],
      ),
    ];
    const { user } = await renderDialog(gatewaysRow({ annotations: kubernetesAnnotations({ namespace: "edge", replicas: 3, volumes: [{ hostPath: "/a", hostPathType: "Directory", mountPath: "/a", readOnly: true }] }) }));
    await retype(user, replicas(), "4");
    await user.click(submit());
    expect(await screen.findByText("Namespace from the API.")).toBeInTheDocument();
    expect(replicas()).toHaveAccessibleDescription("Replicas from the API.");
    expect(screen.getByRole("textbox", { name: "Mount path" })).toHaveAccessibleDescription(KUBERNETES_MOUNT_PATH_TWICE);
    expect(screen.getByText("Annotations from the API.")).toBeInTheDocument();
    expect(dialog()).not.toHaveTextContent("The request was not valid.");
  });

  it.each([
    ["the settings themselves", "annotations.telflo.kubernetes", "Kubernetes settings are required."],
    ["their role", "annotations.telflo.kubernetes.role", "Must be gateway: the group's role on its fleet."],
  ])("shows a 400's detail at %s as the form's alert, not under Volumes", async (_why, path, words) => {
    api.answers = [invalid([path, words])];
    const { user } = await renderDialog(gatewaysRow());
    await retype(user, replicas(), "4");
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(within(screen.getByRole("group", { name: "Volumes" })).queryByText(words)).toBeNull();
    expect(dialog()).not.toHaveTextContent("The request was not valid.");
    // Typing takes it away, as any refusal's words.
    await retype(user, replicas(), "5");
    expect(screen.queryByText(words)).toBeNull();
  });

  it("maps a 400's name detail on Add gateway under the name", async () => {
    api.answers = [invalid(["name", "Name from the API."])];
    const { user } = await renderDialog(addRow());
    await pickVersion(user);
    await user.click(submit());
    expect(await screen.findByText("Name from the API.")).toBeInTheDocument();
    expect(field("Gateway name")).toHaveAccessibleDescription("Name from the API.");
  });
});

describe("settingsProblemsOf and kubernetesDetailKey", () => {
  it("finds nothing wrong with good settings, and the whole annotations' bytes the volumes list's", () => {
    const settings = kubernetesSettings();
    expect(settingsProblemsOf(settings, annotationsWithKubernetes(null, settings))).toEqual(NO_SETTINGS_PROBLEMS);
    const big = { theirs: "x".repeat(16_400) };
    expect(settingsProblemsOf(settings, annotationsWithKubernetes(big, settings)).volumes.list).toMatch(/^Must be at most 16384 bytes/);
  });

  it("keys the API's detail paths", () => {
    expect(kubernetesDetailKey("name")).toBe("name");
    expect(kubernetesDetailKey("annotations.telflo.kubernetes.namespace")).toBe("namespace");
    expect(kubernetesDetailKey("annotations.telflo.kubernetes.replicas")).toBe("replicas");
    expect(kubernetesDetailKey("annotations.telflo.kubernetes.volumes.12.hostPathType")).toBe("12.hostPathType");
    expect(kubernetesDetailKey("annotations.telflo.kubernetes.role")).toBe(FORM_DETAIL_KEY);
    expect(kubernetesDetailKey("annotations.telflo.kubernetes")).toBe(FORM_DETAIL_KEY);
    expect(kubernetesDetailKey("annotations.telflo")).toBe("annotations");
    expect(kubernetesDetailKey("annotations")).toBe("annotations");
    expect(kubernetesDetailKey("assignedVersionId")).toBeUndefined();
  });
});

describe("KubernetesGroupDialog's refusals (decision 24, as D17b-2's)", () => {
  it('shows the fallback "Failed to save group" for a refusal it doesn\'t know, and a 429\'s own words', async () => {
    api.answers = [refusal("internal_thing", "No.", 409), refusal("rate_limited", "Too many attempts.", 429)];
    const { user } = await renderDialog(gatewaysRow());
    await retype(user, replicas(), "2");
    api.freshGroups = null;
    await user.click(submit());
    expect(await screen.findByText(SAVE_GROUP_FAILED_MESSAGE)).toBeInTheDocument();
    await user.click(submit());
    expect(await screen.findByText("Too many attempts.")).toBeInTheDocument();
  });

  it("on a 404 fleet_not_found, toasts the API's words, closes and reloads", async () => {
    api.answers = [refusal("fleet_not_found", "Fleet not found.", 404)];
    const error = vi.spyOn(toast, "error");
    const { user, onChanged } = await renderDialog(clusterBeforeRow());
    await pickVersion(user);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith("Fleet not found.");
  });

  it("closes and revalidates on the organization's refusal, with no message", async () => {
    api.answers = [refusal("organization_not_found", "Organization not found", 404)];
    const { user, onOpenChange, loader } = await renderDialog(addRow());
    const loads = loader.mock.calls.length;
    await pickVersion(user);
    await user.click(submit());
    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ends a save that never answers at 30 s with the 503's words, and closing then reloads", async () => {
    api.answers = ["hang"];
    const { user, onChanged } = await renderDialog(addRow());
    await pickVersion(user);
    vi.useFakeTimers();
    fireEvent.click(submit());
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS));
    vi.useRealTimers();
    expect(await screen.findByText(FLEETS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("can't be closed while saving, every field disabled; a double submit sends once", async () => {
    api.answers = ["hang"];
    const { user, onOpenChange } = await renderDialog(gatewaysRow());
    await retype(user, replicas(), "2");
    fireEvent.click(submit());
    fireEvent.click(submit());
    await waitFor(() => expect(submit()).toHaveTextContent("Saving…"));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    for (const each of [field("Namespace"), replicas(), screen.getByRole("button", { name: "Add volume" })]) expect(each).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(spies.updateCollectorGroup).toHaveBeenCalledTimes(1));
  });

  it("opens afresh: the fields hold the row again, with no earlier refusal", async () => {
    api.answers = [refusal("rate_limited", "Too many attempts.", 429)];
    const { user } = await renderDialog(gatewaysRow());
    await retype(user, field("Namespace"), "elsewhere");
    await user.click(submit());
    expect(await screen.findByText("Too many attempts.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await screen.findByRole("dialog");
    expect(field("Namespace")).toHaveValue("edge");
    expect(screen.queryByText("Too many attempts.")).toBeNull();
  });
});

// D17d-1's paragraph of ADR 0024: a namespace, a gateway's name and a volume's paths are configuration text.
describe("KubernetesGroupDialog's privacy (Preflight rulings 15 and 37)", () => {
  /** Every attribute holding `text`: only an INPUT's value inside ph-no-capture may. */
  function expectOnlyInputValuesInsideNoCapture(text: string) {
    let holders = 0;
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (!attribute.value.includes(text)) continue;
        holders += 1;
        expect(`${element.tagName} ${attribute.name}`, text).toBe("INPUT value");
        expect(element.closest(".ph-no-capture"), text).not.toBeNull();
      }
    }
    return holders;
  }
  /** Every text node holding `text` is inside ph-no-capture (the dialog's title, a gateway's name, excepted by the caller). */
  function expectTextInsideNoCapture(text: string, except: (node: Node) => boolean = () => false) {
    let shown = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node.textContent ?? "").includes(text) || except(node)) continue;
      shown += 1;
      expect(node.parentElement?.closest(".ph-no-capture"), text).not.toBeNull();
    }
    return shown;
  }

  it("holds no namespace, gateway name or path in an attribute but its input's value inside ph-no-capture: Add gateway, every Select open", async () => {
    const name = "canary-gw-1c9e";
    const namespace = "canary-ns-77aa";
    const path = "/srv/canary-path-0d3f";
    const { user } = await renderDialog(addRow());
    await retype(user, field("Gateway name"), name);
    await retype(user, field("Namespace"), namespace);
    await user.click(screen.getByRole("button", { name: "Add volume" }));
    await user.type(screen.getByRole("textbox", { name: "Host path" }), path);
    await user.type(screen.getByRole("textbox", { name: "Mount path" }), path);
    await pickVersion(user);
    for (const text of [name, namespace, path]) expect(expectOnlyInputValuesInsideNoCapture(text), text).toBeGreaterThan(0);
    // The address repeats the name and the namespace: text inside ph-no-capture only.
    expect(expectTextInsideNoCapture(`${name}.${namespace}.svc.cluster.local`)).toBe(2);
    for (const select of ["Type", "Configuration", "Version"]) {
      await user.click(combobox(select));
      await screen.findAllByRole("option");
      for (const text of [name, namespace, path]) expectOnlyInputValuesInsideNoCapture(text);
      await user.keyboard("{Escape}");
    }
    // A refusal's words never repeat a value.
    fireEvent.change(field("Gateway name"), { target: { value: `${name}_` } });
    await user.click(submit());
    await screen.findByText(/start with a letter/);
    expectOnlyInputValuesInsideNoCapture(name);
  });

  it("keeps an Edit's namespace warning and a risky path's warning inside ph-no-capture", async () => {
    const namespace = "canary-saved-ns-5b2f";
    const typed = "canary-typed-ns-90e1";
    const risky = "/etc/canary-risky-3a7c";
    const { user } = await renderDialog(
      gatewaysRow({
        name: "canary-gateway-4d12",
        annotations: kubernetesAnnotations({ namespace, volumes: [{ hostPath: risky, hostPathType: "Directory", mountPath: "/m", readOnly: true }] }),
      }),
    );
    await retype(user, field("Namespace"), typed);
    expect(screen.getByText(namespaceChangeWarning("gateway", namespace, typed))).toBeInTheDocument();
    // The warning's words and its uninstall command (D17d-2 Preflight ruling 31).
    expect(expectTextInsideNoCapture(namespace)).toBe(2);
    expect(expectTextInsideNoCapture(risky)).toBe(1);
    for (const text of [namespace, typed, risky]) expectOnlyInputValuesInsideNoCapture(text);
    // The gateway's name: the title's text (the masked shell's), the address's inside ph-no-capture, no attribute.
    const titleText = (node: Node) => node.parentElement?.closest("h2") !== null;
    // The address and the uninstall command (D17d-2 Preflight ruling 31).
    expect(expectTextInsideNoCapture("canary-gateway-4d12", titleText)).toBe(3);
    expect(expectOnlyInputValuesInsideNoCapture("canary-gateway-4d12")).toBe(0);
    expect(within(dialog()).getByRole("heading")).toHaveTextContent("Edit canary-gateway-4d12");
  });

  // D18 Ruling 42 Nit 2: each role's warning repeats the namespaces in its own words (the Cluster's names the saved one
  // twice, a gateway's the typed one twice): visible text inside ph-no-capture only, in no attribute.
  it.each([
    ["the Agent", "node", "telflo-node"],
    ["the Cluster", "cluster", "telflo-cluster"],
    ["a gateway", "gateway", "gateways"],
  ] as const)("keeps %s's namespace warning inside ph-no-capture, its namespaces in no attribute", async (_who, role, release) => {
    const namespace = `canary-saved-${role}-6e3d`;
    const typed = `canary-typed-${role}-b81a`;
    const annotations = kubernetesAnnotations({ role, namespace, replicas: role === "gateway" ? 3 : undefined });
    const target: KubernetesGroupTarget =
      role === "node"
        ? agentRow(collectorGroup({ annotations }))
        : role === "cluster"
          ? { role, group: clusterGroup({ assignedPublishedVersionId: "p", assignedVersion: publishedVersion(), annotations }) }
          : gatewaysRow({ annotations });
    const { user } = await renderDialog(target);
    await retype(user, field("Namespace"), typed);
    const words = namespaceChangeWarning(role, namespace, typed);
    expect(screen.getByText(words).closest(".ph-no-capture")).not.toBeNull();
    const copy = screen.getByRole("button", { name: "Copy uninstall command" });
    expect(copy.closest(".ph-no-capture")!.querySelector("code")!.textContent).toBe(`helm uninstall '${release}' -n '${namespace}'`);
    // The saved namespace: the warning's words and the uninstall command; the typed one: the warning's words (and a
    // gateway's address).
    expect(expectTextInsideNoCapture(namespace)).toBe(2);
    expect(expectTextInsideNoCapture(typed)).toBe(role === "gateway" ? 3 : 1);
    expect(expectOnlyInputValuesInsideNoCapture(namespace)).toBe(0);
    expect(expectOnlyInputValuesInsideNoCapture(typed)).toBe(1);
  });

  it("puts every input of the dialog's fields inside ph-no-capture", async () => {
    await renderDialog(gatewaysRow({ annotations: kubernetesAnnotations({ volumes: [{ hostPath: "/a", hostPathType: "File", mountPath: "/b", readOnly: false }] }) }));
    for (const input of dialog().querySelectorAll("input")) {
      if (input.getAttribute("aria-hidden") === "true") continue;
      expect(input.closest(".ph-no-capture"), input.id).not.toBeNull();
    }
  });
});

// D20 (default 23; Q83, Q86; Preflight rulings 32 and 33): GroupDialog's Variable group and "Variables used".
describe("KubernetesGroupDialog's Variable group and Variables used (default 23)", () => {
  const EU_ID = "7b000000-0000-4000-8000-0000000000e1";

  beforeEach(() => {
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: EU_ID, name: "eu-edge" })]);
  });

  afterEach(() => {
    useUserStore.getState().clear();
    forgetOrgVariableNames();
    forgetVariableGroupNames();
  });

  it("saves the gateway's variable group alone, and clears it with None", async () => {
    const { user, onChanged } = await renderDialog(gatewaysRow());
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("None (organization values)");
    await user.click(combobox("Variable group"));
    await user.click(await screen.findByRole("option", { name: "eu-edge" }));
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { variableGroupId: EU_ID } }]);

    api.updates = [];
    const second = await renderDialogAgain(gatewaysRow({ variableGroupId: EU_ID }));
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("eu-edge");
    await second.user.click(combobox("Variable group"));
    await second.user.click(await screen.findByRole("option", { name: "None (organization values)" }));
    await second.user.click(submit());
    await waitFor(() => expect(second.onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { variableGroupId: null } }]);
  });

  it("adds a gateway with a variable group chosen", async () => {
    const { user, onChanged } = await renderDialog(addRow());
    await pickVersion(user);
    await user.click(await screen.findByRole("combobox", { name: "Variable group" }));
    await user.click(await screen.findByRole("option", { name: "eu-edge" }));
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates[0]).toMatchObject({ name: "gateway", assignedVersionId: V5_ID, variableGroupId: EU_ID });
  });

  it("lists the chosen version's undefined names before Save, inside ph-no-capture", async () => {
    vi.mocked(apiClient.getConfigurationVersion).mockImplementation(async (_organizationId, configurationId, versionId) =>
      answerFor({ ...THEIRS, id: configurationId }, versionFixture({ id: versionId, configurationId, yamlContent: "a: ${org:OTLP_EP}\nb: ${org:K8S_REGION}" })),
    );
    vi.mocked(apiClient.getOrganizationVariables).mockResolvedValue([organizationVariable({ name: "OTLP_EP" })]);
    await renderDialog(gatewaysRow());
    const missing = await screen.findByText("K8S_REGION");
    expect(missing.closest(".ph-no-capture")).not.toBeNull();
    expect(screen.queryByText("OTLP_EP")).toBeNull();
    expectNoAttributeHolds("K8S_REGION");
  });

  it("shows a 404 variable_group_not_found's words, and reads the variable groups again", async () => {
    api.answers = [refusal("variable_group_not_found", "Variable group not found", 404)];
    const { user } = await renderDialog(gatewaysRow());
    await user.click(await screen.findByRole("combobox", { name: "Variable group" }));
    await user.click(await screen.findByRole("option", { name: "eu-edge" }));
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("Variable group not found");
    await waitFor(() => expect(apiClient.getVariableGroups).toHaveBeenCalledTimes(2));
  });

  it("keeps the row it opened with, its variable group included, when the row is replaced (Ruling 66)", async () => {
    const { user, onChanged } = await renderDialog(gatewaysRow({ variableGroupId: EU_ID }), { replaced: gatewaysRow({ variableGroupId: null }) });
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("eu-edge");
    fireEvent.click(screen.getByRole("button", { name: "Replace", hidden: true }));
    expect(combobox("Variable group")).toHaveTextContent("eu-edge");
    await user.click(combobox("Variable group"));
    await user.click(await screen.findByRole("option", { name: "None (organization values)" }));
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { variableGroupId: null } }]);
  });
});

/** The dialog rendered afresh, the earlier one unmounted. */
async function renderDialogAgain(target: KubernetesGroupTarget) {
  cleanup();
  return renderDialog(target);
}
