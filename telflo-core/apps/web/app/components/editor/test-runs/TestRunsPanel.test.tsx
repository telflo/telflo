/**
 * The Testing tab's runs and results: the list with its places in the queue,
 * each status's row and results, the C-003 callouts, the mutations, the
 * viewers (copy, download), Compare, the re-run of a teammate's run, the
 * polling as the tab shows it, and replay's rules (no file name, text, log or
 * output in any attribute; everything inside `ph-no-capture`).
 *
 * Rendered through TestingTab, which polls the runs (the store's
 * `watchRuns`). Monaco is stubbed: each stub records its props and shows its
 * text as text, as Monaco's own lines are. The API is its client's
 * functions, spied on.
 */

import type { DiffEditorProps, EditorProps } from "@monaco-editor/react";
import {
  DEFAULT_USER_PREFERENCES,
  RULES_UNAVAILABLE_RUN_MESSAGE,
  type EditorPreferences,
  type TestRunDetail,
  type TestRunFile,
  type TestRunSummary,
  type Theme,
} from "@telflo/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const fake = vi.hoisted(() => ({
  editors: [] as EditorProps[],
  diff: null as DiffEditorProps | null,
  /** What the DiffEditor's models and the library saw, in order, as Compare closes. */
  diffEvents: [] as string[],
  /** The DiffEditor's two models' options, as set on them. */
  diffModelOptions: {} as Partial<Record<"original" | "modified", Record<string, unknown>>>,
  initMonaco: (() => Promise.resolve()) as () => Promise<void>,
}));

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: function DiffEditorStub(props: DiffEditorProps) {
    fake.diff = props;
    // The library's own clean-up, after which it disposes the editor (and,
    // unless kept, the models first: the order Monaco reports as an error).
    useEffect(() => {
      // Each model keeps the options set on it, as Monaco's does (the tab size).
      const modelOptions = (side: "original" | "modified") => {
        const options: Record<string, unknown> = { tabSize: 2, indentSize: 2 };
        fake.diffModelOptions[side] = options;
        return {
          getOptions: () => options,
          updateOptions: (next: Record<string, unknown>) => void Object.assign(options, next),
        };
      };
      const models = {
        original: { ...modelOptions("original"), dispose: () => fake.diffEvents.push("original.dispose") },
        modified: { ...modelOptions("modified"), dispose: () => fake.diffEvents.push("modified.dispose") },
      };
      // The models stay reachable here after their release, so a stale update would show in their options.
      const disposeListeners: (() => void)[] = [];
      const diffEditor = {
        getModel: () => models,
        setModel: (model: unknown) => fake.diffEvents.push(model === null ? "setModel(null)" : "setModel"),
        onDidDispose: (listener: () => void) => {
          disposeListeners.push(listener);
          return { dispose: () => undefined };
        },
      };
      props.onMount?.(diffEditor as never, {} as never);
      return () => {
        fake.diffEvents.push("library disposes the editor");
        for (const listener of disposeListeners) listener();
      };
    }, []);
    return (
      <div>
        <pre>{props.original}</pre>
        <pre>{props.modified}</pre>
      </div>
    );
  },
  default: function MonacoStub(props: EditorProps) {
    fake.editors.push(props);
    useEffect(() => {
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
    }, []);
    return <pre data-monaco-stub="">{props.value}</pre>;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => fake.initMonaco(), setMonacoSchema: () => undefined }));

import * as apiClient from "~/lib/api-client.js";
import { ApiError, REQUEST_ABORTED } from "~/lib/api-client.js";
import { formatDateTime } from "~/lib/format.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { RUNS_POLL_INTERVAL_MS, RUNS_REQUEST_TIMEOUT_MS, useTestingStore } from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { COLLEAGUE_ID, GROUP_ID, MEMBER_ID, MINE, signedInMember, THEIRS, versionFixture } from "~/test/configurations.js";
import { testRunFixture, testRunSummaryOf } from "~/test/test-runs.js";
import { MutationsDialog } from "./TestRunResults.js";
import { TestingTab } from "./TestingTab.js";
import { TestRunsPanel } from "./TestRunsPanel.js";
import { monacoAriaHost } from "~/lib/editor/use-aria-container.js";

/** Two pipelines: logs/zqotlp fed by OTLP, logs by filelog. Names carry the private-text marker. */
const YAML = `receivers:
  otlp:
    protocols:
      http: {}
  filelog:
    include: [/var/log/zq-app.log]
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [filelog]
      exporters: [debug]
    logs/zqotlp:
      receivers: [otlp]
      exporters: [debug]
`;
const VERSION = versionFixture({ yamlContent: YAML });

const ENDED = { startedAt: "2026-10-09T12:00:01.000Z", finishedAt: "2026-10-09T12:00:09.000Z", ahead: null };

/** A run that succeeded, with every result (and every private text marked `zq`). */
const SUCCEEDED = testRunFixture({
  id: "0199e000-0000-7000-8000-000000000001",
  status: "succeeded",
  queuedAt: "2026-10-09T12:00:00.000Z",
  ...ENDED,
  pipeline: "logs/zqotlp",
  inputName: "zq-app-logs.json",
  yaml: "zq-original: yaml\n",
  mutatedYaml: "zq-mutated: yaml\n",
  logs: "zq collector log line\n",
  strategy: "otlp",
  compatibility: [
    {
      id: "C-003",
      severity: "advisory",
      component: "processors/zq_tail_sampling",
      message: "zq decision wait is longer than the run",
      details: { recommended_duration_seconds: 12, recommended_covers_window: true },
    },
    {
      id: "C-003",
      severity: "advisory",
      component: "processors/zq_long_wait",
      message: "zq decision wait is longer than any run",
      details: { recommended_duration_seconds: 60, recommended_covers_window: false },
    },
    { id: "C-002", severity: "refuse", component: "processors/zqk8s", message: "zq refused finding", details: {} },
  ],
  mutations: [
    { id: "R-001", severity: "info", message: "zq receivers swapped", details: { receiver: "zq-otlp" } },
    { id: "R-103", severity: "caution", message: "zq detector stripped", details: {} },
    { id: "R-105", severity: "warn", message: "zq providers neutralised", details: {} },
  ],
  outputSizeBytes: 18,
  outputTruncated: false,
  decodedInputSizeBytes: 16,
  decodedInputTruncated: false,
});

