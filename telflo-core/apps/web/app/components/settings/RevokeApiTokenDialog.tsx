import { useRef, useState } from "react";
import { toast } from "sonner";
import type { ApiToken } from "@telflo/contracts";
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
import { isSessionEnded } from "~/lib/api-client.js";
import type { ApiTokenCalls } from "~/lib/api-tokens.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import {
  API_TOKEN_REVOKE_FAILED_MESSAGE,
  API_TOKEN_REVOKED_MESSAGE,
  isServiceAccountError,
  useServiceAccountTokenCalls,
} from "~/lib/service-accounts.js";

/*
 * Revoking a token (D22 decisions 9, 31, 43 and 49; Q137): the confirmation
 * "Revoke token {name}?" (the token's name as visible text in the masked
 * shell) and "Any client using it loses access immediately.", "Cancel",
 * "Revoke" ("Revoking…").
 *
 * - Success toasts "Token revoked" and the page reads the list again: the
 *   token leaves it and its name is free.
 * - `404 api_token_not_found` (revoked meanwhile, in another tab) toasts its
 *   fixed message, closes and reads the list again: the row was stale. Any
 *   other refusal or failure toasts and keeps the dialog; a refusal saying
 *   management is lost leaves through `useLeaveManagement`. Unclosable
 *   while it revokes.
 * - The token is the one the row held when the dialog opened.
 * - Whose token (D25 Preflight ruling 22): a service account's (its
 *   organization and id, D22's callers unchanged), or anyone's given as
 *   `calls` (the Account page's own tokens).
 */

interface RevokeApiTokenDialogBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: ApiToken | null;
  /** After a revoke, or a token already gone: the page reads the list again. */
  onRevoked: () => void;
}

/** A service account's (D22), or the tokens' owner's calls (D25). */
export type RevokeApiTokenDialogProps = RevokeApiTokenDialogBaseProps &
  (
    | { organizationId: string; serviceAccountId: string; calls?: never }
    | { calls: ApiTokenCalls; organizationId?: never; serviceAccountId?: never }
  );

type RevokeSessionProps = RevokeApiTokenDialogBaseProps & { calls: ApiTokenCalls };

/** Each opening is a new session: no "Revoking…" left over. */
export function RevokeApiTokenDialog(props: RevokeApiTokenDialogProps) {
  const { organizationId, serviceAccountId, calls, ...rest } = props;
  if (calls !== undefined) return <RevokeApiTokenSessions {...rest} calls={calls} />;
  return <ServiceAccountRevokeApiTokenDialog {...rest} organizationId={organizationId} serviceAccountId={serviceAccountId} />;
}

function ServiceAccountRevokeApiTokenDialog({
  organizationId,
  serviceAccountId,
  ...rest
}: RevokeApiTokenDialogBaseProps & { organizationId: string; serviceAccountId: string }) {
  const calls = useServiceAccountTokenCalls(organizationId, serviceAccountId);
  return <RevokeApiTokenSessions {...rest} calls={calls} />;
}

function RevokeApiTokenSessions(props: RevokeSessionProps) {
  const opening = useOpeningKey(props.open);
  return <RevokeSession key={opening} {...props} />;
}

function RevokeSession({ open, onOpenChange, calls, token, onRevoked }: RevokeSessionProps) {
  const [revoking, setRevoking] = useState(false);
  const revokingRef = useRef(false);

  const changeOpen = (next: boolean) => {
    if (!revokingRef.current) onOpenChange(next);
  };

  const revoke = async () => {
    if (token === null || revokingRef.current) return;
    revokingRef.current = true;
    setRevoking(true);
    const isStillCurrent = calls.startCall();
    try {
      await calls.revoke(token.id);
      if (!isStillCurrent()) return;
      toast.success(API_TOKEN_REVOKED_MESSAGE);
      onRevoked();
    } catch (failure) {
      if (!isStillCurrent() || isSessionEnded(failure)) return;
      if (calls.leaveOn(failure, () => onOpenChange(false))) return;
      toast.error(calls.failureMessage(failure, API_TOKEN_REVOKE_FAILED_MESSAGE));
      if (isServiceAccountError(failure, "api_token_not_found")) onRevoked();
    } finally {
      revokingRef.current = false;
      setRevoking(false);
    }
  };

  if (token === null) return null;
  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke token {token.name}?</AlertDialogTitle>
          <AlertDialogDescription>Any client using it loses access immediately.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void revoke();
            }}
            disabled={revoking}
            className="bg-fail text-white hover:bg-fail/90"
          >
            {revoking ? "Revoking…" : "Revoke"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
