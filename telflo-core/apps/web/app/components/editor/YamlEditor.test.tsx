/**
 * The YAML tab.
 *
 * Monaco is stubbed: the real editor needs a canvas and workers jsdom doesn't
 * provide. The stub calls `beforeMount` and `onMount` with a fake Monaco that
 * records the command registered and lets a test set the markers, and renders
 * the text as text, as Monaco does. Its model holds the text; an edit written
 * into it fires `onChange`, as Monaco's does, and the stub records the calls
 * that make a store-set text its own undo step (Preflight ruling 16). The
 * browser tests and the hand check cover the real Monaco (builder.e2e.ts
 * shows a canvas change doesn't enter manual edit mode there).
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorProps } from "@monaco-editor/react";

const MODEL_URI = { toString: () => "inmemory://model/1" };
const ERROR = 8;
const WARNING = 4;
const VIEW_STATE = { cursor: "line 2" };

const fake = vi.hoisted(() => ({
  props: null as EditorProps | null,
  markers: [] as { severity: number }[],
  markerListeners: [] as (() => void)[],
  disposed: 0,
  commands: [] as { keybinding: number; handler: () => void }[],
  mounted: false,
  initMonaco: (() => Promise.resolve()) as () => Promise<void>,
  /** The text Monaco's model holds. */
  value: "",
  /** The model and editor calls a store-set text makes, in order. */
  calls: [] as string[],
  /** How many times the model's text was read. */
  reads: 0,
  /** Monaco's own undo stack: the text before each edit, typed or written. */
  undo: [] as string[],
  /** The cursor moves a status bar row made: setPosition, revealLineInCenter, focus. */
  jumps: [] as string[],
  /** Each schema path the tab gave setMonacoSchema, in order. */
  schemaPaths: [] as (string | null)[],
  /** How many times the stubbed Monaco mounted. */
  mounts: 0,
}));

const monaco = {
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { KeyS: 49 },
  MarkerSeverity: { Error: ERROR, Warning: WARNING },
  editor: {
    defineTheme: vi.fn(),
    onDidChangeMarkers: (listener: () => void) => {
      fake.markerListeners.push(listener);
      return { dispose: () => (fake.disposed += 1) };
    },
    getModelMarkers: ({ resource }: { resource: unknown }) => (resource === MODEL_URI ? fake.markers : []),
  },
};

const model = {
  uri: MODEL_URI,
  // The options set on the model, as Monaco's keeps them (the tab size, D21 Preflight ruling 33).
  options: { tabSize: 2, indentSize: 2 } as Record<string, unknown>,
  getOptions: () => model.options,
  updateOptions: (next: Record<string, unknown>) => {
    model.options = { ...model.options, ...next };
  },
  getValue: () => {
    fake.reads += 1;
    return fake.value;
  },
  getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 1 }),
  pushStackElement: () => {
    fake.calls.push("pushStackElement");
  },
  // Monaco's setValue: the text afresh, its undo history gone, and its change event.
  setValue: (value: string) => {
    fake.calls.push("setValue");
    fake.undo = [];
    fake.value = value;
    fake.props?.onChange?.(fake.value, {} as never);
  },
};

const editor = {
  getModel: () => model,
  addCommand: (keybinding: number, handler: () => void) => {
    fake.commands.push({ keybinding, handler });
    return null;
  },
  // An edit fires Monaco's change event, as the real one does.
  executeEdits: (source: string, edits: { text: string }[]) => {
    fake.calls.push(`executeEdits ${source}`);
    fake.undo.push(fake.value);
    fake.value = edits[0]!.text;
    fake.props?.onChange?.(fake.value, {} as never);
    return true;
  },
  saveViewState: () => {
    fake.calls.push("saveViewState");
    return VIEW_STATE;
  },
  restoreViewState: (state: unknown) => {
    fake.calls.push(state === VIEW_STATE ? "restoreViewState" : "restoreViewState (another)");
  },
  setPosition: (position: { lineNumber: number; column: number }) => {
    fake.jumps.push(`setPosition ${position.lineNumber}:${position.column}`);
  },
  revealLineInCenter: (lineNumber: number) => {
    fake.jumps.push(`revealLineInCenter ${lineNumber}`);
  },
  focus: () => {
    fake.jumps.push("focus");
  },
  // The editor preferences let go of the editor when it is disposed (use-editor-preferences.ts).
  onDidDispose: () => ({ dispose: () => undefined }),
  // Cmd/Ctrl+Z in Monaco: its own undo, whose change event is typing to the page.
  trigger: (_source: string, handlerId: string) => {
    if (handlerId !== "undo") return;
    const before = fake.undo.pop();
    if (before === undefined) return;
    fake.value = before;
    fake.props?.onChange?.(fake.value, {} as never);
  },
};

