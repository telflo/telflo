import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import {
  selectCanRedo,
  selectCanUndo,
  selectRedoDescription,
  selectUndoDescription,
  useEditorStore,
} from "~/lib/stores/editor-store.js";

/** The toast for Cmd/Ctrl+D with nothing selected. */
export const NOTHING_TO_DUPLICATE_MESSAGE = "No node selected to duplicate";

/**
 * Keys typed into a field are the field's own: inputs, textareas, anything
 * editable, and Monaco (whose own undo works as always; Cmd/Ctrl+Z, Y and D
 * typed in Monaco never reach the canvas).
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".monaco-editor")) return true;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  return (
    (target instanceof HTMLElement && target.isContentEditable) ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

/**
 * Marks a container whose Delete, Backspace and Cmd/Ctrl+D belong to its
 * controls, never to the canvas: the Configuration tab
 * (`ConfigurationPanel`), and the Self-monitoring dialog's content, which
 * spreads them on its `DialogContent` with `OWN_HISTORY_PROPS`. A checkbox, a
 * select, a drag handle or a button focused there keeps the selected node
 * from being deleted or duplicated. A fixed attribute with no value.
 */
export const OWN_KEYS_PROPS = { "data-own-keys": "" } as const;

/**
 * Where Delete, Backspace and Cmd/Ctrl+D aren't the canvas's: a container
 * marked `OWN_KEYS_PROPS`, and Radix popper content (a select's menu, a
 * popover, the `$` picker), which renders in `<body>`, outside the tab.
 */
const OWN_KEYS_SELECTOR = "[data-own-keys], [data-radix-popper-content-wrapper]";

function isOwnKeysTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWN_KEYS_SELECTOR) !== null;
}

/**
 * Marks a modal whose undo and redo are its own as well: the
 * Self-monitoring dialog's content, whose draft is written against the text
 * it was taken from. Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Cmd/Ctrl+Y pressed
 * there, or in Radix popper content while one is open (its select menus
 * render in `<body>`), never reach the editor's undo and redo; inside a
 * field they are still the field's own. Attributes with no value.
 */
export const OWN_HISTORY_PROPS = { ...OWN_KEYS_PROPS, "data-own-history": "" } as const;

function isOwnHistoryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-own-history]") !== null) return true;
  return target.closest("[data-radix-popper-content-wrapper]") !== null && document.querySelector("[data-own-history]") !== null;
}

/** Meta on a Mac, Ctrl elsewhere. */
function isMac(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
}

/**
 * Undo and redo, duplicate, and their shortcuts on `window`:
 * - Cmd/Ctrl+Z undoes; Cmd/Ctrl+Shift+Z and Cmd/Ctrl+Y redo (the store
 *   toasts "Undo: <description>" and "Redo: <description>");
 * - Cmd/Ctrl+D duplicates the selection in place; a pipeline's group is
 *   never duplicated (its copy would be an orphan group);
 * - Delete and Backspace open the delete dialog for the selection
 *   (`requestDelete`), never deleting directly, and never navigate back
 *   (WebKit would without `preventDefault`).
 * Inside a field or Monaco the keys are the field's own. Delete, Backspace
 * and Cmd/Ctrl+D inside the Configuration tab, the Self-monitoring dialog or
 * Radix popper content do nothing to the canvas (their default is still
 * prevented: no bookmark, no navigation back); undo and redo work there,
 * except in the Self-monitoring dialog (`OWN_HISTORY_PROPS`), where they do
 * nothing either. In manual edit mode the store refuses each of them.
 */
export function useUndoRedo() {
  const canUndo = useEditorStore(selectCanUndo);
  const canRedo = useEditorStore(selectCanRedo);
  const undoDescription = useEditorStore(selectUndoDescription);
  const redoDescription = useEditorStore(selectRedoDescription);

  const undo = useCallback(() => useEditorStore.getState().undo(), []);
  const redo = useCallback(() => useEditorStore.getState().redo(), []);

  /** Duplicates the one selected component in place. */
  const duplicate = useCallback(() => {
    const { selectedNode, duplicateNode } = useEditorStore.getState();
    if (!selectedNode) {
      toast.info(NOTHING_TO_DUPLICATE_MESSAGE);
      return;
    }
    if (selectedNode.type === "pipelineGroup") return;
    const copy = duplicateNode(selectedNode.id, selectedNode.parentId);
    if (copy) toast.success(`Duplicated "${selectedNode.data.label || selectedNode.data.componentSubType}"`, { className: "ph-no-capture" });
  }, []);

  /** Duplicates every selected component in place. */
  const duplicateMultiple = useCallback(() => {
    const copies = useEditorStore.getState().duplicateSelectedNodes();
    if (copies.length > 0) toast.success(`Duplicated ${copies.length} node${copies.length > 1 ? "s" : ""}`);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const mod = isMac() ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === "z" && !event.shiftKey) {
        event.preventDefault();
        if (isOwnHistoryTarget(event.target)) return;
        undo();
      } else if (mod && ((key === "z" && event.shiftKey) || key === "y")) {
        event.preventDefault();
        if (isOwnHistoryTarget(event.target)) return;
        redo();
      } else if (mod && key === "d") {
        event.preventDefault();
        if (isOwnKeysTarget(event.target)) return;
        if (useEditorStore.getState().selectedNodes.length > 1) duplicateMultiple();
        else duplicate();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (isOwnKeysTarget(event.target)) return;
        useEditorStore.getState().requestDelete();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo, duplicate, duplicateMultiple]);

  return { undo, redo, duplicate, duplicateMultiple, canUndo, canRedo, undoDescription, redoDescription };
}
