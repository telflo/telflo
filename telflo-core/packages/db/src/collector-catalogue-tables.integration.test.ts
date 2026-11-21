import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.js";
import { catalogueTables, openTestDatabases, type TestDatabases } from "./testing.js";

/**
 * collector_distributions and collector_versions (migration 1700000000023):
 * global tables the migration step's sync writes as the owner, which the API's
 * role may only read. Nothing here writes them in telflo_platform_test: every
 * write the API's role tries is refused, and the sync's own tests run on a
 * throwaway database (collector-catalogue/sync.integration.test.ts).
 */
describe("the collector catalog's tables", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  /** Every privilege a table can carry (Postgres 17 added MAINTAIN). */
  const tablePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];

  /** The privileges `role` holds on `table`, directly or inherited. */
  const privilegesOf = async (role: string, table: string) => {
    const { rows } = await sql<{ privilege: string }>`
      select privilege
        from unnest(${tablePrivileges}::text[]) with ordinality as p(privilege, position)
       where has_table_privilege(${role}, ${`platform.${table}`}, privilege)
       order by position
    `.execute(ownerDb);
    return rows.map((row) => row.privilege);
  };

  it.each(catalogueTables)(
    "grants telflo_platform_runtime, and the API's login through it, exactly SELECT on %s",
    async (table) => {
      const { rows } = await sql<{ name: string }>`select current_user as name`.execute(db);
      expect(await privilegesOf("telflo_platform_runtime", table)).toEqual(["SELECT"]);
      expect(await privilegesOf(rows[0]!.name, table)).toEqual(["SELECT"]);
    },
  );

  it.each(catalogueTables)(
    "refuses the API's role every write to %s (42501): insert, update, delete and truncate",
    async (table) => {
      const before = await sql<{ rows: number }>`select count(*)::int as rows from ${sql.table(table)}`.execute(
        ownerDb,
      );
      const writes =
        table === "collector_distributions"
          ? [
              sql`insert into collector_distributions (id, label, sort_order, is_default) values ('smuggled', 'Smuggled', 9, false)`,
              sql`update collector_distributions set label = 'Changed'`,
              sql`delete from collector_distributions`,
              sql`truncate collector_distributions cascade`,
            ]
          : [
              sql`insert into collector_versions
                    (distribution, version, label, released_at, is_default, deprecated, container_image,
                     otelcol_contrib, opamp_supervisor)
                  select distribution, '9.9.9', 'v9.9.9', released_at, false, false, container_image, '{}', '{}'
                    from collector_versions limit 1`,
              sql`update collector_versions set deprecated = true, deprecated_note = 'Retired by the API'`,
              sql`delete from collector_versions`,
              sql`truncate collector_versions`,
            ];
      // Each in a transaction rolled back whatever happens, so even a write
      // the grants wrongly let through leaves telflo_platform_test's catalog as
      // the sync wrote it.
      const rollback = new Error("rollback");
      for (const write of writes) {
        await expect(
          db.transaction().execute(async (transaction) => {
            await write.execute(transaction);
            throw rollback;
          }),
        ).rejects.toMatchObject({ code: "42501" });
      }
      const after = await sql<{ rows: number }>`select count(*)::int as rows from ${sql.table(table)}`.execute(ownerDb);
      expect(after.rows).toEqual(before.rows);
    },
  );

  it("has no row-level security on either table, and the API's role reads every row with no database context", async () => {
    const { rows } = await sql<{ name: string; rls: boolean; force: boolean }>`
      select relname::text as name, relrowsecurity as rls, relforcerowsecurity as force
        from pg_class where relname in (${sql.join([...catalogueTables])}) order by relname
    `.execute(ownerDb);
    expect(rows).toEqual([
      { name: "collector_distributions", rls: false, force: false },
      { name: "collector_versions", rls: false, force: false },
    ]);
    for (const table of catalogueTables) {
      const asOwner = await sql<{ rows: number }>`select count(*)::int as rows from ${sql.table(table)}`.execute(
        ownerDb,
      );
      const asApplication = await sql<{ rows: number }>`select count(*)::int as rows from ${sql.table(table)}`.execute(
        db,
      );
      expect(asOwner.rows[0]!.rows).toBeGreaterThan(0);
      expect(asApplication.rows).toEqual(asOwner.rows);
    }
  });

  it("comments every table, column, constraint and index of the catalog (migration 025's renamed_types and its check included), and the three columns, the trigger and the function migration 023 adds elsewhere", async () => {
    const { rows } = await sql<{ object: string; comment: string | null }>`
      select 'table ' || c.relname as object, obj_description(c.oid, 'pg_class') as comment
        from pg_class c where c.relname in (${sql.join([...catalogueTables])})
      union all
      select 'column ' || a.attrelid::regclass || '.' || a.attname, col_description(a.attrelid, a.attnum)
        from pg_attribute a
       where (a.attrelid in (to_regclass('collector_distributions'), to_regclass('collector_versions'))
              and a.attnum > 0 and not a.attisdropped)
          or (a.attrelid = to_regclass('configurations') and a.attname = 'collector_distribution')
          or (a.attrelid = to_regclass('configuration_versions')
              and a.attname in ('collector_distribution', 'collector_version'))
      union all
      select 'constraint ' || con.conname, obj_description(con.oid, 'pg_constraint')
        from pg_constraint con
       where con.contype <> 'n'
         and (con.conrelid in (to_regclass('collector_distributions'), to_regclass('collector_versions'))
              or con.conname in ('fk_configurations_collector_distribution',
                                 'uq_configurations_id_collector_distribution',
                                 'fk_configuration_versions_configuration_distribution',
                                 'fk_configuration_versions_collector_version'))
      union all
      select 'index ' || i.indexrelid::regclass, obj_description(i.indexrelid, 'pg_class')
        from pg_index i
       where i.indrelid in (to_regclass('collector_distributions'), to_regclass('collector_versions'))
         and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)
      union all
      select 'function ' || p.proname, obj_description(p.oid, 'pg_proc')
        from pg_proc p where p.proname = 'refuse_configuration_distribution_change'
      union all
      select 'trigger ' || t.tgname, obj_description(t.oid, 'pg_trigger')
        from pg_trigger t where t.tgname = 'configurations_collector_distribution_unchanged'
      order by 1
    `.execute(ownerDb);
    // 2 tables, their 7 + 13 columns (migration 025's renamed_types the 7th) and 3 elsewhere, their 4 + 5
    // constraints (025's array check the 4th) and 4 elsewhere, their 2 indexes backing no constraint, a function
    // and a trigger.
    expect(rows).toHaveLength(2 + 20 + 3 + 9 + 4 + 2 + 2);
    expect(rows.filter((row) => row.comment === null || row.comment.trim() === "")).toEqual([]);
  });
});
