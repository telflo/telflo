import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { isProductAdminRefusal } from "~/lib/flows/flow-admin.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * Deleting a library file (D23-2 decision 53): "Delete Library File", its
 * question with the file's name (as text, which replay masks; never an
 * attribute, decision 58), Cancel and Delete (Deleting…), not closable while
 * it deletes; "Failed to delete library file". As the test templates' (D14b):
 * a refusal shows the API's words (`failureMessage`), else that fixed
 * message; a 403 `product_admin_required` goes to `/app`
 * (`onProductAdminLost`); nothing is logged.
 */

interface LibraryFileDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The file's name, shown as text in the question. */
  fileName: string | null;
  /** Deletes it; throws the API's refusal. */
  doDelete: () => Promise<void>;
  /** The caller is no longer a product admin (403 `product_admin_required`). */
  onProductAdminLost: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): back to its opener unless prevented. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function LibraryFileDeleteDialog({
  open,
  onOpenChange,
  fileName,
  doDelete,
  onProductAdminLost,
  onCloseAutoFocus,
}: LibraryFileDeleteDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await doDelete();
      onOpenChange(false);
    } catch (error) {
      if (isProductAdminRefusal(error)) {
        onProductAdminLost();
        return;
      }
      const message = failureMessage(error, "Failed to delete library file");
      if (message !== null) toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isDeleting && onOpenChange(next)}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Delete Library File</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete {fileName !== null ? `"${fileName}"` : "this file"}? This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting}>
            {isDeleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
