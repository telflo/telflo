import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
import { Button } from "~/components/ui/button.js";

/*
 * The Unsaved Changes dialog (ADR 0018; D8 decision 15). The editor page
 * opens it while the navigation guard holds a navigation
 * (useNavigationGuard).
 */

interface UnsavedChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaveAndContinue: () => Promise<void>;
  onDiscard: () => void;
  onCancel: () => void;
  isSaving?: boolean;
}

export function UnsavedChangesDialog({
  open,
  onOpenChange,
  onSaveAndContinue,
  onDiscard,
  onCancel,
  isSaving = false,
}: UnsavedChangesDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader className="sm:text-center">
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes that will be lost. What would you like to
            do?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col sm:flex-row sm:justify-center gap-2">
          <AlertDialogCancel onClick={onCancel} disabled={isSaving}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={onDiscard}
            disabled={isSaving}
          >
            Discard Changes
          </Button>
          <Button onClick={onSaveAndContinue} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save & Continue"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
