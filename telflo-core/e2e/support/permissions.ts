import type { Page } from "@playwright/test";

// The Permissions page (/org-admin) in the browser tests. Moved from
// organizations.e2e.ts for D22's service accounts (Preflight ruling 22):
// organizations.e2e.ts and service-accounts.e2e.ts share it.

/** A member's row in the Permissions page's Active or Deleted table, by the address it shows. */
export function memberRow(page: Page, email: string) {
  return page.getByRole("row").filter({ hasText: email });
}
