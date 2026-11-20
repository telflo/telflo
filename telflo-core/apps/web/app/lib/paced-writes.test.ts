import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEETS_UNAVAILABLE_MESSAGE } from "@telflo/contracts";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage } from "~/lib/fleets.js";
import { runPacedWrites, type PacedProgress, type PacedResult, type PacedWrites } from "./paced-writes.js";

function refusal(code: string, message: string, options: { status?: number; retryAfterSeconds?: number } = {}) {
  return new ApiError(code, message, options);
}

const RATE_LIMITED = (retryAfterSeconds?: number) =>
  refusal(
    "rate_limited",
    "Too many attempts. Please wait and try again.",
    retryAfterSeconds === undefined ? { status: 429 } : { status: 429, retryAfterSeconds },
  );
const UNAVAILABLE = () => refusal("fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE, { status: 503 });
const COLLECTOR_GONE = () => refusal("collector_not_found", "Collector not found.", { status: 404 });
const NAME_TAKEN = () => refusal("collector_name_taken", "Another of the organization's collectors has this name.", { status: 409 });
const GROUP_GONE = () => refusal("collector_group_not_found", "Collector group not found.", { status: 404 });

const FALLBACK = "Failed to move collector";
const refusalWords = (error: unknown) => fleetRefusalMessage(error, FALLBACK);

/** One write, answered when the test says. */
interface PendingWrite {
  item: string;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Every write, in order, each answered by the test. It ignores its
 * AbortSignal unless `honourAbort`: then an abort rejects it with
 * REQUEST_ABORTED, as the client does.
 */
function writes({ honourAbort = false } = {}) {
  const sent: PendingWrite[] = [];
  const write = vi.fn((item: string, signal: AbortSignal) => {
    let pending!: PendingWrite;
    const promise = new Promise<void>((resolve, reject) => {
      pending = { item, signal, resolve: () => resolve(), reject };
    });
    if (honourAbort) signal.addEventListener("abort", () => pending.reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
    sent.push(pending);
    return promise;
  });
  return { sent, write, last: () => sent.at(-1)! };
}

/** Lets the promises settle and the timers run, as far as `milliseconds`. */
async function advance(milliseconds = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

const ITEMS = ["a", "b", "c", "d"];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function run(items: readonly string[], served: ReturnType<typeof writes>, stopsOn?: (error: unknown) => boolean) {
  const progress: PacedProgress[] = [];
  let settled: PacedResult<string>[] | null = null;
  const loop = runPacedWrites(items, served.write, {
    timeoutMs: FLEET_WRITE_TIMEOUT_MS,
    refusal: refusalWords,
    ...(stopsOn === undefined ? {} : { stopsOn }),
    onProgress: (each) => progress.push(each),
  });
  void loop.results.then((results) => {
    settled = results;
  });
  return { ...loop, progress, settled: () => settled };
}

describe("runPacedWrites", () => {
  it("sends one request at a time, in order, each with its own hang guard, and tells the progress", async () => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    expect(served.sent.map((each) => each.item)).toEqual(["a"]);
    expect(loop.progress).toEqual([{ current: 1, total: 4, waitingSeconds: null }]);

    // Nothing more goes until the request in flight has answered, however long it takes (short of its guard).
    await advance(FLEET_WRITE_TIMEOUT_MS - 1);
    expect(served.sent).toHaveLength(1);
    served.last().resolve();
    await advance();
    expect(served.sent.map((each) => each.item)).toEqual(["a", "b"]);
    expect(served.sent[1]!.signal).not.toBe(served.sent[0]!.signal);
    expect(loop.progress.at(-1)).toEqual({ current: 2, total: 4, waitingSeconds: null });

    for (let answered = 1; answered < ITEMS.length; answered += 1) {
      served.last().resolve();
      await advance();
    }
    expect(served.sent).toHaveLength(4);
    expect(loop.settled()).toEqual(ITEMS.map((item) => ({ item, kind: "done" })));
    // Every guard stood down: no timer left.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives each item its result: done, gone (collector_not_found), refused with the refusal's words", async () => {
    const served = writes();
    const loop = run(["a", "b", "c", "d"], served);
    await advance();
    served.last().resolve();
    await advance();
    served.last().reject(COLLECTOR_GONE());
    await advance();
    served.last().reject(NAME_TAKEN());
    await advance();
    served.last().reject(refusal("invalid_request", "The request was not valid.", { status: 400 }));
    await advance();

    expect(loop.settled()).toEqual([
      { item: "a", kind: "done" },
      { item: "b", kind: "gone" },
      { item: "c", kind: "refused", message: "Another of the organization's collectors has this name.", error: NAME_TAKEN() },
      { item: "d", kind: "refused", message: FALLBACK, error: expect.any(ApiError) },
    ]);
  });

  it("waits out a 429's Retry-After, then sends the same item again", async () => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    served.last().resolve();
    await advance();
    served.last().reject(RATE_LIMITED(3));
    await advance();
    expect(loop.progress.at(-1)).toEqual({ current: 2, total: 4, waitingSeconds: 3 });

    await advance(2_999);
    expect(served.sent).toHaveLength(2);
    await advance(1);
    expect(served.sent.map((each) => each.item)).toEqual(["a", "b", "b"]);
    expect(loop.progress.at(-1)).toEqual({ current: 2, total: 4, waitingSeconds: null });
    served.last().resolve();
    await advance();
    expect(served.last().item).toBe("c");
  });

  it.each([
    ["without Retry-After", RATE_LIMITED(undefined)],
    ["with Retry-After 0", RATE_LIMITED(0)],
  ])("waits 1 s on a 429 %s", async (_name, error) => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    served.last().reject(error);
    await advance();
    expect(loop.progress.at(-1)).toEqual({ current: 1, total: 4, waitingSeconds: 1 });
    await advance(999);
    expect(served.sent).toHaveLength(1);
    await advance(1);
    expect(served.sent.map((each) => each.item)).toEqual(["a", "a"]);
  });

  it("stops after the request in flight: its result kept, the rest not attempted", async () => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    served.last().resolve();
    await advance();
    loop.stop();
    // The request in flight isn't aborted.
    expect(served.last().signal.aborted).toBe(false);
    served.last().resolve();
    await advance();

    expect(served.sent).toHaveLength(2);
    expect(loop.settled()).toEqual([
      { item: "a", kind: "done" },
      { item: "b", kind: "done" },
      { item: "c", kind: "not_attempted" },
      { item: "d", kind: "not_attempted" },
    ]);
  });

  it("stops during a 429's wait at once: that item and the rest not attempted", async () => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    served.last().resolve();
    await advance();
    served.last().reject(RATE_LIMITED(30));
    await advance(1_000);
    loop.stop();
    await advance();

    expect(loop.settled()).toEqual([
      { item: "a", kind: "done" },
      { item: "b", kind: "not_attempted" },
      { item: "c", kind: "not_attempted" },
      { item: "d", kind: "not_attempted" },
    ]);
    expect(served.sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A Stop while a write is in flight that then answers 429 waits not at all.
  it("stops at once when the request in flight at a stop answers 429: no wait, that item and the rest not attempted", async () => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    served.last().resolve();
    await advance();
    loop.stop();
    const told = loop.progress.length;
    served.last().reject(RATE_LIMITED(30));
    // The promises settle with no timer advanced: nothing waits out the 30 s.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    expect(loop.settled()).toEqual([
      { item: "a", kind: "done" },
      { item: "b", kind: "not_attempted" },
      { item: "c", kind: "not_attempted" },
      { item: "d", kind: "not_attempted" },
    ]);
    expect(loop.progress.slice(told)).toEqual([]);
    expect(served.sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A Stop made as a 429's wait is told (from onProgress) never starts the wait.
  it("stops at once when stopped as a 429's wait is told: no wait, that item and the rest not attempted", async () => {
    const served = writes();
    const progress: PacedProgress[] = [];
    // onProgress runs only once the loop is under way, after `loop` is set.
    const loop: PacedWrites<string> = runPacedWrites(ITEMS, served.write, {
      timeoutMs: FLEET_WRITE_TIMEOUT_MS,
      refusal: refusalWords,
      onProgress: (each) => {
        progress.push(each);
        if (each.waitingSeconds !== null) loop.stop();
      },
    });
    let settled: PacedResult<string>[] | null = null;
    void loop.results.then((results) => {
      settled = results;
    });
    await advance();
    served.last().resolve();
    await advance();
    served.last().reject(RATE_LIMITED(30));
    // The promises settle with no timer advanced: nothing waits out the 30 s.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    expect(settled).toEqual([
      { item: "a", kind: "done" },
      { item: "b", kind: "not_attempted" },
      { item: "c", kind: "not_attempted" },
      { item: "d", kind: "not_attempted" },
    ]);
    expect(progress.at(-1)).toEqual({ current: 2, total: 4, waitingSeconds: 30 });
    expect(served.sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["a 503", UNAVAILABLE],
    ["no connection", () => new ApiError("network_error", "Could not reach the server. Check your connection.")],
    ["a reply that doesn't parse", () => new ApiError("unexpected_response", "The server returned an unexpected response.")],
  ])("stops on an unknown outcome (%s): that item unknown, the rest not attempted", async (_name, failure) => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    served.last().resolve();
    await advance();
    served.last().reject(failure());
    await advance();

    expect(served.sent).toHaveLength(2);
    expect(loop.settled()).toEqual([
      { item: "a", kind: "done" },
      { item: "b", kind: "unknown", error: expect.any(ApiError) },
      { item: "c", kind: "not_attempted" },
      { item: "d", kind: "not_attempted" },
    ]);
  });

  it("stops on a request that never answers, at its hang guard: unknown", async () => {
    const served = writes({ honourAbort: true });
    const loop = run(ITEMS, served);
    await advance(FLEET_WRITE_TIMEOUT_MS - 1);
    expect(served.last().signal.aborted).toBe(false);
    await advance(1);
    expect(served.last().signal.aborted).toBe(true);
    await advance();
    expect(served.sent).toHaveLength(1);
    expect(loop.settled()).toEqual([
      { item: "a", kind: "unknown", error: expect.objectContaining({ code: REQUEST_ABORTED }) },
      { item: "b", kind: "not_attempted" },
      { item: "c", kind: "not_attempted" },
      { item: "d", kind: "not_attempted" },
    ]);
  });

  it.each([
    ["organization_not_found", () => refusal("organization_not_found", "Organization not found", { status: 404 }), "Organization not found"],
    ["terms_acceptance_required", () => refusal("terms_acceptance_required", "Accept the terms.", { status: 403 }), FALLBACK],
    ["the session ended", () => refusal("unauthenticated", "You need to sign in.", { status: 401 }), FALLBACK],
    ["fleet_not_found", () => refusal("fleet_not_found", "Fleet not found.", { status: 404 }), "Fleet not found."],
  ])("stops on %s: that item refused, the rest not attempted", async (_name, failure, message) => {
    const served = writes();
    const loop = run(ITEMS, served);
    await advance();
    served.last().reject(failure());
    await advance();

    expect(served.sent).toHaveLength(1);
    expect(loop.settled()).toEqual([
      { item: "a", kind: "refused", message, error: expect.any(ApiError) },
      { item: "b", kind: "not_attempted" },
      { item: "c", kind: "not_attempted" },
      { item: "d", kind: "not_attempted" },
    ]);
  });

  it("stops on the caller's own stopping refusal (a move's target group gone), and goes on past it without one", async () => {
    const isGroupGone = (error: unknown) => error instanceof ApiError && error.code === "collector_group_not_found";
    const moving = writes();
    const move = run(ITEMS, moving, isGroupGone);
    await advance();
    moving.last().reject(GROUP_GONE());
    await advance();
    expect(moving.sent).toHaveLength(1);
    expect((await move.results).map((each) => each.kind)).toEqual(["refused", "not_attempted", "not_attempted", "not_attempted"]);

    const deleting = writes();
    run(["a", "b"], deleting);
    await advance();
    deleting.last().reject(GROUP_GONE());
    await advance();
    expect(deleting.sent).toHaveLength(2);
  });

  it("answers an empty list at once, sending nothing", async () => {
    const served = writes();
    const loop = run([], served);
    await advance();
    expect(loop.settled()).toEqual([]);
    expect(served.write).not.toHaveBeenCalled();
  });
});
