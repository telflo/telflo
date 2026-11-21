/**
 * The Testing tab's store: the remembered duration, My Files and the
 * selection, the heads kept for the fixture-shape check, the queue and Run's
 * hold. The API is its client's functions, spied on.
 */

import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { COLLEAGUE_ID, GROUP_ID, MEMBER_ID, PERSONAL_ID, VERSION_ID } from "~/test/configurations.js";
import { testFileFixture, testRunFixture } from "~/test/test-runs.js";
import {
  DEFAULT_RUN_DURATION_SECONDS,
  LAST_RUN_DURATION_KEY,
  readRememberedDuration,
  RUNS_REQUEST_TIMEOUT_MS,
  selectIsPlayHeld,
  useTestingStore,
} from "./testing-store.js";

const FIRST = testFileFixture();
const SECOND = testFileFixture({ id: "0199d000-0000-7000-8000-000000000002", displayName: "zq-second", fileName: "zq-second.log" });
const TARGET = { organizationId: GROUP_ID, configurationId: "0199a000-0000-7000-8000-000000000001", versionId: VERSION_ID };
const REQUEST = {
  inputFileId: FIRST.id,
  pipeline: "logs",
  signal: "logs" as const,
  durationSeconds: 5,
  yaml: "receivers: {}\n",
  collectorVersion: "0.162.0",
};

const initialState = useTestingStore.getState();

beforeEach(() => {
  vi.restoreAllMocks();
  useTestingStore.setState(initialState, true);
  window.localStorage.clear();
});

describe("the remembered duration", () => {
  it("is 5 with nothing stored, and the stored whole number otherwise", () => {
    expect(readRememberedDuration()).toBe(DEFAULT_RUN_DURATION_SECONDS);
    window.localStorage.setItem(LAST_RUN_DURATION_KEY, "17");
    expect(readRememberedDuration()).toBe(17);
  });

  it("clamps a stored number to 1-60", () => {
    for (const [stored, read] of [
      ["0", 1],
      ["-4", 1],
      ["61", 60],
      ["9999", 60],
      ["1", 1],
      ["60", 60],
    ] as const) {
      window.localStorage.setItem(LAST_RUN_DURATION_KEY, stored);
      expect(readRememberedDuration(), stored).toBe(read);
    }
  });

  it("refuses a stored value that isn't a whole number: the default", () => {
    for (const stored of ["1.5", "abc", "", "7s", "1e1", "NaN"]) {
      window.localStorage.setItem(LAST_RUN_DURATION_KEY, stored);
      expect(readRememberedDuration(), stored).toBe(DEFAULT_RUN_DURATION_SECONDS);
    }
  });

  it("is the default when reaching localStorage throws (Safari's private mode, storage blocked), and the page keeps a written one", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(readRememberedDuration()).toBe(DEFAULT_RUN_DURATION_SECONDS);
    useTestingStore.getState().setLastRunDurationSeconds(12);
    expect(useTestingStore.getState().lastRunDurationSeconds).toBe(12);
  });

  it("is the default when reading localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("read failed");
    });

    expect(readRememberedDuration()).toBe(DEFAULT_RUN_DURATION_SECONDS);
  });

  it("is the default when localStorage has no methods (Node's own Web Storage global)", () => {
    vi.spyOn(window, "localStorage", "get").mockReturnValue({} as Storage);

    expect(readRememberedDuration()).toBe(DEFAULT_RUN_DURATION_SECONDS);
    useTestingStore.getState().setLastRunDurationSeconds(8);
    expect(useTestingStore.getState().lastRunDurationSeconds).toBe(8);
  });

  it("stores a whole number of seconds, 1-60, and refuses anything else (1.5 is never rounded)", () => {
    const store = useTestingStore.getState();

    store.setLastRunDurationSeconds(30);
    expect(useTestingStore.getState().lastRunDurationSeconds).toBe(30);
    expect(window.localStorage.getItem(LAST_RUN_DURATION_KEY)).toBe("30");

    for (const refused of [0, 61, 1.5, Number.NaN, -1]) store.setLastRunDurationSeconds(refused);
    expect(useTestingStore.getState().lastRunDurationSeconds).toBe(30);
    expect(window.localStorage.getItem(LAST_RUN_DURATION_KEY)).toBe("30");
  });

  it("keeps a written duration for the page when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    useTestingStore.getState().setLastRunDurationSeconds(9);

    expect(useTestingStore.getState().lastRunDurationSeconds).toBe(9);
  });

  it("survives a reset (signing out forgets files, not the browser's preference)", () => {
    useTestingStore.getState().setLastRunDurationSeconds(42);
    useTestingStore.getState().reset();
    expect(useTestingStore.getState().lastRunDurationSeconds).toBe(42);
  });
});

