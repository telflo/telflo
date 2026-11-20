import { useEffect, useRef } from "react";
import { Outlet, redirect, useSearchParams, type ShouldRevalidateFunction } from "react-router";
import type { CurrentUserResponse } from "@telflo/contracts";
import type { Route } from "./+types/app-layout";
import { AcceptTermsDialog } from "~/components/auth/AcceptTermsDialog.js";
import { AppLayout } from "~/components/layout/AppLayout.js";
import { startOrgWelcomeTour } from "~/components/layout/org-welcome-tour.js";
import { identifyUser } from "~/lib/analytics.js";
import { ApiError, getCurrentUser } from "~/lib/api-client.js";
import { fetchCurrentUser } from "~/lib/api-client.server.js";
import { numberPreferenceRead, useUserStore } from "~/lib/stores/user-store.js";
import { rememberTheme, useSignedInTheme } from "~/lib/theme.js";
import { termsToAccept, useSite } from "~/lib/use-site.js";

/**
 * The layout's data, from its server loader and its client loader alike.
 * `refresh_needed` means there is no user to show yet: the access token has
 * expired, and only the browser can refresh it.
 */
export type AppLayoutData =
  | {
      status: "signed_in";
      currentUser: CurrentUserResponse;
      /**
       * When the client loader asked for this `/me` (the user store's
       * `numberPreferenceRead`): an answer to a read sent before a save never
       * overwrites the save's answer. Absent from the server's data and from
       * tests' stubs, which count as read now.
       */
      preferencesReadAt?: number;
    }
  | { status: "refresh_needed" };

/**
 * Every signed-in page sits under this layout route, so the session check
 * happens once here instead of in each page's loader. No session sends the
 * visitor to sign in and back.
 * An expired access token is not "no session": the server can't refresh it
 * (the refresh cookie never reaches a page request), so it says so and the
 * client loader refreshes. An unreachable API throws from fetchCurrentUser,
 * so an outage reaches the error boundary instead of looking like "signed
 * out".
 */
export async function loader({ request }: Route.LoaderArgs): Promise<AppLayoutData> {
  const lookup = await fetchCurrentUser(request);
  switch (lookup.status) {
    case "signed_out": {
      const { pathname, search } = new URL(request.url);
      throw redirect("/login?redirectTo=" + encodeURIComponent(pathname + search));
    }
    case "refresh_needed":
      return { status: "refresh_needed" };
    case "signed_in":
      return { status: "signed_in", currentUser: lookup.currentUser };
  }
}

/**
 * Runs on hydration and on every client-side navigation under the layout
 * (`shouldRevalidate` below makes that every one, not just some).
 * The server loader's answer comes first (on hydration, the data the page
 * was rendered with; afterwards, a fresh request), and a redirect it throws
 * goes through untouched. When it says the access token has expired, the
 * browser client asks for the current user: its interceptor refreshes once
 * and retries.
 *
 * `unauthenticated` means the session is over, and this sends the browser to
 * `/login?redirectTo=<this page>` itself. The browser client's session-ended
 * handler runs on any `unauthenticated` too, including a retry that fails
 * because the session was revoked after a successful refresh, but the
 * redirect stays so this loader doesn't depend on which handler is
 * installed. Both navigations go to the same `/login?redirectTo=…`. Only
 * ever runs in the browser, so `window.location` is there. Any other failure
 * goes to the error boundary.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs): Promise<AppLayoutData> {
  // Numbered before asking, so the store can tell this answer from a save's.
  const preferencesReadAt = numberPreferenceRead();
  const data = await serverLoader();
  if (data.status === "signed_in") return { ...data, preferencesReadAt };

  try {
    return { status: "signed_in", currentUser: await getCurrentUser(), preferencesReadAt };
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthenticated") {
      const { pathname, search } = window.location;
      throw redirect("/login?redirectTo=" + encodeURIComponent(pathname + search));
    }
    throw error;
  }
}
clientLoader.hydrate = true as const;

/**
 * Every navigation under the layout re-runs its loaders. React Router's
 * default doesn't: a layout with no path of its own keeps its data when the
 * navigation moves between two different child paths (only the same URL, a
 * changed search, or a new route instance revalidates). Then a navigation
 * after the access token expired would never reach the client loader's
 * refresh, and the page's own loader would meet the 401 instead.
 */
export const shouldRevalidate: ShouldRevalidateFunction = () => true;

/**
 * The first landing after joining from an invitation, `/app?joined_org={id}`:
 * the parameter is removed with `replace`, so a refresh or Back never shows
 * the callout again, and the welcome callout shows only if the organization
 * is in the user's list. An unknown id is removed and does nothing.
 *
 * It waits for the terms: a new Google account joins with them still to
 * accept, and the parameter stays until the dialog has gone. The list is the
 * loader's, not the store's: the store is seeded in an effect, and the
 * pages' effects run before this layout's. Handled once per id, so a second
 * run of the effect (React's development double run, or a render before the
 * removal lands) never starts a second callout.
 */
