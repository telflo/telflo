/**
 * Only the API's role may connect to the platform's database (ADR 0026:
 * the opamp-server is reached only through its API; D11a spec decision 4).
 *
 * The platform and the opamp-server share one Postgres server but no
 * database object, in either direction: each reaches the other only through
 * the opamp-server's API. Postgres lets every role connect to a new database
 * (PUBLIC holds CONNECT), so the opamp-server's roles could open this one,
 * and a cross-boundary join or query would be stopped only by table grants
 * and by tests noticing. Revoking PUBLIC's CONNECT makes it impossible:
 * opamp-server's bootstrap.sql does the same to telflo_opamp_server.
 *
 *   * CONNECT goes to telflo_platform_runtime, which telflo_platform (the API's login
 *     role, provisioned by `npm run db:migrate`) inherits. A self-hoster's
 *     login role for the API is a member of telflo_platform_runtime too.
 *   * The role migrations run as keeps connecting because it owns the
 *     database (an owner's own CONNECT survives the revoke) or is a
 *     superuser, as telflo is in compose, CI and the tests. A migration role
 *     that is neither would lock itself out here. Test and e2e databases are
 *     migrated by telflo and used by telflo_platform, so none of their setup
 *     changes.
 *   * The database is whichever one this migration runs in (telflo,
 *     telflo_platform_test, telflo_platform_e2e_test, a throwaway test database), named with
 *     format('%I', current_database()), since GRANT and REVOKE take no
 *     expression.
 *   * TEMPORARY stays with PUBLIC: it only matters to a role that can
 *     connect.
 *
 * down gives PUBLIC its CONNECT back and takes telflo_platform_runtime's. The ACL
 * then lists PUBLIC's privileges explicitly instead of being null, which
 * grants the same: compare privileges, not the raw ACL.
 */

export const up = (pgm) => {
  pgm.sql(`
    do $$
    begin
      execute format('revoke connect on database %I from public', current_database());
      execute format('grant connect on database %I to telflo_platform_runtime', current_database());
    end
    $$;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    do $$
    begin
      execute format('grant connect on database %I to public', current_database());
      execute format('revoke connect on database %I from telflo_platform_runtime', current_database());
    end
    $$;
  `);
};
