import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { CookieConsentBanner } from "~/components/consent/CookieConsentBanner.js";
import { Toaster } from "~/components/ui/sonner.js";
import { useAnalytics } from "~/lib/analytics.js";
import { MonacoAriaHostSlot } from "~/lib/editor/monaco-aria-host-slot.js";
import { analyticsSettings } from "~/lib/analytics.server.js";
import { publicWebUrl } from "~/lib/public-url.server.js";
import { siteSettings } from "~/lib/site.server.js";
import { useSite } from "~/lib/use-site.js";
import { jsonLdScriptText, organizationJsonLd } from "~/lib/seo.js";
import { themeClassName, usePageTheme } from "~/lib/theme.js";
import { themeFromRequest } from "~/lib/theme.server.js";
import "./app.css";

// The root layout: no `links` export (app.css bundles the fonts, so nothing
// is fetched from a CDN), no og:image tags, and no ChatKit script. PostHog
// and its cookie-consent banner are switched on by a setting.

// The server's settings the pages need: the public URL, which pages' meta
// functions read from root's match (lib/seo.ts) and the Layout from
// useRouteLoaderData, and PostHog's settings. null, not undefined, when
// unset. And the theme the request's `telflo_theme` cookie names, Dark
// when it names none of the three: the auth screens render it on a full
// load. Only the word goes out, never the cookie itself. And the site's
// switches and links (lib/site.server.ts), which useSite() reads: nothing
// secret.
export function loader({ request }: Route.LoaderArgs) {
  return {
    publicWebUrl: publicWebUrl() ?? null,
    analytics: analyticsSettings(),
    theme: themeFromRequest(request),
    site: siteSettings(),
  };
}

// The settings don't change while the server runs, so a navigation never
// reloads them. Nor does the cookie's theme need to: after a client-side
// navigation the auth screens render the remembered value (lib/theme.ts).
export const shouldRevalidate = () => false;

export const meta: Route.MetaFunction = () => [
  { property: "og:site_name", content: "Telflo" },
  { property: "og:type", content: "website" },
];

// <html>'s class is the page's theme (lib/theme.ts's usePageTheme), in the
// server's HTML, with no script: a signed-in page renders the stored theme
// from the layout's `/me`; the seven auth screens the theme this browser
// was last told (the remembered value after a client-side navigation, else
// the `telflo_theme` cookie); everything else, a 404 and a failed layout
// loader included, `dark`. The server and the hydrating client read the
// same inputs, so the class matches.
//
// The Organization JSON-LD's url and logo follow TELFLO_PUBLIC_WEB_URL. Root's
// loader data can be undefined here (the Layout also wraps the error
// boundary), and the JSON-LD then leaves them out, as without the setting.
// Its `<`s are escaped, so no setting can end the script early.
//
// <html data-hydrated> marks the end of hydration. The Layout wraps every
// page and the error boundary, and its effect runs after all of theirs,
// once React owns the whole document. Until then a controlled field typed
// into is reset to its state on hydration, so the E2E tests
// (e2e/support/session.ts's waitForHydration) wait for the mark.
export function Layout({ children }: { children: React.ReactNode }) {
  const rootData = useRouteLoaderData<typeof loader>("root");
  const theme = usePageTheme();
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return (
    <html lang="en" className={themeClassName(theme)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLdScriptText(organizationJsonLd(rootData?.publicWebUrl ?? undefined)),
          }}
        />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// The one Toaster, here rather than in AppLayout: the root route stays mounted
// across every navigation, so a toast raised just before one (logout's, on its
// way to /login) is shown at once instead of waiting for the next Toaster to
// mount. It renders nothing until there is a toast, so the server and client
// markup match. It follows the page's theme, as <html>'s class does.
//
// PostHog starts, and the consent banner shows, only when the server has a
// key. The banner renders nothing until it has read the stored choice in
// an effect, so the markup matches here too.
//
// The one host for every Monaco's screen-reader live region
// (lib/editor/use-aria-container.ts) goes here for the same reason: the root
// route stays mounted, so the host outlives every editor and viewer. Its
// wrapper (MonacoAriaHostSlot) is an empty `ph-no-capture` div, kept audible
// under modal dialogs by `aria-live="off"`, on the server and the client
// alike; the host is put in it after hydration.
export default function App() {
  const analytics = useRouteLoaderData<typeof loader>("root")?.analytics ?? null;
  // The banner's policy link, the site's: "" names none.
  const cookiePolicyUrl = useSite().terms.cookiePolicyUrl;
  useAnalytics(analytics);
  const theme = usePageTheme();
  return (
    <>
      <Outlet />
      {analytics && <CookieConsentBanner cookiePolicyUrl={cookiePolicyUrl} />}
      <Toaster theme={theme} />
      {/* Every Monaco's screen-reader live region: one host, replay-blocked, never removed, audible under dialogs. */}
      <MonacoAriaHostSlot />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
