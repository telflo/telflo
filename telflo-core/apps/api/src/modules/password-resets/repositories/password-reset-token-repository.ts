import type { Kysely, Transaction } from "kysely";
import type { Database } from "@telflo/db";

export interface CreatePasswordResetTokenInput {
  userId: string;
  /** sha-256 of the token; the plaintext is emailed and never stored. */
  tokenHash: string;
  expiresAt: Date;
}

/**
 * The outcome of presenting a reset token. `consumed` does not mean the
 * token was unexpired: the caller compares `expiresAt` with its own clock, so
 * an expired token is consumed by its first presentation and refused. A
 * consumed token, whether used or superseded, is `already_consumed`.
 */
export type PasswordResetConsumeResult =
  | { status: "consumed"; userId: string; expiresAt: Date }
  | { status: "already_consumed"; userId: string }
  | { status: "not_found" };

export interface IPasswordResetTokenRepository {
  create(input: CreatePasswordResetTokenInput): Promise<void>;
  findUserIdByHash(tokenHash: string): Promise<string | undefined>;
  consume(tokenHash: string, at: Date): Promise<PasswordResetConsumeResult>;
  consumeAllForUser(userId: string, at: Date): Promise<number>;
}

export function createPasswordResetTokenRepository(
  db: Kysely<Database> | Transaction<Database>,
): IPasswordResetTokenRepository {
  return {
    async create(input: CreatePasswordResetTokenInput): Promise<void> {
      await db
        .insertInto("password_reset_tokens")
        .values({
          user_id: input.userId,
          token_hash: input.tokenHash,
          expires_at: input.expiresAt,
        })
        .execute();
    },

    /**
     * The user a token was issued to, consumed or not; `undefined` for an
     * unknown hash. A plain read that locks nothing, so a completion can lock
     * the user's row before it touches the token's. It decides nothing about
     * the token: `consume` does.
     */
    async findUserIdByHash(tokenHash: string): Promise<string | undefined> {
      const row = await db
        .selectFrom("password_reset_tokens")
        .select("user_id")
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      return row?.user_id;
    },

    /**
     * One atomic statement, as for refresh tokens: `consumed_at is null` is
     * a predicate of the UPDATE itself, never a prior select, so of two
     * concurrent presentations of one token exactly one sees `consumed`. The
     * other updates nothing, and the lookup that follows reports it as
     * `already_consumed`.
     *
     * The follow-up lookup only classifies a statement that already changed
     * nothing; it cannot un-consume or double-consume anything.
     */
    async consume(tokenHash: string, at: Date): Promise<PasswordResetConsumeResult> {
      const consumed = await db
        .updateTable("password_reset_tokens")
        .set({ consumed_at: at })
        .where("token_hash", "=", tokenHash)
        .where("consumed_at", "is", null)
        .returning(["user_id", "expires_at"])
        .executeTakeFirst();
      if (consumed) {
        return { status: "consumed", userId: consumed.user_id, expiresAt: consumed.expires_at };
      }

      const existing = await db
        .selectFrom("password_reset_tokens")
        .select(["user_id", "consumed_at"])
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      if (!existing) return { status: "not_found" };
      // The UPDATE matched nothing, so the row was already consumed. A null
      // here would mean it was un-consumed in between, which nothing does.
      if (existing.consumed_at === null) throw new Error("reset token neither consumable nor consumed");
      return { status: "already_consumed", userId: existing.user_id };
    },

    /**
     * Consumes every unconsumed token of the user: before a new one is
     * issued, so only the newest link works, and after a completed reset.
     * Returns how many it consumed.
     */
    async consumeAllForUser(userId: string, at: Date): Promise<number> {
      const result = await db
        .updateTable("password_reset_tokens")
        .set({ consumed_at: at })
        .where("user_id", "=", userId)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