describe("My Files", () => {
  it("are read afresh on every load, not once a session", async () => {
    const read = vi
      .spyOn(apiClient, "getTestFiles")
      .mockResolvedValueOnce({ files: [FIRST] })
      .mockResolvedValueOnce({ files: [SECOND, FIRST] });

    await useTestingStore.getState().loadFiles(GROUP_ID);
    expect(useTestingStore.getState().files).toEqual([FIRST]);
    await useTestingStore.getState().loadFiles(GROUP_ID);

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(GROUP_ID);
    expect(useTestingStore.getState()).toMatchObject({ files: [SECOND, FIRST], filesLoaded: true, filesLoading: false });
  });

  it("keep the list shown while a read is under way, and drop an answer a later read overtook", async () => {
    let answerFirst!: (value: { files: typeof FIRST[] }) => void;
    vi.spyOn(apiClient, "getTestFiles")
      .mockResolvedValueOnce({ files: [FIRST] })
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ files: [SECOND] });
    await useTestingStore.getState().loadFiles(GROUP_ID);

    const slow = useTestingStore.getState().loadFiles(GROUP_ID);
    expect(useTestingStore.getState()).toMatchObject({ files: [FIRST], filesLoaded: true, filesLoading: true });
    await useTestingStore.getState().loadFiles(GROUP_ID);
    answerFirst({ files: [FIRST, SECOND] });
    await slow;

    expect(useTestingStore.getState().files).toEqual([SECOND]);
  });

  it("start from none for another organization: its list, selection and heads aren't this one's", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValueOnce({ files: [FIRST] }).mockResolvedValueOnce({ files: [] });
    await useTestingStore.getState().loadFiles(GROUP_ID);
    useTestingStore.getState().setSelectedFile({ id: FIRST.id, displayName: FIRST.displayName });

    const loading = useTestingStore.getState().loadFiles(PERSONAL_ID);
    expect(useTestingStore.getState()).toMatchObject({ files: [], filesLoaded: false, selectedFile: null });
    await loading;

    expect(useTestingStore.getState()).toMatchObject({ filesOrganizationId: PERSONAL_ID, files: [], filesLoaded: true });
  });

  it("clear the selection when a fresh read no longer lists it (another tab deleted it)", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValueOnce({ files: [FIRST, SECOND] }).mockResolvedValueOnce({ files: [SECOND] });
    await useTestingStore.getState().loadFiles(GROUP_ID);
    useTestingStore.getState().setSelectedFile({ id: FIRST.id, displayName: FIRST.displayName });

    await useTestingStore.getState().loadFiles(GROUP_ID);

    expect(useTestingStore.getState().selectedFile).toBeNull();
  });

  it("reject as the API did, the list left as it was", async () => {
    const failure = new ApiError("network_error", "Could not reach the server. Check your connection.");
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValueOnce({ files: [FIRST] }).mockRejectedValueOnce(failure);
    await useTestingStore.getState().loadFiles(GROUP_ID);

    await expect(useTestingStore.getState().loadFiles(GROUP_ID)).rejects.toBe(failure);
    expect(useTestingStore.getState()).toMatchObject({ files: [FIRST], filesLoading: false });
  });

  it("an upload joins the list's top, with its first 64 KiB kept for the fixture-shape check", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValue({ files: [FIRST] });
    const upload = vi.spyOn(apiClient, "uploadTestFile").mockResolvedValue({ file: SECOND });
    await useTestingStore.getState().loadFiles(GROUP_ID);
    const body = "line one\n".repeat(10_000);
    const file = new File([body], "zq-second.log", { type: "text/plain" });

    const saved = await useTestingStore.getState().uploadFile(GROUP_ID, { displayName: "zq-second", description: "", file });

    expect(saved).toEqual(SECOND);
    expect(upload).toHaveBeenCalledWith(GROUP_ID, { displayName: "zq-second", description: "", file });
    expect(useTestingStore.getState().files).toEqual([SECOND, FIRST]);
    const head = useTestingStore.getState().heads[SECOND.id];
    expect(head?.length).toBe(64 * 1024);
    expect(new TextDecoder().decode(head!.subarray(0, 9))).toBe("line one\n");
  });

  it("a saved sample joins the list's top, its text's head kept", async () => {
    const save = vi.spyOn(apiClient, "saveTestSample").mockResolvedValue({ file: SECOND });

    await useTestingStore.getState().saveSample(GROUP_ID, { displayName: "zq-second", text: '{"resourceLogs":[]}', format: "json" });

    expect(save).toHaveBeenCalledWith(GROUP_ID, { displayName: "zq-second", text: '{"resourceLogs":[]}', format: "json" });
    expect(useTestingStore.getState().files).toEqual([SECOND]);
    expect(new TextDecoder().decode(useTestingStore.getState().heads[SECOND.id])).toBe('{"resourceLogs":[]}');
  });

  it("keeps a copy of a long sample's head alone, not a view of the whole encoded sample", async () => {
    vi.spyOn(apiClient, "saveTestSample").mockResolvedValue({ file: SECOND });

    await useTestingStore.getState().saveSample(GROUP_ID, { displayName: "zq-second", text: "x".repeat(1_000_000), format: "text" });

    const head = useTestingStore.getState().heads[SECOND.id]!;
    expect(head.length).toBe(64 * 1024);
    expect(head.buffer.byteLength).toBe(64 * 1024);
  });

  it.each(["upload", "sample"] as const)("adds nothing when a %s answers after signing out", async (kind) => {
    let answer!: (value: { file: typeof SECOND }) => void;
    const pending = new Promise<{ file: typeof SECOND }>((resolve) => {
      answer = resolve;
    });
    vi.spyOn(apiClient, kind === "upload" ? "uploadTestFile" : "saveTestSample").mockReturnValue(pending);

    const saving =
      kind === "upload"
        ? useTestingStore.getState().uploadFile(GROUP_ID, { displayName: "zq-second", description: "", file: new File(["{}"], "zq-second.json") })
        : useTestingStore.getState().saveSample(GROUP_ID, { displayName: "zq-second", text: "{}", format: "json" });
    useTestingStore.getState().reset();
    answer({ file: SECOND });
    await saving;

    expect(useTestingStore.getState()).toMatchObject({ filesOrganizationId: null, files: [], heads: {} });
  });

  it("deleting a file removes it, its head and, when it was selected, the selection", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValue({ files: [FIRST, SECOND] });
    vi.spyOn(apiClient, "saveTestSample").mockResolvedValue({ file: FIRST });
    const remove = vi.spyOn(apiClient, "deleteTestFile").mockResolvedValue(undefined);
    await useTestingStore.getState().loadFiles(GROUP_ID);
    await useTestingStore.getState().saveSample(GROUP_ID, { displayName: "x", text: "x", format: "text" });
    useTestingStore.getState().setSelectedFile({ id: FIRST.id, displayName: FIRST.displayName });

    await useTestingStore.getState().deleteFile(GROUP_ID, SECOND.id);
    expect(useTestingStore.getState().selectedFile?.id).toBe(FIRST.id);
    await useTestingStore.getState().deleteFile(GROUP_ID, FIRST.id);

    expect(remove).toHaveBeenCalledWith(GROUP_ID, FIRST.id);
    expect(useTestingStore.getState()).toMatchObject({ files: [], selectedFile: null, heads: {} });
  });

  it("a refused delete changes nothing", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValue({ files: [FIRST] });
    vi.spyOn(apiClient, "deleteTestFile").mockRejectedValue(new ApiError("test_file_not_found", "Test file not found", { status: 404 }));
    await useTestingStore.getState().loadFiles(GROUP_ID);

    await expect(useTestingStore.getState().deleteFile(GROUP_ID, FIRST.id)).rejects.toThrow("Test file not found");
    expect(useTestingStore.getState().files).toEqual([FIRST]);
  });

  it("reset forgets the files, the selection, the heads and the runs", async () => {
    vi.spyOn(apiClient, "saveTestSample").mockResolvedValue({ file: FIRST });
    vi.spyOn(apiClient, "queueTestRun").mockResolvedValue({ run: testRunFixture() });
    await useTestingStore.getState().saveSample(GROUP_ID, { displayName: "x", text: "x", format: "text" });
    useTestingStore.getState().setSelectedFile({ id: FIRST.id, displayName: FIRST.displayName });
    useTestingStore.getState().setSelectedPipelineName("logs");
    await useTestingStore.getState().queueRun(TARGET, REQUEST);

    useTestingStore.getState().reset();

    expect(useTestingStore.getState()).toMatchObject({
      filesOrganizationId: null,
      files: [],
      selectedFile: null,
      selectedPipelineName: null,
      heads: {},
      runs: [],
      runsVersionId: null,
    });
  });
});

