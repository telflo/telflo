/**
 * A person's delete by a product admin (D29 decisions 4, 10, 11, 29 and 30;
 * Preflight ruling 5; Rulings 257 and 258).
 *
 *   * product_admin_delete_account(p_user_id, p_at): one SECURITY DEFINER
 *     function, migration 041's pattern (owned by the migration role,
 *     search_path pg_catalog, platform with schema-qualified tables, EXECUTE
 *     revoked from public and granted to telflo_platform_runtime only), which
 *     begins with `perform platform.assert_product_admin()`. The API calls it
 *     only from modules/product-admin/repositories/system-repository.ts (a
 *     test scans the source).
 *
 *     Its locks, in the order every existing path takes them (Preflight
 *     ruling 5: the person first deadlocked against an organization's
 *     delete; Ruling 258: the person, then the caller, against a revoke or
 *     a grant, which lock users by id):
 *       1. the person's live organizations, by id (`for no key update`, as
 *          an organization's delete takes its own);
 *       2. the person's row (`for update`) and the caller's (`for share`)
 *          together, by id;
 *       3. the membership set re-read under those locks: when it differs
 *          from the one locked (the person joined or left an organization
 *          meanwhile), the attempt raises its own SQLSTATE (TFR01, which no
 *          other code raises) inside an exception block that catches only
 *          that one, never `others` (a deadlock, the gate's 42501 or a real
 *          error still propagates). Leaving the block rolls its savepoint
 *          back, which releases every row lock taken inside it, and the
 *          next attempt starts again from the organizations, so an
 *          organization is never locked after a user. After three attempts
 *          it answers busy;
 *       4. their service accounts' users, by id (`for no key update`, as an
 *          organization's delete locks its members' accounts).
 *     Then, under the locks:
 *       - not_found unless the person is a live human; self when the
 *         person is the caller (answered first: no lock is needed);
 *         forbidden when the caller, re-read under its lock, is no longer a
 *         live product admin (decision 18); blocked with product_admin
 *         when the person holds the flag, or with the block of decision 30
 *         (migration 041's list's: an organization not theirs alone, member
 *         before owner, then by name, then by id), read under the locks;
 *       - each organization (all theirs alone): its service accounts
 *         deleted as Settings › Service Accounts deletes one (their tokens
 *         revoked by the caller, their memberships removed, both
 *         deleted_at), its deleted_at, and every live session acting in it
 *         revoked (account_deleted). delete_accounts_only_in_organization
 *         and reassign_sessions_leaving_organization can't serve here:
 *         they require telflo.organization_id;
 *       - their own personal organization renamed after the anonymous
 *         address (`deleted-…@deleted-accounts.telflo.invalid's workspace`,
 *         as the platform names one: its name held the original email),
 *         and those organizations' invitations to the original email
 *         (accepted, revoked or expired) given the anonymous address;
 *       - the person's sessions revoked (account_deleted) and every one of
 *         theirs without its IP address and user agent, their personal API
 *         tokens revoked, their linked identities, settings, reset and
 *         verification tokens deleted;
 *       - user_deletion_records written (the email before the change, the
 *         caller, p_at);
 *       - the email set to `deleted-<24 hex>@deleted-accounts.telflo.invalid`
 *         (decision 10, the address the organization's name took),
 *         password_hash null, deleted_at p_at.
 *     Afterwards the original email is in no column of any table but
 *     the audit log as a whole (audit_events, append-only: any column of
 *     any row may hold it, as an actor's email or in metadata derived
 *     from it), user_deletion_records.original_email (the person's row),
 *     and invitations to it in organizations not deleted with the person
 *     (decision 10's residue; Rulings 266, 267 and 270).
 *     It answers deleted with, per organization, its id, its logo id and
 *     how many service accounts it deleted, and the overall counts. Every
 *     timestamp it writes is p_at, the API's clock.
 *   * sessions.revoked_reason's comment gains account_deleted (the column
 *     is text with no check on its values; the comment lists them, as
 *     migration 034 did).
 *
 * down drops the function and restores migration 034's comment on
 * sessions.revoked_reason: migration 041's catalogue exactly.
 */

const signature = "product_admin_delete_account(uuid, timestamptz)";

/** The caller, once assert_product_admin has passed: telflo.user_id is then a canonical uuid. */
const caller = `current_setting('telflo.user_id')::uuid`;

/** Migration 034's comment on sessions.revoked_reason, exactly: what down restores. */
const migration034ReasonComment = `
    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused,
       password_reset, account_taken_over (a federated sign-in took over an
       unverified account, ADR 0021), organization_access_lost (the
       session''s organization went away and the user had no other, D5
       decision 9) or signed_out_elsewhere (one session signed out from
       Settings › Account, D21 decision 40). Text rather than an enum until
       a third consumer needs to branch on it.';
`;

