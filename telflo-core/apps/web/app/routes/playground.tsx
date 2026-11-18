import { Outlet, useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/playground";
import { PlaygroundShell } from "~/components/playground/PlaygroundShell.js";
import { restartPlaygroundTour } from "~/components/playground/playground-tour.js";
import { PLAYGROUND_HANDLE, PLAYGROUND_TITLES, playgroundMeta } from "~/lib/playground/meta.js";
import { PlaygroundProvider } from "~/lib/playground/provider.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/*
 * The playground's layout (D31-1 decisions 8, 9, 22-27): the provider (the
 * sample's visitor, the lock and its prompt, "Sign in to save", the
 * session-ended handler suspended) around the shell, for the
 * configurations, the flows, a flow's page and fleet management. Its loader
 * only reads the site's switch (D36-1 decision 31, Preflight ruling 6): with
 * TELFLO_PLAYGROUND off, every page under it is a 404. Nothing else is read
 * on the server, and nothing in the browser but the sample and the open
 * reads decision 22 lists. The theme is the remembered one
 * (decision 14); every page has its own canonical (decision 17). The
 * banner's "Take the tour" restarts the playground tour from the list
 * (decision 15).
 */

export const handle = PLAYGROUND_HANDLE;

/** The playground's switch, for this route and its children (D36-1 decision 31). */
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
