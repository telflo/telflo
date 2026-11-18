import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type Collector, type CollectorGroup, type CollectorsPage, type FleetDetail } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, type CollectorsQuery } from "~/lib/api-client.js";
import { FLEETS_POLL_INTERVAL_MS } from "~/lib/fleets.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import {
  collector,
  collectorGroup,
  DEFAULT_GROUP_ID,
  EMPTY_SUMMARY,
  expectNoAttributeHolds,
  expectNoAttributeHoldsInOpenTooltips,
  fleetDetail,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  kubernetesAnnotations,
  kubernetesGroups,
  manyCollectors,
  SECOND_GATEWAY_GROUP_ID,
  serveNoVariables,
} from "~/test/fleets.js";
import { COLLECTOR_NOT_FOUND_MESSAGE } from "./CollectorDetailsDialog.js";
import { CollectorsTab, KUBERNETES_NOT_SHOWING_UP_TIPS, KUBERNETES_WAITING_DETAIL } from "./CollectorsTab.js";
import { KUBERNETES_PIN_NOTE } from "./EditCollectorDialog.js";

// A server fleet's Collectors tab (D17b-1 decisions 2, 3, 21, 27 and 29;
// Preflight rulings 9, 10 and 17) over the real page hook, the browser
// client's calls answered by a small fake of the API's list: the search on
// Enter, the count with Prev disabled on page 1, the no-match state, the
// install-first empty state and the waiting state with its help (D17c-1
// decision 44).

const GONE = () => new ApiError("fleet_not_found", "Fleet not found.", { status: 404 });
const UNAVAILABLE = () => new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });

/** What the fake API holds: the fleet's collectors in its order, and its groups. */
interface Api {
  rows: Collector[];
  groups: CollectorGroup[];
  /** Fails the next page reads with these, one each. */
  failures: unknown[];
  /** Fails the groups reads while set. */
  groupsFailure: unknown;
  /** Holds every page read until released. */
  hold: Promise<void> | null;
}

let api: Api;

/** The API's list over `api`: `q` on names and addresses, `groupId`, `sort` and `order`, 50 a page, the cursor an offset. */
function pageOf(query: CollectorsQuery): CollectorsPage {
  let rows = api.rows;
  if (query.q !== undefined) {
    const q = query.q;
    rows = rows.filter((row) => [row.name, row.reported.ip, row.reported.hostIp].some((text) => text?.includes(q)));
  }
  if (query.groupId !== undefined) rows = rows.filter((row) => row.groupId === query.groupId);
  if (query.sort !== undefined) {
    const key = (row: Collector) => (query.sort === "name" ? row.name : row.lastSeenAt);
    rows = [...rows].sort((a, b) => key(a).localeCompare(key(b)) * (query.order === "desc" ? -1 : 1));
  }
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  const limit = query.limit ?? 50;
  return { collectors: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null };
}

function serve() {
  serveNoVariables();
  const getCollectors = vi.spyOn(apiClient, "getCollectors").mockImplementation(async (_organizationId, _fleetId, query = {}) => {
    if (api.hold !== null) await api.hold;
    const failure = api.failures.shift();
    if (failure !== undefined) throw failure;
    return pageOf(query);
  });
  const getCollectorGroups = vi.spyOn(apiClient, "getCollectorGroups").mockImplementation(async () => {
    if (api.groupsFailure !== null) throw api.groupsFailure;
    return { groups: api.groups };
  });
  return { getCollectors, getCollectorGroups };
}

/** The query of the latest page read. */
function lastQuery(spy: ReturnType<typeof serve>["getCollectors"]): CollectorsQuery {
  return spy.mock.calls.at(-1)![2] as CollectorsQuery;
}

const onFleetGone = vi.fn();
const onFleetChanged = vi.fn();
const onInstall = vi.fn();

function renderTab(
  fleet: FleetDetail = fleetDetail({ summary: { ...EMPTY_SUMMARY, collectors: api.rows.length } }),
  { installStarted = false }: { installStarted?: boolean } = {},
) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <CollectorsTab
          fleet={fleet}
          installStarted={installStarted}
          onInstall={onInstall}
          onFleetGone={onFleetGone}
          onFleetChanged={onFleetChanged}
        />
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
  return userEvent.setup();
}

async function poll(): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
}

const pagerText = () => screen.getByText(/^Showing /).textContent;
const prev = () => screen.getByRole("button", { name: "Prev" });
const next = () => screen.getByRole("button", { name: "Next" });
const searchBox = () => screen.getByRole("searchbox", { name: "Search collectors" });
const filter = () => screen.getByRole("combobox", { name: "Filter by group" });
/** Refresh's icon: it spins while a person's read is under way. */
const refreshIcon = () => screen.getByRole("button", { name: "Refresh collectors" }).querySelector("svg");
const checkbox = (name: string) => screen.getByRole("checkbox", { name });
const names = () => screen.getAllByTitle("View collector details").map((each) => each.textContent);

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(searchBox());
  await user.type(searchBox(), `${text}{Enter}`);
}

async function chooseGroup(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(filter());
  await user.click(await screen.findByRole("option", { name }));
}

