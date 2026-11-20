/**
 * Compare's "Create an OTTL rule": the footer's count, plural, chips, cap
 * and "Showing 5 of {n}."; nothing for no candidates; the truncation
 * sentences; the footer's status regions mounted empty as Compare opens and
 * filled once its files show, a long key wrapped whole in its chip, the
 * chips' group bounded and scrolling; the files parsed and the rules
 * detected once per opening; a chip's lookup of the run's validation
 * pipeline (held, busy, looked up once, dropped once Compare has closed);
 * none → a toast, Compare kept open; found → Compare closes and the rule
 * editor opens prefilled (OTTL condition, the run's signal's context with
 * the validation store cold, the chip's Require and Condition); Save adds
 * the rule through the rules' own save and toasts; the editor's session (an
 * answer after Escape acts on nothing); the hold (a Play all's answer
 * leaves the editor open, a version switch closes it); the focus back to
 * the Compare link, else the selected row; and replay's rule (no key or
 * value in an attribute; the toasts carrying names blocked). A lookup or a
 * save answered after a version switch (the results gone) toasts nothing;
 * Compare closed with Escape or Close gives the focus back to the Compare
 * link.
 *
 * Rendered through TestingTab, as TestRunsPanel's tests: Monaco is stubbed
 * (the DiffEditor shows its texts as text); the API is its client's
 * functions, spied on; toasts are spied on.
 */

import type { DiffEditorProps, EditorProps } from "@monaco-editor/react";
import type {
  CreateValidationRuleRequest,
  TestRunDetail,
  TestRunFile,
  TestRunSignal,
  ValidationPipelinesResponse,
  ValidationRuleResponse,
} from "@telflo/contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: function DiffEditorStub(props: DiffEditorProps) {
    return (
      <div>
        <pre>{props.original}</pre>
        <pre>{props.modified}</pre>
      </div>
    );
  },
  default: function MonacoStub(props: EditorProps) {
    useEffect(() => {
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
    }, []);
    return <pre data-monaco-stub="">{props.value}</pre>;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => Promise.resolve(), setMonacoSchema: () => undefined }));

import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import * as detection from "~/lib/test-runs/diff-rule-detection.js";
import { GROUP_ID, MEMBER_ID, MINE, signedInMember, VERSION_ID, versionFixture } from "~/test/configurations.js";
import { testRunFixture, testRunSummaryOf } from "~/test/test-runs.js";
import { testDefinitionFixture, testSuiteFixture } from "~/test/test-suites.js";
import { validationPipelineFixture, validationRuleFixture } from "~/test/validation-pipelines.js";
import { TestingTab } from "./TestingTab.js";

const YAML = `receivers:
  otlp:
    protocols:
      http: {}
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
    logs/zqotlp:
      receivers: [otlp]
      exporters: [debug]
`;
const VERSION = versionFixture({ yamlContent: YAML });

/** A record's attributes, as strings. */
type Attributes = Record<string, string>;

/** One OTLP/JSON document of `signal` holding `records`, each with its attributes as strings. */
function otlp(signal: TestRunSignal, records: Attributes[]): unknown {
  const attributes = (each: Attributes) => Object.entries(each).map(([key, value]) => ({ key, value: { stringValue: value } }));
  if (signal === "logs") return { resourceLogs: [{ scopeLogs: [{ logRecords: records.map((each) => ({ attributes: attributes(each) })) }] }] };
  if (signal === "traces") return { resourceSpans: [{ scopeSpans: [{ spans: records.map((each) => ({ attributes: attributes(each) })) }] }] };
  return {
    resourceMetrics: [
      { scopeMetrics: [{ metrics: [{ name: "m", gauge: { dataPoints: records.map((each) => ({ attributes: attributes(each), asDouble: 1 })) } }] }] },
    ],
  };
}

const encode = (text: string) => new TextEncoder().encode(text);

/** The decoded input as NDJSON, one document a line; the output as the tester stores several batches, `{"records": […]}`. */
function filesOf(signal: TestRunSignal, input: Attributes[], output: Attributes[]): Partial<Record<TestRunFile, Uint8Array>> {
  return {
    "decoded-input": encode(input.map((each) => JSON.stringify(otlp(signal, [each]))).join("\n")),
    output: encode(JSON.stringify({ records: output.map((each) => otlp(signal, [each])) })),
  };
}

/** An ended OTLP run on logs/zqotlp, with both files; any field overridden. */
function runFixture(overrides: Partial<TestRunDetail>): TestRunDetail {
  return testRunFixture({
    status: "succeeded",
    queuedAt: "2026-10-09T12:00:00.000Z",
    startedAt: "2026-10-09T12:00:01.000Z",
    finishedAt: "2026-10-09T12:00:09.000Z",
    ahead: null,
    pipeline: "logs/zqotlp",
    signal: "logs",
    strategy: "otlp",
    mutations: [],
    compatibility: [],
    outputSizeBytes: 100,
    outputTruncated: false,
    decodedInputSizeBytes: 100,
    decodedInputTruncated: false,
    ...overrides,
  });
}

