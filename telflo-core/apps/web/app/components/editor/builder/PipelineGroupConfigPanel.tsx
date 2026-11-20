import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button.js";
import { Label } from "~/components/ui/label.js";
import { CUSTOM_PIPELINE_COLORS } from "~/lib/graph/node-builders.js";
import type { PipelineSignalType } from "~/lib/graph/types.js";
import { selectIsEditingLocked, useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The pipeline group panel, on the editor's store: the Configuration tab
 * shows it for a selected pipeline group.
 *
 * A colour change is an undo entry (it changes the layout, never
 * the text), and Delete asks through the one delete dialog, which says the
 * pipeline's components go too, and is undoable.
 *
 * The swatches' `title` is the hex colour; the pipeline's name is text only,
 * never an attribute.
 */

/** The signal badges' colours (the Add New Pipeline dialog uses them too). */
export const SIGNAL_BADGE_CLASSES: Readonly<Record<PipelineSignalType, string>> = {
  traces:
    "bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-700",
  metrics: "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700",
  logs: "bg-gray-50 dark:bg-gray-700/40 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600",
};

export const SIGNAL_BADGE_BASE =
  "inline-flex items-center rounded-[4px] border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-[0.07em]";

/** The colour for a pipeline without one. */
const FALLBACK_COLOR = "#94a3b8";

export function PipelineGroupConfigPanel() {
  const selectedNode = useEditorStore((state) => state.selectedNode);
  const pipelines = useEditorStore((state) => state.graph.pipelines);
  const locked = useEditorStore(selectIsEditingLocked);

  if (!selectedNode || selectedNode.type !== "pipelineGroup") return null;

  const pipelineId = selectedNode.data.pipelineId;
  const pipeline = pipelines.find((p) => p.id === pipelineId);

  if (!pipeline) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p className="text-[13px]">Pipeline not found</p>
      </div>
    );
  }

  const currentColor = pipeline.color ?? FALLBACK_COLOR;

  const handleColorChange = (color: string) => {
    if (useEditorStore.getState().setPipelineColor(pipeline.id, color)) toast.success("Pipeline color updated");
  };

  const handleDelete = () => {
    useEditorStore.getState().requestDelete({ kind: "pipeline", pipelineId: pipeline.id });
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto">
      {/* Header: mirrors the component identity header, title row, no type caption. */}
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-4">
        <h3 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{pipeline.name}</h3>
        <Button
          onClick={handleDelete}
          disabled={locked}
          variant="ghost"
          size="sm"
          aria-label="Delete pipeline"
          className="shrink-0 text-fail hover:bg-fail-soft hover:text-fail"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      <div className="mb-4">
        <Label className="mb-1.5 block text-[13px] font-medium text-foreground">Signal Type</Label>
        <div className={`${SIGNAL_BADGE_BASE} ${SIGNAL_BADGE_CLASSES[pipeline.signalType]}`}>{pipeline.signalType}</div>
      </div>

      {/* Color: sets this pipeline's lane colour on the canvas. */}
      <div className="mb-4">
        <Label className="mb-1.5 block text-[13px] font-medium text-foreground">Color</Label>
        <div className="grid grid-cols-6 gap-2">
          {CUSTOM_PIPELINE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => handleColorChange(color)}
              disabled={locked}
              aria-pressed={currentColor === color}
              className="w-8 h-8 rounded-md border-2 transition-colors disabled:opacity-50"
              style={{
                backgroundColor: color,
                borderColor: currentColor === color ? "var(--color-foreground)" : "var(--color-border)",
              }}
              title={color}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
