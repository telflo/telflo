import type { Route } from "./+types/check-your-email";
import { AuthShell } from "~/components/auth/AuthShell.js";
import { Card, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import type { ThemeHandle } from "~/lib/theme.js";

// An auth screen: root's Layout renders the theme this browser was last
// told, the remembered one or the `telflo_theme` cookie's.
export const handle = { theme: "remembered" } satisfies ThemeHandle;

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Check your email - Telflo" }];
}

export default function CheckYourEmailPage() {
  return (
    <AuthShell showHomeLink>
      <Card className="mx-auto w-full max-w-md">
        <CardHeader className="space-y-4">
          <CardTitle>Check your email</CardTitle>
          {/*
            Deliberately does not state an expiry: the web app has no route to
            TELFLO_VERIFICATION_TOKEN_TTL_HOURS (the register response doesn't
            carry it, and this is a static page with no loader), so any number
            written here would be a second hardcoded copy of the same value,
            free to go stale (see the mailer, which is the one place the real
            setting is threaded through). The email itself states the real
            expiry.
          */}
          <CardDescription>
            If that address can be used to create an account, we have sent a confirmation link to it.
          </CardDescription>
        </CardHeader>
      </Card>
    </AuthShell>
  );
}
