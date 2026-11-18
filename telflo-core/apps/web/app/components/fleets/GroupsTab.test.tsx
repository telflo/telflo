import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type CollectorGroup, type Configuration, type FleetDetail } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { FLEETS_POLL_INTERVAL_MS } from "~/lib/fleets.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember, THEIRS } from "~/test/configurations.js";
import {
  collectorGroup,
  configurationVersionListItem,
  CONFIGURATION_ID,
  DATA_MOUNT,
  expectNoAttributeHolds,
  expectNoAttributeHoldsInOpenTooltips,
  FLEET_ID,
  fleetDetail,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  mountsAnnotations,
  NGINX_MOUNT,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  VERSION_ID,
  serveNoVariables,
} from "~/test/fleets.js";
import { MOUNTS_CHANGED_MESSAGE } from "./GroupDialog.js";
import { groupDeleteConfirmLabel } from "./DeleteGroupDialog.js";
import { GROUPS_INTRO, GroupsTab } from "./GroupsTab.js";
import { INSTALL_NEEDS_LIVE_VERSION, INSTALL_NEEDS_VERSION, NOTHING_ASSIGNED_MEANING } from "./GroupsTable.js";

/*
 * A server fleet's Groups tab (D17b-2 decisions 9, 10, 14, 22–25, 32–34;
 * Preflight rulings 8, 10, 11, 14 and 15) over the real hook
 * (`useGroupsTab`), the browser client's calls answered by a small fake of
 * the API's groups: a row per group with its version linked to the
 * editor, "New group", Assign on an unassigned group and Edit otherwise
 * (the same dialog), the delete after confirming then the reload, the More
 * dialog's id, Edit's prefill, and its Install (enabled with a published
 * version, disabled with its reason otherwise: D17c-1 decision 44).
 */

const GONE = () => new ApiError("fleet_not_found", "Fleet not found.", { status: 404 });
const UNAVAILABLE = () => new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });

const EDGE_ID = "c0ffee00-0000-4000-8000-0000000000e0";
const NEW_GROUP_ID = "c0ffee00-0000-4000-8000-0000000000e9";
const V5_ID = "c0ffee00-0000-4000-8000-000000000005";
const CHECKOUT: Configuration = { ...THEIRS, id: CONFIGURATION_ID, name: "checkout-otel" };

/** "edge", nothing assigned. */
const edgeGroup = (overrides: Partial<CollectorGroup> = {}) => collectorGroup({ id: EDGE_ID, name: "edge", isDefault: false, ...overrides });

/** What the fake API holds: the fleet's groups in its order (Default first, then by name). */
interface Api {
  groups: CollectorGroup[];
  /** Fails the next groups reads with these, one each. */
  failures: unknown[];
  /** Holds every groups read until released. */
  hold: Promise<void> | null;
}

let api: Api;

function ordered(groups: CollectorGroup[]): CollectorGroup[] {
  return [...groups].sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1));
}

/** The groups read, and the writes over the fake as the API makes them. */
function serve() {
  serveNoVariables();
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async () => {
    if (api.hold !== null) await api.hold;
    const failure = api.failures.shift();
    if (failure !== undefined) throw failure;
    return { groups: ordered(api.groups) };
  });
  const getConfigurations = vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [CHECKOUT], nextCursor: null });
  vi.spyOn(apiClient, "getConfigurationVersions").mockResolvedValue({
    versions: [configurationVersionListItem({ id: V5_ID, versionNumber: 5 }), configurationVersionListItem()],
  });
  const createCollectorGroup = vi.spyOn(apiClient, "createCollectorGroup").mockImplementation(async (_organizationId, _fleetId, request) => {
    const made = collectorGroup({ id: NEW_GROUP_ID, name: request.name, isDefault: false });
    api.groups = [...api.groups, made];
    return made;
  });
  const updateCollectorGroup = vi.spyOn(apiClient, "updateCollectorGroup").mockImplementation(async (_organizationId, _fleetId, groupId, request) => {
    const index = api.groups.findIndex((group) => group.id === groupId);
    const assigned =
      request.assignedVersionId === undefined
        ? {}
        : request.assignedVersionId === null
          ? { assignedPublishedVersionId: null, assignedVersion: null }
          : {
              assignedPublishedVersionId: PUBLISHED_VERSION_ID,
              assignedVersion: publishedVersion({ versionId: request.assignedVersionId, versionNumber: request.assignedVersionId === V5_ID ? 5 : 4 }),
            };
    api.groups[index] = { ...api.groups[index]!, ...(request.name === undefined ? {} : { name: request.name }), ...assigned };
    return api.groups[index]!;
  });
  const deleteCollectorGroup = vi.spyOn(apiClient, "deleteCollectorGroup").mockImplementation(async (_organizationId, _fleetId, groupId) => {
    api.groups = api.groups.filter((group) => group.id !== groupId);
    return undefined;
  });
  return { getCollectorGroups, getConfigurations, createCollectorGroup, updateCollectorGroup, deleteCollectorGroup };
}

