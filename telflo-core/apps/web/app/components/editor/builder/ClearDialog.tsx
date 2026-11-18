import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";

/*
 * The Clear canvas dialog (ADR 0018; D9a decision 15).
 */

interface ClearDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doClear: () => void;
}

export function ClearDialog({ open, onOpenChange, doClear }: ClearDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear Canvas</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to clear the canvas? This will remove all nodes, connections, and YAML content.
            {" Your saved configuration will not be deleted, but all current changes will be lost."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={doClear} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Clear
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
