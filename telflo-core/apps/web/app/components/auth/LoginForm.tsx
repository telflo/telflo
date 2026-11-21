import { useEffect, useState } from "react";
import {
  EMAIL_RESERVED_MESSAGE,
  OIDC_QUERY_ERROR_CODES,
  safeRedirectPath,
  SESSION_ERROR_CODES,
  type OidcProvider,
  type OidcQueryErrorCode,
  type SessionErrorCode,
} from "@telflo/contracts";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Eye, EyeOff } from "lucide-react";
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
import { ApiError, createSession, requestVerificationEmail } from "~/lib/api-client.js";
import { isCliAuthPath } from "~/lib/cli-auth.js";
import { useSite } from "~/lib/use-site.js";
import {
  AuthDivider,
  FederatedSignInButtons,
  providersWithButtons,
  useRedirectingProvider,
} from "./FederatedSignIn.js";

const UNEXPECTED_ERROR_MESSAGE = "An unexpected error occurred. Please try again.";
const RESEND_FAILED_MESSAGE = "Failed to resend confirmation email. Please try again.";
const SESSION_NOT_KEPT_MESSAGE =
  "You're signed in, but your browser didn't keep the session. Check that cookies are allowed for this site, then try again.";

/**
 * What `/login?error=…` says after a federated sign-in fails. `oauth_failed`
 * has its fixed text; `oauth_email_reserved` says the API's words for the
 * service accounts' domain; `registration_not_open` says a site that isn't
 * open needs an invitation; any value not listed here shows nothing.
 */
const OIDC_QUERY_ERROR_MESSAGES: Record<OidcQueryErrorCode, string> = {
  oauth_failed: "Social login failed. Please try again or use email/password.",
  oauth_email_unverified:
    "This Google account can't be used to sign in. Sign up with your email address instead.",
  oauth_email_reserved: EMAIL_RESERVED_MESSAGE,
  registration_not_open: "This site is invitation-only. Ask an organization admin for an invitation.",
};

function isOidcQueryErrorCode(value: string | null): value is OidcQueryErrorCode {
  return (OIDC_QUERY_ERROR_CODES as readonly (string | null)[]).includes(value);
}

function describeQueryError(value: string | null): string | null {
  return isOidcQueryErrorCode(value) ? OIDC_QUERY_ERROR_MESSAGES[value] : null;
}

/**
 * What the alert says for a failed sign-in. The server's own text is shown
 * where it is a known one ("Invalid login credentials") or carries the
 * retry wait; an unverified email reads "Email not confirmed". Anything
 * else, an unreachable server included, gets the catch-all. The accept
 * page's sign-in form says the same.
 */
function isSessionErrorCode(code: string): code is SessionErrorCode {
  return (SESSION_ERROR_CODES as readonly string[]).includes(code);
}

export function describeSignInError(caught: unknown): string {
  if (!(caught instanceof ApiError) || !isSessionErrorCode(caught.code)) return UNEXPECTED_ERROR_MESSAGE;
  // Narrowed to SessionErrorCode, so a misspelled case is a compile error.
  switch (caught.code) {
    case "invalid_credentials":
    case "rate_limited":
      return caught.message;
    case "email_not_verified":
      return "Email not confirmed";
    default:
      return UNEXPECTED_ERROR_MESSAGE;
  }
}

/**
 * The destination, with this page's fragment carried when it is the CLI's
 * sign-in page: `/cli-auth`'s parameters travel in the fragment, which the
 * signed-in layout's redirect kept on `/login?redirectTo=%2Fcli-auth`.
 * Nowhere else: no other page reads one.
 */