/** The collectors given, moved to the gateways group. */
function inGateways(rows: Collector[]): Collector[] {
  return rows.map((row) => ({ ...row, groupId: GATEWAYS_GROUP_ID }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  onFleetGone.mockClear();
  onFleetChanged.mockClear();
  onInstall.mockClear();
  api = { rows: [], groups: [collectorGroup(), gatewaysGroup()], failures: [], groupsFailure: null, hold: null };
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

describe("CollectorsTab's states (decision 21)", () => {
  it('shows "Loading collectors…" until the first page answers', async () => {
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    api.rows = manyCollectors(2);
    serve();
    renderTab();
    expect(await screen.findByText("Loading collectors…")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    api.hold = null;
    release();
    expect(await screen.findByRole("button", { name: "collector-001" })).toBeInTheDocument();
    expect(screen.queryByText("Loading collectors…")).toBeNull();
  });

  it("shows a failed first load with Try again, which reads again", async () => {
    api.rows = manyCollectors(2);
    api.failures = [UNAVAILABLE()];
    const { getCollectors } = serve();
    const user = renderTab();
    expect(await screen.findByText("Failed to load collectors")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "collector-001" })).toBeInTheDocument();
    expect(getCollectors).toHaveBeenCalledTimes(2);
  });

  // D17c-1 decision 44.
  it("shows an empty fleet the install state before an install, with Install collector, no table and no pager", async () => {
    serve();
    const user = renderTab();
    expect(await screen.findByText("Install your first collector")).toBeInTheDocument();
    expect(screen.getByText("Run one copy-paste command on a host; the collector connects with this fleet's token and appears here.")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for your first collector to connect")).toBeNull();
    expect(screen.queryByRole("button", { name: "Collector not showing up?" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/^Showing /)).toBeNull();

    const install = screen.getByRole("button", { name: "Install collector" });
    await user.click(install);
    expect(onInstall).toHaveBeenCalledWith(install);
  });

  it("shows the waiting state once installing started, the same Install collector, and the help", async () => {
    serve();
    const user = renderTab(undefined, { installStarted: true });
    expect(await screen.findByText("Waiting for your first collector to connect")).toBeInTheDocument();
    expect(screen.getByText("It appears here the moment it checks in. This list refreshes automatically every 15 seconds.")).toBeInTheDocument();
    expect(screen.queryByText("Install your first collector")).toBeNull();
    expect(screen.getByRole("button", { name: "Install collector" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collector not showing up?" }));
    const help = await screen.findByRole("dialog");
    expect(within(help).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "The host must reach the endpoint shown in the install command.",
      "Linux: export OPAMP_TOKEN before running start_supervisor.sh (copy it again from the install dialog).",
      "Container: docker logs telflo-collector shows the supervisor's output.",
      "A command naming a group that has since been deleted is refused: copy a new one.",
      "Re-installing on a container host: remove the old container first (docker rm -f telflo-collector); keep the telflo-opamp volume to keep the same collector.",
    ]);
    // No endpoint: the tab can't know it (Preflight ruling 22).
    expect(help.textContent).not.toMatch(/https?:|wss?:/);
  });

  it("keeps the focus on Install collector as installing starts: one element across both states", async () => {
    serve();
    function Harness() {
      const [started, setStarted] = useState(false);
      return (
        <CollectorsTab
          fleet={fleetDetail()}
          installStarted={started}
          onInstall={() => setStarted(true)}
          onFleetGone={onFleetGone}
          onFleetChanged={onFleetChanged}
        />
      );
    }
    const Stub = createRoutesStub([{ path: "/", Component: Harness }]);
    render(<Stub initialEntries={["/"]} />);
    const user = userEvent.setup();
    const install = await screen.findByRole("button", { name: "Install collector" });
    await user.click(install);
    expect(await screen.findByText("Waiting for your first collector to connect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install collector" })).toBe(install);
    expect(document.activeElement).toBe(install);
  });

  it("says an archived fleet's collectors are installed once it is unarchived, with no Install collector", async () => {
    serve();
    renderTab(fleetDetail({ status: "archived" }));
    expect(await screen.findByText("This fleet is archived: unarchive it to install collectors.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();
    expect(screen.queryByText("Install your first collector")).toBeNull();
    expect(screen.queryByText("Waiting for your first collector to connect")).toBeNull();
  });

  it("shows a search matching nothing as no match, never the install state", async () => {
    api.rows = manyCollectors(3);
    serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });

    await search(user, "zzz");
    expect(await screen.findByText("No collectors match “zzz”.")).toBeInTheDocument();
    expect(screen.queryByText("Install your first collector")).toBeNull();
    expect(screen.queryByText(/^Showing /)).toBeNull();
  });

  it("shows a group with none as such, never the install state", async () => {
    api.rows = manyCollectors(3);
    serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });

    await chooseGroup(user, "gateways");
    expect(await screen.findByText("No collectors in this group.")).toBeInTheDocument();
    expect(screen.queryByText("Install your first collector")).toBeNull();
  });

  it('calls onFleetGone on a fleet found gone, with no toast and no failed state', async () => {
    api.failures = [GONE()];
    const error = vi.spyOn(toast, "error");
    serve();
    renderTab();
    await waitFor(() => expect(onFleetGone).toHaveBeenCalledTimes(1));
    expect(error).not.toHaveBeenCalled();
    expect(screen.queryByText("Failed to load collectors")).toBeNull();
  });
});

describe("CollectorsTab's pager (decision 2)", () => {
  it("shows the count of the summary with Prev and Next, Prev disabled on page 1 and Next on the last", async () => {
    api.rows = manyCollectors(120);
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });

    expect(pagerText()).toBe("Showing 1–50 of 120");
    expect(prev()).toBeDisabled();
    expect(next()).toBeEnabled();

    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 120"));
    expect(lastQuery(getCollectors).cursor).toBe("50");
    expect(prev()).toBeEnabled();
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 101–120 of 120"));
    expect(next()).toBeDisabled();
    expect(names()).toHaveLength(20);

    await user.click(prev());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 120"));
    expect(names()[0]).toBe("collector-051");
  });

  it("never shows a total below the rows shown", async () => {
    api.rows = manyCollectors(120);
    serve();
    const user = renderTab(fleetDetail({ summary: { ...EMPTY_SUMMARY, collectors: 100 } }));
    await screen.findByRole("button", { name: "collector-001" });
    expect(pagerText()).toBe("Showing 1–50 of 100");
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 100"));
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 101–120 of 120"));
  });

  it("shows no total while searched or filtered (the API counts nothing)", async () => {
    api.rows = [...manyCollectors(60), ...inGateways(manyCollectors(3, 61))];
    serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });

    await search(user, "collector-0");
    await waitFor(() => expect(pagerText()).toBe("Showing 1–50"));
    await search(user, "");
    await waitFor(() => expect(pagerText()).toBe("Showing 1–50 of 63"));
    await chooseGroup(user, "gateways");
    await waitFor(() => expect(pagerText()).toBe("Showing 1–3"));
  });
});

describe("CollectorsTab's toolbar (decisions 3 and 21)", () => {
  it("searches on Enter, trimmed, from page 1; an empty box searches nothing", async () => {
    api.rows = manyCollectors(120);
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 120"));

    await user.type(searchBox(), "  collector-11  ");
    expect(getCollectors).toHaveBeenCalledTimes(2);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(names()).toEqual(manyCollectors(10, 110).map((row) => row.name)));
    expect(lastQuery(getCollectors)).toMatchObject({ q: "collector-11", cursor: undefined });

    await search(user, "   ");
    await waitFor(() => expect(pagerText()).toBe("Showing 1–50 of 120"));
    expect(lastQuery(getCollectors).q).toBeUndefined();
  });

  it("bounds the box at 100 characters, with its placeholder and name, and never writes its text into an attribute", async () => {
    serve();
    const user = renderTab();
    await screen.findByText("Install your first collector");
    expect(searchBox()).toHaveAttribute("maxlength", "100");
    expect(searchBox()).toHaveAttribute("placeholder", "Search collectors by name or IP…");

    await user.type(searchBox(), "x".repeat(120));
    expect(searchBox()).toHaveValue("x".repeat(100));
    // Uncontrolled: its value attribute stays the empty default, never the text typed.
    expect(searchBox().getAttribute("value") ?? "").toBe("");
    await user.keyboard("{Enter}");
    expect(searchBox().getAttribute("value") ?? "").toBe("");
  });

  it("refreshes the page shown as a person's read, spinning until it answers; Refresh, Prev and Next stay enabled, Prev and Next doing nothing meanwhile", async () => {
    api.rows = manyCollectors(120);
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 120"));

    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    const refresh = screen.getByRole("button", { name: "Refresh collectors" });
    await user.click(refresh);
    await waitFor(() => expect(refresh.querySelector("svg")).toHaveClass("animate-spin"));
    // Enabled, so the focus stays on the button pressed.
    expect(refresh).toBeEnabled();
    expect(document.activeElement).toBe(refresh);
    expect(prev()).toBeEnabled();
    expect(next()).toBeEnabled();
    expect(lastQuery(getCollectors).cursor).toBe("50");
    const reads = getCollectors.mock.calls.length;
    // Prev and Next do nothing while the person's read is under way.
    await user.click(prev());
    await user.click(next());
    expect(getCollectors).toHaveBeenCalledTimes(reads);
    expect(document.activeElement).toBe(next());
    // The rows stay shown meanwhile.
    expect(names()[0]).toBe("collector-051");

    api.hold = null;
    release();
    await waitFor(() => expect(refresh.querySelector("svg")).not.toHaveClass("animate-spin"));
    expect(pagerText()).toBe("Showing 51–100 of 120");
    expect(getCollectors).toHaveBeenCalledTimes(reads);
  });

  it("offers All groups and the fleet's groups in the API's order, and filters by one from page 1", async () => {
    api.rows = [...manyCollectors(60), ...inGateways(manyCollectors(2, 61))];
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–62 of 62"));
    expect(filter()).toHaveTextContent("All groups");

    await user.click(filter());
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["All groups", "Default", "gateways"]);
    await user.click(screen.getByRole("option", { name: "gateways" }));
    await waitFor(() => expect(names()).toEqual(["collector-061", "collector-062"]));
    expect(lastQuery(getCollectors)).toMatchObject({ groupId: GATEWAYS_GROUP_ID, cursor: undefined });
    expect(filter()).toHaveTextContent("gateways");

    await chooseGroup(user, "All groups");
    await waitFor(() => expect(pagerText()).toBe("Showing 1–50 of 62"));
    expect(lastQuery(getCollectors).groupId).toBeUndefined();
  });

  it("shows the group chosen while its read is under way, over the earlier filter's rows, and keeps it once they come", async () => {
    api.rows = [...manyCollectors(2), ...inGateways(manyCollectors(1, 3))];
    serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });

    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    await chooseGroup(user, "gateways");
    await waitFor(() => expect(refreshIcon()).toHaveClass("animate-spin"));
    expect(filter()).toHaveTextContent("gateways");
    expect(names()).toEqual(["collector-001", "collector-002", "collector-003"]);

    api.hold = null;
    release();
    await waitFor(() => expect(names()).toEqual(["collector-003"]));
    expect(refreshIcon()).not.toHaveClass("animate-spin");
    expect(filter()).toHaveTextContent("gateways");
  });

  it("shows the second of two groups picked during one held read until its read settles, then the rows' own", async () => {
    api.rows = [...manyCollectors(2), ...inGateways(manyCollectors(1, 3))];
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });

    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    await chooseGroup(user, "gateways");
    await waitFor(() => expect(refreshIcon()).toHaveClass("animate-spin"));
    await chooseGroup(user, "Default");
    // The second pick shows, not the first, while both reads are held.
    expect(filter()).toHaveTextContent("Default");
    expect(lastQuery(getCollectors).groupId).toBe(DEFAULT_GROUP_ID);
    expect(names()).toEqual(["collector-001", "collector-002", "collector-003"]);

    api.hold = null;
    release();
    await waitFor(() => expect(names()).toEqual(["collector-001", "collector-002"]));
    expect(refreshIcon()).not.toHaveClass("animate-spin");
    expect(filter()).toHaveTextContent("Default");
  });

  it("returns the filter to the rows' own when the chosen group's read fails", async () => {
    api.rows = [...manyCollectors(2), ...inGateways(manyCollectors(1, 3))];
    serve();
    const error = vi.spyOn(toast, "error");
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });

    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    api.failures = [UNAVAILABLE()];
    await chooseGroup(user, "gateways");
    await waitFor(() => expect(refreshIcon()).toHaveClass("animate-spin"));
    expect(filter()).toHaveTextContent("gateways");

    api.hold = null;
    release();
    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to load collectors"));
    await waitFor(() => expect(filter()).toHaveTextContent("All groups"));
    expect(names()).toEqual(["collector-001", "collector-002", "collector-003"]);
  });

  it("disables the filter, and shows a dash for each Group, while the groups can't be read", async () => {
    api.rows = manyCollectors(2);
    api.groupsFailure = UNAVAILABLE();
    serve();
    renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    expect(filter()).toBeDisabled();
    const groupColumn = screen.getAllByRole("columnheader").findIndex((header) => header.textContent === "Group");
    const row = screen.getByRole("button", { name: "collector-001" }).closest("tr") as HTMLElement;
    expect(within(row).getAllByRole("cell")[groupColumn]).toHaveTextContent(/^—$/);

    api.groupsFailure = null;
    await poll();
    await waitFor(() => expect(filter()).toBeEnabled());
    expect(within(row).getAllByRole("cell")[groupColumn]).toHaveTextContent(/^Default$/);
  });

  it("goes back to All groups when a poll finds the filtered group gone", async () => {
    api.rows = [...manyCollectors(2), ...inGateways(manyCollectors(1, 3))];
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    await chooseGroup(user, "gateways");
    await waitFor(() => expect(names()).toEqual(["collector-003"]));

    api.groups = [collectorGroup()];
    api.rows = api.rows.map((row) => ({ ...row, groupId: collectorGroup().id }));
    await poll();
    await waitFor(() => expect(filter()).toHaveTextContent("All groups"));
    expect(names()).toEqual(["collector-001", "collector-002", "collector-003"]);
    expect(lastQuery(getCollectors).groupId).toBeUndefined();
    expect(pagerText()).toBe("Showing 1–3 of 3");
  });
});

