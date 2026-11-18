/**
 * Soft removal, group organizations without an owner, and the tightened
 * membership invariant (D5 decisions 6 and 9).
 *
 *   * organization_members.deleted_at: removing a member keeps the row and its
 *     role, so an admin can restore it.
 *   * owner_user_id is for personal organizations only. A group organization
 *     has no owner (its admins are equals), so a hard-deleted user can no
 *     longer take a group organization down with them (D1b decision 7).
 *   * Group names are unique, ignoring case, among live group organizations.
 *     Personal ones are left out, so no one can block another person's signup
 *     by taking their `<email>'s workspace` (D1b decision 5).
 *   * D1b's invariant tightens to what it meant: every live user has a live
 *     membership in a live organization. It now also runs when a membership's
 *     or an organization's deleted_at changes, and as SECURITY DEFINER, so
 *     row-level security (Task 3) can't hide memberships from it.
 *   * reassign_sessions_leaving_organization and
 *     delete_accounts_only_in_organization do, in the caller's transaction,
 *     what removing a member and deleting an organization must do to sessions
 *     and accounts (decision 9). They are SECURITY DEFINER because they read
 *     and write other users' rows, which row-level security will hide from the
 *     API's role; only telflo_platform_runtime may run them, and only for the
 *     organization the database context names.
 *
 * down restores migration 003's invariant and the owner column. It refuses
 * while a group organization has no live admin to become its owner again, and it
 * deletes removed memberships: without deleted_at they would read as live.
 */

const invariantMessage = `'user % must belong to at least one organization'`;