function withCliAuthFragment(destination: string): string {
  const path = destination.split(/[?#]/, 1)[0] ?? "";
  if (!isCliAuthPath(path) || destination.includes("#")) return destination;
  return destination + window.location.hash;
}

/*
 * The sign-in form. Success goes to the `redirectTo` query parameter, cleaned
 * by safeRedirectPath, with no toast. The client navigation re-runs the
 * destination's loader, which then sees the new session cookie. For the CLI's
 * sign-in page, `/cli-auth`, this page's fragment goes with it
 * (withCliAuthFragment).
 *
 * A button per configured provider with an icon (Google), then the
 * "or continue with email" divider; with none, neither renders. The button
 * carries the cleaned `redirectTo` to the API's start endpoint, and only
 * when the page has one that survives safeRedirectPath. A failed federated
 * sign-in comes back as `?error=…`, shown in the same alert.
 *
 * After "Email not confirmed", a resend prompt offers another
 * confirmation email for whatever the Email field holds when Resend is
 * clicked. The API answers the same for any address, so the success
 * text is shown for any address. A new sign-in attempt clears the prompt.
 *
 * After a successful sign-in the form stays disabled until navigation
 * unmounts it. If the location changes and the form is still here, the
 * destination sent the browser back to sign-in: the browser did not keep
 * the session cookies (Safari refuses Secure cookies on http://localhost).
 * Rather than hang on "Signing in...", the form re-enables and says so.
 */
export interface LoginFormProps {
  /** The configured providers, from the page's loader; empty for none. */
  providers: readonly OidcProvider[];
}

export function LoginForm({ providers }: LoginFormProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEmailNotConfirmed, setIsEmailNotConfirmed] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isResendSent, setIsResendSent] = useState(false);
  // "Sign up" only where anyone may: an invitation-only or closed site has no sign-up page to offer.
  const canSignUp = useSite().registration === "open";
  const location = useLocation();
  // The location key at the moment a sign-in succeeded; null otherwise.
  const [signedInAtKey, setSignedInAtKey] = useState<string | null>(null);
  const [redirectingId, setRedirectingId] = useRedirectingProvider();
  const isBusy = isSubmitting || redirectingId !== null;
  const providerIds = providersWithButtons(providers);
  // Absent or unsafe comes back "", so the start link leaves it out.
  const federatedRedirectTo = safeRedirectPath(searchParams.get("redirectTo"), "") || undefined;
  const alertMessage = error ?? describeQueryError(searchParams.get("error"));

  useEffect(() => {
    if (signedInAtKey === null || location.key === signedInAtKey) return;
    setSignedInAtKey(null);
    setError(SESSION_NOT_KEPT_MESSAGE);
    setIsSubmitting(false);
  }, [location.key, signedInAtKey]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) return; // Guards the double-click that would sign in twice.
    setError(null);
    setIsEmailNotConfirmed(false);
    setIsResendSent(false);
    setIsSubmitting(true);

    try {
      await createSession({ email, password });
    } catch (caught) {
      setIsEmailNotConfirmed(caught instanceof ApiError && caught.code === "email_not_verified");
      setError(describeSignInError(caught));
      setIsSubmitting(false);
      return;
    }
    setSignedInAtKey(location.key);
    void navigate(withCliAuthFragment(safeRedirectPath(searchParams.get("redirectTo"))));
  }

  async function handleResendConfirmation() {
    if (isResending) return;
    setIsResending(true);
    try {
      await requestVerificationEmail({ email });
      setIsResendSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : RESEND_FAILED_MESSAGE);
    } finally {
      setIsResending(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign In to Telflo</CardTitle>
        <CardDescription>Enter your credentials to access your pipelines</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {alertMessage && (
            <Alert variant="destructive">
              <AlertDescription>{alertMessage}</AlertDescription>
            </Alert>
          )}

          {isEmailNotConfirmed && !isResendSent && (
            <Alert>
              <AlertDescription className="flex items-center justify-between">
                <span>Didn&apos;t receive the confirmation email?</span>
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={() => void handleResendConfirmation()} disabled={isResending}
                >
                  {isResending ? "Sending..." : "Resend"}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {isResendSent && (
            <Alert>
              <AlertDescription>Confirmation email sent — check your inbox.</AlertDescription>
            </Alert>
          )}

          {providerIds.length > 0 && (
            <>
              <FederatedSignInButtons
                providerIds={providerIds}
                redirectTo={federatedRedirectTo}
                isDisabled={isBusy}
                redirectingId={redirectingId}
                onRedirect={setRedirectingId}
              />
              <AuthDivider>or continue with email</AuthDivider>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email" name="email" type="email" autoComplete="email" required
              placeholder="you@example.com"
              value={email} onChange={(e) => setEmail(e.target.value)} disabled={isBusy}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link to="/forgot-password" className="text-sm text-brand hover:underline">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password" name="password" type={showPassword ? "text" : "password"}
                autoComplete="current-password" required placeholder="••••••••" className="pr-10"
                value={password} onChange={(e) => setPassword(e.target.value)} disabled={isBusy}
              />
              <Button
                type="button" variant="ghost" size="sm" tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex flex-col space-y-4">
          <Button type="submit" className="w-full" disabled={isBusy}>
            {isSubmitting ? "Signing in..." : "Sign In"}
          </Button>

          {canSignUp && (
            <p className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{" "}
              <Link to="/register" className="text-brand hover:underline">
                Sign up
              </Link>
            </p>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}
