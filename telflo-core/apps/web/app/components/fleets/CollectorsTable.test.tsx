import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Collector, CollectorGroup } from "@telflo/contracts";
import * as apiClient from "~/lib/api-client.js";
import { formatDateTime } from "~/lib/format.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { forgetVariableGroupNames, ORGANIZATION_VALUES, UNNAMED_VARIABLE_GROUP } from "~/lib/variable-group-display.js";
import { GROUP_ID, signedInMember } from "~/test/configurations.js";
import { variableGroup } from "~/test/variables.js";
import type { CollectorsListQuery } from "~/lib/collectors.js";
import {
  CLUSTER_GROUP_ID,
  clusterGroup,
  collector,
  collectorGroup,
  CONFIGURATION_ID,
  expectNoAttributeHolds,
  expectNoAttributeHoldsInOpenTooltips,
  gatewaysGroup,
  GATEWAYS_GROUP_ID,
  kubernetesGroups,
  manyCollectors,
  publishedVersion,
  PUBLISHED_VERSION_ID,
  sha256Of,
  VERSION_ID,
} from "~/test/fleets.js";
import { COLLECTOR_CONFIGURATION_LABELS, collectorConfigurationMeaning, UNASSIGNED_COLLECTOR_MEANING } from "./CollectorConfigurationCell.js";
import { LIVENESS_LABELS, LIVENESS_WINDOWS } from "./CollectorStatusCell.js";
import { CollectorsTable, VERSION_MEANINGS, type CollectorsTableProps } from "./CollectorsTable.js";
import { DRIFT_MEANINGS } from "./ConfigurationSyncCell.js";

// A server fleet's collectors grid. The server's `liveness` decides Status and
// its `drift` the Configuration column, never the browser.

const NOW = Date.parse("2026-10-14T10:00:00.000Z");
const GROUPS: CollectorGroup[] = [collectorGroup(), gatewaysGroup()];
const UNSORTED: Pick<CollectorsListQuery, "sort" | "order"> = { sort: null, order: "desc" };

function renderTable(collectors: Collector[], props: Partial<CollectorsTableProps> = {}) {
  const handlers = {
    onSort: vi.fn(),
    onSelect: vi.fn(),
    onSelectAll: vi.fn(),
  };
  const view = render(
    <MemoryRouter>
      <CollectorsTable
        collectors={collectors}
        groups={GROUPS}
        query={UNSORTED}
        now={NOW}
        selected={new Set()}
        {...handlers}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...view, ...handlers, user: userEvent.setup() };
}

/** The editor's route, as the grid's version links reach it: its ids, and a link back to the grid. */
function EditorStub() {
  const { configurationId, versionId } = useParams();
  return (
    <p>
      editor {configurationId} {versionId} <Link to="/">back</Link>
    </p>
  );
}

/** The grid at "/", with the editor's route beside it. */
function renderTableAt(collectors: Collector[]) {
  const table = (
    <CollectorsTable
      collectors={collectors}
      groups={GROUPS}
      query={UNSORTED}
      now={NOW}
      selected={new Set()}
      onSort={vi.fn()}
      onSelect={vi.fn()}
      onSelectAll={vi.fn()}
    />
  );
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={table} />
        <Route path="/editor/:configurationId/:versionId" element={<EditorStub />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user: userEvent.setup() };
}

function rowOf(name: string): HTMLElement {
  return screen.getByRole("button", { name }).closest("tr") as HTMLElement;
}

/** A row's cell by its column's header. */
function cellOf(name: string, header: string): HTMLElement {
  const headers = screen.getAllByRole("columnheader").map((each) => each.textContent);
  return within(rowOf(name)).getAllByRole("cell")[headers.indexOf(header)] as HTMLElement;
}

