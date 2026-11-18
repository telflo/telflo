import { FlowsAdminPage } from "~/components/admin/FlowsAdminPage.js";

/*
 * `/product-admin/flows`. The product-admin layout route has checked the flag
 * before this renders (D12 Preflight ruling 5).
 */
export default function AdminFlows() {
  return <FlowsAdminPage />;
}
