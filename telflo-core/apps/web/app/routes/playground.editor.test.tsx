/**
 * `/playground/editor/:configurationId?`: a sample's draft opened under the
 * sample's organization with no API, the playground toolbar (the name as
 * text, the fixed pin, Save staging the edit and opening "Sign in to save",
 * Publish locked), the canvas pill, the blank new configuration, an unknown
 * id's "not found", Cmd/Ctrl+S, no unload guard, the anonymous validate as
 * the only request, everything forgotten on leaving, the phone page, and
 * the playground tour's editor stage (never the editor's own tour).
 *
 * Monaco is stubbed (as routes/editor.test.tsx's): the stub records its
 * props and commands.
 */

import { useEffect } from "react";
import type { EditorProps } from "@monaco-editor/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub, useLocation } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const fake = vi.hoisted(() => ({ mounted: false, commands: [] as (() => void)[] }));
const monaco = {
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  MarkerSeverity: { Error: 8 },
  editor: { defineTheme: () => undefined, onDidChangeMarkers: () => ({ dispose: () => undefined }), getModelMarkers: () => [] },
};
const monacoModel = {
  uri: "inmemory://model/1",
  value: "",
  updateOptions: () => undefined,
  getValue: () => monacoModel.value,
  getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
  pushStackElement: () => undefined,
  setValue: (value: string) => {
    monacoModel.value = value;
  },
};
const monacoEditor = {
  getModel: () => monacoModel,
  addCommand: (_keybinding: number, handler: () => void) => {
    fake.commands.push(handler);
    return null;
  },
  executeEdits: () => true,
  saveViewState: () => null,
  restoreViewState: () => undefined,
  onDidDispose: () => ({ dispose: () => undefined }),
};
vi.mock("@monaco-editor/react", () => ({
  default: function MonacoStub(props: EditorProps) {
    useEffect(() => {
      monacoModel.value = props.value ?? "";
      props.beforeMount?.(monaco as never);
      props.onMount?.(monacoEditor as never, monaco as never);
      fake.mounted = true;
      return () => {
        fake.mounted = false;
        fake.commands = [];
      };
      // Once, as Monaco mounts once.
    }, []);
    return <div data-testid="monaco-stub" />;
  },
  DiffEditor: function DiffEditorStub() {
    return <div />;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({ initMonaco: () => Promise.resolve(), setMonacoSchema: () => undefined }));
// The editor's own tour, watched: the playground editor never starts it.
vi.mock("~/components/editor/builder/tour/start-editor-tour.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startEditorTour: vi.fn(() => () => undefined),
}));

import * as apiClient from "~/lib/api-client.js";
import { startEditorTour } from "~/components/editor/builder/tour/start-editor-tour.js";
import {
  PLAYGROUND_TOUR_STAGE_KEY,
  resetPlaygroundTourForTests,
  setPlaygroundTourStage,
} from "~/components/playground/playground-tour.js";
import { SIGNUP_PROMPT_TITLE, signupPromptText } from "~/components/playground/SignupPromptDialog.js";
import { SIGN_IN_TO_SAVE_TITLE } from "~/components/playground/SignInToSaveDialog.js";
import { PUBLISH_LOCKED_ACTION } from "~/components/playground/PlaygroundToolbar.js";
import { PHONE_PAGE_TEXT } from "~/components/playground/PlaygroundPhonePage.js";
import { sampleConfiguration, SAMPLE_CONFIGURATION_IDS } from "~/lib/playground/sample/configurations.js";
import { NEW_CONFIGURATION_PIN } from "~/lib/playground/sample/types.js";
import { STAGED_EDIT_KEY } from "~/lib/playground/staged-edit.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestingStore } from "~/lib/stores/testing-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { GROUP_ID, signedInMember } from "~/test/configurations.js";
import { matchMediaQueries } from "~/test/intersection-observer.js";
import { installReactFlowMocks } from "~/test/react-flow-jsdom.js";
import PlaygroundEditorPage, { BLANK_CONFIGURATION_ID, BLANK_PILL_TEXT, SAMPLE_PILL_TEXT } from "./playground.editor.js";

const GATEWAY = SAMPLE_CONFIGURATION_IDS.gateway;

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderEditor(path: string) {
  const Stub = createRoutesStub([
    { path: "/playground/editor/:configurationId?", Component: PlaygroundEditorPage },
    { path: "/playground", Component: Where },
    { path: "/app", Component: Where },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

let restoreReactFlow: () => void;
beforeAll(() => {
  restoreReactFlow = installReactFlowMocks();
});
afterAll(() => restoreReactFlow());

let spies: ReturnType<typeof spyOnTheClient>;
let validate: MockInstance<typeof apiClient.validateAnonymously>;

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.getState().reset();
  useTestingStore.getState().reset();
  spies = spyOnTheClient();
  validate = vi
    .spyOn(apiClient, "validateAnonymously")
    .mockImplementation(async (request) => ({ valid: true, collectorVersion: request.collectorVersion ?? NEW_CONFIGURATION_PIN, errors: [] }));
});

afterEach(() => {
  // The anonymous validate is the only request the page makes.
  for (const spy of spies) if ((spy as unknown) !== validate) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  useUserStore.getState().clear();
  document.body.className = "";
});

describe("a sample configuration", () => {
  it("opens its draft under the sample's organization, the name as text, the pin fixed, the pill over the canvas", async () => {
    renderEditor(`/playground/editor/${GATEWAY}`);
    const sample = sampleConfiguration(GATEWAY)!;
    expect(await screen.findByRole("heading", { level: 1, name: sample.configuration.name })).toBeInTheDocument();
    const editor = useEditorStore.getState();
    expect(editor.organizationId).toBe(SAMPLE_ORGANIZATION_ID);
    expect(editor.configuration?.id).toBe(GATEWAY);
    expect(editor.version?.id).toBe(sample.version.id);
    expect(editor.version?.publishedAt).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename configuration" })).toBeNull();
    expect(screen.getByRole("combobox", { name: `Collector version v${sample.version.collectorVersion}` })).toBeInTheDocument();
    expect(screen.getByText(SAMPLE_PILL_TEXT)).toBeInTheDocument();
    // Sign in, labelled so, under the open source's invitation-only default.
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("link", { name: "Create a free account" })).toBeNull();
    for (const tab of ["Configuration", "YAML", "Testing"]) expect(screen.getAllByRole("tab", { name: tab }).length).toBeGreaterThan(0);
    // Masked as the signed-in shell.
    expect(document.body).toHaveClass("tf-app", "ph-mask");
  });

  it("checks its text with the anonymous validate after the pause", async () => {
    renderEditor(`/playground/editor/${GATEWAY}`);
    await screen.findByRole("heading", { level: 1, name: sampleConfiguration(GATEWAY)!.configuration.name });
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    const [request] = validate.mock.calls[0]!;
    expect(request).toMatchObject({ distribution: "otelcol-contrib", collectorVersion: sampleConfiguration(GATEWAY)!.version.collectorVersion });
    expect(request.yaml === sampleConfiguration(GATEWAY)!.version.yamlContent).toBe(true);
  });

  it("Save stages the edit and opens Sign in to save; so does Cmd/Ctrl+S", async () => {
    const user = userEvent.setup();
    renderEditor(`/playground/editor/${GATEWAY}`);
    await screen.findByRole("heading", { level: 1, name: sampleConfiguration(GATEWAY)!.configuration.name });

    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: SIGN_IN_TO_SAVE_TITLE });
    expect(window.localStorage.getItem(STAGED_EDIT_KEY) !== null).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    window.localStorage.clear();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(await screen.findByRole("alertdialog", { name: SIGN_IN_TO_SAVE_TITLE })).toBeInTheDocument();
    expect(window.localStorage.getItem(STAGED_EDIT_KEY) !== null).toBe(true);
  });

  it("locks Publish: the sign-up prompt with its words", async () => {
    const user = userEvent.setup();
    renderEditor(`/playground/editor/${GATEWAY}`);
    await screen.findByRole("heading", { level: 1, name: sampleConfiguration(GATEWAY)!.configuration.name });
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).getByText(signupPromptText(PUBLISH_LOCKED_ACTION))).toBeInTheDocument();
  });

  it("guards nothing on leaving, and forgets the sample: the editor and every Testing tab store", async () => {
    const user = userEvent.setup();
    const listening = vi.spyOn(window, "addEventListener");
    const view = renderEditor(`/playground/editor/${GATEWAY}`);
    await screen.findByRole("heading", { level: 1, name: sampleConfiguration(GATEWAY)!.configuration.name });
    await waitFor(() => expect(useTestingStore.getState().runs.length).toBeGreaterThan(0));
    // The Validation and Suites subtabs read the sample's pipelines and suites.
    await user.click(screen.getByRole("tab", { name: "Testing" }));
    await user.click(screen.getByRole("tab", { name: "Validation" }));
    await waitFor(() => expect(useValidationPipelinesStore.getState().pipelines.length).toBeGreaterThan(0));
    await user.click(screen.getByRole("tab", { name: "Suites" }));
    await waitFor(() => expect(useTestSuitesStore.getState().suites.length).toBeGreaterThan(0));
    expect(listening.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
    view.unmount();
    expect(useEditorStore.getState().configuration).toBeNull();
    expect(useTestingStore.getState().runs).toEqual([]);
    expect(useValidationPipelinesStore.getState().pipelines).toEqual([]);
    expect(useTestSuitesStore.getState().suites).toEqual([]);
  });

  it("forgets on arrival what the Testing tab's stores held before (a signed-in editor's)", async () => {
    useTestingStore.setState({
      selectedTemplate: { id: "00000000-0000-4000-8000-0000000000e1", name: "left behind" },
      selectedPipelineName: "logs/left-behind",
    });
    useTestSuitesStore.setState({ suitesError: "left behind" });
    useValidationPipelinesStore.setState({ pipelinesError: "left behind" });
    renderEditor(`/playground/editor/${GATEWAY}`);
    await screen.findByRole("heading", { level: 1, name: sampleConfiguration(GATEWAY)!.configuration.name });
    expect(useTestingStore.getState()).toMatchObject({ selectedTemplate: null, selectedPipelineName: null });
    expect(useTestSuitesStore.getState().suitesError).toBeNull();
    expect(useValidationPipelinesStore.getState().pipelinesError).toBeNull();
  });
});

