import type { SignInMethodsResponse } from "@telflo/contracts";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AccountCard } from "~/components/settings/AccountCard.js";
import { ChangePasswordCard } from "~/components/settings/ChangePasswordCard.js";
import { PersonalApiTokensCard } from "~/components/settings/PersonalApiTokensCard.js";
import { SessionsCard } from "~/components/settings/SessionsCard.js";
import { SetPasswordCard, useSetPassword } from "~/components/settings/SetPasswordCard.js";
import { SignInMethodsCard, showsSignInMethods } from "~/components/settings/SignInMethodsCard.js";
import { Button } from "~/components/ui/button.js";
import { Card, CardContent } from "~/components/ui/card.js";
import { LINK_RESULT_WORDS, SIGN_IN_METHODS_LOAD_FAILED_MESSAGE, isLinkResultCode, useAccountRead } from "~/lib/account.js";
import { getSignInMethods } from "~/lib/api-client.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/**
 * Settings › Account, its cards in order: Account; Change Password, or Set a
 * Password for an account with none; Sign-in methods, hidden when no provider
 * is configured and the account has no identity; Sessions; API tokens, the
 * person's own, last. The sign-in methods are read once for the second and
 * third cards ("Loading…", or "Failed to load sign-in methods" with "Try
 * again"). Set a Password and "Set a password first" share one request.
 *
 * A link's way back, `?link=<code>`, toasts the code's fixed words (`linked`
 * a success, the rest errors) and is removed with `replace`, as
 * `?joined_org=` is (routes/app-layout.tsx), so a refresh or Back never
 * shows it again; an unknown code is removed and shows nothing. Handled once
 * per code, so a second run of the effect never toasts twice.
 */

const loadSignInMethods = (signal: AbortSignal): Promise<SignInMethodsResponse> => getSignInMethods({ signal });

function useLinkResult(): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const code = searchParams.get("link");
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (code === null || handled.current === code) return;
    handled.current = code;
    const next = new URLSearchParams(searchParams);
    next.delete("link");
    setSearchParams(next, { replace: true });
    if (!isLinkResultCode(code)) return;
    if (code === "linked") toast.success(LINK_RESULT_WORDS[code]);
    else toast.error(LINK_RESULT_WORDS[code]);
  }, [code, searchParams, setSearchParams]);
}

export default function SettingsAccountRoute() {
  const email = useCurrentUser()?.user.email ?? "";
  const { read, reload } = useAccountRead(loadSignInMethods);
  const setPassword = useSetPassword(email);
  useLinkResult();

  return (
    <>
      <AccountCard />
      {read.kind === "loading" && (
        <Card className="mt-4">
          <CardContent className="pt-5">
            <p role="status" className="text-[13px] text-muted-foreground">
              Loading…
            </p>
          </CardContent>
        </Card>
      )}
      {read.kind === "failed" && (
        <Card className="mt-4">
          <CardContent className="flex items-center gap-3 pt-5">
            <p className="text-[13px] text-muted-foreground">{SIGN_IN_METHODS_LOAD_FAILED_MESSAGE}</p>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}
      {read.kind === "read" && (
        <>
          {read.value.hasPassword ? <ChangePasswordCard /> : <SetPasswordCard email={email} setPassword={setPassword} />}
          {showsSignInMethods(read.value) && (
            <SignInMethodsCard methods={read.value} onChanged={reload} setPassword={setPassword} />
          )}
        </>
      )}
      <SessionsCard />
      <PersonalApiTokensCard />
    </>
  );
}
