import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  type CollectorGroup,
  type Configuration,
  type ConfigurationsPage,
  type ConfigurationVersionListItem,
  type CreateCollectorGroupRequest,
  type UpdateCollectorGroupRequest,
} from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED, type ConfigurationsQuery } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS } from "~/lib/fleets.js";
import { answerFor, GROUP_ID, PERSONAL_ID, signedInMember, THEIRS, versionFixture } from "~/test/configurations.js";
import {
  collectorGroup,
  configurationVersionListItem,
  CONFIGURATION_ID,
  DATA_MOUNT,
  DEFAULT_GROUP_ID,
  FLEET_ID,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  mountsAnnotations,
  NGINX_MOUNT,
  expectNoAttributeHolds,
  publishedVersion,
  serveNoVariables,
} from "~/test/fleets.js";
import { forgetOrgVariableNames, seedOrgVariableNames } from "~/lib/org-variables.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { forgetVariableGroupNames } from "~/lib/variable-group-display.js";
import { organizationVariable, variableGroup } from "~/test/variables.js";
import {
  CREATE_DESCRIPTION,
  DEFAULT_DESCRIPTION,
  DEFAULT_NAME_HINT,
  EDIT_DESCRIPTION,
  GROUP_NOT_FOUND_MESSAGE,
  GroupDialog,
  HINT_NOTHING,
  HINT_VERSION,
  MOUNTS_CHANGED_MESSAGE,
  MOUNTS_DISCLOSURE,
  requestOf,
  SAVE_GROUP_FAILED_MESSAGE,
} from "./GroupDialog.js";
import { VARIABLES_UNDEFINED_ASSIGNED_HINT, VARIABLES_UNDEFINED_HINT, VARIABLES_USED_NONE, allDefinedWords } from "./VariableGroupChoice.js";
import { MOUNTS_HINT, MOUNTS_UNREADABLE } from "./MountsEditor.js";

/*
 * The group dialog: create with a configuration picked (its newest
 * version), a name its rules refuse blocked with the message shown, Create
 * disabled until a name and a version (a new group requires one), and
 * edit's prefill with the update's request. The mounts (the disclosure
 * closed for a group with no mounts and open for one with mounts, a mount
 * saved onto the group, the editor seeded from the group's mounts) are in
 * "GroupDialog's mounts" below, with the editor's own cases in
 * `MountsEditor.test.tsx`.
 */

const refusal = (code: string, message: string, status: number, options: { details?: unknown } = {}) =>
  new ApiError(code, message, { status, ...options });
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, 503);
const NAME_TAKEN_WORDS = "Another of the fleet's collector groups has this name.";
const NAME_TAKEN = () => refusal("collector_group_name_taken", NAME_TAKEN_WORDS, 409);

const PAYMENTS_ID = "c0ffee00-0000-4000-8000-000000000001";
const V5_ID = "c0ffee00-0000-4000-8000-000000000005";
const P2_ID = "c0ffee00-0000-4000-8000-000000000102";
const P1_ID = "c0ffee00-0000-4000-8000-000000000101";
const EDGE_ID = "c0ffee00-0000-4000-8000-0000000000e0";

const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };
const PAYMENTS: Configuration = { ...THEIRS, id: PAYMENTS_ID, name: "payments-otel" };

/** "edge", a group with nothing assigned. */
const edgeGroup = (overrides: Partial<CollectorGroup> = {}) => collectorGroup({ id: EDGE_ID, name: "edge", isDefault: false, ...overrides });
/** "gateways" assigned a version of a configuration since deleted. */
const orphanGroup = () => gatewaysGroup({ assignedVersion: null });

type Answer = "saved" | "hang" | Error;

/** What the fake API holds, and every request it was sent. */
interface Api {
  configurations: Configuration[];
  versions: Record<string, ConfigurationVersionListItem[]>;
  /** Holds a configuration's versions read until released. */
  versionsHolds: Map<string, Promise<void>>;
  answers: Answer[];
  creates: CreateCollectorGroupRequest[];
  updates: Array<{ groupId: string; request: UpdateCollectorGroupRequest }>;
  signals: Array<AbortSignal | undefined>;
  /** The fleet's groups a mounts save reads again; null: the group as the dialog opened with it. */
  freshGroups: CollectorGroup[] | Error | null;
}

/** The group the dialog was opened with (renderDialog's). */
let openedGroup: CollectorGroup | null = null;

let api: Api;

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
  const getConfigurations = vi
    .spyOn(apiClient, "getConfigurations")
    .mockImplementation(async (organizationId, query: ConfigurationsQuery = {}): Promise<ConfigurationsPage> => {
      expect(organizationId).toBe(GROUP_ID);
      // No search: a read never sends q.
      expect(query).toEqual({ filter: "published", limit: 100 });
      return { items: api.configurations, nextCursor: null };
    });
  const getConfigurationVersions = vi
    .spyOn(apiClient, "getConfigurationVersions")
    .mockImplementation(async (organizationId, configurationId) => {
      expect(organizationId).toBe(GROUP_ID);
      const hold = api.versionsHolds.get(configurationId);
      if (hold !== undefined) await hold;
      return { versions: api.versions[configurationId] ?? [] };
    });
  const createCollectorGroup = vi.spyOn(apiClient, "createCollectorGroup").mockImplementation((organizationId, fleetId, request, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    api.creates.push(request);
    api.signals.push(options.signal);
    return answer(options.signal);
  });
  const updateCollectorGroup = vi
    .spyOn(apiClient, "updateCollectorGroup")
    .mockImplementation((organizationId, fleetId, groupId, request, options = {}) => {
      expect(organizationId).toBe(GROUP_ID);
      expect(fleetId).toBe(FLEET_ID);
      api.updates.push({ groupId, request });
      api.signals.push(options.signal);
      return answer(options.signal);
    });
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async (organizationId, fleetId, options = {}) => {
    expect(organizationId).toBe(GROUP_ID);
    expect(fleetId).toBe(FLEET_ID);
    api.signals.push(options.signal);
    if (api.freshGroups instanceof Error) throw api.freshGroups;
    return { groups: api.freshGroups ?? (openedGroup === null ? [] : [openedGroup]) };
  });
  return { getConfigurations, getConfigurationVersions, createCollectorGroup, updateCollectorGroup, getCollectorGroups };
}

let spies: ReturnType<typeof serve>;

/** The dialog open for `group` (null: create) in GROUP_ID, on a page that can reopen it and switch organization; a loader counts revalidations. */
async function renderDialog(group: CollectorGroup | null = null) {
  openedGroup = group;
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
        <GroupDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          group={group}
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
  // The opening's read: the published configurations.
  await waitFor(() => expect(spies.getConfigurations).toHaveBeenCalled());
  return { user, onOpenChange, onChanged, loader };
}

type User = ReturnType<typeof userEvent.setup>;

const nameField = () => screen.getByRole("textbox", { name: "Name" });
const submit = () => screen.getByRole("button", { name: /^(Create|Assign|Save|Saving…)$/ });
const combobox = (name: string) => screen.getByRole("combobox", { name });

