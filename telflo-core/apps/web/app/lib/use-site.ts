import { OPEN_SOURCE_SITE, type SiteSettings } from "@telflo/contracts";
import { useRouteLoaderData } from "react-router";

/**
 * The site's switches and links as root's loader read them on the server
 * (lib/site.server.ts): registration, the playground, the docs link, the
 * Terms. The open source's defaults where root's data isn't there (a test
 * rendering a page alone, or the error boundary). Root's loader never
 * revalidates: the settings are fixed per process.
 */
export function useSite(): SiteSettings {
  return useRouteLoaderData<{ site?: SiteSettings }>("root")?.site ?? OPEN_SOURCE_SITE;
}

/**
 * Where a "Create free account" control goes: the sign-up page while
 * registration is open; otherwise sign-in, where an invitee or an existing
 * account goes (the API refuses a sign-up then).
 */
export function signUpPath(registration: SiteSettings["registration"]): "/register" | "/login" {
  return registration === "open" ? "/register" : "/login";
}

/** `signUpPath` for this site. */
export function useSignUpPath(): "/register" | "/login" {
  return signUpPath(useSite().registration);
}

/**
 * A page of the site's docs: `path` (no leading `/`) under TELFLO_DOCS_URL,
 * so `docs` is today's `https://docs.telflo.com/docs` by default and the
 * same page of another site's docs; null when the site has none
 * (TELFLO_DOCS_URL ""), and the link is then left out.
 */
export function docsPage(docsUrl: string, path: string): string | null {
  if (docsUrl === "") return null;
  return `${docsUrl.replace(/\/+$/, "")}/${path}`;
}

/** `docsPage` for this site. */
export function useDocsPage(path: string): string | null {
  return docsPage(useSite().docsUrl, path);
}

/**
 * What a person accepts: the site's Terms version with the Terms' and the
 * privacy policy's URLs, or null when the site asks for no Terms
 * (TELFLO_TERMS_VERSION ""). The forms then show no agreement and send no
 * version, and the terms dialog never opens.
 */
export function termsToAccept(terms: SiteSettings["terms"]): SiteSettings["terms"] | null {
  return terms.version === "" ? null : terms;
}
