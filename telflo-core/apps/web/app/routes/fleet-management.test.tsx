import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEETS_UNAVAILABLE_MESSAGE, type CurrentUserResponse, type FleetsPage } from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { maskSecret } from "~/components/secrets/SecretCopyBox.js";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation, useRevalidator } from "react-router";
import { toast } from "sonner";
import routes from "../routes.js";
import AppLayoutRoute, { shouldRevalidate, type AppLayoutData } from "./app-layout.js";
import FleetManagementRoute, { meta } from "./fleet-management.js";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, type FleetsQuery } from "~/lib/api-client.js";
import { FLEETS_POLL_INTERVAL_MS } from "~/lib/fleets.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import {
  attributesHolding,
  EMPTY_SUMMARY,
  expectNoAttributeHolds,
  fleet,
  expectNoAttributeHoldsInOpenTooltips,
  FLEET_ID,
  fleetCreated,
  fleetDetail,
  fleetsPage,
  manyFleets,
  populatedSummary,
} from "~/test/fleets.js";
import { UNKNOWN_OUTCOME_MESSAGE } from "~/components/fleets/NewFleetDialog.js";
import { Toaster } from "~/components/ui/sonner.js";

vi.mock("~/lib/api-client.server.js", () => ({ fetchCurrentUser: vi.fn() }));

/** Where a create's Done went: the fleet's page. */
function Landed() {
  return <p>landed on {useLocation().pathname}</p>;
}

/** A way to revalidate the layout, as a switch elsewhere would be seen. */
function Revalidate() {
  const { revalidate } = useRevalidator();
  return (
    <button type="button" onClick={() => void revalidate()}>
      Revalidate
    </button>
  );
}

/**
 * `/fleet-management` under the signed-in layout, as the app routes it. The
 * layout's loader answers each user in turn (the last one from then on).
 */
function renderPage(...currentUsers: CurrentUserResponse[]) {
  const answers = currentUsers.length > 0 ? [...currentUsers] : [signedInMember()];
  const Stub = createRoutesStub([
    {
      id: "routes/app-layout",
      Component: AppLayoutRoute as unknown as React.ComponentType,
      loader: (): AppLayoutData => ({ status: "signed_in", currentUser: (answers.length > 1 ? answers.shift() : answers[0])! }),
      shouldRevalidate,
      HydrateFallback: () => null,
      children: [
        {
          path: "/fleet-management",
          Component: () => (
            <>
              <FleetManagementRoute />
              <Revalidate />
            </>
          ),
        },
        { path: "/fleet-management/:fleetId", Component: Landed },
      ],
    },
  ]);
  render(<Stub initialEntries={["/fleet-management"]} />);
  return { user: userEvent.setup() };
}

type Lister = (organizationId: string, query: FleetsQuery) => FleetsPage | Promise<FleetsPage>;

/** The API's list, answered by `answer`. */
function serveFleets(answer: Lister) {
  return vi.spyOn(apiClient, "getFleets").mockImplementation(async (organizationId, query = {}) => answer(organizationId, query));
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

/**
 * Holds the zero timeouts set from now on (Radix's focus return as a dialog
 * closes is one) until `release` runs them, in order; any other timeout
 * goes on as set. A browser's usual order, a write's reload rendering its
 * rows before the close's deferred focus return, made certain.
 */
function holdZeroTimeouts() {
  const held: Array<() => void> = [];
  const setTimeoutAsSet = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: unknown, delay?: number, ...args: unknown[]) => {
    if (typeof handler === "function" && !delay) {
      held.push(() => handler(...args));
      return 0;
    }
    return setTimeoutAsSet(handler as () => void, delay, ...args);
  }) as unknown as typeof setTimeout);
  return {
    release: () => {
      spy.mockRestore();
      act(() => held.splice(0).forEach((run) => run()));
    },
  };
}

async function chooseFilter(user: ReturnType<typeof userEvent.setup>, label: "All fleets" | "Active" | "Archived") {
  await user.click(screen.getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: label }));
}

