/**
 * The polling of a version's runs: every second while any listed run, a
 * teammate's included, is queued or running; stopped when none is, by its
 * stop function (the tab's unmount) and by a version switch; each read
 * aborted after 10 s; stopped after 30 failures in a row with "Failed to
 * refresh test runs" and a retry, at once on a refusal (a 4xx) or a failed
 * first read; a selected run read in full once it has ended; an answer
 * older than a just-queued run never dropping it.
 *
 * Every timer is fake (the poll's, the hang guard's), so nothing here waits
 * on the wall clock: each test advances the clock and counts the reads.
 */

import type { TestRunDetail, TestRunSummary } from "@telflo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { COLLEAGUE_ID, GROUP_ID, MEMBER_ID, MINE, VERSION_ID } from "~/test/configurations.js";
import { testRunFixture, testRunSummaryOf } from "~/test/test-runs.js";
import {
  RUNS_FAILURES_BEFORE_STOP,
  RUNS_LOAD_FAILED_MESSAGE,
  RUNS_POLL_INTERVAL_MS,
  RUNS_REFRESH_FAILED_MESSAGE,
  RUNS_REQUEST_TIMEOUT_MS,
  selectIsPlayHeld,
  useTestingStore,
} from "./testing-store.js";

const TARGET = { organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION_ID };
const OTHER_VERSION_ID = "0199c000-0000-7000-8000-000000000099";
const REQUEST = {
  sourceRunId: "0199e000-0000-7000-8000-000000000001",
  pipeline: "logs",
  signal: "logs" as const,
  durationSeconds: 5,
  yaml: "receivers: {}\n",
  collectorVersion: "0.162.0",
};

/** A run as the list carries it: the detail's summary fields only. */
function summary(overrides: Partial<TestRunDetail> = {}): TestRunSummary {
  return testRunSummaryOf(testRunFixture(overrides));
}

const RUN_ID = "0199e000-0000-7000-8000-000000000001";
const LATER_ID = "0199e000-0000-7000-8000-000000000002";
const queued = (overrides: Partial<TestRunDetail> = {}) => summary({ id: RUN_ID, status: "queued", ahead: 2, ...overrides });
const running = (overrides: Partial<TestRunDetail> = {}) =>
  summary({ id: RUN_ID, status: "running", ahead: null, startedAt: "2026-10-09T12:00:01.000Z", ...overrides });
const succeeded = (overrides: Partial<TestRunDetail> = {}) =>
  summary({ id: RUN_ID, status: "succeeded", ahead: null, startedAt: "2026-10-09T12:00:01.000Z", finishedAt: "2026-10-09T12:00:09.000Z", ...overrides });

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A read that never answers, but rejects as the client does once its signal aborts. */
function hangUntilAborted(options: { signal?: AbortSignal } | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
  });
}

const initialState = useTestingStore.getState();
let stop: (() => void) | null = null;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  useTestingStore.setState(initialState, true);
  // Nothing reaches the network: a test serves what it reads.
  vi.spyOn(apiClient, "getTestRuns").mockResolvedValue({ runs: [] });
  vi.spyOn(apiClient, "getTestRun").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
});

afterEach(() => {
  stop?.();
  stop = null;
  useTestingStore.getState().reset();
  vi.useRealTimers();
});

/** Serves the list from `answers`, one per read, the last one again once they run out. */
function serveRuns(...answers: TestRunSummary[][]) {
  let read = 0;
  return vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => {
    const runs = answers[Math.min(read, answers.length - 1)] ?? [];
    read += 1;
    return { runs };
  });
}

const watch = (target = TARGET) => {
  stop = useTestingStore.getState().watchRuns(target);
};

