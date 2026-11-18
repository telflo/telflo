import { sql } from "kysely";
import type { Kysely } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

/**
 * The API's own database role (D5 decision 1, ADR 0014).
 *
 * Migration 009 creates `telflo_platform_runtime`, a NOLOGIN role holding only the
 * privileges the API needs. The API connects as a login role that is a member
 * of it, named by `TELFLO_DATABASE_URL`; migrations connect as the tables'
 * owner, named by `TELFLO_MIGRATION_DATABASE_URL`. A superuser, a role with
 * BYPASSRLS, and a table's owner all skip row-level security, so the API
 * refuses to start as any of them.
 */
export const APPLICATION_ROLE = "telflo_platform_runtime";

/**
 * Held while provisioning, on the `postgres` maintenance database, which
 * every database on the server shares. Roles belong to the whole server, and
 * two test runs provisioning at once would otherwise race: a concurrent
 * `create role` fails with 23505, a concurrent `alter role … password` with
 * XX000 (D5 Preflight ruling 5).
 */
const PROVISIONING_LOCK = "telflo.provision_application_role";

const SETTINGS_HINT =
  "TELFLO_DATABASE_URL names the API's own login role, and TELFLO_MIGRATION_DATABASE_URL the tables' owner; see .env.example.";

/** The two connections `npm run db:migrate` needs, from the environment. */
export interface MigrationSettings {
  /** The tables' owner, which runs migrations and provisions the application's login. */
  migrationDatabaseUrl: string;
  /** The API's login role, which provisioning creates or resets. */
  applicationDatabaseUrl: string;
}

