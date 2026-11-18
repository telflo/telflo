import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type FleetType } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded, issueDefaultEnrollmentToken } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * A new default token (D17c-1 decisions 4 and 45; Preflight ruling 31), to
 * follow a revoked default token: a Dialog opened by the Tokens tab's "New
 * default token", shown while the fleet has no valid default token.
 *
 * - The title "New default token" throughout; what issuing does and that the
 *   revoked token stays revoked; "Cancel" / "Issue token" ("Issuing…").
 *   One `POST …/tokens/default` per press (a bearer reply: the person's 10
 *   a minute), under the write hang guard.
 * - **The result** shows the new token's bearer once, in a `SecretCopyBox`
 *   ("Copy default token", `ph-no-capture`, as text only), that Reveal gives
 *   it again and that each host that used the revoked token re-runs its
 *   install command (on a container host, removing the old container
 *   first); "Done". The tab and the fleet reload as it shows (the history
 *   gains the issue, and the button goes).
 * - **A Kubernetes-supervisor fleet's** words (D17d-1 Ruling 55; D17d-2
 *   Preflight ruling 32; D18 decisions 6 and 30) speak of its groups' Helm
 *   releases, not hosts' install commands: the description says a pod
 *   starting with the revoked token is refused until its group's release is
 *   upgraded with the new one, and the result to run each group's Install
 *   with Helm again, whose pods restart with the new token (the platform's
 *   chart puts a checksum of the token Secret on each workload's pods, so an
 *   upgrade with a new token rolls them, refused pods included); no
 *   container line.
 * - Refusals inline: `fleet_archived` (the fleet archived meanwhile: the tab
 *   reloads), a 429 with its words, else "Failed to issue token".
 *   `enrollment_token_default_exists` (another member issued one, or an
 *   earlier try landed: an unknown outcome's retry, or a 500 after the
 *   opamp-server had made it) reloads the tab, says "The fleet already has a
 *   valid default token: Reveal shows it." and leaves only "Close".
 *   `fleet_not_found` toasts, closes and reloads. An unknown outcome (the
 *   hang guard's abort included) shows the 503's words with "Try again" in
 *   place of "Issue token" (safe: a repeat answers 409 if the first landed),
 *   and the tab reloads. The organization's or the terms' refusal closes and
 *   revalidates the layout; a session ended is silent.
 * - While issuing: Cancel disabled, no X, Escape and outside clicks do
 *   nothing; a double click sends once. The bearer lives only in this
 *   session's state and leaves it as the dialog closes. Each opening is a
 *   new session (`useOpeningKey`); an answer after the dialog unmounted or
 *   for an organization no longer active does nothing.
 */

export const NEW_DEFAULT_TOKEN_TITLE = "New default token";
export const NEW_DEFAULT_DESCRIPTION =
  "Issues a new default token for installing collectors. The revoked one stays revoked: collectors whose supervisors restart with it are refused until their install command is re-run with the new token.";
export const NEW_DEFAULT_RESULT = "It is shown now only; Reveal gives it again. Re-run the install command on each host that used the revoked token.";
/** The re-install on a container host (D17c-1 Ruling 62): the command's fixed --name is taken by the old container. */
export const CONTAINER_REINSTALL =
  "On a container host, remove the old container first (docker rm -f telflo-collector); keep the telflo-opamp volume to keep the same collector.";
/**
 * A Kubernetes-supervisor fleet's description (D17d-1 Ruling 55; D17d-2 decision 26, Preflight rulings 17 and 32; D18
 * decision 30): its collectors come from its groups' Helm releases; a pod starting with the revoked token is refused
 * until its release is upgraded with the new one, and that upgrade rolls the group's pods (the platform's chart puts a
 * checksum of the token Secret on each workload's pod template).
 */
export const NEW_DEFAULT_DESCRIPTION_KUBERNETES =
  "Issues a new default token for installing collectors. The revoked one stays revoked: pods that start with it are refused until their group's Helm release is upgraded with the new token.";
/**
 * A Kubernetes-supervisor fleet's result (D17d-1 Ruling 55; D17d-2 Preflight ruling 32; D18 decisions 6 and 30), in
 * place of NEW_DEFAULT_RESULT and CONTAINER_REINSTALL: each group's Install with Helm again seals the new token into
 * its release's Secret, and the chart's `checksum/token` annotation on each workload's pod template changes with it,
 * so the upgrade rolls the group's pods (refused ones included), which start with the new token.
 */
export const NEW_DEFAULT_RESULT_KUBERNETES =
  "It is shown now only; Reveal gives it again. Run each group's Install with Helm again: its pods restart with the new token.";
export const DEFAULT_TOKEN_EXISTS = "The fleet already has a valid default token: Reveal shows it.";
export const ISSUE_DEFAULT_FAILED_MESSAGE = "Failed to issue token";

type Stage =
  | { kind: "form" }
  | { kind: "issuing" }
  /** Refused, with its words: "Issue token" again. */
  | { kind: "refused"; error: string }
  /** The issue may or may not have been made: the 503's words, "Try again". */
  | { kind: "unknown" }
  /** A valid default token exists: "Close" only. */
  | { kind: "exists" }
  /** The result, the bearer shown once. */
  | { kind: "issued"; bearer: string }
  /** The result after the dialog closed: the bearer gone from the state. */
  | { kind: "done" };

export interface NewDefaultTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The fleet's type: a Kubernetes-supervisor fleet's words name its groups' Helm releases (D17d-1 Ruling 55). */
  fleetType: FleetType;
  /** After an issue answers (made, unknown, a default token found, the fleet archived or gone): the tab reloads, and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: no earlier refusal or bearer. */
export function NewDefaultTokenDialog(props: NewDefaultTokenDialogProps) {
  const opening = useOpeningKey(props.open);
  return <NewDefaultSession key={opening} {...props} />;
}

function NewDefaultSession({ open, onOpenChange, organizationId, fleetId, fleetType, onChanged, onCloseAutoFocus }: NewDefaultTokenDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  // Reentry guard: a double click lands before the state re-renders.
  const issuingRef = useRef(false);

  // Closed from outside while the result shows (an organization switch closes it): the bearer leaves the state at once.
  if (!open && stage.kind === "issued") setStage({ kind: "done" });

  const issuing = stage.kind === "issuing";
  const kubernetes = fleetType === "kubernetes-supervisor";
  // What to do next with the new token: re-run the install command (a server fleet's), or reinstall the groups' Helm releases.
  const nextSteps = kubernetes ? (
    <p className="text-xs text-muted-foreground">{NEW_DEFAULT_RESULT_KUBERNETES}</p>
  ) : (
    <>
      <p className="text-xs text-muted-foreground">{NEW_DEFAULT_RESULT}</p>
      <p className="text-xs text-muted-foreground">{CONTAINER_REINSTALL}</p>
    </>
  );

  const close = () => {
    if (issuingRef.current) return;
    onOpenChange(false);
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    // The session is over: the session-ended handler has the page.
    if (isSessionEnded(failure)) return;
    if (isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, ISSUE_DEFAULT_FAILED_MESSAGE));
      onOpenChange(false);
      onChanged();
      return;
    }
    if (isUnknownOutcome(failure)) {
      setStage({ kind: "unknown" });
      onChanged();
      return;
    }
    if (failure instanceof ApiError && failure.code === "enrollment_token_default_exists") {
      setStage({ kind: "exists" });
      onChanged();
      return;
    }
    setStage({ kind: "refused", error: fleetRefusalMessage(failure, ISSUE_DEFAULT_FAILED_MESSAGE) });
    if (failure instanceof ApiError && failure.code === "fleet_archived") onChanged();
  };

  const issue = async () => {
    if (issuingRef.current) return;
    issuingRef.current = true;
    const previous = stage;
    setStage({ kind: "issuing" });
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    let bearer: string;
    try {
      bearer = (await issueDefaultEnrollmentToken(sentIn, fleetId, { signal: guard.signal })).token.bearer;
    } catch (failure) {
      issuingRef.current = false;
      // Back to what it showed, unless the refusal says otherwise (a session ended says nothing).
      setStage(previous);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    issuingRef.current = false;
    if (!isStillCurrent(sentIn)) {
      setStage(previous);
      return;
    }
    setStage({ kind: "issued", bearer });
    onChanged();
  };

  const footer = () => {
    if (stage.kind === "issued" || stage.kind === "done") {
      return (
        <Button type="button" onClick={close}>
          Done
        </Button>
      );
    }
    if (stage.kind === "exists") {
      return (
        <Button type="button" onClick={close}>
          Close
        </Button>
      );
    }
    return (
      <>
        <Button type="button" variant="outline" onClick={close} disabled={issuing}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void issue()} disabled={issuing}>
          {issuing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Issuing…
            </>
          ) : stage.kind === "unknown" ? (
            "Try again"
          ) : (
            "Issue token"
          )}
        </Button>
      </>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        hideCloseButton={issuing}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (issuing) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (issuing) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{NEW_DEFAULT_TOKEN_TITLE}</DialogTitle>
          <DialogDescription>{kubernetes ? NEW_DEFAULT_DESCRIPTION_KUBERNETES : NEW_DEFAULT_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-4">
          {stage.kind === "issued" ? (
            <>
              <SecretCopyBox secret={stage.bearer} copyLabel="Copy default token" />
              {nextSteps}
            </>
          ) : stage.kind === "done" ? (
            nextSteps
          ) : stage.kind === "refused" ? (
            <DialogErrorAlert error={stage.error} />
          ) : stage.kind === "unknown" ? (
            <DialogErrorAlert error={FLEETS_UNAVAILABLE_MESSAGE} />
          ) : stage.kind === "exists" ? (
            <DialogErrorAlert error={DEFAULT_TOKEN_EXISTS} />
          ) : null}
        </div>
        <DialogFooter>{footer()}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