describe("CollectorsTab's sorting (decision 21)", () => {
  it("sorts by Name ascending first, then alternates, from page 1; Last seen likewise; the sorted header's aria-sort follows", async () => {
    api.rows = manyCollectors(120).reverse();
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-120" });
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 120"));
    const header = (name: string) => screen.getByRole("button", { name }).closest("th") as HTMLElement;
    expect(header("Name")).not.toHaveAttribute("aria-sort");

    await user.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(names()[0]).toBe("collector-001"));
    expect(lastQuery(getCollectors)).toMatchObject({ sort: "name", order: "asc", cursor: undefined });
    expect(pagerText()).toBe("Showing 1–50 of 120");
    expect(header("Name")).toHaveAttribute("aria-sort", "ascending");

    await user.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(names()[0]).toBe("collector-120"));
    expect(lastQuery(getCollectors)).toMatchObject({ sort: "name", order: "desc" });
    expect(header("Name")).toHaveAttribute("aria-sort", "descending");

    await user.click(screen.getByRole("button", { name: "Last seen" }));
    await waitFor(() => expect(lastQuery(getCollectors)).toMatchObject({ sort: "lastSeen", order: "asc" }));
    await waitFor(() => expect(header("Last seen")).toHaveAttribute("aria-sort", "ascending"));
    expect(header("Name")).not.toHaveAttribute("aria-sort");
  });
});

describe("CollectorsTab's poll (decision 10)", () => {
  it("re-reads the page shown with its cursor and query every 15 s, and a row follows", async () => {
    api.rows = manyCollectors(60);
    const { getCollectors } = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–60 of 60"));
    const reads = getCollectors.mock.calls.length;
    expect(screen.queryByText("Apply failed")).toBeNull();

    api.rows = api.rows.map((row) => (row.name === "collector-052" ? { ...row, drift: "failed", liveness: "offline" } : row));
    await poll();
    expect(await screen.findByText("Apply failed")).toBeInTheDocument();
    expect(getCollectors).toHaveBeenCalledTimes(reads + 1);
    expect(lastQuery(getCollectors).cursor).toBe("50");
  });
});

