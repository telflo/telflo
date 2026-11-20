import { Outlet, useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/playground";
import { PlaygroundShell } from "~/components/playground/PlaygroundShell.js";
import { restartPlaygroundTour } from "~/components/playground/playground-tour.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/*
 * The playground's layout: the provider (the sample's visitor, the lock and
 * its prompt, "Sign in to save", the session-ended handler suspended)
 * around the shell, for the configurations, the flows, a flow's page and
 * fleet management. Its loader only reads the site's switch: with
 * TELFLO_PLAYGROUND off, every page under it is a 404. Nothing else is read
 * on the server, and nothing in the browser but the sample and the open
 * reads. The theme is the remembered one; every page has its own canonical.
 * The banner's "Take the tour" restarts the playground tour from the list.
 */

export const handle = PLAYGROUND_HANDLE;

/** The playground's switch, for this route and its children. */
export function loader() {
  notFoundUnless(siteSettings().playground);
  return null;
}

export function meta({ matches }: Route.MetaArgs) {
  return playgroundMeta(matches, PLAYGROUND_TITLES.configurations, "/playground");
}

export default function PlaygroundLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const takeTour = () => restartPlaygroundTour(pathname, (to) => void navigate(to));
  return (
    <PlaygroundProvider>
      <PlaygroundShell onTakeTour={takeTour}>
        <Outlet />
      </PlaygroundShell>
    </PlaygroundProvider>
  );
}
