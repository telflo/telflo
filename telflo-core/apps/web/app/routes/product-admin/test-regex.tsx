import { TestRegexPage } from "~/components/admin/TestRegexPage.js";

/*
 * `/product-admin/test-regex`. The product-admin layout route has checked
 * the flag before this renders, and checks it again on every move.
 */
export default function AdminTestRegex() {
  return <TestRegexPage />;
}
