import { useState } from "react";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { PUBLISH_DIALOG_TITLE, SAVED_FIRST_MESSAGE, publishDialogMessage } from "~/lib/editor/publishing.js";

interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The open version's number, the only thing the dialog names. */
  versionNumber: number;
  /**
   * Whether the editor holds unsaved changes, which the publish saves first:
   * read as the dialog opens, so the line stays while the save first makes
   * the editor clean.
   */
  dirty: boolean;
  /** Whether the publish is under way. */
  publishing: boolean;
  /** Publishes (`usePublishVersion`); the dialog closes when it ends, whatever the outcome, which it toasts. */
  onPublish: () => Promise<boolean>;
}

/*
 * The publish dialog, with the platform's dialog and fixed words: "This will
 * publish version {N}, making it available to your organization members and
 * fleet management.", and "Your unsaved changes will be saved first." only
 * when there are some (no "Continue?"). While the publish is under way,
 * Publish reads "Publishing…" and both buttons are disabled; Escape, an
 * outside click and the close button do nothing, so a second publish can't
 * start beside it (as the Copy Version dialog). "Your unsaved changes will
 * be saved first." follows whether there were some when the dialog opened,
 * so it doesn't vanish once the save first lands mid-publish. It names the
 * version by its number only.
 */
export function PublishDialog({ open, onOpenChange, versionNumber, dirty, publishing, onPublish }: PublishDialogProps) {
  // Whether there were unsaved changes when it opened, taken again each time
  // it opens.
  const [dirtyWhenOpened, setDirtyWhenOpened] = useState(dirty);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDirtyWhenOpened(dirty);
  }

  const close = () => {
    if (!publishing) onOpenChange(false);
  };

  const handlePublish = async () => {
    if (publishing) return;
    await onPublish();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="sm:text-center">
          <DialogTitle>{PUBLISH_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{publishDialogMessage(versionNumber)}</DialogDescription>
        </DialogHeader>
        {dirtyWhenOpened && <p className="text-center text-sm text-muted-foreground">{SAVED_FIRST_MESSAGE}</p>}
        <DialogFooter className="sm:justify-center">
          <Button type="button" variant="outline" onClick={close} disabled={publishing}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handlePublish()} disabled={publishing}>
            {publishing ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
