import { UserFeedbackAdminPage } from "~/components/admin/UserFeedbackAdminPage.js";

/*
 * `/product-admin/user-feedback` (D29 decision 40). The product-admin layout route
 * has checked the flag before this renders (D12 Preflight ruling 5), and
 * checks it again on every move (D14b Ruling 44).
 */
export default function AdminUserFeedback() {
  return <UserFeedbackAdminPage />;
}
