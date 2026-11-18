import type { Route } from "./+types/reset-password";
import { AuthShell } from "~/components/auth/AuthShell.js";
import { ResetPasswordForm } from "~/components/auth/ResetPasswordForm.js";
import type { ThemeHandle } from "~/lib/theme.js";

// An auth screen: root's Layout renders the theme this browser was last
// told, the remembered one or the `telflo_theme` cookie's (D21 decision 22).
export const handle = { theme: "remembered" } satisfies ThemeHandle;

/*
 * No loader: the token is checked only when the form is submitted (D3
 * decision 9). The token is in the URL's fragment, which never reaches a
 * server (Ruling 14), and is gone from the address bar once the form has
 * mounted (D4 Ruling 14). The page still sends no Referer, as a backstop, and
 * stays out of search indexes.
 */
export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Reset Password - Telflo" },
    { name: "description", content: "Set a new password for your Telflo account" },
    { name: "referrer", content: "no-referrer" },
    { name: "robots", content: "noindex" },
  ];
}

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <ResetPasswordForm />
    </AuthShell>
  );
}