/** A run that failed before producing output, with its message and logs. */
const FAILED = testRunFixture({
  id: "0199e000-0000-7000-8000-000000000002",
  status: "failed",
  queuedAt: "2026-10-09T12:01:00.000Z",
  ...ENDED,
  pipeline: "logs",
  inputName: "zq-lines.log",
  errorCode: "tester_error",
  errorMessage: "zq the collector exited with status 1",
  logs: "zq failed collector output\n",
  strategy: "filelog",
  mutations: [],
  compatibility: [],
});

/** A teammate's run, running. */
const TEAMMATE_RUNNING = testRunFixture({
  id: "0199e000-0000-7000-8000-000000000003",
  status: "running",
  queuedAt: "2026-10-09T12:02:00.000Z",
  startedAt: "2026-10-09T12:02:01.000Z",
  ahead: null,
  queuedByUserId: COLLEAGUE_ID,
});

/** The person's own run, third in line. */
const MINE_QUEUED = testRunFixture({
  id: "0199e000-0000-7000-8000-000000000004",
  status: "queued",
  queuedAt: "2026-10-09T12:03:00.000Z",
  ahead: 2,
  queuedByUserId: MEMBER_ID,
});

/** A teammate's run that succeeded, on the filelog pipeline. */
const TEAMMATE_SUCCEEDED = testRunFixture({
  ...SUCCEEDED,
  id: "0199e000-0000-7000-8000-000000000005",
  queuedByUserId: COLLEAGUE_ID,
  queuedAt: "2026-10-09T11:00:00.000Z",
  pipeline: "logs/zqotlp",
  durationSeconds: 17,
});

/** Two rules the runs below copied: a text rule and an OTTL rule (their texts private). */
const VALIDATION_RULES: TestRunDetail["validationRules"] = [
  {
    id: "0199f400-0000-7000-8000-000000000001",
    position: 1,
    kind: "not_contains_text",
    target: "output",
    pattern: "zq-secret",
    ottl: null,
    name: "zq-no-secrets",
    description: "",
  },
  {
    id: "0199f400-0000-7000-8000-000000000002",
    position: 2,
    kind: "ottl",
    target: "output",
    pattern: null,
    ottl: { context: "log", condition: 'attributes["zq-env"] == "prod"', quantifier: "all" },
    name: "",
    description: "",
  },
];

/** A run whose collector ran and whose second rule failed. */
const VALIDATION_FAILED = testRunFixture({
  ...SUCCEEDED,
  id: "0199e000-0000-7000-8000-000000000006",
  status: "validation_failed",
  validationRules: VALIDATION_RULES,
  validationResults: [
    { id: VALIDATION_RULES[0]!.id, passed: true, error: null, advisory: null, detail: null },
    {
      id: VALIDATION_RULES[1]!.id,
      passed: false,
      error: null,
      advisory: null,
      detail: { kind: "record_mismatch", context: "log", totalCount: 10, matchedCount: 7, missCount: 3, misses: [] },
    },
  ],
});

/** A run the rule evaluator couldn't check: Error, its output and logs kept. */
const RULES_UNAVAILABLE = testRunFixture({
  ...SUCCEEDED,
  id: "0199e000-0000-7000-8000-000000000007",
  status: "failed",
  errorCode: "rules_unavailable",
  errorMessage: RULES_UNAVAILABLE_RUN_MESSAGE,
  validationRules: VALIDATION_RULES,
  validationResults: null,
});

const encode = (text: string) => new TextEncoder().encode(text);

/** The input as uploaded, UTF-16LE with its mark: a viewer decodes it, a download keeps its bytes. */
const INPUT_UTF16 = new Uint8Array([0xff, 0xfe, ...[...'{"zq":"input"}'].flatMap((character) => [character.charCodeAt(0), 0])]);

/** Each run's stored files, by run id. */
const FILES: Record<string, Partial<Record<TestRunFile, Uint8Array>>> = {
  [SUCCEEDED.id]: { input: INPUT_UTF16, output: encode('{"zq":1}\n{"zq":2}\n'), "decoded-input": encode('{"zq":"decoded"}') },
  [FAILED.id]: { input: encode("zq line one\nzq line two\n") },
  [TEAMMATE_SUCCEEDED.id]: { input: encode('{"resourceLogs":[{"zq":"teammate"}]}') },
};

const summaryOf = testRunSummaryOf;

let runsServed: TestRunDetail[] = [];
let listRuns: MockInstance<typeof apiClient.getTestRuns>;
let readRun: MockInstance<typeof apiClient.getTestRun>;
let readFile: MockInstance<typeof apiClient.getTestRunFile>;
let readHead: MockInstance<typeof apiClient.getTestRunInputHead>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

/** The API lists `runs` (newest first, as summaries), reads each in full, and serves their files. */
function serve(...runs: TestRunDetail[]) {
  runsServed = runs;
}

/** The user store holding the member with `theme` and `editor` (Settings' choices). */
function choose(theme: Theme, editor: Partial<EditorPreferences> = {}) {
  const member = signedInMember(GROUP_ID);
  useUserStore.getState().setCurrent({
    ...member,
    preferences: { ...member.preferences, theme, editor: { ...DEFAULT_USER_PREFERENCES.editor, ...editor } },
  });
}

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  fake.editors = [];
  fake.diff = null;
  fake.diffEvents = [];
  fake.diffModelOptions = {};
  fake.initMonaco = () => Promise.resolve();
  runsServed = [];
  listRuns = vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: runsServed.map(summaryOf) }));
  readRun = vi.spyOn(apiClient, "getTestRun").mockImplementation(async (_o, _c, _v, runId) => {
    const run = runsServed.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new ApiError("test_run_not_found", "Test run not found", { status: 404 });
    return { run };
  });
  readFile = vi.spyOn(apiClient, "getTestRunFile").mockImplementation(async (_o, _c, _v, runId, file) => {
    const bytes = FILES[runId]?.[file];
    if (bytes === undefined) throw new ApiError("test_run_not_found", "Test run not found", { status: 404 });
    return bytes;
  });
  readHead = vi.spyOn(apiClient, "getTestRunInputHead").mockImplementation(async (_o, _c, _v, runId) => {
    const bytes = FILES[runId]?.input;
    if (bytes === undefined) throw new ApiError("test_run_not_found", "Test run not found", { status: 404 });
    return bytes.slice(0, 65_536);
  });
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
});