/** Opens the Select labelled `label` and picks `option`. */
async function choose(user: User, label: string, option: string | RegExp) {
  await user.click(combobox(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function rename(user: User, to: string) {
  await user.clear(nameField());
  await user.type(nameField(), to);
}

/** Picks a configuration; its newest version is chosen once read. */
async function pickConfiguration(user: User, name: string, newest: RegExp) {
  await choose(user, "Configuration", name);
  await waitFor(() => expect(combobox("Version")).toHaveTextContent(newest));
}

beforeEach(() => {
  vi.restoreAllMocks();
  api = {
    configurations: [CHECKOUT, PAYMENTS],
    versions: {
      [CONFIGURATION_ID]: [configurationVersionListItem({ id: V5_ID, versionNumber: 5, label: "add redis cache" }), configurationVersionListItem()],
      [PAYMENTS_ID]: [configurationVersionListItem({ id: P2_ID, versionNumber: 2 }), configurationVersionListItem({ id: P1_ID, versionNumber: 1 })],
    },
    versionsHolds: new Map(),
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

describe("GroupDialog: create and edit", () => {
  it("create: fills the name, picks a configuration (its newest version) and creates the group", async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = await renderDialog();

    await user.type(nameField(), "prod-server");
    await pickConfiguration(user, "payments-otel", /@v2/);
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([{ name: "prod-server", assignedVersionId: P2_ID }]);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Group created");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("create: blocks a name the platform's rule refuses, its message shown under the Name, nothing sent", async () => {
    const { user } = await renderDialog();
    fireEvent.change(nameField(), { target: { value: "prod\u0085" } });
    await pickConfiguration(user, "payments-otel", /@v2/);
    await user.click(submit());

    expect(await screen.findByText("Must not start or end with a space, or hold a control character.")).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(spies.createCollectorGroup).not.toHaveBeenCalled();
  });

  it("create: allows letters, digits, spaces, hyphens, underscores and dots, and more (1 to 80 characters)", async () => {
    const { user, onChanged } = await renderDialog();
    await user.type(nameField(), "prod-gateway_1.eu ünïcode: x");
    await pickConfiguration(user, "checkout-otel", /@v5/);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([{ name: "prod-gateway_1.eu ünïcode: x", assignedVersionId: V5_ID }]);
  });

  // A new group requires a published version.
  it("create: keeps Create disabled until a name and a complete version", async () => {
    let release!: () => void;
    api.versionsHolds.set(PAYMENTS_ID, new Promise((resolve) => (release = resolve)));
    const { user } = await renderDialog();
    expect(submit()).toHaveTextContent("Create");
    expect(submit()).toBeDisabled();
    await user.type(nameField(), "db-hosts");
    // A name, no version picked.
    expect(combobox("Configuration")).toHaveTextContent("Pick a configuration");
    expect(submit()).toBeDisabled();
    // A configuration chosen, its versions not yet read.
    await choose(user, "Configuration", "payments-otel");
    expect(submit()).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    expect(submit()).toBeEnabled();
    // A name of spaces is no name.
    await rename(user, "   ");
    expect(submit()).toBeDisabled();
    // Nor is none, a version picked.
    await user.clear(nameField());
    expect(submit()).toBeDisabled();
    expect(spies.createCollectorGroup).not.toHaveBeenCalled();
  });

  it("edit: prefills from the group and updates with only what changed", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup());
    expect(nameField()).toHaveValue("gateways");
    expect(nameField()).toBeEnabled();
    expect(combobox("Published version")).toHaveTextContent("A published version");
    expect(combobox("Configuration")).toHaveTextContent("checkout-otel");
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    expect(submit()).toHaveTextContent("Save");
    expect(submit()).toBeDisabled();

    await pickConfiguration(user, "payments-otel", /@v2/);
    await user.click(submit());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { assignedVersionId: P2_ID } }]);
    expect(spies.createCollectorGroup).not.toHaveBeenCalled();
  });
});

describe("GroupDialog's titles and words", () => {
  it.each([
    ["create", null, "New group", CREATE_DESCRIPTION, "Create"],
    ["an assigned group's edit", gatewaysGroup(), "Edit gateways", EDIT_DESCRIPTION, "Save"],
    ["an unassigned group's assign", edgeGroup(), "Assign a published version to edge", EDIT_DESCRIPTION, "Assign"],
    ["an orphan assignment's edit", orphanGroup(), "Edit gateways", EDIT_DESCRIPTION, "Save"],
    ["the Default group's assign", collectorGroup(), "Assign a published version to Default", DEFAULT_DESCRIPTION, "Assign"],
    [
      "the Default group's edit",
      collectorGroup({ assignedPublishedVersionId: "c0ffee00-0000-4000-8000-0000000000a1", assignedVersion: publishedVersion() }),
      "Edit Default",
      DEFAULT_DESCRIPTION,
      "Save",
    ],
  ])("%s: its title, description and submit", async (_which, group, title, description, submitWords) => {
    await renderDialog(group);
    const dialog = screen.getByRole("dialog", { name: title });
    expect(within(dialog).getByText(description)).toBeInTheDocument();
    expect(submit()).toHaveTextContent(submitWords);
    expect(dialog).not.toHaveTextContent(/deploy group|by name at install time|can't be renamed later/i);
    expect(nameField()).toHaveAttribute("placeholder", "e.g. web-hosts");
    expect(nameField()).toHaveAttribute("maxLength", "80");
  });

  it("says the descriptions' words exactly", () => {
    expect(CREATE_DESCRIPTION).toBe(
      "A group gives its collectors one published version. Collectors that aren't pinned are sent it on their next poll.",
    );
    expect(EDIT_DESCRIPTION).toBe(
      "Rename the group, change its published version, its variable group or its mounts. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.",
    );
    expect(DEFAULT_DESCRIPTION).toBe(
      "Change the group's published version, its variable group or its mounts. The group's collectors that aren't pinned follow a new version on their next poll; pinned ones keep their pin.",
    );
  });

  it("an assigned group's Edit offers A published version and Nothing assigned, and the deleted configuration's version only for such an assignment", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await user.click(combobox("Published version"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["A published version", "Nothing assigned"]);
  });
});

describe("GroupDialog's Name", () => {
  it('sends the Name trimmed, toasts "Group updated", closes and reloads', async () => {
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "  databases  ");
    await user.click(submit());

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { name: "databases" } }]);
    expect(toastSuccess).toHaveBeenCalledWith("Group updated");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("counts a whitespace-only change of the Name as none", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await rename(user, " gateways  ");
    expect(submit()).toBeDisabled();
  });

  it.each([
    ["too long", "x".repeat(81), "Must be 1 to 80 characters."],
    ["a control character", "db\u0007hosts", "Must not start or end with a space, or hold a control character."],
  ])("shows the contract's message for a Name %s under the field, nothing sent", async (_why, value, words) => {
    const { user } = await renderDialog(gatewaysGroup());
    fireEvent.change(nameField(), { target: { value } });
    await user.click(submit());
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(nameField()).toHaveAccessibleDescription(words);
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
  });

  it("shows a taken name under the Name, and clears it on typing", async () => {
    api.answers = [NAME_TAKEN()];
    const { user, onOpenChange } = await renderDialog();
    await user.type(nameField(), "gateways");
    await pickConfiguration(user, "payments-otel", /@v2/);
    await user.click(submit());
    expect(await screen.findByText(NAME_TAKEN_WORDS)).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText(SAVE_GROUP_FAILED_MESSAGE)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.type(nameField(), "x");
    expect(screen.queryByText(NAME_TAKEN_WORDS)).toBeNull();
  });

  it("shows a 400's name problem under the Name, never the API's invalid_request words", async () => {
    api.answers = [
      refusal("invalid_request", "The request was not valid.", 400, {
        details: [{ instancePath: "/name", message: "Must be 1 to 80 characters.", params: { issue: { path: ["name"] } } }],
      }),
    ];
    const { user } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await user.click(submit());
    expect(await screen.findByText("Must be 1 to 80 characters.")).toBeInTheDocument();
    expect(screen.queryByText("The request was not valid.")).toBeNull();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the Default group's Name read-only, says why, and never sends it", async () => {
    const { user, onChanged } = await renderDialog(collectorGroup());
    expect(nameField()).toHaveValue("Default");
    expect(nameField()).toHaveAttribute("readonly");
    expect(screen.getByText(DEFAULT_NAME_HINT)).toBeInTheDocument();
    expect(DEFAULT_NAME_HINT).toBe("The Default group can't be renamed.");
    await user.type(nameField(), "-renamed");
    expect(nameField()).toHaveValue("Default");
    expect(submit()).toBeDisabled();

    await pickConfiguration(user, "checkout-otel", /@v5/);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: DEFAULT_GROUP_ID, request: { assignedVersionId: V5_ID } }]);
  });
});

