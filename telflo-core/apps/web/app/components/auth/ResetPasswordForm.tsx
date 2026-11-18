import { useEffect, useRef, useState } from "react";
import { PASSWORD_MINIMUM_LENGTH } from "@telflo/contracts";
import { Link, useNavigate } from "react-router";
import { PasswordVisibilityToggle } from "~/components/auth/RegisterForm.js";
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
import { clearStoredToken, takeAddressBarToken } from "~/lib/address-bar-token.js";
import { ApiError, resetPassword } from "~/lib/api-client.js";

const UNEXPECTED_ERROR_MESSAGE = "An unexpected error occurred. Please try again.";

/** How long the success message shows before the move to sign-in. */
export const REDIRECT_TO_LOGIN_DELAY_MS = 2000;

type FormError = { kind: "message"; message: string } | { kind: "invalid_link"; message: string };

/** The link back to `/forgot-password`, for a link that can't be used. */
function RequestNewLink() {
  return (
    <Link to="/forgot-password" className="text-brand underline-offset-4 hover:underline">
      Request a new link
    </Link>
  );
}

/** Where the page keeps the link's token for a reload (lib/address-bar-token.ts). */
export const RESET_TOKEN_STORAGE_KEY = "telflo.resetPasswordToken";

/*
 * The reset-password form (ADR 0018). The token comes from the emailed link's
 * fragment, `#token=…`, which the browser never sends to a server, so no
 * proxy or access log records it (D3 decision 9, Ruling 14). It is checked
 * only when the form is submitted, so a mail scanner that prefetches the link
 * consumes nothing.
 *
 * The server never sees the fragment, so the token is read after hydration.
 * Until then the card shows neither the form nor the missing-code alert, and
 * the server's render matches the browser's first one. Reading it also takes
 * it out of the address bar, before analytics can record the URL, and keeps
 * it for a reload of the page (D4 Ruling 14); it is forgotten once the reset
 * succeeds or the API says it is no good.
 *
 * A completed reset signs out every session and does not sign in (decision
 * 5), so success moves to `/login` after two seconds.
 */
export function ResetPasswordForm() {
  const navigate = useNavigate();
  /** `undefined` until the fragment has been read; then the token, or null. */
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUpdated, setIsUpdated] = useState(false);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setToken(takeAddressBarToken("fragment", RESET_TOKEN_STORAGE_KEY));
  }, []);

  useEffect(
    () => () => {
      if (redirectTimer.current !== null) clearTimeout(redirectTimer.current);
    },
    [],
  );

  /** Checked in order: the match first, then the length. */
  function findValidationError(): string | null {
    if (password !== confirmPassword) return "Passwords do not match";
    if (password.length < PASSWORD_MINIMUM_LENGTH) {
      return `Password must be at least ${PASSWORD_MINIMUM_LENGTH} characters`;
    }
    return null;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Guards the double-click that would send the single-use token twice.
    if (isSubmitting || isUpdated || !token) return;
    setError(null);

    const validationError = findValidationError();
    if (validationError) {
      setError({ kind: "message", message: validationError });
      return;
    }

    setIsSubmitting(true);
    try {
      await resetPassword({ token, password });
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === "invalid_reset_token") clearStoredToken(RESET_TOKEN_STORAGE_KEY);
        setError({
          kind: caught.code === "invalid_reset_token" ? "invalid_link" : "message",
          message: caught.message,
        });
      } else {
        setError({ kind: "message", message: UNEXPECTED_ERROR_MESSAGE });
      }
      setIsSubmitting(false);
      return;
    }
    clearStoredToken(RESET_TOKEN_STORAGE_KEY);
    setIsUpdated(true);
    setIsSubmitting(false);
    redirectTimer.current = setTimeout(() => void navigate("/login"), REDIRECT_TO_LOGIN_DELAY_MS);
  }

  const isDisabled = isSubmitting || isUpdated;

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Set New Password</CardTitle>
        <CardDescription>Enter your new password below</CardDescription>
      </CardHeader>

      {token === undefined ? null : token === null ? (
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>
              This link is missing its reset code. <RequestNewLink />
            </AlertDescription>
          </Alert>
        </CardContent>
      ) : (
        // noValidate, as on RegisterForm: the browser's own checks (required,
        // minLength) would preempt this page's messages and their order.
        <form onSubmit={handleSubmit} noValidate>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {error.message}
                  {error.kind === "invalid_link" && (
                    <>
                      {" "}
                      <RequestNewLink />
                    </>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {isUpdated && (
              <Alert>
                <AlertDescription>Password updated successfully! Redirecting...</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="password">New Password</Label>
              <div className="relative">
                <Input
                  id="password" name="password" type={showPassword ? "text" : "password"}
                  autoComplete="new-password" required minLength={PASSWORD_MINIMUM_LENGTH}
                  placeholder="••••••••" className="pr-10"
                  value={password} onChange={(e) => setPassword(e.target.value)} disabled={isDisabled}
                />
                <PasswordVisibilityToggle
                  isVisible={showPassword}
                  onToggle={() => setShowPassword(!showPassword)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Minimum {PASSWORD_MINIMUM_LENGTH} characters.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <div className="relative">
                <Input
                  id="confirmPassword" name="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  autoComplete="new-password" required placeholder="••••••••" className="pr-10"
                  value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={isDisabled}
                />
                <PasswordVisibilityToggle
                  isVisible={showConfirmPassword}
                  onToggle={() => setShowConfirmPassword(!showConfirmPassword)}
                />
              </div>
            </div>
          </CardContent>

          <CardFooter className="flex flex-col space-y-4">
            <Button type="submit" className="w-full" disabled={isDisabled}>
              {isSubmitting ? "Updating..." : "Update Password"}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              Remember your password?{" "}
              <Link to="/login" className="text-brand hover:underline">
                Sign in
              </Link>
            </p>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