describe("a file's head for the fixture-shape check", () => {
  it("is the one kept when this tab uploaded or saved the file, with no read", async () => {
    vi.spyOn(apiClient, "saveTestSample").mockResolvedValue({ file: SECOND });
    const read = vi.spyOn(apiClient, "getTestFileHead");
    await useTestingStore.getState().saveSample(GROUP_ID, { displayName: "zq-second", text: "a line\n", format: "text" });

    const head = await useTestingStore.getState().headFor(GROUP_ID, SECOND.id);

    expect(new TextDecoder().decode(head!)).toBe("a line\n");
    expect(read).not.toHaveBeenCalled();
  });

  it("is read from the API for a file from an earlier session, cut to 64 KiB, and kept while the file is listed", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValue({ files: [FIRST] });
    const read = vi.spyOn(apiClient, "getTestFileHead").mockResolvedValue(new Uint8Array(70_000).fill(0x61));
    await useTestingStore.getState().loadFiles(GROUP_ID);

    const head = await useTestingStore.getState().headFor(GROUP_ID, FIRST.id);
    await useTestingStore.getState().headFor(GROUP_ID, FIRST.id);

    expect(head?.length).toBe(64 * 1024);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(GROUP_ID, FIRST.id, { signal: expect.any(AbortSignal) });
    expect(useTestingStore.getState().heads[FIRST.id]?.length).toBe(64 * 1024);
  });

  it("is null when the read fails (the check is skipped), and nothing is kept", async () => {
    vi.spyOn(apiClient, "getTestFileHead").mockRejectedValue(new ApiError("test_file_not_found", "Test file not found", { status: 404 }));

    await expect(useTestingStore.getState().headFor(GROUP_ID, FIRST.id)).resolves.toBeNull();
    expect(useTestingStore.getState().heads).toEqual({});
  });

  it("isn't kept when it answers after signing out", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockResolvedValue({ files: [FIRST] });
    let answer!: (bytes: Uint8Array) => void;
    vi.spyOn(apiClient, "getTestFileHead").mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await useTestingStore.getState().loadFiles(GROUP_ID);

    const reading = useTestingStore.getState().headFor(GROUP_ID, FIRST.id);
    useTestingStore.getState().reset();
    answer(new Uint8Array([0x7b, 0x7d]));
    await reading;

    expect(useTestingStore.getState().heads).toEqual({});
  });
});