describe("GroupDialog's published version", () => {
  it("renames and assigns in one PATCH", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await choose(user, "Version", /@v5/);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { name: "databases", assignedVersionId: V5_ID } }]);
  });

  it("clears the assignment with null", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup());
    await choose(user, "Published version", "Nothing assigned");
    expect(screen.queryByRole("combobox", { name: "Configuration" })).toBeNull();
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { assignedVersionId: null } }]);
  });

  it("sends nothing for choosing the current assignment again", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await choose(user, "Version", /@v5/);
    expect(submit()).toBeEnabled();
    await choose(user, "Version", /@v4/);
    expect(submit()).toBeDisabled();
  });

  it("keeps an orphan assignment (a deleted configuration's version) unless changed: never sent back; a rename alone is", async () => {
    const { user, onChanged } = await renderDialog(orphanGroup());
    expect(combobox("Published version")).toHaveTextContent("A deleted configuration's version");
    expect(screen.queryByRole("combobox", { name: "Configuration" })).toBeNull();
    expect(submit()).toBeDisabled();
    await user.click(combobox("Published version"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "A published version",
      "Nothing assigned",
      "A deleted configuration's version",
    ]);
    await user.keyboard("{Escape}");
    await rename(user, "gateways-2");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { name: "gateways-2" } }]);
  });

  it("sends an orphan assignment's change: cleared with null", async () => {
    const { user, onChanged } = await renderDialog(orphanGroup());
    await choose(user, "Published version", "Nothing assigned");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { assignedVersionId: null } }]);
  });

  it("opens an unassigned group's Assign with nothing picked: no change, so a rename alone saves", async () => {
    const { user, onChanged } = await renderDialog(edgeGroup());
    expect(combobox("Configuration")).toHaveTextContent("Pick a configuration");
    expect(submit()).toBeDisabled();
    await rename(user, "edge-2");
    expect(submit()).toBeEnabled();
    // A configuration chosen without its version yet: incomplete.
    let release!: () => void;
    api.versionsHolds.set(PAYMENTS_ID, new Promise((resolve) => (release = resolve)));
    await choose(user, "Configuration", "payments-otel");
    expect(submit()).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: EDGE_ID, request: { name: "edge-2", assignedVersionId: P2_ID } }]);
  });

  // A new group requires a published version.
  it("create: offers no Nothing assigned, nor any choice: the picker alone, a group named Published version", async () => {
    const { user } = await renderDialog();
    expect(screen.queryByRole("combobox", { name: "Published version" })).toBeNull();
    const picker = screen.getByRole("group", { name: "Published version" });
    expect(within(picker).getByRole("combobox", { name: "Configuration" })).toHaveTextContent("Pick a configuration");
    expect(within(picker).getByRole("combobox", { name: "Version" })).toBeDisabled();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/Nothing assigned|A published version|A deleted configuration's version/);
    // The Configuration select offers configurations alone.
    await user.click(combobox("Configuration"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["checkout-otel", "payments-otel"]);
  });

  // Nothing assigned only releases an assigned group; an unassigned group's Assign shows the picker alone, as New
  // group does.
  it.each([
    ["an unassigned group's", edgeGroup(), EDGE_ID],
    ["the unassigned Default group's", collectorGroup(), DEFAULT_GROUP_ID],
  ])("%s Assign: the picker alone, no choice, no Nothing assigned, no visible heading; Assign once a version is picked", async (_which, group, groupId) => {
    const { user, onChanged } = await renderDialog(group);
    expect(screen.queryByRole("combobox", { name: "Published version" })).toBeNull();
    expect(screen.queryByText("Published version")).toBeNull();
    const picker = screen.getByRole("group", { name: "Published version" });
    expect(picker).toHaveAttribute("aria-label", "Published version");
    expect(within(picker).getByRole("combobox", { name: "Configuration" })).toHaveTextContent("Pick a configuration");
    expect(within(picker).getByRole("combobox", { name: "Version" })).toBeDisabled();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/Nothing assigned|A published version|A deleted configuration's version/);
    expect(screen.queryByText(HINT_NOTHING)).toBeNull();
    expect(submit()).toHaveTextContent("Assign");
    expect(submit()).toBeDisabled();
    await pickConfiguration(user, "checkout-otel", /@v5/);
    expect(submit()).toBeEnabled();
    expect(picker).toHaveAccessibleDescription(HINT_VERSION);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId, request: { assignedVersionId: V5_ID } }]);
  });

  // New group shows no "Published version" heading, its picker's group keeps the name by a fixed aria-label; Edit
  // keeps its visible label.
  it("create: shows no Published version heading, the picker's group named by fixed words", async () => {
    await renderDialog();
    expect(screen.queryByText("Published version")).toBeNull();
    const picker = screen.getByRole("group", { name: "Published version" });
    expect(picker).toHaveAttribute("aria-label", "Published version");
    expect(picker).not.toHaveAttribute("aria-labelledby");
  });

  it("edit: keeps its visible Published version label, naming the select", async () => {
    await renderDialog(gatewaysGroup());
    expect(screen.getByText("Published version")).toBeVisible();
    expect(combobox("Published version")).toBeInTheDocument();
  });

  // No search box in the picker, New group or Edit group.
  it.each([
    ["New group", null],
    ["Edit group", gatewaysGroup()],
  ])("%s: offers no configuration search box, the Name its one text field", async (_dialog, group) => {
    await renderDialog(group);
    await screen.findByRole("combobox", { name: "Configuration" });
    expect(screen.queryByRole("searchbox", { hidden: true })).toBeNull();
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    expect(screen.getAllByRole("textbox")).toEqual([nameField()]);
  });

  it("create: sends the name trimmed with the version picked, always", async () => {
    const { user, onChanged } = await renderDialog();
    await user.type(nameField(), "  db-hosts ");
    await pickConfiguration(user, "payments-otel", /@v2/);
    await choose(user, "Version", /@v1/);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([{ name: "db-hosts", assignedVersionId: P1_ID }]);
  });

  it('offers the current assignment\'s configuration though no page holds it, with no "(group default)" marker', async () => {
    api.configurations = [PAYMENTS];
    const { user } = await renderDialog(gatewaysGroup());
    await user.click(combobox("Configuration"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["checkout-otel", "payments-otel"]);
    await user.keyboard("{Escape}");
    await user.click(combobox("Version"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).not.toContainEqual(expect.stringMatching(/group default/));
    expect(document.body).not.toHaveTextContent(/group default/);
  });
});

