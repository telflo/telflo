import type { SignInMethodsResponse } from "@telflo/contracts";
import { useCallback, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { LinkProviderDialog, goToProvider, useBackForwardRestore } from "~/components/settings/LinkProviderDialog.js";
import type { SetPassword } from "~/components/settings/SetPasswordCard.js";
import { UnlinkProviderDialog } from "~/components/settings/UnlinkProviderDialog.js";
import { linkStartFailureMessage } from "~/lib/account.js";
import { createIdentityLinkRequest, isSessionEnded } from "~/lib/api-client.js";

/*
 * Settings › Account's "Sign-in methods" (D21 decisions 37-39): "Password",
 * "Set" or "Not set"; then each configured provider, linked ("Linked as
 * {email} on {date}" and "Unlink") or not ("Link Google", the provider's
 * configured name), and any linked identity whose provider is no longer
 * configured, named by its id, which can still be unlinked (Preflight
 * ruling 16). The page hides the card when no provider is configured and
 * the account has no identity.
 *
 * - Link: with a password, the password prompt first (LinkProviderDialog);
 *   without one, the link starts at once. Either way the browser then goes
 *   to the provider, and comes back to `?link=<code>`.
 * - Unlink needs the current password (UnlinkProviderDialog), whose words
 *   say a sign-in links it again when the identity's `relinksByEmail` says
 *   so (Ruling 92). An account with no password can't unlink its only way
 *   in: Unlink is disabled, and "Set a password first" asks for the reset
 *   link, as Set a Password does.
 * - The identity's email is visible text only (decision 45); the buttons
 *   are named by fixed words and the provider's configured name.
 * - The focus as a dialog closes (the dialogs have no Radix trigger, so
 *   Radix alone would leave it on the body; D14b Ruling 46): back to the
 *   button that opened it, unless the methods are being read again after an
 *   answer (an Unlink, or a refusal that closed it): that button is about to
 *   go, so the card's heading takes it.
 */

/** Whether the card shows: a provider is configured, or the account has an identity. */
export function showsSignInMethods(methods: SignInMethodsResponse): boolean {
  return methods.providers.length > 0 || methods.identities.length > 0;
}

/** A link's date, as "Oct 9, 2026". */
function linkedOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type SignInMethodsCardProps = {
  methods: SignInMethodsResponse;
  /** Read the methods again. */
  onChanged: () => void;
  setPassword: SetPassword;
};

type Row = { id: string; name: string; identity: SignInMethodsResponse["identities"][number] | undefined; configured: boolean };

export function SignInMethodsCard({ methods, onChanged, setPassword }: SignInMethodsCardProps) {
  const id = useId();
  const [linking, setLinking] = useState<{ id: string; name: string } | null>(null);
  const [unlinking, setUnlinking] = useState<{ id: string; name: string; relinksByEmail: boolean } | null>(null);
  const [startingFor, setStartingFor] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // The button that opened the dialog, and whether its answer reads the methods again.
  const opener = useRef<HTMLElement | null>(null);
  const changed = useRef(false);
  // Back from the provider (a password-less start): the Link buttons usable again (Ruling 89).
  useBackForwardRestore(useCallback(() => setStartingFor(null), []));

  const rows: Row[] = [
    ...methods.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      identity: methods.identities.find((identity) => identity.provider === provider.id),
      configured: true,
    })),
    ...methods.identities
      .filter((identity) => !methods.providers.some((provider) => provider.id === identity.provider))
      .map((identity) => ({ id: identity.provider, name: identity.provider, identity, configured: false })),
  ];

  /** A password-less account's link: no prompt, the start at once. */
  const startWithoutPassword = async (provider: { id: string; name: string }) => {
    if (startingFor !== null) return;
    setStartingFor(provider.id);
    try {
      const { authorizationUrl } = await createIdentityLinkRequest({ provider: provider.id });
      goToProvider(authorizationUrl);
    } catch (failure) {
      setStartingFor(null);
      if (!isSessionEnded(failure)) toast.error(linkStartFailureMessage(failure));
    }
  };

  const link = (provider: { id: string; name: string }, from: HTMLElement) => {
    if (methods.hasPassword) {
      opener.current = from;
      changed.current = false;
      setLinking(provider);
    } else void startWithoutPassword(provider);
  };

  const unlink = (provider: { id: string; name: string; relinksByEmail: boolean }, from: HTMLElement) => {
    opener.current = from;
    changed.current = false;
    setUnlinking(provider);
  };

  const readAgain = () => {
    changed.current = true;
    onChanged();
  };

  /** A dialog's `onCloseAutoFocus`: the opener, or the heading after an answer that reads the methods again. */
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const from = opener.current;
    opener.current = null;
    if (!changed.current && from?.isConnected === true && !from.matches(":disabled")) from.focus();
    else heading.current?.focus();
    changed.current = false;
  };

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle ref={heading} tabIndex={-1} className="outline-none">
          Sign-in methods
        </CardTitle>
        <CardDescription>How you can sign in to Telflo</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          <li className="flex items-center justify-between gap-4 py-3 first:pt-0">
            <span className="text-[13px] font-medium">Password</span>
            <span className="text-[13px] text-muted-foreground">{methods.hasPassword ? "Set" : "Not set"}</span>
          </li>
          {rows.map((row) => {
            const rowId = `${id}-${row.id}`;
            const { identity } = row;
            return (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-4 py-3 last:pb-0">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-[13px] font-medium">{row.name}</p>
                  {identity !== undefined && (
                    <p className="break-all text-[13px] text-muted-foreground">
                      Linked as {identity.email} on {linkedOn(identity.linkedAt)}
                    </p>
                  )}
                </div>
                {identity !== undefined ? (
                  <div className="flex items-center gap-2">
                    {!methods.hasPassword && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void setPassword.send()}
                        disabled={setPassword.state !== "idle"}
                      >
                        Set a password first
                      </Button>
                    )}
                    <span id={`${rowId}-unlink`} className="sr-only" hidden>
                      Unlink {row.name}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-labelledby={`${rowId}-unlink`}
                      disabled={!methods.hasPassword}
                      onClick={(event) =>
                        unlink(
                          { id: row.id, name: row.name, relinksByEmail: identity.relinksByEmail },
                          event.currentTarget,
                        )
                      }
                    >
                      Unlink
                    </Button>
                  </div>
                ) : (
                  row.configured && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={(event) => link({ id: row.id, name: row.name }, event.currentTarget)}
                      disabled={startingFor !== null}
                    >
                      Link {row.name}
                    </Button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
      {linking !== null && (
        <LinkProviderDialog
          open
          onOpenChange={(open) => !open && setLinking(null)}
          provider={linking}
          onCloseAutoFocus={returnFocus}
        />
      )}
      {unlinking !== null && (
        <UnlinkProviderDialog
          open
          onOpenChange={(open) => !open && setUnlinking(null)}
          provider={{ id: unlinking.id, name: unlinking.name }}
          relinksByEmail={unlinking.relinksByEmail}
          onChanged={readAgain}
          onCloseAutoFocus={returnFocus}
        />
      )}
    </Card>
  );
}
