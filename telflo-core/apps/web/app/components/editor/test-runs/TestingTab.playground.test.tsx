/**
 * The Testing tab in the playground (D31-1 decisions 2, 12, 24 and 31;
 * Preflight rulings 8 and 9; Ruling 280): its runs, a run's details and its
 * input and output, the Validation subtab's pipelines and rules and the
 * Suites subtab's suites and definitions are the sample's, read through the
 * seam (`readsFor`), and no API client function is called; the run dialog
 * opens on the sample's templates, and every action that would run, change,
 * upload, view or download a template, or read the regex library opens the
 * sign-up prompt at its button, with its words, and does nothing else. The
 * signed-in tab is TestingTab.test.tsx's (unchanged).
 *
 * Monaco is stubbed (a textarea holding its text), as in TestingTab's tests.
 */

import type { EditorProps } from "@monaco-editor/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: function DiffEditorStub() {
    return <div />;
  },
  default: function MonacoStub(props: EditorProps) {
    useEffect(() => {
      props.beforeMount?.({ editor: { defineTheme: () => undefined } } as never);
      // Once, as Monaco mounts once.
    }, []);
    return <textarea aria-label="File text" readOnly value={props.value ?? ""} />;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => Promise.resolve(), setMonacoSchema: () => undefined }));
const downloads = vi.hoisted(() => ({ names: [] as string[], blobs: [] as Blob[] }));
vi.mock("~/lib/download.js", () => ({
  downloadBlob: (blob: Blob, name: string) => {
    downloads.names.push(name);
    downloads.blobs.push(blob);
  },
}));

/** A downloaded blob's text (jsdom's Blob has no `text()`). */
function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

import { SIGNUP_PROMPT_TITLE, signupPromptText } from "~/components/playground/SignupPromptDialog.js";
import { PlaygroundContext } from "~/lib/playground/context.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { sampleConfiguration, SAMPLE_CONFIGURATION_IDS } from "~/lib/playground/sample/configurations.js";
import { sampleTesting } from "~/lib/playground/sample/testing-tab.js";
import { sampleVisitor } from "~/lib/playground/sample/types.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { LAST_RUN_DURATION_KEY, useTestingStore } from "~/lib/stores/testing-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { MyFilesPanel } from "./MyFilesPanel.js";
import { TestingTab } from "./TestingTab.js";

const initialEditor = useEditorStore.getState();
const initialTesting = useTestingStore.getState();

function renderInPlayground(children: ReactNode) {
  const Stub = createRoutesStub([{ path: "/", Component: () => <PlaygroundProvider>{children}</PlaygroundProvider> }]);
  return render(<Stub initialEntries={["/"]} />);
}

/** The gateway sample's testing, as the reads answer it. */
const gateway = () => sampleTesting().configurations.find((configuration) => configuration.configurationId === SAMPLE_CONFIGURATION_IDS.gateway)!;

let spies: ReturnType<typeof spyOnTheClient>;

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  downloads.names = [];
  downloads.blobs = [];
  useEditorStore.setState(initialEditor, true);
  useTestingStore.getState().reset();
  useTestingStore.setState({ ...initialTesting, lastRunDurationSeconds: 5 }, true);
  useTestSuitesStore.getState().reset();
  useValidationPipelinesStore.getState().reset();
  useEditorStore.getState().load({ organizationId: SAMPLE_ORGANIZATION_ID, ...sampleConfiguration(SAMPLE_CONFIGURATION_IDS.gateway)! });
  spies = spyOnTheClient();
});

afterEach(() => {
  // Nothing in the playground calls the API client: every read is the sample's, every write locked.
  for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  useUserStore.getState().clear();
});

/** The sign-up prompt, open with `words`; closed with Keep exploring. */
async function expectPrompt(user: ReturnType<typeof userEvent.setup>, words: string) {
  const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
  expect(within(prompt).getByText(signupPromptText(words))).toBeInTheDocument();
  await user.click(within(prompt).getByRole("button", { name: "Keep exploring" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: SIGNUP_PROMPT_TITLE })).toBeNull());
}

