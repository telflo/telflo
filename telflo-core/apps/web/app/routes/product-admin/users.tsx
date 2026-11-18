import { UsersAdminPage } from "~/components/admin/UsersAdminPage.js";

/*
 * `/product-admin/users` (D29 decision 38). The product-admin layout route
 * has checked the flag before this renders (D12 Preflight ruling 5), and
 * checks it again on every move (D14b Ruling 44).
 */
export default function AdminUsers() {
  return <UsersAdminPage />;
}