describe("GroupDialog's hint", () => {
  it("says a version picked is sent to the unpinned collectors; none without a version", async () => {
    expect(HINT_VERSION).toBe("The group's collectors that aren't pinned are sent this version on their next poll; pinned ones keep their pin.");
    const { user } = await renderDialog(edgeGroup());
    expect(screen.queryByText(HINT_VERSION)).toBeNull();
    await pickConfiguration(user, "checkout-otel", /@v5/);
    expect(screen.getByText(HINT_VERSION)).toBeInTheDocument();
  });

  // Nothing assigned, offered only to an assigned group, releases its version.
  it("says Nothing assigned releases the published version, in an assigned group's Edit", async () => {
    expect(HINT_NOTHING).toBe(
      "Releases the published version (e.g. to delete its configuration). Collectors keep running what they have; new installs need a published version.",
    );
    const { user } = await renderDialog(gatewaysGroup());
    expect(screen.queryByText(HINT_NOTHING)).toBeNull();
    await choose(user, "Version", /@v5/);
    expect(screen.getByText(HINT_VERSION)).toBeInTheDocument();
    await choose(user, "Published version", "Nothing assigned");
    expect(screen.getByText(HINT_NOTHING)).toBeInTheDocument();
    expect(combobox("Published version")).toHaveAccessibleDescription(HINT_NOTHING);
    expect(screen.queryByText(HINT_VERSION)).toBeNull();
  });

  // No hint for the assignment a group opens with; the hint describes the Published version select.
  it("says nothing for the version an assigned group opens with, until another is picked; the select is described by the hint", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    expect(screen.queryByText(HINT_VERSION)).toBeNull();
    expect(combobox("Published version")).not.toHaveAttribute("aria-describedby");
    await choose(user, "Version", /@v5/);
    expect(screen.getByText(HINT_VERSION)).toBeInTheDocument();
    expect(combobox("Published version")).toHaveAccessibleDescription(HINT_VERSION);
    await choose(user, "Version", /@v4/);
    expect(screen.queryByText(HINT_VERSION)).toBeNull();
    expect(combobox("Published version")).not.toHaveAttribute("aria-describedby");
    await choose(user, "Published version", "Nothing assigned");
    expect(combobox("Published version")).toHaveAccessibleDescription(HINT_NOTHING);
  });

  it("create: says nothing until a version is picked, then the version's hint, which describes the picker's group", async () => {
    const { user } = await renderDialog();
    const picker = screen.getByRole("group", { name: "Published version" });
    expect(screen.queryByText(HINT_VERSION)).toBeNull();
    expect(screen.queryByText(HINT_NOTHING)).toBeNull();
    expect(picker).not.toHaveAttribute("aria-describedby");
    await pickConfiguration(user, "checkout-otel", /@v5/);
    expect(screen.getByText(HINT_VERSION)).toBeInTheDocument();
    expect(picker).toHaveAccessibleDescription(HINT_VERSION);
  });

  it("says nothing for an orphan assignment kept", async () => {
    await renderDialog(orphanGroup());
    expect(screen.queryByText(HINT_VERSION)).toBeNull();
    expect(screen.queryByText(HINT_NOTHING)).toBeNull();
  });
});

