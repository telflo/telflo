import type { ValidationPipeline, ValidationRule } from "@telflo/contracts";
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
import { isAlreadyGone } from "~/lib/stores/validation-pipelines-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";
import { ruleDisplayName } from "./validation-display.js";

/*
 * The Validation subtab's two delete confirmations (D15a decision 18):
 * the validation pipeline confirmation, and one for a rule, which is never
 * deleted at once (decision 18's Parity Note).
 *
 * Differences (the Parity Notes), as the Suites subtab's
 * (`../test-suites/DeleteConfirmations.tsx`): Delete keeps the dialog open,
 * its words "Deleting...", until the API answers, and a failure toasts the
 * API's words and keeps it open, not closed at the click; one already gone
 * ("not found": another tab deleted it) toasts the API's words and closes,
 * the item dropped; a session that ended toasts nothing. The pipeline's name
 * and the rule's are text in the description, inside the dialog's
 * `ph-no-capture` (D15a Preflight ruling 27: the dialog is a portal, outside
 * the panel's block), never an attribute. Where the focus goes as it closes
 * is the caller's (`onCloseAutoFocus`): with no Radix trigger, Radix's own
 * return would leave it on the page's body.
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
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
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
      <AlertDialogContent className="ph-no-capture" {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
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

/** "Delete validation pipeline?". Its rules go with it. */
export function DeleteValidationPipelineDialog({
  validationPipeline,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  validationPipeline: ValidationPipeline | null;
  onConfirm: (validationPipeline: ValidationPipeline) => Promise<void>;
  onClose: () => void;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}) {
  return (
    <ConfirmDelete
      open={validationPipeline !== null}
      title="Delete validation pipeline?"
      description={
        <>
          Really delete the validation pipeline{" "}
          <span className="font-mono font-medium text-foreground">{validationPipeline?.pipeline}</span> and all its validation
          rules?
        </>
      }
      fallback="Failed to delete validation pipeline"
      onConfirm={() => (validationPipeline === null ? Promise.resolve() : onConfirm(validationPipeline))}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}

/** "Delete validation rule?" (decision 18: a rule is never deleted at once), its words after the definition's (D14b). */
export function DeleteValidationRuleDialog({
  rule,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  rule: ValidationRule | null;
  onConfirm: (rule: ValidationRule) => Promise<void>;
  onClose: () => void;
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}) {
  return (
    <ConfirmDelete
      open={rule !== null}
      title="Delete validation rule?"
      description={
        <>Delete the validation rule {rule === null ? null : <span className="font-medium text-foreground">{ruleDisplayName(rule)}</span>}?</>
      }
      fallback="Failed to delete rule"
      onConfirm={() => (rule === null ? Promise.resolve() : onConfirm(rule))}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}