afterEach(() => {
  // Unmounted first, so the reset (the polling stopped, the runs gone)
  // updates no component outside act; Testing Library's own clean-up runs
  // after this hook.
  cleanup();
  useTestingStore.getState().reset();
});

function renderTab() {
  const view = render(<TestingTab />);
  return { ...view, user: userEvent.setup() };
}

/** Renders the tab with `runs` listed and the row whose badge says `status` selected. */
async function select(status: RegExp, ...runs: TestRunDetail[]) {
  serve(...runs);
  const view = renderTab();
  await view.user.click(await screen.findByRole("button", { name: status }));
  return view;
}

/** The results pane (the list's sibling). */
const results = () => screen.getByRole("region", { name: "Test results" });

describe("the list", () => {
  it("shows the version's runs newest first under Created and Status: the time queued and the badge, 'Queued (n ahead)' while waiting, 'Validation Failed' for a run whose rules failed", async () => {
    // A run whose collector ran and one of whose rules failed.
    const validationFailed = testRunFixture({
      ...SUCCEEDED,
      id: "0199e000-0000-7000-8000-000000000006",
      status: "validation_failed",
      queuedAt: "2026-10-09T12:00:30.000Z",
    });
    serve(MINE_QUEUED, TEAMMATE_RUNNING, FAILED, validationFailed, SUCCEEDED);
    renderTab();

    const rows = await screen.findAllByRole("button", { pressed: false });
    expect(rows.map((button) => button.textContent)).toEqual([
      `${formatDateTime(MINE_QUEUED.queuedAt)}Queued (2 ahead)`,
      `${formatDateTime(TEAMMATE_RUNNING.queuedAt)}Running`,
      `${formatDateTime(FAILED.queuedAt)}Error`,
      `${formatDateTime(validationFailed.queuedAt)}Validation Failed`,
      `${formatDateTime(SUCCEEDED.queuedAt)}Success`,
    ]);
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Status", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("No test selected")).toBeInTheDocument();
    expect(listRuns).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, { signal: expect.any(AbortSignal) });
  });

  it("shows a suite's run's 'Suite › Configuration' breadcrumb under its time, a one-off run none, the names as text only; the help says so", async () => {
    const fromSuite = testRunFixture({
      ...SUCCEEDED,
      id: "0199e000-0000-7000-8000-000000000042",
      queuedAt: "2026-10-09T12:30:00.000Z",
      suiteId: "0199f000-0000-7000-8000-000000000001",
      suiteName: "zq-smoke-tests",
      definitionId: "0199f100-0000-7000-8000-000000000001",
      definitionName: "zq-logs-only",
    });
    serve(fromSuite, FAILED);
    const { user } = renderTab();

    const rows = await screen.findAllByRole("button", { pressed: false });
    expect(rows.map((button) => button.textContent)).toEqual([
      `${formatDateTime(fromSuite.queuedAt)}zq-smoke-tests › zq-logs-onlySuccess`,
      `${formatDateTime(FAILED.queuedAt)}Error`,
    ]);
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of element.attributes) expect(attribute.value).not.toMatch(/zq-smoke|zq-logs-only/);
    }
    // Not in the results.
    await user.click(rows[0]!);
    expect(within(results()).queryByText(/zq-smoke-tests/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "What is this panel?" }));
    // The panel's words, validation results included.
    expect(await screen.findByText(/^Run tests and review past runs/)).toHaveTextContent(
      "Run tests and review past runs for this configuration version. Select a row to see its status, output, and validation results in the detail pane below.",
    );
    expect(await screen.findByText(/Tests ran from a suite carry a/)).toHaveTextContent(
      "Tests ran from a suite carry a Suite › Configuration breadcrumb; one-off runs don't. Use a row's ↺ button to re-run that test against the current YAML.",
    );
  });

  it("says 'Queued' alone for a waiting run whose place isn't known", async () => {
    serve(testRunFixture({ ...MINE_QUEUED, ahead: null }));
    renderTab();

    expect(await screen.findByRole("button", { name: /Queued$/ })).toBeInTheDocument();
  });

  it("says 'No test runs yet for this version.' with none, a spinner while the first read is under way, and asks for a version without one", async () => {
    let answer!: (value: { runs: TestRunSummary[] }) => void;
    listRuns.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderTab();

    expect(screen.getByRole("status", { name: "Loading test runs" })).toBeInTheDocument();
    act(() => answer({ runs: [] }));
    expect(await screen.findByText("No test runs yet for this version.")).toBeInTheDocument();

    act(() => useEditorStore.getState().reset());
    expect(screen.getByText("Load a configuration version to see test runs.")).toBeInTheDocument();
  });

  it("refreshes a teammate's run while it runs", async () => {
    vi.useFakeTimers();
    try {
      serve(TEAMMATE_RUNNING);
      render(<TestingTab />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("button", { name: /Running/ })).toBeInTheDocument();

      serve(testRunFixture({ ...TEAMMATE_RUNNING, status: "succeeded", finishedAt: "2026-10-09T12:02:09.000Z" }));
      await act(() => vi.advanceTimersByTimeAsync(RUNS_POLL_INTERVAL_MS));

      expect(screen.getByRole("button", { name: /Success/ })).toBeInTheDocument();
      expect(listRuns).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows 'Failed to refresh test runs' with Retry once the polling has stopped, and Retry reads again", async () => {
    serve(SUCCEEDED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Success/ });
    const reads = listRuns.mock.calls.length;

    act(() => useTestingStore.setState({ runsError: "Failed to refresh test runs" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to refresh test runs");
    // The runs read before stay listed.
    expect(screen.getByRole("button", { name: /Success/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(listRuns.mock.calls.length).toBe(reads + 1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows a failed first read at once, with Retry, not a toast", async () => {
    listRuns.mockRejectedValueOnce(new apiClient.ApiError("network_error", "Could not reach the server."));
    const { user } = renderTab();

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load test runs");
    expect(screen.queryByRole("status", { name: "Loading test runs" })).toBeNull();
    serve(SUCCEEDED);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: /Success/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a refusal's own words at once, with Retry, and stops asking", async () => {
    listRuns.mockRejectedValue(new apiClient.ApiError("configuration_not_found", "Configuration not found", { status: 404 }));
    renderTab();

    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration not found");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(listRuns).toHaveBeenCalledTimes(1);
  });

  it("stops polling on a version switch and when the tab unmounts: the read under way aborted", async () => {
    const signals: { versionId: string; signal: AbortSignal }[] = [];
    listRuns.mockImplementation(
      (_o, _c, versionId, options) =>
        new Promise(() => {
          if (options?.signal) signals.push({ versionId, signal: options.signal });
        }),
    );
    const { unmount } = renderTab();
    await waitFor(() => expect(signals).toHaveLength(1));

    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000099", yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]).toMatchObject({ versionId: VERSION.id, signal: { aborted: true } });
    expect(signals[1]).toMatchObject({ versionId: other.id, signal: { aborted: false } });

    unmount();
    expect(signals[1]!.signal.aborted).toBe(true);
  });
});

describe("each status's results", () => {
  it("queued: the status with the place in line, nothing read in full", async () => {
    await select(/Queued \(2 ahead\)/, MINE_QUEUED);

    expect(within(results()).getByText("Queued (2 ahead)")).toBeInTheDocument();
    expect(screen.queryByText("Pipeline:")).toBeNull();
    expect(readRun).not.toHaveBeenCalled();
  });

  it("running: the status alone", async () => {
    await select(/Running/, TEAMMATE_RUNNING);

    expect(within(results()).getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Original YAML")).toBeNull();
    expect(readRun).not.toHaveBeenCalled();
  });

  it("success: read in full once; the pipeline, both texts, the mutations, the logs, the files and Compare; no Error", async () => {
    await select(/Success/, SUCCEEDED);

    expect(await within(results()).findByText("Pipeline:")).toBeInTheDocument();
    const pane = results();
    expect(within(pane).getByText("Success")).toBeInTheDocument();
    expect(within(pane).getByText("logs/zqotlp")).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Original YAML" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Test YAML" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Mutations (3)" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Logs" })).toBeInTheDocument();
    expect(within(pane).getByText("Input File:")).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "zq-app-logs.json" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Download zq-app-logs.json" })).toBeInTheDocument();
    expect(within(pane).getByText("Output File:")).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "test-output.json" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Compare input ↔ output" })).toBeEnabled();
    expect(within(pane).queryByText("Error")).toBeNull();
    expect(readRun).toHaveBeenCalledTimes(1);
    expect(readRun).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, SUCCEEDED.id, { signal: expect.any(AbortSignal) });
  });

  it("error: the run's message under Error, the logs only behind Logs (not twice), 'Output File: no output produced', Compare held", async () => {
    await select(/Error/, FAILED);

    const message = await screen.findByText("zq the collector exited with status 1");
    const pane = results();
    expect(within(pane).getAllByText("Error")).toHaveLength(2); // the header's status and the section's label
    expect(message.tagName).toBe("PRE");
    expect(within(pane).getByRole("button", { name: "Logs" })).toBeInTheDocument();
    expect(screen.queryByText(/zq failed collector output/)).toBeNull();
    expect(within(pane).getByText("Output File:")).toBeInTheDocument();
    expect(within(pane).getByText("no output produced")).toBeInTheDocument();
    expect(within(pane).queryByText(/Test Results File/)).toBeNull();
    expect(within(pane).queryByRole("button", { name: "Test YAML" })).toBeNull();
    expect(within(pane).queryByRole("button", { name: /Mutations/ })).toBeNull();
    const compare = within(pane).getByRole("button", { name: "Compare input ↔ output" });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute("title", "No output captured — nothing to compare");
  });

  it("error without a message: '(no error message captured)'", async () => {
    await select(/Error/, testRunFixture({ ...FAILED, errorMessage: null }));

    expect(await screen.findByText("(no error message captured)")).toBeInTheDocument();
  });

  it("a run whose rules failed: 'Validation Failed' in the list (a warn badge) and the header, then its output and its Validation grid, no Error", async () => {
    await select(/Validation Failed/, VALIDATION_FAILED);

    const badge = within(screen.getByRole("button", { name: /Validation Failed/ })).getByText("Validation Failed");
    expect(badge).toHaveClass("text-warn", "bg-warn-soft");
    const pane = results();
    expect(await within(pane).findByText("Pipeline:")).toBeInTheDocument();
    expect(within(pane).getByText("Validation Failed")).toBeInTheDocument();
    expect(within(pane).getByText("Validation Failed").closest("div")?.previousElementSibling).toHaveClass("text-warn", "bg-warn-soft");
    expect(within(pane).getByRole("button", { name: "test-output.json" })).toBeInTheDocument();
    const grid = within(pane).getByRole("list", { name: "Validation" });
    expect(within(grid).getAllByRole("img").map((icon) => icon.getAttribute("aria-label"))).toEqual(["Passed", "Failed"]);
    expect(within(pane).getByText("1 of 2 rules passed")).toBeInTheDocument();
    expect(within(pane).queryByText("Error")).toBeNull();
  });

  it("an evaluator outage: Error with its message, the output, the logs and the text still there, and no grid", async () => {
    await select(/Error/, RULES_UNAVAILABLE);

    const message = await within(results()).findByText(RULES_UNAVAILABLE_RUN_MESSAGE);
    expect(message.tagName).toBe("PRE");
    const pane = results();
    expect(within(pane).getAllByText("Error")).toHaveLength(2); // the header's status and the section's label
    expect(within(pane).getByRole("button", { name: "Original YAML" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Logs" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "test-output.json" })).toBeInTheDocument();
    expect(within(pane).getByRole("button", { name: "Compare input ↔ output" })).toBeEnabled();
    expect(within(pane).queryByRole("list", { name: "Validation" })).toBeNull();
    expect(within(pane).queryByText(/rules? passed/)).toBeNull();
  });

  it("a run without rules shows no grid", async () => {
    await select(/Success/, testRunFixture({ ...SUCCEEDED, validationRules: [], validationResults: null }));

    expect(await within(results()).findByText("Pipeline:")).toBeInTheDocument();
    expect(within(results()).queryByText("Validation")).toBeNull();
  });

  it("says when the full read failed, and Try again reads it again", async () => {
    readRun.mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server."));
    const { user } = await select(/Success/, SUCCEEDED);

    expect(await screen.findByText("Failed to load test run")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Pipeline:")).toBeInTheDocument();
    expect(readRun).toHaveBeenCalledTimes(2);
  });
});

describe("compatibility (C-003's callouts)", () => {
  it("shows each finding's badge, id and component, its message, and C-003's recommended duration", async () => {
    await select(/Success/, SUCCEEDED);
    await screen.findByText("Compatibility");

    expect(screen.getAllByText("Advisory")).toHaveLength(2);
    expect(screen.getByText("Refused")).toBeInTheDocument();
    expect(screen.getByText("C-003 · processors/zq_tail_sampling")).toBeInTheDocument();
    expect(screen.getByText("C-002 · processors/zqk8s")).toBeInTheDocument();
    expect(screen.getByText("zq refused finding")).toBeInTheDocument();
    const [faithful, beyond] = screen.getAllByText(/This run used a/);
    expect(faithful).toHaveTextContent("This run used a 5s window. Re-run with the Run duration set to at least 12s for a faithful result.");
    expect(beyond).toHaveTextContent(
      "This run used a 5s window. Even the maximum 60s run won't fully cover this pipeline's decision window — lower the window to test it faithfully.",
    );
  });

  it("shows no callout for a C-003 finding without a recommended duration, and no section without findings", async () => {
    const plain = testRunFixture({
      ...SUCCEEDED,
      compatibility: [{ id: "C-003", severity: "advisory", component: "processors/zq", message: "zq wait", details: {} }],
    });
    await select(/Success/, plain);
    await screen.findByText("Compatibility");
    expect(screen.queryByText(/This run used a/)).toBeNull();
  });
});

describe("the mutations", () => {
  it("open 'Sandbox mutations': the intro, each one's severity, id, message and details; Close", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Mutations (3)" }));

    const dialog = await screen.findByRole("dialog", { name: "Sandbox mutations" });
    expect(
      within(dialog).getByText(
        "The test runner rewrites your YAML before execution so the sandbox can run safely. Each entry below explains a change made to the configuration that was actually executed.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      'InfoR-001zq receivers swapped{\n  "receiver": "zq-otlp"\n}',
      "CautionR-103zq detector stripped",
      "WarningR-105zq providers neutralised",
    ]);
    expect(dialog).toHaveClass("ph-no-capture");

    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("say 'No mutations were applied.' when there are none", () => {
    render(<MutationsDialog mutations={[]} open onOpenChange={() => undefined} />);

    expect(screen.getByText("No mutations were applied.")).toBeInTheDocument();
  });
});

describe("the viewers", () => {
  let created: Blob[];
  let clicked: { connected: boolean; download: string; href: string }[];

  beforeEach(() => {
    created = [];
    clicked = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        created.push(blob);
        return `blob:stub-${created.length}`;
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ connected: this.isConnected, download: this.download, href: this.href });
    });
  });

  const bytesOf = (blob: Blob) =>
    new Promise<number[]>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
      reader.readAsArrayBuffer(blob);
    });

  it("show the input, decoded from UTF-16, pretty-printed in a read-only telflo-themed Monaco inside ph-no-capture, its live region inside too", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "zq-app-logs.json" }));

    const dialog = await screen.findByRole("dialog", { name: "zq-app-logs.json" });
    expect(await within(dialog).findByText('{ "zq": "input" }', { normalizer: (text) => text.replace(/\s+/g, " ") })).toBeInTheDocument();
    expect(readFile).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, SUCCEEDED.id, "input");
    const props = fake.editors.at(-1)!;
    expect(props.language).toBe("json");
    // The store's theme: the member's default, Dark.
    expect(props.theme).toBe("telflo-dark");
    expect(props).not.toHaveProperty("path");
    const options = props.options as { readOnly?: boolean; ariaContainerElement?: HTMLElement };
    expect(options.readOnly).toBe(true);
    const block = within(dialog).getByText(/"zq": "input"/).closest(".ph-no-capture");
    expect(block).not.toBeNull();
    // The live region: the shell's one replay-blocked host, which outlives the dialog.
    expect(options.ariaContainerElement).toBe(monacoAriaHost());
    expect(options.ariaContainerElement!.closest(".ph-no-capture")).not.toBeNull();
  });

  it("copy one JSON document as compact JSON, saying so, and close", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "zq-app-logs.json" }));
    const dialog = await screen.findByRole("dialog", { name: "zq-app-logs.json" });
    const copy = await within(dialog).findByRole("button", { name: "Copy" });
    await waitFor(() => expect(copy).toBeEnabled());
    expect(copy).toHaveAttribute("title", "Copy as compact JSON");

    await user.click(copy);

    expect(await navigator.clipboard.readText()).toBe('{"zq":"input"}');
    expect(toastSuccess).toHaveBeenCalledWith("Copied to clipboard");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("copy NDJSON as one compact document a line, and text as it is", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "test-output.json" }));
    let dialog = await screen.findByRole("dialog", { name: "Test output" });
    let copy = within(dialog).getByRole("button", { name: "Copy" });
    await waitFor(() => expect(copy).toHaveAttribute("title", "Copy as NDJSON (one compact object per line)"));
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe('{"zq":1}\n{"zq":2}');
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Logs" }));
    dialog = await screen.findByRole("dialog", { name: "Collector logs (stderr)" });
    copy = within(dialog).getByRole("button", { name: "Copy" });
    await waitFor(() => expect(copy).toBeEnabled());
    expect(copy).toHaveAttribute("title", "Copy text");
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe("zq collector log line");
  });

  it("download the input's exact bytes under its name through a detached anchor: no name in a URL, no anchor in <body>", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "zq-app-logs.json" }));
    const dialog = await screen.findByRole("dialog", { name: "zq-app-logs.json" });
    const download = within(dialog).getByRole("button", { name: "Download" });
    await waitFor(() => expect(download).toBeEnabled());

    await user.click(download);

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]).toEqual({ connected: false, download: "zq-app-logs.json", href: "blob:stub-1" });
    expect(clicked[0]!.href).not.toContain("zq");
    expect(await bytesOf(created[0]!)).toEqual([...INPUT_UTF16]);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    // The viewer's read is reused: the file was fetched once.
    expect(readFile.mock.calls.filter((call) => call[4] === "input")).toHaveLength(1);
  });

  it("download from the rows too: the output as test-output.json, the logs as collector-logs.txt", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Download test-output.json" }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]).toMatchObject({ connected: false, download: "test-output.json" });
    expect(await bytesOf(created[0]!)).toEqual([...encode('{"zq":1}\n{"zq":2}\n')]);

    await user.click(screen.getByRole("button", { name: "Logs" }));
    const dialog = await screen.findByRole("dialog", { name: "Collector logs (stderr)" });
    const download = within(dialog).getByRole("button", { name: "Download" });
    await waitFor(() => expect(download).toBeEnabled());
    await user.click(download);
    await waitFor(() => expect(clicked).toHaveLength(2));
    expect(clicked[1]).toMatchObject({ connected: false, download: "collector-logs.txt" });
    expect(await bytesOf(created[1]!)).toEqual([...encode("zq collector log line")]);
  });

  it("show the original and the mutated text, without Download", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Original YAML" }));
    let dialog = await screen.findByRole("dialog", { name: "Original YAML" });
    expect(await within(dialog).findByText(/zq-original: yaml/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Download" })).toBeNull();
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Test YAML" }));
    dialog = await screen.findByRole("dialog", { name: "Test YAML (after sandbox mutations)" });
    expect(await within(dialog).findByText(/zq-mutated: yaml/)).toBeInTheDocument();
  });

  it("say '(empty file)' for an empty file, the API's words for a refusal, and 'Failed to load file' otherwise", async () => {
    readFile.mockResolvedValueOnce(new Uint8Array());
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "test-output.json" }));
    let dialog = await screen.findByRole("dialog", { name: "Test output" });
    expect(await within(dialog).findByText("(empty file)")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy" })).toBeDisabled();
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    readFile.mockRejectedValueOnce(new ApiError("test_run_not_found", "Test run not found", { status: 404 }));
    await user.click(screen.getByRole("button", { name: "zq-app-logs.json" }));
    dialog = await screen.findByRole("dialog", { name: "zq-app-logs.json" });
    expect(await within(dialog).findByText("Test run not found")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Download" })).toBeDisabled();
    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    readFile.mockRejectedValueOnce(new ApiError("unexpected_response", "The server returned an unexpected response."));
    await user.click(screen.getByRole("button", { name: "zq-app-logs.json" }));
    dialog = await screen.findByRole("dialog", { name: "zq-app-logs.json" });
    expect(await within(dialog).findByText("Failed to load file")).toBeInTheDocument();
  });

  it("wait for Monaco before mounting it, and offer 'Try again' when it fails to load", async () => {
    let attempts = 0;
    fake.initMonaco = () => (++attempts === 1 ? Promise.reject(new Error("chunk")) : Promise.resolve());
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Original YAML" }));

    expect(await screen.findByText("The editor couldn't load.")).toBeInTheDocument();
    expect(fake.editors).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/zq-original: yaml/)).toBeInTheDocument();
  });

  it("toast the API's words when a row's download fails", async () => {
    readFile.mockRejectedValueOnce(new ApiError("test_run_not_found", "Test run not found", { status: 404 }));
    const { user } = await select(/Success/, SUCCEEDED);

    await user.click(await screen.findByRole("button", { name: "Download zq-app-logs.json" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Test run not found"));
    expect(clicked).toHaveLength(0);
  });
});

describe("Compare", () => {
  it("is enabled only with both the decoded input and the output", async () => {
    await select(/Success/, testRunFixture({ ...SUCCEEDED, decodedInputSizeBytes: null }));
    const compare = await screen.findByRole("button", { name: "Compare input ↔ output" });

    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute("title", "Compare requires an OTLP input");
  });

  it("shows the decoded input beside the output in a JSON DiffEditor, inside ph-no-capture with its live region", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    const compare = await screen.findByRole("button", { name: "Compare input ↔ output" });
    expect(compare).toHaveAttribute("title", "Compare parsed OTLP input vs output side-by-side");

    await user.click(compare);

    const dialog = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
    await waitFor(() => expect(fake.diff?.original).toBe('{\n  "zq": "decoded"\n}'));
    expect(fake.diff?.modified).toBe('{\n  "zq": 1\n}\n\n{\n  "zq": 2\n}');
    expect(fake.diff?.language).toBe("json");
    expect(fake.diff?.theme).toBe("telflo-dark");
    const options = fake.diff?.options as { readOnly?: boolean; renderSideBySide?: boolean; ariaContainerElement?: HTMLElement };
    expect(options).toMatchObject({ readOnly: true, renderSideBySide: true });
    expect(dialog).toHaveClass("ph-no-capture");
    expect(options.ariaContainerElement).toBe(monacoAriaHost());
    expect(options.ariaContainerElement!.closest(".ph-no-capture")).not.toBeNull();
    expect(readFile.mock.calls.map((call) => call[4]).sort()).toEqual(["decoded-input", "output"]);
    // Not OTLP: no record attributes, so no rule footer (the chips: CompareViewerDialog.test.tsx).
    expect(within(dialog).queryByText(/rule/i)).toBeNull();
  });

  it("takes the theme and the font size, line numbers and tab size from the store, no minimap", async () => {
    choose("navy", { tabSize: 4, fontSize: 16, lineNumbers: false, minimap: true });
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Compare input ↔ output" }));
    await waitFor(() => expect(fake.diff?.original).toBe('{\n  "zq": "decoded"\n}'));

    expect(fake.diff?.theme).toBe("telflo-navy");
    expect(fake.diff?.options).toMatchObject({ fontSize: 16, lineNumbers: "off" });
    // Monaco's diff editor never shows a minimap, so Compare passes none.
    expect(fake.diff?.options).not.toHaveProperty("minimap");
    expect(fake.diffModelOptions.original).toMatchObject({ tabSize: 4, indentSize: 4 });
    expect(fake.diffModelOptions.modified).toMatchObject({ tabSize: 4, indentSize: 4 });
  });

  it("a change of the store's preferences reaches the open diff editor, both models' tab size included", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Compare input ↔ output" }));
    await waitFor(() => expect(fake.diff?.original).toBe('{\n  "zq": "decoded"\n}'));
    const original = fake.diffModelOptions.original;
    expect(original).toMatchObject({ tabSize: 2 });

    act(() => choose("light", { tabSize: 4, fontSize: 18, lineNumbers: false }));

    expect(fake.diff?.theme).toBe("vs");
    expect(fake.diff?.options).toMatchObject({ fontSize: 18, lineNumbers: "off" });
    // The same models, the open editor's.
    expect(fake.diffModelOptions.original).toBe(original);
    expect(fake.diffModelOptions.original).toMatchObject({ tabSize: 4, indentSize: 4 });
    expect(fake.diffModelOptions.modified).toMatchObject({ tabSize: 4, indentSize: 4 });
  });

  it("releases the DiffEditor's models after resetting it, before the library disposes the editor", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Compare input ↔ output" }));
    const dialog = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
    await waitFor(() => expect(fake.diff?.original).toBe('{\n  "zq": "decoded"\n}'));
    expect(fake.diff).toMatchObject({ keepCurrentOriginalModel: true, keepCurrentModifiedModel: true });

    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.diffEvents).toEqual(["setModel(null)", "original.dispose", "modified.dispose", "library disposes the editor"]);
  });

  it("a tab size changed after Compare closes reaches none of its released models (the dialog stays mounted)", async () => {
    const { user } = await select(/Success/, SUCCEEDED);
    await user.click(await screen.findByRole("button", { name: "Compare input ↔ output" }));
    const dialog = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
    await waitFor(() => expect(fake.diff?.original).toBe('{\n  "zq": "decoded"\n}'));
    const original = fake.diffModelOptions.original;
    const modified = fake.diffModelOptions.modified;
    expect(original).toMatchObject({ tabSize: 2, indentSize: 2 });

    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.diffEvents).toContain("library disposes the editor");

    act(() => choose("light", { tabSize: 4 }));
    expect(original).toEqual({ tabSize: 2, indentSize: 2 });
    expect(modified).toEqual({ tabSize: 2, indentSize: 2 });
  });
});

