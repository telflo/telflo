import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Cross2Icon } from "@radix-ui/react-icons";
import { Button } from "~/components/ui/button.js";
import { Switch } from "~/components/ui/switch.js";

interface CookiePreferencesModalProps {
  /** Current state of the optional analytics + session replay toggle. Held by
   *  the parent so it survives going back to the banner. */
  analyticsEnabled: boolean;
  /** Toggle the optional analytics + session replay category. */
  onAnalyticsChange: (enabled: boolean) => void;
  /** Accept every category (the one-click path). */
  onAllowAll: () => void;
  /** Save the current toggle state — maps to our binary consent
   *  (analytics on → "accepted", off → "rejected"). */
  onConfirm: () => void;
  /** Dismiss the modal without deciding (returns to the banner). */
  onClose: () => void;
  /**
   * The site's TELFLO_COOKIE_POLICY_URL (D36-1 decision 33): "Read more"
   * links it in a new tab; with "" the modal names no policy.
   */
  cookiePolicyUrl: string;
}

/**
 * The "Cookie preferences" layer, opened from the consent banner. Mirrors the
 * Triumph / OneTrust pattern: strictly-necessary cookies are always on, and a
 * single optional category (analytics + session replay) is OFF by default, so
 * the visitor has to opt in deliberately. "Allow all" stays the easiest path.
 *
 * Telflo's stored consent is binary ("accepted" | "rejected"), and accepting
 * enables both PostHog product analytics and session replay together, so we
 * present them as one honest toggle rather than implying granular control we
 * don't actually persist.
 *
 * Uses the same raw Radix Dialog + `bg-black/60` overlay as the consent banner,
 * and is rendered as the only consent layer at a time (see
 * CookieConsentBanner), so the page stays dimmed by exactly one consistent
 * layer no matter which screen you're on.
 */
export function CookiePreferencesModal({
  analyticsEnabled,
  onAnalyticsChange,
  onAllowAll,
  onConfirm,
  onClose,
  cookiePolicyUrl,
}: CookiePreferencesModalProps) {
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="space-y-1.5 pr-8">
            <DialogPrimitive.Title className="text-lg font-semibold text-white">
              Your privacy options
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-sm text-slate-400">
              When you visit Telflo we store or retrieve information in your
              browser, mostly as cookies. Strictly necessary cookies keep the app
              working; optional cookies help us understand usage and improve the
              product. You can allow all, or choose what to enable below.
            </DialogPrimitive.Description>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {/* Strictly necessary — always on, no toggle. */}
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-sm font-medium text-white">
                  Strictly necessary cookies
                </h3>
                <span className="shrink-0 text-xs font-medium text-primary">
                  Always active
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                Required for Telflo to work — authentication, security, and
                remembering your preferences. These can&apos;t be switched off.
              </p>
            </div>

            {/* Analytics & session replay — optional, OFF by default. */}
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex items-center justify-between gap-4">
                <h3
                  id="cookie-analytics-label"
                  className="text-sm font-medium text-white"
                >
                  Analytics &amp; session replay
                </h3>
                <Switch
                  checked={analyticsEnabled}
                  onCheckedChange={onAnalyticsChange}
                  aria-labelledby="cookie-analytics-label"
                  aria-describedby="cookie-analytics-desc"
                />
              </div>
              <p
                id="cookie-analytics-desc"
                className="mt-1.5 text-xs leading-relaxed text-slate-400"
              >
                Helps us understand how Telflo is used and reproduce issues
                (PostHog product analytics and session replay). Never includes
                the contents of your pipelines.
              </p>
            </div>
          </div>

          {cookiePolicyUrl !== "" && (
            <p className="text-xs text-slate-400">
              Read more in our{" "}
              <a
                href={cookiePolicyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                Cookie Policy
              </a>
              .
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              onClick={onConfirm}
              className="border-slate-700 bg-transparent text-slate-200 hover:bg-slate-800 hover:text-white"
            >
              Confirm my choices
            </Button>
            <Button onClick={onAllowAll}>Allow all</Button>
          </div>

          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-slate-400 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-600">
            <Cross2Icon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
