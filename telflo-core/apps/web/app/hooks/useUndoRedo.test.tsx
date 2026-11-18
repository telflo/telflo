import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOTHING_TO_DUPLICATE_MESSAGE, OWN_HISTORY_PROPS, OWN_KEYS_PROPS, useUndoRedo } from "./useUndoRedo.js";
import { useSharedCount } from "./useSharedCount.js";
import { corpusText } from "~/lib/graph/corpus/corpus.js";
import { componentKey } from "~/lib/graph/node-operations.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { GROUP_ID, MINE, versionFixture } from "~/test/configurations.js";

const STARTER = corpusText("starter.yaml");
const initialState = useEditorStore.getState();
const store = () => useEditorStore.getState();

function nodeId(key: string, pipeline: string): string {
  const { nodes } = store().graph;
  const group = nodes.find((n) => n.type === "pipelineGroup" && n.data.label === pipeline)!;
  return nodes.find((n) => n.parentId === group.id && componentKey(n.data) === key)!.id;
}

function groupId(pipeline: string): string {
  return store().graph.nodes.find((n) => n.type === "pipelineGroup" && n.data.label === pipeline)!.id;
}

/** Presses a key on `target` (the window when none), and says whether its default was prevented. */
function press(init: KeyboardEventInit, target?: Element): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    (target ?? window).dispatchEvent(event);
  });
  return event.defaultPrevented;
}