describe("the queue and Run's hold", () => {
  it("queues with the API and puts the run, as the list carries it, at the top of the watched version's runs", async () => {
    const run = testRunFixture();
    const queue = vi.spyOn(apiClient, "queueTestRun").mockResolvedValue({ run });
    vi.spyOn(apiClient, "getTestRuns").mockResolvedValue({ runs: [] });
    const stopWatching = useTestingStore.getState().watchRuns(TARGET);
    onTestFinished(stopWatching);

    await expect(useTestingStore.getState().queueRun(TARGET, REQUEST)).resolves.toEqual(run);

    expect(queue).toHaveBeenCalledWith(TARGET.organizationId, TARGET.configurationId, TARGET.versionId, REQUEST);
    const { runs, runsVersionId } = useTestingStore.getState();
    expect(runsVersionId).toBe(VERSION_ID);
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0]!).sort()).toEqual(
      [
        "ahead",
        "collectorVersion",
        "durationSeconds",
        "errorCode",
        "finishedAt",
        "id",
        "inputName",
        "pipeline",
        "queuedAt",
        "queuedByUserId",
        "signal",
        "startedAt",
        "status",
        "suiteId",
        "suiteName",
        "definitionId",
        "definitionName",
      ].sort(),
    );
  });

  it("rejects as the API did, and adds nothing", async () => {
    vi.spyOn(apiClient, "queueTestRun").mockRejectedValue(new ApiError("testing_unavailable", "Testing is unavailable right now. Try again later.", { status: 503 }));

    await expect(useTestingStore.getState().queueRun(TARGET, REQUEST)).rejects.toThrow("Testing is unavailable right now. Try again later.");
    expect(useTestingStore.getState().runs).toEqual([]);
  });

  it("holds Run while the person's own run on this version is queued or running, and only then", () => {
    const held = (runs: ReturnType<typeof testRunFixture>[], userId: string | null = MEMBER_ID, versionId: string | null = VERSION_ID) =>
      selectIsPlayHeld({ runs, runsVersionId: VERSION_ID, playAll: null, starting: null }, userId, versionId);

    expect(held([testRunFixture({ status: "queued" })])).toBe(true);
    expect(held([testRunFixture({ status: "running", ahead: null })])).toBe(true);
    expect(held([testRunFixture({ status: "succeeded", ahead: null })])).toBe(false);
    expect(held([testRunFixture({ status: "failed", ahead: null })])).toBe(false);
    // A teammate's run never holds it, nor a run whose account is gone.
    expect(held([testRunFixture({ queuedByUserId: COLLEAGUE_ID })])).toBe(false);
    expect(held([testRunFixture({ queuedByUserId: null })])).toBe(false);
    // Another version's runs, or no one signed in, or no version open.
    expect(held([testRunFixture()], MEMBER_ID, "0199c000-0000-7000-8000-000000000099")).toBe(false);
    expect(held([testRunFixture()], null)).toBe(false);
    expect(held([testRunFixture()], MEMBER_ID, null)).toBe(false);
  });
});

