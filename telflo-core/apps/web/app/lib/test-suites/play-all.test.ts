/**
 * Play all: the store-owned loops, parallel and serial, with the text, pin,
 * version and suite captured at the click and the definitions read fresh then;
 * at most four queue requests in flight; the selection; the serial order, each
 * run followed by id until it ends; the refusals counted into one toast per
 * message; the stops (a version switch, leaving the page, signing out, 30
 * failed reads, a refusal, a session that ended); and the hold, from the
 * click.
 *
 * Every timer is fake (the follow's, the hang guard's): each test advances
 * the clock and counts the requests. The API is its client's functions,
 * spied on; toasts are spied on.
 */

import type { QueueTestRunRequest, TestDefinition, TestRunDetail } from "@telflo/contracts";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { DEFINITIONS_LOAD_FAILED_MESSAGE, useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import {
  RUNS_FAILURES_BEFORE_STOP,
  RUNS_POLL_INTERVAL_MS,
  RUNS_REFRESH_FAILED_MESSAGE,
  RUNS_REQUEST_TIMEOUT_MS,
  selectIsPlayHeld,
  useTestingStore,
  type PlayAllMode,
} from "~/lib/stores/testing-store.js";
import { GROUP_ID, MEMBER_ID, MINE, versionFixture } from "~/test/configurations.js";
import { testRunFixture, testRunSummaryOf } from "~/test/test-runs.js";
import { testDefinitionFixture, testSuiteFixture } from "~/test/test-suites.js";
import { PLAY_ALL_REQUESTS_IN_FLIGHT, playAll, refusalsMessage, SUITE_HAS_NO_DEFINITIONS_MESSAGE } from "./play-all.js";

const YAML = "receivers:\n  otlp:\n    protocols:\n      http: {}\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n";
const VERSION = versionFixture({ yamlContent: YAML });
const OTHER_VERSION = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
const TARGET = { organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id };
const SUITE = testSuiteFixture();
const QUEUE_FULL = "You have 50 test runs waiting already. Wait for some to finish.";

/** `count` definitions in the suite, in the card's order. */
function definitions(count: number): TestDefinition[] {
  return Array.from({ length: count }, (_, index) =>
    testDefinitionFixture({ id: `0199f100-0000-7000-8000-${String(index + 1).padStart(12, "0")}`, name: `zq-definition-${index + 1}` }),
  );
}

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

/** Each run the fake API has queued, by id, as it now stands. */
let runs: Map<string, TestRunDetail>;
let queue: MockInstance<typeof apiClient.queueTestRun>;
let readRun: MockInstance<typeof apiClient.getTestRun>;
let toastError: MockInstance<typeof toast.error>;
let toastInfo: MockInstance<typeof toast.info>;
let stopWatching: (() => void) | null = null;

/** The run the fake API queues for a request: its id from the definition's, its breadcrumb the definition's. */
function runFor(request: QueueTestRunRequest): TestRunDetail {
  const definitionId = "definitionId" in request ? request.definitionId : "";
  const run = testRunFixture({
    id: `0199e000-0000-7000-8000-${definitionId.slice(-12)}`,
    queuedAt: `2026-10-10T12:00:${definitionId.slice(-2)}.000Z`,
    definitionId,
    definitionName: `zq-definition-${Number(definitionId.slice(-12))}`,
    suiteId: SUITE.id,
    suiteName: SUITE.name,
  });
  runs.set(run.id, run);
  return run;
}

/** The definition's run's id, as the fake API names it. */
const runIdOf = (definition: TestDefinition) => `0199e000-0000-7000-8000-${definition.id.slice(-12)}`;

/** Ends a run, as the API will next read it. */
function end(runId: string, status: "succeeded" | "failed" = "succeeded") {
  const run = runs.get(runId)!;
  runs.set(runId, { ...run, status, ahead: null, startedAt: "2026-10-10T12:01:00.000Z", finishedAt: "2026-10-10T12:01:05.000Z" });
}

/** The suite's definitions as the API lists them, and the suites store holding the version (the Suites subtab read it). */
async function serveSuite(listed: TestDefinition[]) {
  vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
  await useTestSuitesStore.getState().loadSuites(TARGET);
  return vi.spyOn(apiClient, "getTestDefinitions").mockResolvedValue({ definitions: listed });
}

/** Starts a Play all of the suite as the tab does at the click: the editor's text and pin as they are now. */
function start(mode: PlayAllMode, onFirstSelected?: (runId: string) => void) {
  const editor = useEditorStore.getState();
  return playAll({
    userId: MEMBER_ID,
    target: TARGET,
    suiteId: SUITE.id,
    mode,
    yaml: editor.text,
    collectorVersion: editor.collectorVersion!,
    ...(onFirstSelected === undefined ? {} : { onFirstSelected }),
  });
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const held = () => selectIsPlayHeld(useTestingStore.getState(), MEMBER_ID, VERSION.id);
const queuedIds = () => queue.mock.calls.map((call) => (call[3] as { definitionId: string }).definitionId);

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState(initialTesting, true);
  useTestingStore.getState().reset();
  useTestSuitesStore.getState().reset();
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  runs = new Map();
  queue = vi.spyOn(apiClient, "queueTestRun").mockImplementation(async (_o, _c, _v, request) => ({ run: runFor(request) }));
  readRun = vi.spyOn(apiClient, "getTestRun").mockImplementation(async (_o, _c, _v, runId) => {
    const run = runs.get(runId);
    if (run === undefined) throw new ApiError("test_run_not_found", "Test run not found", { status: 404 });
    return { run };
  });
  // The tab's own poll of the list, when a test watches: what the API has queued.
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: [...runs.values()].map(testRunSummaryOf) }));
  toastError = vi.spyOn(toast, "error");
  toastInfo = vi.spyOn(toast, "info");
});

