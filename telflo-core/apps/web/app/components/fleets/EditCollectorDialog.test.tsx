import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  type Collector,
  type CollectorGroup,
  type Configuration,
  type ConfigurationsPage,
  type ConfigurationVersionListItem,
  type FleetType,
  type UpdateCollectorRequest,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED, type ConfigurationsQuery } from "~/lib/api-client.js";
import { FLEET_READ_TIMEOUT_MS, FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { answerFor, GROUP_ID, PERSONAL_ID, signedInMember, THEIRS, versionFixture } from "~/test/configurations.js";
import { forgetOrgVariableNames } from "~/lib/org-variables.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import {
  CLUSTER_GROUP_ID,
  COLLECTOR_ID,
  collector,
  collectorGroup,
  configurationVersionListItem,
  DEFAULT_GROUP_ID,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  INSTANCE_UID,
  kubernetesGroups,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  sha256Of,
  VERSION_ID,
  CONFIGURATION_ID,
  expectNoAttributeHolds,
  serveNoVariables,
} from "~/test/fleets.js";
import { COLLECTOR_NOT_FOUND_MESSAGE } from "./CollectorDetailsDialog.js";
import { CONFIGURATIONS_FAILED_MESSAGE, PICKER_PAGE_SIZE, VERSIONS_FAILED_MESSAGE } from "./CollectorPinPicker.js";
import {
  EditCollectorDialog,
  GROUP_NOT_LISTED_WORDS,
  GROUPS_UNREADABLE_WORDS,
  HINT_NEW_PIN,
  HINT_PIN_STILL_DECIDES,
  hintGroupNothing,
  hintGroupVersion,
  KUBERNETES_PIN_NOTE,
  UPDATE_COLLECTOR_FAILED_MESSAGE,
} from "./EditCollectorDialog.js";
import {
  VARIABLES_UNDEFINED_ASSIGNED_HINT,
  VARIABLES_UNDEFINED_HINT,
  VARIABLES_USED_LABEL,
  VARIABLES_USED_LOADING,
  allDefinedWords,
} from "./VariableGroupChoice.js";
import { pickerDate } from "./VersionOptionLabel.js";
import { organizationVariable, variableGroup } from "~/test/variables.js";

/*
 * "Edit collector": a pin changed without a rename sends no name (one PATCH),
 * and "OK" is disabled until something changes. The picker's own tests are
 * in `CollectorPinPicker.test.tsx`.
 */

const refusal = (code: string, message: string, status: number, options: { details?: unknown } = {}) =>
  new ApiError(code, message, { status, ...options });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const NAME_TAKEN_WORDS = "Another of the organization's collectors has this name.";
const NAME_TAKEN = () => refusal("collector_name_taken", NAME_TAKEN_WORDS, 409);

const PAYMENTS_ID = "c0ffee00-0000-4000-8000-000000000001";
const V5_ID = "c0ffee00-0000-4000-8000-000000000005";
const P2_ID = "c0ffee00-0000-4000-8000-000000000102";
const P1_ID = "c0ffee00-0000-4000-8000-000000000101";
const EMPTY_GROUP_ID = "c0ffee00-0000-4000-8000-0000000000e0";
const LATE_GROUP_ID = "c0ffee00-0000-4000-8000-0000000000e1";

const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };
const PAYMENTS: Configuration = { ...THEIRS, id: PAYMENTS_ID, name: "payments-otel" };

/** "edge" has nothing assigned, as Default. */
const edgeGroup = () => collectorGroup({ id: EMPTY_GROUP_ID, name: "edge", isDefault: false });
const GROUPS = (): CollectorGroup[] => [collectorGroup(), edgeGroup(), gatewaysGroup()];

/** A collector pinned to "checkout-otel @v4". */
const pinnedToV4 = (overrides: Partial<Collector> = {}) =>
  collector({
    pin: { kind: "version", versionId: VERSION_ID, publishedVersionId: PUBLISHED_VERSION_ID, version: publishedVersion() },
    resolution: { from: "pinnedVersion", publishedVersionId: PUBLISHED_VERSION_ID, sha256: sha256Of("a"), version: publishedVersion() },
    ...overrides,
  });

/** What the fake API holds, and every request it was sent. */
interface Api {
  configurations: Configuration[];
  /** The configurations list's page size, to exercise "Load more". */
  configurationsPage: number;
  configurationsFailures: unknown[];
  versions: Record<string, ConfigurationVersionListItem[]>;
  versionsFailures: unknown[];
  /** Holds a configuration's versions read until released. */
  versionsHolds: Map<string, Promise<void>>;
  groups: CollectorGroup[];
  groupsFailures: unknown[];
  /** Holds every configurations read until released. */
  configurationsHold: Promise<void> | null;
  /** Holds the groups reads until released, or forever (aborted by the signal). */
  groupsHold: "forever" | Promise<void> | null;
  updates: Array<"updated" | "hang" | Error>;
  requests: UpdateCollectorRequest[];
  signals: Array<AbortSignal | undefined>;
}

let api: Api;

const aborted = () => new ApiError(REQUEST_ABORTED, "The request was cancelled.");

function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(aborted()));
  });
}

function serve() {
  serveNoVariables();
  const getConfigurations = vi
    .spyOn(apiClient, "getConfigurations")
    .mockImplementation(async (organizationId, query: ConfigurationsQuery = {}): Promise<ConfigurationsPage> => {
      expect(organizationId).toBe(GROUP_ID);
      if (api.configurationsHold !== null) await api.configurationsHold;
      const failure = api.configurationsFailures.shift();
      if (failure !== undefined) throw failure;
      // No search: a read never sends q.
      expect(query.q).toBeUndefined();
      const rows = api.configurations;
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const end = start + api.configurationsPage;
      return { items: rows.slice(start, end), nextCursor: end < rows.length ? String(end) : null };
    });
  const getConfigurationVersions = vi
    .spyOn(apiClient, "getConfigurationVersions")
    .mockImplementation(async (organizationId, configurationId) => {
      expect(organizationId).toBe(GROUP_ID);
      const hold = api.versionsHolds.get(configurationId);
      if (hold !== undefined) await hold;
      const failure = api.versionsFailures.shift();
      if (failure !== undefined) throw failure;
      return { versions: api.versions[configurationId] ?? [] };
    });
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async (_organizationId, _fleetId, options = {}) => {
    if (api.groupsHold === "forever") return hang(options.signal);
    if (api.groupsHold !== null) await api.groupsHold;
    const failure = api.groupsFailures.shift();
    if (failure !== undefined) throw failure;
    return { groups: api.groups };
  });
  const updateCollector = vi.spyOn(apiClient, "updateCollector").mockImplementation((organizationId, fleetId, collectorId, request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    expect(collectorId).toBe(COLLECTOR_ID);
    api.requests.push(request);
    api.signals.push(options.signal);
    const answer = api.updates.shift() ?? "updated";
    if (answer === "updated") return Promise.resolve(collector());
    if (answer === "hang") return hang(options.signal);
    return Promise.reject(answer);
  });
  return { getConfigurations, getConfigurationVersions, getCollectorGroups, updateCollector };
}

let spies: ReturnType<typeof serve>;

interface RenderOptions {
  /** The tab's groups; null as when the tab's groups read failed. */
  groups?: CollectorGroup[] | null;
  /** The fleet's type; left out, the dialog's default (a server fleet). */
  fleetType?: FleetType;
}