/** The person's live organizations, by id: what the attempt locks, and what it re-reads under its locks. */
const liveOrganizationsOf = (person) => `
          select o.id
            from platform.organizations o
           where o.deleted_at is null
             and o.id in (select m.organization_id
                            from platform.organization_members m
                           where m.user_id = ${person} and m.deleted_at is null)
           order by o.id`;

export const up = (pgm) => {
  pgm.sql(`
    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused,
       password_reset, account_taken_over (a federated sign-in took over an
       unverified account, ADR 0021), organization_access_lost (the
       session''s organization went away and the user had no other, D5
       decision 9), signed_out_elsewhere (one session signed out from
       Settings › Account, D21 decision 40) or account_deleted (a product
       admin deleted the person, or the organization the session acted in
       with them, D29 decision 29). Text rather than an enum until a third
       consumer needs to branch on it.';

    create function product_admin_delete_account(p_user_id uuid, p_at timestamptz)
    returns table (
      outcome                   text,
      block_kind                text,
      organizations             jsonb,
      deleted_service_accounts  integer,
      revoked_sessions          integer
    )
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      me uuid;
      attempt integer := 0;
      locked uuid[];
      reread uuid[];
      lock_id uuid;
      found_kind text;
      service_users uuid[];
      deleted_organizations jsonb;
      original text;
      service_count integer;
      session_count integer;
      person_session_count integer;
      -- The anonymous address (decision 10), made once: the account's email and its personal organization's name.
      anonymous text := 'deleted-' || encode(platform.gen_random_bytes(12), 'hex') || '@deleted-accounts.telflo.invalid';
    begin
      perform platform.assert_product_admin();
      if p_user_id is null or p_at is null then
        raise exception 'a delete takes a user and the time' using errcode = 'invalid_parameter_value';
      end if;
      me := ${caller};
      if not exists (select 1 from platform.users u where u.id = p_user_id and u.deleted_at is null and u.kind = 'human') then
        return query select 'not_found'::text, null::text, null::jsonb, null::integer, null::integer;
        return;
      end if;
      if p_user_id = me then
        return query select 'self'::text, null::text, null::jsonb, null::integer, null::integer;
        return;
      end if;

      loop
        attempt := attempt + 1;
        begin
          -- 1. The person's live organizations, by id.
          locked := array(${liveOrganizationsOf("p_user_id")}
             for no key update);
          -- 2. The person (for update) and the caller (for share), by id.
          foreach lock_id in array (select array_agg(x order by x) from unnest(array[p_user_id, me]) x) loop
            if lock_id = p_user_id then
              perform 1 from platform.users u where u.id = p_user_id for update;
            else
              perform 1 from platform.users u where u.id = me for share;
            end if;
          end loop;
          -- 3. The set, re-read under the locks: changed, the attempt starts again.
          reread := array(${liveOrganizationsOf("p_user_id")});
          if reread is distinct from locked then
            raise exception 'the person''s organizations changed while the delete took its locks'
              using errcode = 'TFR01';
          end if;

          if not exists (select 1 from platform.users u where u.id = p_user_id and u.deleted_at is null and u.kind = 'human') then
            return query select 'not_found'::text, null::text, null::jsonb, null::integer, null::integer;
            return;
          end if;
          if not exists (select 1 from platform.users u
                          where u.id = me and u.deleted_at is null and u.kind = 'human' and u.is_product_admin) then
            return query select 'forbidden'::text, null::text, null::jsonb, null::integer, null::integer;
            return;
          end if;
          if exists (select 1 from platform.users u where u.id = p_user_id and u.is_product_admin) then
            return query select 'blocked'::text, 'product_admin'::text, null::jsonb, null::integer, null::integer;
            return;
          end if;
          -- The block of decision 30, as migration 041's list reads it.
          select case when o.owner_user_id is not distinct from p_user_id then 'owner' else 'member' end
            into found_kind
            from platform.organizations o
           where o.id = any (locked)
             and (exists (select 1
                            from platform.organization_members other
                            join platform.users ou on ou.id = other.user_id
                           where other.organization_id = o.id
                             and other.user_id <> p_user_id
                             and other.deleted_at is null
                             and ou.deleted_at is null
                             and ou.kind = 'human')
                  or exists (select 1
                               from platform.organization_invitations i
                              where i.organization_id = o.id
                                and i.accepted_at is null
                                and i.revoked_at is null
                                and i.expires_at > p_at))
           order by (o.owner_user_id is not distinct from p_user_id), o.name, o.id
           limit 1;
          if found_kind is not null then
            return query select 'blocked'::text, found_kind, null::jsonb, null::integer, null::integer;
            return;
          end if;

          -- 4. Their service accounts' users, by id.
          service_users := array(
            select u.id
              from platform.users u
             where u.deleted_at is null
               and u.kind = 'service'
               and u.id in (select sa.user_id
                              from platform.service_accounts sa
                             where sa.organization_id = any (locked) and sa.deleted_at is null)
             order by u.id
               for no key update);

          -- Each organization: its service accounts as Settings deletes one, then its own deleted_at.
          select coalesce(jsonb_agg(jsonb_build_object(
                   'id', o.id,
                   'logoId', o.logo_id,
                   'deletedServiceAccounts', (select count(*)::integer
                                                from platform.service_accounts sa
                                               where sa.organization_id = o.id and sa.user_id = any (service_users)))
                   order by o.id), '[]'::jsonb)
            into deleted_organizations
            from platform.organizations o
           where o.id = any (locked);
          update platform.api_tokens
             set revoked_at = p_at, revoked_by_user_id = me
           where service_account_user_id = any (service_users) and revoked_at is null;
          update platform.organization_members
             set deleted_at = p_at, updated_at = p_at
           where user_id = any (service_users) and deleted_at is null;
          update platform.service_accounts
             set deleted_at = p_at, updated_at = p_at
           where user_id = any (service_users) and deleted_at is null;
          update platform.users
             set deleted_at = p_at, updated_at = p_at
           where id = any (service_users) and deleted_at is null;
          get diagnostics service_count = row_count;
          -- Their own personal organization is renamed as the platform names one, after the
          -- anonymous address: its name held the original email (Ruling 266).
          update platform.organizations
             set deleted_at = p_at,
                 updated_at = p_at,
                 name = case when type = 'personal' and owner_user_id = p_user_id
                             then anonymous || '''s workspace' else name end
           where id = any (locked) and deleted_at is null;
          -- Their invitations in those organizations (accepted, revoked or expired: a pending one
          -- would have blocked the delete) take the anonymous address too (Ruling 267).
          select u.email into original from platform.users u where u.id = p_user_id;
          update platform.organization_invitations
             set email = anonymous, updated_at = p_at
           where organization_id = any (locked) and lower(email) = lower(original);
          update platform.sessions
             set revoked_at = p_at, revoked_reason = 'account_deleted'
           where active_organization_id = any (locked) and revoked_at is null and user_id <> p_user_id;
          get diagnostics session_count = row_count;

          -- The person: sessions (revoked, and every one's address and browser forgotten,
          -- Ruling 266), personal tokens, sign-in methods, settings, links.
          update platform.sessions
             set revoked_at = p_at, revoked_reason = 'account_deleted', ip_address = null, user_agent = null
           where user_id = p_user_id and revoked_at is null;
          get diagnostics person_session_count = row_count;
          update platform.sessions
             set ip_address = null, user_agent = null
           where user_id = p_user_id and (ip_address is not null or user_agent is not null);
          update platform.personal_api_tokens
             set revoked_at = p_at
           where user_id = p_user_id and revoked_at is null;
          delete from platform.user_identities where user_id = p_user_id;
          delete from platform.user_settings where user_id = p_user_id;
          delete from platform.password_reset_tokens where user_id = p_user_id;
          delete from platform.email_verification_tokens where user_id = p_user_id;

          -- The record, then the anonymous account.
          insert into platform.user_deletion_records (user_id, original_email, deleted_by_user_id, deleted_at)
          select u.id, u.email, me, p_at from platform.users u where u.id = p_user_id;
          update platform.users
             set email = anonymous,
                 password_hash = null,
                 deleted_at = p_at,
                 updated_at = p_at
           where id = p_user_id;

          return query select 'deleted'::text, null::text, deleted_organizations, service_count,
                              session_count + person_session_count;
          return;
        exception
          when sqlstate 'TFR01' then
            if attempt >= 3 then
              return query select 'busy'::text, null::text, null::jsonb, null::integer, null::integer;
              return;
            end if;
        end;
      end loop;
    end;
    $$;

    comment on function ${signature} is
      'deletes a person (D29 decisions 29 and 30; Preflight ruling 5;
       Ruling 258): not_found unless a live human, self for the caller; then
       their live organizations locked by id (for no key update), the person
       (for update) and the caller (for share) together by id, the
       membership set re-read under the locks (changed: the attempt rolls
       back to its savepoint, releasing its locks, and starts again; busy
       after three), their service accounts'' users by id. Under the locks:
       forbidden when the caller is no longer a live product admin; blocked
       (product_admin, member or owner) as the Users list reads it;
       otherwise each organization (theirs alone) deleted with its service
       accounts (tokens revoked by the caller, memberships removed) and the
       sessions acting in it revoked, their personal organization renamed
       after the anonymous address and its invitations to the person''s
       email given it; the person''s sessions revoked and
       without IP address and user agent, personal tokens revoked,
       identities, settings, reset and verification tokens deleted;
       user_deletion_records written; the email made anonymous
       (@deleted-accounts.telflo.invalid), no password, deleted_at = p_at
       (the API''s clock). Answers deleted with each organization''s id, logo
       id and service accounts deleted, and the overall counts. Only a
       product admin''s context.';

    revoke execute on function ${signature} from public;
    grant execute on function ${signature} to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function ${signature};
    ${migration034ReasonComment}
  `);
};
