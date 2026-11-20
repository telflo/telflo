import { UserFeedbackAdminPage } from "~/components/admin/UserFeedbackAdminPage.js";

/*
 * `/product-admin/user-feedback`. The product-admin layout route has checked
 * the flag before this renders, and checks it again on every move.
 */
export default function AdminUserFeedback() {
  return <UserFeedbackAdminPage />;
}