describe("the re-run", () => {
  let queue: MockInstance<typeof apiClient.queueTestRun>;

  beforeEach(() => {
    queue = vi.spyOn(apiClient, "queueTestRun").mockImplementation(async (_o, _c, _v, request) => {
      const run = testRunFixture({
        id: "0199e000-0000-7000-8000-000000000009",
        queuedAt: "2026-10-09T13:00:00.000Z",
        status: "queued",
        ahead: 0,
        sourceRunId: "definitionId" in request ? null : (request.sourceRunId ?? null),
      });
      // The API lists it from now on.
      runsServed = [run, ...runsServed];
      return { run };
    });
  });

  it("re-runs a teammate's run through its own input, with its pipeline, signal and duration and the CURRENT raw text; the new run selected and holding ↺", async () => {
    serve(TEAMMATE_SUCCEEDED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Success/ });
    act(() => useEditorStore.getState().setText(`${YAML}# zq edited since\n`));

    await user.click(screen.getByRole("button", { name: "Re-run test" }));

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(queue).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, {
      sourceRunId: TEAMMATE_SUCCEEDED.id,
      pipeline: "logs/zqotlp",
      signal: "logs",
      durationSeconds: 17,
      yaml: `${YAML}# zq edited since\n`,
      collectorVersion: "0.162.0",
    });
    // The fixture-shape check read the head of the run's input, never the whole input.
    expect(readHead).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, TEAMMATE_SUCCEEDED.id, { signal: expect.any(AbortSignal) });
    expect(readFile).not.toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, TEAMMATE_SUCCEEDED.id, "input");
    expect(await within(results()).findByText("Queued (0 ahead)")).toBeInTheDocument();
    await waitFor(() => {
      for (const button of screen.getAllByRole("button", { name: "Re-run test" })) expect(button).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Configure and run" })).toBeDisabled();
  });

  it("moves the focus to the new run's row once queued, not the held ↺", async () => {
    serve(TEAMMATE_SUCCEEDED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Success/ });

    await user.click(screen.getByRole("button", { name: "Re-run test" }));

    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-pressed", "true"));
    expect(document.activeElement).toHaveAccessibleName(/Queued/);
    expect(document.activeElement).toBeEnabled();
  });

  it("asks the fixture-shape question first when the run's input doesn't suit the pipeline, and 'Run Anyway' queues it", async () => {
    // Raw lines on the OTLP pipeline.
    readHead.mockResolvedValueOnce(encode("zq raw line one\nzq raw line two\n"));
    serve(TEAMMATE_SUCCEEDED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Success/ });
    await user.click(screen.getByRole("button", { name: "Re-run test" }));

    const question = await screen.findByRole("dialog", { name: "Fixture may not match the receiver" });
    expect(queue).not.toHaveBeenCalled();
    await user.click(within(question).getByRole("button", { name: "Run Anyway" }));

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(queue.mock.calls[0]?.[3]).toMatchObject({ sourceRunId: TEAMMATE_SUCCEEDED.id });
  });

  it("drops the question when the run's head answers after the version changed: no question, nothing queued, the hold released", async () => {
    let answer!: (bytes: Uint8Array) => void;
    readHead.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    serve(TEAMMATE_SUCCEEDED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Success/ });
    await user.click(screen.getByRole("button", { name: "Re-run test" }));
    expect(useTestingStore.getState().starting).not.toBeNull();

    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000099", yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));
    // Raw lines on the OTLP pipeline: a question, had the version stayed.
    await act(async () => answer(encode("zq raw line one\nzq raw line two\n")));

    // Settled either way: the hold released, or a question shown.
    await waitFor(() => expect(useTestingStore.getState().starting === null || screen.queryByRole("dialog") !== null).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useTestingStore.getState().starting).toBeNull();
    expect(queue).not.toHaveBeenCalled();
  });

  it("closes the question already showing when another configuration opens: nothing queued, the hold released", async () => {
    // Raw lines on the OTLP pipeline.
    readHead.mockResolvedValueOnce(encode("zq raw line one\nzq raw line two\n"));
    serve(TEAMMATE_SUCCEEDED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Success/ });
    await user.click(screen.getByRole("button", { name: "Re-run test" }));
    await screen.findByRole("dialog", { name: "Fixture may not match the receiver" });
    expect(useTestingStore.getState().starting).not.toBeNull();

    const theirs = versionFixture({ id: "0199c000-0000-7000-8000-000000000098", configurationId: THEIRS.id, yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: THEIRS, version: theirs }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useTestingStore.getState().starting).toBeNull();
    expect(queue).not.toHaveBeenCalled();
  });

  it("skips the question when the run's input can't be read", async () => {
    readHead.mockRejectedValueOnce(new ApiError("network_error", "Could not reach the server."));
    serve(TEAMMATE_SUCCEEDED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Success/ });

    await user.click(screen.getByRole("button", { name: "Re-run test" }));

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(screen.queryByText("Fixture may not match the receiver")).toBeNull();
  });

  it("gives up on a head read after 10 s, as the tab's other reads do, and re-runs without the check", async () => {
    vi.useFakeTimers();
    try {
      readHead.mockImplementation(
        (_o, _c, _v, _r, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new ApiError(REQUEST_ABORTED, "The request was cancelled.")));
          }),
      );
      serve(TEAMMATE_SUCCEEDED);
      render(<TestingTab />);
      await act(() => vi.advanceTimersByTimeAsync(0));

      fireEvent.click(screen.getByRole("button", { name: "Re-run test" }));
      await act(() => vi.advanceTimersByTimeAsync(RUNS_REQUEST_TIMEOUT_MS - 1));
      expect(queue).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));

      expect(queue).toHaveBeenCalledOnce();
      expect(screen.queryByText("Fixture may not match the receiver")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a refusal by its message, else 'Failed to re-run test'", async () => {
    queue
      .mockRejectedValueOnce(new ApiError("testing_unavailable", "Testing is unavailable right now. Try again later.", { status: 503 }))
      .mockRejectedValueOnce(new ApiError("invalid_request", "The request was not valid.", { status: 400 }));
    // Raw lines on the filelog pipeline: no question.
    serve(FAILED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Error/ });

    await user.click(screen.getByRole("button", { name: "Re-run test" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Testing is unavailable right now. Try again later."));
    await waitFor(() => expect(screen.getByRole("button", { name: "Re-run test" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Re-run test" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to re-run test"));
  });

  it("gives the focus back to the ↺ pressed when its queue request is refused, nothing queued", async () => {
    let refuse!: (error: unknown) => void;
    queue.mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)));
    // Raw lines on the filelog pipeline: no question.
    serve(FAILED);
    const { user } = renderTab();
    await screen.findByRole("button", { name: /Error/ });
    const rerun = () => screen.getByRole<HTMLButtonElement>("button", { name: "Re-run test" });
    await user.click(rerun());
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    // A browser drops the focus of the held (disabled) ↺ to the body; jsdom neither does nor blurs a disabled button.
    expect(rerun()).toBeDisabled();
    act(() => {
      rerun().disabled = false;
      rerun().blur();
      rerun().disabled = true;
    });
    expect(document.activeElement).toBe(document.body);

    refuse(new ApiError("testing_unavailable", "Testing is unavailable right now. Try again later.", { status: 503 }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Testing is unavailable right now. Try again later."));
    await waitFor(() => expect(document.activeElement).toBe(rerun()));
  });

  it("is held, as Play is, while the person's own run on this version waits; a teammate's doesn't hold it", async () => {
    serve(TEAMMATE_RUNNING, SUCCEEDED);
    renderTab();
    await screen.findByRole("button", { name: /Running/ });
    for (const button of screen.getAllByRole("button", { name: "Re-run test" })) expect(button).toBeEnabled();

    act(() => useTestingStore.setState((state) => ({ runs: [summaryOf(MINE_QUEUED), ...state.runs] })));

    for (const button of screen.getAllByRole("button", { name: "Re-run test" })) expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "Configure and run" })).toBeDisabled();
  });
});