/** Reads both URLs, failing with a pointer to `.env.example` when either is missing. */
export function migrationSettings(env: NodeJS.ProcessEnv): MigrationSettings {
  const missing = ["TELFLO_MIGRATION_DATABASE_URL", "TELFLO_DATABASE_URL"].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable ${missing.join(" and ")}. ${SETTINGS_HINT}`);
  }
  return {
    migrationDatabaseUrl: env.TELFLO_MIGRATION_DATABASE_URL!,
    applicationDatabaseUrl: env.TELFLO_DATABASE_URL!,
  };
}

/**
 * Creates the login role named in `applicationUrl`, with that URL's password,
 * as a member of `telflo_platform_runtime`, or resets an existing one's password
 * and attributes. Connects as `ownerUrl`'s user, which must be able to create
 * roles. Idempotent, and safe when two runs provision at once. The login never
 * holds SUPERUSER, BYPASSRLS, CREATEDB, REPLICATION or CREATEROLE afterwards.
 *
 * Refuses when the login is the owner, a member of the owner (which bypasses
 * RLS on the owner's tables), or an existing superuser: provisioning must
 * never demote the role migrations run as, or quietly keep a role that
 * bypasses every policy.
 *
 * The owner need not be a superuser (D33-1 decision 15: in a cluster it holds
 * only `LOGIN CREATEROLE`). Such an owner may not name SUPERUSER, BYPASSRLS,
 * CREATEDB or REPLICATION in `alter role`, not even to clear them, so it
 * resets only the login, `nocreaterole`, `inherit` and the password. It
 * refuses an existing login holding any of those four (it can't remove them,
 * and the API's login must hold none), and one it holds no ADMIN option on
 * (one it didn't create), which it can't alter at all.
 *
 * The name and password reach Postgres through `pg`'s escaping, because
 * `create role … password` takes no bind parameter. Such a statement is logged
 * when the server sets `log_statement` to `ddl` or `all`.
 */
export async function provisionApplicationRole(ownerUrl: string, applicationUrl: string): Promise<void> {
  const application = new URL(applicationUrl);
  const login = decodeURIComponent(application.username);
  const password = decodeURIComponent(application.password);
  if (!login || !password) {
    throw new Error(`TELFLO_DATABASE_URL must name a user and a password for the API's login role. ${SETTINGS_HINT}`);
  }

  const maintenanceUrl = new URL(ownerUrl);
  maintenanceUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [PROVISIONING_LOCK]);

    const { rows: ownerRows } = await client.query<{ owner: string; owner_is_superuser: boolean }>(
      "select rolname as owner, rolsuper as owner_is_superuser from pg_roles where rolname = current_user",
    );
    const { owner, owner_is_superuser: ownerIsSuperuser } = ownerRows[0]!;
    if (login === owner) {
      throw new Error(
        `TELFLO_DATABASE_URL names "${login}", the role migrations run as. The API needs a login role of its own. ${SETTINGS_HINT}`,
      );
    }

    const { rows: existing } = await client.query<{
      is_superuser: boolean;
      is_owner_member: boolean;
      holds_superuser_only_attribute: boolean;
      owner_has_admin: boolean;
    }>(
      `select rolsuper as is_superuser, pg_has_role(oid, $2::name, 'MEMBER') as is_owner_member,
              (rolsuper or rolbypassrls or rolcreatedb or rolreplication) as holds_superuser_only_attribute,
              pg_has_role($2::name, oid, 'MEMBER WITH ADMIN OPTION') as owner_has_admin
         from pg_roles where rolname = $1`,
      [login, owner],
    );
    if (!ownerIsSuperuser && existing[0]?.holds_superuser_only_attribute) {
      throw new Error(
        `TELFLO_DATABASE_URL names "${login}", which holds SUPERUSER, BYPASSRLS, CREATEDB or REPLICATION. The API's login role ` +
          `must hold none of them, and only a superuser can remove them ("${owner}" is not one). ${SETTINGS_HINT}`,
      );
    }
    if (!ownerIsSuperuser && existing[0] && !existing[0].owner_has_admin) {
      throw new Error(
        `TELFLO_DATABASE_URL names "${login}", which "${owner}" can't reset: "${owner}" didn't create it and holds no ` +
          `ADMIN option on it. A superuser can drop it, so provisioning creates it again. ${SETTINGS_HINT}`,
      );
    }
    if (existing[0]?.is_superuser) {
      throw new Error(`TELFLO_DATABASE_URL names "${login}", a superuser, which bypasses row-level security. ${SETTINGS_HINT}`);
    }
    if (existing[0]?.is_owner_member) {
      throw new Error(
        `TELFLO_DATABASE_URL names "${login}", a member of "${owner}", which owns the tables and so bypasses row-level security. ${SETTINGS_HINT}`,
      );
    }

    const role = pg.escapeIdentifier(login);
    const attributes = `login password ${pg.escapeLiteral(password)} nosuperuser nobypassrls nocreatedb noreplication nocreaterole inherit`;
    // A non-superuser owner may not name SUPERUSER, BYPASSRLS, CREATEDB or
    // REPLICATION, so its alter leaves them out; the checks above refused a
    // login holding any of them.
    const ownerAlterable = `login password ${pg.escapeLiteral(password)} nocreaterole inherit`;
    await client.query(
      existing.length === 0
        ? `create role ${role} ${attributes}`
        : `alter role ${role} ${ownerIsSuperuser ? attributes : ownerAlterable}`,
    );
    // Since Postgres 16 inheritance is fixed per grant, not per role, so it
    // is stated here; granting again updates an existing grant's option.
    await client.query(`grant ${APPLICATION_ROLE} to ${role} with inherit true`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Throws unless `db` connects as a role row-level security constrains: not a
 * superuser, without BYPASSRLS, owning no table in `public` (directly or
 * through a role it inherits from), and a member of `telflo_platform_runtime`.
 * The API calls it before listening, so a misconfigured connection refuses
 * to start rather than serve with every policy silently skipped.
 */
export async function assertApplicationRole(db: Kysely<Database>): Promise<void> {
  const { rows } = await sql<{
    name: string;
    is_superuser: boolean;
    bypasses_rls: boolean;
    owns_table: boolean;
    is_application_member: boolean;
  }>`
    select
      r.rolname as name,
      r.rolsuper as is_superuser,
      r.rolbypassrls as bypasses_rls,
      exists (
        select 1
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'platform'
           and c.relkind in ('r', 'p')
           and pg_has_role(current_user, c.relowner, 'USAGE')
      ) as owns_table,
      -- pg_has_role raises for a role that does not exist, as before
      -- migration 009; case evaluates it only when the role does.
      case when exists (select 1 from pg_roles where rolname = ${APPLICATION_ROLE})
        then pg_has_role(current_user, ${APPLICATION_ROLE}, 'USAGE')
        else false
      end as is_application_member
    from pg_roles r
    where r.rolname = current_user
  `.execute(db);
  const role = rows[0]!;

  const problems = [
    role.is_superuser && "is a superuser",
    role.bypasses_rls && "has BYPASSRLS",
    role.owns_table && "owns application tables, or inherits from their owner",
    !role.is_application_member && `is not a member of ${APPLICATION_ROLE} (npm run db:migrate provisions it)`,
  ].filter((problem) => typeof problem === "string");
  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: the API's database role "${role.name}" ${problems.join(", ")}, so row-level security ` +
        `would not constrain it. Set TELFLO_DATABASE_URL to the API's own login role, and ` +
        `TELFLO_MIGRATION_DATABASE_URL to the tables' owner (see .env.example).`,
    );
  }
}
