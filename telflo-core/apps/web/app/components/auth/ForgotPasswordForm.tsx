import { useState } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
import { Button } from "~/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { ApiError, requestPasswordReset } from "~/lib/api-client.js";

const UNEXPECTED_ERROR_MESSAGE = "An unexpected error occurred. Please try again.";

/*
 * The forgot-password form. The API answers the same for every well-formed
 * address, so success always reads "If an account exists…". After success
 * the form stays disabled until a reload. An ApiError, a rate limit
 * included, shows its message; anything else gets the catch-all.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || isSent) return; // Guards the double-click that would send twice.
    setError(null);
    setIsSubmitting(true);

    try {
      await requestPasswordReset({ email });
      setIsSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Reset Password</CardTitle>
        <CardDescription>Enter your email to receive a password reset link</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {isSent && (
            <Alert>
              <AlertDescription>
                If an account exists with this email, you will receive a password reset link shortly.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email" name="email" type="email" autoComplete="email" required
              placeholder="you@example.com"
              value={email} onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting || isSent}
            />
          </div>
        </CardContent>

        <CardFooter className="flex flex-col space-y-4">
          <Button type="submit" className="w-full" disabled={isSubmitting || isSent}>
            {isSubmitting ? "Sending..." : "Send Reset Link"}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Remember your password?{" "}
            <Link to="/login" className="text-brand hover:underline">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
