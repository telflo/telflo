import { LibraryAdminPage } from "~/components/admin/LibraryAdminPage.js";

/*
 * `/product-admin/library`: the product-admin Library tab. The product-admin
 * layout route has checked the flag before this renders.
 */
export default function AdminLibrary() {
  return <LibraryAdminPage />;
}
