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
 * Deleting a test regex: "Delete Test Regex", its question with the entry's
 * name (as text, never an attribute), Cancel and Delete (Deleting…), not
 * closable while it deletes; "Failed to delete regex". As the templates'
 * confirmation: a refusal shows the API's words (`failureMessage`), else that
 * fixed message, in a toast blocked from replay (`ph-no-capture`); a 403
 * `product_admin_required` goes to `/app` (`onProductAdminLost`); the
 * confirmation carries its own `ph-no-capture`: Radix portals it out of the
 * page's block.
 */

interface TestRegexDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  regexName: string | null;
  /** Deletes it; throws the API's refusal. */
  doDelete: () => Promise<void>;
  /** The caller is no longer a product admin (403 `product_admin_required`). */
  onProductAdminLost: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): back to its opener unless prevented. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function TestRegexDeleteDialog({
  open,
  onOpenChange,
  regexName,
  doDelete,
  onProductAdminLost,
  onCloseAutoFocus,
}: TestRegexDeleteDialogProps) {
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
      const message = failureMessage(error, "Failed to delete regex");
      if (message !== null) toast.error(message, { className: "ph-no-capture" });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isDeleting && onOpenChange(next)}>
      <DialogContent className="ph-no-capture" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Delete Test Regex</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete {regexName !== null ? `"${regexName}"` : "this regex"}? This action cannot be
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
