import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type Collector, type CollectorGroup, type CollectorGroupsResponse, type CollectorsPage, type FleetSummary } from "@telflo/contracts";
import type * as ReactRouter from "react-router";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED, type CollectorsQuery } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import {
  EMPTY_SUMMARY,
  FLEET_ID,
  GATEWAYS_GROUP_ID,
  collectorGroup,
  collectorsPage,
  gatewaysGroup,
  manyCollectors,
} from "~/test/fleets.js";
import {
  COLLECTORS_LOAD_FAILED_MESSAGE,
  COLLECTORS_PAGE_SIZE,
  DEFAULT_COLLECTORS_QUERY,
  useCollectorsPage,
} from "./collectors.js";
import { FLEET_READ_TIMEOUT_MS, FLEETS_POLL_INTERVAL_MS } from "./fleets.js";

// The hook outside a router: the layout's data as each test sets it (for
// the terms), and a revalidate that stays the same function, as the
// router's does.
const router = vi.hoisted(() => ({
  revalidate: vi.fn(() => Promise.resolve()),
  layoutData: undefined as unknown,
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useRouteLoaderData: () => router.layoutData,
  useRevalidator: () => ({ revalidate: router.revalidate, state: "idle" }),
}));

function refusal(code: string, message: string, options: { status?: number; retryAfterSeconds?: number; details?: unknown } = {}) {
  return new ApiError(code, message, options);
}

const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
const NO_CONNECTION = () => new ApiError("network_error", "Could not reach the server. Check your connection.");
const ORGANIZATION_GONE = () => refusal("organization_not_found", "Organization not found", { status: 404 });
const TERMS = () => refusal("terms_acceptance_required", "Accept the current Terms of Service to continue.", { status: 403 });
const SESSION_ENDED = () => refusal("unauthenticated", "You need to sign in.", { status: 401 });
const FLEET_GONE = () => refusal("fleet_not_found", "Fleet not found.", { status: 404 });
const RATE_LIMITED = (retryAfterSeconds: number) =>
  refusal("rate_limited", "Too many attempts. Please wait and try again.", { status: 429, retryAfterSeconds });
/** The platform's stale cursor (`modules/fleets/errors.ts`'s `invalidCursor`). */
const STALE_CURSOR = () =>
  refusal("invalid_request", "The list's cursor isn't valid: reload the list.", {
    status: 400,
    details: [
      {
        keyword: "custom",
        instancePath: "/cursor",
        schemaPath: "#/cursor/custom",
        params: { issue: { code: "custom", path: ["cursor"], message: "Not a cursor of this list's: reload the list." } },
        message: "Not a cursor of this list's: reload the list.",
      },
    ],
  });

const GROUPS: CollectorGroup[] = [collectorGroup(), gatewaysGroup()];

/** A fleet of 312 collectors (Sam's "edge-prod"). */
const SUMMARY: FleetSummary = { ...EMPTY_SUMMARY, collectors: 312 };

/** One call of the browser client, answered when the test says. */
interface PendingCall<Answer> {
  organizationId: string;
  fleetId: string;
  signal: AbortSignal | undefined;
  resolve: (answer: Answer) => void;
  reject: (error: unknown) => void;
}

/**
 * A read the test answers when it chooses. It ignores its AbortSignal, as a
 * reply already on its way would, unless `honourAbort`: then an abort
 * rejects it with REQUEST_ABORTED, as the client does.
 */
function pendingCall<Answer>(organizationId: string, fleetId: string, signal: AbortSignal | undefined, honourAbort: boolean) {
  let call!: PendingCall<Answer>;
  const promise = new Promise<Answer>((resolve, reject) => {
    call = { organizationId, fleetId, signal, resolve, reject };
  });
  if (honourAbort) {
    signal?.addEventListener("abort", () => call.reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
  }
  return { call, promise };
}

/** Every getCollectors and getCollectorGroups call, in order, each answered by the test. */
function serve({ honourAbort = false } = {}) {
  const pages: Array<PendingCall<CollectorsPage> & { query: CollectorsQuery }> = [];
  const groups: Array<PendingCall<CollectorGroupsResponse>> = [];
  vi.spyOn(apiClient, "getCollectors").mockImplementation((organizationId, fleetId, query = {}, options = {}) => {
    const { call, promise } = pendingCall<CollectorsPage>(organizationId, fleetId, options.signal, honourAbort);
    pages.push({ ...call, query });
    return promise;
  });
  vi.spyOn(apiClient, "getCollectorGroups").mockImplementation((organizationId, fleetId, options = {}) => {
    const { call, promise } = pendingCall<CollectorGroupsResponse>(organizationId, fleetId, options.signal, honourAbort);
    groups.push(call);
    return promise;
  });
  return { pages, groups, page: () => pages.at(-1)!, group: () => groups.at(-1)! };
}

type Served = ReturnType<typeof serve>;

/** Lets the promises settle and the timers run, as far as `milliseconds`. */
async function advance(milliseconds = 0): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

/** Answers the latest read: its page, and its groups (the fleet's two, unless given). */
async function answer(served: Served, page: CollectorsPage, groups: CollectorGroup[] = GROUPS): Promise<void> {
  served.page().resolve(page);
  served.group().resolve({ groups });
  await advance();
}

/** The query a read of page `cursor` sends, with nothing else asked. */
function plain(cursor?: string): CollectorsQuery {
  return { q: undefined, groupId: undefined, sort: undefined, order: undefined, limit: COLLECTORS_PAGE_SIZE, cursor };
}

let visibility: DocumentVisibilityState = "visible";
const onFleetGone = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  router.revalidate.mockClear();
  router.layoutData = undefined;
  onFleetGone.mockClear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  document.body.innerHTML = "";
  useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID));
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
});