describe("the poll", () => {
  it("reads the runs at once, again every second while any is queued or running, and stops when none is", async () => {
    const list = serveRuns([queued()], [running()], [succeeded()]);

    watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, { signal: expect.any(AbortSignal) });
    expect(useTestingStore.getState()).toMatchObject({ runs: [queued()], runsLoaded: true, runsLoading: false, runsVersionId: VERSION_ID });

    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);
    expect(useTestingStore.getState().runs).toEqual([running()]);

    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(3);
    expect(useTestingStore.getState().runs).toEqual([succeeded()]);

    // None in flight: no read more, however long.
    await vi.advanceTimersByTimeAsync(60 * RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("doesn't poll a version whose runs have all ended", async () => {
    const list = serveRuns([succeeded()]);

    watch();
    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(1);
  });

  it("refreshes a teammate's run in flight too, not only the person's own, with no total-time cap", async () => {
    const teammate = (status: "running" | "succeeded") =>
      status === "running" ? running({ queuedByUserId: COLLEAGUE_ID }) : succeeded({ queuedByUserId: COLLEAGUE_ID });
    const answers = [...Array.from({ length: 120 }, () => [teammate("running")]), [teammate("succeeded")]];
    const list = serveRuns(...answers);

    watch();
    await vi.advanceTimersByTimeAsync(0);
    // Two minutes of a teammate's run: the poll never gives up at 60 s.
    await vi.advanceTimersByTimeAsync(120 * RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(121);
    expect(useTestingStore.getState().runs).toEqual([teammate("succeeded")]);
    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(121);
  });

  it("stops by its stop function (the tab's unmount): no read after, and the answer in flight dropped and aborted", async () => {
    const answer = deferred<{ runs: TestRunSummary[] }>();
    let signal: AbortSignal | undefined;
    const list = vi
      .spyOn(apiClient, "getTestRuns")
      .mockResolvedValueOnce({ runs: [running()] })
      .mockImplementationOnce(async (_o, _c, _v, options) => {
        signal = options?.signal;
        return answer.promise;
      });

    watch();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);

    stop?.();
    expect(signal?.aborted).toBe(true);
    answer.resolve({ runs: [succeeded()] });
    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(2);
    expect(useTestingStore.getState().runs).toEqual([running()]);
  });

  it("stops on a version switch: the old version's runs and answers gone, the new version read", async () => {
    const stale = deferred<{ runs: TestRunSummary[] }>();
    const list = vi.spyOn(apiClient, "getTestRuns").mockImplementation(async (_o, _c, versionId) =>
      versionId === VERSION_ID ? stale.promise : { runs: [] },
    );
    useTestingStore.setState({ runsVersionId: VERSION_ID, runs: [running()], runsLoaded: true, selectedRunId: RUN_ID });

    watch();
    stop?.();
    watch({ ...TARGET, versionId: OTHER_VERSION_ID });
    stale.resolve({ runs: [running()] });
    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);

    expect(list.mock.calls.map((call) => call[2])).toEqual([VERSION_ID, OTHER_VERSION_ID]);
    expect(useTestingStore.getState()).toMatchObject({ runsVersionId: OTHER_VERSION_ID, runs: [], selectedRunId: null, runsLoaded: true });
  });

  it("stops on signing out (reset)", async () => {
    const list = serveRuns([running()]);

    watch();
    await vi.advanceTimersByTimeAsync(0);
    useTestingStore.getState().reset();
    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(1);
    expect(useTestingStore.getState().runs).toEqual([]);
  });

  it("stops quietly when the session has ended (the session-ended handler takes over)", async () => {
    const list = vi.spyOn(apiClient, "getTestRuns").mockRejectedValue(new ApiError("unauthenticated", "Your session has ended.", { status: 401 }));

    watch();
    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(1);
    expect(useTestingStore.getState()).toMatchObject({ runsError: null, runsLoading: false });
  });
});

