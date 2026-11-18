/**
 * Retires the viewer role (D7 decision 2): an organization has admins and
 * contributors.
 *
 *   * Every viewer membership and invitation becomes contributor. No audit
 *     rows are written: a viewer could only have been made through the API
 *     directly, since the web never offered the role (D5 decision 8).
 *   * Postgres can't drop a value from an enum, so organization_role is
 *     recreated without viewer: the old type is renamed aside, the new one
 *     created under the name, both role columns moved to it, and the old type
 *     dropped.
 *   * The type's dependents, from pg_depend, are the two role columns and
 *     organization_invitation_by_token_hash, which returns it. A function's
 *     result type can't be altered, so the function is dropped first and
 *     recreated over the new type exactly as migration 013 defines it: its
 *     definer, stable, search_path, comment, and execute for
 *     telflo_platform_runtime only. No index, constraint, default or policy
 *     names the type. The functions of migrations 010 and 012 compare role
 *     with 'admin' in their bodies, which are resolved when they run and
 *     record no dependency.
 *
 * node-pg-migrate runs the migration in one transaction, so no request sees
 * the columns between the two types.
 *
 * down adds viewer back to the type, with `alter type ... add value`, which
 * leaves the columns and the function as they are. It can't tell which
 * members and invitations were viewers: they stay contributors.
 */

/** Migration 013's function, over whichever organization_role exists when it runs. */
const invitationByTokenHash = `
    -- The invitee's only way past the policies (D6 decision 9): the
    -- invitation whose hash matches, in any state, with its organization's
    -- name and whether that organization is live. It reads nothing else.
    -- The caller decides what each state means and, once the token has found
    -- the invitation, sets the context to its organization for everything
    -- after. stable: it only reads.
    create function organization_invitation_by_token_hash(p_token_hash text)
    returns table (
      id                    uuid,
      organization_id       uuid,
      email                 text,
      role                  organization_role,
      expires_at            timestamptz,
      accepted_at           timestamptz,
      revoked_at            timestamptz,
      organization_name     text,
      organization_is_live  boolean
    )
    language sql
    stable
    security definer
    set search_path = platform, pg_temp
    as $$
      select i.id, i.organization_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
             o.name, o.deleted_at is null
        from organization_invitations i
        join organizations o on o.id = i.organization_id
       where i.token_hash = p_token_hash
    $$;

    comment on function organization_invitation_by_token_hash(text) is
      'the invitation a token''s hash names, past row-level security: an
       invitee holds the token before they belong to the organization (D6
       decision 9). Keyed by a secret of 256 random bits rather than by the
       database context, the one definer function that is (ADR 0023). Only
       telflo_platform_runtime may run it, and the API calls it from one place,
       findInvitationByTokenHash.';

    -- Functions are executable by public by default; this one reads past the
    -- policies, so only the API's role may run it.
    revoke execute on function organization_invitation_by_token_hash(text) from public;
    grant execute on function organization_invitation_by_token_hash(text) to telflo_platform_runtime;
`;

export const up = (pgm) => {
  pgm.sql(`
    -- updated_at records the change; the audit trail doesn't (see above).
    update organization_members set role = 'contributor', updated_at = now() where role = 'viewer';
    update organization_invitations set role = 'contributor', updated_at = now() where role = 'viewer';

    drop function organization_invitation_by_token_hash(text);

    alter type organization_role rename to organization_role_with_viewer;
    create type organization_role as enum ('admin', 'contributor');
    alter table organization_members
      alter column role type organization_role using role::text::organization_role;
    alter table organization_invitations
      alter column role type organization_role using role::text::organization_role;
    drop type organization_role_with_viewer;

    comment on type organization_role is
      'a member''s role in an organization, and the role an invitation gives
       (D7 decision 2). An admin administers the organization: its name, its
       deletion, its members and invitations. Every member may change its
       content. There is no viewer role (migration 014).';

    ${invitationByTokenHash}
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    -- Nothing is moved back: which members and invitations were viewers is
    -- not recorded, so they stay contributors.
    alter type organization_role add value if not exists 'viewer';
    comment on type organization_role is null;
  `);
};
