import { parseSiteSettings, type SiteSettings } from "@telflo/contracts";

/**
 * The site's switches and links, for root's loader to pass to every page:
 * the same variables the API's settings read (TELFLO_REGISTRATION,
 * TELFLO_PLAYGROUND, ..., TELFLO_TERMS_VERSION), with the same rules and
 * the open source's defaults, through the contracts' parseSiteSettings.
 * Read at call time, as public-url.server.ts reads its URL, so one image
 * serves the SaaS and a self-hosted install. Nothing in it is secret.
 *
 * A value the rules refuse throws (fixed words naming the variable, never
 * its value): the API refuses to start on the same value, so the page fails
 * loudly rather than offering what the API won't serve.
 */
export function siteSettings(): SiteSettings {
  return parseSiteSettings(process.env);
}

/**
 * For the loader of a page a site switch turns off: throws the 404 an unknown
 * page answers, so root's boundary shows "404" and the document request (or a
 * client navigation's data request) answers 404. A server loader's, never a
 * client loader's: the switch is read on the server, where the API reads it
 * too.
 */
export function notFoundUnless(on: boolean): void {
  if (!on) throw new Response("Not Found", { status: 404 });
}
