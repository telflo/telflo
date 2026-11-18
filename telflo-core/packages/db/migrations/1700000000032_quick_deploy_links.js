/**
 * Quick-deploy links (D17c-2 decisions 3, 5, 7 and 22; Preflight rulings 1
 * to 5).
 *
 *   * A link is an organization's row: a member made it for one of the
 *     organization's `server` fleets (the opamp-server's ids, no foreign
 *     key: the fleet, its group and its default token live there, ADR
 *     0026), with the bundle request's validated fields (`choices`), the
 *     typed values sealed (`env_ciphertext`, AES-256-GCM under the API's
 *     key `env_key_id`), its lifetime and its downloads. Its secret is
 *     stored only as its sha-256 (`secret_hash`), as an invitation's token.
 *   * Row-level security has migration 013's shape: every operation, for
 *     telflo_platform_runtime, is limited to the organization the database
 *     context names. No `force`, so the owner and the function below stay
 *     exempt.
 *   * Whoever holds a link downloads without signing in, so the secret has
 *     to find its link before any context can be set:
 *     quick_deploy_link_by_secret_hash is SECURITY DEFINER and keyed by the
 *     secret's hash (ADR 0023's rule: 256 random bits, stored as a hash,
 *     matched exactly), the second such function after migration 013's. It
 *     answers only what the caller needs to go on (the link's id, its
 *     organization and whether that organization is live); everything after
 *     sets the context to that organization and goes through the policies,
 *     the counter's update included.
 *   * Rows are never deleted by the API but with their fleet's delete; an
 *     organization's hard delete cascades. Timestamps have no default: the
 *     API writes them from its clock. The id's default is for fixtures: the
 *     API picks it (select uuidv7()) before the insert, since the sealed
 *     values' associated data names it.
 *   * At most 100 links neither expired nor revoked per fleet: the API
 *     counts them under a transaction-scoped advisory lock on the
 *     organization's fleet (no constraint can say "active at the API's
 *     clock").
 *
 * Migration 009's default privileges give telflo_platform_runtime select,
 * insert, update and delete on the new table; only the function's EXECUTE
 * is granted here.
 *
 * down drops the function and the table, and the policies and indexes with
 * it.
 */

const contextOrganization = `nullif(current_setting('telflo.organization_id', true), '')::uuid`;

