import { LibraryAdminPage } from "~/components/admin/LibraryAdminPage.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/*
 * `/product-admin/library`: the product-admin Library tab. The product-admin
 * layout route has checked the flag before this renders.
 */

/** The page's switch: with TELFLO_LEARNING off, the open source's default, a 404. */
export function loader() {
  notFoundUnless(siteSettings().learning);
  return null;
}
export default function AdminLibrary() {
  return <LibraryAdminPage />;
}
