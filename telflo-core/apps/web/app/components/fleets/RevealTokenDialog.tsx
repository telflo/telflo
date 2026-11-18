import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type EnrollmentTokenListed } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded, revealEnrollmentToken } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { DialogErrorAlert } from "./DialogErrorAlert.js";
import { SecretCopyBox } from "~/components/secrets/SecretCopyBox.js";

/*
 * Reveal (D17b-2 decisions 12, 30 and 34; Preflight ruling 4), on either
 * kind of fleet: a Dialog opened by a valid token's "Reveal".
 *
 * - "Default token" or "Rotate token" as its title; one `POST …/reveal` per
 *   opening (a bearer reply: the person's 10 a minute), "Revealing…" until
 *   it answers, then the bearer, masked, in a `SecretCopyBox` ("Copy default token" /
 *   "Copy rotate token"), inside `ph-no-capture`, as text only.
 * - Its words: either kind enrolls a collector (`Enroll` checks no kind),
 *   and each reveal is recorded in the token history; on an archived fleet
 *   (a reveal is allowed there, Preflight ruling 8), that its collectors are
 *   refused until it is unarchived.
 * - Refusals in the dialog (`enrollment_token_revoked`, `_expired`,
 *   `_not_found`, a 429 with its words), else "Failed to reveal token";
 *   `fleet_not_found` toasts, closes and reloads; an unknown outcome (the
 *   write hang guard's abort included) shows the 503's words with "Try
 *   again" (a reveal is safe to repeat). The organization's or the terms'
 *   refusal closes and revalidates the layout; a session ended is silent.
 * - After a reveal answers (made, refused for its token, or unknown) the
 *   tab and the fleet reload: the history gains the reveal, or the token's
 *   state moved.
 * - The bearer lives only in this session's state, and leaves it as the
 *   dialog closes (D17a's residue "Back or a closed tab before Done loses a
 *   create's bearers": a valid token can be revealed again). Each opening
 *   is a new session (`useOpeningKey`); an answer after the dialog unmounted
 *   or for an organization no longer active does nothing.
 */

export const REVEAL_WORDS =
  "Anyone holding this token can enroll collectors in this fleet and receive the configuration they are sent. Each reveal is recorded in the token history.";
export const REVEAL_ARCHIVED = "This fleet is archived: its collectors are refused until it is unarchived.";
export const REVEAL_FAILED_MESSAGE = "Failed to reveal token";

/** The refusals that say the token itself moved (revoked, expired, gone): the tab reads it again. */
const TOKEN_REFUSALS: ReadonlySet<string> = new Set(["enrollment_token_revoked", "enrollment_token_expired", "enrollment_token_not_found"]);

type Stage =
  | { kind: "revealing" }
  | { kind: "revealed"; bearer: string }
  | { kind: "refused"; error: string }
  /** The reveal may or may not have been made: the 503's words, "Try again". */
  | { kind: "unknown" }
  /** Closed: the bearer gone from the state. */
  | { kind: "closed" };

export interface RevealTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: EnrollmentTokenListed | null;
  /** Whether the fleet is archived: the dialog says its collectors are refused. */
  archived: boolean;
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** After a reveal answers, or a 404 for the fleet: the tab reloads, and the fleet. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: one reveal, its bearer only in this session's state. */
export function RevealTokenDialog(props: RevealTokenDialogProps) {
  const opening = useOpeningKey(props.open);
  return <RevealSession key={opening} {...props} />;
}

function RevealSession({ open, onOpenChange, token, archived, organizationId, fleetId, onChanged, onCloseAutoFocus }: RevealTokenDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const [stage, setStage] = useState<Stage>({ kind: "revealing" });
  // One reveal at a time, and one per opening: StrictMode's second effect run, or a double click on Try again, sends none.
  const revealingRef = useRef(false);
  const startedRef = useRef(false);

  const latestOnChanged = useRef(onChanged);
  useEffect(() => {
    latestOnChanged.current = onChanged;
  });

  // Closed (by the person, or from outside: an organization switch): the bearer leaves the state at once.
  if (!open && stage.kind === "revealed") setStage({ kind: "closed" });

  const reveal = useCallback(async () => {
    if (token === null || revealingRef.current) return;
    revealingRef.current = true;
    setStage({ kind: "revealing" });
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      const revealed = await revealEnrollmentToken(sentIn, fleetId, token.id, { signal: guard.signal });
      if (!isStillCurrent(sentIn)) return;
      setStage({ kind: "revealed", bearer: revealed.token.bearer });
      latestOnChanged.current();
    } catch (failure) {
      if (!isStillCurrent(sentIn)) return;
      if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
        onOpenChange(false);
        void revalidate();
        return;
      }
      // The session is over: the session-ended handler has the page.
      if (isSessionEnded(failure)) return;
      if (isFleetGone(failure)) {
        toast.error(fleetRefusalMessage(failure, REVEAL_FAILED_MESSAGE));
        onOpenChange(false);
        latestOnChanged.current();
        return;
      }
      if (isUnknownOutcome(failure)) {
        setStage({ kind: "unknown" });
        latestOnChanged.current();
        return;
      }
      setStage({ kind: "refused", error: fleetRefusalMessage(failure, REVEAL_FAILED_MESSAGE) });
      if (failure instanceof ApiError && TOKEN_REFUSALS.has(failure.code)) latestOnChanged.current();
    } finally {
      guard.clear();
      revealingRef.current = false;
    }
  }, [token, organizationId, fleetId, isStillCurrent, onOpenChange, revalidate]);

  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    void reveal();
  }, [open, reveal]);

  const close = () => onOpenChange(false);
  const copyLabel = token?.kind === "default" ? "Copy default token" : "Copy rotate token";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{token?.kind === "default" ? "Default token" : "Rotate token"}</DialogTitle>
          <DialogDescription>{REVEAL_WORDS}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-4">
          {archived && <p className="text-[13px] text-warn">{REVEAL_ARCHIVED}</p>}
          {stage.kind === "revealing" ? (
            <p role="status" className="text-[13px] text-muted-foreground">
              Revealing…
            </p>
          ) : stage.kind === "revealed" ? (
            <SecretCopyBox secret={stage.bearer} copyLabel={copyLabel} masked />
          ) : stage.kind === "refused" ? (
            <DialogErrorAlert error={stage.error} />
          ) : stage.kind === "unknown" ? (
            <div className="grid gap-2">
              <DialogErrorAlert error={FLEETS_UNAVAILABLE_MESSAGE} />
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => void reveal()}>
                  Try again
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