/** The dialog open for `row` in GROUP_ID, on a page that can reopen it and switch organization; a loader counts revalidations. */
async function renderEdit(row: Collector = collector(), options: RenderOptions = {}) {
  const mounted = mountEdit(row, options);
  const user = userEvent.setup();
  await screen.findByRole("dialog", { name: "Edit collector" });
  return { user, ...mounted };
}

/** The same, mounted without waiting (for a test on fake timers). */
function mountEdit(row: Collector = collector(), { groups = GROUPS(), fleetType }: RenderOptions = {}) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const loader = vi.fn(() => null);
  function Page() {
    const [open, setOpen] = useState(true);
    const [organizationId, setOrganizationId] = useState(GROUP_ID);
    return (
      <>
        <button type="button" onClick={() => setOrganizationId(PERSONAL_ID)}>
          Switch
        </button>
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
        <EditCollectorDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          collector={row}
          organizationId={organizationId}
          fleetId={FLEET_ID}
          groups={groups}
          {...(fleetType === undefined ? {} : { fleetType })}
          onChanged={onChanged}
        />
      </>
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader, HydrateFallback: () => null }]);
  render(<Stub initialEntries={["/"]} />);
  return { onOpenChange, onChanged, loader };
}

type User = ReturnType<typeof userEvent.setup>;

const nameField = () => screen.getByRole("textbox", { name: "Name" });
const ok = () => screen.getByRole("button", { name: /^(OK|Saving…)$/ });
const combobox = (name: string) => screen.getByRole("combobox", { name });

/** Opens the Select labeled `label` and picks `option`. */
async function choose(user: User, label: string, option: string | RegExp) {
  await user.click(combobox(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function rename(user: User, to: string) {
  await user.clear(nameField());
  await user.type(nameField(), to);
}

/** Waits for the opening's read: the configurations. */
async function settled() {
  await waitFor(() => expect(spies.getConfigurations).toHaveBeenCalled());
}

beforeEach(() => {
  vi.restoreAllMocks();
  api = {
    configurations: [CHECKOUT, PAYMENTS],
    configurationsPage: PICKER_PAGE_SIZE,
    configurationsFailures: [],
    versions: {
      [CONFIGURATION_ID]: [
        configurationVersionListItem({ id: V5_ID, versionNumber: 5, label: "add redis cache" }),
        configurationVersionListItem(),
      ],
      [PAYMENTS_ID]: [
        configurationVersionListItem({ id: P2_ID, versionNumber: 2 }),
        configurationVersionListItem({ id: P1_ID, versionNumber: 1 }),
      ],
    },
    versionsFailures: [],
    versionsHolds: new Map(),
    groups: GROUPS(),
    groupsFailures: [],
    configurationsHold: null,
    groupsHold: null,
    updates: [],
    requests: [],
    signals: [],
  };
  spies = serve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EditCollectorDialog's rename and pin", () => {
  it("pins a different configuration (its newest version) in one request, sending no name", async () => {
    const { user, onChanged } = await renderEdit(pinnedToV4());
    await settled();

    await choose(user, "Configuration", "payments-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    await user.click(ok());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: { kind: "version", versionId: P2_ID } }]);
  });

  it("keeps OK disabled until something changes", async () => {
    await renderEdit();
    expect(ok()).toBeDisabled();
  });
});

describe("EditCollectorDialog's fields", () => {
  it("opens with the title, the description, the UID, the Name, the Group and the Pin", async () => {
    const { user } = await renderEdit();
    const dialog = screen.getByRole("dialog");
    // The description and the Pin's choices name published versions only.
    expect(within(dialog).getByText(/Rename this collector/)).toHaveTextContent(
      /^Rename this collector, move it to another group, or pin it to a published version or a variable group\. Names must be unique within your organization; “Follow the group” clears its pin\.$/,
    );
    expect(dialog).toHaveTextContent(`UID: ${INSTANCE_UID}`);
    expect(nameField()).toHaveValue("web-01");
    expect(nameField()).toHaveAttribute("maxLength", "200");
    expect(combobox("Group")).toHaveTextContent("Default");
    expect(combobox("Pin")).toHaveTextContent("Follow the group");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.click(combobox("Pin"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Follow the group", "A published version"]);
  });

  it('sends the Name trimmed, toasts "Collector updated", closes and reloads', async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = await renderEdit();

    await rename(user, "  web-01-eu  ");
    await user.click(ok());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ name: "web-01-eu" }]);
    expect(toastSuccess).toHaveBeenCalledWith("Collector updated");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("counts a whitespace-only change of the Name as none, and an empty Name as nothing to send", async () => {
    const { user } = await renderEdit();
    await rename(user, " web-01  ");
    expect(ok()).toBeDisabled();
    await user.clear(nameField());
    await user.type(nameField(), "   ");
    expect(ok()).toBeDisabled();
  });

  it("shows a Name the contract refuses under the field, nothing sent", async () => {
    const { user } = await renderEdit();
    await user.clear(nameField());
    fireEvent.change(nameField(), { target: { value: "web\u0007bell" } });
    await user.click(ok());
    expect(await screen.findByText("Must not start or end with a space, or hold a control character.")).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(spies.updateCollector).not.toHaveBeenCalled();
  });

  it("shows a taken name under the Name, and clears it on typing", async () => {
    api.updates = [NAME_TAKEN()];
    const { user, onOpenChange } = await renderEdit();
    await rename(user, "web-02");
    await user.click(ok());
    expect(await screen.findByText(NAME_TAKEN_WORDS)).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.type(nameField(), "x");
    expect(screen.queryByText(NAME_TAKEN_WORDS)).toBeNull();
  });

  it("shows a 400's name problem under the Name, never the API's invalid_request words", async () => {
    api.updates = [
      refusal("invalid_request", "The request was not valid.", 400, {
        details: [{ instancePath: "/name", message: "Must be 1 to 200 characters.", params: { issue: { path: ["name"] } } }],
      }),
    ];
    const { user } = await renderEdit();
    await rename(user, "web-02");
    await user.click(ok());
    expect(await screen.findByText("Must be 1 to 200 characters.")).toBeInTheDocument();
    expect(screen.queryByText("The request was not valid.")).toBeNull();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
  });

  it("renames, moves and pins together, in one request", async () => {
    const { user, onChanged } = await renderEdit(pinnedToV4());
    await settled();
    await rename(user, "web-01-eu");
    await choose(user, "Group", "gateways");
    await choose(user, "Pin", "Follow the group");
    await user.click(ok());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(spies.updateCollector).toHaveBeenCalledTimes(1);
    expect(api.requests).toEqual([{ name: "web-01-eu", groupId: GATEWAYS_GROUP_ID, pin: null }]);
  });

  it("moves alone, sending only the group", async () => {
    const { user, onChanged } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ groupId: GATEWAYS_GROUP_ID }]);
  });
});

describe("EditCollectorDialog's pin", () => {
  it("pins a following collector to a published version: a configuration chosen selects its newest version", async () => {
    const { user, onChanged } = await renderEdit();
    await settled();
    await choose(user, "Pin", "A published version");
    expect(ok()).toBeDisabled();
    await choose(user, "Configuration", "checkout-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v5"));
    await choose(user, "Version", /@v4/);
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: { kind: "version", versionId: VERSION_ID } }]);
  });

  it("keeps OK disabled for a published version with none chosen, even with a rename", async () => {
    const { user } = await renderEdit();
    await settled();
    await rename(user, "web-01-eu");
    expect(ok()).toBeEnabled();
    await choose(user, "Pin", "A published version");
    await screen.findByRole("combobox", { name: "Configuration" });
    expect(combobox("Version")).toHaveTextContent("Pick a version");
    expect(ok()).toBeDisabled();
    fireEvent.submit(nameField().closest("form")!);
    expect(spies.updateCollector).not.toHaveBeenCalled();
  });

  it("unpins with null", async () => {
    const { user, onChanged } = await renderEdit(pinnedToV4());
    await choose(user, "Pin", "Follow the group");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: null }]);
  });

  it("preselects the current pin: its configuration and version, and sends nothing for choosing them again", async () => {
    const { user } = await renderEdit(pinnedToV4());
    await settled();
    expect(combobox("Pin")).toHaveTextContent("A published version");
    expect(combobox("Configuration")).toHaveTextContent("checkout-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    await choose(user, "Pin", "Follow the group");
    await choose(user, "Pin", "A published version");
    expect(ok()).toBeDisabled();
  });

  it("keeps an orphan pin (a deleted configuration's version) unless changed: never sent back", async () => {
    const orphan = collector({
      pin: { kind: "version", versionId: null, publishedVersionId: PUBLISHED_VERSION_ID, version: null },
      resolution: { from: "pinnedVersion", publishedVersionId: PUBLISHED_VERSION_ID, sha256: sha256Of("a"), version: null },
    });
    const { user, onChanged } = await renderEdit(orphan);
    expect(combobox("Pin")).toHaveTextContent("A deleted configuration's version");
    await rename(user, "web-01-eu");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ name: "web-01-eu" }]);
  });

  it("sends an orphan pin's change: unpinned with null", async () => {
    const orphan = collector({ pin: { kind: "version", versionId: null, publishedVersionId: PUBLISHED_VERSION_ID, version: null } });
    const { user, onChanged } = await renderEdit(orphan);
    expect(ok()).toBeDisabled();
    await choose(user, "Pin", "Follow the group");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: null }]);
  });

  it("offers the orphan choice only for an orphan pin", async () => {
    const { user } = await renderEdit(pinnedToV4());
    await user.click(combobox("Pin"));
    expect(await screen.findByRole("option", { name: "Follow the group" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "A deleted configuration's version" })).toBeNull();
  });

  it("offers an orphan pin exactly three choices: the group, a published version and the deleted configuration's version", async () => {
    const orphan = collector({ pin: { kind: "version", versionId: null, publishedVersionId: PUBLISHED_VERSION_ID, version: null } });
    const { user } = await renderEdit(orphan);
    await user.click(combobox("Pin"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Follow the group",
      "A published version",
      "A deleted configuration's version",
    ]);
  });
});

