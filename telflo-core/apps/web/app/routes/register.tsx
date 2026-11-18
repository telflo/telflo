import type { OidcProvider } from "@telflo/contracts";
import { redirect, useNavigate } from "react-router";
import type { Route } from "./+types/register";
import { AuthShell } from "~/components/auth/AuthShell.js";
import { RegisterForm } from "~/components/auth/RegisterForm.js";
import { fetchCurrentUser, fetchOidcProviders } from "~/lib/api-client.server.js";
import type { ThemeHandle } from "~/lib/theme.js";
import { termsToAccept, useSite } from "~/lib/use-site.js";

/**
 * A signed-in visitor has no account to create and goes to `/app`. One whose
 * access token has expired sees the form, like a signed-out one (D2b decision
 * 7). An unreachable API throws rather than reading as signed out.
 *
 * The providers for the federated buttons are fetched alongside. They are
 * optional: if the list can't be had, the page shows the email form alone.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const [lookup, providers] = await Promise.all([
    fetchCurrentUser(request),
    fetchOidcProviders(request).catch((): OidcProvider[] => []),
  ]);
  if (lookup.status === "signed_in") throw redirect("/app");
  return { providers };
}

// An auth screen: root's Layout renders the theme this browser was last
// told, the remembered one or the `telflo_theme` cookie's (D21 decision 22).
export const handle = { theme: "remembered" } satisfies ThemeHandle;

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Sign Up - Telflo" },
    { name: "description", content: "Create your Telflo account" },
  ];
}

export default function RegisterPage({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
  // The site's Terms, as root's loader read them: none when it asks for none (D36-1 decisions 29 and 32).
  const { terms } = useSite();

  return (
    <AuthShell showHomeLink>
      <RegisterForm
        terms={termsToAccept(terms)}
        providers={loaderData.providers}
        onSuccess={() => void navigate("/check-your-email")}
      />
    </AuthShell>
  );
}
