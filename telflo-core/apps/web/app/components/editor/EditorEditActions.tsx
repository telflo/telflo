import { Copy, Redo2, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DuplicateNodeDialog } from "~/components/editor/builder/DuplicateNodeDialog.js";
import { Button } from "~/components/ui/button.js";
import { useUndoRedo } from "~/hooks/useUndoRedo.js";
import { selectIsEditingLocked, useEditorStore } from "~/lib/stores/editor-store.js";

/**
 * The builder buttons' titles, which are also their `aria-label`s: fixed
 * text, never a label or an undo description (D9a decision 7; not
 * "Undo: <description> (Ctrl+Z)" or "Delete "<label>" (Delete)").
 */
export const UNDO_TITLE = "Undo (Ctrl+Z)";
export const REDO_TITLE = "Redo (Ctrl+Shift+Z)";
export const DUPLICATE_TITLE = "Duplicate (Ctrl+D)";
export const DELETE_TITLE = "Delete";

/**
 * The editor toolbar's builder buttons (D9a decisions 7, 8 and 12), Undo,
 * Redo, Duplicate and Delete, with DuplicateNodeDialog and the keyboard
 * shortcuts that come with them (`useUndoRedo`): taken out of EditorToolbar
 * as they were, the same DOM, so the playground's and the public editor's
 * toolbars share them (D31-1 decision 28, Preflight ruling 10).
 *
 * Their disabled rules: Duplicate and Delete are disabled too while the
 * canvas is locked; Undo and Redo follow the store's rules (disabled in
 * manual edit mode, not while the text can't be shown, since an undo can
 * bring back text that reads). Changed: their titles are fixed and are their
 * `aria-label`s (never the undo's description or the node's label); Delete
 * asks through the one delete dialog (the canvas actions mount it). Duplicate
 * opens the `DuplicateNodeDialog` for a receiver, processor or exporter and
 * duplicates a connector or an extension in place. A published version is
 * read-only (D11b decision 4): all four are disabled.
 */
export function EditorEditActions() {
  const locked = useEditorStore(selectIsEditingLocked);
  const selectedNode = useEditorStore((state) => state.selectedNode);
  const selectedNodes = useEditorStore((state) => state.selectedNodes);
  const { undo, redo, duplicate, duplicateMultiple, canUndo, canRedo } = useUndoRedo();
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);

  const handleDuplicate = () => {
    if (selectedNodes.length > 1) {
      duplicateMultiple();
    } else if (selectedNode) {
      const ct = selectedNode.data.componentType;
      if (ct === "connector" || ct === "extension") {
        duplicate();
      } else {
        setDuplicateDialogOpen(true);
      }
    }
  };

  const handleDuplicateInto = (groupId?: string) => {
    const { selectedNode: original, duplicateNode } = useEditorStore.getState();
    if (original) {
      // The store selects the copy.
      if (duplicateNode(original.id, groupId)) toast.success(`Duplicated "${original.data.label}"`, { className: "ph-no-capture" });
    }
    setDuplicateDialogOpen(false);
  };

  const handleLink = (sourceNodeId: string, groupId: string) => {
    // The store selects the linked node.
    if (useEditorStore.getState().linkNodeToGroup(sourceNodeId, groupId)) toast.success("Linked to pipeline");
    setDuplicateDialogOpen(false);
  };

  const duplicateDisabled =
    (selectedNodes.length === 0 && !selectedNode) || selectedNode?.type === "pipelineGroup" || locked;
  const deleteDisabled = selectedNodes.filter((n) => n.type !== "pipelineGroup").length === 0 || locked;

  return (
    <>
      {/* Undo/Redo/Duplicate/Delete Buttons */}
      <div className="flex items-center gap-1">
        <Button
          onClick={undo}
          disabled={!canUndo}
          variant="ghost"
          size="sm"
          title={UNDO_TITLE}
          aria-label={UNDO_TITLE}
          className="h-8 w-8 p-0"
        >
          <Undo2 className="w-4 h-4" />
        </Button>
        <Button
          onClick={redo}
          disabled={!canRedo}
          variant="ghost"
          size="sm"
          title={REDO_TITLE}
          aria-label={REDO_TITLE}
          className="h-8 w-8 p-0"
        >
          <Redo2 className="w-4 h-4" />
        </Button>
        <Button
          onClick={handleDuplicate}
          disabled={duplicateDisabled}
          variant="ghost"
          size="sm"
          title={DUPLICATE_TITLE}
          aria-label={DUPLICATE_TITLE}
          className="h-8 w-8 p-0"
        >
          <Copy className="w-4 h-4" />
        </Button>
        <Button
          onClick={() => useEditorStore.getState().requestDelete()}
          disabled={deleteDisabled}
          variant="ghost"
          size="sm"
          title={DELETE_TITLE}
          aria-label={DELETE_TITLE}
          className="h-8 w-8 p-0"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      <DuplicateNodeDialog
        open={duplicateDialogOpen}
        onOpenChange={setDuplicateDialogOpen}
        nodeId={selectedNode?.id ?? ""}
        onDuplicate={handleDuplicateInto}
        onLink={handleLink}
      />
    </>
  );
}
