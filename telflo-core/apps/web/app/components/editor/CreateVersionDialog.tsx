import { useEffect, useRef, useState } from "react";
import { CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";

interface CreateVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates the version (`useCreateVersion`); true once the editor has opened it. */
  onCreate: (label: string) => Promise<boolean>;
  /** Whether a create is under way. */
  creating: boolean;
  /** Whether a save is under way: Continue waits for it (D10 Ruling 30). */
  saving?: boolean;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`). */
  onCloseAutoFocus?: (event: Event) => void;
}

/*
 * The "Copy Version" dialog (ADR 0018; D10 decision 11). Differences,
 * all in the D10 Parity Notes:
 * - the body says what the create does: a new version from this one, with
 *   its unsaved changes, the source left as last saved (it doesn't say it
 *   saves the changes);
 * - while the create is under way, Continue reads "Creating…" and both
 *   buttons are disabled; Escape, an outside click and the close button do
 *   nothing meanwhile, so a second create can't start beside it (no two
 *   versions from a double click); while a save is under
 *   way, Continue is disabled and Enter creates nothing (the create would
 *   do nothing then);
 * - a failure keeps the dialog open with what was typed (the create says
 *   why), and the focus back in the field (D10 Ruling 44), from Continue,
 *   which was disabled meanwhile.
 * The name is optional, at most 80 characters, trimmed by the create; the
 * field is focused, and Enter creates. Reopening starts with an empty field.
 * The name is the user's text: it is the field's value, never another
 * attribute (ADR 0024).
 */
export function CreateVersionDialog({
  open,
  onOpenChange,
  onCreate,
  creating,
  saving = false,
  onCloseAutoFocus,
}: CreateVersionDialogProps) {
  const [label, setLabel] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setLabel("");
  }, [open]);

  const close = () => {
    if (!creating) onOpenChange(false);
  };

  const handleContinue = async () => {
    if (creating || saving) return;
    if (await onCreate(label)) onOpenChange(false);
    else fieldRef.current?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Copy Version</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-4">
          <DialogDescription className="text-sm text-muted-foreground">
            Creates a new version from this one, including any unsaved changes. This version stays as it was last
            saved.
          </DialogDescription>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="version-label">Version name (optional)</Label>
            <Input
              ref={fieldRef}
              id="version-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleContinue();
                }
              }}
              placeholder="e.g. Add tail sampling"
              maxLength={CONFIGURATION_VERSION_LABEL_MAXIMUM_LENGTH}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={creating}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleContinue()} disabled={creating || saving}>
            {creating ? "Creating…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