const onFleetGone = vi.fn();
const onFleetChanged = vi.fn();
const onInstall = vi.fn();

/** The tab as the route gives it: a row's Install for an active fleet only. */
function renderTab(fleet: FleetDetail = fleetDetail(), { groupsChanged = 0 }: { groupsChanged?: number } = {}) {
  const install = fleet.status === "active" ? onInstall : undefined;
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <GroupsTab fleet={fleet} onFleetGone={onFleetGone} onFleetChanged={onFleetChanged} onInstall={install} groupsChanged={groupsChanged} />
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

async function poll(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
}

const button = (name: string) => screen.getByRole("button", { name });
const rowOf = (name: string) => screen.getByRole("button", { name: `More about ${name}` }).closest("tr") as HTMLElement;
const groupNames = () => screen.getAllByRole("row").slice(1).map((row) => row.querySelector("td span")?.textContent);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  onFleetGone.mockClear();
  onFleetChanged.mockClear();
  onInstall.mockClear();
  api = { groups: [collectorGroup(), gatewaysGroup()], failures: [], hold: null };
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

describe("GroupsTab's states (decision 23)", () => {
  it('shows "Loading groups…" until the first read answers', async () => {
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    serve();
    renderTab();
    expect(await screen.findByText("Loading groups…")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    api.hold = null;
    await act(async () => release());
    expect(await screen.findByText("gateways")).toBeInTheDocument();
    expect(screen.queryByText("Loading groups…")).toBeNull();
  });

  it('shows a failed first load ("Failed to load groups") with Try again, which reads again', async () => {
    api.failures = [UNAVAILABLE()];
    const { getCollectorGroups } = serve();
    const user = renderTab();
    expect(await screen.findByText("Failed to load groups")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(button("Try again"));
    expect(await screen.findByText("gateways")).toBeInTheDocument();
    expect(getCollectorGroups).toHaveBeenCalledTimes(2);
  });

  it("calls onFleetGone on a fleet found gone, with no toast and no failed state", async () => {
    api.failures = [GONE()];
    const error = vi.spyOn(toast, "error");
    serve();
    renderTab();
    await waitFor(() => expect(onFleetGone).toHaveBeenCalledTimes(1));
    expect(error).not.toHaveBeenCalled();
    expect(screen.queryByText("Failed to load groups")).toBeNull();
  });

  it('shows the intro, "New group" and "Refresh groups"', async () => {
    serve();
    renderTab();
    await screen.findByText("gateways");
    expect(GROUPS_INTRO).toBe(
      "A group gives its collectors one published version. Collectors join a group when they are installed into it or moved to it; a collector pinned to a version keeps its pin. Add groups to run different configurations in one fleet, e.g.",
    );
    expect(screen.getByText(/^A group gives its collectors/)).toHaveTextContent(`${GROUPS_INTRO} web-hosts and db-hosts.`);
    expect(button("New group")).toBeEnabled();
    expect(button("Refresh groups")).toBeEnabled();
    expect(document.body).not.toHaveTextContent(/deploy group|\binstall\b/i);
  });
});

describe("GroupsTab's rows (decisions 14 and 23)", () => {
  it("renders one row per group in the API's order, with Name, Published version linked to the editor, Variable group, More, and its actions", async () => {
    api.groups = [gatewaysGroup(), edgeGroup(), collectorGroup()];
    serve();
    renderTab();
    await screen.findByText("gateways");
    expect(screen.getAllByRole("columnheader").map((each) => each.textContent)).toEqual(["Name", "Published version", "Variable group", "More", "Actions"]);
    expect(groupNames()).toEqual(["Default", "edge", "gateways"]);

    const gateways = rowOf("gateways");
    expect(within(gateways).getByRole("link", { name: "checkout-otel @v4" })).toHaveAttribute("href", `/editor/${CONFIGURATION_ID}/${VERSION_ID}`);
    expect(within(gateways).getByRole("link")).not.toHaveAttribute("title");
    // D17c-1 decision 46: the name truncated at 16rem, the full text in a tooltip (PublishedVersionLink's).
    expect(within(within(gateways).getByRole("link")).getByText("checkout-otel")).toHaveClass("truncate", "max-w-64");
    act(() => within(gateways).getByRole("link").focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/^checkout-otel @v4$/);
    expect(within(gateways).getByRole("button", { name: "Edit gateways" })).toHaveTextContent("Edit");
    expect(within(gateways).getByRole("button", { name: "Delete gateways" })).toHaveTextContent("Delete");
    expect(within(gateways).getByRole("button", { name: "More about gateways" })).toHaveTextContent("More");
  });

  it('marks the Default group with a "Default" badge and gives it no Delete', async () => {
    serve();
    renderTab();
    await screen.findByText("gateways");
    const row = rowOf("Default");
    expect(within(row).getAllByText("Default")).toHaveLength(2);
    expect(within(row).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(rowOf("gateways")).queryByText("Default")).toBeNull();
  });

  it("shows a solid Assign on an unassigned group and an outline Edit on an assigned one", async () => {
    serve();
    renderTab();
    const assign = await screen.findByRole("button", { name: "Assign Default" });
    expect(assign).toHaveTextContent("Assign");
    expect(assign.className).toContain("bg-primary");
    const edit = button("Edit gateways");
    expect(edit.className).toContain("border");
    expect(edit.className).not.toContain("bg-primary");
  });

  it('shows "Nothing assigned" with its meaning as a tooltip and screen-reader text, never a title', async () => {
    serve();
    renderTab();
    await screen.findByText("gateways");
    const nothing = within(rowOf("Default")).getByText("Nothing assigned");
    expect(nothing).toHaveTextContent(`Nothing assigned (${NOTHING_ASSIGNED_MEANING})`);
    expect(nothing).toHaveAttribute("tabindex", "0");
    expect(nothing).not.toHaveAttribute("title");
    act(() => nothing.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(NOTHING_ASSIGNED_MEANING);
    expect(NOTHING_ASSIGNED_MEANING).toBe("The group's collectors that aren't pinned show Nothing assigned and keep running what they have.");
  });

  // Install: enabled with a published version, disabled otherwise.
  it("offers a row's Install before Assign or Edit, named Install into {name}, opening the route's dialog with the group and the button", async () => {
    serve();
    const user = renderTab();
    await screen.findByText("gateways");
    const row = rowOf("gateways");
    const install = within(row).getByRole("button", { name: "Install into gateways" });
    expect(install).toHaveTextContent("Install");
    expect(install).not.toHaveAttribute("title");
    expect(install.className).toContain("border");
    const actions = within(row)
      .getAllByRole("button")
      .filter((each) => each.textContent !== "More" && each.textContent !== "Organization values");
    expect(actions.map((each) => each.textContent)).toEqual(["Install", "Edit", "Delete"]);
    await user.click(install);
    expect(onInstall).toHaveBeenCalledWith(api.groups[1], install);
  });

  it("disables Install on a group with nothing assigned, its reason as a tooltip on a focusable wrapper and as screen-reader text", async () => {
    serve();
    const user = renderTab();
    await screen.findByText("gateways");
    // One element named "Install into Default": the focusable wrapper, role="button" and aria-disabled (Ruling 52);
    // the disabled button inside it hidden from assistive technology.
    const wrapper = within(rowOf("Default")).getByRole("button", { name: "Install into Default" });
    expect(wrapper.tagName).toBe("SPAN");
    expect(wrapper).toHaveAttribute("aria-disabled", "true");
    expect(wrapper).toHaveAttribute("tabindex", "0");
    expect(wrapper).toHaveAccessibleDescription(`(${INSTALL_NEEDS_VERSION})`);
    expect(wrapper).toHaveTextContent(`Install (${INSTALL_NEEDS_VERSION})`);
    expect(wrapper).not.toHaveAttribute("title");
    const install = wrapper.querySelector("button") as HTMLButtonElement;
    expect(install).toBeDisabled();
    expect(install).toHaveAttribute("aria-hidden", "true");
    expect(INSTALL_NEEDS_VERSION).toBe("Assign a published version first.");
    act(() => wrapper.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(INSTALL_NEEDS_VERSION);
    await user.click(wrapper);
    expect(onInstall).not.toHaveBeenCalled();
  });

  // Decision 44 (no published version) and Ruling 61: the install's facts would refuse it anyway.
  it("disables Install on a deleted configuration's version, with the facts' words as its reason", async () => {
    api.groups = [collectorGroup(), gatewaysGroup({ assignedVersion: null })];
    serve();
    const user = renderTab();
    await screen.findByText("gateways");
    const wrapper = within(rowOf("gateways")).getByRole("button", { name: "Install into gateways" });
    expect(wrapper).toHaveAttribute("aria-disabled", "true");
    expect(INSTALL_NEEDS_LIVE_VERSION).toBe("This group's published version belongs to a deleted configuration. Assign another first.");
    expect(wrapper).toHaveAccessibleDescription(`(${INSTALL_NEEDS_LIVE_VERSION})`);
    act(() => wrapper.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(INSTALL_NEEDS_LIVE_VERSION);
    await user.click(wrapper);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("offers no Install on an archived fleet's rows", async () => {
    serve();
    renderTab(fleetDetail({ status: "archived" }));
    await screen.findByText("gateways");
    expect(screen.queryByRole("button", { name: /^Install into/ })).toBeNull();
  });

  it("shows \"A deleted configuration's version\" for an assignment the platform no longer holds, with Edit", async () => {
    api.groups = [collectorGroup(), gatewaysGroup({ assignedVersion: null })];
    serve();
    renderTab();
    await screen.findByText("gateways");
    const row = rowOf("gateways");
    expect(within(row).getByText("A deleted configuration's version")).toBeInTheDocument();
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).getByRole("button", { name: "Edit gateways" })).toBeInTheDocument();
  });
});

describe("GroupsTab's poll and refresh (decisions 10 and 32)", () => {
  it("re-reads the groups every 15 s, and a row follows", async () => {
    const { getCollectorGroups } = serve();
    renderTab();
    await screen.findByText("gateways");
    const reads = getCollectorGroups.mock.calls.length;
    api.groups = [collectorGroup(), gatewaysGroup({ name: "gateways-eu" })];
    await poll();
    expect(await screen.findByText("gateways-eu")).toBeInTheDocument();
    expect(getCollectorGroups).toHaveBeenCalledTimes(reads + 1);
  });

  it("pauses the polls while a dialog is open", async () => {
    const { getCollectorGroups } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "More about gateways" }));
    await screen.findByRole("dialog");
    const reads = getCollectorGroups.mock.calls.length;
    await poll();
    expect(getCollectorGroups).toHaveBeenCalledTimes(reads);
  });

  it("reads again on Refresh groups, spinning until it answers", async () => {
    const { getCollectorGroups } = serve();
    const user = renderTab();
    await screen.findByText("gateways");
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    api.groups = [collectorGroup(), edgeGroup(), gatewaysGroup()];
    await user.click(button("Refresh groups"));
    expect(button("Refresh groups").querySelector("svg")).toHaveClass("animate-spin");
    api.hold = null;
    await act(async () => release());
    expect(await screen.findByText("edge")).toBeInTheDocument();
    expect(button("Refresh groups").querySelector("svg")).not.toHaveClass("animate-spin");
    expect(getCollectorGroups).toHaveBeenCalledTimes(2);
  });

  it("reads the groups again when the route's groupsChanged moves (an assignment made outside the tab), not on its first render", async () => {
    const { getCollectorGroups } = serve();
    function Harness() {
      const [changed, setChanged] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setChanged((value) => value + 1)}>
            assigned elsewhere
          </button>
          <GroupsTab fleet={fleetDetail()} onFleetGone={onFleetGone} onFleetChanged={onFleetChanged} groupsChanged={changed} />
        </>
      );
    }
    const Stub = createRoutesStub([{ path: "/", Component: Harness }]);
    render(<Stub initialEntries={["/"]} />);
    await screen.findByText("gateways");
    expect(getCollectorGroups).toHaveBeenCalledTimes(1);
    api.groups = [collectorGroup({ assignedPublishedVersionId: PUBLISHED_VERSION_ID, assignedVersion: publishedVersion() }), gatewaysGroup()];
    await userEvent.setup().click(screen.getByRole("button", { name: "assigned elsewhere" }));
    await waitFor(() => expect(getCollectorGroups).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Edit Default" })).toBeInTheDocument();
  });
});

describe("GroupsTab's dialogs (decisions 22–25)", () => {
  it("opens a row's More: its details with the collector group id", async () => {
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "More about gateways" }));
    const dialog = await screen.findByRole("dialog", { name: "gateways" });
    expect(within(dialog).getByText("Group details")).toBeInTheDocument();
    expect(within(dialog).getByText("Collector Group ID")).toBeInTheDocument();
    expect(within(dialog).getByText(GATEWAYS_GROUP_ID)).toBeInTheDocument();
  });

  it("opens a row's Edit with the group prefilled, and saves a rename, then reloads the groups and the fleet", async () => {
    const { getCollectorGroups, updateCollectorGroup } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Edit gateways" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit gateways" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("gateways");
    const reads = getCollectorGroups.mock.calls.length;
    await user.clear(name);
    await user.type(name, "databases");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateCollectorGroup).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, { name: "databases" }, expect.anything());
    await waitFor(() => expect(getCollectorGroups).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("databases")).toBeInTheDocument();
  });

  it("opens an unassigned group's Assign as the same dialog, titled for assigning; the row then reads Edit", async () => {
    serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Assign Default" }));
    const dialog = await screen.findByRole("dialog", { name: "Assign a published version to Default" });
    await user.click(within(dialog).getByRole("combobox", { name: "Configuration" }));
    await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v5"));
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(rowOf("Default")).findByRole("link", { name: "checkout-otel @v5" })).toBeInTheDocument();
    expect(button("Edit Default")).toHaveTextContent("Edit");
  });

  it('creates a group from "New group", then reloads the groups and the fleet', async () => {
    const { createCollectorGroup } = serve();
    const user = renderTab();
    await screen.findByText("gateways");
    await user.click(button("New group"));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "db-hosts");
    // A new group requires a published version (Ruling 34): a configuration picked selects its newest.
    await user.click(within(dialog).getByRole("combobox", { name: "Configuration" }));
    await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v5"));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createCollectorGroup).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { name: "db-hosts", assignedVersionId: V5_ID }, expect.anything());
    expect(await screen.findByRole("button", { name: "More about db-hosts" })).toBeInTheDocument();
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });

  // Confirmed by the typed name (D17d-1 decision 3).
  it("deletes a group after its name is typed, then reloads the groups and the fleet", async () => {
    const { getCollectorGroups, deleteCollectorGroup } = serve();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Delete gateways" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete gateways" });
    const reads = getCollectorGroups.mock.calls.length;
    await user.type(within(dialog).getByLabelText(groupDeleteConfirmLabel("gateways")), "gateways");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteCollectorGroup).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, GATEWAYS_GROUP_ID, expect.anything());
    await waitFor(() => expect(getCollectorGroups).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("gateways")).toBeNull());
  });

  it("keeps an archived fleet's groups editable (Preflight ruling 8)", async () => {
    serve();
    renderTab(fleetDetail({ status: "archived" }));
    await screen.findByText("gateways");
    for (const name of ["New group", "Assign Default", "Edit gateways", "Delete gateways", "More about gateways"]) expect(button(name)).toBeEnabled();
  });

  it.each([
    ["the details", "More about gateways", "dialog"],
    ["the edit", "Edit gateways", "dialog"],
    ["the create", "New group", "dialog"],
    ["the delete", "Delete gateways", "alertdialog"],
  ] as const)("closes %s when the organization changes", async (_which, opener, role) => {
    serve();
    const user = renderTab();
    await screen.findByText("gateways");
    await user.click(button(opener));
    expect(await screen.findByRole(role)).toBeInTheDocument();

    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
  });
});

