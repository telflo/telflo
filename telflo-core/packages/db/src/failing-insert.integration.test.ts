import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createPool } from "./pool.js";
import type { Database } from "./schema.js";
import { testMigrationDatabaseUrl } from "./test-database.js";
import { dropFailingInsertLeftovers, openTestDatabases, truncateAll, withFailingInsert } from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * withFailingInsert's own guarantees: it refuses to nest, its clean-up cancels
 * only an insert its trigger left waiting (never a session that merely reads
 * the table) and gives up within vitest's 5 s test timeout naming what holds
 * the table, after one attempt when it cancelled nothing, keeping a failed
 * body's error as the cause; and a killed run's leftovers are dropped by the
 * global setup's dropFailingInsertLeftovers, which refuses a database not made
 * for tests.
 */
describe("withFailingInsert", () => {
  let databases: TestDatabases;
  let ownerDb: Kysely<Database>;
  const RAISE = "raise exception 'failing insert under test'";
  const NAME = "test_fail_organizations_insert";
  const LOCK = 4_216_024;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  // A failing test here may leave a trigger behind; the next test mustn't inherit it.
  afterEach(async () => {
    await dropFailingInsertLeftovers(process.env.TELFLO_MIGRATION_DATABASE_URL!);
  });

  const leftovers = async () =>
    (
      await sql<{ name: string }>`
        select t.tgname as name from pg_trigger t where t.tgname like 'test\\_fail\\_%'
        union all
        select p.proname from pg_proc p where p.proname like 'test\\_fail\\_%'
      `.execute(ownerDb)
    ).rows.map((row) => row.name);

  const insertOrganization = (db: Kysely<Database>) =>
    sql`insert into organizations (name, type) values ('failing-insert', 'group')`.execute(db);

  /** Polls pg_stat_activity until a session matches, a bounded number of times. */
  const waitUntil = async (condition: string) => {
    for (let poll = 0; poll < 500; poll++) {
      const { rows } = await sql<{ count: string }>`
        select count(*)::text as count from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and ${sql.raw(condition)}
      `.execute(ownerDb);
      if (Number(rows[0]?.count) > 0) return;
    }
    throw new Error(`no session matched: ${condition}`);
  };

  /**
   * The owner's database on a pool of its own, counting the statements that
   * drop the trigger: one per attempt of withFailingInsert's clean-up (an
   * operation count; Postgres's own counters, pg_stat_database's
   * xact_rollback, are flushed lazily per backend and database-wide, so they
   * can't pin one attempt).
   */
  const countingDrops = () => {
    let drops = 0;
    const db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: createPool(testMigrationDatabaseUrl({ TELFLO_TEST_MIGRATION_DATABASE_URL: process.env.TELFLO_MIGRATION_DATABASE_URL })),
      }),
      log: (event) => {
        if (event.query.sql.startsWith(`drop trigger if exists ${NAME} `)) drops += 1;
      },
    });
    return { db, drops: () => drops };
  };

  /** A reader holding AccessShareLock on organizations, then waiting on LOCK: not the trigger's insert. */
  const readThenWait = () =>
    ownerDb
      .connection()
      .execute((connection) =>
        connection.transaction().execute(async (transaction) => {
          await sql`select count(*) from organizations`.execute(transaction);
          await sql`select pg_advisory_xact_lock(${LOCK})`.execute(transaction);
          return "read";
        }),
      )
      .catch((error: { code?: string }) => error.code);

  /** Holds the advisory lock LOCK on its own connection until `release` is called. */
  const holdLock = async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = ownerDb.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(${LOCK})`.execute(connection);
      try {
        locked();
        await released;
      } finally {
        await sql`select pg_advisory_unlock(${LOCK})`.execute(connection);
      }
    });
    await Promise.race([isLocked, holder.then(() => Promise.reject(new Error("the holder ended before locking")))]);
    return {
      release: async () => {
        release();
        await holder;
      },
    };
  };

  it("makes every insert fail while its body runs, and drops its trigger and function afterwards", async () => {
    await withFailingInsert(ownerDb, "organizations", RAISE, async () => {
      await expect(insertOrganization(ownerDb)).rejects.toThrow("failing insert under test");
      expect((await leftovers()).sort()).toEqual([NAME, NAME]);
    });
    expect(await leftovers()).toEqual([]);
    await insertOrganization(ownerDb);
  });

  it("refuses a nested call on the same table loudly, leaving the outer one's trigger working", async () => {
    await withFailingInsert(ownerDb, "organizations", RAISE, async () => {
      await expect(
        withFailingInsert(ownerDb, "organizations", "return new", async () => {
          throw new Error("the nested body must not run");
        }),
      ).rejects.toThrow(`withFailingInsert on organizations: ${NAME} already exists. withFailingInsert doesn't nest`);
      // The outer trigger is still its own, not replaced by the nested one's.
      await expect(insertOrganization(ownerDb)).rejects.toThrow("failing insert under test");
    });
    expect(await leftovers()).toEqual([]);
  });

  it("refuses a killed run's leftover, which dropFailingInsertLeftovers (the global setup's) drops", async () => {
    await sql
      .raw(`create function ${NAME}() returns trigger language plpgsql as $$ begin return new; end $$`)
      .execute(ownerDb);
    await sql.raw(`create trigger ${NAME} before insert on organizations for each row execute function ${NAME}()`).execute(ownerDb);
    await sql.raw(`create function test_fail_flows_insert() returns trigger language plpgsql as $$ begin return new; end $$`).execute(ownerDb);
    try {
      await expect(withFailingInsert(ownerDb, "organizations", RAISE, async () => {})).rejects.toThrow("already exists");
      // A function alone, its trigger gone, is refused too.
      await expect(withFailingInsert(ownerDb, "flows", RAISE, async () => {})).rejects.toThrow("already exists");
    } finally {
      await dropFailingInsertLeftovers(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    }
    expect(await leftovers()).toEqual([]);
    await withFailingInsert(ownerDb, "organizations", RAISE, async () => {
      await expect(insertOrganization(ownerDb)).rejects.toThrow("failing insert under test");
    });
  });

  it("cancels an insert its trigger left waiting on an advisory lock, then drops the trigger", async () => {
    const lock = await holdLock();
    let inserting: Promise<unknown> | undefined;
    try {
      await withFailingInsert(
        ownerDb,
        "organizations",
        `set local lock_timeout = '20s'; perform pg_advisory_xact_lock(${LOCK}); return new`,
        async () => {
          inserting = insertOrganization(ownerDb).then(
            () => "inserted",
            (error: { code?: string }) => error.code,
          );
          await waitUntil("wait_event_type = 'Lock' and wait_event = 'advisory'");
          // The body ends with the insert still waiting in the trigger.
        },
      );
      // 57014 query_canceled: the clean-up cancelled it; its transaction rolled back.
      expect(await inserting).toBe("57014");
      expect(await leftovers()).toEqual([]);
    } finally {
      await lock.release();
      await inserting;
    }
    const { rows } = await sql<{ count: string }>`select count(*)::text as count from organizations`.execute(ownerDb);
    expect(rows[0]?.count).toBe("0");
  });

  it("never cancels a session that only reads the table: the drop gives up after one attempt, within the test's timeout, naming it", async () => {
    const lock = await holdLock();
    const counting = countingDrops();
    let reading: Promise<unknown> | undefined;
    try {
      await expect(
        withFailingInsert(counting.db, "organizations", RAISE, async () => {
          reading = readThenWait();
          await waitUntil("wait_event_type = 'Lock' and wait_event = 'advisory'");
        }),
      ).rejects.toThrow(/test DDL gave up after lock_timeout 1s.*Holders: .*"relation":"organizations","mode":"AccessShareLock"/);
      // One attempt, nothing having been cancelled: the diagnostic comes within vitest's 5 s test timeout, this test's own.
      expect(counting.drops()).toBe(1);
    } finally {
      await lock.release();
      await counting.db.destroy();
    }
    // The reader was left alone: it read, then took the lock once it was free.
    expect(await reading).toBe("read");
    // Its trigger is left behind, as a killed run's would be: the global setup's drop removes it.
    expect((await leftovers()).sort()).toEqual([NAME, NAME]);
    await dropFailingInsertLeftovers(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    expect(await leftovers()).toEqual([]);
  });

  it("keeps a failed body's error as the cause when the clean-up fails too", async () => {
    const lock = await holdLock();
    const bodyError = new Error("the body's own failure");
    let reading: Promise<unknown> | undefined;
    let thrown: unknown;
    try {
      thrown = await withFailingInsert(ownerDb, "organizations", RAISE, async () => {
        reading = readThenWait();
        await waitUntil("wait_event_type = 'Lock' and wait_event = 'advisory'");
        throw bodyError;
      }).catch((error: unknown) => error);
    } finally {
      await lock.release();
    }
    expect(await reading).toBe("read");
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toMatch(
      /^test DDL gave up after lock_timeout 1s.*Holders: .*\(withFailingInsert's body had failed first: its error is this one's cause; errors holds the clean-up's, then the body's\)$/s,
    );
    expect(aggregate.cause).toBe(bodyError);
    // The clean-up's own error is kept whole, its own cause (the lock timeout's) with it.
    expect(aggregate.errors).toHaveLength(2);
    const [dropError, body] = aggregate.errors as [Error, unknown];
    expect(dropError.message).toMatch(/^test DDL gave up after lock_timeout 1s/);
    expect((dropError.cause as { code?: string } | undefined)?.code).toBe("55P03");
    expect(body).toBe(bodyError);
    await dropFailingInsertLeftovers(process.env.TELFLO_MIGRATION_DATABASE_URL!);
  });

  it("throws the body's own error when the clean-up succeeds", async () => {
    const bodyError = new Error("the body's own failure");
    await expect(
      withFailingInsert(ownerDb, "organizations", RAISE, async () => {
        throw bodyError;
      }),
    ).rejects.toBe(bodyError);
    expect(await leftovers()).toEqual([]);
  });
});

describe("dropFailingInsertLeftovers", () => {
  it("refuses a database whose name doesn't end in _test, touching nothing", async () => {
    // A name no database has, so even a guard that failed would reach nothing real.
    const name = `not_a_test_db_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    url.pathname = `/${name}`;
    await expect(dropFailingInsertLeftovers(url.toString())).rejects.toThrow(
      `Refusing to run tests against database "${name}" (from TELFLO_TEST_MIGRATION_DATABASE_URL)`,
    );
  });
});
