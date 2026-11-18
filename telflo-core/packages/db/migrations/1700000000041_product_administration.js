/**
 * Product administration (D29 decisions 17 to 27; Preflight rulings 1, 3,
 * 4, 7 and 13; Rulings 257 and 258): the platform's first
 * cross-organization path, and the two tables only it reaches.
 *
 *   * user_feedback: "Contact us" (decision 22). A person's message, the
 *     organization they were in (context only, never shown), when it came
 *     and how a product admin handled it. Pending while handled_at is null;
 *     outcome is set exactly when handled_at is. The API's role holds
 *     INSERT only (the sender's request writes it): the insert takes its id
 *     from the API (`select uuidv7()`) and never uses RETURNING, which would
 *     need SELECT (Preflight ruling 8). Every read and every change goes
 *     through the definer functions below.
 *   * user_deletion_records: who a deleted person was (decisions 4, 14, 23
 *     and 24): their id, their original email, who deleted them and when.
 *     Written only by the delete function (migration 042), read only by an
 *     operator's SQL as the tables' owner: the API's role holds nothing on
 *     it.
 *   * Both are `system` resources (decision 21): no row-level security, no
 *     organization; migration 009's default privileges would give the
 *     API's role all four privileges, so they are revoked here explicitly
 *     (Preflight ruling 3).
 *   * assert_product_admin() (decision 18, Preflight ruling 1, migration
 *     028's test_runs_require_dispatcher pattern): raises 42501 unless the
 *     database context is a product admin's, as withProductAdminContext
 *     sets it: telflo.product_admin = 'on', telflo.organization_id empty,
 *     telflo.dispatcher not 'on', and telflo.user_id naming a live human
 *     whose is_product_admin is true, read in that statement. EXECUTE for no
 *     one: the functions below call it as their owner. Its refusal carries
 *     the HINT telflo_product_admin_gate (Ruling 260), so the API answers
 *     this refusal, and no other 42501, 403 product_admin_required.
 *   * The product-admin functions (decision 25): SECURITY DEFINER, owned by
 *     the migration role (the tables' owner, so D12's owner-only trigger
 *     lets grant and revoke change the flag), search_path pg_catalog,
 *     platform with schema-qualified tables, EXECUTE revoked from public and
 *     granted to telflo_platform_runtime only; each begins with
 *     `perform platform.assert_product_admin()`. The API calls them only from
 *     modules/product-admin/repositories/system-repository.ts (a test scans
 *     the source). Every one that writes re-reads the caller under a row
 *     lock (`for share` or stronger) taken with or after its other locks,
 *     users always in id order, and answers `forbidden` when the caller is
 *     no longer a live product admin: a removal committed meanwhile wins
 *     (Rulings 257 and 258). Timestamps they write come from the API's
 *     clock (p_at), never the database's.
 *       - product_admin_list_users: live humans, newest first, searched by
 *         email or by the name of any live organization the person is a
 *         live member of, each with the block of decision 30 (Preflight
 *         ruling 4). The order and the cursor are on created_at to the
 *         millisecond (the API's cursor carries milliseconds: users'
 *         created_at defaults to now(), in microseconds) and the id.
 *       - product_admin_list_product_admins: live humans with the flag, by
 *         email.
 *       - product_admin_grant and product_admin_revoke (decision 27,
 *         Preflight ruling 7).
 *       - product_admin_list_feedback and product_admin_count_pending_feedback.
 *       - product_admin_handle_feedback (Preflight ruling 13).
 *     The delete (product_admin_delete_account) is migration 042's.
 *   * users.is_product_admin's comment names the grant and the revoke
 *     beside an operator's SQL.
 *
 * down drops the functions, the gate and both tables with their rows, and
 * restores migration 026's comment on users.is_product_admin: migration
 * 040's catalogue exactly.
 */

/** Every function the API's role may run, with its arguments: what the grants name. */
const grantedFunctions = [
  "product_admin_list_users(text, timestamptz, uuid, integer, timestamptz)",
  "product_admin_list_product_admins()",
  "product_admin_grant(text, timestamptz)",
  "product_admin_revoke(uuid, timestamptz)",
  "product_admin_list_feedback(timestamptz, uuid, integer)",
  "product_admin_count_pending_feedback()",
  "product_admin_handle_feedback(uuid, text, timestamptz)",
];

