import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { useLockedAction } from "~/lib/playground/context.js";
import { useTestingStore, type SelectedTestInput } from "~/lib/stores/testing-store.js";
import { isTemplateGone, TestConfigurationPanel } from "./TestConfigurationPanel.js";

/** What the dialog runs: one of the person's files or a template, a pipeline by its name in the text, and a duration. */
export interface RunTestValues {
  input: SelectedTestInput;
  pipelineName: string;
  durationSeconds: number;
}

interface RunTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Queues the run (or asks first, the fixture-shape check); rejects as the queue did. */
  onRun: (values: RunTestValues) => Promise<void>;
  /** Where the focus goes as the dialog closes (Radix's onCloseAutoFocus): the tab moves it to the run just queued, else back to "Configure and run". */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The run dialog, wrapping TestConfigurationPanel.tsx. It opens with the
 * remembered duration, input (a file or a template) and pipeline, remembers
 * the input and pipeline it runs with (the panel itself writes nothing),
 * and closes once the run is queued (or once the fixture-shape check has
 * asked). A template deleted since it was picked is forgotten. In the
 * playground its Run is locked and remembers nothing: no input or pipeline
 * is kept for the next opening.
 */
export function RunTestDialog({ open, onOpenChange, onRun, onCloseAutoFocus }: RunTestDialogProps) {
  const lastRunDurationSeconds = useTestingStore((state) => state.lastRunDurationSeconds);
  const selectedFile = useTestingStore((state) => state.selectedFile);
  const selectedTemplate = useTestingStore((state) => state.selectedTemplate);
  const selectedPipelineName = useTestingStore((state) => state.selectedPipelineName);
  const locked = useLockedAction();
  const initialInput: SelectedTestInput | null =
    selectedTemplate !== null
      ? { kind: "template", ...selectedTemplate }
      : selectedFile !== null
        ? { kind: "file", ...selectedFile }
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the default, so the paste panel's editor is usable. */}
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined} {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
        <DialogHeader>
          <DialogTitle>Select Test File</DialogTitle>
        </DialogHeader>

        <TestConfigurationPanel
          initialDurationSeconds={lastRunDurationSeconds}
          initialInput={initialInput}
          initialPipelineName={selectedPipelineName}
          onCancel={() => onOpenChange(false)}
          onSubmit={async ({ input, pipelineName, durationSeconds }) => {
            // Only the run dialog remembers its choice.
            const testing = useTestingStore.getState();
            // The playground's Run is locked (the tab's `onRun`): nothing to remember.
            if (locked === null) {
              testing.setSelectedFile(input.kind === "file" ? { id: input.id, displayName: input.displayName } : null);
              testing.setSelectedTemplate(input.kind === "template" ? { id: input.id, name: input.name } : null);
              testing.setSelectedPipelineName(pipelineName);
            }
            try {
              await onRun({ input, pipelineName, durationSeconds });
            } catch (error) {
              if (input.kind === "template" && isTemplateGone(error)) testing.setSelectedTemplate(null);
              throw error;
            }
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
