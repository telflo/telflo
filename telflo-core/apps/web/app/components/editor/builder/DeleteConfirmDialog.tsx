import { useEffect } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
import type { Graph } from "~/lib/graph/types.js";
import { useEditorStore, type DeleteTarget } from "~/lib/stores/editor-store.js";

/*
 * The one delete confirmation (D9a decision 8), in the Clear dialog's style,
 * never a browser `confirm()`. It shows whatever the store's
 * `pendingDelete` asks about, from the canvas's Delete key, the toolbar's
 * Delete and the pipeline panel alike: its title is the question; Delete
 * runs the store's `confirmDelete` (one undo entry, and a toast), Cancel and
 * Escape its `cancelDelete`, which deletes nothing.
 *
 * Labels and pipeline names are text in the title only, never an attribute
 * (decision 7).
 */

/** What the dialog says: its title, and a description for a pipeline. Null when the target is gone. */
export function describeDelete(target: DeleteTarget, graph: Graph): { title: string; description?: string } | null {
  const pipelineQuestion = (pipelineId: string | undefined) => {
    const pipeline = graph.pipelines.find((p) => p.id === pipelineId);
    return pipeline
      ? { title: `Delete pipeline "${pipeline.name}"?`, description: "Its components and connections will be removed." }
      : null;
  };
  if (target.kind === "pipeline") return pipelineQuestion(target.pipelineId);

  const nodes = graph.nodes.filter((node) => target.nodeIds.includes(node.id));
  if (nodes.length === 0) return null;
  if (nodes.length > 1) return { title: `Delete ${nodes.length} selected nodes?` };
  const node = nodes[0]!;
  if (node.type === "pipelineGroup") return pipelineQuestion(node.data.pipelineId);
  return { title: `Delete "${node.data.label || node.data.componentSubType}"?` };
}

export function DeleteConfirmDialog() {
  const pendingDelete = useEditorStore((state) => state.pendingDelete);
  const graph = useEditorStore((state) => state.graph);
  const question = pendingDelete ? describeDelete(pendingDelete, graph) : null;

  // What it asked about is gone (an undo under it): nothing to confirm.
  const stale = pendingDelete !== null && question === null;
  useEffect(() => {
    if (stale) useEditorStore.getState().cancelDelete();
  }, [stale]);

  const onOpenChange = (open: boolean) => {
    if (!open && useEditorStore.getState().pendingDelete !== null) useEditorStore.getState().cancelDelete();
  };

  return (
    <AlertDialog open={question !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent {...(question?.description ? {} : { "aria-describedby": undefined })}>
        <AlertDialogHeader>
          <AlertDialogTitle>{question?.title}</AlertDialogTitle>
          {question?.description && <AlertDialogDescription>{question.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => useEditorStore.getState().confirmDelete()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