describe("CollectorsTab's selection (decision 27)", () => {
  async function loadedWithSelection(rows: Collector[] = manyCollectors(120)) {
    api.rows = rows;
    const served = serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    await user.click(checkbox("Select collector-001"));
    await user.click(checkbox("Select collector-002"));
    expect(checkbox("Select collector-001")).toBeChecked();
    expect(checkbox("Select all on this page")).toHaveAttribute("aria-checked", "mixed");
    return { ...served, user };
  }

  it("is kept across a poll for the rows still shown, and drops a row gone", async () => {
    await loadedWithSelection();
    api.rows = api.rows.filter((row) => row.name !== "collector-002");
    await poll();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    expect(checkbox("Select collector-001")).toBeChecked();
    expect(checkbox("Select collector-003")).not.toBeChecked();

    // Back on a later poll, the row gone meanwhile isn't selected again.
    api.rows = manyCollectors(120);
    await poll();
    await screen.findByRole("button", { name: "collector-002" });
    expect(checkbox("Select collector-002")).not.toBeChecked();
    expect(checkbox("Select collector-001")).toBeChecked();
  });

  it("selects every row on the page from the header, and none again", async () => {
    const { user } = await loadedWithSelection();
    await user.click(checkbox("Select all on this page"));
    expect(checkbox("Select all on this page")).toBeChecked();
    expect(checkbox("Select collector-050")).toBeChecked();
    await user.click(checkbox("Select all on this page"));
    expect(checkbox("Select collector-001")).not.toBeChecked();
  });

  it("is cleared by a page change, both ways", async () => {
    const { user } = await loadedWithSelection();
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 120"));
    expect(screen.getAllByRole("checkbox").filter((each) => each.getAttribute("aria-checked") !== "false")).toEqual([]);
    await user.click(checkbox("Select collector-051"));
    await user.click(prev());
    await waitFor(() => expect(pagerText()).toBe("Showing 1–50 of 120"));
    expect(checkbox("Select collector-001")).not.toBeChecked();
    expect(checkbox("Select all on this page")).not.toBeChecked();
  });

  // A collector enrolled meanwhile shifts the newest-first list: page 2 starts with page 1's last row.
  it("is cleared by a page change even for a row the new page shows again", async () => {
    const { user } = await loadedWithSelection();
    await user.click(checkbox("Select collector-050"));
    api.rows = [collector({ id: "00000000-0000-4000-9000-0000000000ff", name: "collector-new" }), ...api.rows];
    await user.click(next());
    await waitFor(() => expect(pagerText()).toBe("Showing 51–100 of 120"));
    expect(names()[0]).toBe("collector-050");
    expect(checkbox("Select collector-050")).not.toBeChecked();
    expect(checkbox("Select all on this page")).not.toBeChecked();
  });

  it("is cleared by a search", async () => {
    const { user } = await loadedWithSelection();
    await search(user, "collector-00");
    await waitFor(() => expect(pagerText()).toBe("Showing 1–9"));
    expect(checkbox("Select collector-001")).not.toBeChecked();
  });

  it("is cleared by a filter", async () => {
    const { user } = await loadedWithSelection();
    await chooseGroup(user, "Default");
    await waitFor(() => expect(lastQuery(vi.mocked(apiClient.getCollectors)).groupId).toBeDefined());
    await waitFor(() => expect(checkbox("Select collector-001")).not.toBeChecked());
  });

  it("is cleared by a sort", async () => {
    const { user } = await loadedWithSelection();
    await user.click(screen.getByRole("button", { name: "Name" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Name" }).closest("th")).toHaveAttribute("aria-sort", "ascending"));
    expect(checkbox("Select collector-001")).not.toBeChecked();
    expect(checkbox("Select collector-002")).not.toBeChecked();
  });

  it("is kept when a person's read fails over the rows shown", async () => {
    vi.spyOn(toast, "error");
    const { user } = await loadedWithSelection();
    api.failures = [UNAVAILABLE()];
    await user.click(next());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to load collectors"));
    expect(pagerText()).toBe("Showing 1–50 of 120");
    expect(checkbox("Select collector-001")).toBeChecked();
  });
});

describe("CollectorsTab's details (decision 24; Preflight ruling 17)", () => {
  /** The details' reads: the collector as the fake holds it, the tokens and no errors. */
  function serveDetails() {
    return {
      getCollector: vi.spyOn(apiClient, "getCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
        const found = api.rows.find((row) => row.id === collectorId);
        if (found === undefined) throw new ApiError("collector_not_found", "Collector not found.", { status: 404 });
        return found;
      }),
      getEnrollmentTokens: vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [] }),
      getCollectorErrors: vi.spyOn(apiClient, "getCollectorErrors").mockResolvedValue({ errors: [], nextCursor: null }),
    };
  }

  it("opens a row's details from its Name, refreshed from the collector's read, and pauses the polls while open", async () => {
    api.rows = manyCollectors(3);
    const { getCollectors } = serve();
    const details = serveDetails();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "collector-002" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "collector-002" })).toBeInTheDocument();
    expect(within(dialog).getByText("Collector details")).toBeInTheDocument();
    expect(details.getCollector).toHaveBeenCalledWith(GROUP_ID, api.rows[1]!.fleetId, api.rows[1]!.id, expect.anything());
    expect(await within(dialog).findByText("No errors reported.")).toBeInTheDocument();

    const reads = getCollectors.mock.calls.length;
    await poll();
    expect(getCollectors).toHaveBeenCalledTimes(reads);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await poll();
    expect(getCollectors).toHaveBeenCalledTimes(reads + 1);
  });

  it('toasts "Collector not found", closes the details and reloads the grid and the fleet when the refresh finds it gone', async () => {
    api.rows = manyCollectors(3);
    const { getCollectors } = serve();
    serveDetails();
    const error = vi.spyOn(toast, "error");
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-002" });
    const reads = getCollectors.mock.calls.length;
    // Deleted elsewhere after the page was read.
    api.rows = api.rows.filter((row) => row.name !== "collector-002");

    await user.click(screen.getByRole("button", { name: "collector-002" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(error).toHaveBeenCalledWith(COLLECTOR_NOT_FOUND_MESSAGE);
    await waitFor(() => expect(getCollectors).toHaveBeenCalledTimes(reads + 1));
    // The route reads the fleet again too: the strip and the total follow.
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
  });

  it("closes the details when the organization changes", async () => {
    api.rows = manyCollectors(3);
    serve();
    serveDetails();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "collector-001" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("CollectorsTab's edit and delete (decisions 26 and 28; Preflight rulings 8 and 17)", () => {
  /** The edit's opening reads, the update (a rename the fake then holds) and the delete (the row gone). */
  function serveWrites() {
    return {
      getConfigurations: vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [], nextCursor: null }),
      updateCollector: vi.spyOn(apiClient, "updateCollector").mockImplementation(async (_organizationId, _fleetId, collectorId, request) => {
        const index = api.rows.findIndex((row) => row.id === collectorId);
        api.rows[index] = { ...api.rows[index]!, ...(request.name === undefined ? {} : { name: request.name }) };
        return api.rows[index]!;
      }),
      deleteCollector: vi.spyOn(apiClient, "deleteCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
        api.rows = api.rows.filter((row) => row.id !== collectorId);
        return undefined;
      }),
    };
  }

  it("edits a row from its Edit button, then reloads the page and the fleet", async () => {
    api.rows = manyCollectors(3);
    const { getCollectors, getCollectorGroups } = serve();
    const writes = serveWrites();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Edit collector-002" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit collector" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("collector-002");
    // The tab's groups: the dialog reads none itself.
    expect(within(dialog).getByRole("combobox", { name: "Group" })).toHaveTextContent("Default");
    const groupReads = getCollectorGroups.mock.calls.length;
    const reads = getCollectors.mock.calls.length;
    await user.clear(name);
    await user.type(name, "collector-two");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes.updateCollector).toHaveBeenCalledWith(GROUP_ID, api.rows[1]!.fleetId, api.rows[1]!.id, { name: "collector-two" }, expect.anything());
    await waitFor(() => expect(getCollectors).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    expect(getCollectorGroups.mock.calls.length).toBeGreaterThan(groupReads);
    expect(await screen.findByRole("button", { name: "collector-two" })).toBeInTheDocument();
  });

  it("deletes a row from its Delete button, then reloads the page and the fleet", async () => {
    api.rows = manyCollectors(3);
    const { getCollectors } = serve();
    const writes = serveWrites();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Delete collector-002" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    expect(dialog).toHaveTextContent("You are deleting the record of collector-002.");
    const reads = getCollectors.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(writes.deleteCollector).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getCollectors).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
  });

  it('opens the edit from the details\' "Edit collector", the details closed', async () => {
    api.rows = manyCollectors(3);
    serve();
    serveWrites();
    vi.spyOn(apiClient, "getCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => api.rows.find((row) => row.id === collectorId)!);
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [] });
    vi.spyOn(apiClient, "getCollectorErrors").mockResolvedValue({ errors: [], nextCursor: null });
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "collector-003" }));
    const details = await screen.findByRole("dialog", { name: "collector-003" });

    await user.click(within(details).getByRole("button", { name: "Edit collector" }));

    const edit = await screen.findByRole("dialog", { name: "Edit collector" });
    expect(within(edit).getByRole("textbox", { name: "Name" })).toHaveValue("collector-003");
    expect(screen.queryByRole("dialog", { name: "collector-003" })).toBeNull();
    expect(onFleetChanged).not.toHaveBeenCalled();
  });

  it("pauses the polls while the edit is open", async () => {
    api.rows = manyCollectors(3);
    const { getCollectors } = serve();
    serveWrites();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Edit collector-001" }));
    await screen.findByRole("dialog", { name: "Edit collector" });
    const reads = getCollectors.mock.calls.length;
    await poll();
    expect(getCollectors).toHaveBeenCalledTimes(reads);
  });

  it.each([
    ["the edit", "Edit collector-001", "dialog"],
    ["the delete", "Delete collector-001", "alertdialog"],
  ] as const)("closes %s when the organization changes", async (_which, button, role) => {
    api.rows = manyCollectors(3);
    serve();
    serveWrites();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: button }));
    expect(await screen.findByRole(role)).toBeInTheDocument();

    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
  });
});

