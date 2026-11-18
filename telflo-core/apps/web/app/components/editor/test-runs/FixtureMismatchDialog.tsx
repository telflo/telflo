import { AlertTriangle } from "lucide-react";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import type { MismatchAdvisory } from "~/lib/test-runs/fixture-shape.js";

interface FixtureMismatchDialogProps {
  open: boolean;
  advisory: MismatchAdvisory | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Where the focus goes once the question has closed (Radix's `onCloseAutoFocus`): it has no Radix trigger to go back to. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The warning before a run whose input doesn't suit the target pipeline's
 * receiver (D14a decision 17; `lib/test-runs/fixture-shape.ts`). "Run Anyway"
 * queues the run; Cancel (or closing) queues nothing. The tester attaches the
 * same advisory to the run's results. Where the focus goes as it closes is
 * the caller's (`onCloseAutoFocus`, D14b Rulings 46 and 50): with no Radix
 * trigger, Radix's own handling would leave it on the body.
 *
 * The advisory's message is the module's fixed wording, naming signals and a
 * receiver kind only, never the input or the text.
 */
export function FixtureMismatchDialog({ open, advisory, onCancel, onConfirm, onCloseAutoFocus }: FixtureMismatchDialogProps) {
  if (!advisory) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warn" />
            Fixture may not match the receiver
          </DialogTitle>
          <DialogDescription className="pt-2 text-sm leading-relaxed text-foreground/80">
            {advisory.message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 pt-2 sm:gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Run Anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