describe("GroupDialog's refusals", () => {
  it.each([
    ["configuration_version_not_published", "This version isn't published: publish it before assigning or pinning it.", 422],
    ["configuration_version_not_found", "Version not found", 404],
    ["collector_group_is_default", "The Default group can't be renamed or deleted.", 409],
    ["rate_limited", "Too many attempts. Please wait and try again.", 429],
  ])("shows %s's words in the dialog, which stays open", async (code, words, status) => {
    api.answers = [refusal(code, words, status)];
    const { user, onOpenChange, onChanged } = await renderDialog(gatewaysGroup());
    await choose(user, "Version", /@v5/);
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled();
  });

  it('shows the fallback "Failed to save group" for a refusal it doesn\'t know', async () => {
    api.answers = [refusal("invalid_request", "The request was not valid.", 400)];
    const { user } = await renderDialog(gatewaysGroup());
    await choose(user, "Version", /@v5/);
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent(SAVE_GROUP_FAILED_MESSAGE);
    expect(SAVE_GROUP_FAILED_MESSAGE).toBe("Failed to save group");
  });

  it('on a 404 collector_group_not_found, toasts "Group not found", closes and reloads', async () => {
    api.answers = [refusal("collector_group_not_found", "Collector group not found.", 404)];
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith(GROUP_NOT_FOUND_MESSAGE);
    expect(GROUP_NOT_FOUND_MESSAGE).toBe("Group not found");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("on a 404 fleet_not_found, toasts the API's words, closes and reloads (the page then shows Fleet not found)", async () => {
    api.answers = [refusal("fleet_not_found", "Fleet not found.", 404)];
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Fleet not found.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    ["a 404 organization_not_found", () => refusal("organization_not_found", "Organization not found", 404)],
    ["a 403 terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", 403)],
  ])("on %s, closes and revalidates the layout, with no message", async (_why, failure) => {
    api.answers = [failure()];
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange, onChanged, loader } = await renderDialog(gatewaysGroup());
    const loads = loader.mock.calls.length;
    await rename(user, "databases");
    await user.click(submit());
    await waitFor(() => expect(loader.mock.calls.length).toBe(loads + 1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says nothing when the session has ended", async () => {
    api.answers = [refusal("unauthenticated", "You need to sign in.", 401)];
    const toastError = vi.spyOn(toast, "error");
    const { user, onOpenChange } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await user.click(submit());
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("GroupDialog's unknown outcome", () => {
  it.each([
    ["a 503 fleets_unavailable", UNAVAILABLE],
    ["a 500", () => refusal("internal_error", "Something went wrong.", 500)],
    ["no connection", () => new ApiError("network_error", "Could not reach the server.")],
  ])("after %s, an edit shows the 503's words, stays open, and a retry sends the same request", async (_why, failure) => {
    api.answers = [failure()];
    const { user, onOpenChange, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await choose(user, "Version", /@v5/);
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates.map((each) => each.request)).toEqual([
      { name: "databases", assignedVersionId: V5_ID },
      { name: "databases", assignedVersionId: V5_ID },
    ]);
  });

  it("after a create's unknown outcome, says to reload before trying again; a retry answering a taken name shows it under the Name", async () => {
    api.answers = [UNAVAILABLE(), NAME_TAKEN()];
    const { user, onOpenChange } = await renderDialog();
    await user.type(nameField(), "db-hosts");
    await pickConfiguration(user, "payments-otel", /@v2/);
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("reload before trying again");
    await user.click(submit());
    expect(await screen.findByText(NAME_TAKEN_WORDS)).toBeInTheDocument();
    expect(api.creates).toEqual([
      { name: "db-hosts", assignedVersionId: P2_ID },
      { name: "db-hosts", assignedVersionId: P2_ID },
    ]);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it.each([
    ["Cancel", async (user: User) => user.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Escape", async (user: User) => user.keyboard("{Escape}")],
    ["the X", async (user: User) => user.click(screen.getByRole("button", { name: "Close" }))],
  ])("closed by %s after an unknown outcome, reloads once", async (_how, closeIt) => {
    api.answers = [UNAVAILABLE()];
    const { user, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await user.click(submit());
    await screen.findByRole("alert");
    expect(onChanged).not.toHaveBeenCalled();
    await closeIt(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("closed after a refusal that leaves nothing unknown, doesn't reload", async () => {
    api.answers = [NAME_TAKEN()];
    const { user, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "edge");
    await user.click(submit());
    await screen.findByText(NAME_TAKEN_WORDS);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("ends a save that never answers at 30 s, with the 503's words (it may or may not have been made)", async () => {
    api.answers = ["hang"];
    const { user, onOpenChange, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");

    vi.useFakeTimers();
    fireEvent.click(submit());
    await act(() => vi.advanceTimersByTimeAsync(FLEET_WRITE_TIMEOUT_MS - 1));
    expect(api.signals[0]!.aborted).toBe(false);
    expect(submit()).toHaveTextContent("Saving…");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(api.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();

    expect(await screen.findByRole("alert")).toHaveTextContent(FLEETS_UNAVAILABLE_MESSAGE);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled();
  });
});

describe("GroupDialog while saving", () => {
  it("can't be closed: Cancel disabled, no X, Escape and an outside click do nothing, every field disabled", async () => {
    api.answers = ["hang"];
    const { user, onOpenChange } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await user.click(submit());

    expect(submit()).toHaveTextContent("Saving…");
    expect(submit()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(nameField()).toBeDisabled();
    expect(combobox("Published version")).toBeDisabled();
    expect(combobox("Configuration")).toBeDisabled();
    expect(combobox("Version")).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit gateways" })).toBeInTheDocument();
  });

  it("sends once on a double Enter", async () => {
    api.answers = ["hang"];
    await renderDialog(gatewaysGroup());
    fireEvent.change(nameField(), { target: { value: "databases" } });
    fireEvent.submit(nameField().closest("form")!);
    fireEvent.submit(nameField().closest("form")!);
    expect(spies.updateCollectorGroup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the save", (settle: { resolve: (value: CollectorGroup) => void; reject: (failure: unknown) => void }) => settle.resolve(gatewaysGroup())],
    [
      "a 404",
      (settle: { resolve: (value: CollectorGroup) => void; reject: (failure: unknown) => void }) =>
        settle.reject(refusal("collector_group_not_found", "Collector group not found.", 404)),
    ],
    ["a 503", (settle: { resolve: (value: CollectorGroup) => void; reject: (failure: unknown) => void }) => settle.reject(UNAVAILABLE())],
  ])("drops %s answered after the organization changed: no toast, no message, no reload", async (_why, answerWith) => {
    let settle!: { resolve: (value: CollectorGroup) => void; reject: (failure: unknown) => void };
    spies.updateCollectorGroup.mockImplementation(() => new Promise((resolve, reject) => (settle = { resolve, reject })));
    const toastError = vi.spyOn(toast, "error");
    const toastSuccess = vi.spyOn(toast, "success");
    const { user, onOpenChange, onChanged } = await renderDialog(gatewaysGroup());
    await rename(user, "databases");
    await user.click(submit());
    fireEvent.click(screen.getByRole("button", { name: "Switch", hidden: true }));

    await act(async () => answerWith(settle));

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens afresh: the fields hold the group again, with no earlier refusal", async () => {
    api.answers = [NAME_TAKEN()];
    const { user } = await renderDialog(gatewaysGroup());
    await rename(user, "edge");
    await choose(user, "Published version", "Nothing assigned");
    await user.click(submit());
    await screen.findByText(NAME_TAKEN_WORDS);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("gateways");
    expect(combobox("Published version")).toHaveTextContent("A published version");
    expect(screen.queryByText(NAME_TAKEN_WORDS)).toBeNull();
  });
});

/** Each attribute holding `text`, but the `value` of the elements allowed (the Name: the picker has no search box). */
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

describe("GroupDialog's privacy", () => {
  it("holds no group or configuration name or version label in an attribute, every Select open, but the Name's value", async () => {
    const groupName = "canary-group-5d7e";
    const configurationName = "canary-configuration-3b8f";
    const otherName = "canary-other-configuration-77a1";
    const label = "canary-label-0a4c";
    const assignedLabel = "canary-assigned-label-1f9d";
    api.configurations = [{ ...CHECKOUT, name: configurationName }, { ...PAYMENTS, name: otherName }];
    api.versions[CONFIGURATION_ID] = [configurationVersionListItem({ id: V5_ID, versionNumber: 5, label }), configurationVersionListItem({ label: assignedLabel })];
    const group = gatewaysGroup({ name: groupName, assignedVersion: publishedVersion({ configurationName, versionLabel: assignedLabel }) });
    const { user } = await renderDialog(group);
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v4"));
    const canaries = [groupName, configurationName, otherName, label, assignedLabel];
    // An open Select hides the rest of the dialog from the accessibility tree: the fields are found hidden too.
    const check = () => {
      const allowed = [screen.getByRole("textbox", { name: "Name", hidden: true })];
      for (const canary of canaries) expect(attributesHoldingBut(canary, allowed), canary).toEqual([]);
    };
    expect(screen.getByRole("dialog")).toHaveTextContent(groupName);
    check();

    for (const select of ["Published version", "Configuration", "Version"]) {
      await user.click(combobox(select));
      await screen.findAllByRole("option");
      check();
      await user.keyboard("{Escape}");
    }
    await choose(user, "Version", /@v5/);
    check();
    // The Selects' item values are ids or the fixed choices, never a name (a native select inside the form).
    const values = [...document.querySelectorAll("option")].map((option) => option.value).filter((value) => value !== "");
    for (const value of values) expect(value).toMatch(/^(version|nothing|orphan|none|[0-9a-f-]{36})$/);

    // Another configuration chosen from the list (no search box to hold its name).
    expect(screen.queryByRole("searchbox", { hidden: true })).toBeNull();
    await user.click(combobox("Configuration"));
    await user.click(await screen.findByRole("option", { name: otherName }));
    await waitFor(() => expect(combobox("Version")).toHaveTextContent("@v2"));
    check();

    // Renamed: the Name holds the new name as its value alone.
    await rename(user, `${groupName}-2`);
    check();
    expect(attributesHoldingBut(groupName, [])).toEqual(["INPUT value"]);
  });
});

describe("GroupDialog's mounts", () => {
  const disclosure = () => screen.getByRole("button", { name: MOUNTS_DISCLOSURE });
  const panelOf = () => document.getElementById(disclosure().getAttribute("aria-controls")!)!;
  const hostPaths = () => screen.queryAllByRole("textbox", { name: "Host path" });
  const containerPaths = () => screen.queryAllByRole("textbox", { name: "Container path" });
  const addMount = () => screen.getByRole("button", { name: "Add mount" });
  /** Adds a mount with these paths (the disclosure opened first if it is closed). */
  async function addMountOf(user: User, hostPath: string, containerPath: string) {
    if (disclosure().getAttribute("aria-expanded") === "false") await user.click(disclosure());
    await user.click(addMount());
    await user.type(hostPaths().at(-1)!, hostPath);
    await user.type(containerPaths().at(-1)!, containerPath);
  }

  it.each([
    ["New group", null],
    ["an edit", gatewaysGroup()],
    ["the Default group's", collectorGroup()],
  ])("%s: the disclosure is closed for a group with no mounts, a plain button controlling a hidden panel", async (_which, group) => {
    await renderDialog(group);
    expect(MOUNTS_DISCLOSURE).toBe("Mounts (for the container install)");
    expect(disclosure()).toHaveAttribute("type", "button");
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(panelOf()).not.toBeVisible();
    // Until it is used, no mount editing affordance is reachable.
    expect(screen.queryByRole("button", { name: "Add mount" })).toBeNull();
    expect(screen.getAllByRole("textbox")).toEqual([nameField()]);
  });

  it("reveals the editor when the disclosure is used, and hides it again", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await user.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(panelOf()).toBeVisible();
    expect(addMount()).toBeVisible();
    expect(panelOf()).toHaveTextContent(MOUNTS_HINT);
    await user.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Add mount" })).toBeNull();
  });

  it("starts open on a group's mounts, its rows seeded from them", async () => {
    await renderDialog(gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT, DATA_MOUNT]) }));
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(hostPaths().map((each) => (each as HTMLInputElement).value)).toEqual(["/var/log/nginx", "/srv/data"]);
    expect(containerPaths().map((each) => (each as HTMLInputElement).value)).toEqual(["/var/log/nginx", "/var/lib/otelcol"]);
    expect(screen.getAllByRole("checkbox", { name: "Read-only" }).map((each) => each.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(submit()).toBeDisabled();
  });

  it("saves a mount added onto the group: annotations alone, the group's other keys kept", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup({ annotations: { other: { kept: true } } }));
    await addMountOf(user, " /var/log/nginx ", "/var/log/nginx");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([
      {
        groupId: GATEWAYS_GROUP_ID,
        request: { annotations: { other: { kept: true }, telflo: { dockerMounts: [{ hostPath: "/var/log/nginx", containerPath: "/var/log/nginx", readOnly: true }] } } },
      },
    ]);
  });

  it("saves a mount edited, and one made writable, with a rename in one PATCH", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT, DATA_MOUNT]) }));
    await user.clear(containerPaths()[0]!);
    await user.type(containerPaths()[0]!, "/logs/nginx");
    await user.click(screen.getAllByRole("checkbox", { name: "Read-only" })[0]!);
    await rename(user, "databases");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([
      {
        groupId: GATEWAYS_GROUP_ID,
        request: {
          name: "databases",
          annotations: { other: { kept: true }, telflo: { dockerMounts: [{ ...NGINX_MOUNT, containerPath: "/logs/nginx", readOnly: false }, DATA_MOUNT] } },
        },
      },
    ]);
  });

  it.each([
    ["removes the telflo key, the group's other keys kept", mountsAnnotations([NGINX_MOUNT]), { other: { kept: true } }],
    ["sends null when nothing is left", { telflo: { dockerMounts: [NGINX_MOUNT] } }, null],
  ])("with every mount removed, %s", async (_which, annotations, sent) => {
    const { user, onChanged } = await renderDialog(gatewaysGroup({ annotations }));
    await user.click(screen.getByRole("button", { name: "Remove mount 1" }));
    expect(hostPaths()).toEqual([]);
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { annotations: sent } }]);
  });

  it("sends no annotations when the mounts are as they were: a rename alone, or a mount added then removed", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) }));
    await user.click(addMount());
    expect(submit()).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Remove mount 2" }));
    expect(submit()).toBeDisabled();
    // A path's spaces trimmed is the same mount.
    await user.type(hostPaths()[0]!, "  ");
    expect(submit()).toBeDisabled();
    await rename(user, "databases");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { name: "databases" } }]);
  });

  describe("read again before the write", () => {
    it("refuses the save when another member saved a mount since the opening: the words, nothing written, the dialog open", async () => {
      const opened = gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) });
      api.freshGroups = [collectorGroup(), { ...opened, annotations: mountsAnnotations([NGINX_MOUNT, DATA_MOUNT]) }];
      const { user, onChanged, onOpenChange } = await renderDialog(opened);
      await addMountOf(user, "/var/log/app", "/var/log/app");
      await user.click(submit());
      expect(await screen.findByText(MOUNTS_CHANGED_MESSAGE)).toBeInTheDocument();
      expect(MOUNTS_CHANGED_MESSAGE).toBe("This group's mounts changed since you opened it: close and reopen to see them.");
      expect(spies.getCollectorGroups).toHaveBeenCalledTimes(1);
      expect(api.updates).toEqual([]);
      // The tab reads its groups again at once: a reopening shows the mounts saved meanwhile.
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(submit()).toHaveTextContent("Save");
    });

    it("refuses it too when the mounts were all removed elsewhere, or a rename comes with the mounts", async () => {
      const opened = gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) });
      api.freshGroups = [{ ...opened, annotations: { other: { kept: true } } }];
      const { user } = await renderDialog(opened);
      await addMountOf(user, "/var/log/app", "/var/log/app");
      await rename(user, "databases");
      await user.click(submit());
      expect(await screen.findByText(MOUNTS_CHANGED_MESSAGE)).toBeInTheDocument();
      expect(api.updates).toEqual([]);
    });

    it("merges the mounts into the group's fresh annotations: a key another client wrote meanwhile is kept", async () => {
      const opened = gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) });
      api.freshGroups = [{ ...opened, annotations: { ...mountsAnnotations([NGINX_MOUNT]), theirs: [1, 2] } }];
      const { user, onChanged } = await renderDialog(opened);
      await addMountOf(user, "/srv/data", "/var/lib/otelcol");
      await user.click(submit());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(api.updates).toEqual([
        {
          groupId: GATEWAYS_GROUP_ID,
          request: { annotations: { other: { kept: true }, theirs: [1, 2], telflo: { dockerMounts: [NGINX_MOUNT, { ...DATA_MOUNT, readOnly: true }] } } },
        },
      ]);
      // The read and the write under the one hang guard.
      expect(api.signals).toHaveLength(2);
      expect(api.signals[0]).toBe(api.signals[1]);
    });

    it("reads nothing for a name or version save alone", async () => {
      const { user, onChanged } = await renderDialog(gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) }));
      await rename(user, "databases");
      await user.click(submit());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(spies.getCollectorGroups).not.toHaveBeenCalled();
      expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { name: "databases" } }]);
    });

    it('toasts "Group not found", closes and reloads when the fresh read no longer holds the group', async () => {
      const error = vi.spyOn(toast, "error");
      api.freshGroups = [collectorGroup()];
      const { user, onChanged, onOpenChange } = await renderDialog(gatewaysGroup());
      await addMountOf(user, "/var/log/nginx", "/var/log/nginx");
      await user.click(submit());
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(error).toHaveBeenCalledWith(GROUP_NOT_FOUND_MESSAGE);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(api.updates).toEqual([]);
    });

    it("shows a failed read's words with nothing written, and the save tries again", async () => {
      api.freshGroups = UNAVAILABLE();
      const { user, onChanged } = await renderDialog(gatewaysGroup());
      await addMountOf(user, "/var/log/nginx", "/var/log/nginx");
      await user.click(submit());
      expect(await screen.findByText(FLEETS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
      expect(api.updates).toEqual([]);
      api.freshGroups = null;
      await user.click(submit());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(api.updates).toHaveLength(1);
    });
  });

  it("create: sends the mounts as annotations with the name and the version; none without mounts", async () => {
    const { user, onChanged } = await renderDialog();
    await user.type(nameField(), "web-hosts");
    await pickConfiguration(user, "payments-otel", /@v2/);
    await addMountOf(user, "/var/log/nginx", "/var/log/nginx");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([
      { name: "web-hosts", assignedVersionId: P2_ID, annotations: { telflo: { dockerMounts: [NGINX_MOUNT] } } },
    ]);
  });

  it("create: a mount added then removed sends none", async () => {
    const { user, onChanged } = await renderDialog();
    await user.type(nameField(), "web-hosts");
    await pickConfiguration(user, "payments-otel", /@v2/);
    await addMountOf(user, "/var/log/nginx", "/var/log/nginx");
    await user.click(screen.getByRole("button", { name: "Remove mount 1" }));
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([{ name: "web-hosts", assignedVersionId: P2_ID }]);
  });

  it("the Default group's mounts are editable: an unassigned Default's Assign saves them alone", async () => {
    const { user, onChanged } = await renderDialog(collectorGroup());
    expect(submit()).toHaveTextContent("Assign");
    expect(submit()).toBeDisabled();
    await addMountOf(user, "/var/log/nginx", "/var/log/nginx");
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: DEFAULT_GROUP_ID, request: { annotations: { telflo: { dockerMounts: [NGINX_MOUNT] } } } }]);
  });

  it("shows each field's message under it with nothing sent, opening the disclosure; typing clears the field's", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await addMountOf(user, "var/log", "/app/data");
    await user.click(addMount());
    await user.type(hostPaths()[1]!, "/srv/other");
    await user.type(containerPaths()[1]!, "/app/data");
    // Closed before the submit: the messages open it again.
    await user.click(disclosure());
    fireEvent.change(nameField(), { target: { value: "x".repeat(81) } });
    await user.click(submit());

    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(hostPaths()[0]).toHaveAccessibleDescription("Use an absolute path, starting with /.");
    expect(containerPaths()[0]).toHaveAccessibleDescription("Use a path outside /app: the image keeps its own files there.");
    expect(hostPaths()[1]).not.toHaveAttribute("aria-invalid");
    expect(containerPaths()[1]).toHaveAccessibleDescription("Use a path outside /app: the image keeps its own files there.");
    // The Name's message too, in the same submit.
    expect(nameField()).toHaveAccessibleDescription("Must be 1 to 80 characters.");
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();

    await user.clear(containerPaths()[1]!);
    await user.type(containerPaths()[1]!, "/data");
    expect(containerPaths()[1]).not.toHaveAttribute("aria-invalid");
    expect(containerPaths()[0]).toHaveAttribute("aria-invalid", "true");
    await user.clear(containerPaths()[0]!);
    await user.type(containerPaths()[0]!, "/data/");
    await user.clear(hostPaths()[0]!);
    await user.type(hostPaths()[0]!, "/var/log");
    await rename(user, "databases");
    await user.click(submit());
    // The same container path twice (a trailing / is the same path to Docker): the contracts' words on the second.
    expect(containerPaths()[0]).not.toHaveAttribute("aria-invalid");
    expect(containerPaths()[1]).toHaveAccessibleDescription("Each container path once.");
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
    // A removal renumbers the rows: every mount message goes.
    await user.click(screen.getByRole("button", { name: "Remove mount 1" }));
    expect(screen.queryByText("Each container path once.")).toBeNull();
  });

  it("refuses an empty mount: each path's message, nothing sent", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await user.click(disclosure());
    await user.click(addMount());
    await user.click(submit());
    expect(hostPaths()[0]).toHaveAccessibleDescription("Type a path.");
    expect(containerPaths()[0]).toHaveAccessibleDescription("Type a path.");
    expect(spies.updateCollectorGroup).not.toHaveBeenCalled();
  });

  it("shows a 400's mount details under the row's field and the annotations' under the rows, never the API's invalid_request words", async () => {
    api.answers = [
      refusal("invalid_request", "The request was not valid.", 400, {
        details: [
          { path: ["annotations", "telflo", "dockerMounts", 1, "containerPath"], message: "Each container path once." },
          { instancePath: "/annotations/telflo/dockerMounts/0/hostPath", message: "Use no . or .. segment." },
          { path: ["annotations"], message: "Must be at most 16384 bytes as JSON, with no number written with an exponent and no U+0000." },
        ],
      }),
    ];
    const { user, onOpenChange } = await renderDialog(gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) }));
    await addMountOf(user, "/srv/data", "/var/lib/otelcol");
    await user.click(disclosure());
    await user.click(submit());
    await waitFor(() => expect(containerPaths()[1]).toHaveAccessibleDescription("Each container path once."));
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
    expect(hostPaths()[0]).toHaveAccessibleDescription("Use no . or .. segment.");
    expect(screen.getByText("Must be at most 16384 bytes as JSON, with no number written with an exponent and no U+0000.")).toBeInTheDocument();
    expect(screen.queryByText("The request was not valid.")).toBeNull();
    expect(screen.queryByText(SAVE_GROUP_FAILED_MESSAGE)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  describe("an annotation Telflo can't read", () => {
    const unreadable = { other: 1, telflo: { dockerMounts: "not a list" } };

    it("shows no rows and says a mount added replaces them; a rename leaves it", async () => {
      const { user, onChanged } = await renderDialog(gatewaysGroup({ annotations: unreadable }));
      expect(disclosure()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(MOUNTS_UNREADABLE)).toBeVisible();
      expect(hostPaths()).toEqual([]);
      expect(submit()).toBeDisabled();
      await rename(user, "databases");
      await user.click(submit());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { name: "databases" } }]);
    });

    it("replaces it with a mount added here, the other keys kept", async () => {
      const { user, onChanged } = await renderDialog(gatewaysGroup({ annotations: unreadable }));
      await addMountOf(user, "/var/log/nginx", "/var/log/nginx");
      await user.click(submit());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { annotations: { other: 1, telflo: { dockerMounts: [NGINX_MOUNT] } } } }]);
    });
  });

  it("disables the disclosure and every mount field while saving", async () => {
    api.answers = ["hang"];
    const { user } = await renderDialog(gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) }));
    await user.type(hostPaths()[0]!, "/x");
    await user.click(submit());
    expect(submit()).toHaveTextContent("Saving…");
    expect(disclosure()).toBeDisabled();
    for (const control of [...hostPaths(), ...containerPaths(), ...screen.getAllByRole("checkbox", { name: "Read-only" })]) {
      expect(control).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Remove mount 1" })).toBeDisabled();
    expect(addMount()).toBeDisabled();
  });

  it("opens afresh: the group's mounts again, the disclosure as the group has it", async () => {
    const { user } = await renderDialog(gatewaysGroup());
    await addMountOf(user, "/var/log/nginx", "/var/log/nginx");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await screen.findByRole("dialog");
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(hostPaths()).toEqual([]);
  });

  // Mount paths are configuration text.
  it("holds no mount path in an attribute but its inputs' value, inside ph-no-capture, the messages shown too", async () => {
    const hostPath = "/srv/canary-host-9e2a";
    const containerPath = "/canary-container-41c7";
    const typed = "/canary-typed-d03f";
    const { user } = await renderDialog(gatewaysGroup({ annotations: mountsAnnotations([{ hostPath, containerPath, readOnly: true }]) }));
    await user.click(addMount());
    await user.type(hostPaths()[1]!, typed);
    await user.type(containerPaths()[1]!, containerPath);
    await user.click(submit());
    expect(await screen.findByText("Each container path once.")).toBeInTheDocument();
    for (const path of [hostPath, containerPath, typed]) {
      const holders = attributesHoldingBut(path, []);
      expect(holders.length, path).toBeGreaterThan(0);
      expect(new Set(holders), path).toEqual(new Set(["INPUT value"]));
      for (const input of document.querySelectorAll("input")) {
        if (input.getAttribute("value")?.includes(path)) expect(input.closest(".ph-no-capture"), path).not.toBeNull();
      }
    }
    expect(document.title).not.toContain("canary");
  });
});

