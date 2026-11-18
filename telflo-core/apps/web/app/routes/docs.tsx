import { redirect } from "react-router";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/*
 * The documentation moved to docs.telflo.com, and search engines still have
 * the old telflo.com/docs URLs indexed. `/docs` and every `/docs/*` path
 * answer 301 to the docs home: the site's TELFLO_DOCS_URL (D36-1 decisions 21
 * and 34), read at request time. With it empty (an install with no docs
 * links), the paths are 404s.
 */
export function loader() {
  const { docsUrl } = siteSettings();
  notFoundUnless(docsUrl !== "");
  return redirect(docsUrl, 301);
}
