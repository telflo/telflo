import { Loader2 } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEET_LABEL_MAXIMUM_LENGTH, FLEETS_UNAVAILABLE_MESSAGE, FleetLabelSchema, type Fleet, type FleetErrorCode } from "@telflo/contracts";
import { DialogErrorAlert } from "~/components/fleets/DialogErrorAlert.js";
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
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded, REQUEST_ABORTED, updateFleet } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetFieldProblemsOf, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";

/*
 * "Rename fleet" (D17a decisions 3, 25 and 28; Preflight rulings 14 and 15).
 * The dialog is the create dialogs' (their Name field, its helper and
 * `DialogErrorAlert`), with D7's `DeleteConfigurationDialog` pattern for a
 * write under way:
 *
 * - The Name opens holding the fleet's label. It is trimmed before it is
 *   sent (decision 12); a trimmed Name equal to the label closes the dialog
 *   with no request, until an answer leaves a rename unknown (a 503, a 5xx,
 *   no connection, the hang guard): the fleet may then have the other name,
 *   so the label is sent again (a rename is idempotent), and closing the
 *   dialog (Cancel, Escape, an outside click, the X) reloads (`onRenamed`),
 *   as the create's, archive's and delete's do after one. One the contract
 *   still refuses (`FleetLabelSchema`) shows its words under the field,
 *   nothing sent.
 * - "Save" / "Saving…". While the rename is under way Cancel is disabled,
 *   and Escape, an outside click and the X do nothing (the X is hidden).
 * - Refusals show in the dialog: a 409 `fleet_label_taken`, or a 400 whose
 *   details name the label, under the Name; a 503 `fleets_unavailable` (its
 *   own words: the rename may or may not have been made), a 429 and any
 *   other refusal of `fleetRefusalMessage`'s in the alert, else "Failed to
 *   rename fleet". The rename carries the 30 s hang guard, whose abort shows
 *   the 503's words.
 * - A 404 `fleet_not_found` (deleted meanwhile) toasts the API's message,
 *   closes and reloads (`onRenamed`); a 404 `organization_not_found` or a 403
 *   `terms_acceptance_required` closes and revalidates the layout, with no
 *   message; a session ended is the session-ended handler's (silent).
 * - Success closes and reloads (`onRenamed`): the list re-reads its pages,
 *   the fleet's page its fleet (the PATCH answers no summary).
 * - An answer after the dialog unmounted, or for an organization no longer
 *   active, does nothing (`useStillCurrent`).
 *
 * The label is text, and the Name input's value: React writes a controlled
 * input's `value` attribute, so while the dialog is open that attribute
 * holds the label (Preflight ruling 15's one exception; replay's
 * `maskAllInputs` masks it). No other attribute, and no toast but the API's
 * own message, holds it.
 */

export const RENAME_FAILED_MESSAGE = "Failed to rename fleet";

const FLEET_LABEL_TAKEN: FleetErrorCode = "fleet_label_taken";

export interface RenameFleetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The fleet to rename; null renders nothing to send. */
  fleet: Pick<Fleet, "id" | "label"> | null;
  /** The organization the fleet is the active organization's in. */
  organizationId: string;
  /** After a rename, a 404 for the fleet, or closing after an unknown outcome: the list reloads, or the page reads the fleet again. */
  onRenamed: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the page gives it back to the opener (D14b Ruling 46). */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session, the Name holding the label afresh. */
export function RenameFleetDialog(props: RenameFleetDialogProps) {
  const opening = useOpeningKey(props.open);
  return <RenameFleetSession key={opening} {...props} />;
}

function RenameFleetSession({ open, onOpenChange, fleet, organizationId, onRenamed, onCloseAutoFocus }: RenameFleetDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const nameId = useId();
  const [label, setLabel] = useState(fleet?.label ?? "");
  const [saving, setSaving] = useState(false);
  // Reentry guard: a double Enter lands before the state re-renders.
  const savingRef = useRef(false);
  // An answer left a rename unknown: the fleet may hold another name, so the label is no longer "unchanged".
  const outcomeUnknownRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const trimmed = label.trim();

  const close = () => {
    if (savingRef.current) return;
    onOpenChange(false);
    // The fleet may have the other name: the list or the page reads it again.
    if (outcomeUnknownRef.current) onRenamed();
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    // The session is over: the session-ended handler has the page.
    if (isSessionEnded(failure)) return;
    if (isUnknownOutcome(failure)) outcomeUnknownRef.current = true;
    if (isFleetGone(failure)) {
      toast.error(failure.message);
      onOpenChange(false);
      onRenamed();
      return;
    }
    if (failure instanceof ApiError && failure.code === REQUEST_ABORTED) {
      setError(FLEETS_UNAVAILABLE_MESSAGE);
      return;
    }
    if (failure instanceof ApiError && failure.code === FLEET_LABEL_TAKEN) {
      setProblem(failure.message);
      return;
    }
    const { label: labelProblem } = fleetFieldProblemsOf(failure);
    if (labelProblem !== undefined) {
      setProblem(labelProblem);
      return;
    }
    setError(fleetRefusalMessage(failure, RENAME_FAILED_MESSAGE));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (fleet === null || savingRef.current || trimmed === "") return;
    if (trimmed === fleet.label && !outcomeUnknownRef.current) {
      close();
      return;
    }
    const checked = FleetLabelSchema.safeParse(trimmed);
    if (!checked.success) {
      setError(null);
      setProblem(checked.error.issues[0]?.message ?? RENAME_FAILED_MESSAGE);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setProblem(null);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await updateFleet(sentIn, fleet.id, { label: trimmed }, { signal: guard.signal });
    } catch (failure) {
      savingRef.current = false;
      setSaving(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    savingRef.current = false;
    setSaving(false);
    if (!isStillCurrent(sentIn)) return;
    onOpenChange(false);
    onRenamed();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-w-lg"
        hideCloseButton={saving}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>Rename fleet</DialogTitle>
            <DialogDescription>Give the fleet a new name. Its collectors and tokens don't change.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setProblem(null);
                }}
                maxLength={FLEET_LABEL_MAXIMUM_LENGTH}
                disabled={saving}
                autoComplete="off"
                aria-invalid={problem !== null || undefined}
                aria-describedby={problem !== null ? `${nameId}-help ${nameId}-problem` : `${nameId}-help`}
              />
              <p id={`${nameId}-help`} className="text-xs text-muted-foreground">
                Fleet name must be unique within your organization.
              </p>
              {problem !== null && (
                <p id={`${nameId}-problem`} className="text-xs text-fail" role="alert">
                  {problem}
                </p>
              )}
            </div>

            <DialogErrorAlert error={error} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || trimmed === ""}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
