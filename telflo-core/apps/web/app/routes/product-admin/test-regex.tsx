import { TestRegexPage } from "~/components/admin/TestRegexPage.js";

/*
 * `/product-admin/test-regex` (D15b decision 8).
 * The product-admin layout route has checked the flag before this renders
 * (D12 Preflight ruling 5), and checks it again on every move (D14b Ruling
 * 44).
 */
export default function AdminTestRegex() {
  return <TestRegexPage />;
}
