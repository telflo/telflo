import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { SIGN_OUT_EVERYWHERE_FAILED_MESSAGE, SIGNED_OUT_EVERYWHERE_MESSAGE } from "~/lib/account.js";
import { deleteAllSessions } from "~/lib/api-client.js";
import { signOutWith } from "~/lib/use-logout.js";

/*
 * "Sign out everywhere" (D21 decision 40, Preflight ruling 38): decision
 * 40's confirm, then the existing `DELETE /api/v1/auth/sessions` (every
 * session, this one included; the API clears this browser's cookies), then
 * Logout's clean-up (`signOutWith`: the session-ended handler suspended
 * meanwhile, the stores cleared, PostHog reset; the remembered theme kept),
 * "Signed out everywhere" and `/login`. A failure leaves everything as it
 * was and toasts fixed words.
 */

export function SignOutEverywhereDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const openChange = (next: boolean) => {
    if (!isSigningOut) onOpenChange(next);
  };

  const confirm = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    if (await signOutWith(deleteAllSessions)) {
      toast.success(SIGNED_OUT_EVERYWHERE_MESSAGE);
      void navigate("/login");
      return;
    }
    setIsSigningOut(false);
    toast.error(SIGN_OUT_EVERYWHERE_FAILED_MESSAGE);
  };

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign out everywhere?</DialogTitle>
          <DialogDescription>This signs you out of Telflo in every browser, this one included.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => openChange(false)} disabled={isSigningOut}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={isSigningOut}>
            Sign out everywhere
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
