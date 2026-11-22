import type { Route } from "./+types/library";
import { LibraryPage } from "~/components/library/LibraryPage.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/*
 * `/library`, the sidebar's Learning: its title and description (fixed
 * words, never a file's name). The signed-in layout route supplies the
 * shell (AppLayout), the session check and the terms dialog.
 */

/** The page's switch: with TELFLO_LEARNING off, the open source's default, a 404. */
export function loader() {
  notFoundUnless(siteSettings().learning);
  return null;
}

export function meta(_args: Route.MetaArgs) {
  return [{ title: "Library - Telflo" }, { name: "description", content: "Download resources provided by Telflo" }];
}

export default function LibraryRoute() {
  return <LibraryPage />;
}
