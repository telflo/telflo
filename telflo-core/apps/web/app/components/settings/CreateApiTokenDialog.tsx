import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
  API_TOKEN_EXPIRY_DAYS_MAXIMUM,
  API_TOKEN_EXPIRY_DAYS_MESSAGE,
  API_TOKEN_NAME_MAXIMUM_LENGTH,
} from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { isSessionEnded } from "~/lib/api-client.js";
import type { ApiTokenCalls } from "~/lib/api-tokens.js";
import { useOpeningKey } from "~/lib/hooks/use-opening-key.js";
import { API_TOKEN_CREATE_FAILED_MESSAGE, useServiceAccountTokenCalls } from "~/lib/service-accounts.js";

/*
 * "Create API token":
 *
 * - "Name" (placeholder "e.g. CI pipeline"), typed inside `ph-no-capture`,
 *   uncontrolled: no `value` attribute holds it. "Create token" is enabled
 *   once a name is typed.
 * - "Allow write access" (off: Read, the default; on: Read & write).
 * - "Expires in (days, optional)", placeholder "Never": blank is never;
 *   otherwise a whole number from 1 to 3650, checked before sending ("Enter
 *   a whole number of days from 1 to 3650."). A text field with a numeric
 *   keyboard, not `type="number"`, which gives `""` for mistyped input, so
 *   a typo can't read as "never".
 * - The create's reply is the only place the token crosses the API. It is
 *   handed to `onCreated` and kept nowhere here: the page holds it for the
 *   reveal only.
 * - A refusal toasts its fixed message and keeps the dialog; an answer that
 *   never came (no connection, a server error after the commit) toasts
 *   "Failed to create token" and the page reads the list again (a token
 *   made then can only be revoked); a refusal saying management is lost
 *   leaves through `useLeaveManagement`. Unclosable while it creates.
 * - Whose token: a service account's (its organization and id), or anyone's
 *   given as `calls` (the Account page's own tokens): the create, whether
 *   its answer still belongs on screen, and the failure words.
 */

interface CreateApiTokenDialogBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The token from the create's reply, for the reveal: shown once, then gone. */
  onCreated: (token: string) => void;
  /** A create whose answer never came: the page reads the list again. */
  onUnknownOutcome: () => void;
}

/** A service account's, or the tokens' owner's calls. */
export type CreateApiTokenDialogProps = CreateApiTokenDialogBaseProps &
  (
    | { organizationId: string; serviceAccountId: string; calls?: never }
    | { calls: ApiTokenCalls; organizationId?: never; serviceAccountId?: never }
  );

type CreateSessionProps = CreateApiTokenDialogBaseProps & { calls: ApiTokenCalls };

/** A blank expiry is never; else a whole number of days from 1 to 3650, or undefined for anything else. */
export function expiryDaysOf(typed: string): number | null | undefined {
  const text = typed.trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text)) return undefined;
  const days = Number(text);
  return days >= 1 && days <= API_TOKEN_EXPIRY_DAYS_MAXIMUM ? days : undefined;
}

/** Each opening is a new session: empty fields, Read, no problem shown. */
export function CreateApiTokenDialog(props: CreateApiTokenDialogProps) {
  const { organizationId, serviceAccountId, calls, ...rest } = props;
  if (calls !== undefined) return <CreateApiTokenSessions {...rest} calls={calls} />;
  return <ServiceAccountCreateApiTokenDialog {...rest} organizationId={organizationId} serviceAccountId={serviceAccountId} />;
}

function ServiceAccountCreateApiTokenDialog({
  organizationId,
  serviceAccountId,
  ...rest
}: CreateApiTokenDialogBaseProps & { organizationId: string; serviceAccountId: string }) {
  const calls = useServiceAccountTokenCalls(organizationId, serviceAccountId);
  return <CreateApiTokenSessions {...rest} calls={calls} />;
}

function CreateApiTokenSessions(props: CreateSessionProps) {
  const opening = useOpeningKey(props.open);
  return <CreateSession key={opening} {...props} />;
}

function CreateSession({ open, onOpenChange, calls, onCreated, onUnknownOutcome }: CreateSessionProps) {
  const id = useId();
  const [hasName, setHasName] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);
  const [expiryProblem, setExpiryProblem] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  const changeOpen = (next: boolean) => {
    if (!creatingRef.current) onOpenChange(next);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingRef.current) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name") ?? "").trim();
    if (name === "") return;
    const expiresInDays = expiryDaysOf(String(fields.get("expiresInDays") ?? ""));
    if (expiresInDays === undefined) {
      setExpiryProblem(true);
      return;
    }
    setExpiryProblem(false);
    creatingRef.current = true;
    setCreating(true);
    const isStillCurrent = calls.startCall();
    try {
      const created = await calls.create({ name, access: allowWrite ? "write" : "read", expiresInDays });
      if (!isStillCurrent()) return;
      onOpenChange(false);
      onCreated(created.token);
    } catch (failure) {
      if (!isStillCurrent() || isSessionEnded(failure)) return;
      if (calls.leaveOn(failure, () => onOpenChange(false))) return;
      toast.error(calls.failureMessage(failure, API_TOKEN_CREATE_FAILED_MESSAGE));
      if (!calls.isRefusal(failure)) onUnknownOutcome();
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const nameId = `${id}-name`;
  const writeId = `${id}-write`;
  const expiryId = `${id}-expiry`;
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create API token</DialogTitle>
            <DialogDescription>The token will be shown once. Store it somewhere safe.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="ph-no-capture space-y-1.5">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                name="name"
                maxLength={API_TOKEN_NAME_MAXIMUM_LENGTH}
                placeholder="e.g. CI pipeline"
                autoComplete="off"
                autoFocus
                readOnly={creating}
                onInput={(event) => setHasName(event.currentTarget.value.trim() !== "")}
              />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id={writeId} checked={allowWrite} onCheckedChange={(value) => setAllowWrite(value === true)} disabled={creating} />
              <div className="grid gap-0.5 leading-none">
                <Label htmlFor={writeId}>Allow write access</Label>
                <p className="text-xs text-muted-foreground">Create, update, and delete resources. Leave off for read-only.</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={expiryId}>Expires in (days, optional)</Label>
              <Input
                id={expiryId}
                name="expiresInDays"
                type="text"
                inputMode="numeric"
                placeholder="Never"
                autoComplete="off"
                readOnly={creating}
                aria-invalid={expiryProblem}
                aria-describedby={expiryProblem ? `${expiryId}-problem` : undefined}
                onInput={() => setExpiryProblem(false)}
              />
              {expiryProblem && (
                <p id={`${expiryId}-problem`} role="alert" className="text-xs text-fail">
                  {API_TOKEN_EXPIRY_DAYS_MESSAGE}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !hasName}>
              {creating ? "Creating…" : "Create token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