// The Variable group and "Variables used".
describe("GroupDialog's Variable group and Variables used", () => {
  const EU_ID = "7b000000-0000-4000-8000-0000000000e1";
  const US_ID = "7b000000-0000-4000-8000-0000000000e2";

  /** A deferred answer of a version's text. */
  function deferredText() {
    let release!: (yaml: string) => void;
    const promise = new Promise<string>((resolve) => (release = resolve));
    return { promise, release };
  }

  /** Serves each version's text by id, and the organization's variables (the shared names). */
  function serveTexts(texts: Record<string, string | Promise<string>>, defined: string[] = ["OTLP_EP"]) {
    const signals: Record<string, AbortSignal | undefined> = {};
    vi.mocked(apiClient.getConfigurationVersion).mockImplementation(async (organizationId, configurationId, versionId, options = {}) => {
      expect(organizationId).toBe(GROUP_ID);
      signals[versionId] = options.signal;
      const yamlContent = await (texts[versionId] ?? "");
      return answerFor({ ...THEIRS, id: configurationId }, versionFixture({ id: versionId, configurationId, yamlContent }));
    });
    vi.mocked(apiClient.getOrganizationVariables).mockResolvedValue(
      defined.map((name, index) => organizationVariable({ id: `7a000000-0000-4000-8000-00000000000${index}`, name })),
    );
    return signals;
  }

  beforeEach(() => {
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: EU_ID, name: "eu-edge" }), variableGroup({ id: US_ID, name: "us-edge" })]);
  });

  afterEach(() => {
    useUserStore.getState().clear();
    forgetOrgVariableNames();
    forgetVariableGroupNames();
  });

  it('offers "None (organization values)" first and by default, then the organization\'s variable groups, read once at the opening', async () => {
    const { user } = await renderDialog(gatewaysGroup());
    const select = await screen.findByRole("combobox", { name: "Variable group" });
    expect(select).toHaveTextContent("None (organization values)");
    await user.click(select);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["None (organization values)", "eu-edge", "us-edge"]);
    await user.keyboard("{Escape}");
    expect(submit()).toBeDisabled();
    expect(apiClient.getVariableGroups).toHaveBeenCalledTimes(1);
    expect(apiClient.getVariableGroups).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("saves a variable group alone: one PATCH of variableGroupId", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup());
    await screen.findByRole("combobox", { name: "Variable group" });
    await choose(user, "Variable group", "eu-edge");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { variableGroupId: EU_ID } }]);
  });

  it("preselects the group's variable group and clears it with None: variableGroupId null", async () => {
    const { user, onChanged } = await renderDialog(gatewaysGroup({ variableGroupId: US_ID }));
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("us-edge");
    expect(submit()).toBeDisabled();
    await choose(user, "Variable group", "None (organization values)");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { variableGroupId: null } }]);
  });

  it("creates with a variable group chosen, and sends none for None", async () => {
    const { user, onChanged } = await renderDialog();
    await user.type(nameField(), "prod-server");
    await pickConfiguration(user, "payments-otel", /@v2/);
    await choose(user, "Variable group", "eu-edge");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.creates).toEqual([{ name: "prod-server", assignedVersionId: P2_ID, variableGroupId: EU_ID }]);
    expect(requestOf(null, "x", "version", PAYMENTS_ID, P2_ID)).toEqual({ kind: "create", body: { name: "x", assignedVersionId: P2_ID } });
  });

  it("lists the names the chosen version references that no organization variable has, before Save, inside ph-no-capture", async () => {
    serveTexts({ [publishedVersion().versionId]: "exporters:\n  otlp:\n    endpoint: ${org:OTLP_EP}\n    headers: { region: ${org:REGION} }\n" });
    await renderDialog(gatewaysGroup());
    const missing = await screen.findByText("REGION");
    expect(missing.closest(".ph-no-capture")).not.toBeNull();
    // The version the group already has: the save doesn't assign it again, so nothing says it would be refused.
    expect(screen.getByText(VARIABLES_UNDEFINED_ASSIGNED_HINT)).toBeInTheDocument();
    expect(screen.queryByText(VARIABLES_UNDEFINED_HINT)).toBeNull();
    expect(screen.queryByText("OTLP_EP")).toBeNull();
    expect(apiClient.getConfigurationVersion).toHaveBeenCalledWith(
      GROUP_ID,
      CONFIGURATION_ID,
      publishedVersion().versionId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expectNoAttributeHolds("REGION");
  });

  it("says a version with no organization variable, and one whose every variable is defined", async () => {
    serveTexts({ [publishedVersion().versionId]: "receivers: {}", [P2_ID]: "a: ${org:OTLP_EP}\nb: $${org:REGION}" });
    const { user } = await renderDialog(gatewaysGroup());
    expect(await screen.findByText(VARIABLES_USED_NONE)).toBeInTheDocument();
    await pickConfiguration(user, "payments-otel", /@v2/);
    // $${org:REGION} is literal text, not a reference.
    expect(await screen.findByText(allDefinedWords(1))).toBeInTheDocument();
  });

  // The shared names may be a minute old; the opening reads them again, so a variable just defined elsewhere isn't listed.
  it("reads the organization's names again at the opening once they are a minute old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serveTexts({ [publishedVersion().versionId]: "a: ${org:REGION}" }, ["REGION"]);
    seedOrgVariableNames(GROUP_ID, [organizationVariable({ name: "OTHER" })]);
    vi.setSystemTime(Date.now() + 60_000);
    await renderDialog(gatewaysGroup());
    expect(await screen.findByText(allDefinedWords(1))).toBeInTheDocument();
    expect(apiClient.getOrganizationVariables).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("REGION")).toBeNull();
  });

  it("aborts the previous version's read when another is chosen, and ignores its late answer", async () => {
    const first = deferredText();
    const signals = serveTexts({ [publishedVersion().versionId]: first.promise, [P2_ID]: "x: ${org:SECOND_NAME}" });
    const { user } = await renderDialog(gatewaysGroup());
    await waitFor(() => expect(signals[publishedVersion().versionId]).toBeDefined());
    await pickConfiguration(user, "payments-otel", /@v2/);
    expect(signals[publishedVersion().versionId]!.aborted).toBe(true);
    expect(await screen.findByText("SECOND_NAME")).toBeInTheDocument();
    // Another version than the group's: the save would assign it, and is refused.
    expect(screen.getByText(VARIABLES_UNDEFINED_HINT)).toBeInTheDocument();
    await act(async () => first.release("x: ${org:LATE_NAME}"));
    expect(screen.queryByText("LATE_NAME")).toBeNull();
    expect(screen.getByText("SECOND_NAME")).toBeInTheDocument();
  });

  it("shows a 422 variables_undefined's words and its names, at most 100, then … and N more from totalNames", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `MISSING_${index}`);
    api.answers = [
      refusal("variables_undefined", "The published version references organization variables that aren't defined: define them first.", 422, {
        details: { names, totalNames: 104 },
      }),
    ];
    const { user, onOpenChange } = await renderDialog(gatewaysGroup());
    await pickConfiguration(user, "payments-otel", /@v2/);
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("aren't defined: define them first.");
    expect(screen.getByText("MISSING_99").closest(".ph-no-capture")).not.toBeNull();
    expect(screen.getByText("… and 4 more")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("shows a 404 variable_group_not_found's words inline, and reads the variable groups again", async () => {
    api.answers = [refusal("variable_group_not_found", "Variable group not found", 404)];
    const { user } = await renderDialog(gatewaysGroup());
    await screen.findByRole("combobox", { name: "Variable group" });
    await choose(user, "Variable group", "eu-edge");
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: US_ID, name: "us-edge" })]);
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("Variable group not found");
    await waitFor(() => expect(apiClient.getVariableGroups).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("A variable group no longer listed");
  });

  // A parent reloading its groups while the dialog is open moves nothing of its baseline.
  it("keeps the group it opened with, its variable group included, when the parent reloads", async () => {
    const opened = gatewaysGroup({ variableGroupId: EU_ID });
    openedGroup = opened;
    const onChanged = vi.fn();
    function Page() {
      const [group, setGroup] = useState(opened);
      return (
        <>
          <button type="button" onClick={() => setGroup(gatewaysGroup({ variableGroupId: null }))}>
            Reload
          </button>
          <GroupDialog open onOpenChange={vi.fn()} group={group} organizationId={GROUP_ID} fleetId={FLEET_ID} onChanged={onChanged} />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/", Component: Page, loader: () => null, HydrateFallback: () => null }]);
    render(<Stub initialEntries={["/"]} />);
    const user = userEvent.setup();
    expect(await screen.findByRole("combobox", { name: "Variable group" })).toHaveTextContent("eu-edge");
    fireEvent.click(screen.getByRole("button", { name: "Reload", hidden: true }));
    expect(combobox("Variable group")).toHaveTextContent("eu-edge");
    await choose(user, "Variable group", "None (organization values)");
    await user.click(submit());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.updates).toEqual([{ groupId: GATEWAYS_GROUP_ID, request: { variableGroupId: null } }]);
  });

  it("holds no variable group's name in an attribute; the Select's trigger and list sit inside ph-no-capture", async () => {
    const name = "canary-bound-vg-3c9";
    vi.mocked(apiClient.getVariableGroups).mockResolvedValue([variableGroup({ id: EU_ID, name })]);
    const { user } = await renderDialog(gatewaysGroup({ variableGroupId: EU_ID }));
    const select = await screen.findByRole("combobox", { name: "Variable group" });
    expect(select).toHaveTextContent(name);
    expect(select).toHaveClass("ph-no-capture");
    await user.click(select);
    expect((await screen.findByRole("option", { name })).closest(".ph-no-capture")).not.toBeNull();
    expectNoAttributeHolds(name);
    // Radix's hidden native <select> inside the form holds the names as its options' text: inside ph-no-capture too.
    const native = [...document.querySelectorAll("select option")].filter((each) => (each.textContent ?? "").includes(name));
    expect(native.length).toBeGreaterThan(0);
    for (const each of native) expect(each.closest(".ph-no-capture")).not.toBeNull();
  });

  it("requestOf sends variableGroupId only when it differs from the group's", () => {
    const group = gatewaysGroup({ variableGroupId: EU_ID });
    const assigned = group.assignedVersion!;
    expect(requestOf(group, "gateways", "version", assigned.configurationId, assigned.versionId, [], EU_ID)).toEqual({ kind: "disabled" });
    expect(requestOf(group, "gateways", "version", assigned.configurationId, assigned.versionId, [], US_ID)).toEqual({
      kind: "update",
      body: { variableGroupId: US_ID },
    });
    expect(requestOf(group, "gateways", "version", assigned.configurationId, assigned.versionId, [], null)).toEqual({
      kind: "update",
      body: { variableGroupId: null },
    });
    // Left out, the group's own: no change.
    expect(requestOf(group, "gateways", "version", assigned.configurationId, assigned.versionId)).toEqual({ kind: "disabled" });
  });
});
