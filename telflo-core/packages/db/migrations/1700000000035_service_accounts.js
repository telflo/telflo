/**
 * Service accounts and their API tokens.
 *
 *   * users.kind (user_kind: human or service): a service account is a users
 *     row, so every actor column (a configuration's creator, a version's
 *     publisher, an audit row's actor) keeps pointing at users. Every existing
 *     row becomes human, and an insert that names no kind (registration's) is
 *     human.
 *   * The backstops behind the API's checks. Each holds for the API's role
 *     whatever an API path forgets; only an operator can bypass one, as
 *     migration 026's trigger: the tables' owner with ALTER TABLE … DISABLE
 *     TRIGGER or DROP CONSTRAINT, a superuser with session_replication_role =
 *     replica (which skips the triggers, not the checks).
 *       - ck_users_service_account_credentials: a service account has no
 *         password (password sign-in and a password reset can never set
 *         one) and a verified email (a federated sign-in's take-over, kept
 *         for unverified accounts, never applies to it).
 *       - ck_users_service_account_domain: the reserved domain
 *         (@service-accounts.telflo.invalid, exactly, case aside) is held by
 *         service accounts and by nobody else. Its add constraint checks
 *         every existing row, so up refuses a database where a person holds
 *         such an address and changes nothing.
 *       - users_kind_immutable: kind never changes but by the tables' owner
 *         (an operator's SQL); 42501 for anyone else.
 *       - user_identities_human_only and sessions_human_only: a service
 *         account links no sign-in identity and never holds a session
 *         (23514), on an insert or a row moved onto it. Since kind can't
 *         change, checking the identity's and the session's own rows is
 *         enough.
 *       - service_accounts_service_only: a service_accounts row names a
 *         service account, never a person (23514).
 *   * service_accounts: the account's name beside its user, not an actor
 *     table. The account's id is its user's id. "Live" is the row's
 *     deleted_at, set in the same transaction as the user's, since a partial
 *     unique index can't read users.deleted_at: names are unique, case aside,
 *     among the organization's live accounts. An organization's deletion
 *     soft-deletes the users only and leaves these rows as they were; every
 *     read, the lookup's included, also requires the user live.
 *   * api_tokens: an account's tokens, stored only as the SHA-256 of the token
 *     and its first 11 characters. A token is revoked, never deleted by the
 *     API. Its name is unique among the account's tokens not revoked: an index
 *     predicate can't read the clock (it must be immutable), so an expired
 *     token's name stays taken until the token is revoked, as it stays listed,
 *     with its Expired badge, until then. The composite foreign key keeps a
 *     token in its account's organization.
 *   * Row-level security on both tables has migration 032's shape: every
 *     operation, for telflo_platform_runtime, is limited to the organization the
 *     database context names. Admin-only is the API's rule, not the
 *     policies'. No `force`, so the owner and the lookup stay exempt.
 *   * find_live_api_token_by_hash: the token check's only way past the
 *     policies (migration 032's pattern): SECURITY DEFINER, keyed by the
 *     token's hash, EXECUTE for telflo_platform_runtime only. It answers a
 *     token neither revoked nor expired at the API's clock (p_at) whose
 *     account, user, membership and organization are live, and every refusal
 *     is no row. The API calls it from one place, findLiveApiTokenByHash.
 *
 * No grant on the tables: migration 009's default privileges give
 * telflo_platform_runtime select, insert, update and delete on both; only the
 * lookup's EXECUTE is granted here.
 *
 * down refuses while any user is a service account (count only, as
 * migration 030's down refuses): without kind, migration 034's code would
 * treat a password-less user at the reserved domain as a person. Otherwise
 * it drops, in order, the lookup, api_tokens and api_token_access,
 * service_accounts and its trigger's function, the triggers on sessions,
 * user_identities and users and their functions, the two checks,
 * users.kind and user_kind: migration 034's catalogue exactly.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;

export const up = (pgm) => {
  pgm.sql(`
    create type user_kind as enum ('human', 'service');

    comment on type user_kind is
      'whether a user is a person (human) or a service account (service). Set
       at the insert and never changed but by an
       operator (users_kind_immutable).';

    alter table users add column kind user_kind not null default 'human';

    comment on column users.kind is
      'human for a person, service for a service account: every row
       before migration 035 is human, and an insert naming no kind
       (registration''s) is human. Only the tables'' owner changes it
       (users_kind_immutable). The flows that start from an email address
       (registration, sign-in, reset, Google sign-in, invitations) look up
       humans only.';

    alter table users add constraint ck_users_service_account_credentials
      check (kind = 'human' or (password_hash is null and email_verified_at is not null));
    alter table users add constraint ck_users_service_account_domain
      check ((kind = 'service') = (lower(email) like '%@service-accounts.telflo.invalid'));

    comment on constraint ck_users_service_account_credentials on users is
      'a service account has no password, so password sign-in and a reset can
       never set one (the reset''s update fails here), and a verified email,
       so the take-over kept for unverified accounts never applies to it.';
    comment on constraint ck_users_service_account_domain on users is
      'the reserved domain, @service-accounts.telflo.invalid exactly (case
       aside; a subdomain isn''t it), is held by service accounts and by
       nobody else: a person can never hold such an address, whatever an API
       path forgets, and a service account always does. Added over every
       existing row, so migration 035 refuses a
       database where a person holds one.';

    -- Not SECURITY DEFINER: it must see the role that runs the write, as
    -- current_user (migration 026's form). A fixed search_path all the same.
    -- 42501 (insufficient_privilege): the refusal is one of privilege.
    create function refuse_user_kind_change() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if new.kind is distinct from old.kind then
        if not pg_has_role(current_user, (select c.relowner from pg_class c where c.oid = tg_relid), 'MEMBER') then
          raise exception 'only the tables'' owner changes the kind of user %', new.id
            using errcode = 'insufficient_privilege';
        end if;
      end if;
      return new;
    end;
    $$;

    create trigger users_kind_immutable
      before update of kind on users
      for each row execute function refuse_user_kind_change();

    comment on function refuse_user_kind_change() is
      'a user''s kind never changes but by an operator: a
       person never becomes a service account, nor one a person. Refuses an
       update that changes kind unless current_user is a member of the users
       table''s owner, raising 42501 with a message naming only the user''s
       id. A write that leaves kind as it is passes, whoever runs it. Not
       SECURITY DEFINER: it must see the role that runs the write.';
    comment on trigger users_kind_immutable on users is
      'before update of kind, every row, for every role: the API''s role is
       refused any change of kind, the tables'' owner (the operator''s SQL)
       allowed. Only an operator can bypass it: the owner with ALTER TABLE …
       DISABLE TRIGGER, a superuser with session_replication_role = replica.';

    -- Not SECURITY DEFINER: the API's role reads users (migration 009's
    -- grants). A fixed search_path, as migration 026's trigger function.
    create function refuse_service_account_identity() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if exists (select 1 from users u where u.id = new.user_id and u.kind = 'service') then
        raise exception 'user % is a service account and links no identity', new.user_id
          using errcode = 'check_violation';
      end if;
      return new;
    end;
    $$;

    create trigger user_identities_human_only
      before insert or update of user_id on user_identities
      for each row execute function refuse_service_account_identity();

    comment on function refuse_service_account_identity() is
      'a service account links no sign-in identity, so
       Google sign-in can never reach one: refuses a user_identities row whose
       user is of kind service, raising 23514 with a message naming only the
       user''s id. A person''s row passes; a user that doesn''t exist is left
       to the foreign key.';
    comment on trigger user_identities_human_only on user_identities is
      'before insert or update of user_id, every row, for every role. Since
       kind can''t change, checking the identity''s own row is enough. Only an
       operator can bypass it: the owner with ALTER TABLE … DISABLE TRIGGER, a
       superuser with session_replication_role = replica.';

    create function refuse_service_account_session() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if exists (select 1 from users u where u.id = new.user_id and u.kind = 'service') then
        raise exception 'user % is a service account and has no session', new.user_id
          using errcode = 'check_violation';
      end if;
      return new;
    end;
    $$;

    create trigger sessions_human_only
      before insert or update of user_id on sessions
      for each row execute function refuse_service_account_session();

    comment on function refuse_service_account_session() is
      'a service account never signs in: refuses a session
       whose user is of kind service, inserted or moved onto it, raising 23514 with a message naming only
       the user''s id. A person''s session passes; a user that doesn''t exist
       is left to the foreign key. So no session is ever reassigned or revoked
       for a service account, and none exists without a personal
       organization for one.';
    comment on trigger sessions_human_only on sessions is
      'before insert or update of user_id, every row, for every role, as
       user_identities_human_only: a session is never made for a service
       account nor moved onto one. Only an operator can bypass it: the owner with ALTER TABLE …
       DISABLE TRIGGER, a superuser with session_replication_role = replica.';

    create table service_accounts (
      user_id             uuid         primary key references users(id) on delete cascade,
      organization_id     uuid         not null references organizations(id) on delete cascade,
      name                text         not null,
      created_by_user_id  uuid         references users(id) on delete set null,
      created_at          timestamptz  not null,
      updated_at          timestamptz  not null,
      deleted_at          timestamptz,
      constraint uq_service_accounts_user_id_organization_id unique (user_id, organization_id),
      constraint ck_service_accounts_name check (char_length(name) between 1 and 64),
      constraint ck_service_accounts_deleted_after_created check (deleted_at >= created_at)
    );

    comment on table service_accounts is
      'a service account''s name beside its user: the organization it belongs
       to, its name, who made it and when. Not an actor table: actor columns
       point at users. Created with its user and its one contributor
       membership in one transaction, and deleted with them in one. Rows are
       never deleted
       by the API: a deleted account keeps its row, its deleted_at set.';
    comment on column service_accounts.user_id is
      'the account''s user, of kind service (service_accounts_service_only),
       whose id is the account''s id. Cascades: an operator''s hard delete of
       the user takes the row with it.';
    comment on column service_accounts.organization_id is
      'the organization the account belongs to, where its one membership is.
       Cascades: a hard-deleted organization takes its accounts with it. A
       soft-deleted one leaves them as they were: its users are soft-deleted,
       and the lookup refuses both.';
    comment on column service_accounts.name is
      'the account''s name, 1 to 64 characters, trimmed by the API; unique,
       case aside, among the organization''s live accounts. Organization
       content: never in a log line, an error or an audit row. A
       rename keeps the address (users.email).';
    comment on column service_accounts.created_by_user_id is
      'the admin who made it, or null once their account is hard-deleted.';
    comment on column service_accounts.created_at is
      'when the account was made, by the API''s clock.';
    comment on column service_accounts.updated_at is
      'when the account was last renamed (or made), by the API''s clock.';
    comment on column service_accounts.deleted_at is
      'set when an admin deletes the account, in the same transaction as its
       user''s deleted_at: "live" is null here and on the user. A
       deleted account is never restored, and its name is free again.';
    comment on constraint service_accounts_pkey on service_accounts is
      'one row per service account, by its user''s id.';
    comment on constraint service_accounts_user_id_fkey on service_accounts is
      'the account''s user (23503 otherwise); on delete cascade.';
    comment on constraint service_accounts_organization_id_fkey on service_accounts is
      'the account''s organization (23503 otherwise); on delete cascade.';
    comment on constraint service_accounts_created_by_user_id_fkey on service_accounts is
      'the admin who made the account (23503 otherwise); on delete set null.';
    comment on constraint uq_service_accounts_user_id_organization_id on service_accounts is
      'the target of api_tokens'' composite foreign key, so a token stays in
       its account''s organization.';
    comment on constraint ck_service_accounts_name on service_accounts is
      'a name of 1 to 64 characters.';
    comment on constraint ck_service_accounts_deleted_after_created on service_accounts is
      'a deletion is not before the creation.';

    create unique index uq_service_accounts_organization_id_lower_name
      on service_accounts (organization_id, lower(name)) where deleted_at is null;
    create index idx_service_accounts_organization_id_created_at
      on service_accounts (organization_id, created_at desc, user_id desc);

    comment on index uq_service_accounts_organization_id_lower_name is
      'a name is unique, case aside, among the organization''s live accounts,
       as group organizations'' are (uq_organizations_lower_name_group): the
       API reads it under the organization''s lock first and maps this
       index''s violation to the same 409. A deleted account''s name is free.';
    comment on index idx_service_accounts_organization_id_created_at is
      'Settings › Service Accounts lists an organization''s accounts newest
       first; the create counts its live accounts.';

    -- Not SECURITY DEFINER, as user_identities_human_only.
    create function refuse_human_service_account() returns trigger
    language plpgsql
    set search_path = platform, pg_temp
    as $$
    begin
      if exists (select 1 from users u where u.id = new.user_id and u.kind = 'human') then
        raise exception 'user % is a person, not a service account', new.user_id
          using errcode = 'check_violation';
      end if;
      return new;
    end;
    $$;

    create trigger service_accounts_service_only
      before insert or update of user_id on service_accounts
      for each row execute function refuse_human_service_account();

    comment on function refuse_human_service_account() is
      'a service_accounts row names a service account, never a person:
       nothing else ties the row to its user''s kind.
       Refuses a row whose user is of kind human, raising 23514 with a message
       naming only the user''s id. A user that doesn''t exist is left to the
       foreign key.';
    comment on trigger service_accounts_service_only on service_accounts is
      'before insert or update of user_id, every row, for every role. Since
       kind can''t change, checking the row is enough. Only an operator can
       bypass it: the owner with ALTER TABLE … DISABLE TRIGGER, a superuser
       with session_replication_role = replica.';

    create type api_token_access as enum ('read', 'write');

    comment on type api_token_access is
      'what a token may do: read (the default, "Read") or write ("Read &
       write"). Stored and reported by /whoami; the public API enforces it per
       route.';

    create table api_tokens (
      id                       uuid              primary key default uuidv7(),
      organization_id          uuid              not null references organizations(id) on delete cascade,
      service_account_user_id  uuid              not null,
      name                     text              not null,
      token_hash               text              not null,
      token_prefix             text              not null,
      access                   api_token_access  not null,
      expires_at               timestamptz,
      last_used_at             timestamptz,
      created_by_user_id       uuid              references users(id) on delete set null,
      created_at               timestamptz       not null,
      revoked_at               timestamptz,
      revoked_by_user_id       uuid              references users(id) on delete set null,
      constraint fk_api_tokens_service_account
        foreign key (service_account_user_id, organization_id)
        references service_accounts (user_id, organization_id) on delete cascade,
      constraint ck_api_tokens_name check (char_length(name) between 1 and 64),
      constraint ck_api_tokens_token_hash check (token_hash ~ '^[0-9a-f]{64}$'),
      constraint ck_api_tokens_token_prefix check (token_prefix ~ '^tf_[A-Za-z0-9_-]{8}$'),
      constraint ck_api_tokens_expires_after_created check (expires_at > created_at),
      constraint ck_api_tokens_last_used_after_created check (last_used_at >= created_at),
      constraint ck_api_tokens_revoked_after_created check (revoked_at >= created_at),
      constraint ck_api_tokens_revoked_by check (revoked_at is not null or revoked_by_user_id is null)
    );

    comment on table api_tokens is
      'a service account''s API tokens: tf_ and the
       base64url of 32 random bytes, shown once and stored only as its
       SHA-256 and its first 11 characters. Live while neither revoked nor
       past expires_at by the API''s clock. Revoked, never deleted by the API:
       revoked tokens leave the list; expired ones stay listed until revoked.
       Rows go only with their account''s or their organization''s hard
       delete.';
    comment on column api_tokens.id is
      'the token''s id, which audit rows and log lines name (never the token).';
    comment on column api_tokens.organization_id is
      'the organization of the token''s account (the composite foreign key).
       Cascades: a hard-deleted organization takes its tokens with it. A
       soft-deleted one leaves them unrevoked, and the lookup refuses them.';
    comment on column api_tokens.service_account_user_id is
      'the service account the token acts as, in organization_id (the
       composite foreign key; its hard delete cascades).';
    comment on column api_tokens.name is
      'the token''s name, 1 to 64 characters; unique among the account''s
       tokens not revoked, an expired one''s included. Never in a log line, an
       error or an audit row.';
    comment on column api_tokens.token_hash is
      'SHA-256 (lowercase hex) of the whole token, which the lookup is keyed
       by. The token itself is never stored.';
    comment on column api_tokens.token_prefix is
      'the token''s first 11 characters (tf_ and 8), listed as tf_AbC12xYz…
       in the masked list only. Never in a log line, an error or an audit row.';
    comment on column api_tokens.access is
      'read or write, fixed at creation.';
    comment on column api_tokens.expires_at is
      'when the token stops working, by the API''s clock (a whole number of
       days from 1 to 3650 after creation); null never expires.';
    comment on column api_tokens.last_used_at is
      'the token''s last successful check, written at most once a minute by
       the API in the token''s own context; null until the
       first.';
    comment on column api_tokens.created_by_user_id is
      'the admin who made it, or null once their account is hard-deleted.';
    comment on column api_tokens.created_at is
      'when the token was made, by the API''s clock.';
    comment on column api_tokens.revoked_at is
      'set once, when an admin revokes the token or deletes its account; a
       revoked token never works again, and its name is free.';
    comment on column api_tokens.revoked_by_user_id is
      'the admin who revoked it, or null (not revoked, or their account
       hard-deleted).';
    comment on constraint api_tokens_pkey on api_tokens is
      'one row per token, by its id.';
    comment on constraint api_tokens_organization_id_fkey on api_tokens is
      'the token''s organization (23503 otherwise); on delete cascade.';
    comment on constraint api_tokens_created_by_user_id_fkey on api_tokens is
      'the admin who made the token (23503 otherwise); on delete set null.';
    comment on constraint api_tokens_revoked_by_user_id_fkey on api_tokens is
      'the admin who revoked the token (23503 otherwise); on delete set null.';
    comment on constraint fk_api_tokens_service_account on api_tokens is
      'the token''s account, in the token''s own organization: a token can''t
       name another organization''s account (23503). On delete cascade.';
    comment on constraint ck_api_tokens_name on api_tokens is
      'a name of 1 to 64 characters.';
    comment on constraint ck_api_tokens_token_hash on api_tokens is
      'a SHA-256 in lowercase hex: never the token itself.';
    comment on constraint ck_api_tokens_token_prefix on api_tokens is
      'tf_ and 8 base64url characters: the token''s first 11, never more.';
    comment on constraint ck_api_tokens_expires_after_created on api_tokens is
      'an expiry is after the creation.';
    comment on constraint ck_api_tokens_last_used_after_created on api_tokens is
      'a use is not before the creation.';
    comment on constraint ck_api_tokens_revoked_after_created on api_tokens is
      'a revocation is not before the creation.';
    comment on constraint ck_api_tokens_revoked_by on api_tokens is
      'only a revoked token names who revoked it.';

    create unique index uq_api_tokens_token_hash on api_tokens (token_hash);
    create unique index uq_api_tokens_service_account_user_id_lower_name
      on api_tokens (service_account_user_id, lower(name)) where revoked_at is null;
    create index idx_api_tokens_service_account_user_id_created_at
      on api_tokens (service_account_user_id, created_at desc, id desc);

    comment on index uq_api_tokens_token_hash is
      'the lookup''s key: a hash finds at most one token. 256 random bits
       never collide in practice; this makes a collision an error rather than
       an ambiguity.';
    comment on index uq_api_tokens_service_account_user_id_lower_name is
      'a name is unique, case aside, among the account''s tokens not revoked.
       Not "not expired": an index predicate can''t read the clock, so an
       expired token''s name stays taken until it is revoked, as it stays
       listed until then.';
    comment on index idx_api_tokens_service_account_user_id_created_at is
      'an account''s tokens newest first; the create counts its live tokens,
       and the account''s delete revokes them.';

    alter table service_accounts enable row level security;

    create policy service_accounts_select on service_accounts
      for select to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    create policy service_accounts_insert on service_accounts
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy service_accounts_update on service_accounts
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    create policy service_accounts_delete on service_accounts
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    comment on policy service_accounts_select on service_accounts is
      'the API''s role sees only the context''s organization''s accounts,
       deleted ones included: the repository hides those. A backstop behind
       the organization scope.';
    comment on policy service_accounts_insert on service_accounts is
      'the API''s role creates accounts only in the context''s organization
       (42501 otherwise).';
    comment on policy service_accounts_update on service_accounts is
      'the API''s role changes only the context''s organization''s accounts,
       and can''t move one into another organization.';
    comment on policy service_accounts_delete on service_accounts is
      'the API''s role deletes only the context''s organization''s accounts
       (it deletes none: a deleted account keeps its row).';

    alter table api_tokens enable row level security;

    create policy api_tokens_select on api_tokens
      for select to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    create policy api_tokens_insert on api_tokens
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy api_tokens_update on api_tokens
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    create policy api_tokens_delete on api_tokens
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    comment on policy api_tokens_select on api_tokens is
      'the API''s role sees only the context''s organization''s tokens. The
       token check finds its token through find_live_api_token_by_hash, then
       reads in the token''s own context.';
    comment on policy api_tokens_insert on api_tokens is
      'the API''s role creates tokens only in the context''s organization
       (42501 otherwise).';
    comment on policy api_tokens_update on api_tokens is
      'the API''s role changes only the context''s organization''s tokens (a
       revocation, "Last used"), and can''t move one into another
       organization.';
    comment on policy api_tokens_delete on api_tokens is
      'the API''s role deletes only the context''s organization''s tokens (it
       deletes none: a token is revoked).';

    -- The token check's only way past the policies (as
    -- migration 032's lookup): only what the check needs to build the
    -- token's context, for a token live at the API's clock. stable: it only
    -- reads ("Last used" is written by the API through the policies). A fixed
    -- search_path and schema-qualified tables, as migration 032's.
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
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    do $$
    declare
      service_users bigint;
    begin
      select count(*) into service_users
        from users
       where kind = 'service';
      if service_users > 0 then
        raise exception
          'cannot restore migration 034''s users: % user(s) are service accounts',
          service_users
          using errcode = 'check_violation';
      end if;
    end
    $$;

    drop function find_live_api_token_by_hash(text, timestamptz);
    drop table api_tokens;
    drop type api_token_access;
    drop table service_accounts;
    drop function refuse_human_service_account();
    drop trigger sessions_human_only on sessions;
    drop function refuse_service_account_session();
    drop trigger user_identities_human_only on user_identities;
    drop function refuse_service_account_identity();
    drop trigger users_kind_immutable on users;
    drop function refuse_user_kind_change();
    alter table users drop constraint ck_users_service_account_domain;
    alter table users drop constraint ck_users_service_account_credentials;
    alter table users drop column kind;
    drop type user_kind;
  `);
};
