import { signalOfPipeline } from "@telflo/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Label } from "~/components/ui/label.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import type { RunTarget } from "~/lib/stores/testing-store.js";
import { useValidationPipelinesStore } from "~/lib/stores/validation-pipelines-store.js";
import { ApiError } from "~/lib/api-client.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

interface ValidationPipelineEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the validation pipeline will be on. */
  target: RunTarget;
  /** Where the focus goes as the dialog closes (Radix's onCloseAutoFocus): its opener's. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/**
 * "New validation pipeline": its one field, words and hint. The field is
 * one of the editor's pipelines (its graph's, as the run dialog's); one
 * that already has a validation pipeline is offered disabled, " — already
 * has a validation pipeline". On any version, published or not.
 *
 * Differences:
 * - the request is the pipeline's name only (`{pipeline}`): the API takes
 *   the signal from it, and keeps no unused `name`;
 * - the select's values are the pipelines' opaque ids (`pipeline_<n>`), its
 *   names text only, and its list sits in `ph-no-capture` with the dialog's
 *   content (both are portals, outside the panel's block);
 * - a refusal toasts the API's words (a second for one pipeline, 409:
 *   "Pipeline "logs" already has a validation pipeline for this version."),
 *   else fixed words; a session that ended toasts nothing; a 404 (the
 *   version gone) also closes the dialog, the store reading the list again;
 * - only the pipelines whose signal is logs, traces or metrics are offered
 *   (`signalOfPipeline`): never a `profiles/…` pipeline, which
 *   the API refuses;
 * - an answer acts only on the dialog's session that sent it: a
 *   create answered after Escape, or once the dialog has opened again,
 *   closes nothing and toasts nothing (the new card shows in the list, as
 *   the store keeps it);
 * - closing gives the focus back to "+ Pipeline", its opener.
 */
export function ValidationPipelineEditorDialog({ open, onOpenChange, target, onCloseAutoFocus }: ValidationPipelineEditorDialogProps) {
  const graphPipelines = useEditorStore((state) => state.graph.pipelines);
  // A validation pipeline is a logs, traces or metrics pipeline's (its signal is its name's first part).
  const pipelines = useMemo(() => graphPipelines.filter((pipeline) => signalOfPipeline(pipeline.name) !== undefined), [graphPipelines]);
  const validationPipelines = useValidationPipelinesStore((state) => state.pipelines);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const id = useId();
  /** The dialog's session, counted as it opens and closes: a create's answer acts only on the session that sent it. */
  const session = useRef(0);

  // Pipelines that already have a validation pipeline can't get a second one
  // (unique (version, pipeline name) on the table).
  const takenPipelineNames = useMemo(() => new Set(validationPipelines.map((each) => each.pipeline)), [validationPipelines]);

  useEffect(() => {
    session.current += 1;
    if (!open) return;
    setPipelineId(null);
    setIsSubmitting(false);
  }, [open]);

  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null;
  const canSubmit = selectedPipeline !== null && !takenPipelineNames.has(selectedPipeline.name) && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit || selectedPipeline === null) return;
    const sent = session.current;
    setIsSubmitting(true);
    try {
      // The pipeline's name is the text's `service.pipelines` key: the same
      // value a run records as its pipeline, which its rules are matched by.
      await useValidationPipelinesStore.getState().createPipeline(target, selectedPipeline.name);
      if (session.current !== sent) return;
      onOpenChange(false);
    } catch (error) {
      if (session.current !== sent) return;
      const message = failureMessage(error, "Failed to create validation pipeline");
      if (message !== null) toast.error(message);
      // The version is gone: nothing here can be created on it.
      if (error instanceof ApiError && error.status === 404) onOpenChange(false);
    } finally {
      if (session.current === sent) setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md ph-no-capture"
        aria-describedby={undefined}
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DialogHeader>
          <DialogTitle>New validation pipeline</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-pipeline`}>Pipeline</Label>
            <Select value={pipelineId ?? ""} onValueChange={setPipelineId} disabled={pipelines.length === 0}>
              <SelectTrigger id={`${id}-pipeline`} aria-describedby={`${id}-hint`}>
                <SelectValue placeholder="Select a pipeline" />
              </SelectTrigger>
              <SelectContent className="ph-no-capture">
                {pipelines.map((pipeline) => {
                  const taken = takenPipelineNames.has(pipeline.name);
                  return (
                    <SelectItem key={pipeline.id} value={pipeline.id} disabled={taken}>
                      {pipeline.name}
                      {taken ? " — already has a validation pipeline" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p id={`${id}-hint`} className="text-[11px] text-muted-foreground">
              Rules in this group only run against tests that target this pipeline.
            </p>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
          >
            {isSubmitting ? "Creating…" : "OK"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
