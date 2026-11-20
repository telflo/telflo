/**
 * Personal API tokens and the token lookup for both kinds.
 *
 *   * personal_api_tokens: a person's own `tf_` tokens, as service accounts'
 *     api_tokens (migration 035) but belonging to the user, not to an
 *     organization: the organization is named per request (X-Telflo-Org).
 *     Stored only as the token's SHA-256 and its first 11 characters; revoked,
 *     never deleted by the API; api_tokens' checks, named
 *     ck_personal_api_tokens_*. A name is unique, case aside, among the
 *     person's tokens not revoked (an expired one's included, as for
 *     api_tokens: an index predicate can't read the clock). The 20-token cap
 *     is the API's, under a lock on the user's row. A user's hard delete takes
 *     their tokens with it; a soft-deleted user's are refused by the lookup.
 *   * Row-level security on the context's user (telflo.user_id, migration
 *     011's form): for telflo_platform_runtime, every operation sees and changes
 *     the context's user's own rows only, whatever organization the context
 *     names, and no context sees none. No `force`, so the owner and the
 *     lookup stay exempt.
 *   * find_live_api_token_by_hash answers both kinds. Its return shape
 *     changes, which `create or replace` refuses, so it is dropped and created
 *     again, and its comment and grants, lost with it, are restated. One row
 *     for a live token: (kind, token_id, user_id, email, access,
 *     organization_id, role).
 *       - kind 'service_account': migration 035's joins and conditions
 *         exactly, with the account's address (users.email);
 *         its organization and the membership's role.
 *       - kind 'person': a personal token neither revoked nor expired at
 *         p_at whose user is a live person (kind human, not deleted);
 *         organization and role null.
 *     Still SECURITY DEFINER, stable, with a fixed search_path and
 *     schema-qualified tables, EXECUTE for telflo_platform_runtime only, and
 *     every refusal no row alike. The API calls it from one place,
 *     findLiveApiTokenByHash.
 *
 * No grant on the table: migration 009's default privileges give
 * telflo_platform_runtime select, insert, update and delete on it; only the
 * lookup's EXECUTE is granted here, as migration 035 did.
 *
 * down drops the lookup and the table with its rows (a person's tokens
 * stop working, as none existed before this migration), then creates
 * migration 035's lookup again, its definition, comment and grants byte
 * for byte: migration 037's catalogue exactly.
 */

const contextUser = `nullif(current_setting('telflo.user_id', true), '')::uuid`;

/** Migration 035's lookup, its comment and its grants, exactly as 035 created them: what down restores. */
const migration035Lookup = `
    create function find_live_api_token_by_hash(p_token_hash text, p_at timestamptz)
    returns table (
      token_id                 uuid,
      organization_id          uuid,
      service_account_user_id  uuid,
      access                   api_token_access,
      role                     organization_role
    )
    language sql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
      select t.id, t.organization_id, t.service_account_user_id, t.access, m.role
        from platform.api_tokens t
        join platform.service_accounts sa
          on sa.user_id = t.service_account_user_id and sa.organization_id = t.organization_id
        join platform.users u on u.id = t.service_account_user_id
        join platform.organization_members m
          on m.user_id = t.service_account_user_id and m.organization_id = t.organization_id
        join platform.organizations o on o.id = t.organization_id
       where t.token_hash = p_token_hash
         and t.revoked_at is null
         and (t.expires_at is null or t.expires_at > p_at)
         and sa.deleted_at is null
         and u.deleted_at is null
         and u.kind = 'service'
         and m.deleted_at is null
         and o.deleted_at is null
    $$;

    comment on function find_live_api_token_by_hash(text, timestamptz) is
      'the token a hash names, past row-level security, while it is live:
       neither revoked nor expired at p_at (the API''s clock, never the
       database''s), its account, its user (of kind service), its
       membership and its organization live. It answers the token''s id, its
       organization, its account, its access and the membership''s role,
       nothing else: the name is read afterwards through the policies, in the
       token''s context. Every refusal (an unknown hash, a revoked or expired
       token, a deleted account, user, membership or organization) is no row
       alike. Keyed by a secret of 256 random bits rather than by the database
       context. Only telflo_platform_runtime may run it, and the API
       calls it from one place, findLiveApiTokenByHash.';

    revoke execute on function find_live_api_token_by_hash(text, timestamptz) from public;
    grant execute on function find_live_api_token_by_hash(text, timestamptz) to telflo_platform_runtime;
`;