export const up = (pgm) => {
  pgm.sql(`
    -- As migration 003 did: the triggers only check rows a transaction
    -- touches, so refuse to tighten the rule over a database that already
    -- breaks it. Until now a membership in a soft-deleted organization
    -- counted; from here it doesn't. Held until this migration's transaction
    -- ends, so nothing can commit between the check and the triggers.
    lock table users, organizations, organization_members in share row exclusive mode;

    do $$
    declare
      stranded bigint;
    begin
      select count(*) into stranded
        from users u
       where u.deleted_at is null
         and not exists (
           select 1
             from organization_members m
             join organizations o on o.id = m.organization_id
            where m.user_id = u.id
              and o.deleted_at is null
         );
      if stranded > 0 then
        raise exception
          'cannot tighten the membership invariant: % user(s) with deleted_at null have no membership in a live organization',
          stranded
          using errcode = 'check_violation';
      end if;
    end
    $$;

    alter table organization_members add column deleted_at timestamptz;

    comment on table organization_members is
      'a user''s membership of an organization, with a role. Removal is soft
       (deleted_at), so a removed member can be restored with their role.
       Invitations are D6''s.';
    comment on column organization_members.deleted_at is
      'set when an admin removes the member (D5 decision 6). A removed
       membership grants nothing: every read of memberships filters on it. The
       unique (organization_id, user_id) still holds, so restoring clears this
       column rather than inserting a row.';

    alter table organizations alter column owner_user_id drop not null;
    update organizations set owner_user_id = null where type = 'group';
    alter table organizations
      add constraint ck_organizations_owner_only_personal
      check ((type = 'personal') = (owner_user_id is not null));

    comment on column organizations.owner_user_id is
      'the user whose personal organization this is; null for a group
       organization, whose admins are equals and whose creator is in the audit
       trail (ck_organizations_owner_only_personal). Cascades on user
       deletion: a hard-deleted user takes their personal organization with
       them. Users are normally soft-deleted, so this matters mainly for tests
       and operator cleanup.';

    create unique index uq_organizations_lower_name_group
      on organizations (lower(name)) where type = 'group' and deleted_at is null;

    comment on table organizations is
      'the tenant boundary. Every account belongs to at least one. Group names
       are unique, ignoring case, among live group organizations
       (uq_organizations_lower_name_group). Personal names are not: a unique
       personal name would let anyone block a future signup by taking its
       derived name, and would reveal whether an email has an account (D1b
       decision 5, D5 decision 6).';

    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused,
       password_reset, account_taken_over (a federated sign-in took over an
       unverified account, ADR 0021) or organization_access_lost (the
       session''s organization went away and the user had no other, D5
       decision 9). Text rather than an enum until a third consumer needs to
       branch on it.';

    -- The invariant, redefined in place: the triggers keep calling it. It
    -- checks, at commit, every user a changed row may have stranded:
    --   * users (insert, restore): the user;
    --   * organization_members (delete, removal, restore, a move to another
    --     user or organization): the membership's old user;
    --   * organizations (deletion, restore): every live member.
    -- A user fails when they exist, aren't soft-deleted, and have no live
    -- membership in a live organization. SECURITY DEFINER with a fixed
    -- search_path: it must see every membership of the users it checks, and
    -- row-level security on organization_members (Task 3) would otherwise
    -- hide some from the API's role and refuse valid commits.
    create or replace function ensure_user_has_membership() returns trigger
    language plpgsql
    security definer
    set search_path = platform, pg_temp
    as $$
    declare
      checked_user_ids uuid[];
      stranded_user_id uuid;
    begin
      if tg_table_name = 'users' then
        checked_user_ids := array[new.id];
      elsif tg_table_name = 'organizations' then
        checked_user_ids := array(
          select m.user_id
            from organization_members m
           where m.organization_id = new.id
             and m.deleted_at is null
        );
      else
        checked_user_ids := array[old.user_id];
      end if;

      select u.id into stranded_user_id
        from users u
       where u.id = any (checked_user_ids)
         and u.deleted_at is null
         and not exists (
           select 1
             from organization_members m
             join organizations o on o.id = m.organization_id
            where m.user_id = u.id
              and m.deleted_at is null
              and o.deleted_at is null
         )
       order by u.id
       limit 1;

      if stranded_user_id is not null then
        raise exception ${invariantMessage}, stranded_user_id
          using errcode = 'check_violation';
      end if;

      return null;
    end
    $$;

    -- Moving a membership to another organization can now strand its user
    -- too (the other organization may be deleted), so the move trigger
    -- watches organization_id as well as user_id.
    drop trigger organization_members_user_reassigned on organization_members;
    create constraint trigger organization_members_user_reassigned
      after update of user_id, organization_id on organization_members
      deferrable initially deferred
      for each row
      when (old.user_id is distinct from new.user_id
            or old.organization_id is distinct from new.organization_id)
      execute function ensure_user_has_membership();

    create constraint trigger organization_members_removed_require_membership
      after update of deleted_at on organization_members
      deferrable initially deferred
      for each row
      when (old.deleted_at is distinct from new.deleted_at)
      execute function ensure_user_has_membership();

    create constraint trigger organizations_deleted_require_membership
      after update of deleted_at on organizations
      deferrable initially deferred
      for each row
      when (old.deleted_at is distinct from new.deleted_at)
      execute function ensure_user_has_membership();

    -- D5 decision 9, the current organization picked once on the server:
    -- every live session acting as p_organization_id (of p_user_id only, when
    -- given) moves to the user's own personal organization if they still have
    -- a live membership there, else to their first live membership in a live
    -- organization by name then id, else is revoked with
    -- organization_access_lost. p_organization_id is excluded explicitly, so
    -- the caller may run this before or after it removes the membership or
    -- deletes the organization. Returns how many sessions it moved or
    -- revoked. The caller has already locked the organization and the
    -- memberships; this locks the sessions it changes.
    create function reassign_sessions_leaving_organization(
      p_organization_id uuid,
      p_user_id uuid default null
    ) returns integer
    language plpgsql
    security definer
    set search_path = platform, pg_temp
    as $$
    declare
      leaving record;
      destination_id uuid;
      changed integer := 0;
    begin
      if p_organization_id is distinct from nullif(current_setting('telflo.organization_id', true), '')::uuid then
        raise exception 'reassign_sessions_leaving_organization may act only on the organization in the database context'
          using errcode = 'insufficient_privilege';
      end if;
      for leaving in
        select s.id, s.user_id
          from sessions s
         where s.active_organization_id = p_organization_id
           and s.revoked_at is null
           and (p_user_id is null or s.user_id = p_user_id)
         order by s.id
           for update
      loop
        select o.id into destination_id
          from organization_members m
          join organizations o on o.id = m.organization_id
         where m.user_id = leaving.user_id
           and m.deleted_at is null
           and o.deleted_at is null
           and o.id <> p_organization_id
         order by (o.type = 'personal' and o.owner_user_id = leaving.user_id) desc, o.name, o.id
         limit 1;

        if destination_id is null then
          update sessions
             set revoked_at = now(), revoked_reason = 'organization_access_lost'
           where id = leaving.id;
        else
          update sessions set active_organization_id = destination_id where id = leaving.id;
        end if;
        changed := changed + 1;
      end loop;

      return changed;
    end
    $$;

    -- D5 decision 9, D1b's handoff: deleting a group organization also
    -- soft-deletes every live account with a live membership in it and none
    -- in any other live organization, which would otherwise fail the
    -- invariant at commit. A human always keeps their personal organization,
    -- so today that is nobody; D22's service accounts are who it is for.
    -- Returns how many accounts it soft-deleted.
    create function delete_accounts_only_in_organization(p_organization_id uuid) returns integer
    language plpgsql
    security definer
    set search_path = platform, pg_temp
    as $$
    declare
      deleted integer;
    begin
      if p_organization_id is distinct from nullif(current_setting('telflo.organization_id', true), '')::uuid then
        raise exception 'delete_accounts_only_in_organization may act only on the organization in the database context'
          using errcode = 'insufficient_privilege';
      end if;
      update users u
         set deleted_at = now(), updated_at = now()
       where u.deleted_at is null
         and exists (
           select 1
             from organization_members m
            where m.user_id = u.id
              and m.organization_id = p_organization_id
              and m.deleted_at is null
         )
         and not exists (
           select 1
             from organization_members m
             join organizations o on o.id = m.organization_id
            where m.user_id = u.id
              and m.deleted_at is null
              and o.deleted_at is null
              and o.id <> p_organization_id
         );
      get diagnostics deleted = row_count;
      return deleted;
    end
    $$;

    -- Both functions bypass row-level security, so each ties its argument to
    -- the database context itself: it refuses (42501) unless
    -- p_organization_id is the organization telflo.organization_id names.
    -- D5 only calls them for the active organization, whose context the
    -- API has set; a bug passing another organization's id fails instead of
    -- reaching into it.
    --
    -- Functions are executable by public by default; these act on any user's
    -- rows, so only the API's role may run them.
    revoke execute on function reassign_sessions_leaving_organization(uuid, uuid) from public;
    revoke execute on function delete_accounts_only_in_organization(uuid) from public;
    grant execute on function reassign_sessions_leaving_organization(uuid, uuid) to telflo_platform_runtime;
    grant execute on function delete_accounts_only_in_organization(uuid) to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    do $$
    declare
      ownerless bigint;
    begin
      select count(*) into ownerless
        from organizations o
       where o.type = 'group'
         and not exists (
           select 1 from organization_members m
            where m.organization_id = o.id and m.role = 'admin' and m.deleted_at is null
         );
      if ownerless > 0 then
        raise exception
          'cannot restore organizations.owner_user_id to not null: % group organization(s) have no live admin to own them',
          ownerless
          using errcode = 'check_violation';
      end if;
    end
    $$;

    drop function if exists delete_accounts_only_in_organization(uuid);
    drop function if exists reassign_sessions_leaving_organization(uuid, uuid);

    -- Migration 003's function and triggers, as they were: security invoker,
    -- no search_path, and no triggers on deleted_at. Dropping the function
    -- drops every trigger that calls it.
    drop function ensure_user_has_membership() cascade;
    create function ensure_user_has_membership() returns trigger
    language plpgsql as $$
    declare
      checked_user_id uuid;
    begin
      if tg_table_name = 'users' then
        checked_user_id := new.id;
      else
        checked_user_id := old.user_id;
      end if;

      if exists (
           select 1 from users u
            where u.id = checked_user_id
              and u.deleted_at is null
         )
         and not exists (
           select 1 from organization_members m
            where m.user_id = checked_user_id
         )
      then
        raise exception ${invariantMessage}, checked_user_id
          using errcode = 'check_violation';
      end if;

      return null;
    end
    $$;

    create constraint trigger users_require_membership
      after insert on users
      deferrable initially deferred
      for each row execute function ensure_user_has_membership();
    create constraint trigger users_restored_require_membership
      after update of deleted_at on users
      deferrable initially deferred
      for each row
      when (old.deleted_at is distinct from new.deleted_at)
      execute function ensure_user_has_membership();
    create constraint trigger organization_members_keep_one
      after delete on organization_members
      deferrable initially deferred
      for each row execute function ensure_user_has_membership();
    create constraint trigger organization_members_user_reassigned
      after update of user_id on organization_members
      deferrable initially deferred
      for each row
      when (old.user_id is distinct from new.user_id)
      execute function ensure_user_has_membership();

    comment on column sessions.revoked_reason is
      'one of logout, sign_out_everywhere, refresh_token_reused,
       password_reset or account_taken_over (a federated sign-in took over an
       unverified account, ADR 0021). Text rather than an enum until a third
       consumer needs to branch on it.';

    drop index if exists uq_organizations_lower_name_group;

    -- Each group organization's owner becomes its earliest live admin, the
    -- closest record of who created it. A removed admin can't be the owner:
    -- their membership is deleted below, and an owner must be a member.
    alter table organizations drop constraint if exists ck_organizations_owner_only_personal;
    update organizations o
       set owner_user_id = (
         select m.user_id from organization_members m
          where m.organization_id = o.id and m.role = 'admin' and m.deleted_at is null
          order by m.created_at, m.id
          limit 1
       )
     where o.type = 'group';
    alter table organizations alter column owner_user_id set not null;

    comment on table organizations is
      'the tenant boundary. Every account belongs to at least one. Name
       uniqueness is deliberately absent: a global unique name would let anyone
       block a future signup by taking its derived personal name, and would
       reveal whether an email has an account. D5 decides group-name uniqueness
       (D1b decision 5).';
    comment on column organizations.owner_user_id is
      'cascades on user deletion: a hard-deleted user takes their personal
       organization with them. Users are normally soft-deleted, so this matters
       mainly for tests and operator cleanup. D5 revisits it for group
       organizations, whose owner leaving must not delete them (D1b decision 7).';

    -- Without deleted_at a removed membership would read as live, so it goes.
    -- The delete queues the deferred invariant check, and a table with
    -- pending trigger events can't be altered, so run the check now.
    delete from organization_members where deleted_at is not null;
    set constraints all immediate;
    alter table organization_members drop column deleted_at;
    comment on table organization_members is
      'a user''s membership of an organization, with a role. Member status
       (invited, active, removed) is deferred to D5 and D6.';
  `);
};
