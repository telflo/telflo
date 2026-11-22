import { OPEN_SOURCE_SITE, type SiteSettings } from "@telflo/contracts";
import { Outlet, type createRoutesStub } from "react-router";

type StubRoutes = Parameters<typeof createRoutesStub>[0];

/**
 * The SaaS's site values, as the tests' setup pins them for the server:
 * registration open, the playground and the anonymous reads on, Settings ›
 * Notifications, Contact us and User Feedback, Learning and the library, and
 * Product admin › Users shown, the Terms asked with the three `/home/…` URLs, the
 * default docs.
 */
export const SAAS_SITE: SiteSettings = {
  ...OPEN_SOURCE_SITE,
  registration: "open",
  playground: true,
  anonymousValidate: true,
  publicFlows: true,
  emailNotifications: true,
  userFeedback: true,
  learning: true,
  userAdmin: true,
  terms: {
    version: "2026-01-01",
    termsUrl: "/home/terms-of-service",
    privacyUrl: "/home/privacy-policy",
    cookiePolicyUrl: "/home/cookie-policy",
  },
};

/**
 * `routes` under a root route whose loader hands `useSite()` this `site`, as
 * root's loader does (lib/use-site.ts). Without it, a component reads the
 * open source's defaults. The root's data comes from a loader, so the page
 * renders once it has run: find what it shows (`findBy…`).
 */
export function underSite(site: SiteSettings, routes: StubRoutes): StubRoutes {
  return [
    {
      id: "root",
      Component: () => <Outlet />,
      loader: () => ({ publicWebUrl: null, analytics: null, theme: "dark", site }),
      HydrateFallback: () => null,
      children: routes,
    },
  ];
}
