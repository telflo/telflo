import type { TestDefinition, TestSuite } from "@telflo/contracts";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
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
import { isAlreadyGone } from "~/lib/stores/test-suites-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

/*
 * The Suites subtab's two delete confirmations: the suite confirmation, and
 * one for a definition, which is never deleted at once.
 *
 * Differences: Delete keeps the dialog open, its words "Deleting...", until
 * the API answers, and a failure toasts the API's words and keeps it open,
 * not closed at the click; one already gone ("not found": another tab
 * deleted it) toasts the API's words and closes, the item dropped; a session
 * that ended toasts nothing. The name is text in the description, under the
 * app's `ph-mask`, never an attribute. Where the focus goes as it closes is
 * the caller's (`onCloseAutoFocus`): with no Radix trigger, Radix's own
 * return would leave it on the page's body, Cancel and Escape included.
 */

interface ConfirmDeleteProps {
  open: boolean;
  title: string;
  description: ReactNode;
  /** The words when the API gives none. */
  fallback: string;
  /** Deletes; the dialog closes once it resolves, or once it rejects with the item already gone. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** Where the focus goes as the dialog closes (Radix's onCloseAutoFocus): the caller's; Radix's own goes nowhere (no trigger). */
  onCloseAutoFocus?: (event: Event) => void;
}

function ConfirmDelete({ open, title, description, fallback, onConfirm, onClose, onCloseAutoFocus }: ConfirmDeleteProps) {
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      const message = failureMessage(error, fallback);
      if (message !== null) toast.error(message);
      // Already gone: nothing is left to delete, and the item has left the list.
      if (isAlreadyGone(error)) onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !deleting) onClose();
      }}
    >
      <AlertDialogContent {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Open until the API answers.
              event.preventDefault();
              void confirm();
            }}
            disabled={deleting}
            className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
          >
            {deleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Delete test suite?". Its definitions go with it. */
export function DeleteSuiteDialog({
  suite,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  suite: TestSuite | null;
  onConfirm: (suite: TestSuite) => Promise<void>;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <ConfirmDelete
      open={suite !== null}
      title="Delete test suite?"
      description={
        <>
          Really delete the test suite <span className="font-medium text-foreground">{suite?.name}</span> and all related test
          definitions?
        </>
      }
      fallback="Failed to delete suite"
      onConfirm={() => (suite === null ? Promise.resolve() : onConfirm(suite))}
      onClose={onClose}
      {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
    />
  );
}

/** "Delete test configuration?". */
export function DeleteDefinitionDialog({
  definition,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  definition: TestDefinition | null;
  onConfirm: (definition: TestDefinition) => Promise<void>;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <ConfirmDelete
      open={definition !== null}
      title="Delete test configuration?"
      description={
        <>
          Delete the test configuration <span className="font-medium text-foreground">{definition?.name}</span>?
        </>
      }
      fallback="Failed to delete test configuration"
      onConfirm={() => (definition === null ? Promise.resolve() : onConfirm(definition))}
      onClose={onClose}
      {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
    />
  );
}
