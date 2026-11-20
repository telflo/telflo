/**
 * The API's own database role.
 *
 * Until now the API connected as the tables' owner, a superuser, and row-level
 * security never applies to either. telflo_platform_runtime is a NOLOGIN role
 * holding only what the API needs; the API logs in as a role that is a member
 * of it (provisioned by `npm run db:migrate`, see src/application-role.ts), and
 * migrations keep running as the owner.
 *
 *   * Roles belong to the whole server, not to one database, and telflo,
 *     telflo_platform_test and telflo_platform_e2e_test share one server. So the role is created
 *     only if missing, and a concurrent create by another database's migration
 *     (42710 duplicate_object, or 23505 unique_violation from the catalog's
 *     index when both commit at once) counts as done.
 *   * audit_events gets select and insert only: it is append-only, now by
 *     grant as well as by its trigger.
 *   * Default privileges give tables later migrations create (as this same
 *     owner) select, insert, update and delete. A later append-only table
 *     revokes explicitly.
 *   * pgmigrations gets nothing: the API has no business reading or writing
 *     migration history.
 *
 * down revokes everything this grants and leaves the role, which other
 * databases on the server may still use.
 */

const readWriteTables = [
  "users",
  "email_verification_tokens",
  "organizations",
  "organization_members",
  "sessions",
  "refresh_tokens",
  "password_reset_tokens",
  "user_identities",
];

export const up = (pgm) => {
  pgm.sql(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'telflo_platform_runtime') then
        create role telflo_platform_runtime nologin;
      end if;
    exception when duplicate_object or unique_violation then
      null;
    end
    $$;

    grant usage on schema platform to telflo_platform_runtime;
    grant select, insert, update, delete on ${readWriteTables.join(", ")} to telflo_platform_runtime;
    grant select, insert on audit_events to telflo_platform_runtime;

    alter default privileges in schema platform
      grant select, insert, update, delete on tables to telflo_platform_runtime;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    alter default privileges in schema platform
      revoke select, insert, update, delete on tables from telflo_platform_runtime;
    revoke all on all tables in schema platform from telflo_platform_runtime;
    revoke usage on schema platform from telflo_platform_runtime;
  `);
};