describe("the hang guard", () => {
  it("aborts each read after 10 s, counts it a failure, and reads again a second later", async () => {
    const signals: AbortSignal[] = [];
    const list = vi.spyOn(apiClient, "getTestRuns").mockImplementation((_o, _c, _v, options) => {
      if (options?.signal) signals.push(options.signal);
      // The first read answers (a run going on), the poll's first hangs, the next answers.
      if (signals.length === 1) return Promise.resolve({ runs: [running()] });
      return signals.length === 2 ? hangUntilAborted(options) : Promise.resolve({ runs: [succeeded()] });
    });

    watch();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1);
    expect(signals[1]?.aborted).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[1]?.aborted).toBe(true);
    expect(useTestingStore.getState().runsError).toBeNull();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(3);
    expect(useTestingStore.getState()).toMatchObject({ runsLoaded: true, runsError: null, runs: [succeeded()] });
  });

  it(`stops after ${RUNS_FAILURES_BEFORE_STOP} failures in a row with "Failed to refresh test runs"; Retry reads again and polls on`, async () => {
    expect(RUNS_FAILURES_BEFORE_STOP).toBe(30);
    expect(RUNS_REFRESH_FAILED_MESSAGE).toBe("Failed to refresh test runs");
    // The first read shows a run going on; every poll after it fails.
    const list = vi
      .spyOn(apiClient, "getTestRuns")
      .mockResolvedValueOnce({ runs: [running()] })
      .mockRejectedValue(new ApiError("network_error", "Could not reach the server."));

    watch();
    await vi.advanceTimersByTimeAsync(RUNS_FAILURES_BEFORE_STOP * RUNS_POLL_INTERVAL_MS - 1);
    expect(list).toHaveBeenCalledTimes(30);
    expect(useTestingStore.getState().runsError).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalledTimes(31);
    expect(useTestingStore.getState()).toMatchObject({ runsError: "Failed to refresh test runs", runsLoading: false, runs: [running()] });
    await vi.advanceTimersByTimeAsync(60 * RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(31);

    list.mockResolvedValueOnce({ runs: [running()] }).mockResolvedValue({ runs: [succeeded()] });
    useTestingStore.getState().retryRuns();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(32);
    expect(useTestingStore.getState()).toMatchObject({ runsError: null, runs: [running()] });
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(33);
    expect(useTestingStore.getState().runs).toEqual([succeeded()]);
  });

  it("counts failures in a row only: an answer between them starts the count again", async () => {
    let read = 0;
    const list = vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => {
      read += 1;
      if (read === 1 || read === 30) return { runs: [running()] };
      throw new ApiError("network_error", "Could not reach the server.");
    });

    watch();
    await vi.advanceTimersByTimeAsync(58 * RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(59);
    expect(useTestingStore.getState().runsError).toBeNull();
  });

  it("says at once, with Retry, when the first read fails: nothing waits for 30", async () => {
    expect(RUNS_LOAD_FAILED_MESSAGE).toBe("Failed to load test runs");
    const list = vi.spyOn(apiClient, "getTestRuns").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));

    watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(useTestingStore.getState()).toMatchObject({ runsError: "Failed to load test runs", runsLoading: false, runsLoaded: false });
    await vi.advanceTimersByTimeAsync(60 * RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(1);

    list.mockResolvedValue({ runs: [succeeded()] });
    useTestingStore.getState().retryRuns();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(2);
    expect(useTestingStore.getState()).toMatchObject({ runsError: null, runsLoaded: true, runs: [succeeded()] });
  });

  it("says at once when a first read hangs past the hang guard", async () => {
    vi.spyOn(apiClient, "getTestRuns").mockImplementation((_o, _c, _v, options) => hangUntilAborted(options));

    watch();
    await vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS);

    expect(useTestingStore.getState()).toMatchObject({ runsError: "Failed to load test runs", runsLoading: false });
  });

  it.each([
    [404, "configuration_not_found", "Configuration not found"],
    [403, "forbidden", "You don't have access to this organization."],
  ])("stops at once on a refusal (%d), with the API's words, though runs were shown", async (status, code, message) => {
    const list = vi
      .spyOn(apiClient, "getTestRuns")
      .mockResolvedValueOnce({ runs: [running()] })
      .mockRejectedValue(new ApiError(code, message, { status }));

    watch();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);
    expect(useTestingStore.getState()).toMatchObject({ runsError: message, runsLoading: false });
    await vi.advanceTimersByTimeAsync(60 * RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([
    [408, "request_timeout", "The request timed out."],
    [429, "rate_limited", "Too many requests."],
  ])("counts a %d as transient: it keeps the 30-in-a-row rule", async (status, code, message) => {
    const list = vi
      .spyOn(apiClient, "getTestRuns")
      .mockResolvedValueOnce({ runs: [running()] })
      .mockRejectedValue(new ApiError(code, message, { status }));

    watch();
    await vi.advanceTimersByTimeAsync((RUNS_FAILURES_BEFORE_STOP - 1) * RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(30);
    expect(useTestingStore.getState().runsError).toBeNull();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(31);
    expect(useTestingStore.getState().runsError).toBe("Failed to refresh test runs");
  });

  it("keeps the 30-in-a-row rule for a 5xx after runs were shown", async () => {
    const list = vi
      .spyOn(apiClient, "getTestRuns")
      .mockResolvedValueOnce({ runs: [running()] })
      .mockRejectedValue(new ApiError("internal_error", "Something went wrong.", { status: 502 }));

    watch();
    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(11);
    expect(useTestingStore.getState().runsError).toBeNull();
  });

  it("aborts a run's full read after 10 s too, and offers it again", async () => {
    serveRuns([succeeded()]);
    const detail = vi.spyOn(apiClient, "getTestRun").mockImplementation((_o, _c, _v, _r, options) => hangUntilAborted(options));
    useTestingStore.setState({ runsVersionId: VERSION_ID, selectedRunId: RUN_ID });

    watch();
    await vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS);

    expect(detail).toHaveBeenCalledTimes(1);
    expect(useTestingStore.getState().runDetailFailedId).toBe(RUN_ID);
    detail.mockResolvedValue({ run: testRunFixture({ ...succeeded() }) });
    useTestingStore.getState().retryRunDetail();
    await vi.advanceTimersByTimeAsync(0);
    expect(detail).toHaveBeenCalledTimes(2);
    expect(useTestingStore.getState().runDetails[RUN_ID]?.status).toBe("succeeded");
  });
});

