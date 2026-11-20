/**
 * The Testing tab and its run dialog: the subtab bar and Play, the
 * dialog's fields, defaults and checks, My Files (upload, paste, delete),
 * the fixture-shape question, the queue and its refusals, and replay's
 * rules (no file name or text in an attribute; the sample editor inside
 * `ph-no-capture`).
 *
 * Monaco is stubbed, as in YamlEditor's tests: the stub records its props
 * and renders a textarea standing for the editor, so a test can paste a
 * sample. The API is its client's functions, spied on; toasts are spied on.
 */

import type { EditorProps } from "@monaco-editor/react";
import { TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE, VARIABLES_UNAVAILABLE_MESSAGE, type TestFile } from "@telflo/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const fake = vi.hoisted(() => ({
  props: null as EditorProps | null,
  initMonaco: (() => Promise.resolve()) as () => Promise<void>,
}));

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: function DiffEditorStub() {
    return <div />;
  },
  default: function MonacoStub(props: EditorProps) {
    fake.props = props;
    useEffect(() => {
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
      // Once, as Monaco mounts once.
    }, []);
    return (
      <textarea
        aria-label="Sample editor"
        value={props.value ?? ""}
        onChange={(event) => props.onChange?.(event.target.value, undefined as never)}
      />
    );
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => fake.initMonaco(), setMonacoSchema: () => undefined }));

import * as apiClient from "~/lib/api-client.js";
import { ApiError } from "~/lib/api-client.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { LAST_RUN_DURATION_KEY, useTestingStore } from "~/lib/stores/testing-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { COLLEAGUE_ID, GROUP_ID, MEMBER_ID, MINE, signedInMember, versionFixture } from "~/test/configurations.js";
import { testFileFixture, testRunFixture } from "~/test/test-runs.js";
import { focusIntoSlot } from "./TestConfigurationPanel.js";
import { TestingTab } from "./TestingTab.js";
import { monacoAriaHost } from "~/lib/editor/use-aria-container.js";

/**
 * Three pipelines: traces and logs/zqotlp fed by OTLP, logs by filelog. The
 * pipeline names carry the private-text marker too (configuration text).
 */
const YAML = `receivers:
  otlp:
    protocols:
      http: {}
  filelog:
    include: [/var/log/app.log]
exporters:
  debug: {}
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [filelog]
      exporters: [debug]
    logs/zqotlp:
      receivers: [otlp]
      exporters: [debug]
`;

const VERSION = versionFixture({ yamlContent: YAML });
const OLD_FILE = testFileFixture({ displayName: "zq-old-upload", fileName: "zq-old-upload.json", description: "zq-secret description" });
const OTHER_FILE = testFileFixture({ id: "0199d000-0000-7000-8000-000000000002", displayName: "zq-other", fileName: "zq-other.log" });

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

let toastError: MockInstance<typeof toast.error>;
let toastSuccess: MockInstance<typeof toast.success>;

function serveFiles(files: TestFile[]) {
  return vi.spyOn(apiClient, "getTestFiles").mockResolvedValue({ files });
}

function serveQueue() {
  return vi.spyOn(apiClient, "queueTestRun").mockImplementation(async () => ({ run: testRunFixture() }));
}

/** A file's head as the API's `GET …/test-files/:fileId/head` answers it. */
function serveHead(text: string) {
  return vi.spyOn(apiClient, "getTestFileHead").mockResolvedValue(new TextEncoder().encode(text));
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.setState(initialEditor, true);
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: VERSION });
  useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
  fake.props = null;
  fake.initMonaco = () => Promise.resolve();
  toastError = vi.spyOn(toast, "error");
  toastSuccess = vi.spyOn(toast, "success");
  // The tab polls the version's runs: the API here lists what the store holds, so a queued run stays.
  vi.spyOn(apiClient, "getTestRuns").mockImplementation(async () => ({ runs: useTestingStore.getState().runs }));
  // A file's head, for the fixture-shape check, unread unless a test serves one: the check is then skipped.
  vi.spyOn(apiClient, "getTestFileHead").mockRejectedValue(new ApiError("test_file_not_found", "Test file not found", { status: 404 }));
});

function renderTab() {
  const view = render(<TestingTab />);
  return { ...view, user: userEvent.setup() };
}

const play = () => screen.getByRole("button", { name: "Configure and run" });

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(play());
  return screen.findByRole("dialog", { name: "Select Test File" });
}

/** The dialog's Run button (the main view's). */
const runButton = () => within(screen.getByRole("dialog", { name: "Select Test File" })).getByRole("button", { name: "Run" });

