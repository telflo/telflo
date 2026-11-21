import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";
import { FLEETS_UNAVAILABLE_MESSAGE, type EnrollmentTokenListed, type FleetType } from "@telflo/contracts";
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
import { abortAfter } from "~/lib/abort-after.js";
import { ApiError, isSessionEnded, revokeEnrollmentToken } from "~/lib/api-client.js";
import { isOrganizationGone, isTermsAcceptanceRequired, useStillCurrent } from "~/lib/configurations.js";
import { FLEET_WRITE_TIMEOUT_MS, fleetRefusalMessage, isFleetGone, isUnknownOutcome } from "~/lib/fleets.js";
import { formatDateTime } from "~/lib/format.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { currentRotateToken, tokenValidAt } from "~/lib/tokens.js";

/*
 * Revoke: an AlertDialog with "Revoke this token?", "Cancel" / "Revoke
 * token" ("Revoking..."), "Token revoked" and "Failed to revoke token". Its
 * details:
 *
 * - The body by the token's kind and the fleet's tokens at the render (the
 *   opamp-server's rules, `lib/tokens.ts`):
 *   - a rotate token: its collectors are refused within 10 seconds and stay
 *     refused until their supervisors restart, coming back through the
 *     default token (when the fleet's tokens hold no valid default token,
 *     the clause saying to issue a new one and re-install them), and, only
 *     while another valid rotate token remains, handed the fleet's current
 *     one (they don't fall back to the default bearer on their next poll);
 *     the fleet's only valid rotate token: the suspension;
 *     the current token while another is valid: that one becomes current
 *     until its own expiry (said only when another is valid);
 *   - the default token: what refusing it does now, and that a new one can
 *     then be issued ("New default token" on the Tokens tab) and the
 *     install command re-run on each host (on a Kubernetes-supervisor
 *     fleet, each group's Helm release reinstalled);
 *   - the active count, the API's activeCollectors: collectors seen in
 *     the last 5 minutes that are on (hold) the token now ("1 collector
 *     seen in the last 5 minutes is on it.", destructive; "No collector
 *     seen in the last 5 minutes is on it.").
 * - It stays open until the API answers; Escape does nothing meanwhile;
 *   Cancel is disabled; a double click sends once.
 * - "Token revoked" toasts, closes, and reloads the tab and the fleet. A 404
 *   (the token, or the fleet) toasts the API's words, closes and reloads;
 *   an unknown outcome toasts the 503's words, closes and reloads (a revoke
 *   is idempotent). Any other refusal (a 429 with its words) toasts and
 *   stays open, else "Failed to revoke token". The organization's or the
 *   terms' refusal closes and revalidates the layout; a session ended is
 *   silent.
 */

export const REVOKE_FAILED_MESSAGE = "Failed to revoke token";

const ROTATE_REFUSED = "Collectors holding it are refused within 10 seconds and stay refused until their supervisors restart; they then come back through the default token";
const HANDED_CURRENT = " and are handed the fleet's current rotate token";

/**
 * The clause after "the default token" when the fleet's tokens show none valid: a collector coming back through it is
 * refused too, until a new default token is issued and the collector installed again with it.
 */
export const NO_VALID_DEFAULT_CLAUSE = " (the fleet has no valid default token now: issue a new default token and re-install them)";
/** NO_VALID_DEFAULT_CLAUSE for a sentence about one collector (the rotate dialog's info box). */
export const NO_VALID_DEFAULT_CLAUSE_ONE = " (the fleet has no valid default token now: issue a new default token and re-install it)";

/** Whether the fleet's tokens, as read, hold no valid default token (a default token never expires: not revoked). */
export function noValidDefaultToken(tokens: readonly EnrollmentTokenListed[], now: number): boolean {
  return !tokens.some((token) => token.kind === "default" && tokenValidAt(token, now));
}