const UNAVAILABLE = () => new ApiError("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });

describe("the fleet list (/fleet-management)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserStore.getState().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  });

  it("is /fleet-management under the signed-in layout", () => {
    const layout = routes.find((route) => route.file === "routes/app-layout.tsx");
    expect(layout?.children?.find((route) => route.path === "fleet-management")?.file).toBe("routes/fleet-management.tsx");
  });

  it("has a fixed title, never a fleet's label", () => {
    expect(meta({} as Parameters<typeof meta>[0])).toEqual([{ title: "Fleets - Telflo" }]);
  });

  it('shows "Loading fleets…" until the first page answers, then the rows, under "Fleets" and the organization\'s name', async () => {
    const first = deferred<FleetsPage>();
    const getFleets = serveFleets(() => first.promise);
    renderPage(signedInMember(GROUP_ID));

    expect(await screen.findByText("Loading fleets…")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { level: 1, name: "Fleets" });
    // The organization's name beside the heading, as text (the sidebar's switcher names it too).
    expect(within(heading.parentElement as HTMLElement).getByText("Group")).toBeInTheDocument();
    await act(async () => first.resolve(fleetsPage([fleetDetail()])));

    expect(await screen.findByRole("link", { name: "edge-prod" })).toBeInTheDocument();
    expect(screen.queryByText("Loading fleets…")).toBeNull();
    // The header's New Fleet; no usage strip.
    expect(screen.getAllByRole("button", { name: "New Fleet" })).toHaveLength(1);
    // The first page: the organization's, every fleet, 50 of them.
    expect(getFleets).toHaveBeenCalledWith(GROUP_ID, { status: undefined, limit: 50, cursor: undefined }, expect.anything());
  });

  it('says a failed first load failed, with "Try again", never the onboarding card', async () => {
    let failing = true;
    serveFleets(() => {
      if (failing) throw UNAVAILABLE();
      return fleetsPage([fleetDetail()]);
    });
    const { user } = renderPage();

    expect(await screen.findByText("Failed to load fleets")).toBeInTheDocument();
    expect(screen.queryByText("Create your first fleet")).toBeNull();

    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "edge-prod" })).toBeInTheDocument();
    expect(screen.queryByText("Failed to load fleets")).toBeNull();
  });

  it("shows the first-run card for an organization with no fleet, its editor link at /app and two New Fleet buttons", async () => {
    serveFleets(() => fleetsPage([]));
    renderPage();

    expect(await screen.findByRole("heading", { name: "Create your first fleet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "editor" })).toHaveAttribute("href", "/app");
    // The header's and the card's.
    expect(screen.getAllByRole("button", { name: "New Fleet" })).toHaveLength(2);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it('filters by the API\'s status, "All fleets" first and the default, each filter with its own empty text', async () => {
    const getFleets = serveFleets((_organizationId, { status }) =>
      status === undefined ? fleetsPage([fleetDetail()]) : fleetsPage([]),
    );
    const { user } = renderPage();
    expect(await screen.findByRole("link", { name: "edge-prod" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveTextContent("All fleets");

    await chooseFilter(user, "Active");
    expect(await screen.findByText("No active fleets.")).toBeInTheDocument();
    expect(getFleets).toHaveBeenLastCalledWith(PERSONAL_ID, { status: "active", limit: 50, cursor: undefined }, expect.anything());
    expect(screen.queryByText("Create your first fleet")).toBeNull();

    await chooseFilter(user, "Archived");
    expect(await screen.findByText("No archived fleets.")).toBeInTheDocument();
    expect(getFleets).toHaveBeenLastCalledWith(PERSONAL_ID, { status: "archived", limit: 50, cursor: undefined }, expect.anything());

    await chooseFilter(user, "All fleets");
    expect(await screen.findByRole("link", { name: "edge-prod" })).toBeInTheDocument();
    expect(getFleets).toHaveBeenLastCalledWith(PERSONAL_ID, { status: undefined, limit: 50, cursor: undefined }, expect.anything());
  });

  it('offers the options in order: "All fleets", "Active", "Archived"', async () => {
    serveFleets(() => fleetsPage([fleetDetail()]));
    const { user } = renderPage();
    await screen.findByRole("link", { name: "edge-prod" });
    await user.click(screen.getByRole("combobox"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["All fleets", "Active", "Archived"]);
  });

  it('appends the next page on "Load more", disabled while it reads, and hides it at the end', async () => {
    const more = deferred<FleetsPage>();
    const getFleets = serveFleets((_organizationId, { cursor }) =>
      cursor === undefined ? fleetsPage(manyFleets(50), "cursor-2") : more.promise,
    );
    const { user } = renderPage();
    expect(await screen.findByRole("link", { name: "fleet-50" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    expect(getFleets).toHaveBeenLastCalledWith(PERSONAL_ID, { status: undefined, cursor: "cursor-2" }, expect.anything());

    await act(async () => more.resolve(fleetsPage(manyFleets(2, 51))));
    expect(await screen.findByRole("link", { name: "fleet-52" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(1 + 52);
    expect(screen.queryByRole("button", { name: /Load more|Loading…/ })).toBeNull();
  });

  it('disables "Load more" while a new filter\'s first page is read over the old rows', async () => {
    const active = deferred<FleetsPage>();
    serveFleets((_organizationId, { status }) => (status === "active" ? active.promise : fleetsPage(manyFleets(50), "cursor-2")));
    const { user } = renderPage();
    await screen.findByRole("link", { name: "fleet-1" });

    await chooseFilter(user, "Active");
    expect(screen.getByRole("button", { name: "Load more" })).toBeDisabled();
    await act(async () => active.resolve(fleetsPage([fleetDetail()])));
    expect(await screen.findByRole("link", { name: "edge-prod" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("updates a row from a poll, 15 seconds on, while the tab is visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    let polled = false;
    const getFleets = serveFleets(() =>
      fleetsPage([
        polled
          ? fleetDetail({
              summary: { ...EMPTY_SUMMARY, collectors: 1, online: 1, inSync: 1, lastSeenAt: new Date().toISOString() },
            })
          : fleetDetail(),
      ]),
    );
    renderPage();
    const row = (await screen.findByRole("link", { name: "edge-prod" })).closest("tr") as HTMLElement;
    expect(within(row).getAllByText("No collectors")).toHaveLength(2);

    polled = true;
    await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS - 1));
    expect(getFleets).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));

    await waitFor(() =>
      expect(within(screen.getByRole("link", { name: "edge-prod" }).closest("tr") as HTMLElement).getByText("1/1")).toBeInTheDocument(),
    );
    const updated = screen.getByRole("link", { name: "edge-prod" }).closest("tr") as HTMLElement;
    expect(within(updated).getByText("all in sync")).toBeInTheDocument();
    expect(within(updated).getByText(/seconds? ago$/)).toBeInTheDocument();
    expect(getFleets).toHaveBeenCalledTimes(2);
    expect(getFleets).toHaveBeenLastCalledWith(PERSONAL_ID, { status: undefined, limit: 50, cursor: undefined }, expect.anything());
  });

  it("works Last Seen and the Token badge out again at each poll, for the same fleet", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    const start = Date.parse("2026-10-14T12:00:00.000Z");
    vi.setSystemTime(start);
    // The same reply every time: last seen 5 seconds before the start, the current token expiring 8 days after it.
    const summary = {
      ...EMPTY_SUMMARY,
      collectors: 1,
      online: 1,
      inSync: 1,
      lastSeenAt: new Date(start - 5_000).toISOString(),
      rotateToken: { expiresAt: new Date(start + 8 * 86_400_000).toISOString(), graceEndsAt: null, validCount: 1 },
    };
    const getFleets = serveFleets(() => fleetsPage([fleetDetail({ summary })]));
    renderPage();
    const rowNow = async () => (await screen.findByRole("link", { name: "edge-prod" })).closest("tr") as HTMLElement;
    expect(within(await rowNow()).getByText("5 seconds ago")).toBeInTheDocument();
    expect(within(await rowNow()).getByRole("link", { name: "8d left (open the Tokens tab)" })).toBeInTheDocument();

    // Two days on, at the next poll, which answers the same fleet.
    vi.setSystemTime(start + 2 * 86_400_000 - FLEETS_POLL_INTERVAL_MS);
    await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
    await waitFor(() => expect(getFleets).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect(within(await rowNow()).getByText("2 days ago")).toBeInTheDocument());
    expect(within(await rowNow()).getByRole("link", { name: "6d left (open the Tokens tab)" })).toBeInTheDocument();
    expect(within(await rowNow()).queryByText("5 seconds ago")).toBeNull();
  });

  it("creates a fleet from the header's New Fleet, in the active organization, and Done opens its page", async () => {
    serveFleets(() => fleetsPage([fleetDetail()]));
    const create = vi.spyOn(apiClient, "createFleet").mockImplementation(async (_organizationId, request) => ({
      kind: "created",
      ...fleetCreated({ id: request.id!, label: request.label, type: request.type }),
    }));
    const { user } = renderPage(signedInMember(GROUP_ID));
    await screen.findByRole("link", { name: "edge-prod" });

    await user.click(screen.getByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    await user.type(await screen.findByLabelText("Name"), "edge-new");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    expect(await screen.findByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(GROUP_ID, expect.objectContaining({ label: "edge-new", type: "server" }), expect.anything());
    // The tokens step holds no label in an attribute either.
    for (const element of document.documentElement.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toContain("edge-new");
      }
    }

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(`landed on /fleet-management/${create.mock.calls[0]![1].id}`)).toBeInTheDocument();
  });

  it("reloads the list when a create dialog closes after an unknown outcome, from the empty state's New Fleet too", async () => {
    const getFleets = serveFleets(() => fleetsPage([]));
    vi.spyOn(apiClient, "createFleet").mockRejectedValue(UNAVAILABLE());
    const { user } = renderPage();
    await screen.findByRole("heading", { name: "Create your first fleet" });
    expect(getFleets).toHaveBeenCalledTimes(1);

    // The empty state's button, the second of the two.
    await user.click(screen.getAllByRole("button", { name: "New Fleet" })[1]!);
    await user.click(await screen.findByText("Kubernetes (Helm)"));
    await user.type(await screen.findByLabelText("Name"), "prod-cluster");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    await screen.findByText(UNKNOWN_OUTCOME_MESSAGE);
    expect(getFleets).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(getFleets).toHaveBeenCalledTimes(2));
    expect(getFleets).toHaveBeenLastCalledWith(PERSONAL_ID, { status: undefined, limit: 50, cursor: undefined }, expect.anything());
  });

  it("keeps a create dialog, and its bearers, when a read lands mid-create and the empty state it opened from goes", async () => {
    const active = deferred<FleetsPage>();
    serveFleets((_organizationId, { status }) => (status === "active" ? active.promise : fleetsPage([])));
    const create = vi.spyOn(apiClient, "createFleet").mockImplementation(async (_organizationId, request) => ({
      kind: "created",
      ...fleetCreated({ id: request.id!, label: request.label, type: request.type }),
    }));
    const { user } = renderPage();
    await screen.findByRole("heading", { name: "Create your first fleet" });

    // The filter changed, its read held: the empty state stays meanwhile.
    await chooseFilter(user, "Active");
    expect(screen.getByRole("heading", { name: "Create your first fleet" })).toBeInTheDocument();

    // New Fleet from the empty state, the fleet created and its tokens shown.
    await user.click(screen.getAllByRole("button", { name: "New Fleet" })[1]!);
    await user.click(await screen.findByText("Linux servers & VMs"));
    await user.type(await screen.findByLabelText("Name"), "edge-new");
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    expect(await screen.findByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    const bearers = [fleetCreated().tokens.default.bearer, fleetCreated().tokens.rotate.bearer];
    for (const bearer of bearers) expect(screen.getByText(maskSecret(bearer))).toBeInTheDocument();

    // The held read lands: the empty state goes, the dialog and its bearers stay.
    await act(async () => active.resolve(fleetsPage([])));
    expect(await screen.findByText("No active fleets.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create your first fleet", hidden: true })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    for (const bearer of bearers) expect(screen.getByText(maskSecret(bearer))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText(`landed on /fleet-management/${create.mock.calls[0]![1].id}`)).toBeInTheDocument();
  });

  it("holds no fleet's label in any attribute of the page, dialogs closed, every row's tooltip opened in turn", async () => {
    const canary = "canary-label-93c1";
    const now = Date.now();
    serveFleets(() =>
      fleetsPage([
        fleetDetail({ label: canary, summary: populatedSummary(now) }),
        fleetDetail({
          id: "5f607182-93a4-45b6-8c7d-8e9fa0b1c2d3",
          label: `${canary}-archived`,
          status: "archived",
          summary: populatedSummary(now),
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByRole("link", { name: canary })).toBeInTheDocument();
    // The label is there, as text (which replay masks: the shell is ph-mask).
    expect(document.body.textContent).toContain(canary);
    expect(screen.getByRole("link", { name: canary })).toHaveAttribute("href", `/fleet-management/${FLEET_ID}`);

    expectNoAttributeHolds(canary);
    // Online, Configuration Sync, Token and Last Seen, in both rows.
    expect(await expectNoAttributeHoldsInOpenTooltips(canary, screen.getByRole("table"))).toBe(8);
  });
  // The label canary with each dialog open, the create's tokens step, and
  // the label's two toasts shown (the root's Toaster, mounted beside the
  // page). Only an open Name input's value may hold it.
  it("holds no fleet's label in any attribute with Archive, Unarchive, Delete or the tokens step open, nor in the delete's and create's toasts", async () => {
    const canary = "canary-label-7e2a";
    const ARCHIVED_ID = "5f607182-93a4-45b6-8c7d-8e9fa0b1c2d3";
    let deleted = false;
    serveFleets(() =>
      fleetsPage([
        ...(deleted ? [] : [fleetDetail({ label: canary, summary: populatedSummary(Date.now()) })]),
        fleetDetail({ id: ARCHIVED_ID, label: `${canary}-archived`, status: "archived" }),
      ]),
    );
    vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
      deleted = true;
    });
    vi.spyOn(apiClient, "createFleet").mockImplementation(async (_organizationId, request) => ({
      kind: "created",
      ...fleetCreated({ id: request.id!, label: request.label, type: request.type }),
    }));
    render(<Toaster theme="dark" />);
    const { user } = renderPage(signedInMember(GROUP_ID));
    await screen.findByRole("link", { name: canary });
    expectNoAttributeHolds(canary);

    const closeAlert = async () => {
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    };
    await user.click(screen.getByRole("button", { name: `Archive ${canary}` }));
    expect(await screen.findByRole("alertdialog", { name: "Archive fleet" })).toHaveTextContent(`Archive ${canary}?`);
    expectNoAttributeHolds(canary);
    await closeAlert();
    await user.click(screen.getByRole("button", { name: `Unarchive ${canary}-archived` }));
    expect(await screen.findByRole("alertdialog", { name: "Unarchive fleet" })).toHaveTextContent(`Unarchive ${canary}-archived?`);
    expectNoAttributeHolds(canary);
    await closeAlert();
    await user.click(screen.getByRole("button", { name: `Delete ${canary}` }));
    expect(await screen.findByRole("alertdialog", { name: "Delete fleet" })).toHaveTextContent(`You are permanently deleting ${canary}.`);
    expectNoAttributeHolds(canary);
    await closeAlert();

    // Rename's open Name: its value, and nothing else.
    await user.click(screen.getByRole("button", { name: `Rename ${canary}` }));
    expect(await screen.findByLabelText("Name")).toHaveValue(canary);
    expect(attributesHolding(canary)).toEqual(["INPUT value"]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expectNoAttributeHolds(canary);

    // The delete's toast names the fleet, as text.
    await user.click(screen.getByRole("button", { name: `Delete ${canary}` }));
    await user.click(await screen.findByRole("button", { name: "Delete fleet" }));
    expect(await screen.findByText(`Deleted fleet ${canary}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link", { name: canary })).toBeNull());
    expectNoAttributeHolds(canary);

    // The create's form holds it in the Name's value only; the tokens step and its toast in no attribute.
    await user.click(screen.getByRole("button", { name: "New Fleet" }));
    await user.click(await screen.findByText("Linux servers & VMs"));
    await user.type(await screen.findByLabelText("Name"), `${canary}-new`);
    expect(attributesHolding(canary)).toEqual(["INPUT value"]);
    await user.click(screen.getByRole("button", { name: "Create fleet" }));
    expect(await screen.findByRole("dialog", { name: "Fleet created" })).toBeInTheDocument();
    expect(await screen.findByText(`Fleet "${canary}-new" created`)).toBeInTheDocument();
    expectNoAttributeHolds(canary);
  });

  // The chooser and the create dialogs have no Radix trigger.
  describe("the focus as the create flow closes", () => {
    const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
    const newFleet = (index: number) => () => screen.getAllByRole("button", { name: "New Fleet" })[index]!;

    it.each([["Escape"], ["Cancel"]] as const)("returns to the header's New Fleet after the chooser closes by %s", async (how) => {
      serveFleets(() => fleetsPage([fleetDetail()]));
      const { user } = renderPage();
      await screen.findByRole("link", { name: "edge-prod" });

      await user.click(newFleet(0)());
      const chooser = await screen.findByRole("dialog", { name: "Create a new fleet" });
      if (how === "Escape") await user.keyboard("{Escape}");
      else await user.click(within(chooser).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await focusIsOn(newFleet(0));
    });

    // The server dialog's, and (the follow-up's) the Kubernetes one's: each create dialog gives the focus back itself.
    it.each([
      ["Linux servers & VMs", "New server fleet", "Escape"],
      ["Linux servers & VMs", "New server fleet", "Cancel"],
      ["Kubernetes (Helm)", "New Kubernetes Supervisor Fleet", "Escape"],
      ["Kubernetes (Helm)", "New Kubernetes Supervisor Fleet", "Cancel"],
    ] as const)(
      "hands the empty state's New Fleet from the chooser to the %s create dialog (%s), whose close by %s returns there",
      async (type, title, how) => {
        serveFleets(() => fleetsPage([]));
        const { user } = renderPage();
        await screen.findByRole("heading", { name: "Create your first fleet" });

        await user.click(newFleet(1)());
        await user.click(await screen.findByText(type));
        const create = await screen.findByRole("dialog", { name: title });
        // The chooser's close leaves the focus in the create dialog.
        await waitFor(() => expect(create).toContainElement(document.activeElement as HTMLElement));
        if (how === "Escape") await user.keyboard("{Escape}");
        else await user.click(within(create).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await focusIsOn(newFleet(1));
      },
    );

    // In the create flow, the dialog closes at once, focus back on the
    // empty state's New Fleet, and the reload its unknown outcome started
    // lands later with the fleet made.
    it("goes to the header's New Fleet once a create closed after an unknown outcome has its reload take the empty state away", async () => {
      let made = false;
      const reload = deferred<FleetsPage>();
      serveFleets(() => (made ? reload.promise : fleetsPage([])));
      vi.spyOn(apiClient, "createFleet").mockImplementation(async () => {
        made = true;
        throw UNAVAILABLE();
      });
      const { user } = renderPage();
      await screen.findByRole("heading", { name: "Create your first fleet" });

      await user.click(newFleet(1)());
      await user.click(await screen.findByText("Linux servers & VMs"));
      await user.type(await screen.findByLabelText("Name"), "edge-new");
      await user.click(screen.getByRole("button", { name: "Create fleet" }));
      await screen.findByText(UNKNOWN_OUTCOME_MESSAGE);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      // Closed, the reload held: back on the empty state's New Fleet.
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await focusIsOn(newFleet(1));

      await act(async () => reload.resolve(fleetsPage([fleetDetail()])));
      await screen.findByRole("link", { name: "edge-prod" });
      expect(screen.getAllByRole("button", { name: "New Fleet" })).toHaveLength(1);
      await focusIsOn(newFleet(0));
    });

    // A read begun before the create's reload (a poll's) answering as the dialog closes never spends it.
    it("goes to the header's New Fleet when a poll sent before the create opened answers as it closes after an unknown outcome, and the reload, late, takes the empty state away", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      let calls = 0;
      const pollHeld = deferred<FleetsPage>();
      const reloadHeld = deferred<FleetsPage>();
      serveFleets(() => {
        calls += 1;
        if (calls === 1) return fleetsPage([]);
        return calls === 2 ? pollHeld.promise : reloadHeld.promise;
      });
      vi.spyOn(apiClient, "createFleet").mockRejectedValue(UNAVAILABLE());
      const { user } = renderPage();
      await screen.findByRole("heading", { name: "Create your first fleet" });
      await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
      expect(calls).toBe(2);

      await user.click(newFleet(1)());
      await user.click(await screen.findByText("Linux servers & VMs"));
      await user.type(await screen.findByLabelText("Name"), "edge-new");
      await user.click(screen.getByRole("button", { name: "Create fleet" }));
      await screen.findByText(UNKNOWN_OUTCOME_MESSAGE);
      // The poll, the list still empty, answers; its rows render with the close, the reload begun after it.
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await act(async () => {
        pollHeld.resolve(fleetsPage([]));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        cancel.click();
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(calls).toBe(3);
      // Radix's focus return, a zero timeout set as the dialog unmounted, runs before one set now.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      expect(document.activeElement).toBe(newFleet(1)());

      await act(async () => reloadHeld.resolve(fleetsPage([fleetDetail()])));
      await screen.findByRole("link", { name: "edge-prod" });
      expect(screen.getAllByRole("button", { name: "New Fleet" })).toHaveLength(1);
      await focusIsOn(newFleet(0));
    });

    // A browser's usual order: the reload's rows before the close's deferred focus return. They spend the unknown outcome.
    it("spends a create's unknown outcome on its reload rendered before the close's focus return: a later poll taking the empty state away never moves the focus", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      let made = false;
      const getFleets = serveFleets(() => fleetsPage(made ? [fleetDetail()] : []));
      vi.spyOn(apiClient, "createFleet").mockRejectedValue(UNAVAILABLE());
      const { user } = renderPage();
      await screen.findByRole("heading", { name: "Create your first fleet" });

      await user.click(newFleet(1)());
      await user.click(await screen.findByText("Linux servers & VMs"));
      await user.type(await screen.findByLabelText("Name"), "edge-new");
      await user.click(screen.getByRole("button", { name: "Create fleet" }));
      await screen.findByText(UNKNOWN_OUTCOME_MESSAGE);
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const reads = getFleets.mock.calls.length;
      const focusReturn = holdZeroTimeouts();
      await act(async () => cancel.click());
      // Closed and read again (still empty), the focus not yet given back.
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(getFleets).toHaveBeenCalledTimes(reads + 1);
      expect(document.activeElement).toBe(document.body);
      focusReturn.release();
      expect(document.activeElement).toBe(newFleet(1)());
      act(() => (document.activeElement as HTMLElement).blur());

      // Made after all: the next poll's list has it, and the empty state goes.
      made = true;
      await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
      await screen.findByRole("link", { name: "edge-prod" });
      await act(async () => undefined);
      expect(document.activeElement).toBe(document.body);
    });

    it("goes to the header's New Fleet when the empty state's is gone as the create dialog closes", async () => {
      const active = deferred<FleetsPage>();
      serveFleets((_organizationId, { status }) => (status === "active" ? active.promise : fleetsPage([])));
      const { user } = renderPage();
      await screen.findByRole("heading", { name: "Create your first fleet" });
      await chooseFilter(user, "Active");

      await user.click(newFleet(1)());
      await user.click(await screen.findByText("Linux servers & VMs"));
      await screen.findByRole("dialog", { name: "New server fleet" });
      await act(async () => active.resolve(fleetsPage([])));
      expect(await screen.findByText("No active fleets.")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await focusIsOn(newFleet(0));
    });
  });

  describe("a row's Rename, Archive, Unarchive and Delete", () => {
    const OTHER_ID = "5f607182-93a4-45b6-8c7d-8e9fa0b1c2d3";
    const rowOf = (label: string) => screen.getByRole("link", { name: label }).closest("tr") as HTMLElement;

    it("opens each dialog for its row's fleet", async () => {
      serveFleets(() => fleetsPage([fleetDetail(), fleetDetail({ id: OTHER_ID, label: "edge-dev", status: "archived" })]));
      const { user } = renderPage();
      await screen.findByRole("link", { name: "edge-prod" });

      await user.click(screen.getByRole("button", { name: "Rename edge-dev" }));
      expect(await screen.findByLabelText("Name")).toHaveValue("edge-dev");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await user.click(screen.getByRole("button", { name: "Archive edge-prod" }));
      expect(await screen.findByRole("alertdialog", { name: "Archive fleet" })).toHaveTextContent("Archive edge-prod?");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

      await user.click(screen.getByRole("button", { name: "Unarchive edge-dev" }));
      expect(await screen.findByRole("alertdialog", { name: "Unarchive fleet" })).toHaveTextContent("Unarchive edge-dev?");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

      await user.click(screen.getByRole("button", { name: "Delete edge-dev" }));
      expect(await screen.findByRole("alertdialog", { name: "Delete fleet" })).toHaveTextContent("You are permanently deleting edge-dev.");
    });

    it("archives a row's fleet, and the list reloads with its badge", async () => {
      let status: "active" | "archived" = "active";
      const getFleets = serveFleets(() => fleetsPage([fleetDetail({ status })]));
      const update = vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
        status = request.status!;
        return fleet({ status });
      });
      const { user } = renderPage(signedInMember(GROUP_ID));
      await screen.findByRole("link", { name: "edge-prod" });
      expect(within(rowOf("edge-prod")).queryByText("Archived")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Archive edge-prod" }));
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive" }));

      await waitFor(() => expect(within(rowOf("edge-prod")).getByText("Archived")).toBeInTheDocument());
      expect(update).toHaveBeenCalledWith(GROUP_ID, FLEET_ID, { status: "archived" }, expect.anything());
      expect(getFleets).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Unarchive edge-prod" })).toBeInTheDocument();
    });

    it("deletes a row's fleet: toasts, and the list reloads without it", async () => {
      let deleted = false;
      const getFleets = serveFleets(() =>
        fleetsPage(deleted ? [fleetDetail({ id: OTHER_ID, label: "edge-dev" })] : [fleetDetail(), fleetDetail({ id: OTHER_ID, label: "edge-dev" })]),
      );
      const deleteFleet = vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
        deleted = true;
        return undefined;
      });
      const success = vi.spyOn(toast, "success");
      const { user } = renderPage();
      await screen.findByRole("link", { name: "edge-prod" });

      await user.click(screen.getByRole("button", { name: "Delete edge-prod" }));
      await user.click(await screen.findByRole("button", { name: "Delete fleet" }));

      await waitFor(() => expect(screen.queryByRole("link", { name: "edge-prod" })).toBeNull());
      expect(deleteFleet).toHaveBeenCalledWith(PERSONAL_ID, FLEET_ID, expect.anything());
      expect(success).toHaveBeenCalledWith("Deleted fleet edge-prod");
      expect(getFleets).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("link", { name: "edge-dev" })).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("on a delete's 503, toasts it, closes and reloads the list, which may still show the fleet", async () => {
      const getFleets = serveFleets(() => fleetsPage([fleetDetail()]));
      vi.spyOn(apiClient, "deleteFleet").mockRejectedValue(UNAVAILABLE());
      const error = vi.spyOn(toast, "error");
      const { user } = renderPage();
      await screen.findByRole("link", { name: "edge-prod" });

      await user.click(screen.getByRole("button", { name: "Delete edge-prod" }));
      await user.click(await screen.findByRole("button", { name: "Delete fleet" }));

      await waitFor(() => expect(getFleets).toHaveBeenCalledTimes(2));
      expect(error).toHaveBeenCalledWith(FLEETS_UNAVAILABLE_MESSAGE);
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByRole("link", { name: "edge-prod" })).toBeInTheDocument();
    });

    // No dialog here has a Radix trigger.
    describe("the focus as a row's dialog closes", () => {
      const focusIsOn = async (element: () => HTMLElement) => waitFor(() => expect(document.activeElement).toBe(element()));
      const headerNewFleet = () => screen.getAllByRole("button", { name: "New Fleet" })[0]!;

      it.each([
        ["Rename edge-prod", "dialog", "Escape"],
        ["Rename edge-prod", "dialog", "Cancel"],
        ["Archive edge-prod", "alertdialog", "Escape"],
        ["Archive edge-prod", "alertdialog", "Cancel"],
        ["Unarchive edge-dev", "alertdialog", "Cancel"],
        ["Delete edge-prod", "alertdialog", "Escape"],
        ["Delete edge-prod", "alertdialog", "Cancel"],
      ] as const)("returns to %s after its %s closes by %s", async (name, role, how) => {
        serveFleets(() => fleetsPage([fleetDetail(), fleetDetail({ id: OTHER_ID, label: "edge-dev", status: "archived" })]));
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });

        await user.click(screen.getByRole("button", { name }));
        const dialog = await screen.findByRole(role);
        if (how === "Escape") await user.keyboard("{Escape}");
        else await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
        await focusIsOn(() => screen.getByRole("button", { name }));
      });

      it("returns to the row's Rename after a rename, named for the new label", async () => {
        let label = "edge-prod";
        serveFleets(() => fleetsPage([fleetDetail({ label })]));
        vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
          label = request.label!;
          return fleet({ label });
        });
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });

        await user.click(screen.getByRole("button", { name: "Rename edge-prod" }));
        const name = await screen.findByLabelText("Name");
        await user.clear(name);
        await user.type(name, "edge-renamed");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByRole("link", { name: "edge-renamed" });
        await focusIsOn(() => screen.getByRole("button", { name: "Rename edge-renamed" }));
      });

      it("returns to the row's status button after an archive under All fleets, now its Unarchive", async () => {
        let status: "active" | "archived" = "active";
        serveFleets(() => fleetsPage([fleetDetail({ status })]));
        vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
          status = request.status!;
          return fleet({ status });
        });
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });

        await user.click(screen.getByRole("button", { name: "Archive edge-prod" }));
        await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive" }));

        await focusIsOn(() => screen.getByRole("button", { name: "Unarchive edge-prod" }));
      });

      it("goes to the header's New Fleet after an archive under Active takes the row out of the list", async () => {
        let status: "active" | "archived" = "active";
        serveFleets((_organizationId, query) => fleetsPage(query.status === "active" && status === "archived" ? [] : [fleetDetail({ status })]));
        vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
          status = request.status!;
          return fleet({ status });
        });
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });
        await chooseFilter(user, "Active");
        await screen.findByRole("link", { name: "edge-prod" });

        await user.click(screen.getByRole("button", { name: "Archive edge-prod" }));
        await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive" }));

        await screen.findByText("No active fleets.");
        await focusIsOn(headerNewFleet);
      });

      // The follow-up: a close with no write leaves the focus to the person, even when a poll then takes the row away.
      it("never moves the focus when a poll takes away the row an Escape (no write) went back to", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        let gone = false;
        serveFleets(() => fleetsPage(gone ? [fleetDetail({ id: OTHER_ID, label: "edge-dev" })] : [fleetDetail(), fleetDetail({ id: OTHER_ID, label: "edge-dev" })]));
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });

        await user.click(screen.getByRole("button", { name: "Delete edge-prod" }));
        await screen.findByRole("alertdialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await focusIsOn(() => screen.getByRole("button", { name: "Delete edge-prod" }));
        act(() => (document.activeElement as HTMLElement).blur());

        // Deleted elsewhere: the next poll's list lacks it.
        gone = true;
        await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
        await waitFor(() => expect(screen.queryByRole("link", { name: "edge-prod" })).toBeNull());
        await act(async () => undefined);
        expect(document.activeElement).toBe(document.body);
      });

      it("goes to the header's New Fleet after a delete, the row gone; and after the list's reload answered late", async () => {
        let deleted = false;
        let held: ReturnType<typeof deferred<FleetsPage>> | null = null;
        serveFleets(() => {
          const page = fleetsPage(deleted ? [fleetDetail({ id: OTHER_ID, label: "edge-dev" })] : [fleetDetail(), fleetDetail({ id: OTHER_ID, label: "edge-dev" })]);
          return held === null ? page : held.promise;
        });
        vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
          deleted = true;
          held = deferred<FleetsPage>();
          return undefined;
        });
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });

        await user.click(screen.getByRole("button", { name: "Delete edge-prod" }));
        await user.click(await screen.findByRole("button", { name: "Delete fleet" }));
        // Closed, the reload held: back on the row's Delete, the row still shown.
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await focusIsOn(() => screen.getByRole("button", { name: "Delete edge-prod" }));

        await act(async () => held!.resolve(fleetsPage([fleetDetail({ id: OTHER_ID, label: "edge-dev" })])));
        await waitFor(() => expect(screen.queryByRole("link", { name: "edge-prod" })).toBeNull());
        await focusIsOn(headerNewFleet);
      });

      // A poll's rows before the close never spend the delete's flag; its reload's do.
      it("goes to the header's New Fleet when a poll sent before the delete opened answers with it, and the reload, late, removes the row", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        const both = () => fleetsPage([fleetDetail(), fleetDetail({ id: OTHER_ID, label: "edge-dev" })]);
        let calls = 0;
        const pollHeld = deferred<FleetsPage>();
        const reloadHeld = deferred<FleetsPage>();
        serveFleets(() => {
          calls += 1;
          if (calls === 1) return both();
          return calls === 2 ? pollHeld.promise : reloadHeld.promise;
        });
        // The poll, still showing the row, answers as the delete does.
        vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
          pollHeld.resolve(both());
          await Promise.resolve();
          return undefined;
        });
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });
        await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
        expect(calls).toBe(2);

        await user.click(screen.getByRole("button", { name: "Delete edge-prod" }));
        await user.click(await screen.findByRole("button", { name: "Delete fleet" }));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await focusIsOn(() => screen.getByRole("button", { name: "Delete edge-prod" }));

        await act(async () => reloadHeld.resolve(fleetsPage([fleetDetail({ id: OTHER_ID, label: "edge-dev" })])));
        await waitFor(() => expect(screen.queryByRole("link", { name: "edge-prod" })).toBeNull());
        await focusIsOn(headerNewFleet);
      });

      // What counts is when a read began, not who asked for it: the person's own "Load more", sent before the delete, is no reload.
      it("goes to the header's New Fleet when a \"Load more\" sent before the delete opened answers with it, and the reload, late, removes the row", async () => {
        const more = deferred<FleetsPage>();
        const reloadHeld = deferred<FleetsPage>();
        let firstPages = 0;
        serveFleets((_organizationId, { cursor }) => {
          if (cursor !== undefined) return more.promise;
          firstPages += 1;
          return firstPages === 1 ? fleetsPage(manyFleets(50), "cursor-2") : reloadHeld.promise;
        });
        // "Load more", still showing the row, answers as the delete does.
        vi.spyOn(apiClient, "deleteFleet").mockImplementation(async () => {
          more.resolve(fleetsPage(manyFleets(2, 51)));
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
          return undefined;
        });
        const { user } = renderPage();
        await screen.findByRole("link", { name: "fleet-50" });
        await user.click(screen.getByRole("button", { name: "Load more" }));
        await user.click(screen.getByRole("button", { name: "Delete fleet-1" }));
        await user.click(await screen.findByRole("button", { name: "Delete fleet" }));
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await focusIsOn(() => screen.getByRole("button", { name: "Delete fleet-1" }));
        // "Load more"'s rows are shown before the reload answers.
        expect(screen.getByRole("link", { name: "fleet-52" })).toBeInTheDocument();
        expect(firstPages).toBe(2);

        await act(async () => reloadHeld.resolve(fleetsPage(manyFleets(51, 2))));
        await waitFor(() => expect(screen.queryByRole("link", { name: "fleet-1" })).toBeNull());
        await focusIsOn(headerNewFleet);
      });

      // A browser's usual order: the reload's rows before the close's deferred focus return. They spend the write.
      it("spends a rename's write on its reload rendered before the close's focus return: a later poll taking the row away never moves the focus", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        let label = "edge-prod";
        let gone = false;
        serveFleets(() =>
          fleetsPage(gone ? [fleetDetail({ id: OTHER_ID, label: "edge-dev" })] : [fleetDetail({ label }), fleetDetail({ id: OTHER_ID, label: "edge-dev" })]),
        );
        vi.spyOn(apiClient, "updateFleet").mockImplementation(async (_organizationId, _fleetId, request) => {
          label = request.label!;
          return fleet({ label });
        });
        const { user } = renderPage();
        await screen.findByRole("link", { name: "edge-prod" });

        await user.click(screen.getByRole("button", { name: "Rename edge-prod" }));
        const name = await screen.findByLabelText("Name");
        await user.clear(name);
        await user.type(name, "edge-renamed");
        const save = screen.getByRole("button", { name: "Save" });
        const focusReturn = holdZeroTimeouts();
        await act(async () => save.click());
        // Closed and reloaded, the focus not yet given back.
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByRole("link", { name: "edge-renamed" })).toBeInTheDocument();
        expect(document.activeElement).toBe(document.body);
        focusReturn.release();
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename edge-renamed" }));
        act(() => (document.activeElement as HTMLElement).blur());

        // Deleted elsewhere: the next poll's list lacks it.
        gone = true;
        await act(() => vi.advanceTimersByTimeAsync(FLEETS_POLL_INTERVAL_MS));
        await waitFor(() => expect(screen.queryByRole("link", { name: "edge-renamed" })).toBeNull());
        await act(async () => undefined);
        expect(document.activeElement).toBe(document.body);
      });
    });

    it("closes an open dialog when the active organization changes", async () => {
      const getFleets = serveFleets((organizationId) =>
        fleetsPage(organizationId === PERSONAL_ID ? [fleetDetail()] : [fleetDetail({ id: OTHER_ID, label: "group-fleet" })]),
      );
      const deleteFleet = vi.spyOn(apiClient, "deleteFleet");
      const { user } = renderPage(signedInMember(PERSONAL_ID), signedInMember(GROUP_ID));
      await screen.findByRole("link", { name: "edge-prod" });
      await user.click(screen.getByRole("button", { name: "Delete edge-prod" }));
      expect(await screen.findByRole("alertdialog", { name: "Delete fleet" })).toBeInTheDocument();

      // A switch elsewhere, seen when the layout revalidates (behind the dialog).
      fireEvent.click(screen.getByRole("button", { name: "Revalidate", hidden: true }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(await screen.findByRole("link", { name: "group-fleet" })).toBeInTheDocument();
      expect(getFleets).toHaveBeenLastCalledWith(GROUP_ID, { status: undefined, limit: 50, cursor: undefined }, expect.anything());
      expect(deleteFleet).not.toHaveBeenCalled();
    });
  });
});
