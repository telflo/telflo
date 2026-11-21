import { redirect } from "react-router";
import type { Route } from "./+types/forgot-password";
import { AuthShell } from "~/components/auth/AuthShell.js";
import { ForgotPasswordForm } from "~/components/auth/ForgotPasswordForm.js";
import { fetchCurrentUser } from "~/lib/api-client.server.js";
import type { ThemeHandle } from "~/lib/theme.js";

/**
 * A signed-in visitor goes to `/app`. One whose access token has expired sees
 * the form, like a signed-out one. An unreachable API throws rather than
 * reading as signed out.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const lookup = await fetchCurrentUser(request);
  if (lookup.status === "signed_in") throw redirect("/app");
  return null;
}

// An auth screen: root's Layout renders the theme this browser was last
// told, the remembered one or the `telflo_theme` cookie's.
export const handle = { theme: "remembered" } satisfies ThemeHandle;

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Forgot Password - Telflo" },
    { name: "description", content: "Reset your Telflo password" },
  ];
}

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
