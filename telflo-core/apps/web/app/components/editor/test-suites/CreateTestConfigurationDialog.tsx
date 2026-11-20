import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { useEditorStore } from "~/lib/stores/editor-store.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import { useTestingStore, type RunTarget } from "~/lib/stores/testing-store.js";
import { TestConfigurationPanel } from "../test-runs/TestConfigurationPanel.js";

interface CreateTestConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the suite is on. */
  target: RunTarget;
  suiteId: string;
  /** Where the focus goes as the dialog closes (Radix's onCloseAutoFocus): its opener's. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** What the dialog says when the pipeline chosen is gone from the text by the time it submits. */
export const PIPELINE_GONE_MESSAGE = "Selected pipeline no longer exists";

/**
 * A new definition, "New test configuration": a dialog wrapping the run
 * dialog's panel (`../test-runs/TestConfigurationPanel.tsx`) with its Name and
 * Description, "OK" and "Saving…". The input is copied by the API at once, so
 * the definition never depends on the file staying in My Files.
 *
 * - it opens with the remembered duration, no file chosen, and the
 *   remembered pipeline or the first;
 * - it writes nothing back: the run dialog's remembered file, pipeline and
 *   duration stay as they were, never written into the shared selection;
 * - the sources are My Files (with Upload), Templates and Paste Text; a
 *   template is copied at once too, so deleting it never breaks the
 *   definition;
 * - a refusal toasts the API's words (a suite's 101st: "A test suite can have
 *   at most 100 test configurations."), else "Submission failed"; a session
 *   that ended toasts nothing.
 */
export function CreateTestConfigurationDialog({ open, onOpenChange, target, suiteId, onCloseAutoFocus }: CreateTestConfigurationDialogProps) {
  const lastRunDurationSeconds = useTestingStore((state) => state.lastRunDurationSeconds);
  const selectedPipelineName = useTestingStore((state) => state.selectedPipelineName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* As the run dialog: room for the paste panel's editor. */}
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined} {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
        <DialogHeader>
          <DialogTitle>New test configuration</DialogTitle>
        </DialogHeader>

        <TestConfigurationPanel
          showNameFields
          submitLabel="OK"
          submittingLabel="Saving…"
          initialDurationSeconds={lastRunDurationSeconds}
          initialInput={null}
          initialPipelineName={selectedPipelineName}
          onCancel={() => onOpenChange(false)}
          onSubmit={async ({ input, pipelineName, durationSeconds, name, description }) => {
            const pipeline = useEditorStore.getState().graph.pipelines.find((candidate) => candidate.name === pipelineName);
            if (pipeline === undefined) throw new Error(PIPELINE_GONE_MESSAGE);
            await useTestSuitesStore.getState().createDefinition(target, suiteId, {
              ...(input.kind === "file" ? { inputFileId: input.id } : { templateId: input.id }),
              name,
              description,
              pipeline: pipeline.name,
              signal: pipeline.signalType,
              durationSeconds,
            });
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