export const ONLY_VALID_ROTATE =
  "This is the fleet's only valid rotate token. Revoking it suspends the fleet: collectors that enroll or restart are sent no configuration until you rotate again.";

/** ONLY_VALID_ROTATE, with NO_VALID_DEFAULT_CLAUSE when the fleet has no valid default token (restarting collectors are refused). */
export function onlyValidRotateWords(noValidDefault: boolean): string {
  return noValidDefault ? `${ONLY_VALID_ROTATE.slice(0, -1)}${NO_VALID_DEFAULT_CLAUSE}.` : ONLY_VALID_ROTATE;
}

export const DEFAULT_REVOKE =
  "Collectors still on the default token (those that don't accept connection settings, and every collector while the fleet is suspended) are refused within 10 seconds. New collectors can no longer enroll with it, and collectors whose supervisors restart are refused (they present it). You can then issue a new default token and re-run the install command on each host.";

/**
 * DEFAULT_REVOKE on a Kubernetes-supervisor fleet: its collectors come from its groups' Helm releases, which the Helm
 * install dialog upgrades.
 */
export const DEFAULT_REVOKE_KUBERNETES = `${DEFAULT_REVOKE.slice(0, DEFAULT_REVOKE.lastIndexOf(" You can"))} You can issue a new default token, then run each group's Install with Helm again.`;

/**
 * The rotate token's first sentence: the hand-off clause only while another valid rotate token remains, and
 * NO_VALID_DEFAULT_CLAUSE when the fleet has no valid default token to come back through.
 */
export function rotateRefusedWords(anotherValid: boolean, noValidDefault = false): string {
  return `${ROTATE_REFUSED}${noValidDefault ? NO_VALID_DEFAULT_CLAUSE : ""}${anotherValid ? HANDED_CURRENT : ""}.`;
}

/**
 * "Another valid rotate token, one being replaced, becomes current until it expires on {date}: …", with
 * NO_VALID_DEFAULT_CLAUSE after "handed it" when the fleet has no valid default token.
 */
export function successorWords(expiresAt: string | null, noValidDefault = false): string {
  const clause = noValidDefault ? NO_VALID_DEFAULT_CLAUSE : "";
  if (expiresAt === null) return `Another valid rotate token, one being replaced, becomes current: collectors that enroll or restart are handed it${clause}.`;
  return `Another valid rotate token, one being replaced, becomes current until it expires on ${formatDateTime(expiresAt)}: collectors that enroll or restart are handed it${clause}, and are refused when it expires. Rotate before then.`;
}

/** The active count's sentence: collectors seen in the last 5 minutes that are on the token now. */
export function activeWords(count: number): string {
  if (count === 0) return "No collector seen in the last 5 minutes is on it.";
  if (count === 1) return "1 collector seen in the last 5 minutes is on it.";
  return `${count} collectors seen in the last 5 minutes are on it.`;
}

/**
 * What revoking `token` does, among the fleet's `tokens` at `now`: for a
 * rotate token, whether another valid one remains, whether it is the only
 * valid one, and the one that becomes current when it is the current token.
 */
export function revokeConsequences(token: EnrollmentTokenListed, tokens: readonly EnrollmentTokenListed[], now: number) {
  const others = tokens.filter((each) => each.id !== token.id);
  const anotherValid = others.some((each) => each.kind === "rotate" && tokenValidAt(each, now));
  const isCurrent = currentRotateToken(tokens, now)?.id === token.id;
  return {
    anotherValid,
    onlyValid: token.kind === "rotate" && tokenValidAt(token, now) && !anotherValid,
    successor: isCurrent && anotherValid ? (currentRotateToken(others, now) ?? null) : null,
    // The tab's tokens as read (never empty once read: a fleet always has its default token, revoked or not).
    noValidDefault: tokens.length > 0 && noValidDefaultToken(tokens, now),
  };
}