describe("a signed-in visitor", () => {
  it("opens a node's form, its variable-aware fields included, sending nothing for their real organization", async () => {
    useUserStore.getState().setCurrent(signedInMember(GROUP_ID));
    renderEditor(`/playground/editor/${GATEWAY}`);
    await screen.findByRole("heading", { level: 1, name: sampleConfiguration(GATEWAY)!.configuration.name });
    const exporter = useEditorStore.getState().graph.nodes.find((node) => node.data.componentSubType === "otlphttp")!;
    act(() => useEditorStore.getState().selectNode(exporter.id));
    // The endpoint field is a VaultAwareInput (organization variables' names): none read, the sample has none.
    expect(await screen.findByDisplayValue("https://otlp-gateway.acme.example/otlp")).toBeInTheDocument();
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    expect(apiClient.getOrganizationVariables).not.toHaveBeenCalled();
    // afterEach: no other API client call either.
  });
});

describe("the blank playground editor", () => {
  it("opens a blank new configuration of its own on the newest offered pin", async () => {
    renderEditor("/playground/editor");
    expect(await screen.findByRole("heading", { level: 1, name: "Untitled configuration" })).toBeInTheDocument();
    const editor = useEditorStore.getState();
    expect(editor.organizationId).toBe(SAMPLE_ORGANIZATION_ID);
    expect(editor.configuration?.id).toBe(BLANK_CONFIGURATION_ID);
    expect(editor.collectorVersion).toBe(NEW_CONFIGURATION_PIN);
    expect(editor.text).toBe("");
    expect(screen.getByText(BLANK_PILL_TEXT)).toBeInTheDocument();
  });
});

