import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "~/components/ui/button.js";
import { CookiePreferencesModal } from "./CookiePreferencesModal.js";
import { getConsentStatus, setConsentStatus } from "~/lib/cookie-consent.js";

/**
 * Cookie consent gate, shown on first visit until a choice is stored.
 *
 * Follows the Triumph / OneTrust pattern: a dimmed full-screen backdrop with a
 * compact card pinned to the bottom-right. "Allow all" is the one-click primary
 * action; there is no direct "reject" here — declining is only reachable by
 * opening "Cookie preferences" and turning the optional category off. This
 * nudges undecided visitors toward accepting so we can capture full analytics
 * and session replay in PostHog.
 *
 * The gate and the preferences modal are rendered one at a time (never
 * stacked), each with the same `bg-black/60` dim, so moving between them keeps
 * the page dimmed by exactly one consistent layer.
 *
 * The Cookie Policy is the site's: with TELFLO_COOKIE_POLICY_URL set, "Cookie
 * Policy" links it in a new tab, the visitor's choice still to make when they
 * come back; with it empty, the banner and the modal name no policy page.
 *
 * Consent is stored as a binary value via {@link setConsentStatus}; the
 * analytics module (lib/analytics.ts) listens for the change event and opts
 * in to capture on "accepted".
 *
 * Root renders it only when analytics is on: without PostHog there is
 * nothing to consent to.
 */
export function CookieConsentBanner({ cookiePolicyUrl }: { cookiePolicyUrl: string }) {
  const [visible, setVisible] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  // Lifted out of the preferences modal so the choice survives going back to
  // the banner (which unmounts the preferences modal).
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);

  useEffect(() => {
    if (getConsentStatus() === null) setVisible(true);
  }, []);

  if (!visible) return null;

  const handleAllowAll = () => {
    setConsentStatus("accepted");
    setVisible(false);
  };

  const handleConfirm = () => {
    setConsentStatus(analyticsEnabled ? "accepted" : "rejected");
    setVisible(false);
  };

  // Only one consent layer is shown at a time, so the page is never dimmed by
  // two stacked overlays: the preferences over the gate.
  if (showPreferences) {
    return (
      <CookiePreferencesModal
        analyticsEnabled={analyticsEnabled}
        onAnalyticsChange={setAnalyticsEnabled}
        onAllowAll={handleAllowAll}
        onConfirm={handleConfirm}
        onClose={() => setShowPreferences(false)}
        cookiePolicyUrl={cookiePolicyUrl}
      />
    );
  }

  // First layer: a dimmed gate with a card pinned bottom-right. Built on the
  // Radix Dialog primitive (same as CookiePreferencesModal) so we get a real
  // focus trap, focus restore, and scroll lock. It is deliberately
  // non-dismissible — no close button, and Escape / outside interaction are
  // suppressed — so the visitor must choose, keeping "Allow all" the path of
  // least resistance.
  const preventDismiss = (event: Event) => event.preventDefault();

  return (
    <DialogPrimitive.Root open>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onEscapeKeyDown={preventDismiss}
          onPointerDownOutside={preventDismiss}
          onInteractOutside={preventDismiss}
          className="fixed inset-x-4 bottom-4 z-[61] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-5 shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[26rem]"
        >
          <DialogPrimitive.Title className="text-base font-semibold text-white">
            Telflo uses cookies
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm leading-relaxed text-slate-300">
            We use cookies to understand how Telflo is used and to improve your
            experience.
            {cookiePolicyUrl !== "" && (
              <>
                {" "}
                See our{" "}
                <a
                  href={cookiePolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:text-primary/80"
                >
                  Cookie Policy
                </a>
                .
              </>
            )}
          </DialogPrimitive.Description>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPreferences(true)}
              className="text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            >
              Cookie preferences
            </Button>
            <Button size="sm" onClick={handleAllowAll}>
              Allow all
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