/** The caller, once assert_product_admin has passed: telflo.user_id is then a canonical uuid. */
const caller = `current_setting('telflo.user_id')::uuid`;

/** A live human whose flag is set: what `u` must be to act or to be listed as a product admin. */
const liveProductAdmin = (alias) => `${alias}.deleted_at is null and ${alias}.kind = 'human' and ${alias}.is_product_admin`;

/** Migration 026's comment on users.is_product_admin, exactly: what down restores. */
const migration026FlagComment = `
    comment on column users.is_product_admin is
      'a product admin (D12 decision 3): writes the flows and reaches
       /product-admin. False by default; set and cleared only by an
       operator''s SQL as the tables'' owner (users_product_admin_owner_only),
       and read on every request, so a revocation takes effect at once.';
`;

export const up = (pgm) => {
  pgm.sql(`
    create table user_feedback (
      id                  uuid        primary key default uuidv7(),
      user_id             uuid        not null references users(id) on delete cascade,
      organization_id     uuid        not null references organizations(id) on delete cascade,
      text                text        not null,
      created_at          timestamptz not null,
      handled_at          timestamptz,
      handled_by_user_id  uuid        references users(id) on delete set null,
      outcome             text,
      constraint ck_user_feedback_text check (char_length(text) between 1 and 5000 and text = btrim(text)),
      constraint ck_user_feedback_outcome check (outcome in ('acknowledged', 'dismissed')),
      constraint ck_user_feedback_handled_together check ((handled_at is null) = (outcome is null)),
      constraint ck_user_feedback_handled_by_only_when_handled check (handled_by_user_id is null or handled_at is not null)
    );

    comment on table user_feedback is
      'a person''s message from "Contact us" (D29 decision 22): pending while
       handled_at is null, then acknowledged (a reply emailed, never stored)
       or dismissed by a product admin. A system resource: no organization
       owns it and no row-level security; the API''s role may only insert it
       (the sender''s request), and reads and handles it only through the
       product-admin functions. Its text is personal data: never in a log
       line, an error or an audit row.';
    comment on column user_feedback.id is
      'the item''s id, which audit rows and log lines name (never its text).
       The API sends it (select uuidv7()): with INSERT only it can''t use
       RETURNING.';
    comment on column user_feedback.user_id is
      'the person who sent it. Cascades: an operator''s hard delete of the
       user takes their feedback with it; a soft-deleted sender''s items
       stay, showing the anonymous address.';
    comment on column user_feedback.organization_id is
      'the organization the person was acting in when they sent it: context
       only, never shown. Cascades with an operator''s hard delete of it.';
    comment on column user_feedback.text is
      'the message, trimmed, 1 to 5,000 characters. Personal data.';
    comment on column user_feedback.created_at is
      'when it was sent, by the API''s clock.';
    comment on column user_feedback.handled_at is
      'when a product admin acknowledged or dismissed it, by the API''s
       clock; null while pending.';
    comment on column user_feedback.handled_by_user_id is
      'the product admin who handled it; null while pending, and once their
       account is hard-deleted.';
    comment on column user_feedback.outcome is
      'acknowledged or dismissed, set exactly when handled_at is; null while
       pending.';
    comment on constraint user_feedback_pkey on user_feedback is
      'one row per message, by its id.';
    comment on constraint user_feedback_user_id_fkey on user_feedback is
      'the sender (23503 otherwise); on delete cascade.';
    comment on constraint user_feedback_organization_id_fkey on user_feedback is
      'the sender''s organization (23503 otherwise); on delete cascade.';
    comment on constraint user_feedback_handled_by_user_id_fkey on user_feedback is
      'the product admin who handled it (23503 otherwise); on delete set null.';
    comment on constraint ck_user_feedback_text on user_feedback is
      '1 to 5,000 characters, with no space at either end: the API trims it.';
    comment on constraint ck_user_feedback_outcome on user_feedback is
      'acknowledged or dismissed.';
    comment on constraint ck_user_feedback_handled_together on user_feedback is
      'handled_at and outcome are both set or both null.';
    comment on constraint ck_user_feedback_handled_by_only_when_handled on user_feedback is
      'only a handled item names who handled it.';

    create index idx_user_feedback_pending_created_at
      on user_feedback (created_at desc, id desc) where handled_at is null;
    create index idx_user_feedback_user_id on user_feedback (user_id);
    create index idx_user_feedback_organization_id on user_feedback (organization_id);
    create index idx_user_feedback_handled_by_user_id on user_feedback (handled_by_user_id);

    comment on index idx_user_feedback_pending_created_at is
      'the pending items, newest first: the User Feedback page''s list, its
       cursor and the pending count.';
    comment on index idx_user_feedback_user_id is
      'a user''s feedback, for the cascade of their hard delete.';
    comment on index idx_user_feedback_organization_id is
      'an organization''s feedback, for the cascade of its hard delete.';
    comment on index idx_user_feedback_handled_by_user_id is
      'the items a product admin handled, for the set null of their hard
       delete.';

    revoke all on user_feedback from telflo_platform_runtime;
    grant insert on user_feedback to telflo_platform_runtime;

    create table user_deletion_records (
      user_id             uuid        primary key references users(id) on delete cascade,
      original_email      text        not null,
      deleted_by_user_id  uuid        references users(id) on delete set null,
      deleted_at          timestamptz not null
    );

    comment on table user_deletion_records is
      'who a deleted person was (D29 decisions 4 and 23): written once by the
       delete function (product_admin_delete_account), read only by an
       operator''s SQL as the tables'' owner. The API''s role holds nothing on
       it. A system resource: no organization, no row-level security.';
    comment on column user_deletion_records.user_id is
      'the deleted person, whose users row stays (a soft delete) with the
       anonymous address. Cascades with an operator''s hard delete.';
    comment on column user_deletion_records.original_email is
      'the person''s email before the delete changed it. Personal data: never
       read by the API.';
    comment on column user_deletion_records.deleted_by_user_id is
      'the product admin who deleted them; null once their account is
       hard-deleted.';
    comment on column user_deletion_records.deleted_at is
      'when, by the API''s clock.';
    comment on constraint user_deletion_records_pkey on user_deletion_records is
      'one record per deleted person.';
    comment on constraint user_deletion_records_user_id_fkey on user_deletion_records is
      'the deleted person (23503 otherwise); on delete cascade.';
    comment on constraint user_deletion_records_deleted_by_user_id_fkey on user_deletion_records is
      'the product admin who deleted them (23503 otherwise); on delete set null.';

    create index idx_user_deletion_records_deleted_by_user_id on user_deletion_records (deleted_by_user_id);

    comment on index idx_user_deletion_records_deleted_by_user_id is
      'the records a product admin wrote, for the set null of their hard
       delete.';

    revoke all on user_deletion_records from telflo_platform_runtime;

    comment on column users.is_product_admin is
      'a product admin (D12 decision 3): writes the flows and reaches
       /product-admin. False by default; set and cleared only as the
       tables'' owner (users_product_admin_owner_only): by an operator''s SQL,
       and by another product admin through product_admin_grant and
       product_admin_revoke (D29 decision 27), which run as the owner. Read
       on every request, so a revocation takes effect at once.';

    -- The product-admin context (decision 18, Preflight ruling 1). Not
    -- granted to anyone: only the definer functions below, running as the
    -- owner, call it.
    create function assert_product_admin() returns void
    language plpgsql
    stable
    set search_path = pg_catalog, platform
    as $$
    declare
      setting text := coalesce(current_setting('telflo.user_id', true), '');
    begin
      if coalesce(current_setting('telflo.product_admin', true), '') <> 'on'
         or coalesce(current_setting('telflo.organization_id', true), '') <> ''
         or coalesce(current_setting('telflo.dispatcher', true), '') = 'on'
         or setting !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then
        raise exception 'only a product admin may do this'
          using errcode = 'insufficient_privilege', hint = 'telflo_product_admin_gate';
      end if;
      if not exists (select 1 from platform.users u where u.id = setting::uuid and ${liveProductAdmin("u")}) then
        raise exception 'only a product admin may do this'
          using errcode = 'insufficient_privilege', hint = 'telflo_product_admin_gate';
      end if;
    end;
    $$;

    revoke execute on function assert_product_admin() from public;

    comment on function assert_product_admin() is
      'refuses (42501) unless the database context is a product admin''s, as
       withProductAdminContext sets it (D29 decision 18): telflo.product_admin
       = ''on'', telflo.organization_id empty, telflo.dispatcher not ''on'',
       and telflo.user_id naming a live human whose is_product_admin is true,
       read in this statement. A member''s request and the dispatcher can''t
       reach the product-admin functions, and a cleared flag refuses the very
       next call. Its refusal''s HINT is telflo_product_admin_gate, which the
       API answers 403 (any other 42501 stays an error). EXECUTE for no one:
       the product-admin functions call it as their owner.';

    create function product_admin_list_users(
      p_query text, p_after_created timestamptz, p_after_id uuid, p_limit integer, p_at timestamptz
    )
    returns table (
      id                       uuid,
      email                    text,
      created_at               timestamptz,
      is_product_admin         boolean,
      block_kind               text,
      block_organization_name  text,
      block_role               organization_role
    )
    language plpgsql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      pattern text;
    begin
      perform platform.assert_product_admin();
      if p_limit is null or p_limit < 1 or p_limit > 100 or p_at is null
         or (p_after_created is null) <> (p_after_id is null)
      then
        raise exception 'the list takes a limit from 1 to 100, the time, and both halves of a cursor or neither'
          using errcode = 'invalid_parameter_value';
      end if;
      -- A substring, case aside, with LIKE's own characters taken literally.
      if coalesce(p_query, '') <> '' then
        pattern := '%' || replace(replace(replace(lower(p_query), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%';
      end if;
      return query
      select u.id, u.email, u.created_at, u.is_product_admin,
             case when u.is_product_admin then 'product_admin' else b.kind end,
             case when u.is_product_admin then null else b.organization_name end,
             case when u.is_product_admin then null else b.role end
        from platform.users u
        left join lateral (
          -- The block (decision 30): a live organization the person is a live
          -- member of that isn't theirs alone (another live human member, or
          -- an invitation pending at p_at); member before owner, then by
          -- name, then by id.
          select case when o.owner_user_id is not distinct from u.id then 'owner' else 'member' end as kind,
                 o.name as organization_name,
                 m.role
            from platform.organization_members m
            join platform.organizations o on o.id = m.organization_id
           where m.user_id = u.id
             and m.deleted_at is null
             and o.deleted_at is null
             and (exists (select 1
                            from platform.organization_members other
                            join platform.users ou on ou.id = other.user_id
                           where other.organization_id = o.id
                             and other.user_id <> u.id
                             and other.deleted_at is null
                             and ou.deleted_at is null
                             and ou.kind = 'human')
                  or exists (select 1
                               from platform.organization_invitations i
                              where i.organization_id = o.id
                                and i.accepted_at is null
                                and i.revoked_at is null
                                and i.expires_at > p_at))
           order by (o.owner_user_id is not distinct from u.id), o.name, o.id
           limit 1
        ) b on true
       where u.deleted_at is null
         and u.kind = 'human'
         and (pattern is null
              or lower(u.email) like pattern escape '\\'
              or u.id in (select m.user_id
                            from platform.organization_members m
                            join platform.organizations o on o.id = m.organization_id
                           where m.deleted_at is null
                             and o.deleted_at is null
                             and lower(o.name) like pattern escape '\\'))
         and (p_after_created is null
              or (date_trunc('milliseconds', u.created_at), u.id) < (p_after_created, p_after_id))
       order by date_trunc('milliseconds', u.created_at) desc, u.id desc
       limit p_limit;
    end;
    $$;

    comment on function product_admin_list_users(text, timestamptz, uuid, integer, timestamptz) is
      'the Users page''s list (D29 decisions 25 and 30): live humans (no
       service account, no deleted person), newest first by created_at to
       the millisecond, then id, after the cursor (both halves or neither),
       at most p_limit (1 to 100). p_query, when not empty, is matched case
       aside as a substring (LIKE''s %, _ and \\ taken literally) of the
       email or of the name of any live organization the person is a live
       member of. Each row''s block: product_admin when the person holds the
       flag; otherwise the first organization not theirs alone (another live
       human member, or an invitation pending at p_at, the API''s clock),
       member before owner (owner: their own personal organization), then by
       name; none when every organization is theirs alone. Only a product
       admin''s context (assert_product_admin).';

    create function product_admin_list_product_admins()
    returns table (id uuid, email text)
    language plpgsql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
    begin
      perform platform.assert_product_admin();
      return query
      select u.id, u.email
        from platform.users u
       where ${liveProductAdmin("u")}
       order by u.email, u.id;
    end;
    $$;

    comment on function product_admin_list_product_admins() is
      'every live human holding the product-admin flag, by email (D29
       decision 25). Only a product admin''s context.';

    create function product_admin_grant(p_email text, p_at timestamptz)
    returns table (outcome text, user_id uuid, email text)
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      me uuid;
      target uuid;
      found_email text;
      flagged boolean;
    begin
      perform platform.assert_product_admin();
      if p_at is null then
        raise exception 'a grant takes the time' using errcode = 'invalid_parameter_value';
      end if;
      me := ${caller};
      select u.id into target
        from platform.users u
       where lower(u.email) = lower(btrim(coalesce(p_email, '')))
         and u.deleted_at is null and u.kind = 'human' and u.email_verified_at is not null;
      if target is null then
        return query select 'not_found'::text, null::uuid, null::text;
        return;
      end if;
      -- The caller and the target together, in id order (Ruling 258).
      perform 1 from platform.users u where u.id in (me, target) order by u.id for update;
      if not exists (select 1 from platform.users u where u.id = me and ${liveProductAdmin("u")}) then
        return query select 'forbidden'::text, null::uuid, null::text;
        return;
      end if;
      select u.email, u.is_product_admin into found_email, flagged
        from platform.users u
       where u.id = target and u.deleted_at is null and u.kind = 'human' and u.email_verified_at is not null;
      if found_email is null then
        return query select 'not_found'::text, null::uuid, null::text;
        return;
      end if;
      if flagged then
        return query select 'unchanged'::text, target, found_email;
        return;
      end if;
      update platform.users set is_product_admin = true, updated_at = p_at where id = target;
      return query select 'granted'::text, target, found_email;
    end;
    $$;

    comment on function product_admin_grant(text, timestamptz) is
      'makes the live, verified human whose email is p_email (trimmed, case
       aside) a product admin (D29 decision 27): not_found unless one exists;
       then, the caller and the target locked together by id (for update),
       forbidden when the caller is no longer a live product admin,
       not_found when the target is no longer live, verified and human,
       unchanged when already one, otherwise granted (updated_at = p_at, the
       API''s clock). Answers the outcome and, for granted and unchanged, the
       target''s id and email. Runs as the owner, so the owner-only trigger
       passes. Only a product admin''s context.';

    create function product_admin_revoke(p_user_id uuid, p_at timestamptz)
    returns text
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      me uuid;
      admins integer;
    begin
      perform platform.assert_product_admin();
      if p_user_id is null or p_at is null then
        raise exception 'a revoke takes a user and the time' using errcode = 'invalid_parameter_value';
      end if;
      me := ${caller};
      -- Every live product admin, in id order (Preflight ruling 7): two
      -- removals at once queue here, and the second reads the first's
      -- outcome below.
      perform 1 from platform.users u where ${liveProductAdmin("u")} order by u.id for update;
      if not exists (select 1 from platform.users u where u.id = me and ${liveProductAdmin("u")}) then
        return 'forbidden';
      end if;
      if not exists (select 1 from platform.users u where u.id = p_user_id and ${liveProductAdmin("u")}) then
        return 'not_found';
      end if;
      select count(*) into admins from platform.users u where ${liveProductAdmin("u")};
      if admins <= 1 then
        return 'last_admin';
      end if;
      update platform.users set is_product_admin = false, updated_at = p_at where id = p_user_id;
      return 'revoked';
    end;
    $$;

    comment on function product_admin_revoke(uuid, timestamptz) is
      'clears a product admin''s flag (D29 decision 27, Preflight ruling 7):
       every live product admin locked in id order (for update); forbidden
       when the caller is no longer one, not_found unless the target is one,
       last_admin when they are the only one, otherwise revoked
       (updated_at = p_at, the API''s clock). Runs as the owner, so the
       owner-only trigger passes. Only a product admin''s context.';

    create function product_admin_list_feedback(p_after_created timestamptz, p_after_id uuid, p_limit integer)
    returns table (id uuid, email text, text text, created_at timestamptz, author_deleted boolean)
    language plpgsql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
    begin
      perform platform.assert_product_admin();
      if p_limit is null or p_limit < 1 or p_limit > 100 or (p_after_created is null) <> (p_after_id is null) then
        raise exception 'the list takes a limit from 1 to 100, and both halves of a cursor or neither'
          using errcode = 'invalid_parameter_value';
      end if;
      return query
      select f.id, u.email, f.text, f.created_at, u.deleted_at is not null
        from platform.user_feedback f
        join platform.users u on u.id = f.user_id
       where f.handled_at is null
         and (p_after_created is null or (f.created_at, f.id) < (p_after_created, p_after_id))
       order by f.created_at desc, f.id desc
       limit p_limit;
    end;
    $$;

    comment on function product_admin_list_feedback(timestamptz, uuid, integer) is
      'the pending feedback, newest first, after the cursor (both halves or
       neither), at most p_limit (1 to 100), each with its sender''s current
       email and whether their account is deleted (D29 decision 25). Only a
       product admin''s context.';

    create function product_admin_count_pending_feedback()
    returns integer
    language plpgsql
    stable
    security definer
    set search_path = pg_catalog, platform
    as $$
    begin
      perform platform.assert_product_admin();
      return (select count(*)::integer from platform.user_feedback f where f.handled_at is null);
    end;
    $$;

    comment on function product_admin_count_pending_feedback() is
      'how many feedback items are pending (D29 decisions 25 and 37): a
       number and no personal data. Only a product admin''s context.';

    create function product_admin_handle_feedback(p_id uuid, p_outcome text, p_at timestamptz)
    returns table (outcome text, user_id uuid, email text)
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      me uuid;
      sender uuid;
      sender_email text;
      sender_deleted boolean;
      lock_id uuid;
    begin
      perform platform.assert_product_admin();
      if p_id is null or p_at is null or p_outcome is null or p_outcome not in ('acknowledged', 'dismissed') then
        raise exception 'handling takes an item, acknowledged or dismissed, and the time'
          using errcode = 'invalid_parameter_value';
      end if;
      me := ${caller};
      select f.user_id into sender
        from platform.user_feedback f
       where f.id = p_id and f.handled_at is null
         for update;
      if sender is null then
        return query select 'not_found'::text, null::uuid, null::text;
        return;
      end if;
      -- The caller and the sender, after the item's lock, together by id (for share;
      -- Rulings 257, 258 and 271): users are locked in id order on every path, and
      -- the sender's delete (for update) either commits first, seen here, or waits.
      foreach lock_id in array (select array_agg(distinct x order by x) from unnest(array[me, sender]) x) loop
        perform 1 from platform.users u where u.id = lock_id for share;
      end loop;
      if not exists (select 1 from platform.users u where u.id = me and ${liveProductAdmin("u")}) then
        return query select 'forbidden'::text, null::uuid, null::text;
        return;
      end if;
      select u.email, u.deleted_at is not null into sender_email, sender_deleted
        from platform.users u where u.id = sender;
      if p_outcome = 'acknowledged' and sender_deleted then
        return query select 'author_deleted'::text, null::uuid, null::text;
        return;
      end if;
      update platform.user_feedback
         set handled_at = p_at, handled_by_user_id = me, outcome = p_outcome
       where id = p_id;
      return query select 'handled'::text, sender, sender_email;
    end;
    $$;

    comment on function product_admin_handle_feedback(uuid, text, timestamptz) is
      'acknowledges or dismisses a pending feedback item (D29 decisions 25 and
       34, Preflight ruling 13): the item locked; not_found when it is
       missing or already handled; then the caller and the sender locked for
       share, together by id, so a delete of either commits before the read
       or waits for this one; forbidden when the caller is no longer a live
       product admin; author_deleted for an
       acknowledge whose sender is deleted (the item stays pending);
       otherwise handled by the caller at p_at (the API''s clock), answering
       the sender''s id and current email. Only a product admin''s context.';

    revoke execute on function ${grantedFunctions.join(", ")} from public;
    grant execute on function ${grantedFunctions.join(", ")} to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function ${grantedFunctions.join(", ")};
    drop function assert_product_admin();
    drop table user_deletion_records;
    drop table user_feedback;
    ${migration026FlagComment}
  `);
};
