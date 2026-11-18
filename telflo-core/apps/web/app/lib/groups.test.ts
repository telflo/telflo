import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type CollectorGroup, type CollectorGroupsResponse } from "@telflo/contracts";
import type * as ReactRouter from "react-router";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useCurrentUser } from "~/lib/use-current-user.js";
import { GROUP_ID, PERSONAL_ID, signedInMember } from "~/test/configurations.js";
import { FLEET_ID, collectorGroup, gatewaysGroup } from "~/test/fleets.js";
import { FLEET_READ_TIMEOUT_MS, FLEETS_POLL_INTERVAL_MS } from "./fleets.js";
import { GROUPS_LOAD_FAILED_MESSAGE, useGroupsTab } from "./groups.js";

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

function refusal(code: string, message: string, options: { status?: number; retryAfterSeconds?: number } = {}) {
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

const GROUPS: CollectorGroup[] = [collectorGroup(), gatewaysGroup()];
const RENAMED: CollectorGroup[] = [collectorGroup(), gatewaysGroup({ name: "gateways-eu" })];

/** One getCollectorGroups call, answered when the test says. */
interface PendingCall {
  organizationId: string;
  fleetId: string;
  signal: AbortSignal | undefined;
  resolve: (answer: CollectorGroupsResponse) => void;
  reject: (error: unknown) => void;
}

/**
 * Every getCollectorGroups call, in order, each answered by the test. A call
 * ignores its AbortSignal, as a reply already on its way would, unless
 * `honourAbort`: then an abort rejects it with REQUEST_ABORTED, as the
 * client does.
 */
function serve({ honourAbort = false } = {}) {
  const calls: PendingCall[] = [];
  vi.spyOn(apiClient, "getCollectorGroups").mockImplementation((organizationId, fleetId, options = {}) => {
    let call!: PendingCall;
    const promise = new Promise<CollectorGroupsResponse>((resolve, reject) => {
      call = { organizationId, fleetId, signal: options.signal, resolve, reject };
    });
    if (honourAbort) {
      options.signal?.addEventListener("abort", () => call.reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
    }
    calls.push(call);
    return promise;
  });
  return { calls, last: () => calls.at(-1)! };
}

type Served = ReturnType<typeof serve>;

/** Lets the promises settle and the timers run, as far as `milliseconds`. */
async function advance(milliseconds = 0): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

/** Answers the latest read with `groups`. */
async function answer(served: Served, groups: CollectorGroup[] = GROUPS): Promise<void> {
  served.last().resolve({ groups });
  await advance();
}

/** Fails the latest read with `error`. */
async function fail(served: Served, error: unknown): Promise<void> {
  served.last().reject(error);
  await advance();
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

function render() {
  return renderHook(({ fleetId }: { fleetId: string }) => useGroupsTab(fleetId, { onFleetGone }), {
    initialProps: { fleetId: FLEET_ID },
  });
}

/** The hook with its first read answered. */
async function loaded(groups: CollectorGroup[] = GROUPS) {
  const served = serve();
  const hook = render();
  await advance();
  await answer(served, groups);
  return { ...hook, served };
}

describe("useGroupsTab (D17b-2 decisions 10 and 32, Preflight ruling 10)", () => {
  it("reads the active organization's fleet's groups under a hang guard, as a person's read", async () => {
    const served = serve();
    const { result } = render();
    expect(result.current).toMatchObject({ groups: null, personsRead: true, failed: false, rowsRead: 0 });
    await advance();
    expect(served.calls).toHaveLength(1);
    expect(served.last()).toMatchObject({ organizationId: PERSONAL_ID, fleetId: FLEET_ID });
    expect(served.last().signal).toBeInstanceOf(AbortSignal);

    await answer(served);
    expect(result.current).toMatchObject({ groups: GROUPS, personsRead: false, failed: false });
    expect(result.current.rowsRead).toBeGreaterThan(0);
    expect(result.current.latestRead()).toBe(result.current.rowsRead);
  });

  it("polls every 15 s, replacing the rows, each numbered by the read they came from", async () => {
    const { result, served } = await loaded();
    const first = result.current.rowsRead;

    await advance(FLEETS_POLL_INTERVAL_MS - 1);
    expect(served.calls).toHaveLength(1);
    await advance(1);
    expect(served.calls).toHaveLength(2);
    expect(result.current.personsRead).toBe(false);
    const polled = result.current.latestRead();
    expect(polled).toBeGreaterThan(first);
    expect(result.current.rowsRead).toBe(first);

    await answer(served, RENAMED);
    expect(result.current).toMatchObject({ groups: RENAMED, rowsRead: polled });

    // A reload's rows carry its own number.
    act(() => result.current.reload());
    const reloaded = result.current.latestRead();
    expect(reloaded).toBeGreaterThan(polled);
    expect(result.current.personsRead).toBe(true);
    await advance();
    await answer(served, GROUPS);
    expect(result.current).toMatchObject({ groups: GROUPS, rowsRead: reloaded, personsRead: false });
  });

  it("drops a late answer: an older read answering after a newer one changes nothing", async () => {
    const served = serve();
    const { result } = render();
    await advance();
    const first = served.last();

    act(() => result.current.reload());
    await advance();
    expect(served.calls).toHaveLength(2);
    expect(first.signal?.aborted).toBe(true);
    await answer(served, RENAMED);

    first.resolve({ groups: [collectorGroup()] });
    await advance();
    expect(result.current.groups).toEqual(RENAMED);
  });

  it("drops the old organization's answers on a switch, never renders its rows in the new one, and reads the new one's", async () => {
    const served = serve();
    const renders: Array<{ organizationId: string | undefined; groups: CollectorGroup[] | null }> = [];
    renderHook(() => {
      const read = useGroupsTab(FLEET_ID, { onFleetGone });
      renders.push({ organizationId: useCurrentUser()?.organization.id, groups: read.groups });
      return read;
    });
    await advance();
    await answer(served);

    // A poll in the old organization is under way when the switch comes.
    await advance(FLEETS_POLL_INTERVAL_MS);
    const oldPoll = served.last();
    expect(oldPoll.organizationId).toBe(PERSONAL_ID);

    renders.length = 0;
    act(() => useUserStore.getState().setCurrent(signedInMember(GROUP_ID)));
    await advance();
    expect(oldPoll.signal?.aborted).toBe(true);
    expect(served.last().organizationId).toBe(GROUP_ID);
    expect(renders.filter((each) => each.organizationId === GROUP_ID)).not.toHaveLength(0);
    expect(renders.filter((each) => each.organizationId === GROUP_ID && each.groups !== null)).toEqual([]);

    oldPoll.resolve({ groups: RENAMED });
    await advance();
    expect(renders.at(-1)!.groups).toBeNull();

    await answer(served, [collectorGroup()]);
    expect(renders.at(-1)!.groups).toEqual([collectorGroup()]);
  });

  it("starts over for another fleet: the old fleet's late answer is dropped and its rows never shown", async () => {
    const OTHER_FLEET_ID = "c0d1e2f3-a4b5-4c6d-8e7f-a0b1c2d3e4f5";
    const { result, served, rerender } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const oldPoll = served.last();

    rerender({ fleetId: OTHER_FLEET_ID });
    expect(result.current.groups).toBeNull();
    await advance();
    expect(oldPoll.signal?.aborted).toBe(true);
    expect(served.last().fleetId).toBe(OTHER_FLEET_ID);
    const others = [collectorGroup({ fleetId: OTHER_FLEET_ID })];
    await answer(served, others);
    oldPoll.resolve({ groups: GROUPS });
    await advance();
    expect(result.current.groups).toEqual(others);
  });

  it("never starts a poll while a person's read is under way", async () => {
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    // The reload (its answer still to come, past its guard) is the only read: no poll began.
    expect(served.calls).toHaveLength(2);
    await answer(served);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("lets a person's read supersede a poll under way: the poll is aborted and its answer dropped", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = served.last();

    act(() => result.current.reload());
    await advance();
    expect(poll.signal?.aborted).toBe(true);
    await answer(served, RENAMED);
    poll.resolve({ groups: [collectorGroup()] });
    await advance();
    expect(result.current.groups).toEqual(RENAMED);
  });

  it("keeps the rows and toasts 'Failed to load groups' when a person's read fails over rows shown", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance();
    await fail(served, UNAVAILABLE());
    expect(error).toHaveBeenCalledWith(GROUPS_LOAD_FAILED_MESSAGE);
    expect(error).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ groups: GROUPS, failed: false, personsRead: false });
  });

  it("quiet (a second reader's: the setup checklist, D17c-1 Ruling 61): keeps the rows with no toast when a person's read fails over them", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = renderHook(() => useGroupsTab(FLEET_ID, { onFleetGone, quiet: true }));
    await advance();
    await answer(served);
    act(() => result.current.reload());
    await advance();
    await fail(served, UNAVAILABLE());
    expect(error).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ groups: GROUPS, failed: false, personsRead: false });
  });

  it("shows a failed first read as failed, with no toast and no poll, and 'Try again' reads it", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = render();
    await advance();
    await fail(served, NO_CONNECTION());
    expect(result.current).toMatchObject({ failed: true, groups: null, personsRead: false });
    expect(error).not.toHaveBeenCalled();
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(1);

    act(() => result.current.reload());
    expect(result.current.failed).toBe(false);
    await advance();
    await answer(served);
    expect(result.current).toMatchObject({ failed: false, groups: GROUPS });
  });

  it("ends a first read that never answers at the hang guard, as failed", async () => {
    const served = serve({ honourAbort: true });
    const { result } = render();
    await advance(FLEET_READ_TIMEOUT_MS - 1);
    expect(served.last().signal?.aborted).toBe(false);
    await advance(1);
    expect(served.last().signal?.aborted).toBe(true);
    expect(result.current.failed).toBe(true);
  });

  it("stands each read's hang guard down once it has answered: only the polling interval's timer is left", async () => {
    const { result, served } = await loaded();
    expect(vi.getTimerCount()).toBe(1);
    act(() => result.current.reload());
    await advance();
    expect(vi.getTimerCount()).toBe(2);
    await answer(served);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("skips polls until a poll's 429 Retry-After has passed, the rows kept", async () => {
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    await fail(served, RATE_LIMITED(40));
    expect(result.current.groups).toEqual(GROUPS);
    expect(served.calls).toHaveLength(2);

    // Held until 40 s after the 429: the ticks at 15 s and 30 s after it are skipped.
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("holds the polls on a person's read's 429, which toasts over the rows", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    act(() => result.current.reload());
    await advance();
    await fail(served, RATE_LIMITED(40));
    expect(error).toHaveBeenCalledWith(GROUPS_LOAD_FAILED_MESSAGE);
    await advance(2 * FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(2);
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(served.calls).toHaveLength(3);
  });

  it("keeps the rows, silently, through a poll's 503, no connection, a 401 and its 10 s abort, and polls on", async () => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();

    for (const failure of [UNAVAILABLE(), NO_CONNECTION(), SESSION_ENDED()]) {
      await advance(FLEETS_POLL_INTERVAL_MS);
      await fail(served, failure);
      expect(result.current).toMatchObject({ groups: GROUPS, failed: false });
    }

    const hanging = serve({ honourAbort: true });
    await advance(FLEETS_POLL_INTERVAL_MS);
    expect(hanging.calls).toHaveLength(1);
    await advance(FLEET_READ_TIMEOUT_MS);
    expect(hanging.last().signal?.aborted).toBe(true);
    expect(result.current.groups).toEqual(GROUPS);
    await advance(FLEETS_POLL_INTERVAL_MS - FLEET_READ_TIMEOUT_MS);
    expect(hanging.calls).toHaveLength(2);

    expect(error).not.toHaveBeenCalled();
    expect(router.revalidate).not.toHaveBeenCalled();
    expect(onFleetGone).not.toHaveBeenCalled();
  });

  it.each([
    ["the first read", "first"],
    ["a person's read", "person"],
    ["a poll", "poll"],
  ] as const)("calls onFleetGone on %s's 404 fleet_not_found, with no toast and no failed state", async (_name, reader) => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = render();
    await advance();
    if (reader !== "first") {
      await answer(served);
      if (reader === "person") act(() => result.current.reload());
      else await advance(FLEETS_POLL_INTERVAL_MS);
      await advance();
    }
    await fail(served, FLEET_GONE());
    expect(onFleetGone).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ failed: false, personsRead: false });
  });

  it.each([
    ["organization_not_found", ORGANIZATION_GONE],
    ["terms_acceptance_required", TERMS],
  ])("revalidates the layout on %s, a poll's or a person's, with no toast, the rows kept", async (_code, failure) => {
    const error = vi.spyOn(toast, "error");
    const { result, served } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    await fail(served, failure());
    expect(router.revalidate).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await advance();
    await fail(served, failure());
    expect(router.revalidate).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    expect(result.current.groups).toEqual(GROUPS);
  });

  it("says nothing when a person's read finds the session over", async () => {
    const error = vi.spyOn(toast, "error");
    const served = serve();
    const { result } = render();
    await advance();
    await fail(served, SESSION_ENDED());
    expect(error).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ failed: false, personsRead: false });
  });

  it("loads nothing, and polls nothing, while the layout says the terms need accepting", async () => {
    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, true) };
    const served = serve();
    const { result, rerender } = render();
    await advance(3 * FLEETS_POLL_INTERVAL_MS);
    act(() => result.current.reload());
    await advance();
    expect(served.calls).toHaveLength(0);
    expect(result.current).toMatchObject({ groups: null, personsRead: false });

    router.layoutData = { status: "signed_in", currentUser: signedInMember(PERSONAL_ID, false) };
    rerender({ fleetId: FLEET_ID });
    await advance();
    expect(served.calls).toHaveLength(1);
  });

  it("aborts the read under way on unmount", async () => {
    const { served, unmount } = await loaded();
    await advance(FLEETS_POLL_INTERVAL_MS);
    const poll = served.last();
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
    expect(served.calls).toHaveLength(1);
  });
});
