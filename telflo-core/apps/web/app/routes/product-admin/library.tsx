import { LibraryAdminPage } from "~/components/admin/LibraryAdminPage.js";

/*
 * `/product-admin/library`: the product-admin Library tab (D23-2 decisions
 * 25, 53 and 56). The product-admin layout route has
 * checked the flag before this renders (D12 Preflight ruling 5).
 */
export default function AdminLibrary() {
  return <LibraryAdminPage />;
}