describe("GroupsTab's focus as a dialog closes (decision 33; Preflight ruling 14)", () => {
  async function loaded() {
    api.groups = [collectorGroup(), edgeGroup(), gatewaysGroup()];
    serve();
    const user = renderTab();
    await screen.findByText("gateways");
    return user;
  }

  const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));

  it.each([
    ["the details", "More about gateways", "dialog"],
    ["the edit", "Edit gateways", "dialog"],
    ["the assign", "Assign edge", "dialog"],
    ["the create", "New group", "dialog"],
    ["the delete", "Delete gateways", "alertdialog"],
  ] as const)("returns to the opener after %s closes by Escape", async (_which, opener, role) => {
    const user = await loaded();
    await user.click(button(opener));
    await screen.findByRole(role);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    await focusIsOn(() => button(opener));
  });

  it("returns to the row's button after an assignment, the same element now reading Edit", async () => {
    const user = await loaded();
    const opener = button("Assign edge");
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Assign a published version to edge" });
    await user.click(within(dialog).getByRole("combobox", { name: "Configuration" }));
    await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v5"));
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(button("Edit edge")).toBe(opener));
    await focusIsOn(() => button("Edit edge"));
  });

  it("returns to \"New group\" after a create", async () => {
    const user = await loaded();
    await user.click(button("New group"));
    const dialog = await screen.findByRole("dialog", { name: "New group" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "db-hosts");
    await user.click(within(dialog).getByRole("combobox", { name: "Configuration" }));
    await user.click(await screen.findByRole("option", { name: "checkout-otel" }));
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v5"));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await screen.findByRole("button", { name: "More about db-hosts" });
    await focusIsOn(() => button("New group"));
  });

  it("goes to the first row's Assign or Edit after a delete, its row gone", async () => {
    const user = await loaded();
    await user.click(button("Delete gateways"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete gateways" });
    await user.type(within(dialog).getByLabelText(groupDeleteConfirmLabel("gateways")), "gateways");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("gateways")).toBeNull());
    await focusIsOn(() => button("Assign Default"));
  });

  it("moves on from the row's Delete once a reload answered after the close removes the row (D14b Ruling 52)", async () => {
    const user = await loaded();
    await user.click(button("Delete edge"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete edge" });
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    await user.type(within(dialog).getByLabelText(groupDeleteConfirmLabel("edge")), "edge");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    // Closed, the reload held: the focus is back on the row's Delete, the row still shown.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await focusIsOn(() => button("Delete edge"));

    api.hold = null;
    await act(async () => release());
    await waitFor(() => expect(screen.queryByText("edge")).toBeNull());
    await focusIsOn(() => button("Assign Default"));
  });

  it("goes to the first row's Assign or Edit when the edit finds its group gone", async () => {
    const user = await loaded();
    await user.click(button("Edit gateways"));
    const dialog = await screen.findByRole("dialog", { name: "Edit gateways" });
    vi.mocked(apiClient.updateCollectorGroup).mockImplementation(async (_organizationId, _fleetId, groupId) => {
      api.groups = api.groups.filter((group) => group.id !== groupId);
      throw new ApiError("collector_group_not_found", "Collector group not found.", { status: 404 });
    });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "-2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("gateways")).toBeNull());
    await focusIsOn(() => button("Assign Default"));
  });

  it("goes to Refresh groups when no row's button is left", async () => {
    const user = await loaded();
    await user.click(button("Delete gateways"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete gateways" });
    // A reload answering no groups at all (the API never does: Default always exists) leaves no row's button.
    vi.mocked(apiClient.deleteCollectorGroup).mockImplementation(async () => {
      api.groups = [];
      return undefined;
    });
    await user.type(within(dialog).getByLabelText(groupDeleteConfirmLabel("gateways")), "gateways");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("gateways")).toBeNull());
    await focusIsOn(() => button("Refresh groups"));
  });

  it("never moves the focus when a poll takes away the row an Escape (no write) went back to", async () => {
    const user = await loaded();
    await user.click(button("Delete edge"));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await focusIsOn(() => button("Delete edge"));
    act(() => (document.activeElement as HTMLElement).blur());

    api.groups = api.groups.filter((group) => group.id !== EDGE_ID);
    await poll();
    await waitFor(() => expect(screen.queryByText("edge")).toBeNull());
    expect(document.activeElement).toBe(document.body);
  });
});

// ADR 0024, decisions 12 and 34: no group, configuration or fleet name and no version label in any attribute.
describe("GroupsTab's privacy", () => {
  it("holds no group, configuration or fleet name or version label in an attribute: rows, tooltips, each dialog open (the Name's value excepted)", async () => {
    const groupName = "canary-group-5e21";
    const emptyName = "canary-empty-group-a0c3";
    const orphanName = "canary-orphan-group-77de";
    const configurationName = "canary-configuration-d9b4";
    const label = "canary-label-31f0";
    const fleetLabel = "canary-fleet-08bb";
    api.groups = [
      collectorGroup(),
      collectorGroup({ id: EDGE_ID, name: emptyName, isDefault: false }),
      gatewaysGroup({ name: groupName, assignedVersion: publishedVersion({ configurationName, versionLabel: label }) }),
      collectorGroup({ id: NEW_GROUP_ID, name: orphanName, isDefault: false, assignedPublishedVersionId: PUBLISHED_VERSION_ID }),
    ];
    serve();
    vi.mocked(apiClient.getConfigurations).mockResolvedValue({ items: [{ ...CHECKOUT, name: configurationName }], nextCursor: null });
    vi.mocked(apiClient.getConfigurationVersions).mockResolvedValue({ versions: [configurationVersionListItem({ label })] });
    const user = renderTab(fleetDetail({ label: fleetLabel }));
    await screen.findByText(groupName);
    expect(screen.getByRole("table")).toHaveTextContent(configurationName);
    const canaries = [groupName, emptyName, orphanName, configurationName, label, fleetLabel];
    for (const text of canaries) expectNoAttributeHolds(text);
    // Each Nothing assigned (Default's and the empty group's) and gateways' published version (its full text: D17c-1 decision 46).
    for (const text of canaries) expect(await expectNoAttributeHoldsInOpenTooltips(text, screen.getByRole("table"))).toBe(3);
    // The disabled Install's reason (Default's, the empty group's and the deleted configuration's: D17c-1 decision 44,
    // Ruling 61), its wrapper a role="button" (Ruling 52), which TOOLTIP_TRIGGERS leaves out: opened here, the fifth to
    // the seventh tooltips.
    const disabledInstalls = [...screen.getByRole("table").querySelectorAll<HTMLElement>('[role="button"][aria-disabled="true"]')];
    expect(disabledInstalls).toHaveLength(3);
    for (const wrapper of disabledInstalls) {
      act(() => wrapper.focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent(/^(Assign a published version first\.|This group's published version belongs to a deleted configuration\. Assign another first\.)$/);
      for (const text of canaries) expectNoAttributeHolds(text);
      act(() => wrapper.blur());
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    }
    // A row's Install is named through aria-labelledby, never an attribute holding the name.
    expect(button(`Install into ${groupName}`)).toBeEnabled();
    expect(screen.getByRole("button", { name: `Install into ${orphanName}` })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: `Install into ${emptyName}` })).toHaveAttribute("aria-disabled", "true");

    // Each dialog open; the group dialog's Name input's value is the named exception.
    const nameInputOnly = (text: string) => {
      const holders: string[] = [];
      for (const element of [document.documentElement, ...document.documentElement.querySelectorAll("*")]) {
        for (const attribute of element.attributes) {
          if (!attribute.value.includes(text)) continue;
          if (attribute.name === "value" && element === screen.queryByRole("textbox", { name: "Name", hidden: true })) continue;
          holders.push(`${element.tagName} ${attribute.name}`);
        }
      }
      return holders;
    };
    for (const opener of [`More about ${groupName}`, `Edit ${groupName}`, `Delete ${groupName}`, `Assign ${emptyName}`, `Edit ${orphanName}`, "New group"]) {
      await user.click(button(opener));
      const dialog = await screen.findByRole(opener.startsWith("Delete") ? "alertdialog" : "dialog");
      if (opener === `Edit ${groupName}`) {
        await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Version" })).toHaveTextContent("@v4"));
        expect(dialog).toHaveTextContent(configurationName);
        await user.click(within(dialog).getByRole("combobox", { name: "Version" }));
        expect(await screen.findByRole("option", { name: new RegExp(label) })).toBeInTheDocument();
        for (const text of canaries) expect(nameInputOnly(text), text).toEqual([]);
        await user.keyboard("{Escape}");
      }
      for (const text of canaries) expect(nameInputOnly(text), text).toEqual([]);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    }
  });
});

describe("GroupsTab after a mounts save refused for mounts changed elsewhere (D17c-1 Rulings 61 and 64)", () => {
  it("reads the groups again at the refusal, so closing and reopening shows the mounts saved meanwhile, and that save goes through", async () => {
    api.groups = [collectorGroup(), gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT]) })];
    const calls = serve();
    const user = renderTab();
    await screen.findByText("gateways");
    // Another member saves a second mount; the tab hasn't polled.
    api.groups = [collectorGroup(), gatewaysGroup({ annotations: mountsAnnotations([NGINX_MOUNT, DATA_MOUNT]) })];
    const hostPaths = () => screen.queryAllByRole("textbox", { name: "Host path" });
    const containerPaths = () => screen.queryAllByRole("textbox", { name: "Container path" });
    async function addAndSave() {
      await user.click(screen.getByRole("button", { name: "Add mount" }));
      await user.type(hostPaths().at(-1)!, "/var/log/app");
      await user.type(containerPaths().at(-1)!, "/var/log/app");
      await user.click(screen.getByRole("button", { name: "Save" }));
    }
    await user.click(button("Edit gateways"));
    await screen.findByRole("dialog");
    await addAndSave();
    expect(await screen.findByText(MOUNTS_CHANGED_MESSAGE)).toBeInTheDocument();
    expect(calls.updateCollectorGroup).not.toHaveBeenCalled();
    // The tab's re-read (after the save's own read) answers before the reopening.
    await waitFor(() => expect(calls.getCollectorGroups).toHaveBeenCalledTimes(3));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(button("Edit gateways"));
    await screen.findByRole("dialog");
    expect(hostPaths().map((each) => (each as HTMLInputElement).value)).toEqual(["/var/log/nginx", "/srv/data"]);
    await addAndSave();
    await waitFor(() => expect(calls.updateCollectorGroup).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(MOUNTS_CHANGED_MESSAGE)).toBeNull();
  });
});
