import { TestTemplatesPage } from "~/components/admin/TestTemplatesPage.js";

/*
 * `/product-admin/test-templates` (D14b decision 3). The product-admin layout
 * route has checked the flag before this renders (D12 Preflight ruling 5).
 */
export default function AdminTestTemplates() {
  return <TestTemplatesPage />;
}