describe("an id the sample doesn't hold", () => {
  it("shows the editor's own not-found, its way back the playground's list", async () => {
    const user = userEvent.setup();
    renderEditor("/playground/editor/00000000-0000-4000-8000-000000000999");
    expect(await screen.findByText("Configuration not found")).toBeInTheDocument();
    expect(useEditorStore.getState().configuration).toBeNull();
    await user.click(screen.getByRole("link", { name: "Back to configurations" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(/^\/playground$/);
  });
});

describe("the tour", () => {
  const tourTitle = () => document.querySelector(".driver-popover-title")?.textContent;
  beforeEach(() => {
    window.sessionStorage.clear();
    resetPlaygroundTourForTests();
    vi.mocked(startEditorTour).mockClear();
  });
  afterEach(() => {
    resetPlaygroundTourForTests();
    document.querySelectorAll(".driver-popover, .driver-overlay").forEach((el) => el.remove());
  });

  it("runs the playground tour's editor stage when the list hands it over, never the editor's own", async () => {
    setPlaygroundTourStage("editor");
    renderEditor(`/playground/editor/${GATEWAY}`);
    await waitFor(() => expect(tourTitle()).toBe("Your pipeline, not a wall of YAML"));
    expect(document.querySelector(".driver-active-element")).toBe(document.querySelector('[data-tour-step="canvas"]'));
    expect(window.sessionStorage.getItem(PLAYGROUND_TOUR_STAGE_KEY)).toBeNull();
    expect(startEditorTour).not.toHaveBeenCalled();
  });

  it("starts no tour without a hand-over, though the editor's own tour was never seen", async () => {
    renderEditor(`/playground/editor/${GATEWAY}`);
    await screen.findByRole("heading", { level: 1, name: sampleConfiguration(GATEWAY)!.configuration.name });
    // The anonymous validate's 1.5 s pause is longer than any tour's settle delay.
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".driver-popover")).toBeNull();
    expect(startEditorTour).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("telflo-tour-completed")).toBeNull();
  });
});

describe("on a phone", () => {
  it("shows the phone page: no editor, nothing validated", async () => {
    const original = window.matchMedia;
    window.matchMedia = matchMediaQueries(["(max-width: 767px)"]);
    try {
      renderEditor(`/playground/editor/${GATEWAY}`);
      expect(await screen.findByText(PHONE_PAGE_TEXT)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to playground" })).toHaveAttribute("href", "/playground");
      expect(fake.mounted).toBe(false);
      expect(useEditorStore.getState().configuration).toBeNull();
    } finally {
      window.matchMedia = original;
    }
    expect(validate).not.toHaveBeenCalled();
  });
});
