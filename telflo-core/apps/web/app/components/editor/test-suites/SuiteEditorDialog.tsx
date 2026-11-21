import { TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH, TEST_SUITE_NAME_MAXIMUM_LENGTH, type TestSuite } from "@telflo/contracts";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { Textarea } from "~/components/ui/textarea.js";
import { useTestSuitesStore } from "~/lib/stores/test-suites-store.js";
import type { RunTarget } from "~/lib/stores/testing-store.js";
import { failureMessage } from "~/lib/test-runs/messages.js";

interface SuiteEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The version the suite is (or will be) on. */
  target: RunTarget;
  /** The suite to rename and describe; null to create one. */
  suite: TestSuite | null;
  /** Where the focus goes as the dialog closes (Radix's onCloseAutoFocus): its opener's. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Creating, renaming and describing a suite: its words and fields. On any
 * version, published or not.
 *
 * - the fields' ids come from `useId`, and they take no more
 *   than the API keeps (`maxLength`);
 * - closing gives the focus back to the button that opened it;
 * - a description left empty is `''`, as the API keeps it;
 * - a refusal toasts the API's words (a version's 101st suite: "A version
 *   can have at most 100 test suites."), else fixed words; a session that
 *   ended toasts nothing;
 * - the name and description are input values, masked by replay's
 *   `maskAllInputs`.
 */
export function SuiteEditorDialog({ open, onOpenChange, target, suite, onCloseAutoFocus }: SuiteEditorDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setName(suite?.name ?? "");
    setDescription(suite?.description ?? "");
  }, [open, suite]);

  const isEdit = suite !== null;
  const canSubmit = name.trim().length > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const store = useTestSuitesStore.getState();
      const values = { name: name.trim(), description: description.trim() };
      if (isEdit) await store.updateSuite(target, suite.id, values);
      else await store.createSuite(target, values);
      onOpenChange(false);
    } catch (error) {
      const message = failureMessage(error, isEdit ? "Failed to update suite" : "Failed to create suite");
      if (message !== null) toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined} {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit suite" : "New suite"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={TEST_SUITE_NAME_MAXIMUM_LENGTH}
              placeholder="Smoke tests"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-description`}>Description</Label>
            <Textarea
              id={`${id}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={TEST_SUITE_DESCRIPTION_MAXIMUM_LENGTH}
              placeholder="What this suite covers"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 px-3 text-[13px] font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="h-8 px-3 text-[13px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
          >
            {isSubmitting ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save" : "Create"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