/** Opens My Files, highlights `name` and confirms it. */
async function pickFromMyFiles(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "My Files" }));
  await user.click(await screen.findByRole("button", { name, pressed: false }));
  await user.click(screen.getByRole("button", { name: "OK" }));
  await screen.findByText(name, { selector: "span.font-mono" });
}

/** Chooses a pipeline in the dialog's select. */
async function choosePipeline(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Test Pipeline" }));
  await user.click(await screen.findByRole("option", { name }));
}

/** Pastes `text` as a sample named `name` and saves it, the saved file answered as `saved`. */
async function pasteSample(user: ReturnType<typeof userEvent.setup>, name: string, text: string, saved: TestFile) {
  const save = vi.spyOn(apiClient, "saveTestSample").mockResolvedValue({ file: saved });
  await user.click(screen.getByRole("button", { name: "Paste Text" }));
  await user.type(await screen.findByLabelText("Name"), name);
  fireEvent.change(await screen.findByRole("textbox", { name: "Sample editor" }), { target: { value: text } });
  await user.click(screen.getByRole("button", { name: "Use Sample" }));
  await screen.findByText(saved.displayName, { selector: "span.font-mono" });
  return save;
}

describe("the tab", () => {
  it("has three subtabs, Tests, Validation and Suites, Tests shown, and Play, 'Configure and run'; the sources My Files, Templates and Paste Text; no Generate with AI", async () => {
    vi.spyOn(apiClient, "getTestSuites").mockResolvedValue({ suites: [] });
    const { user } = renderTab();

    const subtabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(subtabs.map((tab) => tab.textContent)).toEqual(["Tests", "Validation", "Suites"]);
    expect(screen.getByRole("tab", { name: "Tests" })).toHaveAttribute("aria-selected", "true");
    expect(play()).toBeEnabled();
    expect(play()).toHaveAttribute("title", "Configure and run");

    serveFiles([]);
    const dialog = await openDialog(user);
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent)
        .filter((text) => ["My Files", "Templates", "Paste Text"].includes(text ?? "")),
    ).toEqual(["My Files", "Templates", "Paste Text"]);
    await user.click(within(dialog).getByRole("button", { name: "Paste Text" }));
    expect(await within(dialog).findByText("Paste Test Sample")).toBeInTheDocument();
    expect(within(dialog).queryByText(/generate/i)).toBeNull();
  });

  it("holds Play while the person's own run on this version is queued or running, and with no version", () => {
    renderTab();
    const member = signedInMember(GROUP_ID).user.id;

    act(() => useTestingStore.setState({ runsVersionId: VERSION.id, runs: [testRunFixture({ queuedByUserId: COLLEAGUE_ID })] }));
    expect(play()).toBeEnabled();
    act(() => useTestingStore.setState({ runs: [testRunFixture({ queuedByUserId: member, status: "running", ahead: null })] }));
    expect(play()).toBeDisabled();
    act(() => useTestingStore.setState({ runs: [testRunFixture({ queuedByUserId: member, status: "queued" })] }));
    expect(play()).toBeDisabled();
    act(() => useTestingStore.setState({ runs: [testRunFixture({ queuedByUserId: member, status: "succeeded", ahead: null })] }));
    expect(play()).toBeEnabled();
    act(() => useTestingStore.setState({ runsVersionId: "0199c000-0000-7000-8000-000000000099", runs: [testRunFixture()] }));
    expect(play()).toBeEnabled();

    act(() => useEditorStore.getState().reset());
    expect(play()).toBeDisabled();
  });
});

