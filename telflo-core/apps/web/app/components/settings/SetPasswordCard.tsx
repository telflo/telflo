import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { SET_PASSWORD_DESCRIPTION, SET_PASSWORD_FAILED_MESSAGE, accountFailureMessage, setPasswordSentWords } from "~/lib/account.js";
import { isSessionEnded, requestPasswordReset } from "~/lib/api-client.js";

/*
 * Settings › Account's "Set a Password", for an account with no password:
 * the password reset link, asked for the account's own email through the
 * existing `POST /api/v1/auth/password-reset-requests` (always 202; its
 * own limits). Then fixed words with the email as visible text (never a
 * toast). Sign-in methods' "Set a password first" runs the same request,
 * so the page holds one `useSetPassword` for both.
 */

export type SetPassword = {
  state: "idle" | "sending" | "sent";
  /** Asks for the link. Nothing while one is being asked for. */
  send: () => Promise<void>;
};

/** Asking for the reset link for `email`, the account's own. A failure toasts fixed words; a session that ended says nothing. */
export function useSetPassword(email: string): SetPassword {
  const [state, setState] = useState<SetPassword["state"]>("idle");
  const sending = useRef(false);
  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    setState("sending");
    try {
      await requestPasswordReset({ email });
      setState("sent");
    } catch (failure) {
      setState("idle");
      if (!isSessionEnded(failure)) toast.error(accountFailureMessage(failure, SET_PASSWORD_FAILED_MESSAGE));
    } finally {
      sending.current = false;
    }
  }, [email]);
  return { state, send };
}

export function SetPasswordCard({ email, setPassword }: { email: string; setPassword: SetPassword }) {
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Set a Password</CardTitle>
        <CardDescription>{SET_PASSWORD_DESCRIPTION}</CardDescription>
      </CardHeader>
      <CardContent>
        {setPassword.state === "sent" ? (
          <p role="status" className="text-[13px]">
            {setPasswordSentWords(email)}
          </p>
        ) : (
          <Button type="button" onClick={() => void setPassword.send()} disabled={setPassword.state === "sending"}>
            {setPassword.state === "sending" ? "Sending..." : "Email me a link"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
