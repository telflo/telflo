import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Configuration, ConfigurationsPage, CurrentUserResponse } from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { toast } from "sonner";
import routes from "../routes.js";
import AppLayoutRoute, { shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import { SAAS_SITE, underSite } from "~/test/site.js";
import ConfigurationsRoute, { meta } from "./configurations.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, type ConfigurationsQuery } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { resetCollectorCatalogue } from "~/lib/stores/collector-catalogue-store.js";
import { CATALOGUE, CONTRIB_LABEL } from "~/test/collector-distributions.js";
import {
  COLLEAGUE_EMAIL,
  GROUP_ID,
  MEMBER_EMAIL,
  MINE,
  ORPHANED,
  PERSONAL_ID,
  THEIRS,
  manyConfigurations,
  signedInMember,
} from "~/test/configurations.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

const VIEW_MODE_KEY = "telflo-configuration-view-mode";

/** Where the page went, for the editor's address. */
function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

/**
 * `/app` under the signed-in layout, as the app routes it. The layout's
 * loader answers each load with the next of `answers`, the last repeating.
 */
function renderPage(answers: CurrentUserResponse[] = [signedInMember()], { strict = false } = {}) {
  const pending = [...answers];
  const layoutLoader = vi.fn(
    (): AppLayoutData => ({ status: "signed_in", currentUser: (pending.length > 1 ? pending.shift() : pending[0])! }),
  );
  const Stub = createRoutesStub(underSite(SAAS_SITE, [
    {
      id: "routes/app-layout",
      Component: AppLayoutRoute as unknown as React.ComponentType,
      loader: layoutLoader,
      shouldRevalidate,
      HydrateFallback: () => null,
      children: [
        { path: "/app", Component: ConfigurationsRoute },
        { path: "/editor/:configurationId", Component: Landed },
      ],
    },
  ]));
  const stub = <Stub initialEntries={["/app"]} />;
  render(strict ? <StrictMode>{stub}</StrictMode> : stub);
  return { layoutLoader, user: userEvent.setup() };
}

type Lister = (organizationId: string, query: ConfigurationsQuery) => ConfigurationsPage | Promise<ConfigurationsPage>;

/** The API's list, answered by `answer`. */
function serveList(answer: Lister) {
  return vi
    .spyOn(apiClient, "getConfigurations")
    .mockImplementation(async (organizationId, query = {}) => answer(organizationId, query));
}

function page(items: Configuration[], nextCursor: string | null = null): ConfigurationsPage {
  return { items, nextCursor };
}

/** A request the test answers when it chooses. */
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function chooseFilter(user: ReturnType<typeof userEvent.setup>, label: "All configurations" | "Mine" | "Published") {
  await user.click(screen.getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("the configurations page (/app)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
    window.localStorage.clear();
    resetCollectorCatalogue();
    vi.spyOn(apiClient, "getCollectorDistributions").mockResolvedValue({ distributions: CATALOGUE });
    // The create dialog reads the flows when it opens.
    vi.spyOn(apiClient, "getFlows").mockResolvedValue({ flows: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is /app under the signed-in layout", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    expect(layout?.children?.find((route) => route.path === "app")?.file).toBe("routes/configurations.tsx");
  });

  it("reads the collector catalogue once, for the tags, and still lists when it can't", async () => {
    serveList(() => page([MINE, THEIRS]));
    const read = vi
      .spyOn(apiClient, "getCollectorDistributions")
      .mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server. Check your connection."));
    const { user } = renderPage();

    // The read failed: the list is there, each tag naming its distribution by id.
    expect(await screen.findByRole("heading", { level: 3, name: MINE.name })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByTitle("Built for otelcol-contrib — chosen when this configuration was created.")).toHaveLength(2),
    );
    expect(screen.getAllByText("Otel Contrib")).toHaveLength(2);

    // The create dialog's opening asks again, and the tags take the catalogue's label.
    read.mockResolvedValue({ distributions: CATALOGUE });
    await user.click(screen.getByRole("button", { name: "New configuration" }));
    await user.click(await screen.findByRole("button", { name: /Blank configuration/ }));
    expect(await screen.findByRole("combobox", { name: "Distribution" })).toHaveTextContent("Otel Contrib");
    expect(
      screen.getAllByTitle(`Built for ${CONTRIB_LABEL} — chosen when this configuration was created.`, { exact: true }),
    ).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("titles /app", () => {
    expect(meta({} as Parameters<typeof meta>[0])).toEqual([
      { title: "My Configurations - Telflo" },
      { name: "description", content: "Manage your OpenTelemetry Collector configurations" },
    ]);
  });

  it("shows the loading state until the first page answers", async () => {
    const first = deferred<ConfigurationsPage>();
    serveList(() => first.promise);
    renderPage();

    expect(await screen.findByText("Loading configurations…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Configurations" })).toBeNull();

    await act(async () => first.resolve(page([MINE])));
    expect(await screen.findByRole("heading", { name: "Configurations" })).toBeInTheDocument();
    expect(screen.queryByText("Loading configurations…")).toBeNull();
  });

  it("loads the active organization's first page and shows it as a grid of cards, with no count", async () => {
    const getConfigurations = serveList(() => page([MINE, THEIRS, ORPHANED]));
    renderPage();

    const mine = (await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).closest(
      "[role=button]",
    ) as HTMLElement;
    const theirs = screen.getByRole("heading", { level: 3, name: "Staging Logs" }).closest("[role=button]") as HTMLElement;
    const orphaned = screen.getByRole("heading", { level: 3, name: "Left Behind" }).closest("[role=button]") as HTMLElement;

    expect(getConfigurations).toHaveBeenCalledTimes(1);
    expect(getConfigurations).toHaveBeenCalledWith(PERSONAL_ID, { q: "", filter: "all" });
    expect(mine).toHaveTextContent("Collects traces and metrics from production");
    expect(mine).not.toHaveTextContent(MEMBER_EMAIL);
    expect(theirs).toHaveTextContent(COLLEAGUE_EMAIL);
    expect(theirs).toHaveTextContent("No description");
    expect(orphaned).not.toHaveTextContent("@");
    expect(screen.queryByRole("table")).toBeNull();
    // The header has no count: a paged list can't know its total.
    expect(screen.getByRole("heading", { level: 1, name: "Configurations" }).parentElement).toHaveTextContent(
      /^Configurations$/,
    );
    expect(screen.getByRole("button", { name: "Grid view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "List view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New configuration" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search configurations…")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveTextContent("All configurations");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("offers All configurations, Mine and Published", async () => {
    serveList(() => page([MINE]));
    const { user } = renderPage();
    await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

    await user.click(screen.getByRole("combobox"));

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "All configurations",
      "Mine",
      "Published",
    ]);
  });

  it("shows Draft or Published on each card, and in the list's Status column", async () => {
    serveList(() => page([MINE, THEIRS]));
    const { user } = renderPage();
    const mine = (await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).closest(
      "[role=button]",
    ) as HTMLElement;
    const theirs = screen.getByRole("heading", { level: 3, name: "Staging Logs" }).closest("[role=button]") as HTMLElement;

    expect(within(mine).getByText("Draft")).toBeInTheDocument();
    expect(within(mine).queryByText("Published")).toBeNull();
    expect(within(theirs).getByText("Published")).toBeInTheDocument();
    expect(within(theirs).queryByText("Draft")).toBeNull();

    await user.click(screen.getByRole("button", { name: "List view" }));

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[2]!.textContent)).toEqual(["Draft", "Published"]);
  });

  it("switches to the list, with its columns, (you), — and the dates, and keeps the choice", async () => {
    serveList(() => page([MINE, THEIRS, ORPHANED]));
    const { user } = renderPage();
    await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

    await user.click(screen.getByRole("button", { name: "List view" }));

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Owner",
      "Status",
      "Distribution",
      "Created",
      "Updated",
      "Actions",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[1]!.textContent)).toEqual([
      `${MEMBER_EMAIL}(you)`,
      COLLEAGUE_EMAIL,
      "—",
    ]);
    expect(within(rows[0]!).getAllByRole("cell")[3]).toHaveTextContent(/^Otel Contrib$/);
    expect(within(rows[0]!).getAllByRole("cell")[4]).toHaveTextContent(new Date(MINE.createdAt).toLocaleDateString());
    expect(within(rows[0]!).getAllByRole("cell")[5]).toHaveTextContent(new Date(MINE.updatedAt).toLocaleDateString());
    expect(window.localStorage.getItem(VIEW_MODE_KEY)).toBe("list");

    await user.click(screen.getByRole("button", { name: "Grid view" }));

    expect(screen.queryByRole("table")).toBeNull();
    expect(window.localStorage.getItem(VIEW_MODE_KEY)).toBe("grid");
  });

  it("opens in the stored view", async () => {
    window.localStorage.setItem(VIEW_MODE_KEY, "list");
    serveList(() => page([MINE]));
    renderPage();

    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("opens in the grid for a stored value that isn't a view", async () => {
    window.localStorage.setItem(VIEW_MODE_KEY, "table");
    serveList(() => page([MINE]));
    renderPage();

    expect(await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("falls back to the grid when storage can't be read, and still switches when it can't be written", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    serveList(() => page([MINE]));
    const { user } = renderPage();

    expect(await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  describe("the empty states", () => {
    it("says No configurations yet., with New configuration, when there are none", async () => {
      serveList(() => page([]));
      const { user } = renderPage();

      expect(await screen.findByText("No configurations yet.")).toBeInTheDocument();
      const buttons = screen.getAllByRole("button", { name: "New configuration" });
      expect(buttons).toHaveLength(2);

      await user.click(buttons[1]!);
      expect(await screen.findByRole("dialog", { name: "New configuration" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /Blank configuration/ }));
      expect(await screen.findByRole("dialog", { name: "Name Your Configuration" })).toBeInTheDocument();
    });

    it("says Nothing matches your search or filter. for a search that finds none", async () => {
      serveList((_organizationId, { q }) => page(q === "" ? [MINE] : []));
      renderPage();
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

      fireEvent.change(screen.getByPlaceholderText("Search configurations…"), { target: { value: "nothing" } });

      expect(await screen.findByText("Nothing matches your search or filter.")).toBeInTheDocument();
      expect(screen.queryByText("No configurations yet.")).toBeNull();
      expect(screen.getAllByRole("button", { name: "New configuration" })).toHaveLength(1);
    });

    it("says Nothing matches your search or filter. for Mine with none", async () => {
      serveList((_organizationId, { filter }) => page(filter === "mine" ? [] : [THEIRS]));
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });

      await chooseFilter(user, "Mine");

      expect(await screen.findByText("Nothing matches your search or filter.")).toBeInTheDocument();
    });
  });

  describe("Load more", () => {
    it("appends the next page, drops a configuration already shown, and goes on the last page", async () => {
      const first = manyConfigurations(50);
      const second = [first[49]!, ...manyConfigurations(10, 51)];
      const more = deferred<ConfigurationsPage>();
      const getConfigurations = serveList((_organizationId, { cursor }) =>
        cursor === undefined ? page(first, "cursor-1") : more.promise,
      );
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Configuration 50" });

      await user.click(screen.getByRole("button", { name: "Load more" }));

      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "all", cursor: "cursor-1" });
      expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
      await act(async () => more.resolve(page(second, null)));

      expect(await screen.findByRole("heading", { level: 3, name: "Configuration 60" })).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(60);
      expect(screen.getAllByRole("heading", { level: 3, name: "Configuration 50" })).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Loading…" })).toBeNull();
    });

    it("asks for the next page with the search and filter the shown list came from", async () => {
      const getConfigurations = serveList((_organizationId, { cursor }) =>
        cursor === undefined ? page([MINE], "cursor-1") : page([THEIRS]),
      );
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });
      await chooseFilter(user, "Mine");
      await waitFor(() => expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "mine" }));

      await user.click(await screen.findByRole("button", { name: "Load more" }));

      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "mine", cursor: "cursor-1" });
      expect(await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).toBeInTheDocument();
    });

    it("ignores a next page that arrives after the search has changed", async () => {
      const more = deferred<ConfigurationsPage>();
      serveList((_organizationId, { cursor, filter }) => {
        if (cursor !== undefined) return more.promise;
        return filter === "mine" ? page([MINE]) : page([THEIRS], "cursor-1");
      });
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });
      await user.click(screen.getByRole("button", { name: "Load more" }));

      await chooseFilter(user, "Mine");
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });
      await act(async () => more.resolve(page([ORPHANED])));

      expect(screen.queryByRole("heading", { level: 3, name: "Left Behind" })).toBeNull();
      expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
    });

    /** The requests for a next page, by the cursor each named. */
    const cursorsAskedFor = (getConfigurations: ReturnType<typeof serveList>) =>
      getConfigurations.mock.calls.flatMap(([, query]) => (query?.cursor === undefined ? [] : [query.cursor]));

    it("sends no next page while a new filter's first page is under way, and shows the new filter's list only", async () => {
      const mineFirst = deferred<ConfigurationsPage>();
      const oldNext = deferred<ConfigurationsPage>();
      const getConfigurations = serveList((_organizationId, { cursor, filter }) => {
        if (cursor !== undefined) return oldNext.promise;
        return filter === "mine" ? mineFirst.promise : page([THEIRS], "cursor-all");
      });
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });

      await chooseFilter(user, "Mine");
      await waitFor(() => expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "mine" }));
      // The old list is still shown, and so is its Load more, but it can't be used.
      const loadMore = screen.getByRole("button", { name: "Load more" });
      expect(loadMore).toBeDisabled();
      fireEvent.click(loadMore);

      // Mine answers first; a next page of the old list, had one been asked
      // for, would answer after it.
      await act(async () => mineFirst.resolve(page([MINE])));
      await act(async () => oldNext.resolve(page([ORPHANED])));

      expect(await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
        "Production Monitoring",
      ]);
      expect(cursorsAskedFor(getConfigurations)).toEqual([]);
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    });

    it("after a delete, pages the reloaded list, never the old one's next page, so no row is skipped or mixed in", async () => {
      // Two to a page: before the delete, [4, 3] then [2, 1]; after it, [3, 2] then [1].
      const [c1, c2, c3, c4] = manyConfigurations(4);
      let deleted = false;
      const reloaded = deferred<ConfigurationsPage>();
      const oldNext = deferred<ConfigurationsPage>();
      const getConfigurations = serveList((_organizationId, { cursor }) => {
        if (cursor === "after-3") return oldNext.promise;
        if (cursor === "after-2") return page([c1!]);
        return deleted ? reloaded.promise : page([c4!, c3!], "after-3");
      });
      vi.spyOn(apiClient, "deleteConfiguration").mockImplementation(async () => {
        deleted = true;
        return undefined;
      });
      const { user } = renderPage();
      const card = (await screen.findByRole("heading", { level: 3, name: "Configuration 4" })).closest(
        "[role=button]",
      ) as HTMLElement;

      await user.click(within(card).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(getConfigurations).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      // Load more, clicked while the reload is under way, does nothing.
      const loadMore = screen.getByRole("button", { name: "Load more" });
      expect(loadMore).toBeDisabled();
      fireEvent.click(loadMore);
      await act(async () => reloaded.resolve(page([c3!, c2!], "after-2")));
      await act(async () => oldNext.resolve(page([c2!, c1!])));
      await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Configuration 4" })).toBeNull());

      await user.click(screen.getByRole("button", { name: "Load more" }));

      await waitFor(() =>
        expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
          "Configuration 3",
          "Configuration 2",
          "Configuration 1",
        ]),
      );
      expect(cursorsAskedFor(getConfigurations)).toEqual(["after-2"]);
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    });

    it("when a new filter's first page fails, keeps the old list, whose Load more pages it with its own query", async () => {
      const getConfigurations = serveList((_organizationId, { cursor, filter }) => {
        if (filter === "mine") throw new ApiError("internal_error", "Something went wrong. Please try again.");
        return cursor === undefined ? page([THEIRS], "cursor-all") : page([ORPHANED]);
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });

      await chooseFilter(user, "Mine");
      await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to load configuration"));
      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "mine" });

      // All's list is still shown, and its Load more isn't left disabled.
      expect(screen.getByRole("heading", { level: 3, name: "Staging Logs" })).toBeInTheDocument();
      const loadMore = screen.getByRole("button", { name: "Load more" });
      expect(loadMore).toBeEnabled();
      await user.click(loadMore);

      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "all", cursor: "cursor-all" });
      expect(await screen.findByRole("heading", { level: 3, name: "Left Behind" })).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
        "Staging Logs",
        "Left Behind",
      ]);
    });

    it("when the reload after a delete fails, keeps the list, and Load more still pages it", async () => {
      let deleted = false;
      const getConfigurations = serveList((_organizationId, { cursor }) => {
        if (cursor !== undefined) return page([ORPHANED]);
        if (deleted) throw new ApiError("internal_error", "Something went wrong. Please try again.");
        return page([MINE, THEIRS], "cursor-1");
      });
      vi.spyOn(apiClient, "deleteConfiguration").mockImplementation(async () => {
        deleted = true;
        return undefined;
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      const card = (await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).closest(
        "[role=button]",
      ) as HTMLElement;

      await user.click(within(card).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to load configuration"));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(getConfigurations).toHaveBeenCalledTimes(2);

      const loadMore = screen.getByRole("button", { name: "Load more" });
      await waitFor(() => expect(loadMore).toBeEnabled());
      await user.click(loadMore);

      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "all", cursor: "cursor-1" });
      expect(await screen.findByRole("heading", { level: 3, name: "Left Behind" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
    });

    it("toasts the failure message when the next page fails, and keeps the list", async () => {
      serveList((_organizationId, { cursor }) => {
        if (cursor !== undefined) throw new ApiError("internal_error", "Something went wrong. Please try again.");
        return page([MINE], "cursor-1");
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

      await user.click(screen.getByRole("button", { name: "Load more" }));

      await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to load configuration"));
      expect(screen.getByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    });

    it("toasts nothing when the next page finds the session over (401 unauthenticated), and keeps the list", async () => {
      const getConfigurations = serveList((_organizationId, { cursor }) => {
        if (cursor !== undefined) throw new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
        return page([MINE], "cursor-1");
      });
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

      await user.click(screen.getByRole("button", { name: "Load more" }));

      await waitFor(() => expect(getConfigurations).toHaveBeenCalledTimes(2));
      // Answered: Load more is no longer under way.
      await waitFor(() => expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled());
      expect(error).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
    });
  });

  describe("search and filter", () => {
    it("sends the search 300 ms after the last keystroke, and not before", async () => {
      const getConfigurations = serveList(() => page([MINE]));
      renderPage();
      const search = await screen.findByPlaceholderText("Search configurations…");
      expect(getConfigurations).toHaveBeenCalledTimes(1);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.change(search, { target: { value: "p" } });
      await act(() => vi.advanceTimersByTimeAsync(200));
      fireEvent.change(search, { target: { value: "prod" } });
      await act(() => vi.advanceTimersByTimeAsync(299));
      expect(getConfigurations).toHaveBeenCalledTimes(1);

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(getConfigurations).toHaveBeenCalledTimes(2);
      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "prod", filter: "all" });
    });

    it("keeps the list shown while a search is under way, and the search box with it", async () => {
      const searched = deferred<ConfigurationsPage>();
      serveList((_organizationId, { q }) => (q === "" ? page([MINE, THEIRS]) : searched.promise));
      renderPage();
      const search = await screen.findByPlaceholderText("Search configurations…");

      fireEvent.change(search, { target: { value: "staging" } });
      await waitFor(() => expect(apiClient.getConfigurations).toHaveBeenCalledTimes(2));

      expect(screen.getByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Search configurations…")).toHaveValue("staging");
      await act(async () => searched.resolve(page([THEIRS])));
      await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Production Monitoring" })).toBeNull());
      expect(screen.getByRole("heading", { level: 3, name: "Staging Logs" })).toBeInTheDocument();
    });

    it("sends filter mine for Mine, at once, and starts over for All configurations", async () => {
      const getConfigurations = serveList((_organizationId, { filter }) => page(filter === "mine" ? [MINE] : [MINE, THEIRS]));
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });

      await chooseFilter(user, "Mine");

      await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Staging Logs" })).toBeNull());
      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "mine" });

      await chooseFilter(user, "All configurations");

      expect(await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).toBeInTheDocument();
      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter: "all" });
    });

    it.each([
      ["Mine", "mine"],
      ["Published", "published"],
      ["All configurations", "all"],
    ] as const)("sends %s's filter (%s) with the first page and with Load more's next", async (label, filter) => {
      const getConfigurations = serveList((_organizationId, query) => {
        if (query.cursor === undefined) return page([query.filter === "published" ? THEIRS : MINE], `cursor-${query.filter}`);
        return page([ORPHANED]);
      });
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });
      // All configurations is the default: it is chosen again after another.
      if (filter === "all") {
        await chooseFilter(user, "Published");
        await screen.findByRole("heading", { level: 3, name: "Staging Logs" });
      }

      await chooseFilter(user, label);

      await waitFor(() => expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter }));
      expect(screen.getByRole("combobox")).toHaveTextContent(label);
      const loadMore = await screen.findByRole("button", { name: "Load more" });
      await waitFor(() => expect(loadMore).toBeEnabled());
      await user.click(loadMore);

      expect(getConfigurations).toHaveBeenLastCalledWith(PERSONAL_ID, { q: "", filter, cursor: `cursor-${filter}` });
      expect(await screen.findByRole("heading", { level: 3, name: "Left Behind" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    });

    it("says Nothing matches your search or filter. for Published with none", async () => {
      serveList((_organizationId, { filter }) => page(filter === "published" ? [] : [MINE]));
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

      await chooseFilter(user, "Published");

      expect(await screen.findByText("Nothing matches your search or filter.")).toBeInTheDocument();
      expect(screen.queryByText("No configurations yet.")).toBeNull();
    });

    it("ignores an older response that arrives late", async () => {
      const late = deferred<ConfigurationsPage>();
      let allLoads = 0;
      const getConfigurations = serveList((_organizationId, { filter }) => {
        if (filter === "mine") return page([MINE]);
        allLoads += 1;
        return allLoads === 1 ? page([THEIRS]) : late.promise;
      });
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });
      await chooseFilter(user, "Mine");
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

      // All configurations asks again and hangs; Mine, chosen after it, answers first.
      await chooseFilter(user, "All configurations");
      await chooseFilter(user, "Mine");
      await waitFor(() => expect(getConfigurations).toHaveBeenCalledTimes(4));
      await act(async () => late.resolve(page([ORPHANED])));

      expect(screen.queryByRole("heading", { level: 3, name: "Left Behind" })).toBeNull();
      expect(screen.getByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
    });
  });

  describe("the organization", () => {
    it("starts over when the active organization changes, without a remount, and never shows the old one's list", async () => {
      const group = deferred<ConfigurationsPage>();
      const getConfigurations = serveList((organizationId) =>
        organizationId === PERSONAL_ID ? page([MINE]) : group.promise,
      );
      const { user, layoutLoader } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

      // A removal elsewhere: the next /me names another organization. The
      // sidebar's Configurations link revalidates the layout; the page stays.
      await user.click(screen.getByRole("link", { name: "Configurations" }));

      await waitFor(() => expect(getConfigurations).toHaveBeenLastCalledWith(GROUP_ID, { q: "", filter: "all" }));
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("heading", { level: 3, name: "Production Monitoring" })).toBeNull();
      expect(screen.getByText("Loading configurations…")).toBeInTheDocument();

      await act(async () => group.resolve(page([THEIRS])));
      expect(await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).toBeInTheDocument();
    });

    it("on a 404 organization_not_found, revalidates the layout and loads the session's organization, with no toast", async () => {
      const getConfigurations = serveList((organizationId) => {
        if (organizationId === PERSONAL_ID) throw new ApiError("organization_not_found", "Organization not found");
        return page([THEIRS]);
      });
      const error = vi.spyOn(toast, "error");
      const { layoutLoader } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);

      expect(await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      expect(getConfigurations).toHaveBeenLastCalledWith(GROUP_ID, { q: "", filter: "all" });
      expect(error).not.toHaveBeenCalled();
    });

    it("closes an open dialog when the active organization changes", async () => {
      const group = deferred<ConfigurationsPage>();
      const getConfigurations = serveList((organizationId) =>
        organizationId === PERSONAL_ID ? page([MINE, THEIRS]) : group.promise,
      );
      const { user } = renderPage([signedInMember(PERSONAL_ID), signedInMember(GROUP_ID)]);
      const card = (await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).closest(
        "[role=button]",
      ) as HTMLElement;
      await user.click(within(card).getByRole("button", { name: "Delete" }));
      expect(await screen.findByRole("dialog", { name: "Delete Configuration" })).toBeInTheDocument();

      // A removal elsewhere, seen when the layout revalidates (the sidebar's
      // link, behind the dialog; a click with no pointer press doesn't
      // dismiss the dialog itself).
      fireEvent.click(screen.getByRole("link", { name: "Configurations", hidden: true }));
      await waitFor(() => expect(getConfigurations).toHaveBeenLastCalledWith(GROUP_ID, { q: "", filter: "all" }));
      await act(async () => group.resolve(page([ORPHANED])));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(await screen.findByRole("heading", { level: 3, name: "Left Behind" })).toBeInTheDocument();
    });

    it("toasts the failure message when the list fails to load, and shows the empty list", async () => {
      serveList(() => {
        throw new ApiError("internal_error", "Something went wrong. Please try again.");
      });
      const error = vi.spyOn(toast, "error");
      renderPage();

      expect(await screen.findByText("No configurations yet.")).toBeInTheDocument();
      expect(error).toHaveBeenCalledWith("Failed to load configuration");
      expect(error).toHaveBeenCalledTimes(1);
    });

    it("toasts nothing when the session is over (401 unauthenticated): the session-ended handler, or Logout, has the page", async () => {
      serveList(() => {
        throw new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
      });
      const error = vi.spyOn(toast, "error");
      renderPage();

      expect(await screen.findByText("No configurations yet.")).toBeInTheDocument();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("the terms", () => {
    async function accept(user: ReturnType<typeof userEvent.setup>) {
      const dialog = await screen.findByRole("dialog", { name: "Updated Terms of Service" });
      await user.click(within(dialog).getByLabelText("I agree to the Terms of Service and Privacy Policy"));
      await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    }

    it("loads nothing while the terms need accepting, and loads once they are accepted", async () => {
      vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      const getConfigurations = serveList(() => page([MINE]));
      const { user } = renderPage([signedInMember(PERSONAL_ID, true), signedInMember(PERSONAL_ID, false)]);

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      expect(screen.getByText("Loading configurations…")).toBeInTheDocument();
      expect(getConfigurations).not.toHaveBeenCalled();

      await accept(user);

      expect(await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
      expect(getConfigurations).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("on a 403 terms_acceptance_required, revalidates the layout, waits for the dialog, and loads after Accept, with no toast", async () => {
      vi.spyOn(apiClient, "acceptTerms").mockResolvedValue(undefined);
      let termsAccepted = false;
      const getConfigurations = serveList(() => {
        if (!termsAccepted) {
          throw new ApiError("terms_acceptance_required", "Accept the current Terms of Service to continue.");
        }
        return page([MINE]);
      });
      const error = vi.spyOn(toast, "error");
      // /me said the terms were accepted, then the terms changed (a race).
      const { user, layoutLoader } = renderPage([
        signedInMember(PERSONAL_ID, false),
        signedInMember(PERSONAL_ID, true),
        signedInMember(PERSONAL_ID, false),
      ]);

      expect(await screen.findByRole("dialog", { name: "Updated Terms of Service" })).toBeInTheDocument();
      expect(layoutLoader).toHaveBeenCalledTimes(2);
      expect(getConfigurations).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Loading configurations…")).toBeInTheDocument();

      termsAccepted = true;
      await accept(user);

      expect(await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
      expect(getConfigurations).toHaveBeenCalledTimes(2);
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("opening a configuration", () => {
    it.each([
      ["a click on the card", async (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) => user.click(card)],
      [
        "Enter on the card",
        async (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) => {
          card.focus();
          await user.keyboard("{Enter}");
        },
      ],
      [
        "Space on the card",
        async (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) => {
          card.focus();
          await user.keyboard(" ");
        },
      ],
      [
        "the card's Edit",
        async (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) =>
          user.click(within(card).getByRole("button", { name: "Edit" })),
      ],
    ])("goes to /editor/{id} on %s", async (_how, open) => {
      serveList(() => page([MINE, THEIRS]));
      const { user } = renderPage();
      const card = (await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).closest(
        "[role=button]",
      ) as HTMLElement;

      await open(user, card);

      expect(await screen.findByText(`landed on /editor/${THEIRS.id}`)).toBeInTheDocument();
    });

    it("goes to /editor/{id} from the list's name, a button and not a link", async () => {
      window.localStorage.setItem(VIEW_MODE_KEY, "list");
      serveList(() => page([MINE, THEIRS]));
      const { user } = renderPage();

      const name = await screen.findByRole("button", { name: "Staging Logs" });
      expect(name.closest("a")).toBeNull();
      await user.click(name);
      expect(await screen.findByText(`landed on /editor/${THEIRS.id}`)).toBeInTheDocument();
    });

    it("goes to /editor/{id} from a row's Edit", async () => {
      window.localStorage.setItem(VIEW_MODE_KEY, "list");
      serveList(() => page([MINE, THEIRS]));
      const { user } = renderPage();
      const row = (await screen.findByRole("button", { name: "Production Monitoring" })).closest("tr")!;

      await user.click(within(row).getByRole("button", { name: "Edit" }));

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    });

    it("doesn't open from Delete, which asks to confirm instead", async () => {
      serveList(() => page([MINE, THEIRS]));
      const { user } = renderPage();
      const card = (await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).closest(
        "[role=button]",
      ) as HTMLElement;

      await user.click(within(card).getByRole("button", { name: "Delete" }));

      expect(await screen.findByRole("dialog", { name: "Delete Configuration" })).toHaveTextContent(
        'Are you sure you want to delete "Staging Logs"? This action cannot be undone.',
      );
      expect(screen.queryByText(/landed on/)).toBeNull();
    });
  });

  describe("creating and deleting", () => {
    it("creates from the header, and opens the new configuration's editor rather than reloading the list", async () => {
      const getConfigurations = serveList(() => page([THEIRS]));
      const createConfiguration = vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const { user } = renderPage();
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });

      await user.click(screen.getByRole("button", { name: "New configuration" }));
      await user.click(await screen.findByRole("button", { name: /Blank configuration/ }));
      await user.type(await screen.findByLabelText("Configuration Name"), "Production Monitoring{Enter}");

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
      // The catalogue's default distribution, preselected.
      expect(createConfiguration).toHaveBeenCalledWith(PERSONAL_ID, {
        name: "Production Monitoring",
        description: "",
        collectorDistribution: "otelcol-contrib",
      });
      expect(getConfigurations).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("creates from the empty state, and opens the new configuration's editor", async () => {
      serveList(() => page([]));
      vi.spyOn(apiClient, "createConfiguration").mockResolvedValue({ configuration: MINE });
      const { user } = renderPage();
      await screen.findByText("No configurations yet.");

      // The empty state's own button, after the header's.
      await user.click(screen.getAllByRole("button", { name: "New configuration" })[1]!);
      await user.click(await screen.findByRole("button", { name: /Blank configuration/ }));
      await user.type(await screen.findByLabelText("Configuration Name"), "Production Monitoring{Enter}");

      expect(await screen.findByText(`landed on /editor/${MINE.id}`)).toBeInTheDocument();
    });

    it("deletes someone else's configuration from its card, and reloads without it", async () => {
      let deleted = false;
      serveList(() => page(deleted ? [MINE] : [MINE, THEIRS]));
      const deleteConfiguration = vi.spyOn(apiClient, "deleteConfiguration").mockImplementation(async () => {
        deleted = true;
        return undefined;
      });
      const { user } = renderPage();
      const card = (await screen.findByRole("heading", { level: 3, name: "Staging Logs" })).closest(
        "[role=button]",
      ) as HTMLElement;

      await user.click(within(card).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Staging Logs" })).toBeNull());
      expect(deleteConfiguration).toHaveBeenCalledWith(PERSONAL_ID, THEIRS.id);
      expect(screen.getByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
    });
  });

  describe("who sees Delete", () => {
    /** The member as an admin of the group organization, not a contributor. */
    function signedInGroupAdmin(): CurrentUserResponse {
      const member = signedInMember(GROUP_ID);
      return { ...member, organization: { ...member.organization, role: "admin" } };
    }

    function cardOf(name: string): HTMLElement {
      return screen.getByRole("heading", { level: 3, name }).closest("[role=button]") as HTMLElement;
    }

    function rowOf(name: string): HTMLElement {
      return screen.getByRole("button", { name }).closest("tr")!;
    }

    it("hides Delete from a teammate, a contributor, on another member's published configuration, card and row, and shows it on their own", async () => {
      serveList(() => page([MINE, THEIRS, ORPHANED]));
      const { user } = renderPage([signedInMember(GROUP_ID)]);
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });

      expect(within(cardOf("Staging Logs")).queryByRole("button", { name: "Delete" })).toBeNull();
      expect(within(cardOf("Staging Logs")).getByRole("button", { name: "Edit" })).toBeInTheDocument();
      // One whose author is gone is an admin's alone.
      expect(within(cardOf("Left Behind")).queryByRole("button", { name: "Delete" })).toBeNull();
      expect(within(cardOf("Production Monitoring")).getByRole("button", { name: "Delete" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "List view" }));

      expect(within(rowOf("Staging Logs")).queryByRole("button", { name: "Delete" })).toBeNull();
      expect(within(rowOf("Left Behind")).queryByRole("button", { name: "Delete" })).toBeNull();
      expect(within(rowOf("Production Monitoring")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });

    it("shows Delete to the author, a contributor, on their own configuration once it is published, and it deletes", async () => {
      const published = { ...MINE, published: true };
      let deleted = false;
      serveList(() => page(deleted ? [THEIRS] : [published, THEIRS]));
      const deleteConfiguration = vi.spyOn(apiClient, "deleteConfiguration").mockImplementation(async () => {
        deleted = true;
        return undefined;
      });
      const { user } = renderPage([signedInMember(GROUP_ID)]);
      await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });

      await user.click(within(cardOf("Production Monitoring")).getByRole("button", { name: "Delete" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Production Monitoring" })).toBeNull());
      expect(deleteConfiguration).toHaveBeenCalledWith(GROUP_ID, MINE.id);
    });

    it("shows Delete to an admin on every configuration, another member's published one and an authorless one too, card and row", async () => {
      serveList(() => page([MINE, THEIRS, ORPHANED]));
      const { user } = renderPage([signedInGroupAdmin()]);
      await screen.findByRole("heading", { level: 3, name: "Staging Logs" });

      for (const name of ["Production Monitoring", "Staging Logs", "Left Behind"]) {
        expect(within(cardOf(name)).getByRole("button", { name: "Delete" })).toBeInTheDocument();
      }

      await user.click(screen.getByRole("button", { name: "List view" }));

      for (const name of ["Production Monitoring", "Staging Logs", "Left Behind"]) {
        expect(within(rowOf(name)).getByRole("button", { name: "Delete" })).toBeInTheDocument();
      }
    });
  });

  it("shows only the latest load's answer under StrictMode's double effects", async () => {
    // The first run's request hangs and answers last, with other items.
    const firstRun = deferred<ConfigurationsPage>();
    let calls = 0;
    const getConfigurations = serveList(() => {
      calls += 1;
      return calls === 1 ? firstRun.promise : page([MINE]);
    });
    renderPage([signedInMember()], { strict: true });

    expect(await screen.findByRole("heading", { level: 3, name: "Production Monitoring" })).toBeInTheDocument();
    expect(getConfigurations.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => firstRun.resolve(page([THEIRS])));

    // The first run's request was overtaken by the second's; its answer isn't shown.
    expect(screen.queryByRole("heading", { level: 3, name: "Staging Logs" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Production Monitoring",
    ]);
  });

  it("puts no name, description or email in any attribute, in the grid, the list or the delete dialog", async () => {
    serveList(() => page([MINE, THEIRS, ORPHANED]));
    const { user } = renderPage();
    await screen.findByRole("heading", { level: 3, name: "Production Monitoring" });
    const privateValues = [MINE, THEIRS, ORPHANED].flatMap((configuration) => [
      configuration.name,
      ...(configuration.description ? [configuration.description] : []),
      ...(configuration.createdBy ? [configuration.createdBy.email] : []),
    ]);

    function assertNoAttributeCarries() {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          for (const value of privateValues) {
            expect(`${element.tagName} ${attribute.name}="${attribute.value}"`).not.toContain(value);
          }
        }
      }
    }

    assertNoAttributeCarries();
    await user.click(screen.getByRole("button", { name: "List view" }));
    assertNoAttributeCarries();
    const row = screen.getByRole("button", { name: "Staging Logs" }).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Delete Configuration" });
    assertNoAttributeCarries();
  });
});
