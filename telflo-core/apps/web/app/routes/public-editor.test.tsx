/**
 * `/public-editor`: the blank public editor, its own configuration and draft
 * opened under the sample's organization with no API, the public toolbar
 * (the name as text, the fixed pin, Save staging the edit and opening "Sign
 * in to save", Publish locked), no Testing tab, the Welcome dialog until
 * done (Start from Scratch, Use a Template, the tour with no version-history
 * step), Cmd/Ctrl+S, no unload guard, the anonymous validate as the only
 * request, everything forgotten on leaving, and the phone page.
 *
 * Monaco is stubbed (as routes/playground.editor.test.tsx's).
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

import * as apiClient from "~/lib/api-client.js";
import * as tour from "~/components/editor/builder/tour/start-editor-tour.js";
import { PHONE_PAGE_TEXT } from "~/components/playground/PlaygroundPhonePage.js";
import { PUBLISH_LOCKED_ACTION } from "~/components/playground/PlaygroundToolbar.js";
import {
  PUBLIC_EDITOR_WELCOME_DONE_KEY,
  PUBLIC_EDITOR_WELCOME_TITLE,
  SKIP_TOUR_LABEL,
  START_BLANK_LABEL,
  START_EXAMPLE_LABEL,
} from "~/components/playground/PublicEditorWelcomeDialog.js";
import { SIGN_IN_TO_SAVE_TITLE } from "~/components/playground/SignInToSaveDialog.js";
import { SIGNUP_PROMPT_TITLE, signupPromptText } from "~/components/playground/SignupPromptDialog.js";
import { SAMPLE_CONFIGURATION_IDS } from "~/lib/playground/sample/configurations.js";
import { NEW_CONFIGURATION_PIN } from "~/lib/playground/sample/types.js";
import { STAGED_EDIT_KEY, readStagedEdit } from "~/lib/playground/staged-edit.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { SAMPLE_ORGANIZATION_ID } from "~/lib/workspace-reads.js";
import { spyOnTheClient } from "~/test/api-client-spies.js";
import { matchMediaQueries } from "~/test/intersection-observer.js";
import { installReactFlowMocks } from "~/test/react-flow-jsdom.js";
import PublicEditorPage, {
  PUBLIC_EDITOR_CONFIGURATION_ID,
  PUBLIC_EDITOR_EXAMPLE_NAME,
  PUBLIC_EDITOR_EXAMPLE_YAML,
  PUBLIC_EDITOR_VERSION_ID,
} from "./public-editor.js";

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderEditor() {
  const Stub = createRoutesStub([
    { path: "/public-editor", Component: PublicEditorPage },
    { path: "/app", Component: Where },
    { path: "/", Component: Where },
  ]);
  return render(<Stub initialEntries={["/public-editor"]} />);
}

async function welcome() {
  return screen.findByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE });
}

let restoreReactFlow: () => void;
beforeAll(() => {
  restoreReactFlow = installReactFlowMocks();
});
afterAll(() => restoreReactFlow());

let spies: ReturnType<typeof spyOnTheClient>;
let validate: MockInstance<typeof apiClient.validateAnonymously>;
let startTour: MockInstance<typeof tour.startEditorTour>;

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  useEditorStore.getState().reset();
  spies = spyOnTheClient();
  validate = vi
    .spyOn(apiClient, "validateAnonymously")
    .mockImplementation(async (request) => ({ valid: true, collectorVersion: request.collectorVersion ?? NEW_CONFIGURATION_PIN, errors: [] }));
  startTour = vi.spyOn(tour, "startEditorTour").mockImplementation(() => () => undefined);
});

afterEach(() => {
  // The anonymous validate is the only request the page makes.
  for (const spy of spies) if ((spy as unknown) !== validate) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
  useUserStore.getState().clear();
  document.body.className = "";
});

describe("the blank public editor", () => {
  // The Welcome dialog done (its own tests below): it would hide the page from the accessibility tree.
  beforeEach(() => {
    window.localStorage.setItem(PUBLIC_EDITOR_WELCOME_DONE_KEY, "true");
  });

  it("opens a configuration and draft of its own under the sample's organization: the name as text, the pin fixed, no Testing tab", async () => {
    renderEditor();
    expect(await screen.findByRole("heading", { level: 1, name: "Untitled configuration" })).toBeInTheDocument();
    const editor = useEditorStore.getState();
    expect(editor.organizationId).toBe(SAMPLE_ORGANIZATION_ID);
    expect(editor.configuration?.id).toBe(PUBLIC_EDITOR_CONFIGURATION_ID);
    expect(editor.version?.id).toBe(PUBLIC_EDITOR_VERSION_ID);
    expect(Object.values(SAMPLE_CONFIGURATION_IDS)).not.toContain(PUBLIC_EDITOR_CONFIGURATION_ID);
    expect(editor.configuration?.collectorDistribution).toBe("otelcol-contrib");
    expect(editor.collectorVersion).toBe(NEW_CONFIGURATION_PIN);
    expect(editor.version?.publishedAt).toBeNull();
    expect(editor.text).toBe("");
    expect(screen.queryByRole("button", { name: "Rename configuration" })).toBeNull();
    expect(screen.getByRole("combobox", { name: `Collector version v${NEW_CONFIGURATION_PIN}` })).toBeInTheDocument();
    // No canvas pill: only the playground editor has one.
    expect(screen.queryByText("Build and validate freely — Save to keep your work.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Create a free account" })).toBeNull();
    for (const tab of ["Configuration", "YAML"]) expect(screen.getAllByRole("tab", { name: tab }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab", { name: "Testing" })).toBeNull();
    // No playground shell; masked as the signed-in shell.
    expect(screen.queryByText("You're in the playground")).toBeNull();
    expect(document.body).toHaveClass("tf-app", "ph-mask");
  });

  it("checks a typed text with the anonymous validate", async () => {
    renderEditor();
    await screen.findByRole("heading", { level: 1, name: "Untitled configuration" });
    // An empty text isn't checked; a typed one is, after the pause.
    act(() => useEditorStore.getState().setText(PUBLIC_EDITOR_EXAMPLE_YAML));
    await waitFor(() => expect(validate).toHaveBeenCalled());
    const [request] = validate.mock.calls[0]!;
    expect(request).toMatchObject({ distribution: "otelcol-contrib", collectorVersion: NEW_CONFIGURATION_PIN });
    expect(request.yaml === PUBLIC_EDITOR_EXAMPLE_YAML).toBe(true);
  });

  it("locks a pick of another collector version, as the playground's", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("heading", { level: 1, name: "Untitled configuration" });
    await user.click(screen.getByRole("combobox", { name: `Collector version v${NEW_CONFIGURATION_PIN}` }));
    await user.click(await screen.findByRole("option", { name: /v0\.161\.0/ }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).getByText(signupPromptText("validate against a different collector version"))).toBeInTheDocument();
    expect(useEditorStore.getState().collectorVersion).toBe(NEW_CONFIGURATION_PIN);
  });

  it("Save stages the edit and opens Sign in to save; so does Cmd/Ctrl+S", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("heading", { level: 1, name: "Untitled configuration" });

    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog", { name: SIGN_IN_TO_SAVE_TITLE });
    const staged = readStagedEdit();
    expect(staged?.edit.name).toBe("Untitled configuration");
    expect(staged?.edit.collectorVersion).toBe(NEW_CONFIGURATION_PIN);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());

    window.localStorage.removeItem(STAGED_EDIT_KEY);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(await screen.findByRole("alertdialog", { name: SIGN_IN_TO_SAVE_TITLE })).toBeInTheDocument();
    expect(window.localStorage.getItem(STAGED_EDIT_KEY) !== null).toBe(true);
  });

  it("a signed-in visitor's Save stages the edit and goes to /app", async () => {
    const { signedInMember } = await import("~/test/configurations.js");
    useUserStore.getState().setCurrent(signedInMember());
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("heading", { level: 1, name: "Untitled configuration" });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("where")).toHaveTextContent(/^\/app$/);
    expect(window.localStorage.getItem(STAGED_EDIT_KEY) !== null).toBe(true);
  });

  it("locks Publish: the sign-up prompt with its words", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("heading", { level: 1, name: "Untitled configuration" });
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const prompt = await screen.findByRole("dialog", { name: SIGNUP_PROMPT_TITLE });
    expect(within(prompt).getByText(signupPromptText(PUBLISH_LOCKED_ACTION))).toBeInTheDocument();
  });

  it("guards nothing on leaving, and forgets what was open", async () => {
    const listening = vi.spyOn(window, "addEventListener");
    const view = renderEditor();
    await screen.findByRole("heading", { level: 1, name: "Untitled configuration" });
    expect(listening.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
    view.unmount();
    expect(useEditorStore.getState().configuration).toBeNull();
    expect(useEditorStore.getState().organizationId).toBeNull();
  });
});

describe("the Welcome dialog", () => {
  it("shows on a first visit; Use a Template opens the example on Contrib 0.162.0, and the tour without its version-history step", async () => {
    const user = userEvent.setup();
    renderEditor();
    await welcome();
    expect(startTour).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: START_EXAMPLE_LABEL }));
    expect(await screen.findByRole("heading", { level: 1, name: PUBLIC_EDITOR_EXAMPLE_NAME })).toBeInTheDocument();
    const editor = useEditorStore.getState();
    expect(editor.text === PUBLIC_EDITOR_EXAMPLE_YAML).toBe(true);
    expect(editor.graphStatus).toBe("ready");
    expect(editor.graph.nodes.length).toBeGreaterThan(0);
    expect(editor.configuration?.id).toBe(PUBLIC_EDITOR_CONFIGURATION_ID);
    expect(editor.organizationId).toBe(SAMPLE_ORGANIZATION_ID);
    expect(editor.collectorVersion).toBe(NEW_CONFIGURATION_PIN);
    expect(startTour.mock.calls).toEqual([[{ versionHistory: false }]]);
    expect(window.localStorage.getItem(PUBLIC_EDITOR_WELCOME_DONE_KEY)).toBe("true");
    // The example's text is checked as any other.
    await waitFor(() => expect(validate.mock.calls.some(([request]) => request.yaml === PUBLIC_EDITOR_EXAMPLE_YAML)).toBe(true));
  });

  it("Start from Scratch with Skip tour: the blank configuration, no tour", async () => {
    const user = userEvent.setup();
    renderEditor();
    await welcome();
    await user.click(screen.getByRole("checkbox", { name: SKIP_TOUR_LABEL }));
    await user.click(screen.getByRole("button", { name: START_BLANK_LABEL }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE })).toBeNull());
    expect(useEditorStore.getState().text).toBe("");
    expect(screen.getByRole("heading", { level: 1, name: "Untitled configuration" })).toBeInTheDocument();
    expect(startTour).not.toHaveBeenCalled();
  });

  it("isn't shown once done: the blank configuration opens", async () => {
    window.localStorage.setItem(PUBLIC_EDITOR_WELCOME_DONE_KEY, "true");
    renderEditor();
    await screen.findByRole("heading", { level: 1, name: "Untitled configuration" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog", { name: PUBLIC_EDITOR_WELCOME_TITLE })).toBeNull();
    expect(startTour).not.toHaveBeenCalled();
  });

  it("the example's only host is on acme.example", () => {
    const hosts = [...PUBLIC_EDITOR_EXAMPLE_YAML.matchAll(/endpoint: ([^\s:]+):\d+/g)].map((match) => match[1]);
    expect(hosts.filter((host) => host !== "0.0.0.0")).toEqual(["otelcol.acme.example"]);
  });
});

describe("on a phone", () => {
  it("shows the phone page, its link to sign-in: no editor, no Welcome dialog, nothing validated", async () => {
    const original = window.matchMedia;
    window.matchMedia = matchMediaQueries(["(max-width: 767px)"]);
    try {
      renderEditor();
      expect(await screen.findByText(PHONE_PAGE_TEXT)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
      expect(fake.mounted).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(useEditorStore.getState().configuration).toBeNull();
    } finally {
      window.matchMedia = original;
    }
    expect(validate).not.toHaveBeenCalled();
  });
});
