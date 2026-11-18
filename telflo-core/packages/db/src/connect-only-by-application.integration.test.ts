import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { runner } from "node-pg-migrate";
import pg from "pg";
import { createDb, createPool } from "./pool.js";
import type { Database } from "./schema.js";
import { openTestDatabases } from "./testing.js";
import type { TestDatabases } from "./testing.js";
import { THROWAWAY_DATABASE_DROP_TIMEOUT } from "./test-database.js";
import { PLATFORM_CONNECTION_OPTIONS, PLATFORM_MIGRATION_OPTIONS } from "./database-schema.js";

// Migration 019 (ADR 0026): only telflo_platform_runtime's members may connect to
// the platform's database. Roles belong to the whole server, so each role
// made here has a name of its own and is dropped afterwards.

describe("migration 019: CONNECT only for telflo_platform_runtime", () => {
  let databases: TestDatabases;
  let ownerDb: Kysely<Database>;
  const createdRoles: string[] = [];

  beforeAll(() => {
    databases = openTestDatabases();
    ownerDb = databases.ownerDb;
  });

  afterEach(async () => {
    for (const role of createdRoles.splice(0)) {
      await sql`drop role if exists ${sql.id(role)}`.execute(ownerDb);
    }
  });

  afterAll(async () => {
    await databases.destroy();
  });

  /** A login role with no membership at all, dropped after the test. */
  async function createOutsider(): Promise<{ role: string; password: string }> {
    const role = `telflo_connect_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const password = `outsider-${randomUUID()}`;
    createdRoles.push(role);
    await sql.raw(`create role ${pg.escapeIdentifier(role)} login password ${pg.escapeLiteral(password)}`).execute(ownerDb);
    return { role, password };
  }

  /** `base` with its user, password and database replaced. */
  function urlAs(base: string, user: string, password: string, database?: string): string {
    const url = new URL(base);
    url.username = user;
    url.password = password;
    if (database !== undefined) url.pathname = `/${database}`;
    return url.toString();
  }

  /** Connects as `url` and returns current_user, closing the connection. */
  async function currentUserAt(url: string): Promise<string> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string }>("select current_user as name");
      return rows[0]!.name;
    } finally {
      await client.end();
    }
  }

  /**
   * Returns a function that resolves once every client `pool` opened has
   * finished closing. pg-pool's end() (Kysely's destroy()) resolves as soon
   * as it has asked its idle clients to end, before their sockets close; a
   * client emits "remove" on the pool only once its own end() is done.
   */
  function everyClientClosed(pool: pg.Pool): () => Promise<void> {
    const open = new Set<pg.PoolClient>();
    let settle: (() => void) | undefined;
    pool.on("connect", (client) => open.add(client));
    pool.on("remove", (client) => {
      open.delete(client);
      if (open.size === 0) settle?.();
    });
    return () => (open.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => (settle = resolve)));
  }

  async function publicMayConnect(db: Kysely<Database>): Promise<boolean> {
    const { rows } = await sql<{ allowed: boolean }>`
      select has_database_privilege('public', current_database(), 'CONNECT') as allowed
    `.execute(db);
    return rows[0]!.allowed;
  }

  it("refuses a login role with no membership a connection to the test database", async () => {
    const { role, password } = await createOutsider();

    await expect(currentUserAt(urlAs(process.env.TELFLO_MIGRATION_DATABASE_URL!, role, password))).rejects.toThrow(
      /permission denied for database/,
    );
    expect(await publicMayConnect(ownerDb)).toBe(false);
  });

  it("lets telflo_platform, a member of telflo_platform_runtime, connect", async () => {
    const apiUrl = new URL(process.env.TELFLO_DATABASE_URL!);
    expect(await currentUserAt(apiUrl.toString())).toBe(decodeURIComponent(apiUrl.username));
    const { rows } = await sql<{ allowed: boolean }>`
      select has_database_privilege('telflo_platform_runtime', current_database(), 'CONNECT') as allowed
    `.execute(ownerDb);
    expect(rows[0]!.allowed).toBe(true);
  });

  // down is shown on a database of its own: the shared test database stays
  // at the newest migration for every other test file.
  it(
    "down gives PUBLIC its CONNECT back, and up takes it away again",
    async () => {
      const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
      const ownerUrl = process.env.TELFLO_MIGRATION_DATABASE_URL!;
      const name = `telflo_connect_${randomUUID().replaceAll("-", "")}_test`;
      const throwawayUrl = new URL(ownerUrl);
      throwawayUrl.pathname = `/${name}`;

      // One client per run, ended by us: given a URL, node-pg-migrate's
      // close() doesn't await client.end() (see schema.integration.test.ts).
      const run = async (direction: "up" | "down", count?: number) => {
        const client = new pg.Client({ connectionString: throwawayUrl.toString(), options: PLATFORM_CONNECTION_OPTIONS });
        await client.connect();
        try {
          await runner({
            dbClient: client,
            dir: migrationsDirectory,
            direction,
            ...(count === undefined ? {} : { count }),
            ...PLATFORM_MIGRATION_OPTIONS,
            log: () => {},
          });
        } finally {
          await client.end();
        }
      };

      await sql`create database ${sql.id(name)}`.execute(ownerDb);
      const throwawayPool = createPool(throwawayUrl.toString());
      const closed = everyClientClosed(throwawayPool);
      const throwaway = createDb(throwawayPool);
      try {
        const { role, password } = await createOutsider();
        const outsiderUrl = urlAs(ownerUrl, role, password, name);

        // Through 1700000000019_connect_only_by_application, so the down
        // below is 019's whatever comes after it.
        await run("up", 20);
        expect(await publicMayConnect(throwaway)).toBe(false);
        await expect(currentUserAt(outsiderUrl)).rejects.toThrow(/permission denied for database/);

        await run("down", 1);
        expect(await publicMayConnect(throwaway)).toBe(true);
        expect(await currentUserAt(outsiderUrl)).toBe(role);
        const { rows } = await sql<{ grantees: string[] }>`
          select coalesce(array_agg(a.grantee::regrole::text) filter (where a.grantee <> 0), '{}') as grantees
            from pg_database d, aclexplode(d.datacl) a
           where d.datname = current_database() and a.privilege_type = 'CONNECT'
        `.execute(throwaway);
        expect(rows[0]!.grantees).not.toContain("telflo_platform_runtime");

        await run("up", 1);
        expect(await publicMayConnect(throwaway)).toBe(false);
        await expect(currentUserAt(outsiderUrl)).rejects.toThrow(/permission denied for database/);
      } finally {
        await throwaway.destroy();
        // The drop is forced, so it would terminate a connection still
        // closing (57P01, on a client nothing listens to any more).
        await closed();
        await sql`drop database if exists ${sql.id(name)} with (force)`.execute(ownerDb);
      }
    },
    // create and drop database wait for a checkpoint (D7 Ruling 15, D31-1 Ruling 316).
    THROWAWAY_DATABASE_DROP_TIMEOUT,
  );
});
