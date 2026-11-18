import { Activity, Eraser, LayoutGrid, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AddPipelineDialog } from "./AddPipelineDialog.js";
import { ClearDialog } from "./ClearDialog.js";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.js";
import { SelfMonitoringDialog, selectTelemetryConfigured } from "./SelfMonitoringDialog.js";
import { selectIsEditingLocked, useEditorStore } from "~/lib/stores/editor-store.js";

/*
 * The canvas actions (D9a decision 15): the floating cluster pinned to the
 * canvas's top right corner. Add pipeline, Self-monitoring, Tidy up and Clear
 * canvas act on the canvas, so they live on it. Clear is the one destructive
 * member: last, behind a divider, tinted destructive on hover, and never
 * without its confirmation.
 *
 * Self-monitoring (D9b decision 7) opens the dialog over `service.telemetry`.
 * Its `aria-label` and `title` are fixed; `data-configured` and the green dot
 * say whether the text has `service.telemetry` with a value other than null
 * (read through aliases and merges), never what it holds (decision 10).
 *
 * Changed: every action is disabled while the canvas is locked (manual edit
 * mode, or text it can't show, so Clear can't run mid-edit), and on a
 * published version, which is read-only (D11b decision 4).
 *
 * The canvas's dialogs live here: Add New Pipeline, Collector Self-Monitoring,
 * Clear Canvas, and the one delete confirmation, which the store's
 * `pendingDelete` opens from the canvas's Delete key, the toolbar and the
 * pipeline panel alike.
 */
export function CanvasActions() {
  const locked = useEditorStore(selectIsEditingLocked);
  const configured = useEditorStore(selectTelemetryConfigured);

  const [addPipelineOpen, setAddPipelineOpen] = useState(false);
  const [selfMonitoringOpen, setSelfMonitoringOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  const handleClear = () => {
    setClearOpen(false);
    if (useEditorStore.getState().clearCanvas()) toast.success("Canvas cleared");
  };

  const handleTidyUp = () => {
    if (!useEditorStore.getState().tidyUp()) return;
    toast.success("Layout tidied", {
      description: "Undo with Ctrl/Cmd+Z to restore the previous positions.",
    });
  };

  const iconBtnClass =
    "relative flex h-6 w-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

  return (
    <>
      <div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm">
        <button
          type="button"
          data-tour-step="add-pipeline"
          onClick={() => setAddPipelineOpen(true)}
          disabled={locked}
          className="flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          title="Add new pipeline"
        >
          <Plus className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="whitespace-nowrap">Add pipeline</span>
        </button>

        <button
          type="button"
          onClick={() => setSelfMonitoringOpen(true)}
          disabled={locked}
          className={iconBtnClass}
          aria-label="Collector self-monitoring (service::telemetry)"
          title="Collector self-monitoring (service::telemetry)"
          data-configured={configured ? "true" : "false"}
        >
          <Activity className="w-3.5 h-3.5" />
          {configured && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />}
        </button>

        <button
          type="button"
          onClick={handleTidyUp}
          disabled={locked}
          className={iconBtnClass}
          aria-label="Tidy up layout"
          title="Tidy up layout (auto-arrange every node)"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
        </button>

        <div className="mx-0.5 h-4 w-px bg-border" />

        <button
          type="button"
          onClick={() => setClearOpen(true)}
          disabled={locked}
          className={`${iconBtnClass} hover:bg-destructive/10 hover:text-destructive`}
          aria-label="Clear canvas"
          title="Clear canvas"
        >
          <Eraser className="w-3.5 h-3.5" />
        </button>
      </div>

      <AddPipelineDialog open={addPipelineOpen} onOpenChange={setAddPipelineOpen} />
      <SelfMonitoringDialog open={selfMonitoringOpen} onOpenChange={setSelfMonitoringOpen} />
      <ClearDialog open={clearOpen} onOpenChange={setClearOpen} doClear={handleClear} />
      <DeleteConfirmDialog />
    </>
  );
}