afterEach(() => {
  stopWatching?.();
  stopWatching = null;
  useTestingStore.getState().reset();
  useTestSuitesStore.getState().reset();
  vi.useRealTimers();
});

/** The tab watches the version's runs, as it does while mounted: queued runs join the list, selected. */
function watch() {
  stopWatching = useTestingStore.getState().watchRuns(TARGET);
}

describe("starting", () => {
  it("sets the hold at once, so a synchronous second call returns false and starts nothing; nor while a single run starts", async () => {
    await serveSuite(definitions(2));

    expect(start("parallel")).toBe(true);
    expect(held()).toBe(true);
    expect(useTestingStore.getState().playAll).toEqual({ target: TARGET, suiteId: SUITE.id, mode: "parallel" });
    expect(start("parallel")).toBe(false);
    expect(start("serial")).toBe(false);

    await flush();
    expect(queuedIds()).toEqual(definitions(2).map((definition) => definition.id));
    expect(useTestingStore.getState().playAll).toBeNull();

    const release = useTestingStore.getState().beginStart(TARGET, MEMBER_ID) as () => void;
    expect(start("serial")).toBe(false);
    release();
    await flush();
    expect(queue).toHaveBeenCalledTimes(2);
  });

  it("reads the definitions fresh at the click, awaiting a read under way, the hold set meanwhile", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [SUITE] });
    await useTestSuitesStore.getState().loadSuites(TARGET);
    const answer = deferred<{ definitions: TestDefinition[] }>();
    const read = vi.spyOn(apiClient, "getTestDefinitions").mockReturnValueOnce(answer.promise);
    // The card expanded: its read is under way.
    const expanding = useTestSuitesStore.getState().loadDefinitions(TARGET, SUITE.id);

    expect(start("parallel")).toBe(true);
    await flush();
    expect(read).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
    expect(held()).toBe(true);

    answer.resolve({ definitions: definitions(1) });
    await expanding;
    await flush();
    expect(queuedIds()).toEqual([definitions(1)[0]!.id]);
  });

  it("says 'This suite has no test configurations yet' for an empty suite, and 'Failed to load test configurations' when the read fails, queuing nothing", async () => {
    const read = await serveSuite([]);

    start("parallel");
    await flush();
    expect(toastInfo).toHaveBeenCalledWith(SUITE_HAS_NO_DEFINITIONS_MESSAGE);
    expect(held()).toBe(false);

    read.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    start("serial");
    await flush();
    expect(toastError).toHaveBeenCalledWith(DEFINITIONS_LOAD_FAILED_MESSAGE);
    expect(queue).not.toHaveBeenCalled();
    expect(held()).toBe(false);

    // A session that ended says nothing.
    toastError.mockClear();
    read.mockRejectedValueOnce(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    start("serial");
    await flush();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("in parallel", () => {
  it("queues every definition from itself with the text, pin and version of the click, in the card's order, at most 4 in flight; the hold until the last answer", async () => {
    const listed = definitions(6);
    await serveSuite(listed);
    const answers: Array<ReturnType<typeof deferred<{ run: TestRunDetail }>>> = [];
    let inFlight = 0;
    let mostInFlight = 0;
    queue.mockImplementation((_o, _c, _v, request) => {
      const answer = deferred<{ run: TestRunDetail }>();
      answers.push(answer);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      const run = runFor(request);
      return answer.promise.finally(() => (inFlight -= 1)).then(() => ({ run }));
    });
    const textAtClick = useEditorStore.getState().text;

    start("parallel");
    // Edited after the click: the requests keep the click's text.
    useEditorStore.getState().setText(`${textAtClick}# zq edited after the click\n`);
    await flush();

    expect(queue).toHaveBeenCalledTimes(PLAY_ALL_REQUESTS_IN_FLIGHT);
    expect(queue.mock.calls[0]).toEqual([GROUP_ID, MINE.id, VERSION.id, { definitionId: listed[0]!.id, yaml: textAtClick, collectorVersion: "0.162.0" }]);
    expect(queuedIds()).toEqual(listed.slice(0, 4).map((definition) => definition.id));

    answers[1]!.resolve({ run: testRunFixture() });
    await flush();
    expect(queuedIds()).toEqual(listed.slice(0, 5).map((definition) => definition.id));
    expect(held()).toBe(true);

    for (const answer of answers) answer.resolve({ run: testRunFixture() });
    await flush();
    for (const answer of answers) answer.resolve({ run: testRunFixture() });
    await flush();

    expect(queuedIds()).toEqual(listed.map((definition) => definition.id));
    expect(mostInFlight).toBe(PLAY_ALL_REQUESTS_IN_FLIGHT);
    expect(useTestingStore.getState().playAll).toBeNull();
    // Nothing followed in parallel: the list's own poll shows them.
    expect(readRun).not.toHaveBeenCalled();
  });

  it("selects the first definition's run in the card's order, though a later one answers first; the first queued when the first is refused; the focus once", async () => {
    const listed = definitions(3);
    await serveSuite(listed);
    watch();
    const answers = new Map<string, ReturnType<typeof deferred<void>>>();
    queue.mockImplementation(async (_o, _c, _v, request) => {
      const answer = deferred<void>();
      answers.set((request as { definitionId: string }).definitionId, answer);
      await answer.promise;
      return { run: runFor(request) };
    });
    const focused = vi.fn();

    start("parallel", focused);
    await flush();
    answers.get(listed[1]!.id)!.resolve();
    await flush();
    expect(useTestingStore.getState().runs.map((run) => run.id)).toContain(runIdOf(listed[1]!));
    expect(useTestingStore.getState().selectedRunId).toBeNull();
    expect(focused).not.toHaveBeenCalled();

    answers.get(listed[0]!.id)!.resolve();
    answers.get(listed[2]!.id)!.resolve();
    await flush();
    expect(useTestingStore.getState().selectedRunId).toBe(runIdOf(listed[0]!));
    expect(focused.mock.calls).toEqual([[runIdOf(listed[0]!)]]);

    // Again, once those have ended, the first refused: the next one queued is selected.
    useTestingStore.setState((state) => ({ runs: state.runs.map((run) => ({ ...run, status: "succeeded" as const, ahead: null })) }));
    queue.mockImplementation(async (_o, _c, _v, request) => {
      if ((request as { definitionId: string }).definitionId === listed[0]!.id) {
        throw new ApiError("test_run_queue_full", QUEUE_FULL, { status: 429 });
      }
      return { run: runFor(request) };
    });
    focused.mockClear();
    start("parallel", focused);
    await flush();
    expect(useTestingStore.getState().selectedRunId).toBe(runIdOf(listed[1]!));
    expect(focused.mock.calls).toEqual([[runIdOf(listed[1]!)]]);
  });

  it("goes on past a refused definition: one error toast per message, its count updated in place ('k of n', 'wasn't' for one), the fallback for words that say nothing", async () => {
    const listed = definitions(5);
    await serveSuite(listed);
    const refusals: Record<string, ApiError> = {
      [listed[1]!.id]: new ApiError("test_run_queue_full", QUEUE_FULL, { status: 429 }),
      [listed[2]!.id]: new ApiError("invalid_request", "The request was not valid.", { status: 400 }),
      [listed[3]!.id]: new ApiError("test_run_queue_full", QUEUE_FULL, { status: 429 }),
    };
    queue.mockImplementation(async (_o, _c, _v, request) => {
      const refusal = refusals[(request as { definitionId: string }).definitionId];
      if (refusal !== undefined) throw refusal;
      return { run: runFor(request) };
    });

    start("parallel");
    await flush();

    expect(queuedIds()).toEqual(listed.map((definition) => definition.id));
    expect(toastError.mock.calls).toEqual([
      ["1 of 5 test configurations wasn't queued: " + QUEUE_FULL, { id: expect.any(String) }],
      ["1 of 5 test configurations wasn't queued: Failed to start test run", { id: expect.any(String) }],
      ["2 of 5 test configurations weren't queued: " + QUEUE_FULL, { id: expect.any(String) }],
    ]);
    const ids = toastError.mock.calls.map((call) => (call[1] as { id: string }).id);
    // The queue-full toast is updated in place; the fallback's is its own.
    expect(ids[2]).toBe(ids[0]);
    expect(ids[1]).not.toBe(ids[0]);
    // No words in an id.
    for (const id of ids) expect(id).not.toMatch(/waiting|valid|Failed/);

    // The next Play all's toasts are its own: a new id, the count from one.
    toastError.mockClear();
    start("parallel");
    await flush();
    expect(toastError.mock.calls[0]![0]).toBe(refusalsMessage(1, 5, QUEUE_FULL));
    expect((toastError.mock.calls[0]![1] as { id: string }).id).not.toBe(ids[0]);
  });

  it("toasts nothing for a refusal answered after signing out, and queues nothing more", async () => {
    const listed = definitions(6);
    await serveSuite(listed);
    const answers: Array<ReturnType<typeof deferred<{ run: TestRunDetail }>>> = [];
    queue.mockImplementation(() => {
      const answer = deferred<{ run: TestRunDetail }>();
      answers.push(answer);
      return answer.promise;
    });

    start("parallel");
    await flush();
    expect(answers).toHaveLength(PLAY_ALL_REQUESTS_IN_FLIGHT);
    useTestingStore.getState().reset();
    for (const answer of answers) answer.reject(new ApiError("test_run_queue_full", QUEUE_FULL, { status: 429 }));
    await flush();

    expect(toastError).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(PLAY_ALL_REQUESTS_IN_FLIGHT);
    expect(useTestingStore.getState().playAll).toBeNull();
  });

  it("stops silently once the session has ended: no toast, nothing more queued, the hold released", async () => {
    const listed = definitions(8);
    await serveSuite(listed);
    queue.mockImplementation(async (_o, _c, _v, request) => {
      if ((request as { definitionId: string }).definitionId === listed[0]!.id) {
        throw new ApiError("unauthenticated", "You need to sign in.", { status: 401 });
      }
      return { run: runFor(request) };
    });

    start("parallel");
    await flush();

    expect(toastError).not.toHaveBeenCalled();
    // The four sent at once answer; nothing after them.
    expect(queue).toHaveBeenCalledTimes(PLAY_ALL_REQUESTS_IN_FLIGHT);
    expect(useTestingStore.getState().playAll).toBeNull();
  });
});

describe("serially", () => {
  it("queues one at a time in the card's order, following each run by id every second until it ends; each step's run selected; held between the steps", async () => {
    const listed = definitions(3);
    await serveSuite(listed);
    watch();
    const focused = vi.fn();

    start("serial", focused);
    await flush();
    expect(queuedIds()).toEqual([listed[0]!.id]);
    expect(useTestingStore.getState().selectedRunId).toBe(runIdOf(listed[0]!));
    expect(focused.mock.calls).toEqual([[runIdOf(listed[0]!)]]);

    // Still queued, then running: nothing more is queued.
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(readRun).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, runIdOf(listed[0]!), { signal: expect.any(AbortSignal) });
    runs.set(runIdOf(listed[0]!), { ...runs.get(runIdOf(listed[0]!))!, status: "running", ahead: null });
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS * 3);
    expect(queuedIds()).toEqual([listed[0]!.id]);

    // It ends: the next is queued at once, the first's row shows it ended, and the hold stays between them.
    let heldBetween: boolean | null = null;
    queue.mockImplementationOnce(async (_o, _c, _v, request) => {
      heldBetween = held() && useTestingStore.getState().runs.every((run) => run.status !== "queued" && run.status !== "running");
      return { run: runFor(request) };
    });
    end(runIdOf(listed[0]!));
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(queuedIds()).toEqual([listed[0]!.id, listed[1]!.id]);
    expect(heldBetween).toBe(true);
    expect(useTestingStore.getState().selectedRunId).toBe(runIdOf(listed[1]!));

    end(runIdOf(listed[1]!));
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(queuedIds()).toEqual(listed.map((definition) => definition.id));
    expect(held()).toBe(true);

    end(runIdOf(listed[2]!));
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(useTestingStore.getState().playAll).toBeNull();
    expect(held()).toBe(false);
    expect(focused).toHaveBeenCalledOnce();
    // The runs carry their breadcrumbs, as the list shows them.
    expect(useTestingStore.getState().runs.map((run) => [run.suiteName, run.definitionName])).toEqual(
      expect.arrayContaining(listed.map((definition) => [SUITE.name, definition.name])),
    );
  });

  it("shows each followed run's state in its row from the follow's own reads, when the list's poll doesn't answer (noteRun)", async () => {
    const listed = definitions(2);
    await serveSuite(listed);
    // The list's reads hang until their abort (RUNS_REQUEST_TIMEOUT_MS, longer than this test): only the follow speaks for the runs.
    const listRuns = vi.spyOn(apiClient, "getTestRuns").mockImplementation(
      (_o, _c, _v, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
        }),
    );
    watch();
    const rowOf = (definition: TestDefinition) => useTestingStore.getState().runs.find((run) => run.id === runIdOf(definition));

    start("serial");
    await flush();
    expect(rowOf(listed[0]!)?.status).toBe("queued");

    runs.set(runIdOf(listed[0]!), { ...runs.get(runIdOf(listed[0]!))!, status: "running", ahead: null, startedAt: "2026-10-10T12:01:00.000Z" });
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(rowOf(listed[0]!)?.status).toBe("running");

    end(runIdOf(listed[0]!));
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(rowOf(listed[0]!)).toMatchObject({ status: "succeeded", finishedAt: "2026-10-10T12:01:05.000Z" });
    expect(rowOf(listed[1]!)?.status).toBe("queued");
    // Within the list's first read's timeout: no list answer could have done it.
    expect(listRuns).toHaveBeenCalledOnce();
    expect(RUNS_POLL_INTERVAL_MS * 2).toBeLessThan(RUNS_REQUEST_TIMEOUT_MS);
  });

  it("goes on at once past a run that ends in failure, and past a refused step, counting it into the toast", async () => {
    const listed = definitions(3);
    await serveSuite(listed);
    queue.mockImplementation(async (_o, _c, _v, request) => {
      if ((request as { definitionId: string }).definitionId === listed[1]!.id) {
        throw new ApiError("test_run_queue_full", QUEUE_FULL, { status: 429 });
      }
      return { run: runFor(request) };
    });

    start("serial");
    await flush();
    end(runIdOf(listed[0]!), "failed");
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);

    // The failed run's next is refused, and the one after it queued at once.
    expect(queuedIds()).toEqual(listed.map((definition) => definition.id));
    expect(toastError).toHaveBeenCalledWith(refusalsMessage(1, 3, QUEUE_FULL), { id: expect.any(String) });
    expect(held()).toBe(true);
  });

  it("aborts a read after the hang guard and reads again, then stops after 30 failed reads in a row: 'Failed to refresh test runs'", async () => {
    await serveSuite(definitions(2));
    readRun.mockImplementation(
      (_o, _c, _v, _r, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
        }),
    );

    start("serial");
    await flush();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS + RUNS_REQUEST_TIMEOUT_MS);
    expect(readRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(readRun).toHaveBeenCalledTimes(2);

    readRun.mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS * (RUNS_FAILURES_BEFORE_STOP - 3) + RUNS_REQUEST_TIMEOUT_MS);
    expect(toastError).not.toHaveBeenCalled();
    expect(held()).toBe(true);
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);

    expect(readRun).toHaveBeenCalledTimes(RUNS_FAILURES_BEFORE_STOP);
    expect(toastError.mock.calls).toEqual([[RUNS_REFRESH_FAILED_MESSAGE]]);
    expect(useTestingStore.getState().playAll).toBeNull();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS * 10);
    expect(readRun).toHaveBeenCalledTimes(RUNS_FAILURES_BEFORE_STOP);
    expect(queue).toHaveBeenCalledOnce();
  });

  it("stops at once on a refusal (a 4xx but 408 and 429) with the API's words, and silently on a session that ended", async () => {
    await serveSuite(definitions(2));
    readRun.mockRejectedValueOnce(new ApiError("configuration_version_not_found", "Version not found", { status: 404 }));

    start("serial");
    await flush();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(toastError.mock.calls).toEqual([["Version not found"]]);
    expect(useTestingStore.getState().playAll).toBeNull();

    // A 429 and a 408 pass with time: the loop goes on.
    toastError.mockClear();
    readRun
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many attempts.", { status: 429 }))
      .mockRejectedValueOnce(new ApiError("request_timeout", "Timed out.", { status: 408 }))
      .mockRejectedValueOnce(new ApiError("unauthenticated", "You need to sign in.", { status: 401 }));
    start("serial");
    await flush();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS * 2);
    expect(held()).toBe(true);
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(toastError).not.toHaveBeenCalled();
    expect(useTestingStore.getState().playAll).toBeNull();
    expect(queue).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a version switch", () => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION })],
    ["leaving the page (the editor's reset)", () => useEditorStore.getState().reset()],
    ["signing out (the store's reset)", () => useTestingStore.getState().reset()],
  ])("stops on %s: its wait and read cut short, nothing more queued, the hold released", async (_label, leave) => {
    const listed = definitions(3);
    await serveSuite(listed);
    const reading = deferred<{ run: TestRunDetail }>();
    let aborted = false;
    readRun.mockImplementationOnce((_o, _c, _v, _r, options) => {
      options?.signal?.addEventListener("abort", () => (aborted = true));
      return reading.promise;
    });

    start("serial");
    await flush();
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);
    expect(readRun).toHaveBeenCalledOnce();

    leave();
    expect(aborted).toBe(true);
    expect(useTestingStore.getState().playAll).toBeNull();
    end(runIdOf(listed[0]!));
    reading.resolve({ run: runs.get(runIdOf(listed[0]!))! });
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS * 10 + RUNS_REQUEST_TIMEOUT_MS);

    expect(queuedIds()).toEqual([listed[0]!.id]);
    expect(readRun).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("stops on a version switch during its wait for the next read, reading nothing more", async () => {
    await serveSuite(definitions(2));

    start("serial");
    await flush();
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION });
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS * 5);

    expect(readRun).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledOnce();
  });

  it("isn't stopped by the editor's text changing (manual edit mode, a tab switch): the text was captured", async () => {
    const listed = definitions(2);
    await serveSuite(listed);
    const textAtClick = useEditorStore.getState().text;

    start("serial");
    await flush();
    useEditorStore.getState().setText(`${textAtClick}# zq edited\n`);
    end(runIdOf(listed[0]!));
    await vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS);

    expect(queuedIds()).toEqual(listed.map((definition) => definition.id));
    expect((queue.mock.calls[1]![3] as { yaml: string }).yaml).toBe(textAtClick);
  });
});

