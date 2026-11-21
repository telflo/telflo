import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext, type DatabaseContext } from "../database/context.js";
import {
  resourceRegistry,
  type OrganizationResource,
  type OrganizationResourceOperations,
} from "./resource-registry.js";

/*
 * The cross-tenant suite, generated from the resource registry. Every
 * organization resource gets the same tests: organization B's context can't
 * list, read, change or remove organization A's row through the resource's
 * repository, while A's own context can. Every one with row-level security
 * also gets raw SQL as the API's role. Nobody writes these per resource:
 * registering it is what adds them.
 *
 * Each seed is a row A's own member can see: for the configuration tables,
 * another member's published configuration, or a draft version 2 of one,
 * since another member's draft is invisible to them by design. Drafts'
 * privacy within one organization has its own suite,
 * draft-privacy.integration.test.ts.
 *
 * A resource whose repository has no remove (a child table, whose rows go
 * with their parent's) declares `removeUnsupported`. Its two remove tests
 * are replaced by one, named with the reason, that checks the operations
 * really have none. Likewise `updateUnsupported` (a test run, which only
 * the dispatcher's functions change) for the two update tests. The raw-SQL
 * tests run whatever the entry declares: the policies must refuse B there
 * all the same.
 *
 * Each seed is made for A's own member, whom the suite acts as in A's
 * context: a test file is visible to its owner alone.
 */

/** What an entry's `operations` returns: without `update` or `remove` when the entry declares them unsupported. */
type EntryOperations = Partial<Pick<OrganizationResourceOperations, "update" | "remove">> &
  Omit<OrganizationResourceOperations, "update" | "remove">;

const organizationResources = resourceRegistry.filter(
  (resource): resource is OrganizationResource => resource.kind === "organization",
);

