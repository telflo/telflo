/**
 * The membership invariant, serialized per user.
 *
 * Migration 010's ensure_user_has_membership checks, at commit, that every
 * user a transaction may have stranded still has a live membership in a live
 * organization. Two transactions each removing one of a user's last two
 * memberships, in different organizations, touch different rows and never
 * wait on each other. Under READ COMMITTED each check then sees the other's
 * removal as not yet committed, so the membership it removed looks like the
 * only one gone: both commit, and the user is left with none (write skew).
 *
 * The check now locks the users it checks `for no key update`, in id order,
 * in a statement of its own before it looks for memberships. The second
 * transaction waits there for the first to commit or roll back; its next
 * statement takes a new snapshot, sees the first's removal, and refuses
 * (23514). `for no key update` rather than `for update`: the foreign-key
 * checks that insert rows referencing a user (a session, a membership, an
 * audit row) take `key share`, which it leaves alone. It does conflict with
 * a password reset's and a takeover's `for update` and with sign-in's `for
 * share`, which each lock the user first. The API's removal and deletion lock
 * the same users early (the member repository's lockAccounts), before any
 * session, so for them the lock here, at commit, finds the users already
 * held. A restore takes it only here, at commit, while holding the
 * organization and the membership: a new organization -> user wait. It is
 * safe because nothing locks a session and then an organization (the switch
 * locks its target organization before its session), so every
 * path goes organization -> user -> session. (This header was corrected
 * after the migration was written; the SQL below is unchanged.)
 *
 * Only the function changes: the triggers keep calling it. down restores
 * migration 010's body.
 */

const invariantMessage = `'user % must belong to at least one organization'`;

/** Migration 010's way of choosing the users to check: kept the same in both directions. */
const checkedUserIds = `
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
`;

/** Migration 010's check: a live user with no live membership in a live organization fails. */
const strandedCheck = `
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
`;

/** The function, with `lock` between choosing the users and checking them. */
const invariantFunction = (lock) => `
    create or replace function ensure_user_has_membership() returns trigger
    language plpgsql
    security definer
    set search_path = platform, pg_temp
    as $$
    declare
      checked_user_ids uuid[];
      stranded_user_id uuid;
    begin
${checkedUserIds}${lock}${strandedCheck}    end
    $$;
`;

export const up = (pgm) => {
  pgm.sql(
    invariantFunction(`
      -- A statement of its own, so the check below takes its snapshot only
      -- once this transaction holds every checked user: a concurrent
      -- transaction checking the same user has committed or rolled back by
      -- then, and its removals are seen. In id order, so two transactions
      -- checking overlapping users lock them in the same order.
      perform 1
         from users u
        where u.id = any (checked_user_ids)
        order by u.id
          for no key update;
`),
  );
};

export const down = (pgm) => {
  pgm.sql(invariantFunction(""));
};