describe("CollectorsTable's columns", () => {
  it("has its columns in order, a selection column first, Group and Version, Variable group after Group, Configuration after Status", () => {
    renderTable([collector()]);
    expect(screen.getAllByRole("columnheader").map((each) => each.textContent)).toEqual([
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
  });

  it("keeps the API's order", () => {
    renderTable(manyCollectors(3));
    expect(screen.getAllByTitle("View collector details").map((each) => each.textContent)).toEqual([
      "collector-001",
      "collector-002",
      "collector-003",
    ]);
  });

  // The Name button opens the details.
  it("shows the name as a button titled View collector details, calling onOpen when wired", async () => {
    const onOpen = vi.fn();
    const { user } = renderTable([collector()], { onOpen });
    const name = screen.getByRole("button", { name: "web-01" });
    expect(name).toHaveAttribute("title", "View collector details");
    await user.click(name);
    expect(onOpen).toHaveBeenCalledWith(collector(), name);
  });

  it.each([
    ["the host's address first", { hostIp: "192.168.1.17", ip: "10.0.4.17" }, "192.168.1.17"],
    ["else its own", { hostIp: null, ip: "10.0.4.17" }, "10.0.4.17"],
    ["else a dash", { hostIp: null, ip: null }, "—"],
  ])("shows the IP Address: %s, in no attribute", (_why, addresses, shown) => {
    const { container } = renderTable([collector({ reported: { ...collector().reported, ...addresses } })]);
    expect(cellOf("web-01", "IP Address")).toHaveTextContent(new RegExp(`^${shown}$`));
    if (shown !== "—") expectNoAttributeHolds(shown, container);
  });

  it("shows the Group's name, or a dash while the groups haven't been read or don't hold it", () => {
    renderTable([collector(), collector({ id: "00000000-0000-4000-9000-000000000002", name: "web-02", groupId: GATEWAYS_GROUP_ID })]);
    expect(cellOf("web-01", "Group")).toHaveTextContent(/^Default$/);
    expect(cellOf("web-02", "Group")).toHaveTextContent(/^gateways$/);
  });

  it.each([
    ["while the groups haven't been read", null],
    ["for a group the groups don't hold", [gatewaysGroup()]],
  ])("shows a dash for the Group %s", (_why, groups) => {
    renderTable([collector()], { groups });
    expect(cellOf("web-01", "Group")).toHaveTextContent(/^—$/);
  });

  describe("Status, from the server's liveness", () => {
    it.each([
      ["online", "Online", "bg-ok"],
      ["warning", "Warning", "bg-warn"],
      ["unknown", "Unknown", "bg-muted-foreground/40"],
      ["offline", "Offline", "bg-fail"],
    ] as const)("shows %s as %s with a %s dot, its window as tooltip and screen-reader text", async (liveness, words, dot) => {
      const { container } = renderTable([collector({ liveness })]);
      const cell = cellOf("web-01", "Status");
      const trigger = cell.querySelector("[tabindex='0']") as HTMLElement;
      const seenWindow = LIVENESS_WINDOWS[liveness];
      expect(trigger).toHaveTextContent(`${words} (${seenWindow})`);
      expect(cell.textContent).toBe(`${words} (${seenWindow})`);
      const spoken = within(cell).getByText(seenWindow, { exact: false });
      expect(spoken).toHaveClass("sr-only");
      // Read by assistive technology: neither hidden nor under aria-hidden.
      expect(spoken).toBeVisible();
      expect(spoken).not.toHaveAttribute("hidden");
      expect(spoken.closest("[aria-hidden='true']")).toBeNull();
      expect(cell.querySelector(`[aria-hidden='true'].${CSS.escape(dot)}`)).not.toBeNull();
      expect(trigger).not.toHaveAttribute("title");
      expect(trigger).not.toHaveAttribute("aria-label");
      expect(container.querySelector("[title]:not([title='View collector details']):not([title='Edit collector']):not([title='Delete collector record'])")).toBeNull();

      act(() => trigger.focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent(seenWindow);
    });

    it("follows the liveness, not the drift: an offline collector in sync says Offline in Status and In sync in Configuration", () => {
      renderTable([collector({ liveness: "offline", drift: "inSync" })]);
      expect(cellOf("web-01", "Status")).toHaveTextContent(/^Offline \(/);
      expect(cellOf("web-01", "Configuration")).toHaveTextContent(/^In sync \(/);
    });

    it("says the liveness windows, and its words", () => {
      expect(LIVENESS_WINDOWS).toEqual({
        online: "online: seen in the last minute",
        warning: "warning: last seen 1–2 minutes ago",
        unknown: "unknown: last seen 2–5 minutes ago",
        offline: "offline: not seen for over 5 minutes",
      });
      expect(LIVENESS_LABELS).toEqual({ online: "Online", warning: "Warning", unknown: "Unknown", offline: "Offline" });
    });
  });

  describe("Configuration, from the server's drift", () => {
    it.each([
      ["inSync", "In sync", "bg-ok"],
      ["pending", "Pending pickup", "bg-warn"],
      ["failed", "Apply failed", "bg-fail"],
      ["drifted", "Drifted", "bg-fail"],
      ["unassigned", "Nothing assigned", "bg-muted-foreground/40"],
    ] as const)("shows %s as a %s dot and words, its meaning as tooltip and screen-reader text", async (drift, words, dot) => {
      const { container } = renderTable([collector({ drift })]);
      const cell = cellOf("web-01", "Configuration");
      const trigger = cell.querySelector("[tabindex='0']") as HTMLElement;
      const meaning = collectorConfigurationMeaning(drift);
      expect(trigger).toHaveTextContent(`${words} (${meaning})`);
      const spoken = within(cell).getByText(meaning, { exact: false });
      expect(spoken).toHaveClass("sr-only");
      // Read by assistive technology: neither hidden nor under aria-hidden.
      expect(spoken).toBeVisible();
      expect(spoken).not.toHaveAttribute("hidden");
      expect(spoken.closest("[aria-hidden='true']")).toBeNull();
      expect(cell.querySelector(`[aria-hidden='true'].${CSS.escape(dot)}`)).not.toBeNull();
      expect(container.querySelector("[title]:not([title='View collector details']):not([title='Edit collector']):not([title='Delete collector record'])")).toBeNull();

      act(() => trigger.focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent(meaning);
    });

    it("says the drift meanings, and its own for Nothing assigned", () => {
      expect(collectorConfigurationMeaning("inSync")).toBe(`in sync: ${DRIFT_MEANINGS.inSync}`);
      expect(collectorConfigurationMeaning("pending")).toBe(`pending pickup: ${DRIFT_MEANINGS.pending}`);
      expect(collectorConfigurationMeaning("failed")).toBe(`apply failed: ${DRIFT_MEANINGS.failed}`);
      expect(collectorConfigurationMeaning("drifted")).toBe(`drifted: ${DRIFT_MEANINGS.drifted}`);
      expect(collectorConfigurationMeaning("unassigned")).toBe(
        "nothing assigned: no pin, and no published version on its group; it keeps running what it has: its own file, or the last published version it was sent.",
      );
      expect(UNASSIGNED_COLLECTOR_MEANING).not.toBe(DRIFT_MEANINGS.unassigned);
      expect(Object.keys(COLLECTOR_CONFIGURATION_LABELS)).toEqual(["inSync", "pending", "failed", "drifted", "unassigned"]);
    });
  });

  describe("Version: what was served", () => {
    it("centers the column, its header and its cells", () => {
      renderTable([collector(), collector({ id: "c6d7e8f9-0a1b-4c2d-b3e4-f5a6b7c8d9e0", name: "web-02", served: null })]);
      const header = screen.getAllByRole("columnheader").find((each) => each.textContent === "Version")!;
      expect(header).toHaveClass("text-center");
      expect(header).not.toHaveClass("text-left");
      for (const name of ["web-01", "web-02"]) {
        expect(cellOf(name, "Version").firstElementChild).toHaveClass("text-center");
      }
    });

    // "{configurationName} @v{n}", as the Groups tab's, with no title.
    it("links a published version served to the editor, '{configurationName} @v{n}', with no title", () => {
      renderTable([collector()]);
      const link = within(cellOf("web-01", "Version")).getByRole("link", { name: "checkout-otel @v4" });
      expect(link).toHaveAttribute("href", `/editor/${CONFIGURATION_ID}/${VERSION_ID}`);
      expect(link.textContent).toBe("checkout-otel @v4");
      expect(link).not.toHaveAttribute("title");
    });

    it("truncates a long configuration name at 16rem, never @v{n}, its full text and its meaning in the one tooltip", async () => {
      const long = `nginx-logs-${"x".repeat(120)}`;
      renderTable([collector({ served: { ...collector().served!, version: publishedVersion({ configurationName: long }) } })]);
      const cell = cellOf("web-01", "Version");
      const link = within(cell).getByRole("link", { name: `${long} @v4` });
      expect(within(link).getByText(long)).toHaveClass("inline-block", "truncate", "max-w-64");
      expect(link.textContent).toBe(`${long} @v4`);
      act(() => link.focus());
      const tooltip = await screen.findByRole("tooltip");
      expect([...tooltip.querySelectorAll("p")].map((line) => line.textContent)).toEqual([`${long} @v4`, VERSION_MEANINGS.version]);
      expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    });

    it("links to the served version, not the target, when they differ", () => {
      renderTable([
        collector({
          served: {
            kind: "version",
            publishedVersionId: PUBLISHED_VERSION_ID,
            sha256: sha256Of("c"),
            at: "2026-10-14T09:00:00.000Z",
            version: publishedVersion({ versionNumber: 3, versionId: "c6d7e8f9-0a1b-4c2d-b3e4-f5a6b7c8d9e0" }),
          },
          drift: "pending",
        }),
      ]);
      expect(within(cellOf("web-01", "Version")).getByRole("link", { name: "checkout-otel @v3" })).toHaveAttribute(
        "href",
        `/editor/${CONFIGURATION_ID}/c6d7e8f9-0a1b-4c2d-b3e4-f5a6b7c8d9e0`,
      );
    });

    const DELETED_SERVED = { kind: "version", publishedVersionId: PUBLISHED_VERSION_ID, sha256: sha256Of("a"), at: null, version: null } as const;
    const FORMS = [
      ["a published version served", collector().served, "checkout-otel @v4", "version"],
      ["a deleted configuration's version", DELETED_SERVED, "Deleted configuration", "deleted"],
      [
        "a deleted published version",
        { kind: "version", publishedVersionId: null, sha256: sha256Of("a"), at: null, version: null },
        "Deleted configuration",
        "deleted",
      ],
      ["nothing", null, "—", "nothing"],
    ] as const;

    it.each(FORMS.slice(1))("shows %s as %s, with no link", (_why, served, words) => {
      renderTable([collector({ served })]);
      const cell = cellOf("web-01", "Version");
      expect(within(cell).queryByRole("link")).toBeNull();
      expect(within(cell).getByText(words)).toHaveClass("text-muted-foreground");
    });

    // What each form means, the collector's running state, as Configuration's meaning is shown.
    it.each(FORMS)(
      "says what the Version for %s means as tooltip text, on hover and on keyboard focus, and as screen-reader text",
      async (_why, served, words, form) => {
        const { user } = renderTable([collector({ served })]);
        const cell = cellOf("web-01", "Version");
        const meaning = VERSION_MEANINGS[form];
        const trigger = (form === "version" ? within(cell).getByRole("link") : cell.querySelector("[tabindex='0']")) as HTMLElement;
        expect(trigger).toHaveAttribute("data-state", "closed");
        expect(trigger).not.toHaveAttribute("title");
        expect(trigger).not.toHaveAttribute("aria-label");
        expect(cell.textContent).toBe(`${words} (${meaning})`);
        const spoken = within(cell).getByText(`(${meaning})`, { exact: false });
        expect(spoken).toHaveClass("sr-only");
        // Read by assistive technology: neither hidden nor under aria-hidden.
        expect(spoken).toBeVisible();
        expect(spoken).not.toHaveAttribute("hidden");
        expect(spoken.closest("[aria-hidden='true']")).toBeNull();
        // The link keeps the version as its name; the dash's and the deleted words' copy is the trigger's own.
        if (form === "version") expect(trigger).toHaveAccessibleName(words);
        else expect(trigger).toContainElement(spoken);

        await user.hover(trigger);
        // A version's one tooltip: its full text, then the meaning; the other forms' the meaning alone.
        expect(await screen.findByRole("tooltip")).toHaveTextContent(form === "version" ? `${words}${meaning}` : meaning);
        // Dismissed (Radix keeps a hovered tooltip open while the pointer may be on its way to it).
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

        // By keyboard: the Tab after Configuration's trigger reaches it.
        act(() => (cellOf("web-01", "Configuration").querySelector("[tabindex='0']") as HTMLElement).focus());
        await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(collectorConfigurationMeaning("inSync")));
        await user.tab();
        expect(trigger).toHaveFocus();
        await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(meaning));
      },
    );

    it("says the Version meanings' words", () => {
      expect(VERSION_MEANINGS).toEqual({
        version: "Running: the last published version it was sent.",
        nothing: "Nothing sent yet: it runs its own file.",
        deleted: "Running a version of a configuration since deleted.",
      });
    });

    it("still goes to the editor from the version's link, its tooltip open", async () => {
      const { user } = renderTableAt([collector()]);
      const link = within(cellOf("web-01", "Version")).getByRole("link", { name: "checkout-otel @v4" });
      act(() => link.focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent(VERSION_MEANINGS.version);
      await user.keyboard("{Enter}");
      expect(await screen.findByText(`editor ${CONFIGURATION_ID} ${VERSION_ID}`)).toBeInTheDocument();

      await user.click(screen.getByRole("link", { name: "back" }));
      await user.click(within(cellOf("web-01", "Version")).getByRole("link", { name: "checkout-otel @v4" }));
      expect(await screen.findByText(`editor ${CONFIGURATION_ID} ${VERSION_ID}`)).toBeInTheDocument();
    });
  });

  describe("Last seen: how long ago, as plain text", () => {
    it.each(["online", "warning", "unknown", "offline"] as const)(
      "shows a %s collector's how long ago with no dot, the full time as tooltip and screen-reader text",
      async (liveness) => {
        renderTable([collector({ liveness })]);
        const cell = cellOf("web-01", "Last seen");
        const trigger = cell.querySelector("[tabindex='0']") as HTMLElement;
        const fullTime = formatDateTime(collector().lastSeenAt);
        expect(cell.textContent).toBe(`5 seconds ago (${fullTime})`);
        // No dot (the liveness is Status's), nor the window.
        expect(cell.querySelector("[aria-hidden='true']")).toBeNull();
        expect(cell).not.toHaveTextContent(LIVENESS_WINDOWS[liveness]);
        // 13 px, monospaced.
        expect(trigger).toHaveClass("font-mono", "text-[13px]");
        expect(trigger).not.toHaveClass("text-xs");
        const spoken = within(cell).getByText(fullTime, { exact: false });
        expect(spoken).toHaveClass("sr-only");
        // Read by assistive technology: neither hidden nor under aria-hidden.
        expect(spoken).toBeVisible();
        expect(spoken).not.toHaveAttribute("hidden");
        expect(spoken.closest("[aria-hidden='true']")).toBeNull();
        expect(trigger).not.toHaveAttribute("title");
        expect(trigger).not.toHaveAttribute("aria-label");

        act(() => trigger.focus());
        const tooltip = await screen.findByRole("tooltip");
        // The full time alone: the window is Status's.
        expect(tooltip.textContent).toBe(fullTime);
      },
    );

    it("reckons the time at the render's now", () => {
      renderTable([collector({ lastSeenAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), liveness: "offline" })]);
      expect(cellOf("web-01", "Last seen")).toHaveTextContent(/^3 hours ago/);
    });
  });

  describe("sorting", () => {
    it("sorts by Name and Last seen through header buttons; no other header sorts, and none shows sorted by default", async () => {
      const { user, onSort } = renderTable([collector()]);
      const headers = screen.getAllByRole("columnheader");
      expect(headers.filter((header) => header.hasAttribute("aria-sort"))).toEqual([]);
      expect(headers.map((header) => within(header).queryByRole("button")?.textContent ?? null)).toEqual([
        null,
        "Name",
        null,
        null,
        null,
        null,
        null,
        null,
        "Last seen",
        null,
      ]);

      await user.click(screen.getByRole("button", { name: "Name" }));
      expect(onSort).toHaveBeenLastCalledWith("name");
      await user.click(screen.getByRole("button", { name: "Last seen" }));
      expect(onSort).toHaveBeenLastCalledWith("lastSeen");
    });

    it.each([
      ["name", "asc", "Name", "ascending"],
      ["name", "desc", "Name", "descending"],
      ["lastSeen", "asc", "Last seen", "ascending"],
      ["lastSeen", "desc", "Last seen", "descending"],
    ] as const)("marks the sorted header only: %s %s", (sort, order, header, ariaSort) => {
      renderTable([collector()], { query: { sort, order } });
      const sorted = screen.getAllByRole("columnheader").filter((each) => each.hasAttribute("aria-sort"));
      expect(sorted).toHaveLength(1);
      expect(sorted[0]).toHaveTextContent(header);
      expect(sorted[0]).toHaveAttribute("aria-sort", ariaSort);
    });
  });

  describe("the row's actions and selection", () => {
    it("names Edit, Delete and the checkbox for the row by hidden text, with fixed titles", () => {
      renderTable([collector()]);
      expect(screen.getByRole("button", { name: "Edit web-01" })).toHaveAttribute("title", "Edit collector");
      expect(screen.getByRole("button", { name: "Delete web-01" })).toHaveAttribute("title", "Delete collector record");
      expect(screen.getByRole("checkbox", { name: "Select web-01" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Select all on this page" })).not.toBeChecked();
      // The icons: 16 px.
      for (const name of ["Edit web-01", "Delete web-01"]) {
        expect(screen.getByRole("button", { name }).querySelector("svg")).toHaveClass("h-4", "w-4");
      }
    });

    it("does nothing on Edit or Delete until a later task wires them, and calls them when wired", async () => {
      const unwired = renderTable([collector()]);
      await unwired.user.click(screen.getByRole("button", { name: "Edit web-01" }));
      await unwired.user.click(screen.getByRole("button", { name: "Delete web-01" }));
      await unwired.user.click(screen.getByRole("button", { name: "web-01" }));
      unwired.unmount();

      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const { user } = renderTable([collector()], { onEdit, onDelete });
      await user.click(screen.getByRole("button", { name: "Edit web-01" }));
      await user.click(screen.getByRole("button", { name: "Delete web-01" }));
      expect(onEdit).toHaveBeenCalledWith(collector(), screen.getByRole("button", { name: "Edit web-01" }));
      expect(onDelete).toHaveBeenCalledWith(collector(), screen.getByRole("button", { name: "Delete web-01" }));
    });

    it("selects a row, and every row on the page from the header", async () => {
      const { user, onSelect, onSelectAll } = renderTable(manyCollectors(2));
      await user.click(screen.getByRole("checkbox", { name: "Select collector-002" }));
      expect(onSelect).toHaveBeenLastCalledWith(manyCollectors(2)[1]!.id, true);
      await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
      expect(onSelectAll).toHaveBeenLastCalledWith(true);
    });

    it("shows the header's checkbox unchecked with none selected, indeterminate with some, checked with all; a row's as selected", async () => {
      const rows = manyCollectors(2);
      const { rerender, user, onSelect, onSelectAll } = renderTable(rows, { selected: new Set([rows[0]!.id]) });
      const all = () => screen.getByRole("checkbox", { name: "Select all on this page" });
      expect(all()).toHaveAttribute("aria-checked", "mixed");
      expect(screen.getByRole("checkbox", { name: "Select collector-001" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Select collector-002" })).not.toBeChecked();
      await user.click(screen.getByRole("checkbox", { name: "Select collector-001" }));
      expect(onSelect).toHaveBeenLastCalledWith(rows[0]!.id, false);

      const props = { collectors: rows, groups: GROUPS, query: UNSORTED, now: NOW, onSort: vi.fn(), onSelect, onSelectAll };
      rerender(
        <MemoryRouter>
          <CollectorsTable {...props} selected={new Set(rows.map((row) => row.id))} />
        </MemoryRouter>,
      );
      expect(all()).toBeChecked();
      await user.click(all());
      expect(onSelectAll).toHaveBeenLastCalledWith(false);
    });
  });

  // Names, addresses and group names are text in the masked shell, never an attribute; the Version tooltips (each
  // form's) hold fixed words only, but for the version's own full text, which is the tooltip's text, never an
  // attribute.
  it("holds no collector, group or configuration name and no address in any attribute, its tooltips open", async () => {
    const name = "canary-collector-7c1e";
    const groupName = "canary-group-2f9a";
    const configurationName = "canary-configuration-5b3d";
    const host = "198.51.100.77";
    const own = "203.0.113.41";
    const { container } = renderTable(
      [
        collector({
          name,
          groupId: GATEWAYS_GROUP_ID,
          reported: { collectorVersion: "0.162.0", ip: own, hostIp: host, attributes: { "host.name": name } },
          served: {
            kind: "version",
            publishedVersionId: PUBLISHED_VERSION_ID,
            sha256: sha256Of("a"),
            at: "2026-10-14T09:00:00.000Z",
            version: publishedVersion({ configurationName }),
          },
        }),
        collector({
          id: "00000000-0000-4000-9000-000000000002",
          name: `${name}-b`,
          groupId: GATEWAYS_GROUP_ID,
          drift: "unassigned",
          liveness: "offline",
          served: null,
          reported: { collectorVersion: null, ip: own, hostIp: null, attributes: null },
        }),
        collector({
          id: "00000000-0000-4000-9000-000000000003",
          name: `${name}-c`,
          groupId: GATEWAYS_GROUP_ID,
          drift: "drifted",
          served: { kind: "version", publishedVersionId: null, sha256: sha256Of("b"), at: null, version: null },
          reported: { collectorVersion: null, ip: own, hostIp: null, attributes: null },
        }),
      ],
      { groups: [collectorGroup(), gatewaysGroup({ name: groupName })], selected: new Set(["00000000-0000-4000-9000-000000000002"]) },
    );
    expect(container.textContent).toContain(name);
    expect(container.textContent).toContain(groupName);
    expect(container.textContent).toContain(host);
    expect(container.textContent).toContain(own);
    expect(container.textContent).toContain(`${configurationName} @v4`);
    expect(container.textContent).toContain("Deleted configuration");
    for (const text of [name, groupName, configurationName, host, own]) expectNoAttributeHolds(text);
    // Status, Configuration, Version and Last seen on each of the three rows: the Version's three forms among them.
    expect(await expectNoAttributeHoldsInOpenTooltips(name, container)).toBe(12);
    for (const text of [groupName, configurationName, host, own]) await expectNoAttributeHoldsInOpenTooltips(text, container);
  });
});

// A Kubernetes-supervisor fleet's grid.
describe("CollectorsTable on a Kubernetes-supervisor fleet", () => {
  const agentPod = collector({ id: "00000000-0000-4000-9000-0000000000a1", name: "agent-pod" });
  const clusterPod = collector({ id: "00000000-0000-4000-9000-0000000000a2", name: "cluster-pod", groupId: CLUSTER_GROUP_ID });
  const gatewayPod = collector({ id: "00000000-0000-4000-9000-0000000000a3", name: "gateway-pod", groupId: GATEWAYS_GROUP_ID });

  // One Group column, where a server fleet's is, as the Groups tab's.
  it("shows one Group column: the role's badge (Agent for the Default group's, Cluster for cluster's, Gateway for any other), then a gateway's name", () => {
    renderTable([agentPod, clusterPod, gatewayPod], { groups: kubernetesGroups(), fleetType: "kubernetes-supervisor" });
    expect(screen.getAllByRole("columnheader").map((each) => each.textContent)).toEqual([
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
    expect(cellOf("agent-pod", "Group")).toHaveTextContent(/^Agent$/);
    expect(cellOf("cluster-pod", "Group")).toHaveTextContent(/^Cluster$/);
    expect(cellOf("gateway-pod", "Group")).toHaveTextContent(/^Gateway gateways$/);
    expect(within(cellOf("gateway-pod", "Group")).getByText("Gateway")).toHaveClass("border");
    expect(screen.getByRole("table")).not.toHaveTextContent("Default");
  });

  it.each([
    ["while the groups haven't been read", null],
    ["for a group the groups don't hold", [clusterGroup()]],
  ])("shows a dash for Group %s", (_why, groups) => {
    renderTable([agentPod], { groups, fleetType: "kubernetes-supervisor" });
    expect(cellOf("agent-pod", "Group")).toHaveTextContent(/^—$/);
  });

  it("shows no badge on a server fleet, where a group named cluster is a group like any other", () => {
    renderTable([clusterPod], { groups: [collectorGroup(), clusterGroup()], fleetType: "server" });
    expect(screen.queryByRole("columnheader", { name: "Role" })).toBeNull();
    expect(cellOf("cluster-pod", "Group")).toHaveTextContent(/^cluster$/);
    expect(screen.queryByText("Cluster")).toBeNull();
  });

  it("holds no gateway name in any attribute", () => {
    const gatewayName = "canary-gateway-4e1b";
    renderTable([agentPod, gatewayPod], { groups: [collectorGroup(), gatewaysGroup({ name: gatewayName })], fleetType: "kubernetes-supervisor" });
    expect(cellOf("gateway-pod", "Group")).toHaveTextContent(gatewayName);
    expectNoAttributeHolds(gatewayName);
  });
});

describe("CollectorsTable's Variable group column", () => {
  const EU_ID = "7b000000-0000-4000-8000-0000000000e1";
  const CANARY_ID = "7b000000-0000-4000-8000-0000000000c1";
  const EU = variableGroup({ id: EU_ID, name: "eu-edge" });
  const CANARY = variableGroup({ id: CANARY_ID, name: "canary-vg" });

  afterEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    forgetVariableGroupNames();
  });

  function signIn() {
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
    return vi.spyOn(apiClient, "getVariableGroups").mockResolvedValue([EU, CANARY]);
  }

  it("shows the pin's variable group, else the group's, else Organization values, reading the names once", async () => {
    const read = signIn();
    renderTable(
      [
        collector({ id: "00000000-0000-4000-9000-000000000001", name: "pinned-one", pinnedVariableGroupId: CANARY_ID, groupId: GATEWAYS_GROUP_ID }),
        collector({ id: "00000000-0000-4000-9000-000000000002", name: "group-one", groupId: GATEWAYS_GROUP_ID }),
        collector({ id: "00000000-0000-4000-9000-000000000003", name: "plain-one" }),
      ],
      { groups: [collectorGroup(), gatewaysGroup({ variableGroupId: EU_ID })] },
    );
    expect(await within(cellOf("pinned-one", "Variable group")).findByRole("button", { name: "canary-vg" })).toBeInTheDocument();
    expect(within(cellOf("group-one", "Variable group")).getByRole("button", { name: "eu-edge" })).toBeInTheDocument();
    expect(within(cellOf("plain-one", "Variable group")).getByRole("button", { name: ORGANIZATION_VALUES })).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reads nothing when no row names a variable group", () => {
    const read = signIn();
    renderTable([collector()]);
    expect(within(cellOf("web-01", "Variable group")).getByRole("button", { name: ORGANIZATION_VALUES })).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("shows a dash while the groups are unread and the collector has no pin; a pin is shown without them", async () => {
    signIn();
    renderTable(
      [collector({ name: "plain-one" }), collector({ id: "00000000-0000-4000-9000-000000000009", name: "pinned-one", pinnedVariableGroupId: EU_ID })],
      { groups: null },
    );
    expect(cellOf("plain-one", "Variable group")).toHaveTextContent(/^—$/);
    expect(await within(cellOf("pinned-one", "Variable group")).findByRole("button", { name: "eu-edge" })).toBeInTheDocument();
  });

  it("names a variable group the read couldn't name in fixed words, never blank", async () => {
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
    const read = vi.spyOn(apiClient, "getVariableGroups").mockRejectedValue(new apiClient.ApiError("network_error", "x"));
    renderTable([collector({ pinnedVariableGroupId: EU_ID })]);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(within(cellOf("web-01", "Variable group")).getByRole("button", { name: UNNAMED_VARIABLE_GROUP })).toBeInTheDocument();
  });

  it("holds no variable group's name in any attribute", async () => {
    signIn();
    renderTable([collector({ pinnedVariableGroupId: CANARY_ID })]);
    await within(cellOf("web-01", "Variable group")).findByRole("button", { name: "canary-vg" });
    expectNoAttributeHolds("canary-vg");
    expect(screen.getByText("canary-vg").closest(".ph-no-capture")).not.toBeNull();
  });
});