export interface RevokeTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: EnrollmentTokenListed | null;
  /** The tab's tokens: what revoking this one does. */
  tokens: readonly EnrollmentTokenListed[];
  /** The active organization the dialog was opened in. */
  organizationId: string;
  fleetId: string;
  /** The fleet's type: a Kubernetes-supervisor fleet's default token words name its groups' Helm releases. */
  fleetType: FleetType;
  /** After the revoke, a 404, or an unknown outcome: the tab reloads, and the fleet. */
  onRevoked: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the tab gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
}

/** Each opening is a new session: nothing of an earlier one's revoke carries over. */
export function RevokeTokenDialog(props: RevokeTokenDialogProps) {
  const opening = useOpeningKey(props.open);
  return <RevokeSession key={opening} {...props} />;
}

function RevokeSession({ open, onOpenChange, token, tokens, organizationId, fleetId, fleetType, onRevoked, onCloseAutoFocus }: RevokeTokenDialogProps) {
  const { revalidate } = useRevalidator();
  const isStillCurrent = useStillCurrent(organizationId);
  const [isRevoking, setIsRevoking] = useState(false);
  const revokingRef = useRef(false);

  const close = () => {
    if (!revokingRef.current) onOpenChange(false);
  };

  const refused = (failure: unknown) => {
    if (isOrganizationGone(failure) || isTermsAcceptanceRequired(failure)) {
      onOpenChange(false);
      void revalidate();
      return;
    }
    if (isSessionEnded(failure)) return;
    if ((failure instanceof ApiError && failure.code === "enrollment_token_not_found") || isFleetGone(failure)) {
      toast.error(fleetRefusalMessage(failure, REVOKE_FAILED_MESSAGE));
      onOpenChange(false);
      onRevoked();
      return;
    }
    if (isUnknownOutcome(failure)) {
      toast.error(FLEETS_UNAVAILABLE_MESSAGE);
      onOpenChange(false);
      onRevoked();
      return;
    }
    toast.error(fleetRefusalMessage(failure, REVOKE_FAILED_MESSAGE));
  };

  const handleRevoke = async () => {
    if (token === null || revokingRef.current) return;
    revokingRef.current = true;
    setIsRevoking(true);
    const sentIn = organizationId;
    const guard = abortAfter(FLEET_WRITE_TIMEOUT_MS);
    try {
      await revokeEnrollmentToken(sentIn, fleetId, token.id, { signal: guard.signal });
    } catch (failure) {
      revokingRef.current = false;
      setIsRevoking(false);
      if (isStillCurrent(sentIn)) refused(failure);
      return;
    } finally {
      guard.clear();
    }
    revokingRef.current = false;
    setIsRevoking(false);
    if (!isStillCurrent(sentIn)) return;
    toast.success("Token revoked");
    onOpenChange(false);
    onRevoked();
  };

  const consequences = token === null ? null : revokeConsequences(token, tokens, Date.now());

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (isRevoking) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this token?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {token !== null && consequences !== null && (
                <>
                  <p>
                    {token.kind === "default"
                      ? fleetType === "kubernetes-supervisor"
                        ? DEFAULT_REVOKE_KUBERNETES
                        : DEFAULT_REVOKE
                      : rotateRefusedWords(consequences.anotherValid, consequences.noValidDefault)}
                  </p>
                  <p className={token.activeCollectors > 0 ? "font-medium text-fail" : undefined}>{activeWords(token.activeCollectors)}</p>
                  {consequences.onlyValid && <p className="font-medium text-warn">{onlyValidRotateWords(consequences.noValidDefault)}</p>}
                  {consequences.successor !== null && <p>{successorWords(consequences.successor.expiresAt, consequences.noValidDefault)}</p>}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog open while the revoke runs; it closes itself when the API answers.
              event.preventDefault();
              void handleRevoke();
            }}
            disabled={isRevoking}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isRevoking ? "Revoking..." : "Revoke token"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
