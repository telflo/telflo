/**
 * Organization invitations (D6 decisions 1, 2 and 9).
 *
 *   * An invitation is its own row, addressed to an email, rather than an
 *     `invited` membership: no account exists until the invitee
 *     creates one, so an invitation to an unregistered address touches nothing
 *     but this row.
 *   * It is pending while neither accepted nor revoked. A partial unique index
 *     allows one pending invitation per address per organization; accepted
 *     and revoked ones stay for the audit trail, and don't block a new one.
 *   * Row-level security has migration 011's shape for the organization's
 *     rows: every operation, for telflo_platform_runtime, is limited to the
 *     organization the database context names. No `force`, so the owner
 *     (migrations, fixtures) and the function below stay exempt.
 *   * An invitee acts before they belong to the organization, so the token
 *     has to find its invitation first. organization_invitation_by_token_hash
 *     is SECURITY DEFINER and keyed by the token's hash, a secret, rather than
 *     by the database context (ADR 0023 amends ADR 0022 for it). Everything
 *     after the lookup sets the context and goes through the policies.
 *
 * Migration 009's default privileges already give telflo_platform_runtime select,
 * insert, update and delete on the new table, so nothing is granted here.
 *
 * down drops the function and the table, and the policies and indexes with
 * it.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;

export const up = (pgm) => {
  pgm.sql(`
    create table organization_invitations (
      id                   uuid              primary key default uuidv7(),
      organization_id      uuid              not null references organizations(id) on delete cascade,
      email                text              not null,
      role                 organization_role not null,
      token_hash           text              not null,
      invited_by_user_id   uuid              references users(id) on delete set null,
      expires_at           timestamptz       not null,
      created_at           timestamptz       not null default now(),
      updated_at           timestamptz       not null default now(),
      accepted_at          timestamptz,
      accepted_by_user_id  uuid              references users(id) on delete set null,
      revoked_at           timestamptz,
      constraint ck_organization_invitations_email_lowercase check (email = lower(email)),
      -- Not an equality: a hard-deleted acceptor sets accepted_by_user_id to
      -- null and leaves an accepted invitation without one.
      constraint ck_organization_invitations_accepted_by
        check (accepted_at is not null or accepted_by_user_id is null),
      constraint ck_organization_invitations_one_outcome check (accepted_at is null or revoked_at is null)
    );

    comment on table organization_invitations is
      'an admin''s invitation of an email address into an organization, with
       the role the invitee will have (D6 decision 1). Pending while
       accepted_at and revoked_at are both null; a pending invitation past
       expires_at is expired, stays listed, and Resend revives it. Rows are
       never deleted by the API: accepted and revoked ones are the audit
       trail.';
    comment on column organization_invitations.organization_id is
      'the inviting organization. Cascades: a hard-deleted organization takes
       its invitations with it. A soft-deleted one keeps them, and the lookup
       by token reports it as not live.';
    comment on column organization_invitations.email is
      'the invited address, lowercased (ck_organization_invitations_email_lowercase),
       so the one-pending index and the accepting account''s email compare
       without case. Only an account with this address may accept (D6
       decision 3).';
    comment on column organization_invitations.token_hash is
      'sha-256 of the link''s token, as for verification and reset tokens.
       The plaintext is emailed, in the link''s fragment, and never stored.
       Resend replaces it, so an earlier link stops working.';
    comment on column organization_invitations.invited_by_user_id is
      'the admin who invited, or null once their account is hard-deleted
       (normally users are soft-deleted). The audit trail keeps who invited
       either way.';
    comment on column organization_invitations.expires_at is
      '7 days after the latest send (INVITATION_TTL_DAYS). Compared with the
       API''s clock, never the database''s, so tests can move time.';
    comment on column organization_invitations.accepted_by_user_id is
      'the account that accepted, set with accepted_at. Null for an accepted
       invitation only once that account is hard-deleted
       (ck_organization_invitations_accepted_by).';
    comment on column organization_invitations.revoked_at is
      'set when an admin cancels the invitation. The row stays, for the audit
       trail. An invitation is never both accepted and
       revoked (ck_organization_invitations_one_outcome).';

    create unique index uq_organization_invitations_token_hash
      on organization_invitations (token_hash);
    create unique index uq_organization_invitations_one_pending
      on organization_invitations (organization_id, email)
      where accepted_at is null and revoked_at is null;
    create index idx_organization_invitations_organization_id
      on organization_invitations (organization_id);

    comment on index uq_organization_invitations_token_hash is
      'a token finds at most one invitation. 256 random bits never collide in
       practice; this makes a collision an error rather than an ambiguity.';
    comment on index uq_organization_invitations_one_pending is
      'one pending invitation per address per organization (D6 decision 1),
       expired ones included. Accepted and revoked invitations fall out of it,
       so the address can be invited again.';
    comment on index idx_organization_invitations_organization_id is
      'the Invited tab lists an organization''s invitations, and a hard delete
       of an organization cascades to them. The one-pending index covers
       pending rows only.';

    alter table organization_invitations enable row level security;

    create policy organization_invitations_select on organization_invitations
      for select to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    create policy organization_invitations_insert on organization_invitations
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy organization_invitations_update on organization_invitations
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    -- Nothing deletes an invitation (cancelling sets revoked_at), but a
    -- policy keeps a future delete inside the organization.
    create policy organization_invitations_delete on organization_invitations
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

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
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function if exists organization_invitation_by_token_hash(text);
    drop table if exists organization_invitations;
  `);
};