describe("a selected run's full read", () => {
  it("happens once, when the selected run ends, however long the polling goes on", async () => {
    const teammate = running({ id: LATER_ID, queuedAt: "2026-10-09T12:01:00.000Z", queuedByUserId: COLLEAGUE_ID });
    serveRuns([running(), teammate], [succeeded(), teammate]);
    const full = testRunFixture({ ...succeeded(), logs: "zq collector logs" });
    const detail = vi.spyOn(apiClient, "getTestRun").mockResolvedValue({ run: full });

    watch();
    await vi.advanceTimersByTimeAsync(0);
    useTestingStore.getState().selectRun(RUN_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(detail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * RUNS_POLL_INTERVAL_MS);

    expect(detail).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, RUN_ID, { signal: expect.any(AbortSignal) });
    expect(useTestingStore.getState().runDetails[RUN_ID]).toEqual(full);
  });

  it("happens on selecting an ended run, and only once however often it is selected", async () => {
    serveRuns([succeeded()]);
    const detail = vi.spyOn(apiClient, "getTestRun").mockResolvedValue({ run: testRunFixture({ ...succeeded() }) });

    watch();
    await vi.advanceTimersByTimeAsync(0);
    useTestingStore.getState().selectRun(RUN_ID);
    useTestingStore.getState().selectRun(RUN_ID);
    await vi.advanceTimersByTimeAsync(0);
    useTestingStore.getState().selectRun(null);
    useTestingStore.getState().selectRun(RUN_ID);
    await vi.advanceTimersByTimeAsync(0);

    expect(detail).toHaveBeenCalledTimes(1);
  });

  it("says when it failed, until a retry", async () => {
    serveRuns([succeeded()]);
    const detail = vi.spyOn(apiClient, "getTestRun").mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server."));

    watch();
    await vi.advanceTimersByTimeAsync(0);
    useTestingStore.getState().selectRun(RUN_ID);
    await vi.advanceTimersByTimeAsync(0);

    expect(useTestingStore.getState().runDetailFailedId).toBe(RUN_ID);
    expect(detail).toHaveBeenCalledTimes(1);
  });
});