describe("cross-tenant isolation", () => {
  /** The API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /**
   * A tenant: a person acting in a live group organization. They also keep
   * their personal organization, so deleting the group, or removing them
   * from it, leaves the membership invariant satisfied.
   */
  const createTenant = async (): Promise<DatabaseContext & { organizationId: string }> => {
    const person = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: person.user.id });
    return { userId: person.user.id, organizationId: group.organization.id };
  };

  describe("the registry", () => {
    it("declares every table in the database exactly once, and nothing else", async () => {
      // pg_class, as the owner: information_schema hides tables the
      // connecting role has no grant on.
      const { rows } = await sql<{ name: string }>`
        select c.relname as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'platform' and c.relkind in ('r', 'p') and c.relname <> 'pgmigrations'
      `.execute(ownerDb);
      const registered = resourceRegistry.map((resource) => resource.table);

      expect(registered.filter((table, index) => registered.indexOf(table) !== index)).toEqual([]);
      expect([...registered].sort()).toEqual(rows.map((row) => row.name).sort());
    });

    it("marks row-level security exactly where the database has it on", async () => {
      const { rows } = await sql<{ name: string; hasRowLevelSecurity: boolean }>`
        select c.relname as name, c.relrowsecurity as "hasRowLevelSecurity"
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'platform' and c.relkind in ('r', 'p') and c.relname <> 'pgmigrations'
      `.execute(ownerDb);
      const inDatabase = Object.fromEntries(rows.map((row) => [row.name, row.hasRowLevelSecurity]));
      const declared = Object.fromEntries(
        resourceRegistry.map((resource) => [
          resource.table,
          // A global table may have its own kind (a person's rows); a system one has none.
          resource.kind === "system" ? false : (resource.hasRowLevelSecurity ?? false),
        ]),
      );

      expect(declared).toEqual(inDatabase);
    });

    it("grants the API's role no SELECT on a system table: it reaches one only through the product-admin functions", async () => {
      const systemTables = resourceRegistry.filter((resource) => resource.kind === "system").map((resource) => resource.table);
      expect(systemTables.sort()).toEqual(["user_deletion_records", "user_feedback"]);
      for (const table of systemTables) {
        const { rows } = await sql<{ held: boolean }>`
          select has_table_privilege('telflo_platform_runtime', ${`platform.${table}`}, 'SELECT') as held
        `.execute(ownerDb);
        expect({ table, select: rows[0]!.held }).toEqual({ table, select: false });
        await expect(sql`select 1 from ${sql.table(table)} limit 1`.execute(db)).rejects.toMatchObject({ code: "42501" });
      }
    });
  });

  describe.each(organizationResources.map((resource) => [resource.table, resource] as const))(
    "%s",
    (_table, resource) => {
      let a: DatabaseContext & { organizationId: string };
      let b: DatabaseContext & { organizationId: string };
      let key: string;

      beforeEach(async () => {
        a = await createTenant();
        b = await createTenant();
        key = await resource.seed(ownerDb, a.organizationId, a.userId);
      });

      /** Runs one operation in `context`'s database context, over the resource's repository. */
      const as = <Result>(
        context: DatabaseContext & { organizationId: string },
        work: (operations: EntryOperations) => Promise<Result>,
      ) =>
        withDatabaseContext(db, context, (transaction) =>
          work(resource.operations(transaction, { userId: context.userId, organizationId: context.organizationId })),
        );

      /** Removes the row with this key; only a resource without `removeUnsupported` reaches it. */
      const remove = (operations: EntryOperations, key: string) => {
        if (operations.remove === undefined) throw new Error(`${resource.table} has no remove`);
        return operations.remove(key);
      };

      /** Changes the row with this key; only a resource without `updateUnsupported` reaches it. */
      const update = (operations: EntryOperations, key: string) => {
        if (operations.update === undefined) throw new Error(`${resource.table} has no update`);
        return operations.update(key);
      };

      /** A's row, read back as the owner; undefined once it's gone. */
      const rowInA = async () => {
        const { rows } = await sql<Record<string, unknown>>`
          select * from ${sql.table(resource.table)}
          where ${sql.ref(resource.keyColumn)} = ${key}
            and ${sql.ref(resource.scopingColumn)} = ${a.organizationId}
        `.execute(ownerDb);
        return rows[0];
      };

      describe("through its repository, organization B's context", () => {
        it("can't list A's row", async () => {
          expect(await as(b, (operations) => operations.list())).not.toContain(key);
        });

        it("can't read A's row", async () => {
          expect(await as(b, (operations) => operations.read(key))).toBeUndefined();
        });

        if (resource.updateUnsupported === undefined) {
          it("can't update A's row", async () => {
            const before = await rowInA();
            await as(b, (operations) => update(operations, key));
            expect(await rowInA()).toEqual(before);
          });
        }

        if (resource.removeUnsupported === undefined) {
          it("can't remove A's row", async () => {
            const before = await rowInA();
            await as(b, (operations) => remove(operations, key));
            expect(await rowInA()).toEqual(before);
          });
        }
      });

      describe("through its repository, organization A's own context", () => {
        it("lists the row", async () => {
          expect(await as(a, (operations) => operations.list())).toContain(key);
        });

        it("reads the row", async () => {
          expect(await as(a, (operations) => operations.read(key))).toBeDefined();
        });

        if (resource.updateUnsupported === undefined) {
          it("updates the row", async () => {
            const before = await rowInA();
            await as(a, (operations) => update(operations, key));
            expect(await rowInA()).not.toEqual(before);
          });
        }

        if (resource.removeUnsupported === undefined) {
          it("removes the row", async () => {
            const before = await rowInA();
            await as(a, (operations) => remove(operations, key));
            expect(await rowInA()).not.toEqual(before);
          });
        }
      });

      if (resource.updateUnsupported !== undefined) {
        it(`has no update: ${resource.updateUnsupported}`, async () => {
          expect(await as(a, async (operations) => "update" in operations)).toBe(false);
          expect(await as(b, async (operations) => "update" in operations)).toBe(false);
        });
      }

      if (resource.removeUnsupported !== undefined) {
        it(`has no remove: ${resource.removeUnsupported}`, async () => {
          expect(await as(a, async (operations) => "remove" in operations)).toBe(false);
          expect(await as(b, async (operations) => "remove" in operations)).toBe(false);
        });
      }

      if (resource.hasRowLevelSecurity) {
        describe("in raw SQL as the application role, organization B's context", () => {
          const inB = <Result>(work: (transaction: Transaction<Database>) => Promise<Result>) =>
            withDatabaseContext(db, b, work);

          it("selects none of A's rows", async () => {
            const { rows } = await inB((transaction) =>
              sql`select * from ${sql.table(resource.table)}
                  where ${sql.ref(resource.scopingColumn)} = ${a.organizationId}`.execute(transaction),
            );
            expect(rows).toEqual([]);
          });

          it("updates none of A's rows", async () => {
            const before = await rowInA();
            const result = await inB((transaction) =>
              sql`update ${sql.table(resource.table)}
                  set ${sql.ref(resource.keyColumn)} = ${sql.ref(resource.keyColumn)}
                  where ${sql.ref(resource.scopingColumn)} = ${a.organizationId}`.execute(transaction),
            );
            expect(result.numAffectedRows).toBe(0n);
            expect(await rowInA()).toEqual(before);
          });

          it("deletes none of A's rows", async () => {
            const result = await inB((transaction) =>
              sql`delete from ${sql.table(resource.table)}
                  where ${sql.ref(resource.scopingColumn)} = ${a.organizationId}`.execute(transaction),
            );
            expect(result.numAffectedRows).toBe(0n);
            expect(await rowInA()).toBeDefined();
          });

          it("can't insert a row naming A: 42501", async () => {
            const row = await resource.rowToInsert(ownerDb, a.organizationId);
            await expect(
              inB((transaction) =>
                transaction
                  .insertInto(resource.table)
                  .values(row as never)
                  .execute(),
              ),
            ).rejects.toMatchObject({ code: "42501" });
          });
        });
      }
    },
  );
});