export const up = (pgm) => {
  pgm.sql(`
    create table personal_api_tokens (
      id            uuid              primary key default uuidv7(),
      user_id       uuid              not null references users(id) on delete cascade,
      name          text              not null,
      token_hash    text              not null,
      token_prefix  text              not null,
      access        api_token_access  not null,
      expires_at    timestamptz,
      last_used_at  timestamptz,
      created_at    timestamptz       not null,
      revoked_at    timestamptz,
      constraint ck_personal_api_tokens_name check (char_length(name) between 1 and 64),
      constraint ck_personal_api_tokens_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint ck_personal_api_tokens_token_prefix check (token_prefix ~ '^tf_[A-Za-z0-9_-]{8}$'),
      constraint ck_personal_api_tokens_expires_after_created check (expires_at > created_at),
      constraint ck_personal_api_tokens_last_used_after_created check (last_used_at >= created_at),
      constraint ck_personal_api_tokens_revoked_after_created check (revoked_at >= created_at)
    );

    comment on table personal_api_tokens is
      'a person''s own API tokens: tf_ and the base64url of
       32 random bytes, shown once and stored only as its SHA-256 and its
       first 11 characters, as a service account''s (api_tokens). Belongs to
       the user, not to an organization: the organization is named on each
       request (X-Telflo-Org) and the person''s membership there read then.
       Live while neither revoked nor past expires_at by the API''s clock,
       and its user a live person. Revoked, never deleted by the API; rows go
       only with their user''s hard delete. Row-level security shows the
       context''s user their own rows only.';
    comment on column personal_api_tokens.id is
      'the token''s id, which audit rows and log lines name (never the token).';
    comment on column personal_api_tokens.user_id is
      'the person the token acts as. Cascades: an operator''s hard delete of
       the user takes their tokens with it; a soft-deleted user''s are
       refused by the lookup.';
    comment on column personal_api_tokens.name is
      'the token''s name, 1 to 64 characters; unique, case aside, among the
       person''s tokens not revoked, an expired one''s included. The person''s
       content: never in a log line, an error or an audit row.';
    comment on column personal_api_tokens.token_hash is
      'SHA-256 (lowercase hex) of the whole token, which the lookup is keyed
       by. The token itself is never stored.';
    comment on column personal_api_tokens.token_prefix is
      'the token''s first 11 characters (tf_ and 8), listed as tf_AbC12xYz…
       in the masked list only. Never in a log line, an error or an audit row.';
    comment on column personal_api_tokens.access is
      'read or write, fixed at creation.';
    comment on column personal_api_tokens.expires_at is
      'when the token stops working, by the API''s clock (a whole number of
       days from 1 to 3650 after creation); null never expires.';
    comment on column personal_api_tokens.last_used_at is
      'the token''s last successful check, written at most once a minute by
       the API in the person''s own context; null until the first.';
    comment on column personal_api_tokens.created_at is
      'when the token was made, by the API''s clock.';
    comment on column personal_api_tokens.revoked_at is
      'set once, when the person revokes the token; a revoked token never
       works again, and its name is free.';
    comment on constraint personal_api_tokens_pkey on personal_api_tokens is
      'one row per token, by its id.';
    comment on constraint personal_api_tokens_user_id_fkey on personal_api_tokens is
      'the token''s person (23503 otherwise); on delete cascade.';
    comment on constraint ck_personal_api_tokens_name on personal_api_tokens is
      'a name of 1 to 64 characters.';
    comment on constraint ck_personal_api_tokens_token_hash on personal_api_tokens is
      'a SHA-256 in lowercase hex: never the token itself.';
    comment on constraint ck_personal_api_tokens_token_prefix on personal_api_tokens is
      'tf_ and 8 base64url characters: the token''s first 11, never more.';
    comment on constraint ck_personal_api_tokens_expires_after_created on personal_api_tokens is
      'an expiry is after the creation.';
    comment on constraint ck_personal_api_tokens_last_used_after_created on personal_api_tokens is
      'a use is not before the creation.';
    comment on constraint ck_personal_api_tokens_revoked_after_created on personal_api_tokens is
      'a revocation is not before the creation.';

    create unique index uq_personal_api_tokens_token_hash on personal_api_tokens (token_hash);
    create unique index uq_personal_api_tokens_user_id_lower_name
      on personal_api_tokens (user_id, lower(name)) where revoked_at is null;
    create index idx_personal_api_tokens_user_id_created_at
      on personal_api_tokens (user_id, created_at desc, id desc);

    comment on index uq_personal_api_tokens_token_hash is
      'the lookup''s key: a hash finds at most one personal token. 256 random
       bits never collide in practice; this makes a collision an error rather
       than an ambiguity.';
    comment on index uq_personal_api_tokens_user_id_lower_name is
      'a name is unique, case aside, among the person''s tokens not revoked.
       Not "not expired": an index predicate can''t read the clock, so an
       expired token''s name stays taken until it is revoked, as it stays
       listed until then.';
    comment on index idx_personal_api_tokens_user_id_created_at is
      'a person''s tokens newest first (Settings › Account); the create counts
       their live tokens.';

    alter table personal_api_tokens enable row level security;

    create policy personal_api_tokens_select on personal_api_tokens
      for select to telflo_platform_runtime
      using (user_id = ${contextUser});

    create policy personal_api_tokens_insert on personal_api_tokens
      for insert to telflo_platform_runtime
      with check (user_id = ${contextUser});

    create policy personal_api_tokens_update on personal_api_tokens
      for update to telflo_platform_runtime
      using (user_id = ${contextUser})
      with check (user_id = ${contextUser});

    create policy personal_api_tokens_delete on personal_api_tokens
      for delete to telflo_platform_runtime
      using (user_id = ${contextUser});

    comment on policy personal_api_tokens_select on personal_api_tokens is
      'the API''s role sees only the context''s user''s own tokens, whatever
       organization the context names; no user in the context sees none. The
       token check finds a token through find_live_api_token_by_hash, then
       works in the person''s own context.';
    comment on policy personal_api_tokens_insert on personal_api_tokens is
      'the API''s role creates tokens only for the context''s user (42501
       otherwise).';
    comment on policy personal_api_tokens_update on personal_api_tokens is
      'the API''s role changes only the context''s user''s own tokens (a
       revocation, "Last used"), and can''t move one to another person.';
    comment on policy personal_api_tokens_delete on personal_api_tokens is
      'the API''s role deletes only the context''s user''s own tokens (it
       deletes none: a token is revoked).';

    -- The return shape changes, which create or replace
    -- refuses: dropped and created again, its comment and grants restated.
    drop function find_live_api_token_by_hash(text, timestamptz);

    -- The token check's only way past the policies (as
    -- migrations 032's and 035's lookups): only what the check needs to
    -- build the token's context, for a token live at the API's clock.
    -- stable: it only reads ("Last used" is written by the API through the
    -- policies). A fixed search_path and schema-qualified tables.
    create function find_live_api_token_by_hash(p_token_hash text, p_at timestamptz)
    returns table (
      kind             text,
      token_id         uuid,
      user_id          uuid,
      email            text,
      access           api_token_access,
      organization_id  uuid,
      role             organization_role
    )
    language sql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
      select 'service_account'::text, t.id, t.service_account_user_id, u.email::text, t.access,
             t.organization_id, m.role
        from platform.api_tokens t
        join platform.service_accounts sa
          on sa.user_id = t.service_account_user_id and sa.organization_id = t.organization_id
        join platform.users u on u.id = t.service_account_user_id
        join platform.organization_members m
          on m.user_id = t.service_account_user_id and m.organization_id = t.organization_id
        join platform.organizations o on o.id = t.organization_id
       where t.token_hash = p_token_hash
         and t.revoked_at is null
         and (t.expires_at is null or t.expires_at > p_at)
         and sa.deleted_at is null
         and u.deleted_at is null
         and u.kind = 'service'
         and m.deleted_at is null
         and o.deleted_at is null
      union all
      select 'person'::text, p.id, p.user_id, u.email::text, p.access,
             null::uuid, null::platform.organization_role
        from platform.personal_api_tokens p
        join platform.users u on u.id = p.user_id
       where p.token_hash = p_token_hash
         and p.revoked_at is null
         and (p.expires_at is null or p.expires_at > p_at)
         and u.deleted_at is null
         and u.kind = 'human'
    $$;

    comment on function find_live_api_token_by_hash(text, timestamptz) is
      'the token a hash names, of either kind, past row-level security, while
       it is live: neither revoked nor
       expired at p_at (the API''s clock, never the database''s). A service
       account''s (kind service_account) needs its account, its user (of kind
       service), its membership and its organization live, and answers the
       token''s id, its account, the account''s address, its access, its
       organization and the membership''s role. A person''s
       (personal_api_tokens, kind person) needs its user a live person (kind
       human, not deleted), and answers the token''s id, the person, their
       email and its access, with no organization and no role: the
       organization is named per request. Nothing else: the name is read
       afterwards through the policies. Every refusal (an unknown hash, a
       revoked or expired token, a deleted account, user, membership or
       organization, a person''s token on a user who isn''t a live person) is
       no row alike. Keyed by a secret of 256 random bits rather than by the
       database context. Only telflo_platform_runtime may run it, and
       the API calls it from one place, findLiveApiTokenByHash.';

    revoke execute on function find_live_api_token_by_hash(text, timestamptz) from public;
    grant execute on function find_live_api_token_by_hash(text, timestamptz) to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function find_live_api_token_by_hash(text, timestamptz);
    drop table personal_api_tokens;
    ${migration035Lookup}
  `);
};