describe("a run just queued", () => {
  it("survives an answer to a read sent before it was queued, and keeps the hold, until a later answer speaks for it", async () => {
    const reads: ReturnType<typeof deferred<{ runs: TestRunSummary[] }>>[] = [];
    vi.spyOn(apiClient, "getTestRuns").mockImplementation(() => {
      const read = deferred<{ runs: TestRunSummary[] }>();
      reads.push(read);
      return read.promise;
    });
    const mine = testRunFixture({ id: LATER_ID, queuedAt: "2026-10-09T12:05:00.000Z", status: "queued", ahead: 0 });
    vi.spyOn(apiClient, "queueTestRun").mockResolvedValue({ run: mine });
    const held = () => selectIsPlayHeld(useTestingStore.getState(), MEMBER_ID, VERSION_ID);

    watch();
    expect(reads).toHaveLength(1);
    // The run is queued while the first read is under way.
    await useTestingStore.getState().queueRun(TARGET, REQUEST);
    expect(held()).toBe(true);
    expect(useTestingStore.getState().selectedRunId).toBe(LATER_ID);

    // That read's answer was taken before the run existed: it doesn't list it.
    reads[0]!.resolve({ runs: [succeeded()] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useTestingStore.getState().runs.map((run) => run.id)).toEqual([LATER_ID, RUN_ID]);
    expect(held()).toBe(true);

    // The next read was sent after: its answer is the truth.
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(reads).toHaveLength(2);
    reads[1]!.resolve({ runs: [summary({ ...mine, status: "succeeded", ahead: null }), succeeded()] });
    await vi.advanceTimersByTimeAsync(0);
    expect(held()).toBe(false);
    expect(useTestingStore.getState().runs.map((run) => [run.id, run.status])).toEqual([
      [LATER_ID, "succeeded"],
      [RUN_ID, "succeeded"],
    ]);
  });

  it("is dropped by an answer to a read sent after it was queued that no longer lists it", async () => {
    const list = serveRuns([], []);
    const mine = testRunFixture({ id: LATER_ID, status: "queued", ahead: 0 });
    vi.spyOn(apiClient, "queueTestRun").mockResolvedValue({ run: mine });

    watch();
    await vi.advanceTimersByTimeAsync(0);
    await useTestingStore.getState().queueRun(TARGET, REQUEST);
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);

    expect(list).toHaveBeenCalledTimes(2);
    expect(useTestingStore.getState().runs).toEqual([]);
  });

  it("starts an idle polling again, and a stopped one too", async () => {
    const list = vi.spyOn(apiClient, "getTestRuns").mockResolvedValue({ runs: [] });
    vi.spyOn(apiClient, "queueTestRun").mockResolvedValue({ run: testRunFixture({ id: LATER_ID }) });

    watch();
    await vi.advanceTimersByTimeAsync(5 * RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(1);

    await useTestingStore.getState().queueRun(TARGET, REQUEST);
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list).toHaveBeenCalledTimes(2);

    // Stopped on failures, a queued run (the API answered) starts it again at once.
    list.mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
    useTestingStore.setState({ runs: [running()] });
    useTestingStore.getState().retryRuns();
    await vi.advanceTimersByTimeAsync(RUNS_FAILURES_BEFORE_STOP * RUNS_POLL_INTERVAL_MS);
    expect(useTestingStore.getState().runsError).toBe(RUNS_REFRESH_FAILED_MESSAGE);
    const before = list.mock.calls.length;
    list.mockResolvedValue({ runs: [] });
    await useTestingStore.getState().queueRun(TARGET, REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    expect(list.mock.calls.length).toBe(before + 1);
    expect(useTestingStore.getState().runsError).toBeNull();
  });

  it("touches nothing when it answers after the tab left its version: the version shown keeps its runs and its polling", async () => {
    const answer = deferred<{ run: TestRunDetail }>();
    vi.spyOn(apiClient, "queueTestRun").mockReturnValue(answer.promise);
    const newRun = running({ id: LATER_ID });
    const list = vi
      .spyOn(apiClient, "getTestRuns")
      .mockImplementation(async (_o, _c, versionId) => ({ runs: versionId === OTHER_VERSION_ID ? [newRun] : [] }));

    watch();
    await vi.advanceTimersByTimeAsync(0);
    // A re-run on the old version, then a switch to another before the API answers.
    const queuing = useTestingStore.getState().queueRun(TARGET, REQUEST);
    stop?.();
    watch({ ...TARGET, versionId: OTHER_VERSION_ID });
    await vi.advanceTimersByTimeAsync(0);
    answer.resolve({ run: testRunFixture({ id: RUN_ID, status: "queued", ahead: 0 }) });
    await queuing;

    expect(useTestingStore.getState()).toMatchObject({
      runsVersionId: OTHER_VERSION_ID,
      runs: [newRun],
      runsLoading: false,
      selectedRunId: null,
    });
    const reads = list.mock.calls.filter((call) => call[2] === OTHER_VERSION_ID).length;
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(list.mock.calls.filter((call) => call[2] === OTHER_VERSION_ID)).toHaveLength(reads + 1);
    expect(list.mock.calls.filter((call) => call[2] === VERSION_ID)).toHaveLength(1);
  });

  it("adds nothing when it answers after signing out", async () => {
    const answer = deferred<{ run: TestRunDetail }>();
    vi.spyOn(apiClient, "queueTestRun").mockReturnValue(answer.promise);

    const queuing = useTestingStore.getState().queueRun(TARGET, REQUEST);
    useTestingStore.getState().reset();
    answer.resolve({ run: testRunFixture() });
    await queuing;

    expect(useTestingStore.getState()).toMatchObject({ runs: [], runsVersionId: null, selectedRunId: null });
  });
});
