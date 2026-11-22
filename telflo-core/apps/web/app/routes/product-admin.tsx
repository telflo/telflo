import { Outlet, redirect, useLocation, useNavigate } from "react-router";
import type { CurrentUserResponse } from "@telflo/contracts";
import type { Route } from "./+types/product-admin";
import { Button } from "~/components/ui/button.js";
import { ApiError, getCurrentUser, getPendingFeedbackCount } from "~/lib/api-client.js";
import { fetchCurrentUser, fetchPendingFeedbackCount } from "~/lib/api-client.server.js";
import { siteSettings } from "~/lib/site.server.js";
import { useSite } from "~/lib/use-site.js";
import { cn } from "~/lib/utils.js";

/*
 * Product admin (`/product-admin`): the "Admin Dashboard" shell, its left nav
 * and the page beside it. Its rules:
 * - the nav: User Feedback, Test Templates, Test Regex, Library, Flows, Users
 *   and Product admins; User Feedback only while the site's
 *   TELFLO_USER_FEEDBACK is on, Library only while TELFLO_LEARNING is, and
 *   Users only while TELFLO_USER_ADMIN is (each off, the open source's
 *   default, its page is a 404);
 * - User Feedback shows the pending count, 0 included, read by the loaders
 *   after the gate, and only while TELFLO_USER_FEEDBACK is on; a count that
 *   can't be read hides the badge and nothing else (it never reaches the
 *   gate or the error boundary). The User Feedback page revalidates this
 *   layout after each acknowledge or dismiss;
 * - the gate is checked on the server before anything renders, and again on
 *   every move between its pages (`shouldRevalidate`), so a non-admin never
 *   sees the page, not even before a redirect;
 * - `/product-admin` itself goes to Flows;
 * - the signed-in layout route supplies the shell (AppLayout) and the
 *   session check, as for `/settings` and `/org-admin`.
 *
 * React Router runs the signed-in layout's loader and this one side by
 * side, so this one can't read the layout's answer: it asks for the current
 * user itself. Every API call the page makes is refused for anyone without
 * the flag (403 `product_admin_required`, read live), which the page answers
 * by going to `/app`; this gate is what keeps a non-admin from seeing the
 * page at all.
 */

/**
 * The gate's answer: `product_admin`, the page may render, with the pending
 * feedback's count for the nav's badge (null when it couldn't be read: no
 * badge, and null too while TELFLO_USER_FEEDBACK is off: never read);
 * `refresh_needed`, the access token has expired and only the browser can
 * refresh it, so the client loader asks again, reading the count only if
 * the server's `userFeedback` says the switch is on.
 */
export type ProductAdminData =
  | { status: "product_admin"; pendingFeedback: number | null }
  | { status: "refresh_needed"; userFeedback: boolean };

/** Where `/product-admin` itself goes: Flows. */
export const PRODUCT_ADMIN_HOME = "/product-admin/flows";

