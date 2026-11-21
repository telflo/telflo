import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
import { Button } from "~/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { ApiError, postVerifyEmail, requestVerificationEmail } from "~/lib/api-client.js";

const RESEND_FAILED_MESSAGE = "Failed to resend confirmation email. Please try again.";

type PanelState =
  | { kind: "pending" }
  | { kind: "verified" }
  | { kind: "already_verified" }
  | { kind: "failed"; message: string };

export interface VerifyEmailPanelProps {
  /** The link's token, null when it has none, or undefined until the page has read it. */
  token: string | null | undefined;
}

export function VerifyEmailPanel({ token }: VerifyEmailPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "pending" });
  // A verification token is single-use, so submitting it twice burns it. React
  // strict mode mounts effects twice in development, which would do exactly
  // that; this ref makes the submission happen once regardless.
  const hasSubmitted = useRef(false);

  useEffect(() => {
    if (token === undefined || hasSubmitted.current) return;
    hasSubmitted.current = true;

    if (!token) {
      setState({
        kind: "failed",
        message: "This link is missing its confirmation code. Try the link from your email again.",
      });
      return;
    }

    void postVerifyEmail({ token })
      .then((result) => setState({ kind: result.status }))
      .catch((caught: unknown) =>
        setState({
          kind: "failed",
          message:
            caught instanceof ApiError
              ? caught.message
              : "Something went wrong confirming your email. Please try again.",
        }),
      );
  }, [token]);

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader className="space-y-4">
        {state.kind === "pending" && (
          <CardDescription>Confirming your email…</CardDescription>
        )}

        {state.kind === "verified" && (
          <>
            <CardTitle>Your email address is confirmed</CardTitle>
            <CardDescription>You can now sign in.</CardDescription>
            <Button asChild className="w-full">
              <Link to="/login">Sign in</Link>
            </Button>
          </>
        )}

        {state.kind === "already_verified" && (
          <>
            <CardTitle>Already confirmed</CardTitle>
            <CardDescription>
              This email address was confirmed previously. Nothing more to do.
            </CardDescription>
            <Button asChild className="w-full">
              <Link to="/login">Sign in</Link>
            </Button>
          </>
        )}

        {state.kind === "failed" && (
          <>
            <CardTitle>We could not confirm your email</CardTitle>
            <Alert variant="destructive">
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          </>
        )}
      </CardHeader>

      {state.kind === "failed" && (
        <CardContent>
          <ResendConfirmationForm />
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Asks for another confirmation email for the typed address. The API
 * answers the same whether or not the address has an unconfirmed account,
 * so the success text says so.
 */
function ResendConfirmationForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return; // Guards the double-click that would send twice.
    setError(null);
    setIsSubmitting(true);
    try {
      await requestVerificationEmail({ email });
      setIsSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : RESEND_FAILED_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isSent) {
    return (
      <p className="text-sm text-muted-foreground">
        If that address has an unconfirmed account, we have sent a new confirmation link to it.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="resend-email">Email</Label>
        <Input
          id="resend-email" name="email" type="email" autoComplete="email" required
          placeholder="you@example.com"
          value={email} onChange={(e) => setEmail(e.target.value)} disabled={isSubmitting}
        />
      </div>
      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Sending..." : "Send a new link"}
      </Button>
    </form>
  );
}