function useJoinedOrganizationCallout(currentUser: CurrentUserResponse | null): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const joinedId = searchParams.get("joined_org");
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    if (currentUser === null || currentUser.termsAcceptanceRequired || joinedId === null) return;
    if (handledId.current === joinedId) return;
    handledId.current = joinedId;
    const next = new URLSearchParams(searchParams);
    next.delete("joined_org");
    setSearchParams(next, { replace: true });
    const joined = currentUser.organizations.find((organization) => organization.id === joinedId);
    if (joined) startOrgWelcomeTour(joined.name, joined.type);
  }, [currentUser, joinedId, searchParams, setSearchParams]);
}

// No HydrateFallback, deliberately: the server renders the component with
// the server loader's data (the shell, or the placeholder below), and
// hydration keeps that markup while the client loader runs.

export default function AppLayoutRoute({ loaderData }: Route.ComponentProps) {
  const setCurrent = useUserStore((state) => state.setCurrent);
  const reseedPreferences = useUserStore((state) => state.reseedPreferences);
  const currentUser = loaderData.status === "signed_in" ? loaderData.currentUser : null;
  // The site's Terms, which the terms dialog links and its Accept records; none when it asks for none.
  const site = useSite();
  const preferencesReadAt = loaderData.status === "signed_in" ? loaderData.preferencesReadAt : undefined;
  // Who the store holds, as a value: the same on every navigation until the
  // API's answer changes. The preferences aren't in it: they are compared
  // with the store's own below.
  const seed =
    currentUser === null
      ? null
      : JSON.stringify([currentUser.user, currentUser.organization, currentUser.organizations, currentUser.isProductAdmin]);

  // Seeded in an effect, never during render: the store is a module
  // singleton, and writing it while rendering on the server would share one
  // request's user with the next.
  useEffect(() => {
    if (currentUser) setCurrent(currentUser, preferencesReadAt);
    // Keyed on what the store holds, not on each loader result's identity:
    // every navigation revalidates the loader, and the store is re-seeded
    // only when the answer changed. That is a different user; a switch, or a
    // removal or deletion that moved the session; a role another admin
    // changed, which shows or hides the Permissions item; the list of
    // organizations, which a restoration (or a removal from an organization
    // that isn't the active one) or another admin's rename changes; and the
    // product-admin flag, which an operator sets or clears. An answer that
    // is the same again doesn't re-seed, so it leaves alone what creating
    // and renaming put in the store.
  }, [seed, setCurrent]);

  // The preferences, on every `/me` answer: compared with what the store
  // last confirmed, not with the previous answer, so a change in another tab
  // or browser reaches this tab even when `/me` says again what it said
  // before this tab's own save. Only the preferences are re-seeded; a read
  // older than a save's answer leaves that key alone, and a choice still
  // being saved stays shown. Keyed on the loader's answer itself: a new one
  // on every revalidation.
  useEffect(() => {
    if (loaderData.status === "signed_in") {
      reseedPreferences(loaderData.currentUser.user.id, loaderData.currentUser.preferences, loaderData.preferencesReadAt);
    }
  }, [loaderData, reseedPreferences]);

  // The theme this page renders (root's Layout reads the same), remembered
  // for the auth screens: after Logout's client-side way to /login they keep
  // it. A change made in another browser reaches it at the next
  // revalidation, a change in Appearance at once. Written from an effect,
  // never during a render.
  const theme = useSignedInTheme(currentUser);
  useEffect(() => {
    if (theme !== null) rememberTheme(theme);
  }, [theme]);

  useJoinedOrganizationCallout(currentUser);

  // PostHog learns who is signed in, but only once the visitor has accepted
  // (lib/analytics.ts). Keyed on the user, so the revalidation on every
  // navigation doesn't identify again. Without analytics it does nothing.
  const userId = currentUser?.user.id;
  const email = currentUser?.user.email;
  useEffect(() => {
    if (userId !== undefined && email !== undefined) identifyUser(userId, email);
  }, [userId, email]);

  if (currentUser === null) {
    // Waiting on the client loader's refresh: blank, and not the sidebar,
    // since there is no user to show in it yet. `tf-app` gives it the app's
    // floor in the cookie's theme, which <html> carries until `/me` answers.
    return <div className="tf-app h-screen bg-gray-50 dark:bg-gray-900" aria-busy="true" />;
  }

  // The terms dialog sits over the shell while `/me` says the current terms
  // need accepting. Whichever loader answered, the server's or the client's
  // refresh path, the flag comes from the same `/me`; after Accept the
  // dialog revalidates, and the fresh answer closes it.
  return (
    <>
      <AppLayout>
        <Outlet />
      </AppLayout>
      <AcceptTermsDialog open={currentUser.termsAcceptanceRequired} terms={termsToAccept(site.terms)} />
    </>
  );
}