vi.mock("@monaco-editor/react", () => ({
  default: function MonacoStub(props: EditorProps) {
    fake.props = props;
    useEffect(() => {
      fake.value = props.value ?? "";
      props.beforeMount?.(monaco as never);
      props.onMount?.(editor as never, monaco as never);
      fake.mounted = true;
      fake.mounts += 1;
      // Once, as Monaco mounts once.
    }, []);
    return <div data-testid="monaco-stub">{props.value}</div>;
  },
}));
vi.mock("~/lib/editor/monaco-setup.js", () => ({
  initMonaco: () => fake.initMonaco(),
  setMonacoSchema: (path: string | null) => {
    fake.schemaPaths.push(path);
  },
}));

import { YamlEditor } from "./YamlEditor.js";
import { answerValidation, REFUSAL } from "~/test/validation.js";
import * as download from "~/lib/download.js";
import { selectIsDirty, summaryOf, useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, PUBLISHED_FIELDS, versionFixture } from "~/test/configurations.js";
import { monacoAriaHost } from "~/lib/editor/use-aria-container.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { DEFAULT_USER_PREFERENCES, type EditorPreferences, type Theme } from "@telflo/contracts";
import { signedInMember } from "~/test/configurations.js";

/** The user store holding the person with `theme` and `editor` (Settings' choices). */
function choose(theme: Theme, editor: Partial<EditorPreferences> = {}) {
  const member = signedInMember();
  useUserStore.getState().setCurrent({
    ...member,
    preferences: { ...member.preferences, theme, editor: { ...DEFAULT_USER_PREFERENCES.editor, ...editor } },
  });
}

const YAML = "receivers:\n  otlp:\n";

const VERSION = versionFixture({ yamlContent: YAML });

const initialState = useEditorStore.getState();

function loadYaml(yaml: string) {
  useEditorStore.getState().load({
    organizationId: GROUP_ID,
    configuration: MINE,
    version: { ...VERSION, yamlContent: yaml },
  });
}

/**
 * Renders the tab and waits for the stubbed Monaco to mount: its
 * `beforeMount` and `onMount` run in an effect, which can come after the
 * stub's element appears when the machine is busy.
 */
async function renderEditor(onSave: () => void = vi.fn()) {
  const view = render(<YamlEditor onSave={onSave} />);
  await screen.findByTestId("monaco-stub");
  await waitFor(() => expect(fake.mounted).toBe(true));
  return { ...view, user: userEvent.setup() };
}

/** The collector validator found the text on screen valid (D13b decision 2's gate then opens). */
function answerValid() {
  act(() => answerValidation({ status: "valid", collectorVersion: "0.162.0", requirements: [] }));
}

/** Typing in Monaco: its model holds the new text, and its onChange says so. */
function typeInMonaco(text: string) {
  act(() => {
    fake.undo.push(fake.value);
    fake.value = text;
    fake.props?.onChange?.(text, {} as never);
  });
}

function setMarkers(markers: { severity: number }[]) {
  fake.markers = markers;
  act(() => fake.markerListeners.forEach((listener) => listener()));
}

beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState(initialState, true);
  loadYaml(YAML);
  fake.props = null;
  fake.markers = [];
  fake.markerListeners = [];
  fake.disposed = 0;
  fake.commands = [];
  fake.mounted = false;
  fake.initMonaco = () => Promise.resolve();
  fake.value = "";
  model.options = { tabSize: 2, indentSize: 2 };
  useUserStore.getState().clear();
  fake.calls = [];
  fake.reads = 0;
  fake.undo = [];
  fake.jumps = [];
  fake.schemaPaths = [];
  fake.mounts = 0;
  monaco.editor.defineTheme.mockClear();
});