/** "Follow the group" offered and not disabled (never refused); the Pin's list closed again. */
async function expectFollowAllowed(user: User) {
  await user.click(combobox("Pin"));
  expect(await screen.findByRole("option", { name: "Follow the group" })).not.toHaveAttribute("aria-disabled");
  await user.keyboard("{Escape}");
}

describe("EditCollectorDialog's Follow the group", () => {
  it("'Follow the group' is never refused: a pinned collector in a group with no published version unpins", async () => {
    const { user, onChanged } = await renderEdit(pinnedToV4());
    expect(screen.queryByText(/imported|couldn't be read/)).toBeNull();
    await user.click(combobox("Pin"));
    expect(await screen.findByRole("option", { name: "Follow the group" })).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByRole("option", { name: "Follow the group" }));
    expect(combobox("Pin")).not.toHaveAccessibleDescription();
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: null }]);
  });
});

describe("EditCollectorDialog's hint", () => {
  it("says a new pin is sent on the next poll", async () => {
    const { user } = await renderEdit();
    await settled();
    await choose(user, "Pin", "A published version");
    await choose(user, "Configuration", "payments-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    expect(screen.getByText(HINT_NEW_PIN)).toBeInTheDocument();
    expect(HINT_NEW_PIN).toBe("It is sent this configuration on its next poll.");
  });

  it("says an unpin to a group with a published version is sent that version", async () => {
    const { user } = await renderEdit(pinnedToV4({ groupId: GATEWAYS_GROUP_ID }));
    await choose(user, "Pin", "Follow the group");
    expect(screen.getByText(hintGroupVersion("gateways"))).toBeInTheDocument();
    expect(hintGroupVersion("gateways")).toBe("It is sent gateways's published version on its next poll.");
  });

  it("says a move of a following collector to a group with a published version is sent it", async () => {
    const { user } = await renderEdit();
    await choose(user, "Group", "gateways");
    expect(screen.getByText(hintGroupVersion("gateways"))).toBeInTheDocument();
  });

  it("says a move of a following collector to a group with none shows Nothing assigned", async () => {
    const { user } = await renderEdit(collector({ groupId: GATEWAYS_GROUP_ID }));
    await choose(user, "Group", "edge");
    expect(screen.getByText(hintGroupNothing("edge"))).toBeInTheDocument();
    expect(hintGroupNothing("edge")).toBe("edge has no published version: it shows Nothing assigned and keeps running what it has.");
  });

  it("says a pinned collector's move leaves its pin deciding", async () => {
    const { user } = await renderEdit(pinnedToV4());
    await choose(user, "Group", "gateways");
    expect(screen.getByText(HINT_PIN_STILL_DECIDES)).toBeInTheDocument();
    expect(HINT_PIN_STILL_DECIDES).toBe("Its pin still decides what it runs.");
  });

  it("says nothing for a rename alone, or nothing changed", async () => {
    const { user } = await renderEdit();
    expect(screen.queryByText(/next poll|Nothing assigned|still decides/)).toBeNull();
    await rename(user, "web-01-eu");
    expect(screen.queryByText(/next poll|Nothing assigned|still decides/)).toBeNull();
  });
});

describe("EditCollectorDialog on a Kubernetes-supervisor fleet", () => {
  const K8S = { groups: kubernetesGroups(), fleetType: "kubernetes-supervisor" } as const;

  it("puts the canary note under the Pin select, which it describes, whatever the Pin chosen", async () => {
    const { user } = await renderEdit(collector(), K8S);
    const note = screen.getByText(KUBERNETES_PIN_NOTE);
    expect(KUBERNETES_PIN_NOTE).toBe("A rescheduled pod is a new collector: it follows its group again.");
    expect(note).toHaveClass("text-muted-foreground");
    expect(combobox("Pin")).toHaveAttribute("aria-describedby", note.id);
    expect(combobox("Pin")).toHaveAccessibleDescription(KUBERNETES_PIN_NOTE);
    await choose(user, "Pin", "A published version");
    expect(screen.getByText(KUBERNETES_PIN_NOTE)).toBe(note);
    expect(combobox("Pin")).toHaveAccessibleDescription(KUBERNETES_PIN_NOTE);
  });

  it("has no canary note on a server fleet", async () => {
    await renderEdit();
    expect(screen.queryByText(KUBERNETES_PIN_NOTE)).toBeNull();
    expect(combobox("Pin")).not.toHaveAttribute("aria-describedby");
  });

  it("names the Agent and the Cluster by role in the Group select, listed Agent, Cluster, then the gateways in the API's order", async () => {
    const { user } = await renderEdit(collector(), K8S);
    expect(combobox("Group")).toHaveTextContent(/^Agent$/);
    await user.click(combobox("Group"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Agent", "Cluster", "alpha", "gateways"]);
    await user.click(screen.getByRole("option", { name: "Cluster" }));
    expect(combobox("Group")).toHaveTextContent(/^Cluster$/);
  });

  it("names the Agent and the Cluster by role in the hints", async () => {
    const groups = kubernetesGroups().map((group) =>
      group.isDefault ? { ...group, assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() } : group,
    );
    const { user } = await renderEdit(collector({ groupId: GATEWAYS_GROUP_ID }), { groups, fleetType: "kubernetes-supervisor" });
    await choose(user, "Group", "Agent");
    expect(screen.getByText("It is sent Agent's published version on its next poll.")).toBeInTheDocument();
    await choose(user, "Group", "Cluster");
    expect(screen.getByText("Cluster has no published version: it shows Nothing assigned and keeps running what it has.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/Default|cluster has/);
  });

  it("moves to the Cluster by its group's id", async () => {
    const { user, onChanged } = await renderEdit(collector(), K8S);
    await choose(user, "Group", "Cluster");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ groupId: CLUSTER_GROUP_ID }]);
  });
});

describe("EditCollectorDialog's picker reads", () => {
  it("reads the published configurations (100, no search) on opening, and the pinned configuration's versions", async () => {
    await renderEdit(pinnedToV4());
    await settled();
    expect(spies.getConfigurations).toHaveBeenCalledTimes(1);
    expect(spies.getConfigurations.mock.calls[0]![1]).toEqual({ filter: "published", limit: 100 });
    expect(spies.getConfigurations.mock.calls[0]![2]!.signal).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(spies.getConfigurationVersions).toHaveBeenCalledTimes(1));
    expect(spies.getConfigurationVersions.mock.calls[0]![1]).toBe(CONFIGURATION_ID);
    expect(spies.getConfigurationVersions.mock.calls[0]![2]).toMatchObject({ filter: "published" });
    expect(spies.getCollectorGroups).not.toHaveBeenCalled();
  });

  it('shows "Loading configurations…" until the configurations answer', async () => {
    let release!: () => void;
    api.configurationsHold = new Promise((resolve) => (release = resolve));
    const { user } = await renderEdit();
    await choose(user, "Pin", "A published version");
    expect(screen.getByText("Loading configurations…")).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByRole("combobox", { name: "Configuration" })).toBeInTheDocument();
  });

  it('shows a failed read with "Try again", which reads again', async () => {
    api.configurationsFailures = [UNAVAILABLE()];
    const { user } = await renderEdit();
    await choose(user, "Pin", "A published version");
    expect(await screen.findByText(CONFIGURATIONS_FAILED_MESSAGE)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("combobox", { name: "Configuration" })).toBeInTheDocument();
    expect(spies.getConfigurations).toHaveBeenCalledTimes(2);
  });

  it('pages with "Load more" below the Configuration select, resending the filter with the cursor', async () => {
    api.configurations = [CHECKOUT, PAYMENTS, { ...THEIRS, id: "c0ffee00-0000-4000-8000-0000000000c3", name: "checkout-eu" }];
    api.configurationsPage = 1;
    const { user } = await renderEdit();
    await choose(user, "Pin", "A published version");
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(spies.getConfigurations).toHaveBeenCalledTimes(2));
    expect(spies.getConfigurations.mock.calls[1]![1]).toEqual({ filter: "published", limit: 100, cursor: "1" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(spies.getConfigurations).toHaveBeenCalledTimes(3));
    expect(spies.getConfigurations.mock.calls[2]![1]).toEqual({ filter: "published", limit: 100, cursor: "2" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
    await user.click(combobox("Configuration"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["checkout-otel", "payments-otel", "checkout-eu"]);
  });

  it('toasts a failed "Load more" and keeps the configurations', async () => {
    api.configurationsPage = 1;
    const toastError = vi.spyOn(toast, "error");
    const { user } = await renderEdit();
    await choose(user, "Pin", "A published version");
    await screen.findByRole("button", { name: "Load more" });
    api.configurationsFailures = [UNAVAILABLE()];
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(CONFIGURATIONS_FAILED_MESSAGE));
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    await user.click(combobox("Configuration"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["checkout-otel"]);
  });

  // No search box; more than a page is reached by "Load more".
  it("offers no configuration search box, and says when there is no published configuration", async () => {
    api.configurations = [];
    const { user } = await renderEdit();
    await choose(user, "Pin", "A published version");
    expect(await screen.findByText("No published configurations.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { hidden: true })).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    // The dialog's one text field is the Name.
    expect(screen.getAllByRole("textbox")).toEqual([screen.getByRole("textbox", { name: "Name" })]);
  });

  it("always offers the current pin's configuration, even when the list leaves it out", async () => {
    api.configurations = [PAYMENTS];
    const { user } = await renderEdit(pinnedToV4());
    await settled();
    await user.click(combobox("Configuration"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["checkout-otel", "payments-otel"]);
  });

  it("shows the versions' read failing with \"Try again\"", async () => {
    api.versionsFailures = [UNAVAILABLE()];
    const { user } = await renderEdit(pinnedToV4());
    expect(await screen.findByText(VERSIONS_FAILED_MESSAGE)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
  });

  it("preselects the newest version once a failed versions read is tried again", async () => {
    const { user, onChanged } = await renderEdit();
    await settled();
    await choose(user, "Pin", "A published version");
    api.versionsFailures = [UNAVAILABLE()];
    await choose(user, "Configuration", "payments-otel");
    expect(await screen.findByText(VERSIONS_FAILED_MESSAGE)).toBeInTheDocument();
    expect(ok()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    expect(spies.getConfigurationVersions).toHaveBeenCalledTimes(2);
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: { kind: "version", versionId: P2_ID } }]);
  });

  it("drops a configuration's versions answered after another configuration was chosen", async () => {
    let release!: () => void;
    api.versionsHolds.set(PAYMENTS_ID, new Promise((resolve) => (release = resolve)));
    const { user, onChanged } = await renderEdit();
    await settled();
    await choose(user, "Pin", "A published version");
    // payments-otel's versions are held; checkout-otel's, chosen after, answer at once.
    await choose(user, "Configuration", "payments-otel");
    await waitFor(() => expect(spies.getConfigurationVersions).toHaveBeenCalledTimes(1));
    await choose(user, "Configuration", "checkout-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v5"));

    await act(async () => release());
    await waitFor(() => expect(spies.getConfigurationVersions).toHaveBeenCalledTimes(2));
    expect(combobox("Version")).toHaveTextContent("@v5");
    expect(combobox("Version")).toBeEnabled();
    await user.click(combobox("Version"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      `@v5add redis cache${pickerDate("2026-10-12T09:00:00.000Z")}`,
      `@v4${pickerDate("2026-10-12T09:00:00.000Z")}`,
    ]);
    await user.keyboard("{Escape}");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: { kind: "version", versionId: V5_ID } }]);
  });

  it("lists a configuration's versions as VersionOptionLabels, newest first, the group's marked", async () => {
    const { user } = await renderEdit(pinnedToV4({ groupId: GATEWAYS_GROUP_ID }));
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    await user.click(combobox("Version"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      `@v5add redis cache${pickerDate("2026-10-12T09:00:00.000Z")}`,
      `@v4 (group default)${pickerDate("2026-10-12T09:00:00.000Z")}`,
    ]);
  });

});

describe("EditCollectorDialog's refusals", () => {
  it.each([
    ["configuration_version_not_published", "This version isn't published: publish it before assigning or pinning it.", 409],
    ["configuration_version_not_found", "Version not found", 404],
    ["collector_group_not_found", "Collector group not found.", 404],
    ["rate_limited", "Too many attempts. Please wait and try again.", 429],
  ])("shows %s's words in the dialog, which stays open", async (code, words, status) => {
    api.updates = [refusal(code, words, status)];
    const { user, onOpenChange, onChanged } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(ok()).toBeEnabled();
  });

  it("shows the fallback for a refusal it doesn't know", async () => {
    api.updates = [refusal("invalid_request", "The request was not valid.", 400)];
    const { user } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    expect(await screen.findByRole("alert")).toHaveTextContent(UPDATE_COLLECTOR_FAILED_MESSAGE);
  });

  it('on a 404 collector_not_found, toasts "Collector not found", closes and reloads', async () => {
    api.updates = [refusal("collector_not_found", "Collector not found.", 404)];
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(COLLECTOR_NOT_FOUND_MESSAGE);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on a 404 fleet_not_found, toasts the API's words, closes and reloads", async () => {
    api.updates = [refusal("fleet_not_found", "Fleet not found.", 404)];
    const toastError = vi.spyOn(toast, "error");
    const { user, onChanged } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Fleet not found.");
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    api.updates = [failure()];
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged, loader } = await renderEdit();
    const loads = loader.mock.calls.length;
    await choose(user, "Group", "gateways");
    await user.click(ok());
    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    api.updates = [refusal("unauthenticated", "You need to sign in.", 401)];
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    await waitFor(() => expect(ok()).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("EditCollectorDialog's unknown outcome", () => {
  it.each([
    ["a 503 fleets_unavailable", UNAVAILABLE],
    ["a 500", () => refusal("internal_error", "Something went wrong.", 500)],
    ["no connection", () => new ApiError("network_error", "Could not reach the server.")],
  ])("after %s, shows the 503's words, keeps the dialog open, and a retry sends the same request", async (_why, failure) => {
    api.updates = [failure()];
    const { user, onOpenChange, onChanged } = await renderEdit();
    await rename(user, "web-01-eu");
    await choose(user, "Group", "gateways");
    await user.click(ok());
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([
      { name: "web-01-eu", groupId: GATEWAYS_GROUP_ID },
      { name: "web-01-eu", groupId: GATEWAYS_GROUP_ID },
    ]);
  });

  it.each([
    ["Cancel", async (user: User) => user.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Escape", async (user: User) => user.keyboard("{Escape}")],
    ["the X", async (user: User) => user.click(screen.getByRole("button", { name: "Close" }))],
  ])("closed by %s after an unknown outcome, reloads once", async (_how, closeIt) => {
    api.updates = [UNAVAILABLE()];
    const { user, onChanged } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    await screen.findByRole("alert");
    expect(onChanged).not.toHaveBeenCalled();
    await closeIt(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("closed after a refusal that leaves nothing unknown, doesn't reload", async () => {
    api.updates = [NAME_TAKEN()];
    const { user, onChanged } = await renderEdit();
    await rename(user, "web-02");
    await user.click(ok());
    await screen.findByText(NAME_TAKEN_WORDS);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("ends an update that never answers at 30 s, with the 503's words (it may or may not have been made)", async () => {
    api.updates = ["hang"];
    const { user, onOpenChange, onChanged } = await renderEdit();
    await choose(user, "Group", "gateways");

    vi.useFakeTimers();
    fireEvent.click(ok());
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(api.signals[0]!.aborted).toBe(false);
    expect(ok()).toHaveTextContent("Saving…");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(api.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(ok()).toBeEnabled();
  });
});

describe("EditCollectorDialog while saving", () => {
  it("can't be closed: Cancel disabled, no X, Escape and an outside click do nothing, every field disabled", async () => {
    api.updates = ["hang"];
    const { user, onOpenChange } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());

    expect(ok()).toHaveTextContent("Saving…");
    expect(ok()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(nameField()).toBeDisabled();
    expect(combobox("Group")).toBeDisabled();
    expect(combobox("Pin")).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit collector" })).toBeInTheDocument();
  });

  it("sends once on a double Enter", async () => {
    api.updates = ["hang"];
    await renderEdit();
    fireEvent.change(nameField(), { target: { value: "web-02" } });
    fireEvent.submit(nameField().closest("form")!);
    fireEvent.submit(nameField().closest("form")!);
    expect(spies.updateCollector).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the update", (settle: { resolve: (value: Collector) => void; reject: (failure: unknown) => void }) => settle.resolve(collector())],
    ["a 404", (settle: { resolve: (value: Collector) => void; reject: (failure: unknown) => void }) => settle.reject(refusal("collector_not_found", "Collector not found.", 404))],
    ["a 503", (settle: { resolve: (value: Collector) => void; reject: (failure: unknown) => void }) => settle.reject(UNAVAILABLE())],
  ])("drops %s answered after the organization changed: no toast, no message, no reload", async (_why, answer) => {
    let settle!: { resolve: (value: Collector) => void; reject: (failure: unknown) => void };
    spies.updateCollector.mockImplementation(() => new Promise((resolve, reject) => (settle = { resolve, reject })));
    const toastError = vi.spyOn(toast, "error");
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = await renderEdit();
    await choose(user, "Group", "gateways");
    await user.click(ok());
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));

    await act(async () => answer(settle));

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens afresh: the fields hold the collector again, with no earlier refusal", async () => {
    api.updates = [NAME_TAKEN()];
    const { user } = await renderEdit();
    await rename(user, "web-02");
    await choose(user, "Group", "gateways");
    await user.click(ok());
    await screen.findByText(NAME_TAKEN_WORDS);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("web-01");
    expect(combobox("Group")).toHaveTextContent("Default");
    expect(screen.queryByText(NAME_TAKEN_WORDS)).toBeNull();
  });
});

describe("EditCollectorDialog without the tab's groups", () => {
  it('reads the groups itself on opening: "Loading groups…", "Follow the group" allowed meanwhile', async () => {
    let release!: () => void;
    api.groupsHold = new Promise((resolve) => (release = resolve));
    const { user } = await renderEdit(pinnedToV4({ groupId: GATEWAYS_GROUP_ID }), { groups: null });
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1);
    expect(spies.getCollectorGroups.mock.calls[0]![2]!.signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText("Loading groups…")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Group" })).toBeNull();
    expect(screen.queryByText(/couldn't be read/)).toBeNull();
    await user.click(combobox("Pin"));
    expect(await screen.findByRole("option", { name: "Follow the group" })).not.toHaveAttribute("aria-disabled");
    await user.keyboard("{Escape}");

    await act(async () => release());
    expect(await screen.findByRole("combobox", { name: "Group" })).toHaveTextContent("gateways");
    await user.click(combobox("Pin"));
    expect(await screen.findByRole("option", { name: "Follow the group" })).not.toHaveAttribute("aria-disabled");
  });

  it('after a failure says "The groups couldn\'t be read." with "Try again", which reads again', async () => {
    api.groupsFailures = [UNAVAILABLE()];
    const { user } = await renderEdit(pinnedToV4({ groupId: GATEWAYS_GROUP_ID }), { groups: null });
    expect(await screen.findByText(GROUPS_UNREADABLE_WORDS)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Group" })).toBeNull();
    await user.click(combobox("Pin"));
    expect(await screen.findByRole("option", { name: "Follow the group" })).not.toHaveAttribute("aria-disabled");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("combobox", { name: "Group" })).toBeInTheDocument();
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(2);
  });

  it("ends a groups read that never answers at 10 s, as a failure", async () => {
    api.groupsHold = "forever";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mountEdit(collector(), { groups: null });
    await act(async () => {});
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1);
    const signal = spies.getCollectorGroups.mock.calls[0]![2]!.signal!;
    await act(() => vi.advanceTimersByTimeAsync(FLEET_READ_TIMEOUT_MS - 1));
    expect(signal.aborted).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(signal.aborted).toBe(true);
    vi.useRealTimers();
    expect(await screen.findByText(GROUPS_UNREADABLE_WORDS)).toBeInTheDocument();
    await expectFollowAllowed(userEvent.setup());
  });

  it('shows no hint and no "(group default)" marker while it has no groups, and still sends a rename or a pin', async () => {
    api.groupsFailures = [UNAVAILABLE()];
    const { user, onChanged } = await renderEdit(pinnedToV4({ groupId: GATEWAYS_GROUP_ID }), { groups: null });
    await screen.findByText(GROUPS_UNREADABLE_WORDS);
    await expectFollowAllowed(user);
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    await choose(user, "Version", /@v5/);
    expect(screen.queryByText(HINT_NEW_PIN)).toBeNull();
    await user.click(combobox("Configuration"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["checkout-otel", "payments-otel"]);
    await user.keyboard("{Escape}");
    await user.click(combobox("Version"));
    expect(screen.queryByText(/group default/)).toBeNull();
    await user.keyboard("{Escape}");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: { kind: "version", versionId: V5_ID } }]);
  });

  it("reads the groups itself when the tab's don't hold the collector's group (one made since): never an empty group name", async () => {
    // The details' refreshed collector, in a group made after the tab's last groups read; the group has no published version.
    let release!: () => void;
    api.groupsHold = new Promise((resolve) => (release = resolve));
    api.groups = [...GROUPS(), collectorGroup({ id: LATE_GROUP_ID, name: "late-group", isDefault: false })];
    const { user } = await renderEdit(pinnedToV4({ groupId: LATE_GROUP_ID }), { groups: GROUPS() });
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading groups…")).toBeInTheDocument();
    await expectFollowAllowed(user);

    await act(async () => release());
    expect(await screen.findByRole("combobox", { name: "Group" })).toHaveTextContent("late-group");
    await choose(user, "Group", "gateways");
    await choose(user, "Pin", "Follow the group");
    expect(screen.getByText(hintGroupVersion("gateways"))).toBeInTheDocument();
  });

  it("counts its own read without the collector's group as unreadable: no blank Group, no empty name", async () => {
    const { user } = await renderEdit(pinnedToV4({ groupId: LATE_GROUP_ID }), { groups: GROUPS() });
    expect(await screen.findByText(GROUPS_UNREADABLE_WORDS)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Group" })).toBeNull();
    await expectFollowAllowed(user);
    // Once the group is there, Try again shows it.
    api.groups = [...GROUPS(), collectorGroup({ id: LATE_GROUP_ID, name: "late-group", isDefault: false })];
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("combobox", { name: "Group" })).toHaveTextContent("late-group");
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(2);
  });

  it("marks the chosen group's assignment when it knows the groups", async () => {
    const { user } = await renderEdit(pinnedToV4({ groupId: GATEWAYS_GROUP_ID }));
    await settled();
    await user.click(combobox("Configuration"));
    expect(await screen.findByRole("option", { name: "checkout-otel (group default)" })).toBeInTheDocument();
  });
});

/** The dialog open for `row`, its tab's groups changeable from the test (`setTabGroups`); under StrictMode when `strict`. */
function mountWithTabGroups(row: Collector, initial: CollectorGroup[] | null, { strict = false } = {}) {
  let setTabGroups!: (groups: CollectorGroup[] | null) => void;
  function Page() {
    const [open, setOpen] = useState(true);
    const [groups, setGroups] = useState(initial);
    setTabGroups = setGroups;
    return (
      <EditCollectorDialog open={open} onOpenChange={setOpen} collector={row} organizationId={GROUP_ID} fleetId={FLEET_ID} groups={groups} onChanged={vi.fn()} />
    );
  }
  const Stub = createRoutesStub([{ path: "/", Component: Page, loader: () => null, HydrateFallback: () => null }]);
  render(strict ? <StrictMode><Stub initialEntries={["/"]} /></StrictMode> : <Stub initialEntries={["/"]} />);
  return { user: userEvent.setup(), setTabGroups: (groups: CollectorGroup[] | null) => act(() => setTabGroups(groups)) };
}

// The dialog's own groups read, and a group the shown groups lost.
describe("EditCollectorDialog when the tab's groups change while it is open", () => {
  it("reads the groups itself once a tab's answer drops the collector's group, never left on \"Loading groups…\"", async () => {
    const { setTabGroups } = mountWithTabGroups(collector({ groupId: GATEWAYS_GROUP_ID }), GROUPS());
    expect(await screen.findByRole("combobox", { name: "Group" })).toHaveTextContent("gateways");
    expect(spies.getCollectorGroups).not.toHaveBeenCalled();

    // A tab's answer since the opening (a reload under way when it opened) no longer holds gateways.
    await setTabGroups([collectorGroup(), edgeGroup()]);
    await waitFor(() => expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("combobox", { name: "Group" })).toHaveTextContent("gateways");
    expect(screen.queryByText("Loading groups…")).toBeNull();

    // Held again, then dropped again: its own read is kept, none made again this opening.
    await setTabGroups(GROUPS());
    await setTabGroups(null);
    expect(screen.getByRole("combobox", { name: "Group" })).toHaveTextContent("gateways");
    expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1);
  });

  it("names a Group chosen that the groups shown no longer hold with neutral words: never a blank trigger or an empty name", async () => {
    const { user, setTabGroups } = mountWithTabGroups(collector(), GROUPS());
    await screen.findByRole("combobox", { name: "Group" });
    await choose(user, "Group", "edge");

    // A tab's answer since: edge is gone (the collector's Default is still held).
    await setTabGroups([collectorGroup(), gatewaysGroup()]);
    expect(combobox("Group")).toHaveTextContent(GROUP_NOT_LISTED_WORDS);
    expect(GROUP_NOT_LISTED_WORDS).toBe("A group no longer listed");
    expect(screen.queryByText(/edge/)).toBeNull();
    // It can't be chosen again; the groups listed can.
    await user.click(combobox("Group"));
    expect(await screen.findByRole("option", { name: GROUP_NOT_LISTED_WORDS })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "gateways" }));
    expect(combobox("Group")).toHaveTextContent("gateways");
    expect(screen.queryByText(GROUP_NOT_LISTED_WORDS)).toBeNull();
  });
});

// StrictMode's first run reads, its cleanup aborts the read, and the second
// reads again; the first's failure must never show.
describe("EditCollectorDialog under StrictMode", () => {
  it('never flashes "The groups couldn\'t be read." for the first run\'s aborted read', async () => {
    const pendingGroups: Array<(groups: { groups: CollectorGroup[] }) => void> = [];
    const abortable = <Value,>(pending: Array<(value: Value) => void>, signal: AbortSignal | undefined) =>
      new Promise<Value>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(aborted()));
        pending.push(resolve);
      });
    spies.getCollectorGroups.mockImplementation((_organizationId, _fleetId, options = {}) => abortable(pendingGroups, options.signal));
    mountWithTabGroups(collector({ groupId: GATEWAYS_GROUP_ID }), null, { strict: true });
    await screen.findByRole("dialog", { name: "Edit collector" });

    // Each read twice: the first run's aborted, its failure settled.
    await waitFor(() => expect(spies.getCollectorGroups).toHaveBeenCalledTimes(2));
    expect(spies.getCollectorGroups.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    await act(async () => {});
    expect(screen.queryByText(GROUPS_UNREADABLE_WORDS)).toBeNull();
    expect(screen.getByText("Loading groups…")).toBeInTheDocument();

    // The second run's answers show.
    await act(async () => {
      pendingGroups.at(-1)!({ groups: api.groups });
    });
    expect(await screen.findByRole("combobox", { name: "Group" })).toHaveTextContent("gateways");
    expect(screen.queryByText(GROUPS_UNREADABLE_WORDS)).toBeNull();
  });
});

// The picker's state outlives the child the Pin choice unmounts.
describe("EditCollectorDialog's picker across Pin choices", () => {
  it("keeps the configuration chosen from a later page, and the pages read, when the Pin choice switches away and back", async () => {
    api.configurationsPage = 1;
    const { user } = await renderEdit(collector());
    await settled();
    await choose(user, "Pin", "A published version");
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
    await choose(user, "Configuration", "payments-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));

    await choose(user, "Pin", "Follow the group");
    expect(screen.queryByRole("combobox", { name: "Configuration" })).toBeNull();
    await choose(user, "Pin", "A published version");

    // Nothing read again: the pages and the choice are the dialog's.
    expect(spies.getConfigurations).toHaveBeenCalledTimes(2);
    expect(combobox("Configuration")).toHaveTextContent("payments-otel");
    expect(combobox("Version")).toHaveTextContent("@v2");
    await user.click(ok());
    await waitFor(() => expect(api.requests).toEqual([{ pin: { kind: "version", versionId: P2_ID } }]));
  });
});

/** Every attribute under the document holding `text`, but the elements allowed to (their `value` alone). */
function attributesHoldingBut(text: string, allowed: Element[]): string[] {
  const holders: string[] = [];
  for (const element of [document.documentElement, ...document.documentElement.querySelectorAll("*")]) {
    for (const attribute of element.attributes) {
      if (!attribute.value.includes(text)) continue;
      if (attribute.name === "value" && allowed.includes(element)) continue;
      holders.push(`${element.tagName} ${attribute.name}`);
    }
  }
  return holders;
}

describe("EditCollectorDialog's privacy", () => {
  it("holds no collector, group or configuration name in an attribute, every Select open, but the Name's value", async () => {
    const collectorName = "canary-collector-91c2";
    const groupName = "canary-group-5d7e";
    const configurationName = "canary-configuration-3b8f";
    const label = "canary-label-0a4c";
    const emptyGroupName = "canary-empty-group-6e1f";
    api.groups = [collectorGroup(), gatewaysGroup({ name: groupName }), collectorGroup({ id: EMPTY_GROUP_ID, name: emptyGroupName, isDefault: false })];
    api.configurations = [{ ...CHECKOUT, name: configurationName }, PAYMENTS];
    api.versions[CONFIGURATION_ID] = [configurationVersionListItem({ id: V5_ID, versionNumber: 5, label })];
    const row = pinnedToV4({
      name: collectorName,
      groupId: GATEWAYS_GROUP_ID,
      pin: {
        kind: "version",
        versionId: VERSION_ID,
        publishedVersionId: PUBLISHED_VERSION_ID,
        version: publishedVersion({ configurationName }),
      },
    });
    const { user } = await renderEdit(row, { groups: api.groups });
    await settled();
    const canaries = [collectorName, groupName, configurationName, label, emptyGroupName];
    // An open Select hides the rest of the dialog from the accessibility tree: the fields are found hidden too.
    const check = () => {
      const allowed = [screen.getByRole("textbox", { name: "Name", hidden: true })];
      for (const canary of canaries) expect(attributesHoldingBut(canary, allowed), canary).toEqual([]);
    };
    expect(screen.getByRole("dialog")).toHaveTextContent(groupName);
    check();

    for (const select of ["Group", "Pin", "Configuration", "Version"]) {
      await user.click(combobox(select));
      await screen.findAllByRole("option");
      check();
      await user.keyboard("{Escape}");
    }
    await choose(user, "Version", /@v5/);
    check();

    // The configuration named in the list, marked the group's (no search box to hold it).
    await user.click(combobox("Configuration"));
    expect(await screen.findByRole("option", { name: `${configurationName} (group default)` })).toBeInTheDocument();
    check();
    await user.keyboard("{Escape}");

    // Moved and renamed: the hint and the Name hold the names as text and value.
    await choose(user, "Group", "Default");
    await rename(user, `${collectorName}-2`);
    check();

    // The hints that name a group: as text only.
    await choose(user, "Pin", "Follow the group");
    await choose(user, "Group", groupName);
    expect(screen.getByText(hintGroupVersion(groupName))).toBeInTheDocument();
    check();
    await choose(user, "Group", emptyGroupName);
    expect(screen.getByText(hintGroupNothing(emptyGroupName))).toBeInTheDocument();
    check();

    // The collector's name: the Name's value alone.
    expect(attributesHoldingBut(collectorName, [])).toEqual(["INPUT value"]);
  });

});

describe("EditCollectorDialog's default ids", () => {
  it("opens with the collector's own group", async () => {
    await renderEdit(collector({ groupId: DEFAULT_GROUP_ID }));
    expect(combobox("Group")).toHaveTextContent("Default");
  });
});

// The Pin's Variable group choice.
describe("EditCollectorDialog's Variable group", () => {
  const EU_ID = "7b000000-0000-4000-8000-0000000000e1";
  const US_ID = "7b000000-0000-4000-8000-0000000000e2";
  const VARIABLE_GROUPS = () => [variableGroup({ id: EU_ID, name: "eu-edge" }), variableGroup({ id: US_ID, name: "us-edge" })];
  /** The fleet's groups, Default's variable group eu-edge. */
  const BOUND_GROUPS = (): CollectorGroup[] => [collectorGroup({ variableGroupId: EU_ID }), edgeGroup(), gatewaysGroup()];

  beforeEach(() => {
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue(VARIABLE_GROUPS());
  });

  it('offers "Follow group (eu-edge)", its group\'s variable group, first, then the organization\'s, chosen by default', async () => {
    const { user } = await renderEdit(collector(), { groups: BOUND_GROUPS() });
    const select = await screen.findByRole("combobox", { name: "Variable group" });
    expect(select).toHaveTextContent("Follow group (eu-edge)");
    await user.click(select);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Follow group (eu-edge)", "eu-edge", "us-edge"]);
    await user.keyboard("{Escape}");
    expect(ok()).toBeDisabled();
  });

  it('says "Follow group (Organization values)" for a group with none, and follows the Group chosen', async () => {
    const { user } = await renderEdit(collector(), { groups: BOUND_GROUPS() });
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("Follow group (eu-edge)");
    await choose(user, "Group", "edge");
    expect(combobox("Variable group")).toHaveTextContent("Follow group (Organization values)");
  });

  it("pins a variable group alone: one PATCH of pinnedVariableGroupId, no pin", async () => {
    const { user, onChanged } = await renderEdit(collector(), { groups: BOUND_GROUPS() });
    await screen.findByRole("combobox", { name: "Variable group" });
    await choose(user, "Variable group", "us-edge");
    expect(ok()).toBeEnabled();
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pinnedVariableGroupId: US_ID }]);
  });

  it("preselects the collector's pinned variable group; Follow group sends null", async () => {
    const { user, onChanged } = await renderEdit(collector({ pinnedVariableGroupId: US_ID }), { groups: BOUND_GROUPS() });
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("us-edge");
    expect(ok()).toBeDisabled();
    await choose(user, "Variable group", "Follow group (eu-edge)");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pinnedVariableGroupId: null }]);
  });

  it("sends only what changed: a pin alone carries no variable group, both changed carry both", async () => {
    const { user, onChanged } = await renderEdit(pinnedToV4({ pinnedVariableGroupId: EU_ID }), { groups: BOUND_GROUPS() });
    await settled();
    await screen.findByRole("combobox", { name: "Variable group" });
    await choose(user, "Pin", "Follow the group");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pin: null }]);

    await user.click(screen.getByRole("button", { name: "Reopen", hidden: true }));
    await screen.findByRole("dialog", { name: "Edit collector" });
    await screen.findByRole("combobox", { name: "Variable group" });
    await choose(user, "Pin", "Follow the group");
    await choose(user, "Variable group", "us-edge");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(api.requests[1]).toEqual({ pin: null, pinnedVariableGroupId: US_ID });
  });

  it("shows a 422 variables_undefined's words and its names, and a 404 variable_group_not_found's words", async () => {
    api.updates = [
      refusal("variables_undefined", "The published version references organization variables that aren't defined: define them first.", 422, {
        details: { names: ["OTLP_EP", "REGION"], totalNames: 2 },
      }),
      refusal("variable_group_not_found", "Variable group not found", 404),
    ];
    const { user } = await renderEdit(collector(), { groups: BOUND_GROUPS() });
    await screen.findByRole("combobox", { name: "Variable group" });
    await choose(user, "Variable group", "us-edge");
    await user.click(ok());
    expect(await screen.findByRole("alert")).toHaveTextContent("aren't defined: define them first.");
    expect(screen.getByText("OTLP_EP").closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByText("REGION")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).toBeNull();
    await user.click(ok());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Variable group not found"));
    expect(screen.queryByText("OTLP_EP")).toBeNull();
    // The variable group deleted meanwhile: the list read again.
    await waitFor(() => expect(apiClient.getVariableGroups).toHaveBeenCalledTimes(2));
  });

  // The baseline is the collector as the dialog opened.
  it("keeps the collector it opened with when the parent reloads: Follow group still sends the change from the snapshot", async () => {
    const opened = collector({ pinnedVariableGroupId: EU_ID });
    const onChanged = vi.fn();
    function Page() {
      const [row, setRow] = useState(opened);
      return (
        <>
          <button type="button" onClick={() => setRow(collector({ pinnedVariableGroupId: null, name: "renamed-elsewhere" }))}>
            Reload
          </button>
          <EditCollectorDialog
            open
            onOpenChange={vi.fn()}
            collector={row}
            organizationId={GROUP_ID}
            fleetId={FLEET_ID}
            groups={BOUND_GROUPS()}
            onChanged={onChanged}
          />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/", Component: Page, loader: () => null, HydrateFallback: () => null }]);
    render(<Stub initialEntries={["/"]} />);
    const user = userEvent.setup();
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("eu-edge");
    fireEvent.click(screen.getByRole("button", { name: "Reload", hidden: true }));
    expect(combobox("Variable group")).toHaveTextContent("eu-edge");
    expect(nameField()).toHaveValue("web-01");
    expect(ok()).toBeDisabled();
    await choose(user, "Variable group", "Follow group (eu-edge)");
    await user.click(ok());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.requests).toEqual([{ pinnedVariableGroupId: null }]);
  });

  it("holds no variable group's name in an attribute; its Select sits inside ph-no-capture", async () => {
    const name = "canary-pinned-vg-77b";
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: EU_ID, name })]);
    const { user } = await renderEdit(collector({ pinnedVariableGroupId: EU_ID }), { groups: BOUND_GROUPS() });
    const select = await screen.findByRole("combobox", { name: "Variable group" });
    expect(select).toHaveTextContent(name);
    expect(select).toHaveClass("ph-no-capture");
    await user.click(select);
    expect((await screen.findByRole("option", { name: `Follow group (${name})` })).closest(".ph-no-capture")).not.toBeNull();
    expectNoAttributeHolds(name);
    // Radix's hidden native <select> inside the form holds the names as its options' text: inside ph-no-capture too.
    const native = [...document.querySelectorAll("select option")].filter((each) => (each.textContent ?? "").includes(name));
    expect(native.length).toBeGreaterThan(0);
    for (const each of native) expect(each.closest(".ph-no-capture")).not.toBeNull();
  });
});

