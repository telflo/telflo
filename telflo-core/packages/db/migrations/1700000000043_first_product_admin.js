/**
 * The first product admin.
 *
 *   * bootstrap_first_product_admin(p_user_id, p_at): the one way the API's
 *     role can make a product admin without being one. `telflo-admin
 *     bootstrap` (apps/api/src/admin/) calls it once, in the transaction
 *     that creates the account, through
 *     identity/repositories/user-repository.ts (a test scans the source).
 *     Migration 041's pattern: SECURITY DEFINER, owned by the migration role
 *     (the tables' owner, so migration 026's owner-only trigger lets it set
 *     the flag), search_path pg_catalog, platform with schema-qualified
 *     tables, EXECUTE revoked from public and granted to
 *     telflo_platform_runtime only.
 *     In order:
 *       - 22023 when either argument is null;
 *       - a transaction advisory lock on one constant key
 *         (hashtext('telflo.bootstrap_first_product_admin')), so concurrent
 *         calls run one after the other: the second sees the first's
 *         commit. Not a table lock: the command's own insert into users,
 *         earlier in its transaction, would deadlock two bootstraps;
 *       - 42501 with HINT telflo_product_admin_exists when any user holds
 *         the flag, deleted or not, a person or a service account (once
 *         there has been a product admin, the others grant it);
 *       - the flag set on the user, when a live human
 *         (updated_at = p_at), or 42501 with HINT
 *         telflo_bootstrap_user_not_found (unknown, deleted, a service
 *         account);
 *       - an audit row, product_admin.bootstrapped, the user as actor and
 *         subject, occurred_at p_at (the API's clock), metadata empty.
 *     Its messages are fixed words: never an email or an id.
 *   * users.accepted_terms_version's comment: the current version is the
 *     site's setting (TELFLO_TERMS_VERSION), no longer a constant of the
 *     code, and a site without one asks for none. Migration 007's comment
 *     named CURRENT_TERMS_VERSION, which no longer exists.
 *   * users.is_product_admin's comment names the bootstrap beside the grant
 *     and the revoke.
 *
 * down drops the function and restores migration 007's and migration
 * 041's comments: migration 042's catalogue exactly.
 */

const signature = "bootstrap_first_product_admin(uuid, timestamptz)";

/** Migration 007's comment on users.accepted_terms_version, exactly: what down restores. */
const migration007TermsComment = `
    comment on column users.accepted_terms_version is
      'the terms version the user last accepted, or null for one who has
       accepted none (an account created through a provider, until the terms
       dialog). The current version is CURRENT_TERMS_VERSION in
       @telflo/contracts; any other value means the terms must be accepted
       again.';
`;

/** Migration 041's comment on users.is_product_admin, exactly: what down restores. */
const migration041FlagComment = `
    comment on column users.is_product_admin is
      'a product admin: writes the flows and reaches
       /product-admin. False by default; set and cleared only as the
       tables'' owner (users_product_admin_owner_only): by an operator''s SQL,
       and by another product admin through product_admin_grant and
       product_admin_revoke, which run as the owner. Read
       on every request, so a revocation takes effect at once.';
`;

export const up = (pgm) => {
  pgm.sql(`
    comment on column users.accepted_terms_version is
      'the terms version the user last accepted, or null for one who has
       accepted none (an account created through a provider, until the terms
       dialog, or on a site that asks for no Terms). The current version is
       the site''s setting, TELFLO_TERMS_VERSION: any other value means the
       terms must be accepted again, and a site whose setting is empty asks
       for none.';

    comment on column users.is_product_admin is
      'a product admin: writes the flows and reaches
       /product-admin. False by default; set and cleared only as the
       tables'' owner (users_product_admin_owner_only): by an operator''s SQL,
       by another product admin through product_admin_grant and
       product_admin_revoke, and once, while no user holds it, by
       bootstrap_first_product_admin, which run as the owner. Read on every
       request, so a revocation takes effect at once.';

    create function bootstrap_first_product_admin(p_user_id uuid, p_at timestamptz)
    returns void
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, platform
    as $$
    declare
      found_email text;
    begin
      if p_user_id is null or p_at is null then
        raise exception 'a bootstrap takes a user and the time' using errcode = 'invalid_parameter_value';
      end if;
      -- One bootstrap at a time: a second waits here for the first to end, then sees its flag.
      perform pg_advisory_xact_lock(hashtext('telflo.bootstrap_first_product_admin'));
      if exists (select 1 from platform.users u where u.is_product_admin) then
        raise exception 'a product admin already exists'
          using errcode = 'insufficient_privilege', hint = 'telflo_product_admin_exists';
      end if;
      update platform.users u
         set is_product_admin = true, updated_at = p_at
       where u.id = p_user_id and u.deleted_at is null and u.kind = 'human'
      returning u.email into found_email;
      if found_email is null then
        raise exception 'no live person has that id'
          using errcode = 'insufficient_privilege', hint = 'telflo_bootstrap_user_not_found';
      end if;
      insert into platform.audit_events (occurred_at, actor_user_id, actor_email, action, subject_type, subject_id, metadata)
      values (p_at, p_user_id, found_email, 'product_admin.bootstrapped', 'user', p_user_id, '{}'::jsonb);
    end;
    $$;

    comment on function ${signature} is
      'makes the first product admin: 22023 for a null
       argument; under a transaction advisory lock (one constant key), so
       concurrent calls run one after the other, 42501 with HINT
       telflo_product_admin_exists when any user holds the flag (deleted
       or not), 42501 with HINT telflo_bootstrap_user_not_found unless the
       user is a live human; otherwise sets the flag (updated_at = p_at)
       and audits product_admin.bootstrapped (occurred_at = p_at, the
       API''s clock). Messages in fixed words. Called by telflo-admin
       bootstrap, in the transaction that creates the account.';

    revoke execute on function ${signature} from public;
    grant execute on function ${signature} to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    drop function ${signature};
    ${migration007TermsComment}
    ${migration041FlagComment}
  `);
};
