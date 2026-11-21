import { useRef, useState, type FormEvent } from "react";
import { CalendarPlus, Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  FLEETS_UNAVAILABLE_MESSAGE,
  QUICK_DEPLOY_LINK_EXTENSION_LABELS,
  QUICK_DEPLOY_LINK_EXTENSIONS,
  type QuickDeployLink,
  type QuickDeployLinkExtension,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, extendQuickDeployLink, isSessionEnded } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";

/*
 * Extend: a dialog "Extend install link" with six presets as native radios
 * (no radio group in `components/ui`, no new dependency), "Cancel" /
 * "Extend" ("Extending…") and the toast "Install link extended". Its
 * rules:
 *
 * - The new expiry is counted from now (the API's clock, not the old
 *   expiry, so an expired link never stays expired), and the words say so:
 *   "Set a new expiry, counted from now."
 * - "1 day" is chosen at each opening: each opening is a new session
 *   (`useOpeningKey`), its link a snapshot taken at the opening.
 * - It stays open until the API answers; Cancel is disabled meanwhile, Escape
 *   and outside clicks do nothing, a double click sends once. The `POST` runs
 *   under the write hang guard.
 * - Refusals: `quick_deploy_link_revoked` (another member revoked it) in
 *   the dialog's alert, "Extend" gone, and the tab reloads (the row shows
 *   it revoked); `quick_deploy_link_not_found` or the fleet gone toasts the
 *   API's words, closes and reloads; an unknown outcome toasts the 503's
 *   words, closes and reloads (the row shows what happened); any other
 *   refusal (a 429 with its words) toasts and stays open, else "Failed to
 *   extend the install link". The organization's or the terms' refusal
 *   closes and revalidates the layout; a session ended is silent. An answer
 *   after the dialog unmounted or for an organization no longer active does
 *   nothing.
 */

export const EXTEND_DESCRIPTION = "Set a new expiry, counted from now.";
export const EXTENDED_MESSAGE = "Install link extended";
export const EXTEND_FAILED_MESSAGE = "Failed to extend the install link";

const DEFAULT_EXTENSION: QuickDeployLinkExtension = "1d";

function isExtension(value: string): value is QuickDeployLinkExtension {
  return (QUICK_DEPLOY_LINK_EXTENSIONS as readonly string[]).includes(value);
}

export interface ExtendInstallLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row's link, as the opening found it. */
  link: QuickDeployLink | null;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** After the extend, a refusal that changes the row, or an unknown outcome: the tab reloads. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: "1 day" chosen afresh, nothing of an earlier one's extend carried over. */
export function ExtendInstallLinkDialog(props: ExtendInstallLinkDialogProps) {
  const opening = useOpeningKey(props.open);
  return <ExtendSession key={opening} {...props} />;
}

function ExtendSession({ open, onOpenChange, link: opened, organizationId, fleetId, onChanged, onCloseAutoFocus }: ExtendInstallLinkDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const [link] = useState(opened);
  const [by, setBy] = useState<QuickDeployLinkExtension>(DEFAULT_EXTENSION);
  const [extending, setExtending] = useState(false);
  const extendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);

  const close = () => {
    if (!extendingRef.current) onOpenChange(false);
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    if (isSessionEnded(failure)) return;
    if (failure instanceof ApiError && failure.code === "quick_deploy_link_revoked") {
      setRevoked(true);
      setError(failure.message);
      onChanged();
      return;
    }
    if ((failure instanceof ApiError && failure.code === "quick_deploy_link_not_found") || isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, EXTEND_FAILED_MESSAGE));
      onOpenChange(false);
      onChanged();
      return;
    }
    if (isUnknownOutcome(failure)) {
      toast.error(FLEETS_UNAVAILABLE_MESSAGE);
      onOpenChange(false);
      onChanged();
      return;
    }
    toast.error(fleetRefusalMessage(failure, EXTEND_FAILED_MESSAGE));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (link === null || revoked || extendingRef.current) return;
    extendingRef.current = true;
    setExtending(true);
    setError(null);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await extendQuickDeployLink(sentIn, fleetId, link.id, by, { signal: guard.signal });
    } catch (failure) {
      extendingRef.current = false;
      setExtending(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    extendingRef.current = false;
    setExtending(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success(EXTENDED_MESSAGE);
    onOpenChange(false);
    onChanged();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        hideCloseButton={extending}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (extending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (extending) event.preventDefault();
        }}
      >
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>Extend install link</DialogTitle>
            <DialogDescription>{EXTEND_DESCRIPTION}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <fieldset disabled={extending || revoked}>
              <legend className="mb-2 text-[13px] font-medium text-foreground">New expiry</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {QUICK_DEPLOY_LINK_EXTENSIONS.map((each) => (
                  <label
                    key={each}
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px] transition-colors ${
                      by === each ? "border-brand bg-brand-soft text-foreground" : "border-border text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    <input
                      type="radio"
                      name="extend-install-link-by"
                      value={each}
                      checked={by === each}
                      onChange={(change) => {
                        if (isExtension(change.target.value)) setBy(change.target.value);
                      }}
                      className="h-3.5 w-3.5"
                    />
                    {QUICK_DEPLOY_LINK_EXTENSION_LABELS[each]}
                  </label>
                ))}
              </div>
            </fieldset>
            <DialogErrorAlert error={error} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={extending}>
              Cancel
            </Button>
            {!revoked && (
              <Button type="submit" disabled={extending || link === null}>
                {extending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Extending…
                  </>
                ) : (
                  <>
                    <CalendarPlus className="mr-2 h-4 w-4" aria-hidden="true" />
                    Extend
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
