import { UsersAdminPage } from "~/components/admin/UsersAdminPage.js";

/*
 * `/product-admin/users`. The product-admin layout route has checked the flag
 * before this renders, and checks it again on every move.
 */
export default function AdminUsers() {
  return <UsersAdminPage />;
}
