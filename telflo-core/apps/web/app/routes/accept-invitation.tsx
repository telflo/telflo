import { useEffect } from "react";
import type { OidcProvider } from "@telflo/contracts";
import type { Route } from "./+types/accept-invitation";
import { AcceptInvitation, takeInvitationToken, type InvitationVisitor } from "~/components/auth/AcceptInvitation.js";
import { AuthShell } from "~/components/auth/AuthShell.js";
import { ApiError, getCurrentUser, suspendSessionEndedHandler } from "~/lib/api-client.js";
import { fetchCurrentUser, fetchOidcProviders } from "~/lib/api-client.server.js";
import type { ThemeHandle } from "~/lib/theme.js";
import { termsToAccept, useSite } from "~/lib/use-site.js";

/** The page's data, from its server loader and its client loader alike. */
export type AcceptInvitationData = { visitor: InvitationVisitor; providers: OidcProvider[] };

/**
 * Who is signed in, whoever it is: unlike `/login`, a signed-in visitor stays,
 * since they may be the one invited (D6 decision 13). The preview runs in the
 * browser, because the token is only there. The providers for the Google
 * button are optional, as on `/login`. An unreachable API throws from
 * fetchCurrentUser rather than reading as signed out.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<AcceptInvitationData> {
  const [visitor, providers] = await Promise.all([
    fetchCurrentUser(request),
    fetchOidcProviders(request).catch((): OidcProvider[] => []),
  ]);
  return { visitor, providers };
}

/**
 * Runs on hydration and on every revalidation, as the signed-in layout's does.
 * First it moves the link's token out of the address bar, before this page
 * makes any request (D6 decision 2).
 *
 * Someone following an emailed link usually has an expired access token, and
 * must not read as signed out (D6 Preflight ruling 3). So when the server
 * says a refresh is needed, the browser client asks for the current user and
 * its interceptor refreshes. The session-ended handler is suspended for it,
 * so a refused refresh reads as signed out here instead of going to
 * `/login`. Any other failure goes to the error boundary.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs): Promise<AcceptInvitationData> {
  takeInvitationToken();
  const data = await serverLoader();
  if (data.visitor.status !== "refresh_needed") return data;

  const release = suspendSessionEndedHandler();
  try {
    return { ...data, visitor: { status: "signed_in", currentUser: await getCurrentUser() } };
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthenticated") {
      return { ...data, visitor: { status: "signed_out" } };
    }
    throw error;
  } finally {
    release();
  }
}
clientLoader.hydrate = true as const;

// No HydrateFallback, as on the signed-in layout: the server renders the
// page's loading card, and hydration keeps it while the client loader runs.

// An auth screen: root's Layout renders the theme this browser was last
// told, the remembered one or the `telflo_theme` cookie's (D21 decision 22).
export const handle = { theme: "remembered" } satisfies ThemeHandle;

/*
 * The page's title and description; `noindex` keeps the page out of
 * search indexes. The token is in the fragment,
 * which never reaches a server, and is gone from the address bar once the
 * page has loaded; the page still sends no Referer, as a backstop, as
 * `/reset-password` does.
 */
export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Accept Invitation - Telflo" },
    { name: "description", content: "Accept your organization invitation to Telflo" },
    { name: "referrer", content: "no-referrer" },
    { name: "robots", content: "noindex" },
  ];
}

export default function AcceptInvitationPage({ loaderData }: Route.ComponentProps) {
  // While the page is shown, a session that ends leaves it here, signed out,
  // rather than going to `/login` (D6 Preflight ruling 3).
  useEffect(() => suspendSessionEndedHandler(), []);
  // The site's Terms, as root's loader read them: none when it asks for none (D36-1 decisions 29 and 32).
  const { terms } = useSite();

  return (
    <AuthShell>
      <AcceptInvitation
        visitor={loaderData.visitor}
        providers={loaderData.providers}
        terms={termsToAccept(terms)}
      />
    </AuthShell>
  );
}