describe("the definitions known", () => {
  /** Starts a Play all, recording when its definitions are known and what was queued then. */
  function startWatched(mode: PlayAllMode) {
    const known: number[] = [];
    const editor = useEditorStore.getState();
    playAll({
      userId: MEMBER_ID,
      target: TARGET,
      suiteId: SUITE.id,
      mode,
      yaml: editor.text,
      collectorVersion: editor.collectorVersion!,
      onDefinitionsKnown: () => known.push(queue.mock.calls.length),
    });
    return known;
  }

  it("calls onDefinitionsKnown once, before the first queue request, when the suite has a definition, in each mode", async () => {
    await serveSuite(definitions(2));

    const parallel = startWatched("parallel");
    await flush();
    expect(parallel).toEqual([0]);
    expect(queue).toHaveBeenCalledTimes(2);

    const serial = startWatched("serial");
    await flush();
    expect(serial).toEqual([2]);
  });

  it("never calls it for an empty suite, a failed read, or a Play all stopped while it read", async () => {
    const read = await serveSuite([]);
    const empty = startWatched("parallel");
    await flush();
    expect(toastInfo).toHaveBeenCalledWith(SUITE_HAS_NO_DEFINITIONS_MESSAGE);
    expect(empty).toEqual([]);

    read.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    const failed = startWatched("serial");
    await flush();
    expect(failed).toEqual([]);

    const answer = deferred<{ definitions: TestDefinition[] }>();
    read.mockReturnValueOnce(answer.promise);
    const stopped = startWatched("parallel");
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION });
    answer.resolve({ definitions: definitions(1) });
    await flush();
    expect(stopped).toEqual([]);
    expect(queue).not.toHaveBeenCalled();
  });
});

