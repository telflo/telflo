import { useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import {
  NEW_PASSWORD_MAXIMUM_LENGTH,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  PASSWORD_UPDATE_FAILED_MESSAGE,
  PASSWORD_UPDATED_MESSAGE,
  PASSWORDS_DO_NOT_MATCH_MESSAGE,
  accountFailureMessage,
  isAccountRefusal,
} from "~/lib/account.js";
import { changePassword, isSessionEnded } from "~/lib/api-client.js";
import { PASSWORD_MINIMUM_LENGTH } from "@telflo/contracts";

/*
 * Settings › Account's "Change Password": "Current Password", "New Password",
 * "Confirm New Password", "Update Password" ("Updating..." while it runs).
 *
 * - Before sending, the web checks the match, then the length (in
 *   `ResetPasswordForm`'s order and words); "Confirm" is the web's alone.
 *   Over 128 characters is the API's refusal said first, in fixed words: no
 *   `maxLength`, which would cut a pasted password short without a word, and
 *   the register and reset forms have none either.
 * - `PUT /api/v1/auth/me/password`. A wrong current password shows the API's
 *   fixed message under its field, announced (`role="alert"`), and that
 *   field takes the focus again once it is enabled (unless the focus was
 *   moved out of the form meanwhile); any other refusal or a limit toasts its
 *   fixed message, anything else "Failed to update password"; a session that
 *   ended says nothing (the session-ended handler takes over). Success
 *   toasts "Password updated successfully". Every session is kept.
 * - The passwords live only in the form's own fields, uncontrolled: React
 *   writes a controlled input's value into its `value` attribute, so these
 *   never get one. They are read when the form is sent and emptied after
 *   every answer; replay masks inputs (`maskAllInputs`).
 */

type Filled = { current: boolean; next: boolean; confirm: boolean };
const NOTHING_FILLED: Filled = { current: false, next: false, confirm: false };

export function ChangePasswordCard() {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [filled, setFilled] = useState<Filled>(NOTHING_FILLED);
  const [problem, setProblem] = useState<string | null>(null);
  const [currentProblem, setCurrentProblem] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const currentField = useRef<HTMLInputElement>(null);
  // Counts wrong current passwords: after each, once the field is enabled again, it takes the focus (RenameVersionDialog's way),
  // unless the person moved it elsewhere meanwhile: only a focus that is lost (on the body, gone) or still in the form moves
  // (SessionsCard's guard). A layout effect: in the very commit that shows the alert and enables the field, not in a later
  // task.
  const [wrongPasswords, setWrongPasswords] = useState(0);
  useLayoutEffect(() => {
    if (wrongPasswords === 0) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected || form.current?.contains(active) === true) {
      currentField.current?.focus();
    }
  }, [wrongPasswords]);

  const empty = () => {
    form.current?.reset();
    setFilled(NOTHING_FILLED);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isUpdating) return;
    const fields = new FormData(event.currentTarget);
    const currentPassword = String(fields.get("currentPassword") ?? "");
    const newPassword = String(fields.get("newPassword") ?? "");
    const confirmPassword = String(fields.get("confirmPassword") ?? "");
    setCurrentProblem(null);
    if (newPassword !== confirmPassword) return setProblem(PASSWORDS_DO_NOT_MATCH_MESSAGE);
    if (newPassword.length < PASSWORD_MINIMUM_LENGTH) return setProblem(PASSWORD_TOO_SHORT_MESSAGE);
    if (newPassword.length > NEW_PASSWORD_MAXIMUM_LENGTH) return setProblem(PASSWORD_TOO_LONG_MESSAGE);
    setProblem(null);
    setIsUpdating(true);
    try {
      await changePassword({ currentPassword, newPassword });
      empty();
      toast.success(PASSWORD_UPDATED_MESSAGE);
    } catch (failure) {
      empty();
      if (isAccountRefusal(failure, "current_password_incorrect")) {
        setCurrentProblem(failure.message);
        setWrongPasswords((count) => count + 1);
      } else if (!isSessionEnded(failure)) toast.error(accountFailureMessage(failure, PASSWORD_UPDATE_FAILED_MESSAGE));
    } finally {
      setIsUpdating(false);
    }
  };

  const field = (name: keyof Filled) => (event: React.FormEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value !== "";
    setFilled((before) => (before[name] === value ? before : { ...before, [name]: value }));
  };

  const currentId = `${id}-current`;
  const newId = `${id}-new`;
  const confirmId = `${id}-confirm`;
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Change Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={form} onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={currentId}>Current Password</Label>
            <Input
              ref={currentField}
              id={currentId}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              onInput={field("current")}
              disabled={isUpdating}
              aria-invalid={currentProblem !== null}
              aria-describedby={currentProblem === null ? undefined : `${currentId}-problem`}
            />
            {currentProblem !== null && (
              <p id={`${currentId}-problem`} className="text-xs text-fail" role="alert">
                {currentProblem}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={newId}>New Password</Label>
            <Input
              id={newId}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              onInput={field("next")}
              disabled={isUpdating}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={confirmId}>Confirm New Password</Label>
            <Input
              id={confirmId}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              onInput={field("confirm")}
              disabled={isUpdating}
            />
          </div>
          {problem !== null && (
            <p role="alert" className="text-xs text-fail">
              {problem}
            </p>
          )}
          <Button type="submit" disabled={isUpdating || !filled.current || !filled.next || !filled.confirm}>
            {isUpdating ? "Updating..." : "Update Password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