describe("YamlEditor", () => {
  it("has its header: the YAML label, then Copy and Download side by side", async () => {
    await renderEditor();

    expect(screen.getByText("YAML")).toHaveClass("tf-label");
    const copy = screen.getByRole("button", { name: "Copy YAML to clipboard" });
    const downloadButton = screen.getByRole("button", { name: "Download YAML configuration" });
    expect(copy).toHaveAttribute("title", "Copy YAML to clipboard");
    expect(downloadButton).toHaveAttribute("title", "Download YAML configuration");
    expect(copy.nextElementSibling).toBe(downloadButton);
    // Apply and Undo All only in manual edit mode.
    expect(screen.queryByRole("button", { name: /apply|undo/i })).not.toBeInTheDocument();
  });

  it("says Loading editor… and mounts no editor until Monaco is initialized", async () => {
    let finish!: () => void;
    fake.initMonaco = () => new Promise<void>((resolve) => (finish = resolve));
    render(<YamlEditor onSave={vi.fn()} />);

    expect(screen.getByText("Loading editor…")).toBeInTheDocument();
    // A mount before loader.config would fetch Monaco from a CDN (Preflight ruling 16).
    expect(screen.queryByTestId("monaco-stub")).not.toBeInTheDocument();
    expect(fake.props).toBeNull();

    await act(async () => finish());

    expect(await screen.findByTestId("monaco-stub")).toBeInTheDocument();
    expect(screen.queryByText("Loading editor…")).not.toBeInTheDocument();
  });

  it("says the editor couldn't load when Monaco fails, and Try again loads it, with the store's text untouched", async () => {
    const edited = `${YAML}# typed before the tab mounted again\n`;
    act(() => useEditorStore.getState().setText(edited));
    const attempts: (() => Promise<void>)[] = [
      () => Promise.reject(new Error("Failed to fetch dynamically imported module")),
      () => Promise.resolve(),
    ];
    const initMonaco = vi.fn(() => attempts.shift()!());
    fake.initMonaco = initMonaco;
    const user = userEvent.setup();
    render(<YamlEditor onSave={vi.fn()} />);

    expect(await screen.findByText("The editor couldn't load.")).toBeInTheDocument();
    expect(screen.queryByText("Loading editor…")).not.toBeInTheDocument();
    expect(screen.queryByTestId("monaco-stub")).not.toBeInTheDocument();
    expect(useEditorStore.getState().text).toBe(edited);
    // Copy and Download still work from the store's text.
    expect(screen.getByRole("button", { name: "Copy YAML to clipboard" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("monaco-stub")).toHaveTextContent("typed before the tab mounted again");
    expect(initMonaco).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("The editor couldn't load.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    const state = useEditorStore.getState();
    expect(state.text).toBe(edited);
    expect(state.savedText).toBe(YAML);
  });

  it("says Loading editor… again while Try again loads", async () => {
    let finish!: () => void;
    const attempts: (() => Promise<void>)[] = [
      () => Promise.reject(new Error("offline")),
      () => new Promise<void>((resolve) => (finish = resolve)),
    ];
    fake.initMonaco = () => attempts.shift()!();
    const user = userEvent.setup();
    render(<YamlEditor onSave={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(screen.getByText("Loading editor…")).toBeInTheDocument();
    expect(screen.queryByText("The editor couldn't load.")).not.toBeInTheDocument();
    await act(async () => finish());
    expect(await screen.findByTestId("monaco-stub")).toBeInTheDocument();
  });

  it("gives Monaco the store's text, YAML, and contracts' default theme and preferences before the user store is seeded", async () => {
    // A model that starts elsewhere (8), so the default's 2 is the preference's doing, not the fake's.
    model.options = { tabSize: 8, indentSize: 8 };
    await renderEditor();

    expect(fake.props).toMatchObject({
      value: YAML,
      defaultLanguage: "yaml",
      theme: "telflo-dark",
      height: "100%",
      options: {
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontLigatures: false,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        scrollbar: { vertical: "visible", horizontal: "visible" },
      },
    });
    // The tab size goes on the model, never through the options (Preflight ruling 30).
    expect(fake.props?.options).not.toHaveProperty("tabSize");
    expect(model.options).toMatchObject({ tabSize: 2, indentSize: 2 });
    for (const name of ["telflo-dark", "telflo-navy"]) {
      expect(monaco.editor.defineTheme).toHaveBeenCalledWith(name, expect.objectContaining({ base: "vs-dark", inherit: true }));
    }
    // Light is Monaco's built-in `vs` (Q128): nothing is defined for it.
    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(2);
  });

  it("takes the theme and all four preferences from the store (D21 decisions 27 and 28)", async () => {
    choose("navy", { tabSize: 4, fontSize: 16, lineNumbers: false, minimap: true });
    await renderEditor();

    expect(fake.props?.theme).toBe("telflo-navy");
    expect(fake.props?.options).toMatchObject({ fontSize: 16, lineNumbers: "off", minimap: { enabled: true } });
    expect(model.options).toMatchObject({ tabSize: 4, indentSize: 4 });
  });

  it("a change of the store's preferences reaches the open editor, the model's tab size included", async () => {
    choose("dark");
    await renderEditor();
    expect(fake.mounts).toBe(1);

    act(() => choose("light", { tabSize: 4, fontSize: 18, lineNumbers: false, minimap: true }));

    expect(fake.props?.theme).toBe("vs");
    expect(fake.props?.options).toMatchObject({ fontSize: 18, lineNumbers: "off", minimap: { enabled: true } });
    expect(model.options).toMatchObject({ tabSize: 4, indentSize: 4 });
    // The same editor, not a new one.
    expect(fake.mounts).toBe(1);

    act(() => choose("light", { tabSize: 2 }));
    expect(model.options).toMatchObject({ tabSize: 2, indentSize: 2 });
  });

  it("is React Flow's nokey, so the canvas's keys (Space, its pan key) stand aside inside it", async () => {
    await renderEditor();

    expect(screen.getByTestId("monaco-stub").closest(".nokey")).not.toBeNull();
    expect(screen.getByText("YAML").closest(".nokey")).not.toBeNull();
  });

  it("is blocked from session replay: ph-no-capture on Monaco's container, its widgets and live region inside it, word-based suggestions off (ADR 0024)", async () => {
    await renderEditor();

    // posthog-js's default replay blockClass; initOptions doesn't change it.
    const blocked = screen.getByTestId("monaco-stub").closest(".ph-no-capture");
    expect(blocked).not.toBeNull();
    // Only the editor is blocked: the header and its buttons stay recorded.
    expect(screen.getByText("YAML").closest(".ph-no-capture")).toBeNull();
    const options = fake.props?.options as {
      wordBasedSuggestions?: string;
      ariaContainerElement?: HTMLElement;
      overflowWidgetsDomNode?: HTMLElement;
    };
    // Completion's rows and details, and hover, carry the schema's keys and
    // descriptions in attributes (D13c decision 12): Monaco renders them in
    // its own element, inside the container, unless given another node for
    // them. jsdom can't render them; the browser tests find them there.
    expect(options.overflowWidgetsDomNode === undefined || blocked!.contains(options.overflowWidgetsDomNode)).toBe(true);
    // Monaco would offer the configuration's words as suggestions, each word in a row's aria-label.
    expect(options.wordBasedSuggestions).toBe("off");
    // Monaco's screen-reader live region goes where it is given, not <body>:
    // the shell's one replay-blocked host, shared by every Monaco (Ruling 48).
    expect(options.ariaContainerElement).toBeInstanceOf(HTMLElement);
    expect(options.ariaContainerElement).toBe(monacoAriaHost());
    expect(options.ariaContainerElement!.closest(".ph-no-capture")).not.toBeNull();
    // Monaco deep-clones its options: an element React rendered (its own fiber properties) would loop.
    expect(Object.keys(options.ariaContainerElement!)).toEqual([]);
  });

  it("sets no path or defaultPath, which Monaco would write into a data-uri attribute (Preflight ruling 16)", async () => {
    await renderEditor();

    expect(fake.props).not.toHaveProperty("path");
    expect(fake.props).not.toHaveProperty("defaultPath");
  });

  it("typing writes the store's text, and makes it dirty", async () => {
    await renderEditor();

    typeInMonaco(`${YAML}exporters:\n`);

    expect(useEditorStore.getState().text).toBe(`${YAML}exporters:\n`);
    expect(useEditorStore.getState().savedText).toBe(YAML);
  });

  it("registers Cmd/Ctrl+S inside Monaco, which calls the latest onSave", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = await renderEditor(first);

    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]?.keybinding).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS);

    rerender(<YamlEditor onSave={latest} />);
    fake.commands[0]?.handler();

    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("shows the alert with the error count, and removes it when the markers clear", async () => {
    await renderEditor();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    setMarkers([{ severity: ERROR }]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("YAML Validation Error");
    expect(alert).toHaveTextContent("1 validation error");
    expect(alert).not.toHaveTextContent("1 validation errors");

    setMarkers([{ severity: ERROR }, { severity: WARNING }, { severity: ERROR }]);
    expect(screen.getByRole("alert")).toHaveTextContent("2 validation errors");

    setMarkers([{ severity: WARNING }]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    setMarkers([{ severity: ERROR }]);
    setMarkers([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stops listening to markers when it unmounts", async () => {
    const { unmount } = await renderEditor();

    unmount();

    expect(fake.disposed).toBe(1);
  });

  it("copies the store's text and toasts", async () => {
    const { user } = await renderEditor();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const success = vi.spyOn(toast, "success");
    act(() => useEditorStore.getState().setText(`${YAML}exporters:\n`));

    await user.click(screen.getByRole("button", { name: "Copy YAML to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(`${YAML}exporters:\n`);
    expect(success).toHaveBeenCalledWith("Configuration copied to clipboard");
  });

  it("toasts the failure when the clipboard is refused", async () => {
    const { user } = await renderEditor();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");

    await user.click(screen.getByRole("button", { name: "Copy YAML to clipboard" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to copy to clipboard"));
    expect(success).not.toHaveBeenCalled();
  });

  it("downloads the store's text as config.yaml, text/yaml, and toasts", async () => {
    const { user } = await renderEditor();
    const downloadTextFile = vi.spyOn(download, "downloadTextFile").mockImplementation(() => {});
    const success = vi.spyOn(toast, "success");
    act(() => useEditorStore.getState().setText(`${YAML}exporters:\n`));

    await user.click(screen.getByRole("button", { name: "Download YAML configuration" }));

    expect(downloadTextFile).toHaveBeenCalledWith(`${YAML}exporters:\n`, "config.yaml", "text/yaml");
    expect(success).toHaveBeenCalledWith("Configuration downloaded");
  });

  it("downloads through the browser a config.yaml blob of type text/yaml", async () => {
    const { user } = await renderEditor();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:stub");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });

    await user.click(screen.getByRole("button", { name: "Download YAML configuration" }));

    expect(downloads).toEqual(["config.yaml"]);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("text/yaml");
  });

  describe("manual edit mode (D9a decision 2)", () => {
    const TYPED = `${YAML}exporters:\n  debug: {}\nservice:\n  pipelines:\n    traces:\n      receivers: [otlp]\n      exporters: [debug]\n`;

    function applyButton() {
      return screen.getByRole("button", { name: "Apply" });
    }

    it("typing enters it once, with its toast, and shows Undo All and Apply with their titles", async () => {
      const { user } = await renderEditor();
      const info = vi.spyOn(toast, "info");

      typeInMonaco(`${YAML}# one\n`);
      typeInMonaco(`${YAML}# one\n# two\n`);

      expect(info).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith("Entered manual edit mode");
      const state = useEditorStore.getState();
      expect(state.isYamlEditing).toBe(true);
      expect(state.preEditText).toBe(YAML);
      expect(state.text).toBe(`${YAML}# one\n# two\n`);

      const undoAll = screen.getByRole("button", { name: "Undo All" });
      expect(undoAll).toHaveAttribute("title", "Undo all changes and exit manual mode");
      answerValid();
      expect(applyButton()).toBeEnabled();
      // Undo All, Apply, then Copy and Download, in the header.
      expect(undoAll.nextElementSibling).toContainElement(applyButton());
      expect(undoAll.nextElementSibling?.nextElementSibling).toBe(
        screen.getByRole("button", { name: "Copy YAML to clipboard" }),
      );

      await user.hover(applyButton());
      expect((await screen.findAllByText("Apply Changes and Exit Manual Mode")).length).toBeGreaterThan(0);
    });

    it("Apply puts the typed text on the canvas, takes one undo entry, and leaves the mode", async () => {
      const { user } = await renderEditor();
      const success = vi.spyOn(toast, "success");
      typeInMonaco(TYPED);
      answerValid();

      await user.click(applyButton());

      const state = useEditorStore.getState();
      expect(state.isYamlEditing).toBe(false);
      expect(state.text).toBe(TYPED);
      expect(state.graph.nodes.some((node) => node.data.label === "Debug")).toBe(true);
      expect(state.history.past.at(-1)).toMatchObject({ text: YAML, description: "Edit YAML" });
      expect(success).toHaveBeenCalledWith("Changes applied");
      expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Undo All" })).not.toBeInTheDocument();
      // Monaco already held the typed text: nothing is written into it.
      expect(fake.calls).toEqual([]);
    });

    it("Undo All puts back the text from before the typing, in Monaco too, and leaves the mode", async () => {
      const { user } = await renderEditor();
      const info = vi.spyOn(toast, "info");
      typeInMonaco(TYPED);

      await user.click(screen.getByRole("button", { name: "Undo All" }));

      const state = useEditorStore.getState();
      expect(state.isYamlEditing).toBe(false);
      expect(state.text).toBe(YAML);
      expect(fake.value).toBe(YAML);
      expect(info).toHaveBeenLastCalledWith("Changes reverted");
      expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
      expect(state.history.past).toEqual([]);
    });

    it("Apply is disabled while Monaco marks an error, and the alert says so", async () => {
      await renderEditor();
      typeInMonaco(`${YAML}key: nested: value\n`);

      setMarkers([{ severity: ERROR }]);

      expect(applyButton()).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("1 validation error");

      setMarkers([]);
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Nested mappings are not allowed"));
      expect(applyButton()).toBeDisabled();
    });

    it("Apply is disabled while the typed text can't be read, with the reason as text and in no attribute", async () => {
      const marker = "marker-4b1f";
      const { container } = await renderEditor();
      typeInMonaco(`receivers:\n  otlp: *${marker}\n`);
      // Nothing to check: idle, so the parse gate alone decides.
      act(() => answerValidation({ status: "idle" }));

      const alert = await screen.findByRole("alert");
      expect(applyButton()).toBeDisabled();
      expect(alert).toHaveTextContent("YAML Validation Error");
      expect(alert).toHaveTextContent(`Line 2, column 9: The alias *${marker} names no anchor set before it.`);
      const attributes = [container, ...container.querySelectorAll("*")].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.value),
      );
      expect(attributes.filter((value) => value.includes(marker))).toEqual([]);

      // Fixed (and checked): Apply is enabled again, and the alert goes.
      typeInMonaco(TYPED);
      answerValid();
      await waitFor(() => expect(applyButton()).toBeEnabled());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("an Apply the store refuses (before the typed text was read) says why, and stays in the mode", async () => {
      const { user } = await renderEditor();
      typeInMonaco("receivers: [a]\n");
      act(() => answerValidation({ status: "idle" }));

      // At once: the read waits for typing to pause.
      await user.click(applyButton());

      expect(screen.getByRole("alert")).toHaveTextContent("Line 1, column 12: receivers must be a mapping.");
      expect(useEditorStore.getState().isYamlEditing).toBe(true);
      expect(applyButton()).toBeDisabled();
    });
  });

  describe("the collector schema (D13c decisions 2, 3 and 11)", () => {
    const TYPED = `${YAML}exporters:\n  debug: {}\n`;

    function applyButton() {
      return screen.getByRole("button", { name: "Apply" });
    }

    it("gives setMonacoSchema the pin's schema before Monaco loads, so monaco-yaml is configured for it at once", async () => {
      const order: string[] = [];
      fake.initMonaco = () => {
        order.push(`initMonaco after ${JSON.stringify(fake.schemaPaths)}`);
        return Promise.resolve();
      };

      await renderEditor();

      expect(fake.schemaPaths).toEqual(["/schemas/otelcol-contrib/v0.162.0.json"]);
      expect(order).toEqual(['initMonaco after ["/schemas/otelcol-contrib/v0.162.0.json"]']);
    });

    it("switches the schema when the pin changes, an unsaved pick included, without mounting Monaco again", async () => {
      await renderEditor();

      act(() => useEditorStore.getState().setCollectorVersion("0.161.0"));
      // A retired pin: syntax only (decision 2).
      act(() => useEditorStore.getState().setCollectorVersion("0.158.0"));
      act(() => useEditorStore.getState().setCollectorVersion("0.162.0"));

      expect(fake.schemaPaths).toEqual([
        "/schemas/otelcol-contrib/v0.162.0.json",
        "/schemas/otelcol-contrib/v0.161.0.json",
        null,
        "/schemas/otelcol-contrib/v0.162.0.json",
      ]);
      expect(fake.mounts).toBe(1);
      // A store change that leaves the pin alone asks for nothing.
      typeInMonaco(TYPED);
      expect(fake.schemaPaths).toHaveLength(4);
    });

    it("gives syntax only to a distribution without schemas", async () => {
      useEditorStore.getState().load({
        organizationId: GROUP_ID,
        configuration: { ...MINE, collectorDistribution: "grafana-alloy" },
        version: versionFixture({ yamlContent: YAML, collectorVersion: "1.0.0" }),
      });

      await renderEditor();

      expect(fake.schemaPaths).toEqual([null]);
    });

    it("a schema's Warning markers leave Apply enabled, with no alert and the status bar unchanged; a syntax Error still disables Apply and shows the alert", async () => {
      await renderEditor();
      typeInMonaco(TYPED);
      answerValid();
      const bar = screen.getByText("config valid · v0.162.0");

      // An unknown key and an unknown type: the schema's findings are Warnings (severity 4).
      setMarkers([{ severity: WARNING }, { severity: WARNING }]);

      expect(applyButton()).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("YAML Validation Error")).not.toBeInTheDocument();
      expect(bar).toBeInTheDocument();
      expect(bar).toHaveTextContent("config valid · v0.162.0");

      // A syntax error beside them: an Error (severity 8), counted alone.
      setMarkers([{ severity: WARNING }, { severity: ERROR }, { severity: WARNING }]);

      expect(applyButton()).toBeDisabled();
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("YAML Validation Error");
      expect(alert).toHaveTextContent("1 validation error");
      expect(alert).not.toHaveTextContent("validation errors");

      setMarkers([{ severity: WARNING }]);
      expect(applyButton()).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("the collector validator (D13b decisions 2, 3 and 14)", () => {
    const TYPED = `${YAML}exporters:\n  debug: {}\n`;

    function applyButton() {
      return screen.getByRole("button", { name: "Apply" });
    }

    /** Apply's tooltip, as hovering its trigger shows it. */
    async function tooltipOf(user: ReturnType<typeof userEvent.setup>, text: string) {
      const trigger = applyButton().parentElement!;
      await user.unhover(trigger);
      await user.hover(trigger);
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    }

    it("Apply's gate and its four tooltips, first match wins: validating, errors, unchecked (unavailable or retired), else D9a's", async () => {
      const { user } = await renderEditor();
      typeInMonaco(TYPED);

      // Due to be checked: disabled.
      expect(applyButton()).toBeDisabled();
      await tooltipOf(user, "Validating...");

      act(() => answerValidation({ status: "invalid", collectorVersion: "0.162.0", errors: [REFUSAL], requirements: [] }));
      expect(applyButton()).toBeDisabled();
      await tooltipOf(user, "Validation Errors Exist");

      act(() => answerValidation({ status: "unavailable", message: "Validation is unavailable. Your YAML was not checked — retry shortly." }));
      expect(applyButton()).toBeEnabled();
      await tooltipOf(user, "Validation unavailable — applying unchecked YAML");

      act(() => answerValidation({ status: "retired", collectorVersion: "0.155.0" }));
      expect(applyButton()).toBeEnabled();
      await tooltipOf(user, "Validation unavailable — applying unchecked YAML");

      act(() => answerValidation({ status: "valid", collectorVersion: "0.162.0", requirements: [] }));
      expect(applyButton()).toBeEnabled();
      await tooltipOf(user, "Apply Changes and Exit Manual Mode");
    });

    it("Apply follows the answer for exactly the text on screen: one for the text before doesn't open it", async () => {
      await renderEditor();
      typeInMonaco(TYPED);
      answerValid();
      expect(applyButton()).toBeEnabled();

      typeInMonaco(`${TYPED}# more\n`);
      expect(applyButton()).toBeDisabled();
    });

    it("Apply waits for the parse as well: a valid answer never opens it over text Monaco marks", async () => {
      await renderEditor();
      typeInMonaco(TYPED);
      answerValid();
      setMarkers([{ severity: ERROR }]);
      expect(applyButton()).toBeDisabled();
    });

    it("empty text is never checked: Apply follows the parse alone, with D9a's tooltip, and the bar shows nothing", async () => {
      const { user } = await renderEditor();
      typeInMonaco("");

      expect(applyButton()).toBeEnabled();
      await tooltipOf(user, "Apply Changes and Exit Manual Mode");
      expect(screen.queryByText("validating config…")).toBeNull();
    });

    it("puts the status bar under the editor, inside its replay-blocked container (ADR 0024)", async () => {
      await renderEditor();
      typeInMonaco(TYPED);

      const bar = screen.getByText("validating config…");
      const blocked = screen.getByTestId("monaco-stub").closest(".ph-no-capture");
      expect(blocked).not.toBeNull();
      expect(bar.closest(".ph-no-capture")).toBe(blocked);
      expect(blocked).toHaveClass("flex", "flex-col", "min-h-0");
      // After the editor, which takes the room left.
      const editorBox = screen.getByTestId("monaco-stub").parentElement!;
      expect(editorBox).toHaveClass("flex-1", "min-h-0");
      expect(editorBox.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("a row that names a component puts Monaco's cursor on its key, in the middle of the view, and focuses Monaco", async () => {
      const text = [
        "receivers:",
        "  otlp: {}",
        "exporters:",
        "  otlp/2:",
        "    endpoint: x",
        "service:",
        "  pipelines:",
        "    traces:",
        "      receivers: [otlp]",
        "      exporters: [otlp/2]",
        "",
      ].join("\n");
      loadYaml(text);
      const { user } = await renderEditor();
      act(() =>
        answerValidation({
          status: "invalid",
          collectorVersion: "0.162.0",
          errors: [
            { message: "bad endpoint", componentPath: "exporters::otlp/2" },
            { message: "no receivers", componentPath: "service::pipelines::traces" },
          ],
          requirements: [],
        }),
      );

      await user.click(screen.getByRole("button", { name: "2 errors · v0.162.0" }));
      await user.click(screen.getByRole("button", { name: "exporters::otlp/2: bad endpoint" }));
      expect(fake.jumps).toEqual(["setPosition 4:3", "revealLineInCenter 4", "focus"]);

      fake.jumps = [];
      await user.click(screen.getByRole("button", { name: "service::pipelines::traces: no receivers" }));
      expect(fake.jumps).toEqual(["setPosition 8:5", "revealLineInCenter 8", "focus"]);
    });
  });

  describe("a text the store sets (Preflight ruling 16)", () => {
    it("is written into Monaco as its own undo step, keeps the cursor and scroll, and doesn't enter manual edit mode", async () => {
      await renderEditor();
      const info = vi.spyOn(toast, "info");

      act(() => {
        expect(useEditorStore.getState().addPipeline("logs/extra")).not.toBeNull();
      });

      const state = useEditorStore.getState();
      expect(state.text).not.toBe(YAML);
      expect(state.text).toContain("logs/extra");
      expect(fake.value).toBe(state.text);
      expect(fake.calls).toEqual([
        "saveViewState",
        "pushStackElement",
        "executeEdits telflo-store",
        "pushStackElement",
        "restoreViewState",
      ]);
      expect(state.isYamlEditing).toBe(false);
      expect(info).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    });

    it("reads nothing from Monaco when a store change leaves the text alone", async () => {
      await renderEditor();
      fake.reads = 0;

      act(() => {
        useEditorStore.getState().setActiveTab("yaml");
        useEditorStore.getState().setPanelWidth(500);
      });

      expect(fake.reads).toBe(0);
      expect(fake.calls).toEqual([]);
    });

    it("typing writes nothing back into Monaco, which already holds it", async () => {
      await renderEditor();

      typeInMonaco(`${YAML}# typed\n`);

      expect(fake.calls).toEqual([]);
      expect(fake.value).toBe(`${YAML}# typed\n`);
    });

    it("a created version adopted under it clears Monaco's own undo history too, keeping the view: undo then changes nothing (D10 Ruling 22)", async () => {
      await renderEditor();
      act(() => {
        expect(useEditorStore.getState().addPipeline("logs/extra")).not.toBeNull();
      });
      const text = useEditorStore.getState().text;
      typeInMonaco(`${text}# typed\n`);
      typeInMonaco(text);
      expect(fake.undo.length).toBeGreaterThan(0);
      fake.calls = [];

      act(() =>
        useEditorStore.getState().adoptCreatedVersion(
          versionFixture({ id: "0199c000-0000-7000-8000-000000000013", versionNumber: 3, yamlContent: text }),
        ),
      );

      expect(fake.calls).toEqual(["saveViewState", "setValue", "restoreViewState"]);
      expect(fake.undo).toEqual([]);
      const adopted = useEditorStore.getState();
      expect(adopted.isYamlEditing).toBe(false);
      expect(adopted.text).toBe(text);
      expect(selectIsDirty(adopted)).toBe(false);

      act(() => editor.trigger("keyboard", "undo"));

      expect(fake.value).toBe(text);
      expect(useEditorStore.getState()).toMatchObject({ text, savedText: text, isYamlEditing: false });
      expect(useEditorStore.getState().history).toEqual({ past: [], future: [] });
      expect(selectIsDirty(useEditorStore.getState())).toBe(false);
    });

    it("stops listening to the store when it unmounts", async () => {
      const { unmount } = await renderEditor();
      unmount();

      act(() => {
        useEditorStore.getState().addPipeline("logs/extra");
      });

      expect(fake.calls).toEqual([]);
      expect(fake.value).toBe(YAML);
    });
  });

  it("puts the YAML in no attribute, even with an error shown (ADR 0024)", async () => {
    const marker = "yaml-marker-4b1f";
    loadYaml(`receivers:\n  ${marker}: {}\n`);
    const { container } = await renderEditor();
    setMarkers([{ severity: ERROR }]);

    // The stub renders the text as text, as Monaco does: the walk would
    // find nothing if it weren't on the page at all.
    expect(container).toHaveTextContent(marker);
    const attributes = [container, ...container.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes].map((attribute) => `${element.tagName} ${attribute.name}="${attribute.value}"`),
    );
    expect(attributes.length).toBeGreaterThan(0);
    expect(attributes.filter((attribute) => attribute.includes(marker))).toEqual([]);
  });

  describe("a published version: read-only (D11b decision 4; Preflight ruling 11)", () => {
    it("gives Monaco readOnly, still blocked from replay with word-based suggestions off (D9a Ruling 37)", async () => {
      useEditorStore.getState().load({ organizationId: GROUP_ID, configuration: MINE, version: { ...VERSION, ...PUBLISHED_FIELDS } });
      await renderEditor();

      const options = fake.props?.options as { readOnly?: boolean; wordBasedSuggestions?: string };
      expect(options.readOnly).toBe(true);
      expect(options.wordBasedSuggestions).toBe("off");
      expect(screen.getByTestId("monaco-stub").closest(".ph-no-capture")).not.toBeNull();
      // Copy and Download still work on it.
      expect(screen.getByRole("button", { name: "Copy YAML to clipboard" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Download YAML configuration" })).toBeEnabled();
    });

    it("gives a draft's Monaco readOnly false", async () => {
      await renderEditor();
      expect((fake.props?.options as { readOnly?: boolean }).readOnly).toBe(false);
    });

    it("becomes read-only when the open version is published under it, and typing changes nothing", async () => {
      await renderEditor();
      act(() => useEditorStore.getState().replaceVersionSummary({ ...summaryOf(VERSION), ...PUBLISHED_FIELDS }));
      expect((fake.props?.options as { readOnly?: boolean }).readOnly).toBe(true);

      typeInMonaco(`${YAML}# typed\n`);
      expect(useEditorStore.getState().text).toBe(YAML);
      expect(useEditorStore.getState().isYamlEditing).toBe(false);
    });

    it("hides Apply over text a stale tab typed before the version was published, keeping the text (ruling 12), and keeps Undo All (Ruling 31)", async () => {
      await renderEditor();
      typeInMonaco(`${YAML}# typed\n`);
      expect(screen.getByRole("button", { name: "Undo All" })).toBeInTheDocument();

      act(() => useEditorStore.getState().replaceVersionSummary({ ...summaryOf(VERSION), ...PUBLISHED_FIELDS }));

      expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Undo All" })).toBeEnabled();
      expect(screen.getByTestId("monaco-stub")).toHaveTextContent("# typed");
      expect(useEditorStore.getState().text).toBe(`${YAML}# typed\n`);
    });

    it("Undo All on a published version puts the published text back on screen and leaves manual edit mode (rulings 31 and 34)", async () => {
      const { user } = await renderEditor();
      typeInMonaco(`${YAML}# typed\n`);
      act(() => useEditorStore.getState().replaceVersionSummary({ ...summaryOf(VERSION), ...PUBLISHED_FIELDS }));

      await user.click(screen.getByRole("button", { name: "Undo All" }));

      expect(useEditorStore.getState().text).toBe(YAML);
      expect(useEditorStore.getState().isYamlEditing).toBe(false);
      expect(fake.value).toBe(YAML);
      expect(screen.queryByRole("button", { name: "Undo All" })).toBeNull();
      expect((fake.props?.options as { readOnly?: boolean }).readOnly).toBe(true);
    });
  });
});