function render(summary: FleetSummary = SUMMARY) {
  return renderHook(({ fleetId, summary: fleetSummary }) => useCollectorsPage(fleetId, fleetSummary, { onFleetGone }), {
    initialProps: { fleetId: FLEET_ID, summary },
  });
}

/** The hook with its first page answered: `rows` collectors, `nextCursor`, and the fleet's groups. */
async function loaded(page: CollectorsPage = collectorsPage(manyCollectors(50), "cursor-1"), summary: FleetSummary = SUMMARY) {
  const served = serve();
  const hook = render(summary);
  await advance();
  await answer(served, page);
  return { ...hook, served };
}

describe("useCollectorsPage", () => {
  it("reads page 1 of the active organization's fleet and its groups under one hang guard: 50, newest first, nothing asked", async () => {
    const served = serve();
    const { result } = render();
    expect(result.current.collectors).toBeNull();
    expect(result.current.personsRead).toBe(true);
    await advance();

    expect(served.pages).toHaveLength(1);
    expect(served.groups).toHaveLength(1);
    expect(served.page()).toMatchObject({ organizationId: PERSONAL_ID, fleetId: FLEET_ID, query: plain() });
    expect(served.group()).toMatchObject({ organizationId: PERSONAL_ID, fleetId: FLEET_ID });
    expect(served.page().signal).toBeInstanceOf(AbortSignal);
    expect(served.group().signal).toBe(served.page().signal);

    await answer(served, collectorsPage(manyCollectors(50), "cursor-1"));
    expect(result.current).toMatchObject({
      collectors: manyCollectors(50),
      groups: GROUPS,
      query: DEFAULT_COLLECTORS_QUERY,
      pageIndex: 0,
      hasPrev: false,
      hasNext: true,
      personsRead: false,
      failed: false,
    });
  });

  it("Next pushes the page's cursor and Prev pops it", async () => {
    const { result, served } = await loaded();

    act(() => result.current.next());
    expect(result.current.personsRead).toBe(true);
    await advance();
    expect(served.page().query).toEqual(plain("cursor-1"));
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));
    expect(result.current).toMatchObject({ pageIndex: 1, hasPrev: true, hasNext: true, collectors: manyCollectors(50, 51) });

    act(() => result.current.next());
    await advance();
    expect(served.page().query).toEqual(plain("cursor-2"));
    await answer(served, collectorsPage(manyCollectors(12, 101), null));
    expect(result.current).toMatchObject({ pageIndex: 2, hasNext: false });

    // The last page: nothing more to read.
    act(() => result.current.next());
    await advance();
    expect(served.pages).toHaveLength(3);

    act(() => result.current.prev());
    await advance();
    expect(served.page().query).toEqual(plain("cursor-1"));
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));
    expect(result.current).toMatchObject({ pageIndex: 1, collectors: manyCollectors(50, 51) });

    act(() => result.current.prev());
    await advance();
    expect(served.page().query).toEqual(plain());
    await answer(served, collectorsPage(manyCollectors(50), "cursor-1"));
    expect(result.current).toMatchObject({ pageIndex: 0, hasPrev: false });

    // The first page: nothing before it.
    act(() => result.current.prev());
    await advance();
    expect(served.pages).toHaveLength(5);

    // Next again reads the cursor the first page answered now, not one from before.
    act(() => result.current.reload());
    await advance();
    await answer(served, collectorsPage(manyCollectors(50), "cursor-1b"));
    act(() => result.current.next());
    await advance();
    expect(served.page().query).toEqual(plain("cursor-1b"));
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2b"));
    act(() => result.current.next());
    await advance();
    expect(served.page().query).toEqual(plain("cursor-2b"));
  });

  it("does nothing on Next or Prev while a person's read is under way", async () => {
    const { result, served } = await loaded();
    act(() => result.current.reload());
    act(() => result.current.next());
    act(() => result.current.prev());
    await advance();
    expect(served.pages).toHaveLength(2);
    expect(served.page().query).toEqual(plain());
  });

  it("says 'of {total}' from the fleet's summary only while nothing is searched or filtered, never below the last row shown", async () => {
    const { result, served, rerender } = await loaded(collectorsPage(manyCollectors(50), "cursor-1"), { ...SUMMARY, collectors: 60 });
    expect(result.current.pager).toEqual({ from: 1, to: 50, total: 60 });

    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));
    // 100 rows read while the summary says 60: never "51 to 100 of 60".
    expect(result.current.pager).toEqual({ from: 51, to: 100, total: 100 });
    rerender({ fleetId: FLEET_ID, summary: { ...SUMMARY, collectors: 312 } });
    expect(result.current.pager).toEqual({ from: 51, to: 100, total: 312 });

    act(() => result.current.search("web"));
    await advance();
    await answer(served, collectorsPage(manyCollectors(7)));
    expect(result.current.pager).toEqual({ from: 1, to: 7, total: null });

    act(() => result.current.search(""));
    await advance();
    await answer(served, collectorsPage(manyCollectors(50), "cursor-1"));
    expect(result.current.pager).toEqual({ from: 1, to: 50, total: 312 });

    act(() => result.current.filterByGroup(GATEWAYS_GROUP_ID));
    await advance();
    await answer(served, collectorsPage(manyCollectors(3)));
    expect(result.current.pager).toEqual({ from: 1, to: 3, total: null });

    // No rows, no pager: the empty states have none.
    act(() => result.current.search("nothing"));
    await advance();
    await answer(served, collectorsPage([]));
    expect(result.current.collectors).toEqual([]);
    expect(result.current.pager).toBeNull();
  });

  it("reads page 1 for a search (trimmed), a filter and a sort, each keeping the others", async () => {
    const { result, served } = await loaded();
    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));
    expect(result.current.pageIndex).toBe(1);

    act(() => result.current.search("  10.0.4 "));
    await advance();
    expect(served.page().query).toEqual({ ...plain(), q: "10.0.4" });
    await answer(served, collectorsPage(manyCollectors(7)));
    expect(result.current).toMatchObject({ pageIndex: 0, query: { ...DEFAULT_COLLECTORS_QUERY, q: "10.0.4" } });

    act(() => result.current.filterByGroup(GATEWAYS_GROUP_ID));
    await advance();
    expect(served.page().query).toEqual({ ...plain(), q: "10.0.4", groupId: GATEWAYS_GROUP_ID });
    await answer(served, collectorsPage(manyCollectors(2), "g-1"));

    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(1, 3)));
    expect(result.current.pageIndex).toBe(1);

    act(() => result.current.sortBy("name"));
    await advance();
    expect(served.page().query).toEqual({ ...plain(), q: "10.0.4", groupId: GATEWAYS_GROUP_ID, sort: "name", order: "asc" });
    await answer(served, collectorsPage(manyCollectors(2)));
    expect(result.current.pageIndex).toBe(0);
    expect(result.current.query).toEqual({ q: "10.0.4", groupId: GATEWAYS_GROUP_ID, sort: "name", order: "asc" });

    // A second click alternates; another column starts ascending; never back to the default.
    act(() => result.current.sortBy("name"));
    await advance();
    expect(served.page().query).toMatchObject({ sort: "name", order: "desc" });
    await answer(served, collectorsPage(manyCollectors(2)));
    act(() => result.current.sortBy("name"));
    await advance();
    expect(served.page().query).toMatchObject({ sort: "name", order: "asc" });
    await answer(served, collectorsPage(manyCollectors(2)));
    act(() => result.current.sortBy("lastSeen"));
    await advance();
    expect(served.page().query).toMatchObject({ sort: "lastSeen", order: "asc" });
    await answer(served, collectorsPage(manyCollectors(2)));

    act(() => result.current.filterByGroup(null));
    await advance();
    expect(served.page().query).toEqual({ ...plain(), q: "10.0.4", sort: "lastSeen", order: "asc" });
  });

  it("starts a new query from the latest one asked for: a search while a filter's read is under way keeps the filter", async () => {
    const { result, served } = await loaded();
    act(() => result.current.filterByGroup(GATEWAYS_GROUP_ID));
    // The rows shown keep their own query until the read answers.
    expect(result.current.query).toEqual(DEFAULT_COLLECTORS_QUERY);
    act(() => result.current.search("web"));
    await advance();
    expect(served.page().query).toEqual({ ...plain(), q: "web", groupId: GATEWAYS_GROUP_ID });
    await answer(served, collectorsPage(manyCollectors(1)));
    expect(result.current.query).toEqual({ ...DEFAULT_COLLECTORS_QUERY, q: "web", groupId: GATEWAYS_GROUP_ID });
  });

  it("polls every 15 s, re-reading the page shown with its cursor, query and sort, and the groups, replacing the rows", async () => {
    const { result, served } = await loaded();
    act(() => result.current.sortBy("lastSeen"));
    await advance();
    await answer(served, collectorsPage(manyCollectors(50), "s-1"));
    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(50, 51), "s-2"));
    const before = served.pages.length;

    await advance(FLEETS_POLL_INTERVAL_MS - 1);
    expect(served.pages).toHaveLength(before);
    await advance(1);
    expect(served.pages).toHaveLength(before + 1);
    expect(served.groups).toHaveLength(before + 1);
    expect(served.page().query).toEqual({ ...plain("s-1"), sort: "lastSeen", order: "asc" });
    expect(result.current.personsRead).toBe(false);

    const renamedGroups = [collectorGroup(), gatewaysGroup({ name: "gateways-eu" })];
    await answer(served, collectorsPage(manyCollectors(49, 52), null), renamedGroups);
    expect(result.current).toMatchObject({ collectors: manyCollectors(49, 52), hasNext: false, pageIndex: 1, groups: renamedGroups });
  });

  // The review of 32f39ff: the tab's focus return tells rows from a read begun after a write by the read's number.
  it("numbers its rows by the read they came from, a person's or a poll's, and gives the latest read begun", async () => {
    const { result, served } = await loaded();
    const first = result.current.rowsRead;
    expect(first).toBeGreaterThan(0);
    expect(result.current.latestRead()).toBe(first);

    // Next begun: numbered above the rows shown, which keep their number until it answers.
    act(() => result.current.next());
    const next = result.current.latestRead();
    expect(next).toBeGreaterThan(first);
    expect(result.current.rowsRead).toBe(first);
    await advance();
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));
    expect(result.current.rowsRead).toBe(next);

    // A poll's rows carry the poll's number.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const polled = result.current.latestRead();
    expect(polled).toBeGreaterThan(next);
    expect(result.current.rowsRead).toBe(next);
    await answer(served, collectorsPage(manyCollectors(49, 52), "cursor-2"));
    expect(result.current).toMatchObject({ collectors: manyCollectors(49, 52), rowsRead: polled });

    // A reload's, its own.
    act(() => result.current.reload());
    const reloaded = result.current.latestRead();
    expect(reloaded).toBeGreaterThan(polled);
    await advance();
    await answer(served, collectorsPage(manyCollectors(48, 53), "cursor-2"));
    expect(result.current).toMatchObject({ collectors: manyCollectors(48, 53), rowsRead: reloaded });
  });

  it("drops a late answer: an older read answering after a newer one changes nothing", async () => {
    const served = serve();
    const { result } = render();
    await advance();
    const first = { page: served.page(), group: served.group() };

    act(() => result.current.reload());
    await advance();
    expect(served.pages).toHaveLength(2);
    expect(first.page.signal?.aborted).toBe(true);
    await answer(served, collectorsPage(manyCollectors(2, 10)));

    first.page.resolve(collectorsPage(manyCollectors(5, 100)));
    first.group.resolve({ groups: [collectorGroup()] });
    await advance();
    expect(result.current.collectors).toEqual(manyCollectors(2, 10));
    expect(result.current.groups).toEqual(GROUPS);
  });

  it("drops the old organization's answers on a switch, and starts over at page 1 with nothing asked", async () => {
    const { result, served } = await loaded();
    act(() => result.current.search("web"));
    await advance();
    await answer(served, collectorsPage(manyCollectors(3), "w-1"));
    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(1, 4)));

    // A poll in the old organization is under way when the switch comes.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const oldPoll = { page: served.page(), group: served.group() };
    expect(oldPoll.page.organizationId).toBe(PERSONAL_ID);

    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await advance();
    expect(oldPoll.page.signal?.aborted).toBe(true);
    expect(result.current).toMatchObject({ collectors: null, groups: null, pageIndex: 0, query: DEFAULT_COLLECTORS_QUERY, pager: null });
    expect(served.page().organizationId).toBe(GROUP_ID);
    expect(served.page().query).toEqual(plain());

    oldPoll.page.resolve(collectorsPage(manyCollectors(9, 200)));
    oldPoll.group.resolve({ groups: GROUPS });
    await advance();
    expect(result.current.collectors).toBeNull();
    expect(result.current.groups).toBeNull();

    await answer(served, collectorsPage(manyCollectors(1, 300)), [collectorGroup()]);
    expect(result.current.collectors).toEqual(manyCollectors(1, 300));
    expect(result.current.groups).toEqual([collectorGroup()]);
  });

  it("never renders another organization's rows, not even in the render the switch makes, and a switch back starts over", async () => {
    const served = serve();
    const renders: Array<{ organizationId: string | undefined; collectors: Collector[] | null }> = [];
    const { result } = renderHook(() => {
      const read = useCollectorsPage(FLEET_ID, SUMMARY, { onFleetGone });
      renders.push({ organizationId: useCurrentUser()?.organization.id, collectors: read.collectors });
      return read;
    });
    await advance();
    await answer(served, collectorsPage(manyCollectors(3), "c-1"));
    act(() => result.current.search("web"));
    await advance();
    await answer(served, collectorsPage(manyCollectors(2, 10)));

    renders.length = 0;
    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await advance();
    expect(renders.filter((each) => each.organizationId === GROUP_ID)).not.toHaveLength(0);
    expect(renders.filter((each) => each.organizationId === GROUP_ID && each.collectors !== null)).toEqual([]);

    // Back to the first organization before the second's page answers: its old page is gone too.
    act(() => useUserStore.getState().setCurrent(signedInMember(PERSONAL_ID)));
    await advance();
    expect(result.current).toMatchObject({ collectors: null, groups: null, query: DEFAULT_COLLECTORS_QUERY, pageIndex: 0 });
    expect(served.page()).toMatchObject({ organizationId: PERSONAL_ID, query: plain() });
    await answer(served, collectorsPage(manyCollectors(1, 400)));
    expect(result.current.collectors).toEqual(manyCollectors(1, 400));
  });

  // Another fleet (the route's fleetId changed) is a start over, as an organization switch is.
  it("drops the old fleet's read on a switch to another fleet, never renders its rows, and starts at page 1 with no groups", async () => {
    const OTHER_FLEET_ID = "c0d1e2f3-a4b5-4c6d-8e7f-a0b1c2d3e4f5";
    const served = serve();
    const renders: Array<{ fleetId: string; collectors: Collector[] | null; groups: CollectorGroup[] | null }> = [];
    const { result, rerender } = renderHook(
      ({ fleetId }: { fleetId: string }) => {
        const read = useCollectorsPage(fleetId, SUMMARY, { onFleetGone });
        renders.push({ fleetId, collectors: read.collectors, groups: read.groups });
        return read;
      },
      { initialProps: { fleetId: FLEET_ID } },
    );
    await advance();
    await answer(served, collectorsPage(manyCollectors(50), "cursor-1"));
    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));
    expect(result.current.pageIndex).toBe(1);

    // A poll of the old fleet is under way when the switch comes.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const oldPoll = { page: served.page(), group: served.group() };
    expect(oldPoll.page.fleetId).toBe(FLEET_ID);

    renders.length = 0;
    rerender({ fleetId: OTHER_FLEET_ID });
    await advance();
    expect(oldPoll.page.signal?.aborted).toBe(true);
    expect(served.page()).toMatchObject({ fleetId: OTHER_FLEET_ID, query: plain() });
    expect(result.current).toMatchObject({ collectors: null, groups: null, pageIndex: 0, query: DEFAULT_COLLECTORS_QUERY, pager: null });

    const otherGroups = [collectorGroup({ fleetId: OTHER_FLEET_ID })];
    await answer(served, collectorsPage(manyCollectors(2, 500)), otherGroups);
    expect(result.current).toMatchObject({ collectors: manyCollectors(2, 500), pageIndex: 0, groups: otherGroups });

    // The old fleet's poll answers only now, after the new fleet's page: dropped, never shown over it.
    oldPoll.page.resolve(collectorsPage(manyCollectors(50, 51), "cursor-2"));
    oldPoll.group.resolve({ groups: GROUPS });
    await advance();
    expect(result.current).toMatchObject({ collectors: manyCollectors(2, 500), pageIndex: 0, groups: otherGroups, hasNext: false });
    const otherRenders = renders.filter((each) => each.fleetId === OTHER_FLEET_ID);
    expect(otherRenders).not.toHaveLength(0);
    const oldRows = new Set([...manyCollectors(100)].map((row) => row.id));
    expect(otherRenders.filter((each) => each.collectors?.some((row) => oldRows.has(row.id)))).toEqual([]);
    expect(otherRenders.filter((each) => each.groups === GROUPS)).toEqual([]);
  });

  it("never starts a poll while a person's read is under way", async () => {
    const { result, served } = await loaded();
    act(() => result.current.next());
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    // The Next (its answer still to come, past its guard) is the only read: no poll began.
    expect(served.pages).toHaveLength(2);
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));

    // Done: the next tick polls.
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.pages).toHaveLength(3);
    expect(served.page().query).toEqual(plain("cursor-1"));
  });

  it("lets a person's read supersede a poll under way: the poll is aborted and its answer dropped", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = { page: served.page(), group: served.group() };

    act(() => result.current.search("web"));
    await advance();
    expect(poll.page.signal?.aborted).toBe(true);
    expect(served.page()).not.toBe(poll.page);
    await answer(served, collectorsPage(manyCollectors(1, 7)));

    poll.page.resolve(collectorsPage(manyCollectors(9, 20)));
    poll.group.resolve({ groups: [collectorGroup()] });
    await advance();
    expect(result.current.collectors).toEqual(manyCollectors(1, 7));
    expect(result.current.query.q).toBe("web");
    expect(result.current.groups).toEqual(GROUPS);
  });

  it("keeps the rows and toasts 'Failed to load collectors' when a person's read fails over rows shown", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.search("web"));
    await advance();
    served.page().reject(UNAVAILABLE());
    served.group().resolve({ groups: GROUPS });
    await advance();

    expect(error).toHaveBeenCalledWith(COLLECTORS_LOAD_FAILED_MESSAGE);
    expect(result.current).toMatchObject({ collectors: manyCollectors(50), query: DEFAULT_COLLECTORS_QUERY, failed: false, personsRead: false });

    // The rows' own position stays the base: a filter now isn't searched.
    act(() => result.current.filterByGroup(GATEWAYS_GROUP_ID));
    await advance();
    expect(served.page().query).toEqual({ ...plain(), groupId: GATEWAYS_GROUP_ID });
  });

  it("shows a failed first read as failed, with no toast and no poll, and 'Try again' reads it", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = render();
    await advance();
    served.page().reject(NO_CONNECTION());
    served.group().reject(NO_CONNECTION());
    await advance();
    expect(result.current).toMatchObject({ failed: true, collectors: null, personsRead: false });
    expect(error).not.toHaveBeenCalled();
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.pages).toHaveLength(1);

    act(() => result.current.reload());
    expect(result.current.failed).toBe(false);
    await advance();
    expect(served.page().query).toEqual(plain());
    await answer(served, collectorsPage([]));
    expect(result.current).toMatchObject({ failed: false, collectors: [] });
  });

  it("ends a first read that never answers at the hang guard, as failed", async () => {
    const served = serve({ honourAbort: true });
    const { result } = render();
    await advance(FLEET_READ_TIMEOUT_MS - 1);
    expect(served.page().signal?.aborted).toBe(false);
    await advance(1);
    expect(served.page().signal?.aborted).toBe(true);
    expect(result.current.failed).toBe(true);
  });

  it("stands each read's hang guard down once it has answered: only the polling interval's timer is left", async () => {
    const { result, served } = await loaded();
    expect(vi.getTimerCount()).toBe(1);
    act(() => result.current.next());
    await advance();
    expect(vi.getTimerCount()).toBe(2);
    await answer(served, collectorsPage(manyCollectors(50, 51), null));
    expect(vi.getTimerCount()).toBe(1);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(2);
    served.page().reject(SESSION_ENDED());
    served.group().reject(SESSION_ENDED());
    await advance();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("skips polls until a poll's 429 Retry-After has passed, the rows kept", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.page().reject(RATE_LIMITED(40));
    served.group().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.collectors).toEqual(manyCollectors(50));
    expect(served.pages).toHaveLength(2);

    // Held until 40 s after the 429: the ticks at 15 s and 30 s after it are skipped.
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.pages).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.pages).toHaveLength(3);
  });

  it("holds the polls on a 429 of a person's read, and on a 429 of the groups' read alone", async () => {
    vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance();
    served.page().resolve(collectorsPage(manyCollectors(50), "cursor-1"));
    served.group().reject(RATE_LIMITED(40));
    await advance();
    expect(result.current.collectors).toEqual(manyCollectors(50));

    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.pages).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.pages).toHaveLength(3);
  });

  it("keeps the rows, silently, through a poll's 503, no connection, a 401 and its 10 s abort, and polls on", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();

    for (const failure of [UNAVAILABLE(), NO_CONNECTION(), SESSION_ENDED()]) {
      await advance(FLEETS_POLL_INTERVAL_MS);
      served.page().reject(failure);
      served.group().reject(failure);
      await advance();
      expect(result.current.collectors).toEqual(manyCollectors(50));
      expect(result.current.groups).toEqual(GROUPS);
      expect(result.current.failed).toBe(false);
    }

    // A poll that never answers ends at the hang guard; the next one runs.
    const hanging = serve({ honourAbort: true });
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(hanging.pages).toHaveLength(1);
    await advance(FLEET_READ_TIMEOUT_MS - 1);
    expect(hanging.page().signal?.aborted).toBe(false);
    await advance(1);
    expect(hanging.page().signal?.aborted).toBe(true);
    expect(hanging.group().signal?.aborted).toBe(true);
    expect(result.current.collectors).toEqual(manyCollectors(50));
    await advance(FLEETS_POLL_INTERVAL_MS - FLEET_READ_TIMEOUT_MS);
    expect(hanging.pages).toHaveLength(2);

    expect(error).not.toHaveBeenCalled();
    expect(router.revalidate).not.toHaveBeenCalled();
    expect(onFleetGone).not.toHaveBeenCalled();
  });

  it("keeps the last groups when the groups' read alone fails, and shows the page it read", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.page().resolve(collectorsPage(manyCollectors(50, 2), "cursor-1"));
    served.group().reject(UNAVAILABLE());
    await advance();
    expect(result.current.collectors).toEqual(manyCollectors(50, 2));
    expect(result.current.groups).toEqual(GROUPS);

    act(() => result.current.reload());
    await advance();
    served.page().resolve(collectorsPage(manyCollectors(50, 3), "cursor-1"));
    served.group().reject(NO_CONNECTION());
    await advance();
    expect(result.current.collectors).toEqual(manyCollectors(50, 3));
    expect(result.current.groups).toEqual(GROUPS);
    expect(error).not.toHaveBeenCalled();
  });

  it("has no groups until a groups read answers, and then has them", async () => {
    const served = serve();
    const { result } = render();
    await advance();
    served.page().resolve(collectorsPage(manyCollectors(2)));
    served.group().reject(UNAVAILABLE());
    await advance();
    expect(result.current.collectors).toEqual(manyCollectors(2));
    expect(result.current.groups).toBeNull();

    await advance(FLEETS_POLL_INTERVAL_MS);
    await answer(served, collectorsPage(manyCollectors(2)));
    expect(result.current.groups).toEqual(GROUPS);
  });

  describe("an empty page other than the first steps back, within the same read", () => {
    /** On page 3 (index 2) of a fleet: pages 1 and 2 full, page 3 with 5 rows. */
    async function onThirdPage() {
      const hook = await loaded();
      act(() => hook.result.current.next());
      await advance();
      await answer(hook.served, collectorsPage(manyCollectors(50, 51), "cursor-2"));
      act(() => hook.result.current.next());
      await advance();
      await answer(hook.served, collectorsPage(manyCollectors(5, 101), null));
      expect(hook.result.current.pageIndex).toBe(2);
      return hook;
    }

    it("for a poll: page 3 emptied steps back to page 2, under the poll's guard, with no groups read again", async () => {
      const { result, served } = await onThirdPage();
      await advance(FLEETS_POLL_INTERVAL_MS);
      const groupsReads = served.groups.length;
      const guard = served.page().signal;
      await answer(served, collectorsPage([]));
      expect(served.page().query).toEqual(plain("cursor-1"));
      expect(served.page().signal).toBe(guard);
      expect(served.groups).toHaveLength(groupsReads);
      served.page().resolve(collectorsPage(manyCollectors(48, 51), null));
      await advance();
      expect(result.current).toMatchObject({ pageIndex: 1, collectors: manyCollectors(48, 51), hasPrev: true, hasNext: false });

      // The cursor stack was cut back: Prev reads page 1.
      act(() => result.current.prev());
      await advance();
      expect(served.page().query).toEqual(plain());
    });

    it("for a reload: pages 3 and 2 emptied step back to page 1", async () => {
      const { result, served } = await onThirdPage();
      act(() => result.current.reload());
      await advance();
      expect(served.page().query).toEqual(plain("cursor-2"));
      await answer(served, collectorsPage([]));
      expect(served.page().query).toEqual(plain("cursor-1"));
      expect(result.current.personsRead).toBe(true);
      served.page().resolve(collectorsPage([]));
      await advance();
      expect(served.page().query).toEqual(plain());
      served.page().resolve(collectorsPage(manyCollectors(30)));
      await advance();
      expect(result.current).toMatchObject({ pageIndex: 0, collectors: manyCollectors(30), personsRead: false, hasPrev: false });
    });

    it("for Next onto a page emptied meanwhile: the page shown is read again", async () => {
      const { result, served } = await loaded();
      act(() => result.current.next());
      await advance();
      await answer(served, collectorsPage([], null));
      expect(served.page().query).toEqual(plain());
      served.page().resolve(collectorsPage(manyCollectors(50), null));
      await advance();
      expect(result.current).toMatchObject({ pageIndex: 0, hasNext: false, collectors: manyCollectors(50) });
    });

    it("for Prev onto a page emptied meanwhile", async () => {
      const { result, served } = await onThirdPage();
      act(() => result.current.prev());
      await advance();
      expect(served.page().query).toEqual(plain("cursor-1"));
      await answer(served, collectorsPage([]));
      expect(served.page().query).toEqual(plain());
      served.page().resolve(collectorsPage(manyCollectors(4)));
      await advance();
      expect(result.current).toMatchObject({ pageIndex: 0, collectors: manyCollectors(4) });
    });

    // The step-back's own read is superseded like any other.
    it("drops a poll's step-back read superseded by a person's read: its late answer changes nothing", async () => {
      const { result, served } = await onThirdPage();
      await advance(FLEETS_POLL_INTERVAL_MS);
      await answer(served, collectorsPage([]));
      const stepBack = served.page();
      expect(stepBack.query).toEqual(plain("cursor-1"));

      act(() => result.current.search("web"));
      await advance();
      expect(served.page()).not.toBe(stepBack);
      await answer(served, collectorsPage(manyCollectors(2, 7)));
      expect(result.current).toMatchObject({ pageIndex: 0, collectors: manyCollectors(2, 7) });

      stepBack.resolve(collectorsPage(manyCollectors(48, 51), "cursor-2"));
      await advance();
      expect(result.current).toMatchObject({ pageIndex: 0, collectors: manyCollectors(2, 7), hasPrev: false, hasNext: false });
      expect(result.current.query.q).toBe("web");
    });

    // The stack is cut back to the page stepped back to, so Next reads that page's fresh cursor.
    it("reads the stepped-back page's own next cursor on Next", async () => {
      const { result, served } = await onThirdPage();
      await advance(FLEETS_POLL_INTERVAL_MS);
      await answer(served, collectorsPage([]));
      served.page().resolve(collectorsPage(manyCollectors(50, 51), "cursor-2b"));
      await advance();
      expect(result.current).toMatchObject({ pageIndex: 1, hasNext: true });

      act(() => result.current.next());
      await advance();
      expect(served.page().query).toEqual(plain("cursor-2b"));
      await answer(served, collectorsPage(manyCollectors(3, 101), null));
      expect(result.current).toMatchObject({ pageIndex: 2, collectors: manyCollectors(3, 101) });
    });

    it("never for the first page: an empty first page is the empty states'", async () => {
      const { result, served } = await loaded(collectorsPage([]));
      expect(result.current.collectors).toEqual([]);
      expect(served.pages).toHaveLength(1);
    });
  });

  it("reads page 1 again, silently, when the cursor is stale (400 invalid_request naming cursor)", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(50, 51), "cursor-2"));

    await advance(FLEETS_POLL_INTERVAL_MS);
    served.page().reject(STALE_CURSOR());
    served.group().resolve({ groups: GROUPS });
    await advance();
    expect(served.page().query).toEqual(plain());
    served.page().resolve(collectorsPage(manyCollectors(50, 7), "fresh-1"));
    await advance();
    expect(result.current).toMatchObject({ pageIndex: 0, collectors: manyCollectors(50, 7), hasPrev: false });

    // A person's read too.
    act(() => result.current.next());
    await advance();
    served.page().reject(STALE_CURSOR());
    served.group().resolve({ groups: GROUPS });
    await advance();
    expect(served.page().query).toEqual(plain());
    served.page().resolve(collectorsPage(manyCollectors(50, 8), "fresh-1"));
    await advance();
    expect(result.current).toMatchObject({ pageIndex: 0, collectors: manyCollectors(50, 8) });
    expect(error).not.toHaveBeenCalled();
  });

  it("goes back to 'All groups', page 1, when the filter's group is gone", async () => {
    const { result, served } = await loaded();
    act(() => result.current.filterByGroup(GATEWAYS_GROUP_ID));
    await advance();
    await answer(served, collectorsPage(manyCollectors(50), "g-1"));
    act(() => result.current.next());
    await advance();
    await answer(served, collectorsPage(manyCollectors(3, 51)));
    expect(result.current.query.groupId).toBe(GATEWAYS_GROUP_ID);

    // The poll's groups no longer hold it: the same poll reads "All groups" from page 1.
    await advance(FLEETS_POLL_INTERVAL_MS);
    await answer(served, collectorsPage([]), [collectorGroup()]);
    expect(served.page().query).toEqual(plain());
    served.page().resolve(collectorsPage(manyCollectors(50), "cursor-1"));
    await advance();
    expect(result.current).toMatchObject({
      query: DEFAULT_COLLECTORS_QUERY,
      pageIndex: 0,
      groups: [collectorGroup()],
      pager: { from: 1, to: 50, total: 312 },
    });
  });

  it.each([
    ["a person's read", "person"],
    ["a poll", "poll"],
  ] as const)("calls onFleetGone on %s's 404 fleet_not_found, with no toast and no failed state", async (_name, reader) => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    if (reader === "person") act(() => result.current.reload());
    else await advance(FLEETS_POLL_INTERVAL_MS);
    await advance();
    served.page().reject(FLEET_GONE());
    served.group().reject(FLEET_GONE());
    await advance();

    expect(onFleetGone).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(result.current.failed).toBe(false);
    expect(result.current.personsRead).toBe(false);
  });

  it("calls onFleetGone on a first read's 404 fleet_not_found, never the failed state", async () => {
    const served = serve();
    const { result } = render();
    await advance();
    served.page().reject(FLEET_GONE());
    served.group().resolve({ groups: GROUPS });
    await advance();
    expect(onFleetGone).toHaveBeenCalledTimes(1);
    expect(result.current.failed).toBe(false);
  });

  it.each([
    ["organization_not_found", ORGANIZATION_GONE],
    ["terms_acceptance_required", TERMS],
  ])("revalidates the layout on %s, a poll's or a person's, with no toast, the rows kept", async (_code, failure) => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    served.page().reject(failure());
    served.group().reject(failure());
    await advance();
    expect(router.revalidate).toHaveBeenCalled();

    act(() => result.current.reload());
    await advance();
    served.page().reject(failure());
    served.group().reject(failure());
    await advance();
    expect(router.revalidate).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    expect(result.current.collectors).toEqual(manyCollectors(50));
  });

  it("says nothing when a person's read finds the session over", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.next());
    await advance();
    served.page().reject(SESSION_ENDED());
    served.group().reject(SESSION_ENDED());
    await advance();
    expect(error).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ personsRead: false, pageIndex: 0, failed: false });
  });

  it("loads nothing, and polls nothing, while the layout says the terms need accepting", async () => {
    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, true) };
    const served = serve();
    const { result, rerender } = render();
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    act(() => result.current.search("web"));
    await advance();
    expect(served.pages).toHaveLength(0);
    expect(result.current.collectors).toBeNull();

    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, false) };
    rerender({ fleetId: FLEET_ID, summary: SUMMARY });
    await advance();
    expect(served.pages).toHaveLength(1);
  });

  // The terms branch of the start leaves no person's read under way.
  it("has no person's read under way once the terms need accepting, even with one begun before", async () => {
    const served = serve();
    const { result, rerender } = render();
    await advance();
    expect(result.current.personsRead).toBe(true);
    expect(served.pages).toHaveLength(1);

    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, true) };
    rerender({ fleetId: FLEET_ID, summary: SUMMARY });
    await advance();
    expect(result.current.personsRead).toBe(false);
    expect(served.page().signal?.aborted).toBe(true);
  });

  it("aborts the read under way on unmount", async () => {
    const { served, unmount } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = served.page();
    unmount();
    expect(poll.signal?.aborted).toBe(true);
  });

  it("pauses while a dialog is open (useVisiblePolling)", async () => {
    const { served } = await loaded();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    expect(served.pages).toHaveLength(1);
  });
});
