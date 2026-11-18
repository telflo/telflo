import { useState } from "react";
import { toast } from "sonner";

import { SIGNAL_BADGE_BASE, SIGNAL_BADGE_CLASSES } from "./PipelineGroupConfigPanel.js";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { extractSignalType } from "~/lib/graph/parse.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The Add New Pipeline dialog (ADR 0018; D9a decision 15): the name is
 * lowercased as it's typed and trimmed on submit, then refused when empty,
 * not `traces`, `metrics` or `logs` with an optional `/<name>`, or already
 * used. The store adds the pipeline to the text, empty, with the first unused
 * colour, as one undo entry.
 *
 * The pipeline's id is opaque (`pipeline_<n>`, decision 7), never built
 * from the name. The name is shown as text only.
 */

export const PIPELINE_NAME_PATTERN = /^(traces|metrics|logs)(?:\/[a-z0-9-]+)?$/;

export const EMPTY_NAME_MESSAGE = "Pipeline name cannot be empty";
export const INVALID_NAME_MESSAGE = "Invalid format. Use: traces, metrics, logs, or {type}/{name}";
export const DUPLICATE_NAME_MESSAGE = "Pipeline with this name already exists";

interface AddPipelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const codeClass = "rounded-[4px] bg-muted px-1 py-0.5 font-mono text-xs";

export function AddPipelineDialog({ open, onOpenChange }: AddPipelineDialogProps) {
  const [pipelineName, setPipelineName] = useState("");

  const handleCreatePipeline = () => {
    const name = pipelineName.trim().toLowerCase();

    if (!name) {
      toast.error(EMPTY_NAME_MESSAGE);
      return;
    }
    if (!PIPELINE_NAME_PATTERN.test(name)) {
      toast.error(INVALID_NAME_MESSAGE);
      return;
    }
    const store = useEditorStore.getState();
    if (store.graph.pipelines.some((p) => p.name === name)) {
      toast.error(DUPLICATE_NAME_MESSAGE);
      return;
    }

    // Refused only when the canvas is locked or the text can't take it
    // (the store toasts that); the dialog stays open with the name.
    if (!store.addPipeline(name)) return;
    toast.success(`Pipeline "${name}" created`, { className: "ph-no-capture" });

    setPipelineName("");
    onOpenChange(false);
  };

  const signalType = extractSignalType(pipelineName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Add New Pipeline</DialogTitle>
          <DialogDescription>Create a new named pipeline for your OpenTelemetry configuration.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="pipeline-name">Pipeline Name</Label>
            <Input
              id="pipeline-name"
              // A pipeline's name is configuration text: replay never records the field (Ruling 301).
              className="ph-no-capture"
              placeholder="traces/production"
              value={pipelineName}
              onChange={(event) => setPipelineName(event.target.value.toLowerCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleCreatePipeline();
              }}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Format: <code className={codeClass}>traces</code>, <code className={codeClass}>traces/production</code>,{" "}
              <code className={codeClass}>metrics/high-priority</code>
            </p>
          </div>

          {pipelineName && (
            <div className="space-y-2">
              <Label>Detected Signal Type</Label>
              <div className="flex items-center gap-2">
                <div className={`${SIGNAL_BADGE_BASE} ${SIGNAL_BADGE_CLASSES[signalType]}`}>{signalType}</div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreatePipeline}>Create Pipeline</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
