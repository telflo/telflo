/**
 * The membership invariant: no account exists without an organization. A
 * transaction that would leave a user with no organization_members row fails
 * at commit, whichever code path it came from.
 *
 * The rule is **at least one membership**, not "has a personal organization".
 * Registration gives a human account a personal organization, but other kinds
 * of account may never have one: a service account is a users row
 * holding a single contributor membership in its target group organization and
 * no personal organization. That shape satisfies this invariant, provided the
 * account is created together with its membership in one transaction.
 *
 * Documented limits, outside what row triggers can see:
 *   * TRUNCATE of organization_members alone empties it without firing any
 *     row trigger. That is an operator-level act, not an application path;
 *     the test helper truncates users in the same statement.
 *   * A superuser can disable triggers or set session_replication_role =
 *     replica, which skips them. The compose role is a superuser; the
 *     non-superuser application role of a later migration closes this.
 */
export const up = (pgm) => {
  pgm.sql(`
    -- The triggers only ever check rows a transaction touches; they never
    -- re-scan existing ones. So refuse to install them over a database that
    -- already breaks the rule. The previous migration's backfill gives every
    -- non-deleted account a membership, so this fails only if an account was
    -- created without one afterwards.
    --
    -- Held until this migration's transaction ends, so no user or membership
    -- change can commit between the check below and the triggers existing.
    lock table users, organization_members in share row exclusive mode;

    do $$
    declare
      users_without_membership bigint;
    begin
      select count(*) into users_without_membership
        from users u
       where u.deleted_at is null
         and not exists (
           select 1 from organization_members m where m.user_id = u.id
         );
      if users_without_membership > 0 then
        raise exception
          'cannot install the membership invariant: % user(s) with deleted_at null have no organization membership',
          users_without_membership
          using errcode = 'check_violation';
      end if;
    end
    $$;

    -- Checks one user at commit. It raises only when that user still exists,
    -- is not soft-deleted, and has no membership:
    --   * the user is gone: hard-deleting a user cascades to their
    --     organizations and memberships, and must still work;
    --   * the user is soft-deleted: their memberships are left as they are,
    --     and refusing them would stop account deletion from working.
    --
    -- Deleting an organization cascades to its memberships, so it fails only
    -- for a member for whom it held the last membership: for a human account,
    -- normally the personal organization. Such an account must be deleted or
    -- soft-deleted in the same transaction.
    --
    -- SQLSTATE 23514 (check_violation): this is an integrity rule the schema
    -- cannot express as a check constraint, so it reports as one. Callers and
    -- tests match on the message, which names the user.
    --
    -- Under row-level security, this function must still see every
    -- membership of the user it checks, or it will refuse valid commits.
    create function ensure_user_has_membership() returns trigger
    language plpgsql as $$
    declare
      checked_user_id uuid;
    begin
      -- On users (insert, restore) the row itself is the user. On
      -- organization_members (delete, reassignment) the user who may have
      -- lost their last membership is the old one.
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
        raise exception 'user % must belong to at least one organization', checked_user_id
          using errcode = 'check_violation';
      end if;

      return null;
    end
    $$;

    -- Constraint triggers, deferred to commit: registration inserts the user
    -- before its organization and membership, and the check must see all
    -- three. Row-level triggers do not fire on TRUNCATE, so tests can still
    -- empty the tables. Every way a user can come to lack a membership is
    -- covered: a user appearing (insert, or restore from soft deletion) and a
    -- membership leaving them (delete, or reassignment to another user).
    -- Changing a membership's organization_id keeps the user a member, so it
    -- needs no check.
    create constraint trigger users_require_membership
      after insert on users
      deferrable initially deferred
      for each row execute function ensure_user_has_membership();

    -- A soft-delete passes (deleted_at is then not null); a restore of a user
    -- with no membership fails.
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
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop trigger if exists organization_members_user_reassigned on organization_members;
    drop trigger if exists organization_members_keep_one on organization_members;
    drop trigger if exists users_restored_require_membership on users;
    drop trigger if exists users_require_membership on users;
    drop function if exists ensure_user_has_membership();
  `);
};
