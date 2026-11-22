import { UsersAdminPage } from "~/components/admin/UsersAdminPage.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/*
 * `/product-admin/users`. The product-admin layout route has checked the flag
 * before this renders, and checks it again on every move.
 */

/** The page's switch: with TELFLO_USER_ADMIN off, the open source's default, a 404. */
export function loader() {
  notFoundUnless(siteSettings().userAdmin);
  return null;
}
export default function AdminUsers() {
  return <UsersAdminPage />;
}