/** The run with three candidates: zq-level changed, zq-drop removed, zq-env added (the input's keys first). */
const RUN = runFixture({ id: "0199e000-0000-7000-8000-000000000001" });
const RUN_INPUT: Attributes[] = [
  { "zq-level": "info", "zq-drop": "zq-gone" },
  { "zq-level": "info", "zq-drop": "zq-gone" },
];
const RUN_OUTPUT: Attributes[] = [
  { "zq-level": "zq-warn", "zq-env": "zq-prod" },
  { "zq-level": "zq-warn", "zq-env": "zq-prod" },
];
const CHIPS = ["+ attribute changed: zq-level", "+ attribute removed: zq-drop", "+ attribute added: zq-env"] as const;

/** The logs/zqotlp validation pipeline on the run's version. */
const PIPELINE = validationPipelineFixture({ pipeline: "logs/zqotlp", signal: "logs" });
const NO_PIPELINE_MESSAGE = 'No validation pipeline exists for "logs/zqotlp" yet. Create one in the Validation tab first.';

let runsServed: TestRunDetail[] = [];
let filesServed: Record<string, Partial<Record<TestRunFile, Uint8Array>>> = {};
let pipelinesServed = [PIPELINE];
let listPipelines: MockInstance<typeof apiClient.getValidationPipelines>;
let createRule: MockInstance<typeof apiClient.createValidationRule>;
let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Another version of the configuration, without runs: loading it leaves the run's, the results unmounting (the list shows its placeholder). */
const OTHER_VERSION = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
async function switchVersion() {
  runsServed = [];
  act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: OTHER_VERSION }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findByText("No test runs yet for this version.");
  expect(screen.queryByRole("region", { name: "Test results", hidden: true })).toBeNull();
}

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  useTestSuitesStore.getState().reset();
  // Cold: the Validation subtab never opened.
  useValidationPipelinesStore.getState().reset();
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  runsServed = [RUN];
  filesServed = { [RUN.id]: filesOf("logs", RUN_INPUT, RUN_OUTPUT) };
  pipelinesServed = [PIPELINE];
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: runsServed.map(testRunSummaryOf) }));
  vi.spyOn(apiClient, "getTestRun").mockImplementation(async (_o, _c, _v, runId) => {
    const run = runsServed.find((candidate) => candidate.id === runId);
    if (run === undefined) throw new ApiError("test_run_not_found", "Test run not found", { status: 404 });
    return { run };
  });
  vi.spyOn(apiClient, "getTestRunFile").mockImplementation(async (_o, _c, _v, runId, file) => {
    const bytes = filesServed[runId]?.[file];
    if (bytes === undefined) throw new ApiError("test_run_not_found", "Test run not found", { status: 404 });
    return bytes;
  });
  vi.spyOn(apiClient, "getTestSuites").mockImplementation(async () => ({ suites: [] }));
  listPipelines = vi.spyOn(apiClient, "getValidationPipelines").mockImplementation(async () => ({
    validationPipelines: pipelinesServed.map((each) => ({ ...each })),
  }));
  vi.spyOn(apiClient, "getValidationRules").mockImplementation(async () => ({ rules: [] }));
  createRule = vi.spyOn(apiClient, "createValidationRule").mockImplementation(async (_o, _c, _v, pipelineId, request) => ({
    rule: validationRuleFixture({
      validationPipelineId: pipelineId,
      kind: request.kind,
      target: request.target,
      pattern: null,
      ottl: request.ottl ?? null,
      name: request.name ?? "",
      description: request.description ?? "",
    }),
  }));
  toastError = vi.spyOn(toast, "error").mockImplementation(() => "");
  toastSuccess = vi.spyOn(toast, "success").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
});

afterEach(() => {
  cleanup();
  useTestingStore.getState().reset();
});

const results = () => screen.getByRole("region", { name: "Test results" });
const compareLink = () => within(results()).getByRole("button", { name: "Compare input ↔ output" });

/** Renders the tab, selects the run whose badge says `status`, and opens Compare once its files show. */
async function openCompare(status: RegExp = /Success/) {
  render(<TestingTab />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: status }));
  await user.click(await within(results()).findByRole("button", { name: "Compare input ↔ output" }));
  const dialog = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
  await waitFor(() => expect(within(dialog).queryByRole("status", { name: "Loading files" })).toBeNull());
  return { user, dialog };
}

