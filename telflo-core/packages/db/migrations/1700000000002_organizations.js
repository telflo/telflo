/**
 * Organizations and their memberships, plus a backfill that gives every
 * existing account a personal organization.
 *
 * The rule that no account exists without a membership is enforced by the
 * next migration, once registration and the tests create organizations
 * together with users.
 */
export const up = (pgm) => {
  pgm.sql(`
    -- Postgres enum types with singular names. The roles carry no "org_"
    -- prefix (a banned one).
    create type organization_type as enum ('personal', 'group');
    create type organization_role as enum ('admin', 'contributor', 'viewer');

    create table organizations (
      id             uuid              primary key default uuidv7(),
      name           text              not null,
      type           organization_type not null,
      owner_user_id  uuid              not null references users(id) on delete cascade,
      created_at     timestamptz       not null default now(),
      updated_at     timestamptz       not null default now(),
      deleted_at     timestamptz,
      constraint ck_organizations_name_length check (char_length(name) between 1 and 300)
    );

    -- Neither this table nor organization_members carries a unique
    -- (id, organization_id) composite foreign-key target:
    -- organizations.id is itself the organization id, and nothing references
    -- a membership yet. Add the pattern when a child table needs it.
    comment on table organizations is
      'the tenant boundary. Every account belongs to at least one. Name
       uniqueness is deliberately absent: a global unique name would let anyone
       block a future signup by taking its derived personal name, and would
       reveal whether an email has an account. A later migration decides
       group-name uniqueness.';
    comment on column organizations.name is
      'a personal organization is named <lowercased email>''s workspace. The
       300-character limit guards against unbounded input (at most 254
       characters of email plus the 12-character suffix).';
    comment on column organizations.type is
      'personal: created with the account at registration, one per user. group:
       created and shared deliberately.';
    comment on column organizations.owner_user_id is
      'cascades on user deletion: a hard-deleted user takes their personal
       organization with them. Users are normally soft-deleted, so this matters
       mainly for tests and operator cleanup. A later migration revisits it
       for group organizations, whose owner leaving must not delete them.';

    -- One personal organization per user.
    create unique index uq_organizations_owner_user_id_personal
      on organizations (owner_user_id) where type = 'personal';

    create table organization_members (
      id               uuid              primary key default uuidv7(),
      organization_id  uuid              not null references organizations(id) on delete cascade,
      user_id          uuid              not null references users(id) on delete cascade,
      role             organization_role not null,
      created_at       timestamptz       not null default now(),
      updated_at       timestamptz       not null default now()
    );

    comment on table organization_members is
      'a user''s membership of an organization, with a role. Member status
       (invited, active, removed) is deferred to later migrations.';

    create unique index uq_organization_members_organization_id_user_id
      on organization_members (organization_id, user_id);
    create index idx_organization_members_user_id on organization_members (user_id);

    -- Backfill: every account that predates this migration gets a personal
    -- organization and an admin membership, exactly as registration now
    -- creates them, and the audit events registration writes for them:
    -- organization.created and organization_member.added, each attributed to
    -- the owner and marked source backfill. Set-based: the inserts chain
    -- through data-modifying CTEs. audit_events is append-only, but its
    -- trigger blocks only update and delete; inserts are allowed.
    --
    -- Soft-deleted users are skipped: a departed account should not gain an
    -- organization, a membership or audit history, and the membership
    -- invariant (next migration) exempts soft-deleted users anyway.
    with users_without_membership as (
      select u.id, u.email
        from users u
       where u.deleted_at is null
         and not exists (
           select 1 from organization_members m where m.user_id = u.id
         )
    ),
    created_organizations as (
      insert into organizations (name, type, owner_user_id)
      select lower(email) || '''s workspace', 'personal', id
        from users_without_membership
      returning id, owner_user_id
    ),
    created_memberships as (
      insert into organization_members (organization_id, user_id, role)
      select id, owner_user_id, 'admin'
        from created_organizations
      returning id, organization_id, user_id
    ),
    backfill_events as (
      select o.owner_user_id as actor_user_id, u.email as actor_email,
             o.id as organization_id, 1 as sequence,
             'organization.created' as action, 'organization' as subject_type, o.id as subject_id,
             '{"type":"personal","source":"backfill"}'::jsonb as metadata
        from created_organizations o
        join users_without_membership u on u.id = o.owner_user_id
      union all
      select m.user_id, u.email, m.organization_id, 2,
             'organization_member.added', 'organization_member', m.id,
             '{"role":"admin","source":"backfill"}'::jsonb
        from created_memberships m
        join users_without_membership u on u.id = m.user_id
    )
    -- One insert, ordered per account as registration writes them:
    -- organization.created, then organization_member.added.
    insert into audit_events
      (actor_user_id, actor_email, organization_id, action, subject_type, subject_id, metadata)
    select actor_user_id, actor_email, organization_id, action, subject_type, subject_id, metadata
      from backfill_events
     order by actor_user_id, sequence;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop table if exists organization_members;
    drop table if exists organizations;
    drop type if exists organization_role;
    drop type if exists organization_type;
  `);
};
