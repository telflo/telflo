import { safeRedirectPath, type OidcProvider } from "@telflo/contracts";
import { redirect } from "react-router";
import type { Route } from "./+types/login";
import { AuthShell } from "~/components/auth/AuthShell.js";
import { LoginForm } from "~/components/auth/LoginForm.js";
import { fetchCurrentUser, fetchOidcProviders } from "~/lib/api-client.server.js";
import type { ThemeHandle } from "~/lib/theme.js";

/**
 * A signed-in visitor goes straight to `redirectTo` (cleaned) or `/app`. One
 * whose access token has expired sees the form, like a signed-out one. An
 * unreachable API throws from fetchCurrentUser rather than reading as signed
 * out, so the error boundary shows it.
 *
 * The providers for the federated buttons are fetched alongside. They are
 * optional: if the list can't be had, the page shows the email form alone.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const [lookup, providers] = await Promise.all([
    fetchCurrentUser(request),
    fetchOidcProviders(request).catch((): OidcProvider[] => []),
  ]);
  if (lookup.status === "signed_in") {
    throw redirect(safeRedirectPath(new URL(request.url).searchParams.get("redirectTo")));
  }
  return { providers };
}

// An auth screen: root's Layout renders the theme this browser was last
// told, the remembered one or the `telflo_theme` cookie's.
export const handle = { theme: "remembered" } satisfies ThemeHandle;

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Login - Telflo" },
    { name: "description", content: "Sign in to your Telflo account" },
  ];
}

export default function LoginPage({ loaderData }: Route.ComponentProps) {
  return (
    <AuthShell>
      <LoginForm providers={loaderData.providers} />
    </AuthShell>
  );
}
