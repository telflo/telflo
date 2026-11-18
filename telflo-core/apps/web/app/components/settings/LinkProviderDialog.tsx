import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { isAccountRefusal, linkStartFailureMessage } from "~/lib/account.js";
import { createIdentityLinkRequest, isSessionEnded } from "~/lib/api-client.js";

/*
 * The password prompt before linking a provider (D21 decision 38), for an
 * account with a password: the current password goes in the link start's
 * POST body (never the URL), then the browser goes to the provider's
 * authorization URL. A wrong password shows the API's fixed message under
 * the field, announced (`role="alert"`), and the field takes the focus again
 * once it is enabled; a provider that can't be reached toasts "Linking Google didn't
 * work. Try again."; another refusal its fixed message. The title is fixed
 * words with the provider's configured name. The password lives only in the
 * dialog's uncontrolled field (no `value` attribute), is emptied after every
 * answer, and goes with the dialog when it closes (decision 45). Busy from
 * the start until the browser leaves; a page restored from the back/forward
 * cache is usable again (Ruling 89).
 */

/** The hosts a provider may be reached on over plain http: the API's loopback issuer rule (`isLoopbackHttpIssuer`). */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether the browser may go to `authorizationUrl`: an https URL, or http on
 * a loopback host (the fake provider in the browser tests, 127.0.0.1). The
 * contract's `url()` takes `javascript:` and `data:` too (Ruling 89).
 */
export function isProviderAddress(authorizationUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
}

/**
 * Sends the browser to the provider. Its own function, so the link's way out
 * is one place to read. Any other address is refused with an error in fixed
 * words (never the address); the callers then show the link's failure words.
 */
export function goToProvider(authorizationUrl: string): void {
  if (!isProviderAddress(authorizationUrl)) throw new Error("The provider's address was refused.");
  window.location.assign(authorizationUrl);
}

/**
 * Calls `restored` when the browser restores the page from its back/forward
 * cache (a `pageshow` with `persisted`): pressing Back from the provider
 * brings the page back exactly as it left, still busy. D2c Ruling 16's
 * `useRedirectingProvider` (FederatedSignIn.tsx) is the precedent; Ruling 89.
 * `restored` must keep its identity (a state setter's call).
 */
export function useBackForwardRestore(restored: () => void): void {
  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) restored();
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [restored]);
}

type LinkProviderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: { id: string; name: string };
  /** Where the focus goes once the dialog has closed (Radix's `onCloseAutoFocus`): the card decides. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
};

export function LinkProviderDialog({ open, onOpenChange, provider, onCloseAutoFocus }: LinkProviderDialogProps) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  // Counts wrong passwords: after each, once the field is enabled again, it takes the focus (RenameVersionDialog's way),
  // in a layout effect: in the very commit that shows the alert and enables the field, not in a later task (Ruling 93).
  const [wrongPasswords, setWrongPasswords] = useState(0);
  useLayoutEffect(() => {
    if (wrongPasswords > 0) field.current?.focus();
  }, [wrongPasswords]);
  // Back from the provider: the dialog usable again (Cancel, Escape, a new start).
  useBackForwardRestore(useCallback(() => setIsStarting(false), []));

  const openChange = (next: boolean) => {
    if (isStarting) return;
    if (!next) {
      setProblem(null);
      setFilled(false);
    }
    onOpenChange(next);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isStarting) return;
    const currentPassword = String(new FormData(event.currentTarget).get("currentPassword") ?? "");
    setProblem(null);
    setIsStarting(true);
    try {
      const { authorizationUrl } = await createIdentityLinkRequest({ provider: provider.id, currentPassword });
      form.current?.reset();
      setFilled(false);
      // Busy until the browser leaves for the provider.
      goToProvider(authorizationUrl);
    } catch (failure) {
      form.current?.reset();
      setFilled(false);
      setIsStarting(false);
      if (isAccountRefusal(failure, "current_password_incorrect")) {
        setProblem(failure.message);
        setWrongPasswords((count) => count + 1);
        return;
      }
      onOpenChange(false);
      if (!isSessionEnded(failure)) toast.error(linkStartFailureMessage(failure));
    }
  };

  const fieldId = `${id}-current`;
  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <form ref={form} onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Link {provider.name}</DialogTitle>
            <DialogDescription>Enter your current password to continue to {provider.name}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor={fieldId}>Current Password</Label>
            <Input
              ref={field}
              id={fieldId}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              autoFocus
              onInput={(event) => setFilled(event.currentTarget.value !== "")}
              disabled={isStarting}
              aria-invalid={problem !== null}
              aria-describedby={problem === null ? undefined : `${fieldId}-problem`}
            />
            {problem !== null && (
              <p id={`${fieldId}-problem`} className="text-xs text-fail" role="alert">
                {problem}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => openChange(false)} disabled={isStarting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isStarting || !filled}>
              {isStarting ? "Continuing..." : "Continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
