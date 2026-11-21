import { useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { UNLINK_FAILED_MESSAGE, accountFailureMessage, isAccountRefusal } from "~/lib/account.js";
import { isSessionEnded, unlinkIdentity } from "~/lib/api-client.js";

/*
 * Removing a provider's sign-in: the current password, in the DELETE's body
 * (never the URL). A wrong one shows the API's fixed message under the field,
 * announced (`role="alert"`), and the field takes the focus again once it is
 * enabled. Success toasts fixed words with the provider's configured name and
 * the card reads its methods again; another refusal (no such sign-in any
 * more, no password) toasts its fixed message and reads them again too. The
 * words say that a Google sign-in with the account's own address links it
 * again (the sign-in's link by an authoritative email still applies) exactly
 * when the API says the identity's provider re-links by email
 * (`relinksByEmail`: configured, with an email-authority rule), as the
 * "removed" email does. The password lives only in the dialog's uncontrolled
 * field, is emptied after every answer, and goes with the dialog.
 */

type UnlinkProviderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: { id: string; name: string };
  /** The identity's `relinksByEmail` from the sign-in methods: only then does signing in with it link it again. */
  relinksByEmail: boolean;
  /** The sign-in methods changed (or may have): read them again. */
  onChanged: () => void;
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the card decides. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
};

export function UnlinkProviderDialog({
  open,
  onOpenChange,
  provider,
  relinksByEmail,
  onChanged,
  onCloseAutoFocus,
}: UnlinkProviderDialogProps) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isUnlinking, setIsUnlinking] = useState(false);
  // Counts wrong passwords: after each, once the field is enabled again, it takes the focus (RenameVersionDialog's way),
  // in a layout effect: in the very commit that shows the alert and enables the field, not in a later task.
  const [wrongPasswords, setWrongPasswords] = useState(0);
  useLayoutEffect(() => {
    if (wrongPasswords > 0) field.current?.focus();
  }, [wrongPasswords]);

  const openChange = (next: boolean) => {
    if (isUnlinking) return;
    if (!next) {
      setProblem(null);
      setFilled(false);
    }
    onOpenChange(next);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isUnlinking) return;
    const currentPassword = String(new FormData(event.currentTarget).get("currentPassword") ?? "");
    setProblem(null);
    setIsUnlinking(true);
    try {
      await unlinkIdentity(provider.id, { currentPassword });
    } catch (failure) {
      form.current?.reset();
      setFilled(false);
      setIsUnlinking(false);
      if (isAccountRefusal(failure, "current_password_incorrect")) {
        setProblem(failure.message);
        setWrongPasswords((count) => count + 1);
        return;
      }
      if (isSessionEnded(failure)) return;
      onOpenChange(false);
      toast.error(accountFailureMessage(failure, UNLINK_FAILED_MESSAGE));
      onChanged();
      return;
    }
    form.current?.reset();
    setFilled(false);
    setIsUnlinking(false);
    onOpenChange(false);
    toast.success(`${provider.name} sign-in removed.`);
    onChanged();
  };

  const fieldId = `${id}-current`;
  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <form ref={form} onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Unlink {provider.name}</DialogTitle>
            <DialogDescription>
              Enter your current password to remove this sign-in. You can still sign in with your password.
              {relinksByEmail &&
                ` If your Telflo address is this ${provider.name} account's address, signing in with ${provider.name} links it again.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor={fieldId}>Current Password</Label>
            <Input
              ref={field}
              id={fieldId}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              autoFocus
              onInput={(event) => setFilled(event.currentTarget.value !== "")}
              disabled={isUnlinking}
              aria-invalid={problem !== null}
              aria-describedby={problem === null ? undefined : `${fieldId}-problem`}
            />
            {problem !== null && (
              <p id={`${fieldId}-problem`} className="text-xs text-fail" role="alert">
                {problem}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => openChange(false)} disabled={isUnlinking}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={isUnlinking || !filled}>
              {isUnlinking ? "Unlinking..." : "Unlink"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
