import type { Kysely, Transaction } from "kysely";
import type { Database } from "@telflo/db";

export interface VerificationToken {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface CreateVerificationTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface IVerificationTokenRepository {
  create(input: CreateVerificationTokenInput): Promise<void>;
  findByHash(tokenHash: string): Promise<VerificationToken | undefined>;
  consume(id: string): Promise<boolean>;
  consumeAllForUser(userId: string, at: Date): Promise<number>;
}

export function createVerificationTokenRepository(
  db: Kysely<Database> | Transaction<Database>,
): IVerificationTokenRepository {
  return {
    async create(input: CreateVerificationTokenInput): Promise<void> {
      await db
        .insertInto("email_verification_tokens")
        .values({
          user_id: input.userId,
          token_hash: input.tokenHash,
          expires_at: input.expiresAt,
        })
        .execute();
    },

    /**
     * Unfiltered lookup by hash: returns the row regardless of whether it is
     * consumed or expired. The service branches on `consumedAt`/`expiresAt`
     * itself, so a consumed or expired token must come back distinguishable
     * from a hash that was never issued at all — a filtered lookup would make
     * "already verified" indistinguishable from "invalid token".
     */
    async findByHash(tokenHash: string): Promise<VerificationToken | undefined> {
      const row = await db
        .selectFrom("email_verification_tokens")
        .selectAll()
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();

      return row
        ? { id: row.id, userId: row.user_id, expiresAt: row.expires_at, consumedAt: row.consumed_at }
        : undefined;
    },

    /**
     * Atomic single-use consumption. The `consumed_at is null` predicate lives
     * in the UPDATE rather than in a preceding SELECT, so two concurrent
     * requests cannot both succeed — exactly one updates a row and gets true.
     * Returns false if the token was already consumed.
     */
    async consume(id: string): Promise<boolean> {
      const result = await db
        .updateTable("email_verification_tokens")
        .set({ consumed_at: new Date() })
        .where("id", "=", id)
        .where("consumed_at", "is", null)
        .executeTakeFirst();

      return Number(result.numUpdatedRows) === 1;
    },

    /**
     * Consumes every unconsumed token of the user, so no link already sent
     * can verify the email again: a federated sign-in that takes over an
     * unverified account (D2c Ruling 9) leaves nothing behind that could
     * rewrite `email_verified_at`. Returns how many it consumed.
     */
    async consumeAllForUser(userId: string, at: Date): Promise<number> {
      const result = await db
        .updateTable("email_verification_tokens")
        .set({ consumed_at: at })
        .where("user_id", "=", userId)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
