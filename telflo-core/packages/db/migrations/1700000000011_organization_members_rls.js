/**
 * Row-level security on organization_members, for telflo_platform_runtime:
 *
 *   * select: the context's user's own memberships, in every organization
 *     (the switcher needs them), and every membership of the context's
 *     organization (the Permissions page);
 *   * insert, update and delete: only in the context's organization.
 *
 * The context is the two settings apps/api/src/database/context.ts sets per
 * transaction. With neither set, nothing is visible. nullif turns the empty
 * string a setting reads as, once a transaction that set it has ended, back
 * into null, which matches nothing; a bare ''::uuid would raise.
 *
 * No `force`: the tables' owner, which runs migrations and test fixtures,
 * stays exempt, and so do the SECURITY DEFINER functions it owns (the
 * membership invariant and migration 010's two), which must see every
 * membership. The policies are a backstop behind the organization-scoped
 * repositories, never a reason to widen what a query asks for.
 *
 * down drops the policies and turns row-level security off.
 */

const contextUser = `nullif(current_setting('telflo.user_id', true), '')::uuid`;
const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;

export const up = (pgm) => {
  pgm.sql(`
    alter table organization_members enable row level security;

    create policy organization_members_select on organization_members
      for select to telflo_platform_runtime
      using (user_id = ${contextUser} or organization_id = ${contextOrganization});

    create policy organization_members_insert on organization_members
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy organization_members_update on organization_members
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    -- Nothing deletes a membership yet (removal is an update of deleted_at),
    -- but a policy keeps a future delete inside the organization.
    create policy organization_members_delete on organization_members
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop policy organization_members_delete on organization_members;
    drop policy organization_members_update on organization_members;
    drop policy organization_members_insert on organization_members;
    drop policy organization_members_select on organization_members;
    alter table organization_members disable row level security;
  `);
};