// The group dialogs' "Variables used", for the published version the Pin chooses: the names show before Save.
describe("EditCollectorDialog's Variables used", () => {
  /** Serves each version's text by id, and the organization's variables (the shared names). */
  function serveTexts(texts: Record<string, string>, defined: string[] = ["OTLP_EP"]) {
    vi.mocked(apiClient.getConfigurationVersion).mockImplementation(async (organizationId, configurationId, versionId) => {
      expect(organizationId).toBe(GROUP_ID);
      return answerFor({ ...THEIRS, id: configurationId }, versionFixture({ id: versionId, configurationId, yamlContent: texts[versionId] ?? "" }));
    });
    vi.mocked(apiClient.getOrganizationVariables).mockResolvedValue(
      defined.map((name, index) => organizationVariable({ id: `7a000000-0000-4000-8000-00000000000${index}`, name })),
    );
  }

  beforeEach(() => {
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  });

  afterEach(() => {
    useUserStore.getState().clear();
    forgetOrgVariableNames();
  });

  it("lists the pinned version's names no organization variable has, before Save, inside ph-no-capture; the pin as opened isn't refused", async () => {
    serveTexts({ [VERSION_ID]: "exporters:\n  otlp:\n    endpoint: ${org:OTLP_EP}\n    headers: { region: ${org:REGION} }\n" });
    await renderEdit(pinnedToV4());
    expect(await screen.findByText(VARIABLES_USED_LABEL)).toBeInTheDocument();
    const missing = await screen.findByText("REGION");
    expect(missing.closest(".ph-no-capture")).not.toBeNull();
    // The pin it opened with: the save doesn't send it again, so nothing says it would be refused.
    expect(screen.getByText(VARIABLES_UNDEFINED_ASSIGNED_HINT)).toBeInTheDocument();
    expect(screen.queryByText(VARIABLES_UNDEFINED_HINT)).toBeNull();
    expect(screen.queryByText("OTLP_EP")).toBeNull();
    expect(apiClient.getConfigurationVersion).toHaveBeenCalledWith(
      GROUP_ID,
      CONFIGURATION_ID,
      VERSION_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expectNoAttributeHolds("REGION");
  });

  it('says "Saving is refused…" for a version the save would pin, "all defined" for another, and nothing for Follow the group', async () => {
    serveTexts({ [P2_ID]: "a: ${org:SECOND_NAME}", [V5_ID]: "a: ${org:OTLP_EP}" });
    const { user } = await renderEdit(collector());
    await settled();
    expect(screen.queryByText(VARIABLES_USED_LABEL)).toBeNull();
    await choose(user, "Pin", "A published version");
    await choose(user, "Configuration", "payments-otel");
    expect(await screen.findByText("SECOND_NAME")).toBeInTheDocument();
    expect(screen.getByText(VARIABLES_UNDEFINED_HINT)).toBeInTheDocument();
    await choose(user, "Configuration", "checkout-otel");
    expect(await screen.findByText(allDefinedWords(1))).toBeInTheDocument();
    expect(screen.queryByText("SECOND_NAME")).toBeNull();
    await choose(user, "Pin", "Follow the group");
    expect(screen.queryByText(VARIABLES_USED_LABEL)).toBeNull();
  });

  it("lists nothing as undefined before the user store has the organization", async () => {
    useUserStore.getState().clear();
    serveTexts({ [VERSION_ID]: "a: ${org:REGION}" });
    await renderEdit(pinnedToV4());
    expect(await screen.findByText(VARIABLES_USED_LOADING)).toBeInTheDocument();
    expect(screen.queryByText("REGION")).toBeNull();
    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    expect(await screen.findByText("REGION")).toBeInTheDocument();
  });
});
