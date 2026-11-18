import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { createDb, createPool, type Database } from "@telflo/db";
import { createUserWithOrganization, truncateAll } from "@telflo/db/testing";
import {
  createPasswordResetTokenRepository,
  type IPasswordResetTokenRepository,
} from "./password-reset-token-repository.js";

describe("password reset token repository", () => {
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The repositories' connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let resetTokens: IPasswordResetTokenRepository;

  beforeAll(() => {
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(process.env.TELFLO_DATABASE_URL!));
    resetTokens = createPasswordResetTokenRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  const future = () => new Date(Date.now() + 3_600_000);

  const consumedAtOf = async (tokenHash: string) =>
    (
      await ownerDb
        .selectFrom("password_reset_tokens")
        .select("consumed_at")
        .where("token_hash", "=", tokenHash)
        .executeTakeFirstOrThrow()
    ).consumed_at;

  /**
   * Resolves once `count` backends other than `lockerPid` are waiting on a
   * lock while running a statement against password_reset_tokens; throws
   * after five seconds rather than hanging the suite.
   */
  const waitForBlockedBackends = async (lockerPid: number, count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await sql<{ blocked: number }>`
        select count(*)::int as blocked
        from pg_stat_activity
        where datname = current_database()
          and pid <> ${lockerPid}
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%password_reset_tokens%'
      `.execute(ownerDb);
      if ((rows[0]?.blocked ?? 0) >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} backends blocked on password_reset_tokens`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("consumes a token once with its user and expiry, then reports already_consumed with its user", async () => {
    const { user } = await createUserWithOrganization(ownerDb);
    const expiresAt = future();
    await resetTokens.create({ userId: user.id, tokenHash: "hash-once", expiresAt });
    const at = new Date("2030-01-02T03:04:05.678Z");

    expect(await resetTokens.consume("hash-once", at)).toEqual({
      status: "consumed",
      userId: user.id,
      expiresAt,
    });
    expect(await consumedAtOf("hash-once")).toEqual(at);
    expect(await resetTokens.consume("hash-once", new Date())).toEqual({
      status: "already_consumed",
      userId: user.id,
    });
    // The second presentation leaves the first one's time in place.
    expect(await consumedAtOf("hash-once")).toEqual(at);
  });

  it("consumes an expired token, leaving the expiry check to the caller", async () => {
    const { user } = await createUserWithOrganization(ownerDb);
    const expiresAt = new Date(Date.now() - 1_000);
    await resetTokens.create({ userId: user.id, tokenHash: "hash-expired", expiresAt });
    expect(await resetTokens.consume("hash-expired", new Date())).toEqual({
      status: "consumed",
      userId: user.id,
      expiresAt,
    });
  });

  it("findUserIdByHash finds a token's user whether or not it is consumed, and nothing for an unknown hash", async () => {
    const { user } = await createUserWithOrganization(ownerDb);
    const { user: other } = await createUserWithOrganization(ownerDb);
    await resetTokens.create({ userId: user.id, tokenHash: "hash-find", expiresAt: future() });
    await resetTokens.create({ userId: other.id, tokenHash: "hash-other", expiresAt: future() });

    expect(await resetTokens.findUserIdByHash("hash-find")).toBe(user.id);
    expect(await resetTokens.findUserIdByHash("hash-other")).toBe(other.id);
    expect(await resetTokens.findUserIdByHash("never-issued")).toBeUndefined();

    // It reads; it does not consume.
    expect(await consumedAtOf("hash-find")).toBeNull();
    await resetTokens.consume("hash-find", new Date());
    expect(await resetTokens.findUserIdByHash("hash-find")).toBe(user.id);
  });

  it("findUserIdByHash does not wait on a token row another transaction holds (D3 Ruling 17)", async () => {
    // A completion reads the token's user before it locks anything, so the
    // read must not queue behind a transaction that holds the token's row.
    const { user } = await createUserWithOrganization(ownerDb);
    await resetTokens.create({ userId: user.id, tokenHash: "hash-held", expiresAt: future() });

    const locker = await pool.connect();
    try {
      await locker.query("begin");
      await locker.query("update password_reset_tokens set consumed_at = now() where token_hash = $1", ["hash-held"]);

      expect(await resetTokens.findUserIdByHash("hash-held")).toBe(user.id);
    } finally {
      await locker.query("rollback");
      locker.release();
    }
  });

  it("reports not_found for an unknown hash", async () => {
    expect(await resetTokens.consume("never-issued", new Date())).toEqual({ status: "not_found" });
  });

  it("of two concurrent consumes of one token, exactly one consumes and the other sees already_consumed", async () => {
    // Forces the overlap rather than hoping for it (D2a Ruling 6). A
    // separate connection holds the token's row lock while both consumes
    // start, and is released only once both are blocked at the database.
    // An implementation that reads first and updates after, or whose UPDATE
    // lacks `consumed_at is null`, sees two `consumed`.
    const { user } = await createUserWithOrganization(ownerDb);
    await resetTokens.create({ userId: user.id, tokenHash: "hash-race", expiresAt: future() });

    const locker = await pool.connect();
    let lockerInTransaction = false;
    try {
      await locker.query("begin");
      lockerInTransaction = true;
      await locker.query("select id from password_reset_tokens where token_hash = $1 for update", ["hash-race"]);
      const lockerPid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      const racing = Promise.all([
        resetTokens.consume("hash-race", new Date()),
        resetTokens.consume("hash-race", new Date()),
      ]);
      // Keeps an early rejection from going unhandled while we wait.
      racing.catch(() => undefined);

      await waitForBlockedBackends(lockerPid, 2);

      await locker.query("rollback");
      lockerInTransaction = false;

      const results = await racing;
      expect(results.map((result) => result.status).sort()).toEqual(["already_consumed", "consumed"]);
    } finally {
      if (lockerInTransaction) await locker.query("rollback");
      locker.release();
    }
  });

  it("consumeAllForUser consumes only that user's unconsumed token and reports how many", async () => {
    // A user has at most one unconsumed token
    // (uq_password_reset_tokens_one_live_per_user), so the count is 0 or 1.
    const { user } = await createUserWithOrganization(ownerDb);
    const { user: other } = await createUserWithOrganization(ownerDb);
    const earlier = new Date("2030-01-01T00:00:00.000Z");
    await resetTokens.create({ userId: user.id, tokenHash: "mine-used", expiresAt: future() });
    await resetTokens.consume("mine-used", earlier);
    await resetTokens.create({ userId: user.id, tokenHash: "mine-live", expiresAt: future() });
    await resetTokens.create({ userId: other.id, tokenHash: "theirs", expiresAt: future() });
    const at = new Date("2030-01-02T03:04:05.000Z");

    expect(await resetTokens.consumeAllForUser(user.id, at)).toBe(1);

    expect(await consumedAtOf("mine-live")).toEqual(at);
    // An already-consumed token keeps the time it was consumed.
    expect(await consumedAtOf("mine-used")).toEqual(earlier);
    expect(await consumedAtOf("theirs")).toBeNull();
    expect(await resetTokens.consume("theirs", at)).toMatchObject({ status: "consumed", userId: other.id });
  });

  it("consumeAllForUser reports 0 for a user with no unconsumed tokens", async () => {
    const { user } = await createUserWithOrganization(ownerDb);
    expect(await resetTokens.consumeAllForUser(user.id, new Date())).toBe(0);
  });
});