export const up = (pgm) => {
  pgm.sql(`
    create table quick_deploy_links (
      id                  uuid         primary key default uuidv7(),
      organization_id     uuid         not null references organizations(id) on delete cascade,
      fleet_id            uuid         not null,
      group_id            uuid         not null,
      default_token_id    uuid         not null,
      created_by_user_id  uuid         references users(id) on delete set null,
      secret_hash         text         not null,
      choices             jsonb        not null,
      env_ciphertext      bytea,
      env_key_id          text,
      created_at          timestamptz  not null,
      expires_at          timestamptz,
      revoked_at          timestamptz,
      revoked_by_user_id  uuid         references users(id) on delete set null,
      download_count      integer      not null default 0,
      last_downloaded_at  timestamptz,
      constraint ck_quick_deploy_links_secret_hash check (secret_hash ~ '^[0-9a-f]{64}$'),
      constraint ck_quick_deploy_links_choices
        check (jsonb_typeof(choices) = 'object' and octet_length(choices::text) <= 16384),
      constraint ck_quick_deploy_links_env_sealed
        check ((env_ciphertext is null) = (env_key_id is null)),
      constraint ck_quick_deploy_links_env_key_id check (env_key_id ~ '^[0-9a-f]{16}$'),
      constraint ck_quick_deploy_links_env_ciphertext_length
        check (octet_length(env_ciphertext) between 29 and 1048576),
      constraint ck_quick_deploy_links_expires_after_created check (expires_at > created_at),
      constraint ck_quick_deploy_links_revoked_after_created check (revoked_at >= created_at),
      constraint ck_quick_deploy_links_revoked_by check (revoked_at is not null or revoked_by_user_id is null),
      constraint ck_quick_deploy_links_downloads
        check (download_count >= 0 and (download_count = 0) = (last_downloaded_at is null))
    );

    comment on table quick_deploy_links is
      'a quick-deploy link (D17c-2): whoever holds its secret downloads the
       install it was made for, rendered at each download from choices and
       the group''s current published version, until it expires or is
       revoked. Rows go only with their fleet''s delete or their
       organization''s hard delete: revoked and expired ones stay listed.';
    comment on column quick_deploy_links.id is
      'the link''s id, which the API picks (select uuidv7()) before the
       insert: the sealed values'' associated data names it. The default is
       for fixtures.';
    comment on column quick_deploy_links.organization_id is
      'the organization whose fleet the link installs into. Cascades: a
       hard-deleted organization takes its links with it. A soft-deleted one
       keeps them, and the lookup by secret reports it as not live.';
    comment on column quick_deploy_links.fleet_id is
      'the opamp-server''s fleet (no foreign key: the fleet lives there).
       The fleet''s delete through the platform deletes its links.';
    comment on column quick_deploy_links.group_id is
      'the opamp-server''s collector group the install enrolls into.';
    comment on column quick_deploy_links.default_token_id is
      'the fleet''s default token whose bearer the link''s command carries: a
       download is refused once that token is revoked (decision 6).';
    comment on column quick_deploy_links.created_by_user_id is
      'the member who made it, or null once their account is hard-deleted.';
    comment on column quick_deploy_links.secret_hash is
      'sha-256 (hex) of the link''s secret (tqd_ and 43 base64url
       characters, 256 random bits). The secret is shown once and never
       stored.';
    comment on column quick_deploy_links.choices is
      'the bundle request''s validated fields: method, arch, rootPath,
       executablePath (null for all-in-one), systemd and envNames. Never a
       value, a display name or the secret.';
    comment on column quick_deploy_links.env_ciphertext is
      'the values typed for the configuration''s variables, sealed with
       AES-256-GCM (a version byte, the 12-byte nonce, the 16-byte tag, the
       ciphertext; the organization''s and the link''s ids as associated
       data). Null when none was typed.';
    comment on column quick_deploy_links.env_key_id is
      'which of the API''s keys sealed env_ciphertext (16 hex characters
       derived from the key, never the key). Set exactly when the ciphertext
       is.';
    comment on column quick_deploy_links.created_at is
      'when the link was made, by the API''s clock.';
    comment on column quick_deploy_links.expires_at is
      'when the link stops working, by the API''s clock (24 hours after
       creation; Extend sets it counted from now); null never expires.';
    comment on column quick_deploy_links.revoked_at is
      'set once, when a member revokes it; a revoked link is never
       re-enabled.';
    comment on column quick_deploy_links.revoked_by_user_id is
      'the member who revoked it, or null (not revoked, or their account
       hard-deleted).';
    comment on column quick_deploy_links.download_count is
      'successful downloads, counted in the transaction that audits each.';
    comment on column quick_deploy_links.last_downloaded_at is
      'the latest successful download, by the API''s clock; null exactly while
       download_count is 0.';
    comment on constraint quick_deploy_links_pkey on quick_deploy_links is
      'one row per link, by its id.';
    comment on constraint quick_deploy_links_organization_id_fkey on quick_deploy_links is
      'the link''s organization (23503 otherwise); on delete cascade.';
    comment on constraint quick_deploy_links_created_by_user_id_fkey on quick_deploy_links is
      'the member who made the link (23503 otherwise); on delete set null.';
    comment on constraint quick_deploy_links_revoked_by_user_id_fkey on quick_deploy_links is
      'the member who revoked the link (23503 otherwise); on delete set null.';
    comment on constraint ck_quick_deploy_links_secret_hash on quick_deploy_links is
      'a sha-256 in lowercase hex: never the secret itself.';
    comment on constraint ck_quick_deploy_links_choices on quick_deploy_links is
      'an object of at most 16 KiB (50 names of 256 characters and the paths fit).';
    comment on constraint ck_quick_deploy_links_env_sealed on quick_deploy_links is
      'a ciphertext always names its key, and a key id has a ciphertext.';
    comment on constraint ck_quick_deploy_links_env_key_id on quick_deploy_links is
      'a key id is 16 lowercase hex characters.';
    comment on constraint ck_quick_deploy_links_env_ciphertext_length on quick_deploy_links is
      'the sealed values: at least the header (29 bytes), at most 1 MiB.';
    comment on constraint ck_quick_deploy_links_expires_after_created on quick_deploy_links is
      'an expiry is after the creation (an extension counts from now).';
    comment on constraint ck_quick_deploy_links_revoked_after_created on quick_deploy_links is
      'a revocation is not before the creation.';
    comment on constraint ck_quick_deploy_links_revoked_by on quick_deploy_links is
      'only a revoked link names who revoked it.';
    comment on constraint ck_quick_deploy_links_downloads on quick_deploy_links is
      'a count never below zero, and a last download exactly when there was one.';

    create unique index uq_quick_deploy_links_secret_hash on quick_deploy_links (secret_hash);
    create index idx_quick_deploy_links_fleet_created
      on quick_deploy_links (organization_id, fleet_id, created_at desc, id desc);

    comment on index uq_quick_deploy_links_secret_hash is
      'a secret finds at most one link: 256 random bits never collide in
       practice; this makes a collision an error rather than an ambiguity.';
    comment on index idx_quick_deploy_links_fleet_created is
      'Install Links lists a fleet''s links newest first, keyset paged on
       (created_at, id); the create counts a fleet''s active links; a fleet''s
       delete removes them; an organization''s hard delete cascades.';

    alter table quick_deploy_links enable row level security;

    create policy quick_deploy_links_select on quick_deploy_links
      for select to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    create policy quick_deploy_links_insert on quick_deploy_links
      for insert to telflo_platform_runtime
      with check (organization_id = ${contextOrganization});

    create policy quick_deploy_links_update on quick_deploy_links
      for update to telflo_platform_runtime
      using (organization_id = ${contextOrganization})
      with check (organization_id = ${contextOrganization});

    create policy quick_deploy_links_delete on quick_deploy_links
      for delete to telflo_platform_runtime
      using (organization_id = ${contextOrganization});

    -- The download's only way past the policies (ADR 0023's rule): the link
    -- whose hash matches, in any state, with its organization and whether
    -- that organization is live; nothing else. The caller then sets the
    -- context to that organization and reads the link through the policies.
    -- stable: it only reads. A fixed search_path and schema-qualified
    -- tables, as migration 021's helper.
    create function quick_deploy_link_by_secret_hash(p_secret_hash text)
    returns table (
      id                    uuid,
      organization_id       uuid,
      organization_is_live  boolean
    )
    language sql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
      select l.id, l.organization_id, o.deleted_at is null
        from platform.quick_deploy_links l
        join platform.organizations o on o.id = l.organization_id
       where l.secret_hash = p_secret_hash
    $$;

    comment on function quick_deploy_link_by_secret_hash(text) is
      'the link a secret''s hash names, past row-level security: whoever holds
       a quick-deploy link downloads without signing in (D17c-2). Keyed by a
       secret of 256 random bits rather than by the database context, as
       organization_invitation_by_token_hash (ADR 0023). Only
       telflo_platform_runtime may run it, and the API calls it from one place,
       findQuickDeployLinkBySecretHash.';

    revoke execute on function quick_deploy_link_by_secret_hash(text) from public;
    grant execute on function quick_deploy_link_by_secret_hash(text) to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function if exists quick_deploy_link_by_secret_hash(text);
    drop table if exists quick_deploy_links;
  `);
};