/** The pathname without a trailing slash, so `/product-admin/` is `/product-admin` too. */
function normalized(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** Sign in, then back to this address: the signed-in layout's redirect for a session that is over. */
function signInRedirect(url: URL): Response {
  return redirect("/login?redirectTo=" + encodeURIComponent(url.pathname + url.search));
}

/**
 * The gate's rules for a signed-in user, shared by both loaders: anyone
 * without the flag goes to `/app` (a 302 on a document request, so nothing
 * of the page renders); a product admin at `/product-admin` itself goes to
 * Flows, only after the flag is checked, so the redirect tells a non-admin
 * nothing.
 */
function admit(currentUser: CurrentUserResponse, url: URL): void {
  if (!currentUser.isProductAdmin) throw redirect("/app");
  if (normalized(url.pathname) === "/product-admin") throw redirect(PRODUCT_ADMIN_HOME);
}

/**
 * The pending count, read after the gate has said yes: any failure (the API's
 * refusal, an expired token, an outage, an answer that isn't the schema) is
 * null, no badge, and never reaches the gate or the error boundary.
 */
async function pendingCountOr(read: () => Promise<number | null>): Promise<number | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * The server's gate: no session goes to sign in and back, as the signed-in
 * layout sends it; an expired access token says so, for the client loader;
 * a signed-in user goes through `admit`. An unreachable API throws from
 * fetchCurrentUser, for the error boundary.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<ProductAdminData> {
  const url = new URL(request.url);
  const lookup = await fetchCurrentUser(request);
  switch (lookup.status) {
    case "signed_out":
      throw signInRedirect(url);
    case "refresh_needed":
      return { status: "refresh_needed", userFeedback: siteSettings().userFeedback };
    case "signed_in": {
      admit(lookup.currentUser, url);
      const pendingFeedback = siteSettings().userFeedback
        ? await pendingCountOr(async () => {
            const read = await fetchPendingFeedbackCount(request);
            return read.status === "loaded" ? read.data : null;
          })
        : null;
      return { status: "product_admin", pendingFeedback };
    }
  }
}

/**
 * On hydration and every client-side navigation into product admin: the
 * server loader's answer (a redirect it throws goes through untouched), and
 * when the access token had expired, the browser client's `/me`, whose
 * interceptor refreshes once (one refresh in flight with the layout's), then
 * the same rules. A session that is over goes to sign in and back; any other
 * failure reaches the error boundary.
 */
export async function clientLoader({ request, serverLoader }: Route.ClientLoaderArgs): Promise<ProductAdminData> {
  const data = await serverLoader();
  if (data.status === "product_admin") return data;

  const url = new URL(request.url);
  let currentUser: CurrentUserResponse;
  try {
    currentUser = await getCurrentUser();
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthenticated") throw signInRedirect(url);
    throw error;
  }
  admit(currentUser, url);
  const pendingFeedback = data.userFeedback ? await pendingCountOr(() => getPendingFeedbackCount()) : null;
  return { status: "product_admin", pendingFeedback };
}
clientLoader.hydrate = true as const;

/**
 * The gate runs again on every move between product admin's pages: by
 * default React Router keeps a parent's answer when only a child changes,
 * so an admin whose flag was cleared on Flows would still see Test
 * Templates. Each move asks the server again, as the first visit did.
 */
export function shouldRevalidate(): boolean {
  return true;
}

/**
 * The nav's order: User Feedback (with the pending count), Test Templates,
 * Test Regex, Library, Flows, Users, then Product admins. `site` names the
 * site's switch an item needs, if any.
 */
const navItems: Array<{
  path: string;
  label: string;
  showsPendingFeedback?: true;
  site?: "userFeedback" | "learning" | "userAdmin";
}> = [
  { path: "/product-admin/user-feedback", label: "User Feedback", showsPendingFeedback: true, site: "userFeedback" },
  { path: "/product-admin/test-templates", label: "Test Templates" },
  { path: "/product-admin/test-regex", label: "Test Regex" },
  { path: "/product-admin/library", label: "Library", site: "learning" },
  { path: PRODUCT_ADMIN_HOME, label: "Flows" },
  { path: "/product-admin/users", label: "Users", site: "userAdmin" },
  { path: "/product-admin/product-admins", label: "Product admins" },
];

export default function ProductAdminRoute({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const site = useSite();

  // Nothing renders until the gate has said yes: while the browser refreshes
  // an expired access token, the signed-in layout shows its placeholder.
  if (loaderData.status !== "product_admin") return null;

  return (
    <div className="flex h-full">
      {/* Left Sidebar Navigation */}
      <div className="w-52 bg-card border-r border-border flex flex-col">
        <div className="flex h-13 items-center border-b border-border px-4">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">Admin Dashboard</h2>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {navItems.filter((item) => item.site === undefined || site[item.site]).map((item) => {
            const active = normalized(location.pathname) === item.path;
            return (
              <Button
                key={item.path}
                variant="ghost"
                className={cn(
                  "relative h-8 w-full justify-start rounded-[5px] px-2.5 text-left text-[13px] font-medium",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                onClick={() => {
                  void navigate(item.path);
                }}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand"
                  />
                )}
                {item.label}
                {item.showsPendingFeedback && loaderData.pendingFeedback !== null && (
                  <span className="ml-auto rounded-[4px] bg-muted px-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                    {loaderData.pendingFeedback}
                  </span>
                )}
              </Button>
            );
          })}
        </nav>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
