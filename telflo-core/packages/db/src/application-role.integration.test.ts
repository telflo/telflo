import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import pg from "pg";
import { APPLICATION_ROLE, assertApplicationRole, migrationSettings, provisionApplicationRole } from "./application-role.js";
import { createDb, createPool } from "./pool.js";
import type { Database } from "./schema.js";
import { openTestDatabases } from "./testing.js";
import type { TestDatabases } from "./testing.js";

// Roles belong to the whole server, so every role these tests create has a
// name of its own and is dropped afterwards. None of them is the suite's own
// login role, which other test files are connected as.

describe("the application role", () => {
  let databases: TestDatabases;
  let ownerDb: Kysely<Database>;
  let ownerUrl: string;
  const createdRoles: string[] = [];

  beforeAll(() => {
    databases = openTestDatabases();
    ownerDb = databases.ownerDb;
    ownerUrl = process.env.TELFLO_MIGRATION_DATABASE_URL!;
  });

  afterEach(async () => {
    for (const role of createdRoles.splice(0)) {
      await sql`drop role if exists ${sql.id(role)}`.execute(ownerDb);
    }
  });

  afterAll(async () => {
    await databases.destroy();
  });

  /** A role name no other test uses, dropped after the test. */
  function newRoleName(): string {
    const name = `telflo_role_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    createdRoles.push(name);
    return name;
  }

  /** The test database's URL, logging in as `user` with `password`. */
  function urlFor(user: string, password: string): string {
    const url = new URL(ownerUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  }

  /** Runs `work` on a connection as `url`'s user, closed afterwards. */
  async function connectedAs<T>(url: string, work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    const db = createDb(createPool(url));
    try {
      return await work(db);
    } finally {
      await db.destroy();
    }
  }

  async function currentUser(url: string): Promise<string> {
    return connectedAs(url, async (db) => {
      const { rows } = await sql<{ name: string }>`select current_user as name`.execute(db);
      return rows[0]!.name;
    });
  }

  async function attributesOf(role: string) {
    const { rows } = await sql<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
    }>`
      select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolreplication, rolcreaterole, rolinherit
        from pg_roles where rolname = ${role}
    `.execute(ownerDb);
    return rows[0];
  }

  async function applicationMembershipOf(role: string) {
    const { rows } = await sql<{ inherit_option: boolean }>`
      select m.inherit_option
        from pg_auth_members m
       where m.roleid = ${APPLICATION_ROLE}::regrole and m.member = ${role}::regrole
    `.execute(ownerDb);
    return rows;
  }

  const LOGIN_ATTRIBUTES = {
    rolcanlogin: true,
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolreplication: false,
    rolcreaterole: false,
    rolinherit: true,
  };

  describe("provisionApplicationRole", () => {
    it("creates a missing role with the right attributes, as an inheriting member of telflo_platform_runtime", async () => {
      const role = newRoleName();
      // A password that needs both URL-decoding and SQL quoting.
      const password = `p@ss:w/rd '"${randomUUID()}`;

      await provisionApplicationRole(ownerUrl, urlFor(role, password));

      expect(await attributesOf(role)).toEqual(LOGIN_ATTRIBUTES);
      expect(await applicationMembershipOf(role)).toEqual([{ inherit_option: true }]);
      expect(await currentUser(urlFor(role, password))).toBe(role);
    });

    it("resets a changed password and attributes on an existing role", async () => {
      const role = newRoleName();
      await provisionApplicationRole(ownerUrl, urlFor(role, "first-password"));
      await sql.raw(`alter role ${pg.escapeIdentifier(role)} createdb bypassrls replication noinherit`).execute(ownerDb);

      await provisionApplicationRole(ownerUrl, urlFor(role, "second-password"));

      expect(await attributesOf(role)).toEqual(LOGIN_ATTRIBUTES);
      expect(await currentUser(urlFor(role, "second-password"))).toBe(role);
      await expect(currentUser(urlFor(role, "first-password"))).rejects.toThrow(/password authentication failed/);
    });

    it("refuses the owner's own URL, and changes nothing", async () => {
      const owner = new URL(ownerUrl);
      const before = await attributesOf(decodeURIComponent(owner.username));

      await expect(provisionApplicationRole(ownerUrl, ownerUrl)).rejects.toThrow(
        /names "[^"]+", the role migrations run as.*TELFLO_MIGRATION_DATABASE_URL/,
      );
      expect(await attributesOf(decodeURIComponent(owner.username))).toEqual(before);
    });

    it("refuses an existing superuser, and leaves it a superuser", async () => {
      const role = newRoleName();
      await sql.raw(`create role ${pg.escapeIdentifier(role)} login superuser password 'unused'`).execute(ownerDb);

      await expect(provisionApplicationRole(ownerUrl, urlFor(role, "a-password"))).rejects.toThrow(
        /a superuser, which bypasses row-level security/,
      );
      expect((await attributesOf(role))?.rolsuper).toBe(true);
      expect(await applicationMembershipOf(role)).toEqual([]);
    });

    it("refuses a role that is a member of the owner, which bypasses row-level security on the owner's tables", async () => {
      const role = newRoleName();
      const owner = decodeURIComponent(new URL(ownerUrl).username);
      await sql.raw(`create role ${pg.escapeIdentifier(role)} login password 'unused'`).execute(ownerDb);
      await sql.raw(`grant ${pg.escapeIdentifier(owner)} to ${pg.escapeIdentifier(role)}`).execute(ownerDb);

      await expect(provisionApplicationRole(ownerUrl, urlFor(role, "a-password"))).rejects.toThrow(
        /a member of "[^"]+", which owns the tables/,
      );
      expect(await applicationMembershipOf(role)).toEqual([]);
    });

    it("refuses a URL with no password", async () => {
      const role = newRoleName();
      const url = new URL(ownerUrl);
      url.username = role;
      url.password = "";
      await expect(provisionApplicationRole(ownerUrl, url.toString())).rejects.toThrow(
        /must name a user and a password/,
      );
    });

    it("succeeds twice at once, as two test runs provisioning together do", async () => {
      const role = newRoleName();
      const url = urlFor(role, "concurrent-password");

      await expect(
        Promise.all([provisionApplicationRole(ownerUrl, url), provisionApplicationRole(ownerUrl, url)]),
      ).resolves.toEqual([undefined, undefined]);

      expect(await attributesOf(role)).toEqual(LOGIN_ATTRIBUTES);
      expect(await currentUser(url)).toBe(role);
    });

    // D33-1 decision 15: in a cluster the tables' owner holds only LOGIN
    // CREATEROLE. Each test makes such an owner with the suite's superuser,
    // holding ADMIN on telflo_platform_runtime as migration 009's creator does.
    describe("as an owner that isn't a superuser", () => {
      // Dropped in reverse: the application login before the owner that
      // granted its membership.
      const rolesInOrder: string[] = [];

      afterEach(async () => {
        for (const role of rolesInOrder.splice(0).reverse()) {
          await sql`drop role if exists ${sql.id(role)}`.execute(ownerDb);
        }
      });

      function uniqueRoleName(): string {
        const name = `telflo_role_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        rolesInOrder.push(name);
        return name;
      }

      async function createNonSuperuserOwner(): Promise<string> {
        const owner = uniqueRoleName();
        const password = randomUUID();
        await sql
          .raw(`create role ${pg.escapeIdentifier(owner)} login createrole password ${pg.escapeLiteral(password)}`)
          .execute(ownerDb);
        await sql
          .raw(
            `grant ${pg.escapeIdentifier(APPLICATION_ROLE)} to ${pg.escapeIdentifier(owner)} with admin true, inherit false, set false`,
          )
          .execute(ownerDb);
        return urlFor(owner, password);
      }

      /** Whether `url` can log in; the result is a boolean, never the error. */
      async function canConnect(url: string): Promise<boolean> {
        return currentUser(url).then(
          () => true,
          () => false,
        );
      }

      it("provisions a login twice, the second run resetting its password", async () => {
        const nonSuperuserOwnerUrl = await createNonSuperuserOwner();
        expect((await attributesOf(decodeURIComponent(new URL(nonSuperuserOwnerUrl).username)))?.rolsuper).toBe(false);
        const role = uniqueRoleName();
        const firstPassword = randomUUID();
        const secondPassword = randomUUID();

        await provisionApplicationRole(nonSuperuserOwnerUrl, urlFor(role, firstPassword));
        expect(await canConnect(urlFor(role, firstPassword))).toBe(true);

        await provisionApplicationRole(nonSuperuserOwnerUrl, urlFor(role, secondPassword));

        expect(await attributesOf(role)).toEqual(LOGIN_ATTRIBUTES);
        expect(await applicationMembershipOf(role)).toEqual([{ inherit_option: true }]);
        expect(await canConnect(urlFor(role, secondPassword))).toBe(true);
        expect(await canConnect(urlFor(role, firstPassword))).toBe(false);
      });

      it.each([
        ["SUPERUSER", "rolsuper"],
        ["BYPASSRLS", "rolbypassrls"],
        ["CREATEDB", "rolcreatedb"],
        ["REPLICATION", "rolreplication"],
      ] as const)("refuses an existing login holding %s, and leaves it unchanged", async (attribute, column) => {
        const nonSuperuserOwnerUrl = await createNonSuperuserOwner();
        const owner = decodeURIComponent(new URL(nonSuperuserOwnerUrl).username);
        const role = uniqueRoleName();
        const firstPassword = randomUUID();
        await provisionApplicationRole(nonSuperuserOwnerUrl, urlFor(role, firstPassword));
        await sql.raw(`alter role ${pg.escapeIdentifier(role)} ${attribute}`).execute(ownerDb);

        const error = await provisionApplicationRole(nonSuperuserOwnerUrl, urlFor(role, randomUUID())).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          `TELFLO_DATABASE_URL names "${role}", which holds SUPERUSER, BYPASSRLS, CREATEDB or REPLICATION. The API's ` +
            `login role must hold none of them, and only a superuser can remove them ("${owner}" is not one). ` +
            `TELFLO_DATABASE_URL names the API's own login role, and TELFLO_MIGRATION_DATABASE_URL the tables' owner; ` +
            `see .env.example.`,
        );
        const { rows } = await sql<{ held: boolean }>`
          select ${sql.ref(column)} as held from pg_roles where rolname = ${role}
        `.execute(ownerDb);
        expect(rows).toEqual([{ held: true }]);
        expect(await canConnect(urlFor(role, firstPassword))).toBe(true);
      });

      it("refuses an existing login it holds no ADMIN option on, naming no password", async () => {
        const nonSuperuserOwnerUrl = await createNonSuperuserOwner();
        const owner = decodeURIComponent(new URL(nonSuperuserOwnerUrl).username);
        const role = uniqueRoleName();
        // Created by the suite's superuser, so the owner holds no ADMIN on it.
        await sql.raw(`create role ${pg.escapeIdentifier(role)} login password ${pg.escapeLiteral(randomUUID())}`).execute(ownerDb);
        const password = randomUUID();

        const error = await provisionApplicationRole(nonSuperuserOwnerUrl, urlFor(role, password)).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(Error);
        expect([(error as Error).message, (error as Error).stack ?? "", String(error)].some((text) => text.includes(password))).toBe(
          false,
        );
        expect((error as Error).message).toBe(
          `TELFLO_DATABASE_URL names "${role}", which "${owner}" can't reset: "${owner}" didn't create it and holds no ` +
            `ADMIN option on it. A superuser can drop it, so provisioning creates it again. ` +
            `TELFLO_DATABASE_URL names the API's own login role, and TELFLO_MIGRATION_DATABASE_URL the tables' owner; ` +
            `see .env.example.`,
        );
        expect(await applicationMembershipOf(role)).toEqual([]);
        expect(await canConnect(urlFor(role, password))).toBe(false);
      });
    });
  });

  describe("assertApplicationRole", () => {
    it("passes as the application role the tests connect as", async () => {
      await expect(assertApplicationRole(databases.db)).resolves.toBeUndefined();
    });

    it("throws as the owner (a superuser locally), naming both settings", async () => {
      await expect(assertApplicationRole(ownerDb)).rejects.toThrow(
        /Refusing to start: the API's database role "[^"]+" is a superuser.*TELFLO_DATABASE_URL.*TELFLO_MIGRATION_DATABASE_URL/,
      );
    });

    // The owner's check on its own: this role is no superuser and has no
    // BYPASSRLS, but inherits from the tables' owner, which skips RLS on them.
    it("throws for a role that is neither superuser nor BYPASSRLS but inherits from the tables' owner", async () => {
      const role = newRoleName();
      const owner = decodeURIComponent(new URL(ownerUrl).username);
      await provisionApplicationRole(ownerUrl, urlFor(role, "owner-member-password"));
      await sql.raw(`grant ${pg.escapeIdentifier(owner)} to ${pg.escapeIdentifier(role)}`).execute(ownerDb);

      await connectedAs(urlFor(role, "owner-member-password"), async (db) => {
        const error = await assertApplicationRole(db).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/owns application tables, or inherits from their owner/);
        expect((error as Error).message).not.toMatch(/superuser|BYPASSRLS/);
      });
    });

    // The BYPASSRLS check on its own: this role is no superuser, owns
    // nothing, and is an inheriting member of telflo_platform_runtime, so only
    // BYPASSRLS can refuse it.
    it("throws for a role that is not a superuser but has BYPASSRLS", async () => {
      const role = newRoleName();
      try {
        await sql
          .raw(`create role ${pg.escapeIdentifier(role)} login nosuperuser bypassrls password 'bypasses-rls'`)
          .execute(ownerDb);
        await sql
          .raw(`grant ${pg.escapeIdentifier(APPLICATION_ROLE)} to ${pg.escapeIdentifier(role)} with inherit true`)
          .execute(ownerDb);

        await connectedAs(urlFor(role, "bypasses-rls"), async (db) => {
          const error = await assertApplicationRole(db).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            `Refusing to start: the API's database role "${role}" has BYPASSRLS, so row-level security would not ` +
              `constrain it. Set TELFLO_DATABASE_URL to the API's own login role, and TELFLO_MIGRATION_DATABASE_URL ` +
              `to the tables' owner (see .env.example).`,
          );
        });
      } finally {
        await sql`drop role if exists ${sql.id(role)}`.execute(ownerDb);
      }
    });

    it("throws for a role that isn't a member of telflo_platform_runtime", async () => {
      const role = newRoleName();
      await sql.raw(`create role ${pg.escapeIdentifier(role)} login password 'not-a-member'`).execute(ownerDb);
      // Since migration 019 only telflo_platform_runtime's members may connect, so
      // this role gets CONNECT of its own to reach the check under test. A
      // role holding a privilege can't be dropped, so it is revoked before
      // afterEach drops the role.
      const { rows } = await sql<{ name: string }>`select current_database() as name`.execute(ownerDb);
      const database = pg.escapeIdentifier(rows[0]!.name);
      await sql.raw(`grant connect on database ${database} to ${pg.escapeIdentifier(role)}`).execute(ownerDb);
      try {
        await connectedAs(urlFor(role, "not-a-member"), async (db) => {
          await expect(assertApplicationRole(db)).rejects.toThrow(/is not a member of telflo_platform_runtime/);
        });
      } finally {
        await sql.raw(`revoke connect on database ${database} from ${pg.escapeIdentifier(role)}`).execute(ownerDb);
      }
    });
  });

  describe("migrationSettings", () => {
    it("reads both URLs", () => {
      expect(
        migrationSettings({ TELFLO_MIGRATION_DATABASE_URL: "postgresql://owner", TELFLO_DATABASE_URL: "postgresql://api" }),
      ).toEqual({ migrationDatabaseUrl: "postgresql://owner", applicationDatabaseUrl: "postgresql://api" });
    });

    it("fails naming a missing URL and pointing at .env.example", () => {
      expect(() => migrationSettings({ TELFLO_DATABASE_URL: "postgresql://api" })).toThrow(
        /Missing required environment variable TELFLO_MIGRATION_DATABASE_URL\. .*\.env\.example/,
      );
      expect(() => migrationSettings({})).toThrow(/TELFLO_MIGRATION_DATABASE_URL and TELFLO_DATABASE_URL/);
    });
  });
});
