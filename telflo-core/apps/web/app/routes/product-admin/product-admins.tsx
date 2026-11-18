import { OrganizationCreationSetting } from "~/components/admin/OrganizationCreationSetting.js";
import { ProductAdminsPage } from "~/components/admin/ProductAdminsPage.js";

/*
 * `/product-admin/product-admins` (D29 decision 39). The product-admin layout route
 * has checked the flag before this renders (D12 Preflight ruling 5), and
 * checks it again on every move (D14b Ruling 44). Below the list, the
 * switch that keeps creating organizations to product admins (D36-1
 * decision 51).
 */
export default function AdminProductAdmins() {
  return (
    <>
      <ProductAdminsPage />
      <div className="px-5 pb-5">
        <OrganizationCreationSetting />
      </div>
    </>
  );
}