beforeEach(() => {
  useEditorStore.setState(initialState, true);
  vi.restoreAllMocks();
  store().load({
    organizationId: GROUP_ID,
    configuration: MINE,
    version: versionFixture({ yamlContent: STARTER }),
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("useUndoRedo", () => {
  it("Ctrl+Z undoes and Ctrl+Shift+Z and Ctrl+Y redo, off a Mac", () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
    });
    expect(result.current).toMatchObject({ canUndo: true, canRedo: false, undoDescription: "Tidy up layout" });

    expect(press({ key: "z", ctrlKey: true })).toBe(true);
    expect(store().history.future).toHaveLength(1);
    expect(result.current).toMatchObject({ canUndo: false, canRedo: true, redoDescription: "Tidy up layout" });

    press({ key: "Z", ctrlKey: true, shiftKey: true });
    expect(store().history.past).toHaveLength(1);
    press({ key: "z", ctrlKey: true });
    press({ key: "y", ctrlKey: true });
    expect(store().history.past).toHaveLength(1);

    // Meta isn't the modifier off a Mac.
    press({ key: "z", metaKey: true });
    expect(store().history.past).toHaveLength(1);
  });

  it("uses Meta on a Mac", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
    });

    press({ key: "z", ctrlKey: true });
    expect(store().history.past).toHaveLength(1);
    press({ key: "z", metaKey: true });
    expect(store().history.past).toHaveLength(0);
  });

  it("leaves the keys to Monaco, inputs, textareas and editable content", () => {
    renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
    });
    store().setSelection([nodeId("processors.batch", "traces")]);

    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    const monacoInput = document.createElement("textarea");
    monaco.append(monacoInput);
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "");
    const inEditable = document.createElement("span");
    editable.append(inEditable);
    document.body.append(monaco, input, textarea, editable);

    for (const target of [monaco, monacoInput, input, textarea, editable, inEditable]) {
      expect(press({ key: "z", ctrlKey: true }, target)).toBe(false);
      expect(press({ key: "y", ctrlKey: true }, target)).toBe(false);
      expect(press({ key: "d", ctrlKey: true }, target)).toBe(false);
      expect(press({ key: "Backspace" }, target)).toBe(false);
      expect(press({ key: "Delete" }, target)).toBe(false);
    }
    expect(store().history.past).toHaveLength(1);
    expect(store().history.future).toEqual([]);
    expect(store().pendingDelete).toBeNull();
  });

  it("leaves Delete, Backspace and Cmd/Ctrl+D to the controls of a marked container (the Configuration tab) and of Radix popper content; undo still works there (Preflight ruling 23)", () => {
    renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
    });
    const batch = nodeId("processors.batch", "traces");
    store().setSelection([batch]);
    const nodes = store().graph.nodes.length;

    const tab = document.createElement("div");
    for (const [name, value] of Object.entries(OWN_KEYS_PROPS)) tab.setAttribute(name, value);
    const checkbox = document.createElement("button");
    checkbox.setAttribute("role", "checkbox");
    tab.append(checkbox);
    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    popper.append(option);
    document.body.append(tab, popper);

    for (const target of [tab, checkbox, option]) {
      // Prevented (no bookmark, no navigation back), and nothing done to the canvas.
      expect(press({ key: "Delete" }, target)).toBe(true);
      expect(press({ key: "Backspace" }, target)).toBe(true);
      expect(press({ key: "d", ctrlKey: true }, target)).toBe(true);
    }
    expect(store().pendingDelete).toBeNull();
    expect(store().graph.nodes).toHaveLength(nodes);

    // Undo is the page's, there too.
    expect(press({ key: "z", ctrlKey: true }, checkbox)).toBe(true);
    expect(store().history.past).toHaveLength(0);
    // Attribute only, no value (decision 10).
    expect(OWN_KEYS_PROPS).toEqual({ "data-own-keys": "" });
  });

  it("keeps undo and redo out of a container marked as its own history (the Self-monitoring dialog) and of popper content while one is open; a field there keeps its own (Ruling 65)", () => {
    renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
      store().tidyUp();
    });
    act(() => {
      store().undo();
    });
    expect(store().history.past).toHaveLength(1);
    expect(store().history.future).toHaveLength(1);
    const before = store().text;

    const dialog = document.createElement("div");
    for (const [name, value] of Object.entries(OWN_HISTORY_PROPS)) dialog.setAttribute(name, value);
    const checkbox = document.createElement("button");
    checkbox.setAttribute("role", "checkbox");
    const input = document.createElement("input");
    dialog.append(checkbox, input);
    const popper = document.createElement("div");
    popper.setAttribute("data-radix-popper-content-wrapper", "");
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    popper.append(option);
    document.body.append(dialog, popper);

    const keys = [{ key: "z", ctrlKey: true }, { key: "z", ctrlKey: true, shiftKey: true }, { key: "y", ctrlKey: true }];
    for (const target of [dialog, checkbox, option]) {
      // Prevented, and nothing done to the editor's history.
      for (const init of keys) expect(press(init, target)).toBe(true);
    }
    // A field's own undo: not prevented, not the editor's.
    for (const init of keys) expect(press(init, input)).toBe(false);
    expect(store().history.past).toHaveLength(1);
    expect(store().history.future).toHaveLength(1);
    expect(store().text).toBe(before);
    // Still a container of its own keys too.
    expect(press({ key: "Delete" }, checkbox)).toBe(true);
    expect(store().pendingDelete).toBeNull();

    // With the dialog gone, popper content's undo is the page's again.
    dialog.remove();
    expect(press({ key: "z", ctrlKey: true }, option)).toBe(true);
    expect(store().history.past).toHaveLength(0);
    // Attributes only, no value (decision 10).
    expect(OWN_HISTORY_PROPS).toEqual({ "data-own-keys": "", "data-own-history": "" });
  });

  it("Backspace and Delete open the delete dialog for the selection, delete nothing, and never navigate back", () => {
    renderHook(() => useUndoRedo());
    const batch = nodeId("processors.batch", "traces");
    store().setSelection([batch]);
    const button = document.createElement("button");
    document.body.append(button);

    expect(press({ key: "Backspace" }, button)).toBe(true);
    expect(store().pendingDelete).toEqual({ kind: "nodes", nodeIds: [batch] });
    expect(store().graph.nodes.some((n) => n.id === batch)).toBe(true);
    expect(store().text).toBe(STARTER);
    expect(store().history.past).toEqual([]);

    store().cancelDelete();
    expect(press({ key: "Delete" })).toBe(true);
    expect(store().pendingDelete).toEqual({ kind: "nodes", nodeIds: [batch] });
    expect(store().graph.nodes.some((n) => n.id === batch)).toBe(true);

    // Nothing selected: nothing to ask about, and still no navigation.
    store().cancelDelete();
    store().setSelection([]);
    expect(press({ key: "Backspace" })).toBe(true);
    expect(store().pendingDelete).toBeNull();
  });

  it("Ctrl+D duplicates the selected component in place, and several at once", () => {
    const success = vi.spyOn(toast, "success");
    renderHook(() => useUndoRedo());
    const batch = nodeId("processors.batch", "traces");
    store().selectNode(batch);

    expect(press({ key: "d", ctrlKey: true })).toBe(true);
    expect(success).toHaveBeenCalledWith('Duplicated "Batch"', { className: "ph-no-capture" });
    const copy = store().selectedNode!;
    expect(copy.id).not.toBe(batch);
    expect(copy.parentId).toBe(groupId("traces"));
    expect(store().text).toContain("  batch/2:\n");

    store().setSelection([nodeId("receivers.otlp", "traces"), nodeId("exporters.otlp", "traces")]);
    press({ key: "d", ctrlKey: true });
    expect(success).toHaveBeenLastCalledWith("Duplicated 2 nodes");
  });

  it("Ctrl+D with a pipeline's group selected does nothing", () => {
    const success = vi.spyOn(toast, "success");
    const info = vi.spyOn(toast, "info");
    renderHook(() => useUndoRedo());
    store().setSelection([groupId("traces")]);
    const before = store();

    expect(press({ key: "d", ctrlKey: true })).toBe(true);

    expect(store().graph).toBe(before.graph);
    expect(store().text).toBe(STARTER);
    expect(store().history.past).toEqual([]);
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("Ctrl+D with nothing selected says so", () => {
    const info = vi.spyOn(toast, "info");
    renderHook(() => useUndoRedo());
    press({ key: "d", ctrlKey: true });
    expect(info).toHaveBeenCalledWith(NOTHING_TO_DUPLICATE_MESSAGE);
    expect(NOTHING_TO_DUPLICATE_MESSAGE).toBe("No node selected to duplicate");
  });

  it("in manual edit mode the shortcuts do nothing (the store refuses them)", () => {
    renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
    });
    store().selectNode(nodeId("processors.batch", "traces"));
    act(() => store().setText(`${STARTER}# typed\n`));
    const before = store();

    press({ key: "z", ctrlKey: true });
    press({ key: "d", ctrlKey: true });
    press({ key: "Backspace" });

    expect(store().graph).toBe(before.graph);
    expect(store().history).toBe(before.history);
    expect(store().pendingDelete).toBeNull();
  });

  it("stops listening when unmounted", () => {
    const { unmount } = renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
    });
    unmount();
    expect(press({ key: "z", ctrlKey: true })).toBe(false);
    expect(store().history.past).toHaveLength(1);
  });

  it("the undo and redo it returns work as the keys do", () => {
    const { result } = renderHook(() => useUndoRedo());
    act(() => {
      store().tidyUp();
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);
    act(() => {
      result.current.redo();
    });
    expect(result.current.canUndo).toBe(true);
  });
});

describe("useSharedCount", () => {
  it("counts the nodes linked by one sharedConfigId, and none for no id", () => {
    const { result, rerender } = renderHook(({ id }: { id: string | undefined }) => useSharedCount(id), {
      initialProps: { id: "processor-batch" as string | undefined },
    });
    expect(result.current).toBe(3);

    rerender({ id: undefined });
    expect(result.current).toBe(0);
    rerender({ id: "exporter-nothing" });
    expect(result.current).toBe(0);
  });
});