describe("CollectorsTab's selection bar and bulk actions (decision 27; Preflight rulings 5 and 13)", () => {
  /** The bulk dialogs' calls over the fake: the pin's reads, the pin, a move (the row's group) and a delete (the row gone). */
  function serveBulk() {
    return {
      getConfigurations: vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [], nextCursor: null }),
      pinCollectors: vi.spyOn(apiClient, "pinCollectors").mockImplementation(async (_organizationId, _fleetId, request) => ({
        updated: request.collectorIds,
        notFound: [],
      })),
      updateCollector: vi.spyOn(apiClient, "updateCollector").mockImplementation(async (_organizationId, _fleetId, collectorId, request) => {
        const index = api.rows.findIndex((row) => row.id === collectorId);
        api.rows[index] = { ...api.rows[index]!, ...(request.groupId === undefined ? {} : { groupId: request.groupId }) };
        return api.rows[index]!;
      }),
      deleteCollector: vi.spyOn(apiClient, "deleteCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
        api.rows = api.rows.filter((row) => row.id !== collectorId);
        return undefined;
      }),
    };
  }

  /** The tab loaded with collector-001 and collector-002 selected. */
  async function selectTwo(rows: Collector[] = manyCollectors(3)) {
    api.rows = rows;
    const served = serve();
    const bulk = serveBulk();
    const user = renderTab();
    await screen.findByRole("button", { name: rows[0]!.name });
    await user.click(checkbox(`Select ${rows[0]!.name}`));
    await user.click(checkbox(`Select ${rows[1]!.name}`));
    return { ...served, ...bulk, user };
  }

  const bar = () => screen.getByText(/^\d+ selected$/).parentElement!;

  it('shows no bar without a selection; with one, "{n} selected", Pin, Move to group, Delete and Clear selection, which clears it', async () => {
    api.rows = manyCollectors(3);
    serve();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    expect(screen.queryByText(/selected$/)).toBeNull();

    await user.click(checkbox("Select collector-001"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(checkbox("Select collector-003"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    for (const name of ["Pin selected collectors", "Move to group", "Delete selected collectors", "Clear selection"]) {
      expect(within(bar()).getByRole("button", { name })).toBeEnabled();
    }
    // Pin and Delete read as before; their fixed names set them apart from the rows' and the dialogs' buttons.
    expect(within(bar()).getByRole("button", { name: "Pin selected collectors" })).toHaveTextContent(/^Pin$/);
    expect(within(bar()).getByRole("button", { name: "Delete selected collectors" })).toHaveTextContent(/^Delete$/);
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText(/selected$/)).toBeNull();
    expect(checkbox("Select collector-001")).not.toBeChecked();
    expect(checkbox("Select all on this page")).not.toBeChecked();
  });

  it("pins the selection from the bar in one request, then reloads the page and the fleet", async () => {
    const { user, getCollectors, pinCollectors } = await selectTwo();
    await user.click(within(bar()).getByRole("button", { name: "Pin selected collectors" }));
    const dialog = await screen.findByRole("dialog", { name: "Pin collectors" });
    const reads = getCollectors.mock.calls.length;

    await user.click(within(dialog).getByRole("combobox", { name: "Published version" }));
    await user.click(await screen.findByRole("option", { name: "Follow each collector's group" }));
    await user.click(within(dialog).getByRole("button", { name: "Pin 2" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pinCollectors).toHaveBeenCalledWith(GROUP_ID, api.rows[0]!.fleetId, { collectorIds: [api.rows[0]!.id, api.rows[1]!.id], pin: null }, expect.anything());
    await waitFor(() => expect(getCollectors).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
  });

  it("moves the selection from the bar one at a time, and once closed reloads the page and the fleet", async () => {
    const { user, getCollectors, updateCollector } = await selectTwo();
    await user.click(within(bar()).getByRole("button", { name: "Move to group" }));
    const dialog = await screen.findByRole("dialog", { name: "Move collectors" });
    await user.click(within(dialog).getByRole("combobox", { name: "Group" }));
    await user.click(await screen.findByRole("option", { name: "gateways" }));
    await user.click(within(dialog).getByRole("button", { name: "Move 2" }));

    expect(await within(dialog).findByText("Moved 2")).toBeInTheDocument();
    expect(updateCollector.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [api.rows[0]!.id, { groupId: GATEWAYS_GROUP_ID }],
      [api.rows[1]!.id, { groupId: GATEWAYS_GROUP_ID }],
    ]);
    const reads = getCollectors.mock.calls.length;
    expect(onFleetChanged).not.toHaveBeenCalled();

    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(getCollectors).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    // The rows moved stay selected: the page and the query are the same.
    expect(checkbox("Select collector-001")).toBeChecked();
  });

  it("deletes the selection from the bar one at a time; once closed the page reloads, the rows and their selection gone", async () => {
    const { user, getCollectors, deleteCollector } = await selectTwo();
    await user.click(within(bar()).getByRole("button", { name: "Delete selected collectors" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collectors" });
    expect(dialog).toHaveTextContent("You are deleting the records of 2 collectors.");
    await user.click(within(dialog).getByRole("button", { name: "Delete 2" }));

    expect(await within(dialog).findByText("Deleted 2")).toBeInTheDocument();
    expect(deleteCollector).toHaveBeenCalledTimes(2);
    const reads = getCollectors.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(getCollectors).toHaveBeenCalledTimes(reads + 1));
    expect(onFleetChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(names()).toEqual(["collector-003"]));
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("without the groups, disables Move to group with ruling 5's words; bulk pin's Follow the group stays allowed (D16c)", async () => {
    api.groupsFailure = UNAVAILABLE();
    const rows = manyCollectors(3);
    const { user } = await selectTwo(rows);

    expect(within(bar()).getByRole("button", { name: "Move to group" })).toBeDisabled();
    expect(within(bar()).getByText("The groups couldn't be read.")).toBeInTheDocument();

    await user.click(within(bar()).getByRole("button", { name: "Pin selected collectors" }));
    const dialog = await screen.findByRole("dialog", { name: "Pin collectors" });
    expect(dialog).not.toHaveTextContent(/couldn't be read|import/);
    await user.click(within(dialog).getByRole("combobox", { name: "Published version" }));
    expect(await screen.findByRole("option", { name: "Follow each collector's group" })).not.toHaveAttribute("aria-disabled");
  });

  it("pauses the polls while a bulk dialog is open", async () => {
    const { user, getCollectors } = await selectTwo();
    await user.click(within(bar()).getByRole("button", { name: "Delete selected collectors" }));
    await screen.findByRole("alertdialog", { name: "Delete collectors" });
    const reads = getCollectors.mock.calls.length;
    await poll();
    expect(getCollectors).toHaveBeenCalledTimes(reads);
  });

  it.each([
    ["Pin selected collectors", "dialog"],
    ["Move to group", "dialog"],
    ["Delete selected collectors", "alertdialog"],
  ] as const)("closes the %s dialog when the organization changes", async (button, role) => {
    const { user } = await selectTwo();
    await user.click(within(bar()).getByRole("button", { name: button }));
    expect(await screen.findByRole(role)).toBeInTheDocument();

    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
  });

  it("holds no collector or group name in an attribute: the bar, and each bulk dialog open (decision 32)", async () => {
    const first = "canary-collector-c051";
    const second = "canary-collector-d162";
    const groupName = "canary-group-e273";
    api.groups = [collectorGroup(), gatewaysGroup({ name: groupName })];
    const rows = manyCollectors(3);
    rows[0] = { ...rows[0]!, name: first };
    rows[1] = { ...rows[1]!, name: second, groupId: GATEWAYS_GROUP_ID };
    const { user } = await selectTwo(rows);
    const canaries = [first, second, groupName];
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    for (const text of canaries) expectNoAttributeHolds(text);

    for (const [button, role] of [["Pin selected collectors", "dialog"], ["Move to group", "dialog"], ["Delete selected collectors", "alertdialog"]] as const) {
      await user.click(within(bar()).getByRole("button", { name: button }));
      await screen.findByRole(role);
      for (const text of canaries) expectNoAttributeHolds(text);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    }
  });
});

// D17b-1's final fix wave (final review B's Major; D14b Ruling 46's pattern): no dialog here has a Radix
// trigger, so each close gives the focus back to its opener itself, else to a fallback.
describe("CollectorsTab's focus as a dialog closes", () => {
  /** Every dialog's calls over the fake: the details' reads, the edit's, the writes (as the fake holds them). */
  function serveDialogs() {
    vi.spyOn(apiClient, "getCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
      const found = api.rows.find((row) => row.id === collectorId);
      if (found === undefined) throw new ApiError("collector_not_found", "Collector not found.", { status: 404 });
      return found;
    });
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [] });
    vi.spyOn(apiClient, "getCollectorErrors").mockResolvedValue({ errors: [], nextCursor: null });
    vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(apiClient, "updateCollector").mockImplementation(async (_organizationId, _fleetId, collectorId, request) => {
      const index = api.rows.findIndex((row) => row.id === collectorId);
      api.rows[index] = {
        ...api.rows[index]!,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.groupId === undefined ? {} : { groupId: request.groupId }),
      };
      return api.rows[index]!;
    });
    vi.spyOn(apiClient, "deleteCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
      api.rows = api.rows.filter((row) => row.id !== collectorId);
      return undefined;
    });
    vi.spyOn(apiClient, "pinCollectors").mockImplementation(async (_organizationId, _fleetId, request) => ({
      updated: request.collectorIds,
      notFound: [],
    }));
  }

  /** The tab loaded with three collectors and every dialog's calls served. */
  async function loaded() {
    api.rows = manyCollectors(3);
    serve();
    serveDialogs();
    const user = renderTab();
    await screen.findByRole("button", { name: "collector-001" });
    return user;
  }

  const button = (name: string) => screen.getByRole("button", { name });
  const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
  const bar = () => screen.getByRole("region", { name: "Selected collectors" });

  it.each([
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["the X", async (user: ReturnType<typeof userEvent.setup>) => user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }))],
  ] as const)("returns to the row's Name after the details close by %s", async (_how, close) => {
    const user = await loaded();
    await user.click(button("collector-002"));
    await screen.findByRole("dialog", { name: "collector-002" });

    await close(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => button("collector-002"));
  });

  it("goes to the first row's Name when the details find their collector gone, its row gone with the reload", async () => {
    const user = await loaded();
    api.rows = api.rows.filter((row) => row.name !== "collector-002");
    await user.click(button("collector-002"));

    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    await focusIsOn(() => button("collector-001"));
  });

  it("hands the row's Name from the details to the edit they open: the edit's close returns there", async () => {
    const user = await loaded();
    await user.click(button("collector-003"));
    const details = await screen.findByRole("dialog", { name: "collector-003" });
    await user.click(within(details).getByRole("button", { name: "Edit collector" }));
    const edit = await screen.findByRole("dialog", { name: "Edit collector" });
    // The details' close leaves the focus in the edit.
    await waitFor(() => expect(edit).toContainElement(document.activeElement as HTMLElement));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => button("collector-003"));
  });

  it.each([
    ["Escape", "escape"],
    ["Cancel", "cancel"],
    ["a save", "save"],
  ] as const)("returns to the row's Edit after the edit closes by %s", async (_how, how) => {
    const user = await loaded();
    await user.click(button("Edit collector-002"));
    const dialog = await screen.findByRole("dialog", { name: "Edit collector" });
    if (how === "escape") await user.keyboard("{Escape}");
    if (how === "cancel") await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    if (how === "save") {
      const name = within(dialog).getByRole("textbox", { name: "Name" });
      await user.clear(name);
      await user.type(name, "collector-two");
      await user.click(within(dialog).getByRole("button", { name: "OK" }));
      await screen.findByRole("button", { name: "collector-two" });
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => button(how === "save" ? "Edit collector-two" : "Edit collector-002"));
  });

  it("goes to the first row's Name when the edit finds its collector gone", async () => {
    const user = await loaded();
    await user.click(button("Edit collector-001"));
    const dialog = await screen.findByRole("dialog", { name: "Edit collector" });
    vi.mocked(apiClient.updateCollector).mockImplementation(async (_organizationId, _fleetId, collectorId) => {
      api.rows = api.rows.filter((row) => row.id !== collectorId);
      throw new ApiError("collector_not_found", "Collector not found.", { status: 404 });
    });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.type(name, "x");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-001" })).toBeNull());
    await focusIsOn(() => button("collector-002"));
  });

  it.each([
    ["Escape", "escape"],
    ["Cancel", "cancel"],
  ] as const)("returns to the row's Delete after the delete closes by %s", async (_how, how) => {
    const user = await loaded();
    await user.click(button("Delete collector-002"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    if (how === "escape") await user.keyboard("{Escape}");
    else await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await focusIsOn(() => button("Delete collector-002"));
  });

  it("goes to the first row's Name after a delete, its row gone", async () => {
    const user = await loaded();
    await user.click(button("Delete collector-001"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-001" })).toBeNull());
    await focusIsOn(() => button("collector-002"));
  });

  it("moves on from the row's Delete once a reload answered after the close removes the row (D14b Ruling 52)", async () => {
    const user = await loaded();
    await user.click(button("Delete collector-002"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    // Closed, the reload held: the focus is back on the row's Delete, the row still shown.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await focusIsOn(() => button("Delete collector-002"));

    api.hold = null;
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    await focusIsOn(() => button("collector-001"));
  });

  // The review of cfaf57d: a poll's rows before the close never spend the delete's flag; its reload's do.
  it("moves on from the row's Delete when a poll sent before the delete opened answers with it, and the reload, late, removes the row", async () => {
    const user = await loaded();
    const before = [...api.rows];
    let calls = 0;
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => (releasePoll = resolve));
    let releaseReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => (releaseReload = resolve));
    vi.spyOn(apiClient, "getCollectors").mockImplementation(async (_organizationId, _fleetId, query = {}) => {
      calls += 1;
      if (calls === 1) {
        await pollGate;
        return { collectors: before, nextCursor: null };
      }
      await reloadGate;
      return pageOf(query);
    });
    await poll();
    expect(calls).toBe(1);
    await user.click(button("Delete collector-002"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    // The poll, still showing the row, answers as the delete does.
    vi.spyOn(apiClient, "deleteCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
      api.rows = api.rows.filter((row) => row.id !== collectorId);
      releasePoll();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      return undefined;
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await focusIsOn(() => button("Delete collector-002"));
    expect(calls).toBe(2);

    releaseReload();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    await focusIsOn(() => button("collector-001"));
  });

  // The review of 32f39ff: what counts is when a read began, not who asked for it: the person's own Refresh, sent before the delete, is no reload.
  it("moves on from the row's Delete when a Refresh sent before the delete opened answers with it, and the reload, late, removes the row", async () => {
    const user = await loaded();
    const before = [...api.rows];
    let calls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => (releaseRefresh = resolve));
    let releaseReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => (releaseReload = resolve));
    vi.spyOn(apiClient, "getCollectors").mockImplementation(async (_organizationId, _fleetId, query = {}) => {
      calls += 1;
      if (calls === 1) {
        await refreshGate;
        return { collectors: before, nextCursor: null };
      }
      await reloadGate;
      return pageOf(query);
    });
    await user.click(screen.getByRole("button", { name: "Refresh collectors" }));
    expect(calls).toBe(1);
    await user.click(button("Delete collector-002"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    // The Refresh, still showing the row, answers as the delete does.
    vi.spyOn(apiClient, "deleteCollector").mockImplementation(async (_organizationId, _fleetId, collectorId) => {
      api.rows = api.rows.filter((row) => row.id !== collectorId);
      releaseRefresh();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      return undefined;
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await focusIsOn(() => button("Delete collector-002"));
    expect(calls).toBe(2);

    releaseReload();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    await focusIsOn(() => button("collector-001"));
  });

  it("never moves the focus when a Refresh takes away the row an Escape (no write) went back to", async () => {
    const user = await loaded();
    await user.click(button("Delete collector-002"));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await focusIsOn(() => button("Delete collector-002"));
    act(() => (document.activeElement as HTMLElement).blur());

    // Deleted elsewhere: the Refresh's page lacks it.
    api.rows = api.rows.filter((row) => row.name !== "collector-002");
    act(() => screen.getByRole("button", { name: "Refresh collectors" }).click());
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    await act(async () => undefined);
    expect(document.activeElement).toBe(document.body);
  });

  // A browser's usual order (the hook's own test has it too): the reload's rows render before Radix's
  // deferred focus return. Here the save, its close and its reload answer inside one act, so they
  // render together; the focus return, a timeout, comes after. The write is taken with the read
  // before its reload: the reload's rows spend it, and a later poll has nothing to act on.
  it("spends an edit's write on its reload rendered before the close's focus return: a later poll taking the row away never moves the focus", async () => {
    const user = await loaded();
    await user.click(button("Edit collector-002"));
    const dialog = await screen.findByRole("dialog", { name: "Edit collector" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "collector-two");
    const ok = within(dialog).getByRole("button", { name: "OK" });
    await act(async () => {
      ok.click();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    // Closed and reloaded, the focus not yet given back.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "collector-two" })).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    // Radix's focus return, a zero timeout set as the dialog unmounted, runs before one set now.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(button("Edit collector-two"));
    act(() => (document.activeElement as HTMLElement).blur());

    // Deleted elsewhere: the next poll's page lacks it.
    api.rows = api.rows.filter((row) => row.name !== "collector-two");
    await poll();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-two" })).toBeNull());
    await act(async () => undefined);
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves the focus where the person put it when the row goes after they moved it", async () => {
    const user = await loaded();
    await user.click(button("Delete collector-002"));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    let release!: () => void;
    api.hold = new Promise((resolve) => (release = resolve));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await focusIsOn(() => button("Delete collector-002"));
    act(() => button("Edit collector-003").focus());

    api.hold = null;
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    expect(document.activeElement).toBe(button("Edit collector-003"));
  });

  // The follow-up: only a write's reload moves the focus on; a poll after a close with no write never does.
  it("never moves the focus when a poll takes away the row an Escape (no write) went back to", async () => {
    const user = await loaded();
    await user.click(button("collector-002"));
    await screen.findByRole("dialog", { name: "collector-002" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => button("collector-002"));
    act(() => (document.activeElement as HTMLElement).blur());

    // Deleted elsewhere: the next poll's page lacks it.
    api.rows = api.rows.filter((row) => row.name !== "collector-002");
    await poll();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-002" })).toBeNull());
    await act(async () => undefined);
    expect(document.activeElement).toBe(document.body);
  });

  // The last review: a dialog opened anew forgets an earlier write whose reload never rendered rows (it failed).
  it("never moves the focus when a poll takes away the row an Escape went back to, after an earlier write's reload failed", async () => {
    const user = await loaded();
    await user.click(button("Edit collector-002"));
    const dialog = await screen.findByRole("dialog", { name: "Edit collector" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "collector-two");
    // The write lands; its reload fails over the rows shown (a toast), so no rows render after it.
    api.failures.push(UNAVAILABLE());
    const error = vi.spyOn(toast, "error");
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => button("Edit collector-002"));

    await user.click(button("collector-003"));
    await screen.findByRole("dialog", { name: "collector-003" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => button("collector-003"));
    act(() => (document.activeElement as HTMLElement).blur());

    // Deleted elsewhere: the next poll's page lacks it.
    api.rows = api.rows.filter((row) => row.name !== "collector-003");
    await poll();
    await waitFor(() => expect(screen.queryByRole("button", { name: "collector-003" })).toBeNull());
    await act(async () => undefined);
    expect(document.activeElement).toBe(document.body);
  });

  it("goes to the search box after the last row is deleted", async () => {
    api.rows = manyCollectors(1);
    serve();
    serveDialogs();
    const user = renderTab();
    await user.click(await screen.findByRole("button", { name: "Delete collector-001" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await screen.findByText("Install your first collector");
    await focusIsOn(searchBox);
  });

  /** collector-001 and collector-002 selected. */
  async function selectTwo(user: ReturnType<typeof userEvent.setup>) {
    await user.click(checkbox("Select collector-001"));
    await user.click(checkbox("Select collector-002"));
  }

  it.each([
    ["Pin selected collectors", "dialog", "Pin collectors"],
    ["Move to group", "dialog", "Move collectors"],
    ["Delete selected collectors", "alertdialog", "Delete collectors"],
  ] as const)("returns to the selection bar's %s after its dialog closes by Escape and by Cancel", async (name, role, title) => {
    const user = await loaded();
    await selectTwo(user);
    for (const how of ["escape", "cancel"] as const) {
      await user.click(within(bar()).getByRole("button", { name }));
      const dialog = await screen.findByRole(role, { name: title });
      if (how === "escape") await user.keyboard("{Escape}");
      else await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
      await focusIsOn(() => within(bar()).getByRole("button", { name }));
    }
  });

  it("returns to the bar's Pin after a bulk pin, the rows still selected", async () => {
    const user = await loaded();
    await selectTwo(user);
    await user.click(within(bar()).getByRole("button", { name: "Pin selected collectors" }));
    const dialog = await screen.findByRole("dialog", { name: "Pin collectors" });
    await user.click(within(dialog).getByRole("combobox", { name: "Published version" }));
    await user.click(await screen.findByRole("option", { name: "Follow each collector's group" }));
    await user.click(within(dialog).getByRole("button", { name: "Pin 2" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => within(bar()).getByRole("button", { name: "Pin selected collectors" }));
  });

  it("returns to the bar's Move to group after a bulk move's Close", async () => {
    const user = await loaded();
    await selectTwo(user);
    await user.click(within(bar()).getByRole("button", { name: "Move to group" }));
    const dialog = await screen.findByRole("dialog", { name: "Move collectors" });
    await user.click(within(dialog).getByRole("combobox", { name: "Group" }));
    await user.click(await screen.findByRole("option", { name: "gateways" }));
    await user.click(within(dialog).getByRole("button", { name: "Move 2" }));
    await within(dialog).findByText("Moved 2");
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(() => within(bar()).getByRole("button", { name: "Move to group" }));
  });

  it("goes to the search box after a bulk delete's Close, the selection and its bar gone with the rows", async () => {
    const user = await loaded();
    await selectTwo(user);
    await user.click(within(bar()).getByRole("button", { name: "Delete selected collectors" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete collectors" });
    await user.click(within(dialog).getByRole("button", { name: "Delete 2" }));
    await within(dialog).findByText("Deleted 2");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(names()).toEqual(["collector-003"]));
    expect(screen.queryByRole("region", { name: "Selected collectors" })).toBeNull();
    await focusIsOn(searchBox);
  });

  it("goes to the selection bar when its button can't take the focus as the dialog closes", async () => {
    const user = await loaded();
    await selectTwo(user);
    await user.click(within(bar()).getByRole("button", { name: "Pin selected collectors" }));
    await screen.findByRole("dialog", { name: "Pin collectors" });
    // The button pressed, disabled meanwhile (as Move to group is while no groups are held).
    const hiddenBar = screen.getByRole("region", { name: "Selected collectors", hidden: true });
    within(hiddenBar).getByRole("button", { name: "Pin selected collectors", hidden: true }).setAttribute("disabled", "");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await focusIsOn(bar);
    // The focus given it is seen: the buttons' ring (the follow-up), not an outline removed alone.
    expect(bar()).toHaveClass("focus-visible:ring-2", "focus-visible:ring-ring/40");
    expect(bar()).not.toHaveClass("focus:outline-none");
  });
});

// ADR 0024, decisions 13 and 32: no collector, group or fleet name and no address in any attribute.
describe("CollectorsTab's privacy", () => {
  it("holds no collector, group or fleet name and no address in an attribute: rows, tooltips, the filter open and chosen, the search box holding a name", async () => {
    const name = "canary-collector-5d0b";
    const groupName = "canary-group-91ce";
    const label = "canary-fleet-a3f2";
    const address = "198.51.100.23";
    api.groups = [collectorGroup(), gatewaysGroup({ name: groupName })];
    api.rows = [
      collector({ name, groupId: GATEWAYS_GROUP_ID, reported: { collectorVersion: null, ip: address, hostIp: null, attributes: { "host.name": name } } }),
      ...manyCollectors(2, 2),
    ];
    serve();
    const user = renderTab(fleetDetail({ label, summary: { ...EMPTY_SUMMARY, collectors: 3 } }));
    await screen.findByRole("button", { name });
    const canaries = [name, groupName, label, address];
    for (const text of canaries) expectNoAttributeHolds(text);
    const table = screen.getByRole("table");
    // Each row's Status, Configuration (Ruling 55), Version (D16c Ruling 21) and Last seen.
    for (const text of canaries) expect(await expectNoAttributeHoldsInOpenTooltips(text, table)).toBe(12);

    await user.click(checkbox(`Select ${name}`));
    await user.click(filter());
    await screen.findByRole("option", { name: groupName });
    for (const text of canaries) expectNoAttributeHolds(text);
    await user.click(screen.getByRole("option", { name: groupName }));
    await waitFor(() => expect(names()).toEqual([name]));
    expect(filter()).toHaveTextContent(groupName);
    for (const text of canaries) expectNoAttributeHolds(text);

    await user.type(searchBox(), name);
    for (const text of canaries) expectNoAttributeHolds(text);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(vi.mocked(apiClient.getCollectors).mock.calls.at(-1)![2]).toMatchObject({ q: name }));
    await waitFor(() => expect(names()).toEqual([name]));
    for (const text of canaries) expectNoAttributeHolds(text);

    await search(user, "no-such-collector");
    expect(await screen.findByText("No collectors match “no-such-collector”.")).toBeInTheDocument();
    expectNoAttributeHolds("no-such-collector");
  });
});

// D17d-1 decision 23; Preflight rulings 25–29: a Kubernetes-supervisor fleet's tab.
describe("CollectorsTab on a Kubernetes-supervisor fleet", () => {
  const kubernetesFleet = (overrides: Partial<FleetDetail> = {}) =>
    fleetDetail({ type: "kubernetes-supervisor", summary: { ...EMPTY_SUMMARY, collectors: api.rows.length }, ...overrides });

  beforeEach(() => {
    api.groups = kubernetesGroups();
  });

  it("shows an empty fleet's waiting state at once, in Kubernetes words: Install with Helm (no Install collector), and the help with its two tips", async () => {
    serve();
    const user = renderTab(kubernetesFleet());
    expect(await screen.findByText("Waiting for your first collector to connect")).toBeInTheDocument();
    expect(screen.getByText(KUBERNETES_WAITING_DETAIL)).toBeInTheDocument();
    expect(KUBERNETES_WAITING_DETAIL).toBe(
      "Each pod a group's Helm release starts appears here when it checks in with this fleet's token. This list refreshes automatically every 15 seconds.",
    );
    expect(screen.queryByText("Install your first collector")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Collector not showing up?" }));
    const help = await screen.findByRole("dialog");
    expect(within(help).getAllByRole("listitem").map((item) => item.textContent)).toEqual([...KUBERNETES_NOT_SHOWING_UP_TIPS]);
    expect(KUBERNETES_NOT_SHOWING_UP_TIPS).toEqual([
      "The pod must reach the fleet's endpoint: kubectl logs on the pod shows the supervisor's output.",
      "Each collector names its group (COLLECTOR_GROUP_ID): one naming no group, or a group that has since been deleted, is refused.",
    ]);
    expect(help).not.toHaveTextContent(/docker|Linux|install command/i);
    // The command in monospace, as the server tip's docker logs (Ruling 50).
    expect(within(help).getByText("kubectl logs")).toHaveClass("font-mono");
    expect(onInstall).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    // D17d-2 decision 23: the route's Helm install dialog.
    const install = screen.getByRole("button", { name: "Install with Helm" });
    await user.click(install);
    expect(onInstall).toHaveBeenCalledWith(install);
  });

  it("says an archived fleet's words, with no waiting state and no Install collector", async () => {
    serve();
    renderTab(kubernetesFleet({ status: "archived" }));
    expect(await screen.findByText("This fleet is archived: unarchive it to install collectors.")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for your first collector to connect")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install collector" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install with Helm" })).toBeNull();
  });

  it("names the Agent and the Cluster by role in the Group filter, listed Agent, Cluster, then the gateways, and filters by id", async () => {
    api.rows = [collector(), inGateways(manyCollectors(1, 2))[0]!];
    const { getCollectors } = serve();
    const user = renderTab(kubernetesFleet());
    await screen.findByRole("button", { name: "web-01" });
    expect(screen.getByRole("columnheader", { name: "Group" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Role" })).toBeNull();

    await user.click(filter());
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["All groups", "Agent", "Cluster", "alpha", "gateways"]);
    await user.click(screen.getByRole("option", { name: "Agent" }));
    await waitFor(() => expect(names()).toEqual(["web-01"]));
    expect(lastQuery(getCollectors)).toMatchObject({ groupId: DEFAULT_GROUP_ID });
    expect(filter()).toHaveTextContent(/^Agent$/);
  });

  // D17d-2 decision 25 (Ruling 44): the tab hands its groups to the deletes, which name each group's release.
  it("gives a row's delete and the bulk delete the tab's groups: each names its pods' groups' helm uninstall", async () => {
    api.groups = [collectorGroup(), gatewaysGroup({ annotations: kubernetesAnnotations({ namespace: "edge" }) })];
    const [first, second] = manyCollectors(2);
    api.rows = [{ ...first!, groupId: GATEWAYS_GROUP_ID }, { ...second!, groupId: DEFAULT_GROUP_ID }];
    serve();
    const user = renderTab(kubernetesFleet());
    await screen.findByRole("button", { name: "collector-001" });
    const code = (dialog: HTMLElement, name: string) => within(dialog).getByRole("button", { name }).closest(".ph-no-capture")!.querySelector("code")!.textContent;

    await user.click(screen.getByRole("button", { name: "Delete collector-001" }));
    const single = await screen.findByRole("alertdialog", { name: "Delete collector record" });
    expect(code(single, "Copy uninstall command")).toBe("helm uninstall 'gateways' -n 'edge'");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(checkbox("Select collector-001"));
    await user.click(checkbox("Select collector-002"));
    await user.click(within(screen.getByText("2 selected").parentElement!).getByRole("button", { name: "Delete selected collectors" }));
    const bulk = await screen.findByRole("alertdialog", { name: "Delete collectors" });
    expect(code(bulk, "Copy uninstall commands")).toBe(["helm uninstall 'telflo-node' -n 'telflo-collectors'", "helm uninstall 'gateways' -n 'edge'"].join("\n"));
  });

  it("holds no node, gateway or collector name in an attribute: the grid, the filter, and every dialog open (details, edit, delete, bulk pin, move and delete)", async () => {
    const node = "canary-node-31d7";
    const gateway = "canary-gateway-a4e2";
    const otherGateway = "canary-gateway-b5f3";
    const pod = "canary-pod-c6a4";
    api.groups = [collectorGroup(), gatewaysGroup({ id: SECOND_GATEWAY_GROUP_ID, name: otherGateway }), gatewaysGroup({ name: gateway })];
    api.rows = [
      collector({ name: pod, groupId: GATEWAYS_GROUP_ID, reported: { ...collector().reported, attributes: { "k8s.node.name": node, "k8s.pod.name": pod } } }),
      ...manyCollectors(2, 2),
    ];
    serve();
    vi.spyOn(apiClient, "getCollector").mockImplementation(async () => api.rows[0]!);
    vi.spyOn(apiClient, "getEnrollmentTokens").mockResolvedValue({ tokens: [] });
    vi.spyOn(apiClient, "getCollectorErrors").mockResolvedValue({ errors: [], nextCursor: null });
    vi.spyOn(apiClient, "getConfigurations").mockResolvedValue({ items: [], nextCursor: null });
    const user = renderTab(kubernetesFleet());
    await screen.findByRole("button", { name: pod });
    const canaries = [node, gateway, otherGateway, pod];
    const check = (texts = canaries) => {
      for (const text of texts) expectNoAttributeHolds(text);
    };
    expect(screen.getByRole("table")).toHaveTextContent(gateway);
    check();

    await user.click(filter());
    await screen.findByRole("option", { name: otherGateway });
    check();
    await user.keyboard("{Escape}");

    // The details: the Node row shows the node.
    await user.click(screen.getByRole("button", { name: pod }));
    const details = await screen.findByRole("dialog", { name: pod });
    await waitFor(() => expect(within(details).getAllByText(node)).toHaveLength(2));
    check();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The edit: its Name input's value holds the pod's name (D17b-1 Preflight ruling 15's exception), nothing else.
    await user.click(screen.getByRole("button", { name: `Edit ${pod}` }));
    const edit = await screen.findByRole("dialog", { name: "Edit collector" });
    expect(within(edit).getByText(KUBERNETES_PIN_NOTE)).toBeInTheDocument();
    expect(within(edit).getByRole("combobox", { name: "Group" })).toHaveTextContent(gateway);
    await user.click(within(edit).getByRole("combobox", { name: "Group" }));
    await screen.findByRole("option", { name: otherGateway });
    check([node, gateway, otherGateway]);
    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: `Delete ${pod}` }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(`Deleting the record just forgets ${pod}: a pod still running enrolls again on its next poll.`);
    check();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await user.click(checkbox(`Select ${pod}`));
    await user.click(checkbox("Select collector-002"));
    const bar = screen.getByText("2 selected").parentElement!;
    for (const [button, role] of [["Pin selected collectors", "dialog"], ["Move to group", "dialog"], ["Delete selected collectors", "alertdialog"]] as const) {
      await user.click(within(bar).getByRole("button", { name: button }));
      const open = await screen.findByRole(role);
      if (button === "Move to group") {
        await user.click(within(open).getByRole("combobox", { name: "Group" }));
        await screen.findByRole("option", { name: gateway });
      }
      if (button === "Pin selected collectors") expect(open).toHaveTextContent(KUBERNETES_PIN_NOTE);
      check();
      if (button === "Move to group") await user.keyboard("{Escape}");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
    }
  });
});
