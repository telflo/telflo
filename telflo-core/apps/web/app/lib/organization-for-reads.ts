import { usePlaygroundVisitor } from "~/lib/playground/context.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { isSampleOrganization } from "~/lib/workspace-reads.js";

/*
 * The one organization source for a read that isn't a `readsFor` reader: the
 * organization variables' names (`useOrgVariables`), the variable groups'
 * names (`useNamesOrganization`), and any such hook added later. Inside the
 * playground the visitor is the sample's, whose organization no API read may
 * name, so the answer is null and the hook reads nothing: a signed-in
 * visitor's own organization, still in the user store, never reaches it.
 * Outside, the user store's organization, as those hooks always read it.
 *
 * `useCurrentUser` isn't called: its layout-loader fallback needs a data
 * router, which the forms' and screens' tests render without, and these
 * hooks never read the loader. A reader that should answer inside the
 * playground goes through `readsFor` with `useCurrentUser()`'s id instead.
 * organization-for-reads.guard.test.ts holds every other source file to
 * this hook (or `useCurrentUser`) for the organization.
 */

/** The organization a non-`readsFor` read names: the visitor's first, then the user store's; null for none or the sample's. */
export function useOrganizationForReads(): string | null {
  const visitor = usePlaygroundVisitor();
  const stored = useUserStore((state) => state.current?.organization.id ?? null);
  const current = visitor?.organization.id ?? stored;
  return isSampleOrganization(current) ? null : current;
}