describe("the Tests subtab", () => {
  it("lists the sample's runs, newest first, and shows a run's details", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    const rows = await screen.findAllByRole("button", { pressed: false, name: /Success|Error|Validation Failed/ });
    expect(rows).toHaveLength(gateway().runs.length);
    await user.click(rows[0]!);
    const results = await screen.findByRole("region", { name: "Test results" });
    expect(await within(results).findByText("k8s-pod-logs.json")).toBeInTheDocument();
  });

  it("opens and downloads a run's input and output from the sample (Ruling 280)", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    const [newest] = await screen.findAllByRole("button", { pressed: false, name: /Success|Error|Validation Failed/ });
    await user.click(newest!);
    const results = await screen.findByRole("region", { name: "Test results" });

    await user.click(await within(results).findByRole("button", { name: "k8s-pod-logs.json" }));
    const viewer = await screen.findByRole("dialog");
    const shown = (await within(viewer).findByLabelText("File text")) as HTMLTextAreaElement;
    expect(shown.value).toContain('"service.name"');
    await user.keyboard("{Escape}");

    await user.click(within(results).getByRole("button", { name: "Download k8s-pod-logs.json" }));
    await user.click(within(results).getByRole("button", { name: "Download test-output.json" }));
    await waitFor(() => expect(downloads.names).toEqual(["k8s-pod-logs.json", "test-output.json"]));
    const [input, output] = await Promise.all(downloads.blobs.map(textOf));
    const run = gateway().runs[0]!;
    expect(input).toBe(new TextDecoder().decode(run.files.input));
    expect(output).toBe(new TextDecoder().decode(run.files.output));
  });

  it("locks ↺ and Compare at their buttons", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    const [newest] = await screen.findAllByRole("button", { pressed: false, name: /Success|Error|Validation Failed/ });
    await user.click((await screen.findAllByRole("button", { name: "Re-run test" }))[0]!);
    await expectPrompt(user, "run a test against your config");

    await user.click(newest!);
    const results = await screen.findByRole("region", { name: "Test results" });
    await user.click(await within(results).findByRole("button", { name: /Compare input ↔ output/ }));
    await expectPrompt(user, "compare a run's input and output");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the run dialog", () => {
  it("opens on the sample's templates; its Run is locked, remembering nothing (duration, input, pipeline) and queuing nothing", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    await user.click(await screen.findByRole("button", { name: "Configure and run" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Test File" });
    await user.click(within(dialog).getByRole("button", { name: /Templates/ }));
    await user.click(await within(dialog).findByText("Kubernetes pod logs"));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    // The duration changed, so a signed-in Run would remember it.
    const duration = within(dialog).getByLabelText("Run duration (seconds)");
    await user.clear(duration);
    await user.type(duration, "9");
    await user.click(within(dialog).getByRole("button", { name: "Run" }));

    await expectPrompt(user, "run a test against your config");
    expect(screen.queryByRole("dialog", { name: "Select Test File" })).toBeNull();
    expect(window.localStorage.getItem(LAST_RUN_DURATION_KEY)).toBeNull();
    expect(useTestingStore.getState().lastRunDurationSeconds).toBe(5);
    // Nor the input or pipeline, as a signed-in Run's would be (Ruling 291).
    expect(useTestingStore.getState()).toMatchObject({ selectedFile: null, selectedTemplate: null, selectedPipelineName: null });
  });

  it("gives the focus back to Configure and run after the locked Run's prompt: the Run pressed is gone by then (Ruling 299)", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    const opener = await screen.findByRole("button", { name: "Configure and run" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Select Test File" });
    await user.click(within(dialog).getByRole("button", { name: /Templates/ }));
    await user.click(await within(dialog).findByText("Kubernetes pod logs"));
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    const run = within(dialog).getByRole("button", { name: "Run" });
    await user.click(run);
    await expectPrompt(user, "run a test against your config");
    expect(run.isConnected).toBe(false);
    expect(opener).toHaveFocus();
  });

  it("locks a template's View contents and Download, Paste Text and My Files' Upload", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    await user.click(await screen.findByRole("button", { name: "Configure and run" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Test File" });

    await user.click(within(dialog).getByRole("button", { name: /Templates/ }));
    await user.click(await within(dialog).findByRole("button", { name: "View contents of Kubernetes pod logs" }));
    await expectPrompt(user, "view a template's contents");
    await user.click(within(dialog).getByRole("button", { name: "Download Kubernetes pod logs" }));
    await expectPrompt(user, "download a template");
    expect(downloads.names).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await user.click(within(dialog).getByRole("button", { name: /Paste Text/ }));
    await expectPrompt(user, "save a pasted sample");

    await user.click(within(dialog).getByRole("button", { name: /My Files/ }));
    expect(await within(dialog).findByText("You have no saved files. Upload a file to select it.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    await expectPrompt(user, "upload a test file");
  });
});

describe("the Validation subtab", () => {
  it("shows the sample's pipeline and rules; every change and the regex library are locked", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    await user.click(screen.getByRole("tab", { name: "Validation" }));
    await user.click(await screen.findByRole("button", { name: "Add validation pipeline" }));
    await expectPrompt(user, "create a validation pipeline");

    await user.click(screen.getByRole("button", { name: "Delete validation pipeline" }));
    await expectPrompt(user, "delete a validation pipeline");

    await user.click(screen.getByRole("button", { name: /^logs/, expanded: false }));
    expect(await screen.findByRole("button", { name: "Edit rule 2: No SSNs leak through" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Edit rule 1:/ }));
    await expectPrompt(user, "edit a validation rule");
    await user.click(screen.getByRole("button", { name: /^Delete rule 2:/ }));
    await expectPrompt(user, "delete a validation rule");
    await user.click(screen.getByRole("button", { name: "Add Validation Rule" }));
    await expectPrompt(user, "add a validation rule");
    await user.click(screen.getByRole("button", { name: "Add from regex library" }));
    await expectPrompt(user, "add rules from the regex library");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Suites subtab", () => {
  it("shows the sample's suite and its definitions; every run and change is locked", async () => {
    const user = userEvent.setup();
    renderInPlayground(<TestingTab />);
    await user.click(screen.getByRole("tab", { name: "Suites" }));
    expect(await screen.findByText("Nightly regression")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add suite" }));
    await expectPrompt(user, "create a test suite");
    await user.click(screen.getByRole("button", { name: "Play all tests in parallel" }));
    await expectPrompt(user, "run a test suite against your config");
    await user.click(screen.getByRole("button", { name: "Play all tests serially" }));
    await expectPrompt(user, "run a test suite against your config");
    await user.click(screen.getByRole("button", { name: "Edit suite" }));
    await expectPrompt(user, "edit a test suite");
    await user.click(screen.getByRole("button", { name: "Delete suite" }));
    await expectPrompt(user, "delete a test suite");

    await user.click(screen.getByRole("button", { name: /^Nightly regression/, expanded: false }));
    expect(await screen.findByText("k8s attributes present")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Run test" })[0]!);
    await expectPrompt(user, "run a test against your config");
    await user.click(screen.getAllByRole("button", { name: "Delete test configuration" })[0]!);
    await expectPrompt(user, "delete a test configuration");
    await user.click(screen.getByRole("button", { name: /Add test configuration/ }));
    await expectPrompt(user, "add a test configuration");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("My Files", () => {
  it("locks a file's delete at its button (the sample has none of the visitor's: here one is listed)", async () => {
    const user = userEvent.setup();
    const lock = vi.fn();
    const file = {
      id: "00000000-0000-4000-8000-0000000000f1",
      displayName: "checkout sample",
      fileName: "checkout-sample.json",
      description: "",
      contentType: "application/json",
      sizeBytes: 12,
      sha256: "0".repeat(64),
      createdAt: new Date().toISOString(),
    };
    useTestingStore.setState({ filesOrganizationId: SAMPLE_ORGANIZATION_ID, files: [file], filesLoaded: true });
    const value = { visitor: sampleVisitor(), lock, catalogue: [], openSignInToSave: () => undefined };
    render(
      <PlaygroundContext.Provider value={value}>
        <MyFilesPanel
          organizationId={SAMPLE_ORGANIZATION_ID}
          onDone={() => undefined}
          onCancel={() => undefined}
          onSelectFile={() => undefined}
          onRequestUpload={() => undefined}
        />
      </PlaygroundContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "Delete checkout sample" }));
    // The words, and the Delete pressed as the prompt's opener (Ruling 299).
    expect(lock).toHaveBeenCalledWith("delete a test file", screen.getByRole("button", { name: "Delete checkout sample" }));
    expect(useTestingStore.getState().files).toEqual([file]);
  });
});