describe("one hold over every Play", () => {
  const OTHER = { ...TARGET, versionId: "0199c000-0000-7000-8000-000000000099" };
  const held = (versionId: string | null = VERSION_ID, userId: string | null = MEMBER_ID) =>
    selectIsPlayHeld(useTestingStore.getState(), userId, versionId);

  beforeEach(() => {
    useTestingStore.getState().reset();
  });

  it("holds while a single run starts on the version: set at once, so a synchronous second start is refused; released once, by its own start only", () => {
    const store = () => useTestingStore.getState();
    const release = store().beginStart(TARGET, MEMBER_ID);

    expect(release).toBeTypeOf("function");
    expect(held()).toBe(true);
    // Held for whoever looks, and on this version only.
    expect(held(VERSION_ID, null)).toBe(true);
    expect(held(OTHER.versionId)).toBe(false);
    // A second start before anything was awaited sees it.
    expect(store().beginStart(TARGET, MEMBER_ID)).toBe(false);
    expect(store().beginPlayAll(TARGET, "0199f000-0000-7000-8000-000000000001", "parallel", MEMBER_ID)).toBeNull();

    (release as () => void)();
    expect(held()).toBe(false);
    const next = store().beginStart(TARGET, MEMBER_ID) as () => void;
    // The first start's release, called again, never releases the next one's hold.
    (release as () => void)();
    expect(held()).toBe(true);
    next();
    expect(held()).toBe(false);
  });

  it("holds while a Play all is under way on the version: set at once, a synchronous second Play all refused, until it ends", () => {
    const store = () => useTestingStore.getState();
    const run = store().beginPlayAll(TARGET, "0199f000-0000-7000-8000-000000000001", "serial", MEMBER_ID);

    expect(run).not.toBeNull();
    expect(store().playAll).toEqual({ target: TARGET, suiteId: "0199f000-0000-7000-8000-000000000001", mode: "serial" });
    expect(held()).toBe(true);
    expect(store().beginPlayAll(TARGET, "0199f000-0000-7000-8000-000000000002", "parallel", MEMBER_ID)).toBeNull();
    expect(store().beginStart(TARGET, MEMBER_ID)).toBe(false);

    store().endPlayAll(run!);
    expect(store().playAll).toBeNull();
    expect(held()).toBe(false);
  });

  it("refuses every start while the person's own run on the version waits, as Run is held", () => {
    useTestingStore.setState({ runsVersionId: VERSION_ID, runs: [testRunFixture({ status: "queued" })] });

    expect(useTestingStore.getState().beginStart(TARGET, MEMBER_ID)).toBe(false);
    expect(useTestingStore.getState().beginPlayAll(TARGET, "0199f000-0000-7000-8000-000000000001", "parallel", MEMBER_ID)).toBeNull();
    // A teammate starts: their own runs don't hold them.
    expect(useTestingStore.getState().beginStart(TARGET, COLLEAGUE_ID)).toBeTypeOf("function");
  });

  it("stops a Play all on signing out (reset), calling its stop once, and forgets a start", () => {
    const store = () => useTestingStore.getState();
    const run = store().beginPlayAll(TARGET, "0199f000-0000-7000-8000-000000000001", "serial", MEMBER_ID)!;
    const stopped = vi.fn();
    run.onStop = stopped;

    store().reset();

    expect(run.stopped).toBe(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(store().playAll).toBeNull();
    expect(store().beginStart(TARGET, MEMBER_ID)).toBeTypeOf("function");
    store().reset();
    expect(store().starting).toBeNull();
    expect(held()).toBe(false);
  });
});

describe("a queued run's selection", () => {
  it("is left as it was with {select: false}: the run joins the list, the selection stays", async () => {
    vi.spyOn(apiClient, "getTestRuns").mockResolvedValue({ runs: [] });
    const stopWatching = useTestingStore.getState().watchRuns(TARGET);
    onTestFinished(stopWatching);
    const first = testRunFixture({ id: "0199e000-0000-7000-8000-000000000011" });
    const second = testRunFixture({ id: "0199e000-0000-7000-8000-000000000012", queuedAt: "2026-10-09T12:00:01.000Z" });
    vi.spyOn(apiClient, "queueTestRun").mockResolvedValueOnce({ run: first }).mockResolvedValueOnce({ run: second });

    await useTestingStore.getState().queueRun(TARGET, REQUEST);
    await useTestingStore.getState().queueRun(TARGET, REQUEST, { select: false });

    expect(useTestingStore.getState().runs.map((run) => run.id)).toEqual([second.id, first.id]);
    expect(useTestingStore.getState().selectedRunId).toBe(first.id);
  });
});

describe("the templates", () => {
  const TEMPLATE = {
    id: "0199f200-0000-7000-8000-000000000001",
    name: "zq-otlp-logs",
    description: "",
    receiverType: "otlp",
    signal: "logs" as const,
    fileName: "zq-otlp-logs.json",
    contentType: "application/json",
    sizeBytes: 20,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
  };

  it("are read afresh each time, the remembered template kept while listed and dropped once a read no longer lists it; signing out forgets them", async () => {
    const read = vi.spyOn(apiClient, "getTestTemplates").mockResolvedValue({ templates: [TEMPLATE] });
    useTestingStore.getState().setSelectedTemplate({ id: TEMPLATE.id, name: TEMPLATE.name });

    await expect(useTestingStore.getState().loadTemplates()).resolves.toEqual([TEMPLATE]);
    expect(useTestingStore.getState()).toMatchObject({ templates: [TEMPLATE], templatesLoaded: true, templatesLoading: false });
    expect(useTestingStore.getState().selectedTemplate).toEqual({ id: TEMPLATE.id, name: TEMPLATE.name });

    read.mockResolvedValueOnce({ templates: [] });
    await useTestingStore.getState().loadTemplates();
    expect(read).toHaveBeenCalledTimes(2);
    expect(useTestingStore.getState().selectedTemplate).toBeNull();

    await useTestingStore.getState().loadTemplates();
    useTestingStore.getState().reset();
    expect(useTestingStore.getState()).toMatchObject({ templates: [], templatesLoaded: false, selectedTemplate: null });
  });

  it("drop an answer that arrives after signing out, and reject a failed read as the API did", async () => {
    let answer!: (value: { templates: (typeof TEMPLATE)[] }) => void;
    vi.spyOn(apiClient, "getTestTemplates").mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const reading = useTestingStore.getState().loadTemplates();
    useTestingStore.getState().reset();
    answer({ templates: [TEMPLATE] });
    await reading;
    expect(useTestingStore.getState().templates).toEqual([]);

    vi.spyOn(apiClient, "getTestTemplates").mockRejectedValueOnce(new ApiError("unexpected_response", "Unexpected response", { status: 500 }));
    await expect(useTestingStore.getState().loadTemplates()).rejects.toBeInstanceOf(ApiError);
    expect(useTestingStore.getState().templatesLoading).toBe(false);
  });

  it("abort a read that never answers after RUNS_REQUEST_TIMEOUT_MS, which then fails as a read that can't be made", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // Answers only by its abort, as the client does.
    const read = vi.spyOn(apiClient, "getTestTemplates").mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new ApiError(apiClient.REQUEST_ABORTED, "The request was cancelled.")));
        }),
    );
    let outcome: unknown = "pending";
    void useTestingStore
      .getState()
      .loadTemplates()
      .then(
        () => (outcome = "read"),
        (error: unknown) => (outcome = error),
      );

    await vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1);
    expect(outcome).toBe("pending");
    expect(useTestingStore.getState().templatesLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toMatchObject({ code: apiClient.REQUEST_ABORTED });
    expect(useTestingStore.getState().templatesLoading).toBe(false);
    expect(read).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });
});
