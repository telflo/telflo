import { UserFeedbackAdminPage } from "~/components/admin/UserFeedbackAdminPage.js";
import { notFoundUnless, siteSettings } from "~/lib/site.server.js";

/*
 * `/product-admin/user-feedback`. The product-admin layout route has checked
 * the flag before this renders, and checks it again on every move.
 */

/** The page's switch: with TELFLO_USER_FEEDBACK off, the open source's default, a 404. */
export function loader() {
  notFoundUnless(siteSettings().userFeedback);
  return null;
}
export default function AdminUserFeedback() {
  return <UserFeedbackAdminPage />;
}
