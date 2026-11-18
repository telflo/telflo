import { useState } from "react";
import { useRevalidator } from "react-router";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
import { Button } from "~/components/ui/button.js";
import { Checkbox } from "~/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";
import { LegalDocumentLink } from "~/components/legal/LegalDocumentLink.js";
import type { TermsToAccept } from "~/components/auth/RegisterForm.js";
import { ApiError, acceptTerms } from "~/lib/api-client.js";
import { LOGOUT_FAILED_MESSAGE, useLogout } from "~/lib/use-logout.js";

const UNEXPECTED_ERROR_MESSAGE = "An unexpected error occurred. Please try again.";

interface AcceptTermsDialogProps {
  open: boolean;
  /**
   * The site's Terms (D36-1 decisions 29 and 32): the version Accept records
   * and the two documents' URLs. Null on a site that asks for none: the
   * dialog never opens, whatever `open` says.
   */
  terms: TermsToAccept | null;
}

/**
 * The terms dialog (ADR 0018), shown by the signed-in layout while `/me`
 * says the current terms need accepting (D2c decision 6; the D2c Parity
 * Notes):
 * - it can't be dismissed: no close button, and Escape and outside clicks do
 *   nothing. `open` belongs to the layout's data alone;
 * - Accept records the site's Terms version, then revalidates the layout,
 *   whose fresh `/me` closes this. The flag isn't copied into the user
 *   store, so the loader stays its one source;
 * - Cancel logs out as the sidebar does (useLogout), and goes to `/login`;
 * - "Terms of Service" and "Privacy Policy" are links that open the site's
 *   TELFLO_TERMS_URL and TELFLO_PRIVACY_URL in a new tab (Ruling 20; D36-1
 *   decision 32);
 * - a failed Accept or Cancel says so.
 */
export function AcceptTermsDialog({ open, terms }: AcceptTermsDialogProps) {
  const revalidator = useRevalidator();
  const logout = useLogout();
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    if (terms === null) return;
    setError(null);
    setIsAccepting(true);
    try {
      await acceptTerms({ version: terms.version });
      await revalidator.revalidate();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setIsAccepting(false);
    }
  };

  const handleCancel = async () => {
    setError(null);
    if (!(await logout())) setError(LOGOUT_FAILED_MESSAGE);
  };

  return (
    <Dialog open={open && terms !== null} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md"
        hideCloseButton
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Updated Terms of Service</DialogTitle>
          <DialogDescription>
            Our Terms of Service have been updated. Please review and accept them to continue using the service.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <div className="flex items-start space-x-2">
            <Checkbox
              id="accept-terms"
              aria-labelledby="accept-terms-agreement"
              checked={agreedToTerms}
              onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
            />
            {/* The links stay outside the <label>, so following one never ticks the box. */}
            <p id="accept-terms-agreement" className="text-sm leading-tight text-muted-foreground">
              <label htmlFor="accept-terms" className="cursor-pointer">
                I agree to the
              </label>{" "}
              <LegalDocumentLink to={terms?.termsUrl ?? ""} className="text-primary">
                Terms of Service
              </LegalDocumentLink>{" "}
              and{" "}
              <LegalDocumentLink to={terms?.privacyUrl ?? ""} className="text-primary">
                Privacy Policy
              </LegalDocumentLink>
            </p>
          </div>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => void handleCancel()}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleAccept()}
            disabled={!agreedToTerms || isAccepting}
          >
            {isAccepting ? "Accepting..." : "Accept"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
