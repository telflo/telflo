import { redirect } from "react-router";
import { ApiError } from "~/lib/api-client.js";

/*
 * What the signed-in flows pages' loaders share (`/app/flows` and
 * `/app/flows/:slug`), the signed-in layout's pattern: the server loader
 * reads with the visitor's cookie, and the client loader reads again
 * through the browser client when the access token had expired.
 */

/** Sign in, then back to `pathname` and `search`: the layout's redirect for a session that is over. */
export function signInRedirect(pathname: string, search: string): Response {
  return redirect("/login?redirectTo=" + encodeURIComponent(pathname + search));
}

/** The 404 a flow the visitor may not see answers: no such slug, or a hidden one for anyone but a product admin. */
export function flowNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** Whether a read was refused because the visitor may not see the flow. */
export function isFlowNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "flow_not_found";
}

/**
 * A client loader's read through the browser client (its interceptor
 * refreshes once and retries). `unauthenticated` means the session is over:
 * the browser goes to sign in and back, as the layout's client loader sends
 * it; `flow_not_found` is the 404; anything else reaches the error boundary.
 * Only ever runs in the browser, so `window.location` is there.
 */
export async function readInBrowser<Data>(read: () => Promise<Data>): Promise<Data> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiError && error.code === "unauthenticated") {
      throw signInRedirect(window.location.pathname, window.location.search);
    }
    if (isFlowNotFound(error)) throw flowNotFound();
    throw error;
  }
}
