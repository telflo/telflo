import { useState } from "react";
import { PASSWORD_MINIMUM_LENGTH, type OidcProvider, type SiteTerms } from "@telflo/contracts";
import { Link } from "react-router";
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
import { Checkbox } from "~/components/ui/checkbox.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { LegalDocumentLink } from "~/components/legal/LegalDocumentLink.js";
import { captureEvent } from "~/lib/analytics.js";
import { ApiError, postRegister } from "~/lib/api-client.js";
import {
  AuthDivider,
  FederatedSignInButtons,
  providersWithButtons,
  useRedirectingProvider,
} from "./FederatedSignIn.js";

/** What the forms ask a person to accept: the version and where its two documents are read. */
export type TermsToAccept = Pick<SiteTerms, "version" | "termsUrl" | "privacyUrl">;

export interface RegisterFormProps {
  /** The site's Terms (lib/use-site.ts' termsToAccept), or null when it asks for none: no agreement, no version sent. */
  terms: TermsToAccept | null;
  onSuccess: () => void;
  /** The configured providers, from the page's loader; empty for none. */
  providers: readonly OidcProvider[];
}

/**
 * A plausibility check only — the server's Zod schema remains the authority
 * on what is actually a valid address. This just keeps an obviously-wrong
 * value from making a round trip when every other field fails instantly.
 */
function isPlausibleEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value);
}

/*
 * The register form: "Register with a social account", a button per
 * configured provider with an icon (Google), then "or with an email" and the
 * form. With no such provider, neither the buttons nor their dividers
 * render. Consent is an explicit checkbox, not an implied "by creating an
 * account you agree" line; a federated sign-up accepts the terms after it
 * signs in. Its "Terms of Service" and "Privacy Policy" open the site's URLs
 * in a new tab. A site that asks for no Terms gets neither the "Usage
 * policies" divider nor the checkbox, and the request carries no version.
 */
export function RegisterForm({ terms, onSuccess, providers }: RegisterFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [redirectingId, setRedirectingId] = useRedirectingProvider();
  const isBusy = isSubmitting || redirectingId !== null;
  const providerIds = providersWithButtons(providers);

  /** Client-side checks are courtesy; the server validates the same rules. */
  function findValidationError(): string | null {
    if (!isPlausibleEmail(email)) return "Enter a valid email address.";
    if (password !== confirmPassword) return "Passwords do not match.";
    if (password.length < PASSWORD_MINIMUM_LENGTH) {
      return `Password must be at least ${PASSWORD_MINIMUM_LENGTH} characters.`;
    }
    if (terms !== null && !hasAcceptedTerms) return "You must accept the terms to continue.";
    return null;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) return; // Guards the double-click that would register twice.
    setError(null);

    const validationError = findValidationError();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSubmitting(true);
    try {
      await postRegister({ email, password, ...(terms !== null && { acceptedTermsVersion: terms.version }) });
      // The sign-up event, when analytics is on. The API answers the same
      // for an address that is already registered, so every accepted
      // registration counts.
      captureEvent("user_signed_up", { method: "email" });
      onSuccess();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Create Account</CardTitle>
        <CardDescription>Sign up to start building OpenTelemetry pipelines</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit} noValidate>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {providerIds.length > 0 && (
            <>
              <AuthDivider>Register with a social account</AuthDivider>
              <FederatedSignInButtons
                providerIds={providerIds}
                isDisabled={isBusy}
                redirectingId={redirectingId}
                onRedirect={setRedirectingId}
              />
              <AuthDivider>or with an email</AuthDivider>
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
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password" name="password" type={showPassword ? "text" : "password"}
                autoComplete="new-password" required placeholder="••••••••" className="pr-10"
                value={password} onChange={(e) => setPassword(e.target.value)} disabled={isBusy}
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
                disabled={isBusy}
              />
              <PasswordVisibilityToggle
                isVisible={showConfirmPassword}
                onToggle={() => setShowConfirmPassword(!showConfirmPassword)}
              />
            </div>
          </div>

          {terms !== null && (
            <>
              <AuthDivider>Usage policies</AuthDivider>

              <TermsAgreement terms={terms} checked={hasAcceptedTerms} onCheckedChange={setHasAcceptedTerms} disabled={isBusy} />
            </>
          )}
        </CardContent>

        <CardFooter className="flex flex-col space-y-4">
          <Button type="submit" className="w-full" disabled={isBusy}>
            {isSubmitting ? "Creating account…" : "Create Account"}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-brand hover:underline">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The eye button inside a password field. Out of the tab order, so tabbing
 * moves between fields rather than stopping on it. ResetPasswordForm uses it
 * too.
 */
export function PasswordVisibilityToggle({
  isVisible,
  onToggle,
}: {
  isVisible: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button" variant="ghost" size="sm" tabIndex={-1}
      aria-label={isVisible ? "Hide password" : "Show password"}
      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
      onClick={onToggle}
    >
      {isVisible ? (
        <EyeOff className="h-4 w-4 text-muted-foreground" />
      ) : (
        <Eye className="h-4 w-4 text-muted-foreground" />
      )}
    </Button>
  );
}

/**
 * The terms checkbox and its links, to the site's Terms and privacy URLs.
 * The accept page's account form uses it too.
 */
export function TermsAgreement({
  terms,
  checked,
  onCheckedChange,
  disabled,
}: {
  terms: Pick<TermsToAccept, "termsUrl" | "privacyUrl">;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id="terms" name="terms" className="mt-0.5"
        aria-labelledby="terms-agreement"
        checked={checked}
        onCheckedChange={(state) => onCheckedChange(state === true)}
        disabled={disabled}
      />
      {/* The links stay outside the <Label>, so following one never ticks the box. */}
      <p
        id="terms-agreement"
        className="text-xs leading-relaxed font-medium text-muted-foreground peer-disabled:opacity-70"
      >
        <Label htmlFor="terms" className="inline text-xs leading-relaxed text-muted-foreground">
          I agree to the
        </Label>{" "}
        <LegalDocumentLink to={terms.termsUrl} className="text-brand">
          Terms of Service
        </LegalDocumentLink>{" "}
        and{" "}
        <LegalDocumentLink to={terms.privacyUrl} className="text-brand">
          Privacy Policy
        </LegalDocumentLink>
      </p>
    </div>
  );
}
