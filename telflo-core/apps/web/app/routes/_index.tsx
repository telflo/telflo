import { redirect } from "react-router";
import type { Route } from "./+types/_index";
import { fetchCurrentUser } from "~/lib/api-client.server.js";

/**
 * `/` (D36-1 decision 22): the marketing site left the web app (decision
 * 20), so the address goes where the visitor belongs, on the server. A
 * signed-in visitor, or one whose access token has expired (the app's
 * layout refreshes it), goes to `/app`; a signed-out one to `/login`; both
 * 302. An unreachable API throws from fetchCurrentUser, as on `/login`,
 * rather than reading as signed out, so the error boundary shows it. A
 * site serving its own home page at `/` routes it there in the gateway
 * (`gateway.extraRoutes`, decision 24), ahead of this.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const lookup = await fetchCurrentUser(request);
  throw redirect(lookup.status === "signed_out" ? "/login" : "/app");
}

/** Never rendered: the loader always redirects. A component keeps `/` a page route, for client navigation too. */
export default function Index() {
  return null;
}