const chipsIn = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("button", { name: /^\+ attribute/ })
    .map((chip) => chip.textContent);

/** Opens Compare and presses the chip named `chip`; the editor shows once the lookup finds the pipeline. */
async function openEditorFrom(chip: string) {
  const view = await openCompare();
  await view.user.click(within(view.dialog).getByRole("button", { name: chip }));
  const editor = await screen.findByRole("dialog", { name: "Add validation rule" });
  return { ...view, editor };
}

describe("Compare's footer", () => {
  it("says 'Detected 3 candidate rules:' and offers each as a chip, in its words and order, a group labeled by that line, each titled 'Create an OTTL rule asserting this change'; the output's several batches and the NDJSON input read", async () => {
    const { dialog } = await openCompare();

    const line = within(dialog).getByText(/^Detected/);
    expect(line).toHaveTextContent("Detected 3 candidate rules:");
    expect(line).toHaveAttribute("role", "status");
    const group = within(dialog).getByRole("group", { name: "Detected 3 candidate rules:" });
    expect(within(group).getAllByRole("button").map((chip) => chip.textContent)).toEqual(CHIPS);
    for (const chip of within(group).getAllByRole("button")) {
      expect(chip).toHaveAttribute("title", "Create an OTTL rule asserting this change");
      expect(chip).not.toHaveAttribute("aria-disabled");
      expect(chip).not.toHaveAttribute("aria-busy");
    }
    expect(within(dialog).queryByText(/^Showing/)).toBeNull();
    expect(listPipelines).not.toHaveBeenCalled();
  });

  it("says 'Detected 1 candidate rule:' for one", async () => {
    filesServed = { [RUN.id]: filesOf("logs", [{ a: "1" }], [{ a: "1", "zq-env": "zq-prod" }]) };
    const { dialog } = await openCompare();

    expect(within(dialog).getByRole("group", { name: "Detected 1 candidate rule:" })).toBeInTheDocument();
    expect(chipsIn(dialog)).toEqual(["+ attribute added: zq-env"]);
  });

  it("shows five chips of seven, and 'Showing 5 of 7.', politely", async () => {
    const added = Object.fromEntries(Array.from({ length: 7 }, (_each, index) => [`zq-key${index + 1}`, "zq-value"]));
    filesServed = { [RUN.id]: filesOf("logs", [{ a: "1" }], [{ a: "1", ...added }]) };
    const { dialog } = await openCompare();

    expect(within(dialog).getByText(/^Detected/)).toHaveTextContent("Detected 7 candidate rules:");
    expect(chipsIn(dialog)).toEqual([1, 2, 3, 4, 5].map((index) => `+ attribute added: zq-key${index}`));
    const showing = within(dialog).getByText("Showing 5 of 7.");
    expect(showing).toHaveAttribute("role", "status");
  });

  it.each([
    ["seven chips", false, ["Detected 7 candidate rules:", "Showing 5 of 7."]],
    ["a run cut at 10 MiB", true, ["Output was cut at 10 MiB, so no rules are suggested.", ""]],
  ])(
    "mounts the footer's two status regions empty as Compare opens, while its files load, and fills those same regions once they show (%s)",
    async (_label, outputTruncated, lines) => {
      const added = Object.fromEntries(Array.from({ length: 7 }, (_each, index) => [`zq-key${index + 1}`, "zq-value"]));
      runsServed = [{ ...RUN, outputTruncated }];
      filesServed = { [RUN.id]: filesOf("logs", [{ a: "1" }], [{ a: "1", ...added }]) };
      const input = deferred<Uint8Array>();
      const read = vi.mocked(apiClient.getTestRunFile);
      const serve = read.getMockImplementation()!;
      read.mockImplementation(async (...args) => (args[4] === "decoded-input" ? input.promise : serve(...args)));
      render(<TestingTab />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /Success/ }));
      await user.click(await within(results()).findByRole("button", { name: "Compare input ↔ output" }));
      const dialog = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
      /** The footer's status regions (the loading spinner's is named). */
      const regions = () => within(dialog).queryAllByRole("status").filter((each) => !each.hasAttribute("aria-label"));

      expect(within(dialog).getByRole("status", { name: "Loading files" })).toBeInTheDocument();
      const mounted = regions();
      expect(mounted.map((each) => each.textContent)).toEqual(["", ""]);
      expect(mounted.every((each) => each.closest(".ph-no-capture") === dialog)).toBe(true);

      await act(async () => input.resolve(filesServed[RUN.id]!["decoded-input"]!));
      await waitFor(() => expect(within(dialog).queryByRole("status", { name: "Loading files" })).toBeNull());

      expect(regions()).toEqual(mounted);
      expect(mounted.map((each) => each.textContent)).toEqual(lines);
      if (!outputTruncated) expect(within(dialog).getByRole("group", { name: "Detected 7 candidate rules:" })).toBeInTheDocument();
    },
  );

  it("shows a long key whole in its chip, wrapped, never cut, and in no title", async () => {
    const key = `zq-${"very-long-attribute-key-".repeat(12)}end`;
    filesServed = { [RUN.id]: filesOf("logs", [{ a: "1" }], [{ a: "1", [key]: "zq-value" }]) };
    const { dialog } = await openCompare();

    const chip = within(dialog).getByRole("button", { name: `+ attribute added: ${key}` });
    expect(chip).toHaveTextContent(`+ attribute added: ${key}`, { normalizeWhitespace: false });
    expect(chip).toHaveClass("whitespace-normal", "h-auto");
    expect(chip).not.toHaveClass("whitespace-nowrap");
    const label = chip.querySelector("span")!;
    expect(label).toHaveClass("whitespace-pre-wrap", "break-all");
    expect(label).not.toHaveClass("truncate");
    expect(chip).toHaveAttribute("title", "Create an OTTL rule asserting this change");
    for (const element of dialog.querySelectorAll("*")) {
      for (const attribute of element.attributes) expect(attribute.value).not.toContain("very-long-attribute-key");
    }
  });

  it("keeps very long keys whole in a group at most 10rem tall that scrolls, so the diff editor keeps its room (three 3,000-character keys)", async () => {
    const keys = [1, 2, 3].map((index) => `zq-${index}-${"k".repeat(2995)}`);
    filesServed = { [RUN.id]: filesOf("logs", [{ a: "1" }], [{ a: "1", ...Object.fromEntries(keys.map((key) => [key, "zq-value"])) }]) };
    const { dialog } = await openCompare();

    const group = within(dialog).getByRole("group", { name: "Detected 3 candidate rules:" });
    // jsdom lays nothing out: the bound is the group's own (max-h-40, overflow-y-auto), and the chips are inside it.
    expect(group).toHaveClass("max-h-40", "overflow-y-auto");
    expect(within(group).getAllByRole("button").map((chip) => chip.textContent)).toEqual(keys.map((key) => `+ attribute added: ${key}`));
    for (const chip of within(group).getAllByRole("button")) {
      expect(chip.querySelector("span")).toHaveClass("whitespace-pre-wrap", "break-all");
      expect(chip.querySelector("span")).not.toHaveClass("truncate");
    }
    // The diff editor's box is the dialog's flexible one, beside the footer, never inside the scrolled group.
    const editorBox = within(dialog).getByText(/zq-value/, { selector: "pre" }).closest(".flex-1");
    expect(editorBox).toHaveClass("min-h-0");
    expect(editorBox!.contains(group)).toBe(false);
  });

  it("shows no footer when nothing changed", async () => {
    filesServed = { [RUN.id]: filesOf("logs", RUN_INPUT, RUN_INPUT) };
    const { dialog } = await openCompare();

    expect(within(dialog).getAllByText('"zq-drop"', { exact: false })).not.toEqual([]);
    expect(within(dialog).queryByText(/Detected|candidate|Showing|rules are suggested/)).toBeNull();
    expect(within(dialog).queryByRole("group")).toBeNull();
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Close", "Close"]);
  });

  it.each([
    [{ outputTruncated: true }, "Output was cut at 10 MiB, so no rules are suggested."],
    [{ decodedInputTruncated: true }, "Input was cut at 10 MiB, so no rules are suggested."],
    [{ outputTruncated: true, decodedInputTruncated: true }, "Input and output were cut at 10 MiB, so no rules are suggested."],
  ])("offers nothing for a run cut at 10 MiB (%o) and says so, politely: '%s'; nothing detected", async (truncation, sentence) => {
    runsServed = [{ ...RUN, ...truncation }];
    const detect = vi.spyOn(detection, "detectRuleCandidates");
    const { dialog } = await openCompare();

    const line = within(dialog).getByText(sentence);
    expect(line).toHaveAttribute("role", "status");
    expect(chipsIn(dialog)).toEqual([]);
    expect(within(dialog).queryByText(/Detected/)).toBeNull();
    expect(detect).not.toHaveBeenCalled();
    // The files still show.
    expect(within(dialog).getAllByText('"zq-drop"', { exact: false })).not.toEqual([]);
  });

  it("detects once per opening, never per render: a chip's lookup, its answer and the toast re-render nothing into a second detection", async () => {
    const detect = vi.spyOn(detection, "detectRuleCandidates");
    const answer = deferred<ValidationPipelinesResponse>();
    listPipelines.mockReturnValueOnce(answer.promise);
    const { user, dialog } = await openCompare();
    expect(detect).toHaveBeenCalledOnce();

    await user.click(within(dialog).getByRole("button", { name: CHIPS[0] }));
    expect(within(dialog).getByRole("button", { name: CHIPS[0] })).toHaveAttribute("aria-busy", "true");
    await act(async () => answer.resolve({ validationPipelines: [] }));
    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    await user.hover(within(dialog).getByRole("button", { name: CHIPS[1] }));
    expect(detect).toHaveBeenCalledOnce();

    await user.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(detect).toHaveBeenCalledOnce();
    await user.click(compareLink());
    await screen.findByRole("group", { name: "Detected 3 candidate rules:" });
    expect(detect).toHaveBeenCalledTimes(2);
  });
});