describe("the run dialog: fields and defaults", () => {
  it("opens with the first pipeline, the remembered duration, no file, Run held; and reads My Files each time it opens", async () => {
    const read = serveFiles([OLD_FILE]);
    useTestingStore.setState({ lastRunDurationSeconds: 12 });
    const { user } = renderTab();

    const dialog = await openDialog(user);

    expect(within(dialog).getByRole("combobox", { name: "Test Pipeline" })).toHaveTextContent("traces");
    expect(within(dialog).getByLabelText("Run duration (seconds)")).toHaveValue(12);
    expect(within(dialog).getByText(/How long the collector keeps running after the fixture is delivered\./)).toHaveTextContent(
      "How long the collector keeps running after the fixture is delivered. Bump this for pipelines with `batch.timeout` or `tail_sampling.decision_wait` longer than 5s. Range 1–60.",
    );
    expect(within(dialog).getByText("Choose Test File")).toBeInTheDocument();
    expect(within(dialog).getByText("Selected File:")).toHaveTextContent("Selected File: None");
    expect(runButton()).toBeDisabled();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read).toHaveBeenCalledWith(GROUP_ID);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await openDialog(user);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("lists the canvas's pipelines by name", async () => {
    serveFiles([]);
    const { user } = renderTab();
    await openDialog(user);

    await user.click(screen.getByRole("combobox", { name: "Test Pipeline" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["traces", "logs", "logs/zqotlp"]);
  });

  it.each(["0", "61", "1.5", ""])("refuses the duration %j: 'Must be an integer between 1 and 60.', Run held", async (typed) => {
    serveFiles([OLD_FILE]);
    useTestingStore.setState({ selectedFile: { id: OLD_FILE.id, displayName: OLD_FILE.displayName } });
    const { user } = renderTab();
    await openDialog(user);
    await waitFor(() => expect(runButton()).toBeEnabled());

    const duration = screen.getByLabelText("Run duration (seconds)");
    await user.clear(duration);
    if (typed !== "") await user.type(duration, typed);

    expect(await screen.findByText("Must be an integer between 1 and 60.")).toBeInTheDocument();
    expect(duration).toHaveAttribute("aria-invalid", "true");
    expect(runButton()).toBeDisabled();

    await user.clear(duration);
    await user.type(duration, "60");
    expect(screen.queryByText("Must be an integer between 1 and 60.")).toBeNull();
    expect(runButton()).toBeEnabled();
  });

  it("offers My Files, Templates and Paste Text as the file's sources", async () => {
    serveFiles([]);
    const { user } = renderTab();
    const dialog = await openDialog(user);

    const sources = within(dialog).getAllByRole("button").map((button) => button.textContent);
    expect(sources).toEqual(expect.arrayContaining(["My Files", "Templates", "Paste Text"]));
  });
});

describe("running", () => {
  it("queues the run with the raw text, the pin, the pipeline's name and signal, the file and the duration; remembers the duration, the file and the pipeline", async () => {
    serveFiles([OLD_FILE]);
    const queue = serveQueue();
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");
    await choosePipeline(user, "logs/zqotlp");
    const duration = screen.getByLabelText("Run duration (seconds)");
    await user.clear(duration);
    await user.type(duration, "20");

    await user.click(runButton());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(queue).toHaveBeenCalledWith(GROUP_ID, MINE.id, VERSION.id, {
      inputFileId: OLD_FILE.id,
      pipeline: "logs/zqotlp",
      signal: "logs",
      durationSeconds: 20,
      yaml: YAML,
      collectorVersion: "0.162.0",
    });
    expect(window.localStorage.getItem(LAST_RUN_DURATION_KEY)).toBe("20");
    // The queued run holds Play.
    expect(play()).toBeDisabled();

    // The next run opens where this one left off.
    act(() => useTestingStore.setState({ runs: [] }));
    await openDialog(user);
    expect(screen.getByRole("combobox", { name: "Test Pipeline" })).toHaveTextContent("logs/zqotlp");
    expect(screen.getByLabelText("Run duration (seconds)")).toHaveValue(20);
    expect(screen.getByText("Selected File:")).toHaveTextContent("zq-old-upload");
  });

  it("gives the focus back to 'Configure and run' when the dialog is cancelled, even when the click didn't focus it", async () => {
    serveFiles([]);
    const { user } = renderTab();
    const configure = play();
    // As Safari: a click doesn't focus a button, so nothing remembers it as the dialog's opener.
    fireEvent.click(configure);
    const dialog = await screen.findByRole("dialog", { name: "Select Test File" });
    expect(document.activeElement).not.toBe(configure);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(configure));
  });

  it("keeps the dialog open on a Run held since it opened (a start elsewhere): 'Another run is in progress', nothing queued", async () => {
    serveFiles([OLD_FILE]);
    const queue = serveQueue();
    const { user } = renderTab();
    const dialog = await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");
    // Another Play on this version starts while the dialog is open.
    act(() => {
      useTestingStore.getState().beginStart({ organizationId: GROUP_ID, configurationId: MINE.id, versionId: VERSION.id }, MEMBER_ID);
    });

    await user.click(runButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Another run is in progress"));
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Select Test File" })).toBe(dialog);
    expect(queue).not.toHaveBeenCalled();
  });

  it("moves the focus to the queued run's row as the dialog closes, not back to the held Play", async () => {
    serveFiles([OLD_FILE]);
    serveQueue();
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");

    await user.click(runButton());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(play()).toBeDisabled();
    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-pressed", "true"));
    expect(document.activeElement).toBeEnabled();
  });

  it("ties the duration's error to its input (aria-describedby), and its help always", async () => {
    serveFiles([]);
    const { user } = renderTab();
    await openDialog(user);
    const duration = screen.getByLabelText("Run duration (seconds)");
    expect(duration).toHaveAccessibleDescription(/How long the collector keeps running/);

    await user.clear(duration);
    await user.type(duration, "1.5");

    expect(duration).toHaveAttribute("aria-invalid", "true");
    expect(duration).toHaveAccessibleDescription(/^Must be an integer between 1 and 60\. How long the collector keeps running/);
  });

  it("asks the fixture-shape question for a file from an earlier session, reading its head from the API", async () => {
    serveFiles([OLD_FILE]);
    const head = serveHead("2026-10-09 10:14:03 INFO order placed\n2026-10-09 10:14:05 WARN payment declined\n");
    const queue = serveQueue();
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");
    await choosePipeline(user, "logs/zqotlp");

    await user.click(runButton());

    expect(await screen.findByRole("dialog", { name: "Fixture may not match the receiver" })).toBeInTheDocument();
    expect(head).toHaveBeenCalledWith(GROUP_ID, OLD_FILE.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(queue).not.toHaveBeenCalled();
  });

  it("queues without the question when the earlier session's file's head can't be read (the check is skipped)", async () => {
    serveFiles([OLD_FILE]);
    const queue = serveQueue();
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");
    await choosePipeline(user, "logs/zqotlp");

    await user.click(runButton());

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(apiClient.getTestFileHead).toHaveBeenCalledOnce();
    expect(screen.queryByText("Fixture may not match the receiver")).toBeNull();
  });

  it("reads an earlier session's head once, then keeps it", async () => {
    serveFiles([OLD_FILE]);
    const head = serveHead('{"resourceLogs":[]}');
    const queue = serveQueue();
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");
    await choosePipeline(user, "logs/zqotlp");
    await user.click(runButton());
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());

    act(() => useTestingStore.setState({ runs: [] }));
    await openDialog(user);
    await waitFor(() => expect(runButton()).toBeEnabled());
    await user.click(runButton());

    await waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
    expect(head).toHaveBeenCalledOnce();
  });

  it.each([
    [503, "testing_unavailable", "Testing is unavailable right now. Try again later."],
    [429, "test_run_rate_limited", "Too many test runs in the last minute. Try again shortly."],
    [429, "test_run_queue_full", "You have 50 test runs waiting already. Wait for some to finish."],
    [400, "collector_version_retired", "No longer offered. Pick a newer collector version."],
    [400, "collector_version_unknown", "That collector version isn't offered."],
    // The queue's own code and the shared sentence for a text too long once the organization's variables are filled
    // in (not the bare invalid_request, whose words the fallback would replace), and the family's words when the
    // values couldn't be read.
    [400, "filled_in_too_long", TEST_RUN_FILLED_IN_TOO_LONG_MESSAGE],
    [503, "variables_unavailable", VARIABLES_UNAVAILABLE_MESSAGE],
  ])("shows a %i %s refusal by its message, keeps the dialog open and Run free", async (status, code, message) => {
    serveFiles([OLD_FILE]);
    vi.spyOn(apiClient, "queueTestRun").mockRejectedValue(new ApiError(code, message, { status }));
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");

    await user.click(runButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
    expect(screen.getByRole("dialog", { name: "Select Test File" })).toBeInTheDocument();
    expect(runButton()).toBeEnabled();
    // Nothing was queued, so nothing holds Play (behind the open dialog).
    expect(screen.getByRole("button", { name: "Configure and run", hidden: true })).toBeEnabled();
  });

  it("says nothing when the session has ended (the session-ended handler takes over)", async () => {
    serveFiles([OLD_FILE]);
    const queue = vi
      .spyOn(apiClient, "queueTestRun")
      .mockRejectedValue(new ApiError("unauthenticated", "Your session has ended. Sign in again.", { status: 401 }));
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");

    await user.click(runButton());

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    await waitFor(() => expect(runButton()).toBeEnabled());
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("the dialog's slides", () => {
  it("move the focus into the slot slid in, to its first control, and back to the main view's first control", async () => {
    serveFiles([OLD_FILE]);
    const { user } = renderTab();
    await openDialog(user);
    await waitFor(() => expect(useTestingStore.getState().filesLoaded).toBe(true));

    await user.click(screen.getByRole("button", { name: "My Files" }));
    expect(screen.getByRole("button", { name: "Delete zq-old-upload" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(screen.getByLabelText("Name")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete zq-old-upload" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("combobox", { name: "Test Pipeline" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    // Format is held while the sample is empty, so the name is the first control.
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("focus the slot itself when nothing in it can take the focus (each slot can: tabIndex -1)", async () => {
    serveFiles([]);
    const { user } = renderTab();
    const dialog = await openDialog(user);
    const slots = [...dialog.querySelectorAll<HTMLElement>("[data-run-dialog-slot]")];
    expect(slots).toHaveLength(3);
    for (const slot of slots) expect(slot).toHaveAttribute("tabindex", "-1");

    // Inside the dialog, whose focus trap keeps the focus in it.
    const bare = document.createElement("div");
    bare.tabIndex = -1;
    bare.innerHTML = '<button disabled>Held</button><input type="checkbox" tabindex="-1" /><span>Text</span>';
    dialog.appendChild(bare);
    try {
      focusIntoSlot(bare);
      expect(bare).toHaveFocus();
      bare.append(document.createElement("textarea"));
      focusIntoSlot(bare);
      expect(bare.querySelector("textarea")).toHaveFocus();
    } finally {
      bare.remove();
    }
  });

  it("clip the track's box rather than hide it, so it is no scroll container: Tab mid-slide can't scroll it", async () => {
    serveFiles([]);
    const { user } = renderTab();
    const dialog = await openDialog(user);
    const track = dialog.querySelector<HTMLElement>("[data-run-dialog-track]")!;

    // `overflow: clip` (jsdom applies no stylesheet: the class is what the
    // browsers get; the browser tests check the box never scrolls in each).
    expect(track).toHaveClass("overflow-clip");
    // Not a scroll container, so no zero minimum width as a grid item of its own: given one.
    expect(track).toHaveClass("min-w-0");
    expect(track.className).not.toMatch(/\boverflow-(hidden|auto|scroll)\b/);
    // Nothing undoes a scroll any more: there is none to undo.
    expect(track.onscroll).toBeNull();
  });

  it("focus without scrolling, so the clipping box never scrolls to the slot still sliding in", () => {
    const slot = document.createElement("div");
    slot.tabIndex = -1;
    slot.innerHTML = "<input />";
    document.body.append(slot);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      focusIntoSlot(slot);
      slot.querySelector("input")?.remove();
      focusIntoSlot(slot);

      expect(focus.mock.calls).toEqual([[{ preventScroll: true }], [{ preventScroll: true }]]);
    } finally {
      slot.remove();
    }
  });
});

describe("My Files: upload", () => {
  it("uploads a picked file under its name, back to My Files with it listed first, toasting 'File uploaded'", async () => {
    serveFiles([OLD_FILE]);
    const saved = testFileFixture({ id: "0199d000-0000-7000-8000-000000000009", displayName: "zq-picked", fileName: "zq-picked.ndjson" });
    const upload = vi.spyOn(apiClient, "uploadTestFile").mockResolvedValue({ file: saved });
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "Upload" }));
    expect(await screen.findByText("Upload Test File")).toBeInTheDocument();
    expect(screen.getByText("No file selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();

    const file = new File(['{"a":1}\n{"b":2}\n'], "zq-picked.ndjson", { type: "application/x-ndjson" });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    expect(screen.getByLabelText("Name")).toHaveValue("zq-picked.ndjson");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "zq-picked");
    await user.type(screen.getByLabelText("Description"), "Two records");
    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("File uploaded"));
    expect(upload).toHaveBeenCalledWith(GROUP_ID, { displayName: "zq-picked", description: "Two records", file });
    const rows = await screen.findAllByRole("button", { pressed: false });
    expect(rows.map((row) => row.textContent)).toEqual(["zq-picked", "zq-old-upload"]);
    // Slid away, still mounted, hidden from assistive technology.
    expect(screen.getByText("Upload Test File").closest("[data-run-dialog-slot]")).toHaveAttribute("aria-hidden", "true");
  });

  it.each([
    ["zq-sheet.csv", 10, "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used."],
    ["zq-no-extension", 10, "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used."],
    ["zq-huge.log", 10 * 1024 * 1024 + 1, "The file is larger than 10 MiB."],
  ])("refuses %s before sending it, saying why, with OK held", async (name, size, message) => {
    serveFiles([]);
    const upload = vi.spyOn(apiClient, "uploadTestFile");
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "Upload" }));

    const file = new File(["x"], name);
    Object.defineProperty(file, "size", { value: size });
    // A browser's picker can offer every file ("All Files"), past `accept`.
    await userEvent.setup({ applyAccept: false }).upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    [new ApiError("test_file_too_large", "The file is larger than 10 MiB.", { status: 413 }), "The file is larger than 10 MiB."],
    [
      new ApiError("test_file_type_unsupported", "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used.", { status: 415 }),
      "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used.",
    ],
    [new ApiError("invalid_request", "The request was not valid.", { status: 400 }), "Failed to upload file"],
  ])("shows the API's refusal %#: %s", async (refusal, message) => {
    serveFiles([]);
    vi.spyOn(apiClient, "uploadTestFile").mockRejectedValue(refusal);
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "Upload" }));
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, new File(["{}"], "a.json"));

    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
    expect(screen.getByText("Upload Test File")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "OK" })).toBeEnabled();
  });
});

describe("My Files: the list and delete", () => {
  it("says so when there are no files", async () => {
    serveFiles([]);
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "My Files" }));

    expect(await screen.findByText("You have no saved files. Upload a file to select it.")).toBeInTheDocument();
  });

  it("shows a file's details: its name and description, or 'No description.'", async () => {
    serveFiles([OLD_FILE, OTHER_FILE]);
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "My Files" }));

    await user.click(await screen.findByRole("button", { name: "Show details for zq-old-upload" }));
    expect(await screen.findByText("zq-secret description")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Show details for zq-other" }));
    expect(await screen.findByText("No description.")).toBeInTheDocument();
  });

  it("deletes a file at once, toasting 'Deleted <name>'", async () => {
    serveFiles([OLD_FILE, OTHER_FILE]);
    const remove = vi.spyOn(apiClient, "deleteTestFile").mockResolvedValue(undefined);
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "My Files" }));

    await user.click(await screen.findByRole("button", { name: "Delete zq-other" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "zq-other", pressed: false })).toBeNull());
    expect(remove).toHaveBeenCalledWith(GROUP_ID, OTHER_FILE.id);
    expect(toastSuccess).toHaveBeenCalledWith("Deleted zq-other", { className: "ph-no-capture" });
  });

  it("deleting the selected file leaves the dialog's selection, and Run is held", async () => {
    serveFiles([OLD_FILE, OTHER_FILE]);
    vi.spyOn(apiClient, "deleteTestFile").mockResolvedValue(undefined);
    const { user } = renderTab();
    await openDialog(user);
    await pickFromMyFiles(user, "zq-old-upload");
    expect(runButton()).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "Delete zq-old-upload" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Deleted zq-old-upload", { className: "ph-no-capture" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("Selected File:")).toHaveTextContent("Selected File: None");
    expect(runButton()).toBeDisabled();
  });

  it("toasts 'Failed to delete <name>' when the delete fails, the file still listed", async () => {
    serveFiles([OLD_FILE]);
    vi.spyOn(apiClient, "deleteTestFile").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "My Files" }));

    await user.click(await screen.findByRole("button", { name: "Delete zq-old-upload" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to delete zq-old-upload", { className: "ph-no-capture" }));
    expect(screen.getByRole("button", { name: "zq-old-upload", pressed: false })).toBeInTheDocument();
  });

  it("toasts 'Failed to load test input files' when the read fails", async () => {
    vi.spyOn(apiClient, "getTestFiles").mockRejectedValue(new ApiError("network_error", "Could not reach the server."));
    const { user } = renderTab();

    await openDialog(user);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to load test input files"));
  });
});