describe("a Play all that queued nothing", () => {
  /** Starts a Play all, recording each onNothingQueued call by whether Play was still held then. */
  function startCounted(mode: PlayAllMode) {
    const heldAtCall: boolean[] = [];
    const editor = useEditorStore.getState();
    playAll({
      userId: MEMBER_ID,
      target: TARGET,
      suiteId: SUITE.id,
      mode,
      yaml: editor.text,
      collectorVersion: editor.collectorVersion!,
      onNothingQueued: () => heldAtCall.push(held()),
    });
    return heldAtCall;
  }

  it("says so once, its hold already released: every definition refused (in each mode), an empty suite, a failed read", async () => {
    const read = await serveSuite(definitions(3));
    queue.mockRejectedValue(new ApiError("test_run_queue_full", QUEUE_FULL, { status: 429 }));

    const parallel = startCounted("parallel");
    await flush();
    expect(parallel).toEqual([false]);
    const serial = startCounted("serial");
    await flush();
    expect(serial).toEqual([false]);

    read.mockResolvedValueOnce({ definitions: [] });
    const empty = startCounted("parallel");
    await flush();
    expect(empty).toEqual([false]);

    read.mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    const failed = startCounted("serial");
    await flush();
    expect(failed).toEqual([false]);
  });

  it("says nothing once a run is queued, the others refused (parallel), or the loop stopped after it (serial)", async () => {
    await serveSuite(definitions(3));
    queue.mockRejectedValueOnce(new ApiError("test_run_queue_full", QUEUE_FULL, { status: 429 }));

    const parallel = startCounted("parallel");
    await flush();
    expect(queue).toHaveBeenCalledTimes(3);
    expect(held()).toBe(false);
    expect(parallel).toEqual([]);

    const serial = startCounted("serial");
    await flush();
    expect(queue).toHaveBeenCalledTimes(4);
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION });
    await flush();
    expect(held()).toBe(false);
    expect(serial).toEqual([]);

    // Stopped while its first queue request was in flight, which then queued: something was queued.
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
    const answer = deferred<{ run: TestRunDetail }>();
    queue.mockImplementationOnce((_o, _c, _v, request) => answer.promise.then(() => ({ run: runFor(request) })));
    const stoppedMidRequest = startCounted("serial");
    await flush();
    useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION });
    answer.resolve({ run: testRunFixture() });
    await flush();
    expect(queue).toHaveBeenCalledTimes(5);
    expect(held()).toBe(false);
    expect(stoppedMidRequest).toEqual([]);
  });

  it("says nothing once stopped while its definitions read was under way, though the read answers, fails or times out later", async () => {
    const read = await serveSuite(definitions(1));
    const other = { organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION };
    const back = { organizationId: GROUP_ID, configuration: MINE, version: VERSION };

    // A version switch, then the read answers: nothing queued, nothing said.
    const answer = deferred<{ definitions: TestDefinition[] }>();
    read.mockReturnValueOnce(answer.promise);
    const answered = startCounted("parallel");
    useEditorStore.getState().load(other);
    expect(held()).toBe(false);
    answer.resolve({ definitions: definitions(1) });
    await flush();
    expect(answered).toEqual([]);

    // Signing out (the store's reset), then the read fails.
    useEditorStore.getState().load(back);
    const failure = deferred<{ definitions: TestDefinition[] }>();
    read.mockReturnValueOnce(failure.promise);
    const failed = startCounted("serial");
    useTestingStore.getState().reset();
    failure.reject(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    await flush();
    expect(failed).toEqual([]);

    // A version switch, then the read never answers: let go of by the hang guard.
    read.mockImplementationOnce(
      (_o, _c, _v, _s, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
        }),
    );
    const timedOut = startCounted("parallel");
    useEditorStore.getState().load(other);
    await vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS);
    expect(timedOut).toEqual([]);

    expect(queue).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("lets go of a definitions read that never answers after RUNS_REQUEST_TIMEOUT_MS: 'Failed to load test configurations', the hold released; a refusal toasts its own words", async () => {
    const read = await serveSuite(definitions(1));
    // Answers only by its abort, as the client does.
    read.mockImplementationOnce(
      (_o, _c, _v, _s, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
        }),
    );
    const stalled = startCounted("parallel");
    await vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1);
    expect(held()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(held()).toBe(false);
    expect(toastError).toHaveBeenCalledWith(DEFINITIONS_LOAD_FAILED_MESSAGE);
    expect(stalled).toEqual([false]);

    read.mockRejectedValueOnce(new ApiError("test_suite_not_found", "Test suite not found", { status: 404 }));
    startCounted("serial");
    await flush();
    expect(toastError).toHaveBeenLastCalledWith("Test suite not found");
    expect(queue).not.toHaveBeenCalled();
  });
});
