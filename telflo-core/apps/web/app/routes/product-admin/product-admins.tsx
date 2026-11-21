import { OrganizationCreationSetting } from "~/components/admin/OrganizationCreationSetting.js";
import { ProductAdminsPage } from "~/components/admin/ProductAdminsPage.js";

/*
 * `/product-admin/product-admins`. The product-admin layout route has checked
 * the flag before this renders, and checks it again on every move. Below the
 * list, the switch that keeps creating organizations to product admins.
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