describe("the focus after a queue", () => {
  it("drops a request to focus the selected row when no selected row shows as the list renders: a row selected later doesn't take the focus", async () => {
    // Listed, none selected (the queued run's answer was for a version left behind); nothing polls here.
    act(() => useTestingStore.setState({ runsVersionId: VERSION.id, runs: [summaryOf(TEAMMATE_RUNNING), summaryOf(SUCCEEDED)] }));
    let pending = true;
    const takeFocus = vi.fn(() => {
      const waiting = pending;
      pending = false;
      return waiting;
    });
    render(<TestRunsPanel onRerun={() => undefined} disableRerun={false} focusRequest={1} takeFocus={takeFocus} />);
    expect(screen.getByRole("button", { name: /Running/ })).toBeInTheDocument();
    // The request was taken, with nothing selected to focus.
    expect(takeFocus).toHaveReturnedWith(true);
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();

    // Selected later (another click elsewhere, a later run's answer): the focus stays where it was.
    act(() => useTestingStore.getState().selectRun(TEAMMATE_RUNNING.id));

    expect(screen.getByRole("button", { pressed: true })).toHaveAccessibleName(/Running/);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("replay", () => {
  it("puts no file name, text, log, output or finding in any attribute, with the results and every viewer shown, all inside ph-no-capture", async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:stub"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const markers: string[] = [];
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
    };
    /** Every private text shown is inside a ph-no-capture block. */
    const insideBlocks = (texts: RegExp[]) => {
      for (const text of texts) {
        for (const element of screen.queryAllByText(text)) expect(element.closest(".ph-no-capture"), String(text)).not.toBeNull();
      }
    };
    const { user } = await select(/Error/, SUCCEEDED, FAILED);
    await screen.findByText("zq the collector exited with status 1");
    scan();
    insideBlocks([/zq the collector exited/, /zq-lines\.log/]);

    await user.click(screen.getByRole("button", { name: /Success/ }));
    await screen.findByText("zq refused finding");
    scan();
    insideBlocks([/zq refused finding/, /zq-app-logs\.json/, /processors\/zq/, /logs\/zqotlp/]);

    const viewers: [string, string][] = [
      ["Original YAML", "Original YAML"],
      ["Test YAML", "Test YAML (after sandbox mutations)"],
      ["Mutations (3)", "Sandbox mutations"],
      ["Logs", "Collector logs (stderr)"],
      ["zq-app-logs.json", "zq-app-logs.json"],
      ["test-output.json", "Test output"],
      ["Compare input ↔ output", "Compare input ↔ output"],
    ];
    for (const [opener, title] of viewers) {
      await user.click(within(results()).getByRole("button", { name: opener }));
      const dialog = await screen.findByRole("dialog", { name: title });
      // Loaded: its spinner gone (Compare's footer keeps its two status regions).
      await waitFor(() => expect(within(dialog).queryByRole("status", { name: /^Loading/ })).toBeNull());
      expect(dialog).toHaveClass("ph-no-capture");
      scan();
      await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    await user.click(within(results()).getByRole("button", { name: "Download zq-app-logs.json" }));
    scan();

    expect(markers).toEqual([]);
  });
});
