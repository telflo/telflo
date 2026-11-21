import { useEffect, useState, type ComponentType } from "react";
import type { OidcProvider } from "@telflo/contracts";
import { Button } from "~/components/ui/button.js";
import { Separator } from "~/components/ui/separator.js";
import { GoogleIcon } from "./GoogleIcon.js";

/**
 * The providers the sign-in and register forms can draw a button for. The
 * API lists what is configured (already sorted); a provider without an icon
 * here gets no button. That is Google alone.
 */
const KNOWN_PROVIDERS = {
  google: { label: "Google", Icon: GoogleIcon },
} satisfies Record<string, { label: string; Icon: ComponentType }>;

export type KnownProviderId = keyof typeof KNOWN_PROVIDERS;

function isKnownProvider(id: string): id is KnownProviderId {
  return Object.hasOwn(KNOWN_PROVIDERS, id);
}

/** The listed providers that get a button, in the API's order. */
export function providersWithButtons(providers: readonly OidcProvider[]): KnownProviderId[] {
  return providers.map((provider) => provider.id).filter(isKnownProvider);
}

/**
 * Where a provider's button goes: the API's start endpoint, which redirects
 * to the provider. `redirectTo` is added only when given; the caller has
 * already cleaned it.
 */
export function federatedStartHref(id: KnownProviderId, redirectTo?: string): string {
  const path = `/api/v1/auth/oidc/${id}`;
  return redirectTo ? `${path}?${new URLSearchParams({ redirectTo }).toString()}` : path;
}

/**
 * Which provider's button was clicked, so the page reads "Redirecting..."
 * and holds still while the browser leaves for the provider. If the person
 * comes back with the Back button, a browser that kept the page in its
 * back/forward cache restores it exactly as it left, still redirecting and
 * disabled. A `pageshow` with `persisted` set is that restore, so the
 * state resets and the form is usable again.
 */
export function useRedirectingProvider(): [KnownProviderId | null, (id: KnownProviderId | null) => void] {
  const [redirectingId, setRedirectingId] = useState<KnownProviderId | null>(null);
  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) setRedirectingId(null);
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);
  return [redirectingId, setRedirectingId];
}

export interface FederatedSignInButtonsProps {
  providerIds: readonly KnownProviderId[];
  /** The cleaned `redirectTo`, or undefined for none. */
  redirectTo?: string | undefined;
  /** Another action is under way (an email sign-in, or a redirect already started). */
  isDisabled: boolean;
  /** The provider whose button was clicked; its label reads "Redirecting...". */
  redirectingId: KnownProviderId | null;
  onRedirect: (id: KnownProviderId) => void;
}

/**
 * A grid of outline buttons, one full-width button per provider. Each is a
 * plain link, not a client-side `<Link>`: the start endpoint is the API's,
 * and the browser must leave the app to reach the provider. Once one is
 * clicked the page navigates away; the state resets only if the page comes
 * back from the back/forward cache (useRedirectingProvider). A modified
 * click (a new tab or window) leaves this page where it is, so it doesn't
 * count as redirecting.
 */
export function FederatedSignInButtons({
  providerIds,
  redirectTo,
  isDisabled,
  redirectingId,
  onRedirect,
}: FederatedSignInButtonsProps) {
  return (
    <div className="grid gap-3">
      {providerIds.map((id) => {
        const { label, Icon } = KNOWN_PROVIDERS[id];
        return (
          <Button
            key={id} asChild variant="outline"
            className="w-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            <a
              href={federatedStartHref(id, redirectTo)}
              aria-disabled={isDisabled || undefined}
              onClick={(event) => {
                if (isDisabled) {
                  event.preventDefault();
                  return;
                }
                const isPlainClick =
                  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
                if (isPlainClick) onRedirect(id);
              }}
            >
              <Icon />
              {redirectingId === id ? "Redirecting..." : label}
            </a>
          </Button>
        );
      })}
    </div>
  );
}

/** The labeled divider: a rule with small uppercase text over it. */
export function AuthDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center">
        <Separator className="w-full" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-card px-2 text-muted-foreground">{children}</span>
      </div>
    </div>
  );
}