describe("Paste Text", () => {
  it("is JSON for an OTLP pipeline: Format, the OTLP hint, saved as JSON and selected", async () => {
    serveFiles([]);
    const saved = testFileFixture({ id: "0199d000-0000-7000-8000-000000000010", displayName: "zq-pasted" });
    const { user } = renderTab();
    await openDialog(user);
    await choosePipeline(user, "logs/zqotlp");

    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    await screen.findByRole("textbox", { name: "Sample editor" });
    expect(fake.props?.language).toBe("json");
    expect(screen.getByRole("button", { name: "Format" })).toBeInTheDocument();
    expect(
      screen.getByText("OTLP/JSON matching the pipeline's signal (logs). Saved as a reusable file in My Files."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Sample editor" }), { target: { value: '{"resourceLogs":[]}' } });
    await user.click(screen.getByRole("button", { name: "Format" }));
    expect(screen.getByRole("textbox", { name: "Sample editor" })).toHaveValue('{\n  "resourceLogs": []\n}');

    const save = vi.spyOn(apiClient, "saveTestSample").mockResolvedValue({ file: saved });
    await user.type(screen.getByLabelText("Name"), "zq-pasted");
    await user.click(screen.getByRole("button", { name: "Use Sample" }));

    expect(await screen.findByText("zq-pasted", { selector: "span.font-mono" })).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(GROUP_ID, { displayName: "zq-pasted", text: '{\n  "resourceLogs": []\n}', format: "json" });
    expect(toastSuccess).toHaveBeenCalledWith("Sample saved to My Files");
    expect(runButton()).toBeEnabled();
  });

  it("is plain text for the filelog pipeline, narrowed to the target: the raw hint, saved as text", async () => {
    serveFiles([]);
    const { user } = renderTab();
    await openDialog(user);
    await choosePipeline(user, "logs");

    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    await screen.findByRole("textbox", { name: "Sample editor" });
    expect(fake.props?.language).toBe("plaintext");
    expect(screen.queryByRole("button", { name: "Format" })).toBeNull();
    expect(
      screen.getByText(
        "Raw log lines (one record per line), as your filelog receiver reads them from disk. Saved as a reusable file in My Files.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // Its OTLP sibling of the same signal is JSON, not filelog's plain text.
    await choosePipeline(user, "logs/zqotlp");
    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    await screen.findByRole("textbox", { name: "Sample editor" });
    expect(fake.props?.language).toBe("json");
  });

  it("says 'Content is not valid JSON' when Format can't read it", async () => {
    serveFiles([]);
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Sample editor" }), { target: { value: "{not json" } });

    await user.click(screen.getByRole("button", { name: "Format" }));

    expect(toastError).toHaveBeenCalledWith("Content is not valid JSON");
  });

  it.each([
    ["zq-big", "x".repeat(1024 * 1024 + 1), "Sample exceeds the 1MB limit"],
    ["zq-sheet.csv", "a,b", "Only .json, .ndjson, .yaml, .yml, .txt and .log files can be used."],
  ])("refuses %s before sending it: %s", async (name, text, message) => {
    serveFiles([]);
    const save = vi.spyOn(apiClient, "saveTestSample");
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    await user.type(await screen.findByLabelText("Name"), name);
    fireEvent.change(screen.getByRole("textbox", { name: "Sample editor" }), { target: { value: text } });

    await user.click(screen.getByRole("button", { name: "Use Sample" }));

    expect(toastError).toHaveBeenCalledWith(message);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Paste Test Sample")).toBeInTheDocument();
  });

  it("shows the API's refusal, else 'Failed to save the sample'", async () => {
    serveFiles([]);
    const save = vi
      .spyOn(apiClient, "saveTestSample")
      .mockRejectedValueOnce(new ApiError("rate_limited", "Too many requests. Try again shortly.", { status: 429 }))
      .mockRejectedValueOnce(new ApiError("unexpected_response", "The server returned an unexpected response."));
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    await user.type(await screen.findByLabelText("Name"), "zq-s");
    fireEvent.change(screen.getByRole("textbox", { name: "Sample editor" }), { target: { value: "{}" } });

    await user.click(screen.getByRole("button", { name: "Use Sample" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Too many requests. Try again shortly."));
    await user.click(screen.getByRole("button", { name: "Use Sample" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to save the sample"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps the sample editor in a ph-no-capture block with Monaco's live region inside, word suggestions off, no path", async () => {
    serveFiles([]);
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Paste Text" }));

    const editor = await screen.findByRole("textbox", { name: "Sample editor" });
    const block = editor.closest(".ph-no-capture");
    expect(block).not.toBeNull();
    const options = fake.props?.options as { ariaContainerElement?: HTMLElement; wordBasedSuggestions?: string };
    // The shell's one replay-blocked host, shared by every Monaco.
    expect(options.ariaContainerElement).toBe(monacoAriaHost());
    expect(options.ariaContainerElement!.closest(".ph-no-capture")).not.toBeNull();
    expect(options.wordBasedSuggestions).toBe("off");
    expect(fake.props).not.toHaveProperty("path");
    expect(fake.props).not.toHaveProperty("defaultPath");
    // The store's theme: the member's default, Dark.
    expect(fake.props?.theme).toBe("telflo-dark");
  });

  it("waits for Monaco before mounting it, and offers 'Try again' when it fails to load", async () => {
    serveFiles([]);
    let attempts = 0;
    fake.initMonaco = () => (++attempts === 1 ? Promise.reject(new Error("chunk")) : Promise.resolve());
    const { user } = renderTab();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Paste Text" }));

    expect(await screen.findByText("The editor couldn't load.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Sample editor" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Sample editor" })).toBeInTheDocument();
  });
});

describe("the fixture-shape check", () => {
  const RAW_LINES = "2026-10-09 10:14:03 INFO order placed\n2026-10-09 10:14:05 WARN payment declined\n";
  const F001 =
    "Your fixture looks like raw text log lines, but the target pipeline uses an OTLP receiver. The sandbox OTLP/HTTP endpoint will reject each line as invalid JSON, so the run is likely to produce no output. Convert the fixture to OTLP-JSON to test this pipeline, or test a `file_log` (or `filelog`) receiver pipeline against this fixture as-is.";
  const SAMPLE = testFileFixture({ id: "0199d000-0000-7000-8000-000000000011", displayName: "zq-lines", fileName: "zq-lines.json" });

  async function askAboutRawLines(user: ReturnType<typeof userEvent.setup>) {
    serveFiles([]);
    await openDialog(user);
    await choosePipeline(user, "logs/zqotlp");
    await pasteSample(user, "zq-lines", RAW_LINES, SAMPLE);
    await user.click(runButton());
    return screen.findByRole("dialog", { name: "Fixture may not match the receiver" });
  }

  it("asks before queuing raw lines on an OTLP pipeline; Cancel queues nothing", async () => {
    const queue = serveQueue();
    const { user } = renderTab();

    const question = await askAboutRawLines(user);

    expect(within(question).getByText(F001)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Select Test File" })).toBeNull();
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(queue).not.toHaveBeenCalled();
    expect(play()).toBeEnabled();
  });

  it("'Run Anyway' queues the run as it was asked about", async () => {
    const queue = serveQueue();
    const { user } = renderTab();

    const question = await askAboutRawLines(user);
    await user.click(within(question).getByRole("button", { name: "Run Anyway" }));

    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(queue.mock.calls[0]?.[3]).toMatchObject({ inputFileId: SAMPLE.id, pipeline: "logs/zqotlp", signal: "logs" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The focus goes to the queued run's row, not the held Play.
    await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-pressed", "true"));
  });

  it("'Run Anyway' shows a refusal by its message", async () => {
    vi.spyOn(apiClient, "queueTestRun").mockRejectedValue(
      new ApiError("testing_unavailable", "Testing is unavailable right now. Try again later.", { status: 503 }),
    );
    const { user } = renderTab();

    const question = await askAboutRawLines(user);
    await user.click(within(question).getByRole("button", { name: "Run Anyway" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Testing is unavailable right now. Try again later."));
  });

  it("doesn't ask about the same lines on the filelog pipeline, nor about an OTLP envelope on the OTLP sibling (the target, not its signal)", async () => {
    serveFiles([]);
    const queue = serveQueue();
    const { user } = renderTab();
    await openDialog(user);
    await choosePipeline(user, "logs");
    await pasteSample(user, "zq-lines", RAW_LINES, SAMPLE);
    await user.click(runButton());
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());

    act(() => useTestingStore.setState({ runs: [] }));
    const envelope = testFileFixture({ id: "0199d000-0000-7000-8000-000000000012", displayName: "zq-envelope" });
    await openDialog(user);
    await choosePipeline(user, "logs/zqotlp");
    await pasteSample(user, "zq-envelope", '{"resourceLogs":[]}', envelope);
    await user.click(runButton());

    await waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Fixture may not match the receiver")).toBeNull();
  });
});

describe("replay", () => {
  it("puts no file name, description, sample or pipeline name in any attribute, with every panel and popover shown", async () => {
    serveFiles([OLD_FILE, OTHER_FILE]);
    vi.spyOn(apiClient, "uploadTestFile");
    const { user } = renderTab();
    await openDialog(user);
    const markers: string[] = [];
    /** Every attribute in the document carrying a marker; an input's value is masked by replay, as elsewhere. */
    const scan = () => {
      for (const element of document.querySelectorAll("*")) {
        for (const attribute of element.attributes) {
          if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && attribute.name === "value") continue;
          if (attribute.value.includes("zq")) markers.push(`${element.tagName} ${attribute.name}="${attribute.value}"`);
        }
      }
    };

    await choosePipeline(user, "logs/zqotlp");
    scan();
    await pickFromMyFiles(user, "zq-old-upload");
    scan();
    await user.click(screen.getByRole("button", { name: "My Files" }));
    await user.click(await screen.findByRole("button", { name: "Show details for zq-old-upload" }));
    await screen.findByText("zq-secret description");
    scan();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Upload" }));
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(picker, new File(["{}"], "zq-picked.json"));
    await screen.findByText("zq-picked.json");
    scan();
    // Replay records a file input's value (the file's name) whatever maskAllInputs says: it is blocked.
    expect(picker.closest(".ph-no-capture")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Paste Text" }));
    await user.type(await screen.findByLabelText("Name"), "zq-pasted");
    fireEvent.change(screen.getByRole("textbox", { name: "Sample editor" }), { target: { value: "zq sample text" } });
    scan();

    expect(markers).toEqual([]);
    // The scan saw them, as text.
    expect(screen.getByText("zq-old-upload", { selector: "span.font-mono" })).toBeInTheDocument();
  });
});