describe("a chip: the lookup", () => {
  it("finds the run's validation pipeline by its version and pipeline, read from the API; Compare closes and the editor opens prefilled: OTTL condition, the run's signal's context, the chip's Require and Condition, Name and Description empty", async () => {
    const { editor } = await openEditorFrom(CHIPS[1]);

    expect(listPipelines).toHaveBeenCalledOnce();
    expect(listPipelines).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION_ID, { signal: expect.any(AbortSignal) });
    expect(screen.queryByRole("dialog", { name: "Compare input ↔ output" })).toBeNull();
    expect(editor).toHaveClass("ph-no-capture");
    expect(within(editor).getByRole("combobox", { name: "Rule type" })).toHaveTextContent("OTTL condition");
    expect(within(editor).getByRole("combobox", { name: "Context" })).toHaveTextContent("log");
    expect(within(editor).getByRole("combobox", { name: "Require" })).toHaveTextContent("No record matches");
    expect(within(editor).getByLabelText("OTTL condition")).toHaveValue('attributes["zq-drop"] != nil');
    expect(within(editor).getByLabelText("Name")).toHaveValue("");
    expect(within(editor).getByLabelText("Description")).toHaveValue("");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("opens 'changed' with Require all and the output's value, escaped", async () => {
    const { editor } = await openEditorFrom(CHIPS[0]);

    expect(within(editor).getByRole("combobox", { name: "Require" })).toHaveTextContent("All records match");
    expect(within(editor).getByLabelText("OTTL condition")).toHaveValue('attributes["zq-level"] == "zq-warn"');
  });

  it("saves through the rules' own save, Add rule: the rule as prefilled, on the run's version and pipeline; toasts 'Rule added to logs/zqotlp' (ph-no-capture); the focus back on the Compare link", async () => {
    const { user, editor } = await openEditorFrom(CHIPS[2]);

    await user.click(within(editor).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createRule).toHaveBeenCalledOnce();
    const [organizationId, configurationId, versionId, pipelineId, request] = createRule.mock.calls[0]!;
    expect([organizationId, configurationId, versionId, pipelineId]).toEqual([GROUP_ID, MINE.id, VERSION_ID, PIPELINE.id]);
    expect(request).toEqual({
      kind: "ottl",
      target: "output",
      ottl: { context: "log", quantifier: "all", condition: 'attributes["zq-env"] != nil' },
      name: "",
      description: "",
    } satisfies CreateValidationRuleRequest);
    expect(toastSuccess).toHaveBeenCalledOnce();
    expect(toastSuccess).toHaveBeenCalledWith("Rule added to logs/zqotlp", { className: "ph-no-capture" });
    await waitFor(() => expect(compareLink()).toHaveFocus());
  });

  it("toasts its words when the run's pipeline has no validation pipeline (ph-no-capture): no editor, Compare open, the chips released", async () => {
    pipelinesServed = [validationPipelineFixture({ pipeline: "logs" })];
    const { user, dialog } = await openCompare();

    await user.click(within(dialog).getByRole("button", { name: CHIPS[0] }));

    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    expect(toastError).toHaveBeenCalledWith(NO_PIPELINE_MESSAGE, { className: "ph-no-capture" });
    expect(screen.queryByRole("dialog", { name: "Add validation rule" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Compare input ↔ output" })).toBe(dialog);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: CHIPS[0] })).not.toHaveAttribute("aria-busy"));
    for (const chip of within(dialog).getAllByRole("button", { name: /^\+ attribute/ })) expect(chip).not.toHaveAttribute("aria-disabled");
    expect(within(dialog).getByRole("button", { name: CHIPS[0] })).toHaveFocus();
  });

  it("toasts a failed lookup in the API's words, else 'Failed to resolve validation pipeline' (ph-no-capture), Compare open; a session that ended toasts nothing", async () => {
    listPipelines.mockRejectedValueOnce(new ApiError("configuration_version_not_found", "zq That version doesn't exist.", { status: 404 }));
    listPipelines.mockRejectedValueOnce(new ApiError("unexpected_response", "The answer couldn't be read.", { status: 500 }));
    listPipelines.mockRejectedValueOnce(new ApiError("unauthenticated", "Your session has ended. Sign in again.", { status: 401 }));
    const { user, dialog } = await openCompare();
    const chip = () => within(dialog).getByRole("button", { name: CHIPS[0] });

    await user.click(chip());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("zq That version doesn't exist.", { className: "ph-no-capture" }));
    await waitFor(() => expect(chip()).not.toHaveAttribute("aria-busy"));
    await user.click(chip());
    await waitFor(() => expect(toastError).toHaveBeenLastCalledWith("Failed to resolve validation pipeline", { className: "ph-no-capture" }));
    await waitFor(() => expect(chip()).not.toHaveAttribute("aria-busy"));
    await user.click(chip());
    await waitFor(() => expect(listPipelines).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(chip()).not.toHaveAttribute("aria-busy"));
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "Compare input ↔ output" })).toBe(dialog);
    expect(screen.queryByRole("dialog", { name: "Add validation rule" })).toBeNull();
  });

  it("holds every chip while one's lookup runs (aria-disabled, never disabled), that one busy: a double click, or another chip, looks up once", async () => {
    const answer = deferred<ValidationPipelinesResponse>();
    listPipelines.mockReturnValueOnce(answer.promise);
    const { user, dialog } = await openCompare();
    const chip = within(dialog).getByRole("button", { name: CHIPS[1] });

    await user.dblClick(chip);
    expect(chip).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: CHIPS[2] }));

    expect(listPipelines).toHaveBeenCalledOnce();
    expect(chip).toHaveAttribute("aria-busy", "true");
    expect(chip).toBeEnabled();
    expect(within(dialog).getAllByRole("button", { name: /^\+ attribute/ }).map((each) => each.getAttribute("aria-disabled"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(within(dialog).getByRole("button", { name: CHIPS[2] })).not.toHaveAttribute("aria-busy");

    await act(async () => answer.resolve({ validationPipelines: [PIPELINE] }));
    const editor = await screen.findByRole("dialog", { name: "Add validation rule" });
    expect(within(editor).getByLabelText("OTTL condition")).toHaveValue('attributes["zq-drop"] != nil');
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("drops a lookup answered after Compare closed: no editor, no toast; Compare opened again looks up afresh", async () => {
    const answer = deferred<ValidationPipelinesResponse>();
    listPipelines.mockReturnValueOnce(answer.promise);
    const { user, dialog } = await openCompare();
    await user.click(within(dialog).getByRole("button", { name: CHIPS[0] }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await act(async () => answer.resolve({ validationPipelines: [PIPELINE] }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();

    // And none answered too late toasts either.
    const late = deferred<ValidationPipelinesResponse>();
    listPipelines.mockReturnValueOnce(late.promise);
    await user.click(compareLink());
    const reopened = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
    const chip = await within(reopened).findByRole("button", { name: CHIPS[0] });
    expect(chip).not.toHaveAttribute("aria-disabled");
    await user.click(chip);
    expect(listPipelines).toHaveBeenCalledTimes(2);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => late.resolve({ validationPipelines: [] }));
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["no validation pipeline for the run's", "none"],
    ["a failed lookup", "failed"],
  ] as const)("drops a lookup answered after a version switch, the results gone: %s toasts nothing", async (_what, outcome) => {
    const answer = deferred<ValidationPipelinesResponse>();
    listPipelines.mockReturnValueOnce(answer.promise);
    const { user, dialog } = await openCompare();
    await user.click(within(dialog).getByRole("button", { name: CHIPS[0] }));
    expect(listPipelines).toHaveBeenCalledOnce();

    await switchVersion();
    await act(async () =>
      outcome === "none"
        ? answer.resolve({ validationPipelines: [] })
        : answer.reject(new ApiError("unexpected_response", "zq The answer couldn't be read.", { status: 500 })),
    );

    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the prefilled editor", () => {
  it.each([
    ["logs", "log"],
    ["traces", "span"],
    ["metrics", "datapoint"],
  ] as const)("takes its context from the run's signal (%s → %s), the validation store cold", async (signal, context) => {
    runsServed = [{ ...RUN, signal }];
    filesServed = { [RUN.id]: filesOf(signal, RUN_INPUT, RUN_OUTPUT) };
    pipelinesServed = [{ ...PIPELINE, signal }];
    const { user, editor } = await openEditorFrom(CHIPS[2]);

    expect(useValidationPipelinesStore.getState().target).toBeNull();
    expect(within(editor).getByRole("combobox", { name: "Context" })).toHaveTextContent(context);
    await user.click(within(editor).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(createRule).toHaveBeenCalledOnce());
    expect(createRule.mock.calls[0]![4].ottl?.context).toBe(context);
  });

  it("acts on nothing after Escape mid-save: no toast, nothing reopened; the store keeps what the API answered", async () => {
    const answer = deferred<ValidationRuleResponse>();
    createRule.mockReturnValueOnce(answer.promise);
    const { user, editor } = await openEditorFrom(CHIPS[2]);
    await user.click(within(editor).getByRole("button", { name: "Add rule" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(compareLink()).toHaveFocus());

    await act(async () => answer.resolve({ rule: validationRuleFixture({ kind: "ottl", pattern: null }) }));

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(compareLink()).toHaveFocus();
  });

  it("is closed by a version switch", async () => {
    const { editor } = await openEditorFrom(CHIPS[2]);
    expect(editor).toBeInTheDocument();

    const other = versionFixture({ id: "0199c000-0000-7000-8000-000000000002", yamlContent: YAML });
    act(() => useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: other }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createRule).not.toHaveBeenCalled();
  });

  it.each(["added", "refused"] as const)("acts on nothing when its save is answered (%s) after a version switch: no toast, no 'Rule added'", async (outcome) => {
    const answer = deferred<ValidationRuleResponse>();
    createRule.mockReturnValueOnce(answer.promise);
    const { user, editor } = await openEditorFrom(CHIPS[2]);
    await user.click(within(editor).getByRole("button", { name: "Add rule" }));
    expect(createRule).toHaveBeenCalledOnce();

    await switchVersion();
    await act(async () =>
      outcome === "added"
        ? answer.resolve({ rule: validationRuleFixture({ kind: "ottl", pattern: null }) })
        : answer.reject(new ApiError("network_error", "Could not reach the server. Check your connection.")),
    );

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("closing Compare", () => {
  it.each([
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    [
      "the footer's Close",
      async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
        user.click(within(dialog).getByText("Close", { selector: "button" })),
    ],
    [
      "the corner's Close",
      async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
        user.click(within(dialog).getByText("Close", { selector: "span.sr-only" }).closest("button")!),
    ],
  ])("gives the focus back to the Compare link: %s", async (_how, close) => {
    const { user, dialog } = await openCompare();
    expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(2);

    await close(user, dialog);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(compareLink()).toHaveFocus());
  });
});

describe("the hold", () => {
  it("keeps the editor and what was typed in it through a Play all's answer selecting another run; closed, the focus goes to that run's row", async () => {
    const suite = testSuiteFixture();
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [suite] });
    let release: (value: { definitions: ReturnType<typeof testDefinitionFixture>[] }) => void = () => undefined;
    vi.spyOn(apiClient, "getTestDefinitions").mockReturnValue(new Promise((resolve) => (release = resolve)));
    const queued = testRunFixture({
      id: "0199e000-0000-7000-8000-000000000009",
      queuedAt: "2026-10-09T12:30:00.000Z",
      queuedByUserId: MEMBER_ID,
    });
    const queue = vi.spyOn(apiClient, "queueTestRun").mockImplementation(async () => {
      runsServed = [queued, ...runsServed];
      return { run: queued };
    });
    render(<TestingTab />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Suites" }));
    await screen.findByText(suite.name);
    await user.click(screen.getByRole("button", { name: "Play all tests in parallel" }));
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await user.click(await screen.findByRole("button", { name: /Success/ }));
    await user.click(await within(results()).findByRole("button", { name: "Compare input ↔ output" }));
    const dialog = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
    await user.click(await within(dialog).findByRole("button", { name: CHIPS[2] }));
    const editor = await screen.findByRole("dialog", { name: "Add validation rule" });
    const name = within(editor).getByLabelText("Name");
    await user.type(name, "zq-env guard");

    await act(async () => release({ definitions: [testDefinitionFixture()] }));

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    await waitFor(() => expect(useTestingStore.getState().selectedRunId).toBe(queued.id));
    await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
    expect(screen.getByRole("dialog", { name: "Add validation rule" })).toBe(editor);
    expect(within(editor).getByLabelText("Name")).toHaveValue("zq-env guard");
    expect(within(editor).getByLabelText("OTTL condition")).toHaveValue('attributes["zq-env"] != nil');
    expect(editor.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The run selected now isn't the one Compare showed: its row.
    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-pressed", "true"));
    expect(document.activeElement?.closest("li")).toBe(screen.getByRole("button", { name: /Queued/ }).closest("li"));
  });

  it("serves no focus request while the editor shows: a Play all's answer selecting its first run neither moves the focus off Name nor selects what was typed there", async () => {
    const suite = testSuiteFixture();
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [suite] });
    let release: (value: { definitions: ReturnType<typeof testDefinitionFixture>[] }) => void = () => undefined;
    vi.spyOn(apiClient, "getTestDefinitions").mockReturnValue(new Promise((resolve) => (release = resolve)));
    const queued = testRunFixture({
      id: "0199e000-0000-7000-8000-000000000009",
      queuedAt: "2026-10-09T12:30:00.000Z",
      queuedByUserId: MEMBER_ID,
    });
    const queue = vi.spyOn(apiClient, "queueTestRun").mockImplementation(async () => {
      runsServed = [queued, ...runsServed];
      return { run: queued };
    });
    render(<TestingTab />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Suites" }));
    await screen.findByText(suite.name);
    await user.click(screen.getByRole("button", { name: "Play all tests in parallel" }));
    await user.click(screen.getByRole("tab", { name: "Tests" }));
    await user.click(await screen.findByRole("button", { name: /Success/ }));
    await user.click(await within(results()).findByRole("button", { name: "Compare input ↔ output" }));
    const dialog = await screen.findByRole("dialog", { name: "Compare input ↔ output" });
    await user.click(await within(dialog).findByRole("button", { name: CHIPS[2] }));
    const editor = await screen.findByRole("dialog", { name: "Add validation rule" });
    const name = within(editor).getByLabelText<HTMLInputElement>("Name");
    await user.type(name, "zq-env guard");
    expect(name).toHaveFocus();
    expect([name.selectionStart, name.selectionEnd]).toEqual([12, 12]);
    /** Every element the focus went to from here on. */
    const focused: EventTarget[] = [];
    const record = (event: FocusEvent) => focused.push(event.target!);
    document.addEventListener("focusin", record);

    try {
      await act(async () => release({ definitions: [testDefinitionFixture()] }));
      await waitFor(() => expect(queue).toHaveBeenCalledOnce());
      await waitFor(() => expect(useTestingStore.getState().selectedRunId).toBe(queued.id));
      await waitFor(() => expect(useTestingStore.getState().playAll).toBeNull());
      await waitFor(() => expect(screen.getByRole("button", { name: /Queued/, hidden: true })).toHaveAttribute("aria-pressed", "true"));
    } finally {
      document.removeEventListener("focusin", record);
    }

    expect(focused).toEqual([]);
    expect(name).toHaveFocus();
    expect([name.selectionStart, name.selectionEnd]).toEqual([12, 12]);
    // Typing goes on where it was.
    await user.keyboard("s");
    expect(name).toHaveValue("zq-env guards");

    // The request was dropped, not kept: closing the editor gives the focus to the selected row once (focusAfterEditor's
    // fallback), and nothing pulls it there later, when the list next renders.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-pressed", "true"));
    const tests = screen.getByRole("tab", { name: "Tests" });
    act(() => tests.focus());
    act(() =>
      useTestingStore.setState((state) => ({
        runs: state.runs.map((listed) => (listed.id === queued.id ? { ...listed, status: "running" as const } : listed)),
      })),
    );
    await screen.findByRole("button", { name: /Running/ });
    expect(tests).toHaveFocus();
  });
});

describe("replay", () => {
  it("puts no key or value in any attribute (the chips, their busy state, the editor), every text inside ph-no-capture; the toasts carrying a pipeline's name blocked", async () => {
    const markers: string[] = [];
    /** Every attribute carrying a marker; an input's or textarea's value is masked by replay (maskAllInputs). */
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && attribute.name === "value") continue;
          if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
    };
    const answer = deferred<ValidationPipelinesResponse>();
    listPipelines.mockReturnValueOnce(answer.promise);
    const { user, dialog } = await openCompare();
    scan();
    for (const chip of within(dialog).getAllByRole("button", { name: /^\+ attribute/ })) expect(chip.closest(".ph-no-capture")).toBe(dialog);
    expect(within(dialog).getByText(/^Detected/).closest(".ph-no-capture")).toBe(dialog);

    await user.click(within(dialog).getByRole("button", { name: CHIPS[0] }));
    scan();
    await act(async () => answer.resolve({ validationPipelines: [] }));
    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
    scan();

    await user.click(within(dialog).getByRole("button", { name: CHIPS[0] }));
    const editor = await screen.findByRole("dialog", { name: "Add validation rule" });
    expect(editor).toHaveClass("ph-no-capture");
    scan();
    await user.click(within(editor).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    scan();

    expect(markers).toEqual([]);
    // Every toast carrying configuration text is blocked from replay.
    for (const call of [...toastError.mock.calls, ...toastSuccess.mock.calls]) expect(call[1]).toEqual({ className: "ph-no-capture" });
    expect(toastError).toHaveBeenCalledWith(NO_PIPELINE_MESSAGE, { className: "ph-no-capture" });
    expect(toastSuccess).toHaveBeenCalledWith("Rule added to logs/zqotlp", { className: "ph-no-capture" });
  });
});
