import type { Kysely, Selectable, Transaction } from "kysely";
import type { Database, RefreshTokensTable } from "@telflo/db";

export interface RefreshToken {
  id: string;
  sessionId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface CreateRefreshTokenInput {
  sessionId: string;
  /** sha-256 of the token; the plaintext never reaches the database. */
  tokenHash: string;
  expiresAt: Date;
}

/**
 * The outcome of presenting a refresh token. `consumed` does not mean the
 * token was unexpired: the caller compares `expiresAt` with its own clock.
 * Both carry the session's user, so the caller can set the database context
 * before it reads the session's membership.
 * `already_consumed` carries the session so the caller can revoke it as a
 * reuse (see the refresh_tokens table comment, migration 1700000000004), and
 * when the token was consumed, so the caller can tell a concurrent
 * presentation within the grace window from a reuse. Its `expiresAt` lets
 * the caller refuse an expired token there too: an expired token is consumed
 * by its first presentation and then refused, and must not earn an access
 * token by being presented again.
 */
export type ConsumeResult =
  | { status: "consumed"; sessionId: string; userId: string; expiresAt: Date }
  | { status: "already_consumed"; sessionId: string; userId: string; expiresAt: Date; consumedAt: Date }
  | { status: "not_found" };

/** The single place a refresh_tokens row becomes camelCase. */
function toRefreshToken(row: Selectable<RefreshTokensTable>): RefreshToken {
  return {
    id: row.id,
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export interface IRefreshTokenRepository {
  create(input: CreateRefreshTokenInput): Promise<RefreshToken>;
  consume(tokenHash: string, at: Date): Promise<ConsumeResult>;
}

export function createRefreshTokenRepository(
  db: Kysely<Database> | Transaction<Database>,
): IRefreshTokenRepository {
  return {
    async create(input: CreateRefreshTokenInput): Promise<RefreshToken> {
      const row = await db
        .insertInto("refresh_tokens")
        .values({
          session_id: input.sessionId,
          token_hash: input.tokenHash,
          expires_at: input.expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRefreshToken(row);
    },

    /**
     * One atomic statement: `consumed_at is null` is a predicate of the
     * UPDATE itself, never a prior select, so of two concurrent
     * presentations of one token exactly one sees `consumed`. The other
     * updates nothing, and the lookup that follows reports it as
     * `already_consumed`, with the time the winner consumed it.
     *
     * The follow-up lookup only classifies a statement that already changed
     * nothing; it cannot un-consume or double-consume anything. Inside a
     * transaction it runs after the UPDATE waited out any concurrent
     * consumer's lock, so it reads the committed `consumed_at`.
     *
     * The session's user comes from a join in the same statement. The
     * sessions row is read, not locked: its user never changes.
     */
    async consume(tokenHash: string, at: Date): Promise<ConsumeResult> {
      const consumed = await db
        .updateTable("refresh_tokens")
        .from("sessions")
        .set({ consumed_at: at })
        .whereRef("sessions.id", "=", "refresh_tokens.session_id")
        .where("refresh_tokens.token_hash", "=", tokenHash)
        .where("refresh_tokens.consumed_at", "is", null)
        .returning(["refresh_tokens.session_id", "refresh_tokens.expires_at", "sessions.user_id"])
        .executeTakeFirst();
      if (consumed) {
        return {
          status: "consumed",
          sessionId: consumed.session_id,
          userId: consumed.user_id,
          expiresAt: consumed.expires_at,
        };
      }

      const existing = await db
        .selectFrom("refresh_tokens")
        .innerJoin("sessions", "sessions.id", "refresh_tokens.session_id")
        .select(["refresh_tokens.session_id", "refresh_tokens.expires_at", "refresh_tokens.consumed_at", "sessions.user_id"])
        .where("refresh_tokens.token_hash", "=", tokenHash)
        .executeTakeFirst();
      if (!existing) return { status: "not_found" };
      // The UPDATE matched nothing, so the row was already consumed. A null
      // here would mean it was un-consumed in between, which nothing does.
      if (existing.consumed_at === null) throw new Error("refresh token neither consumable nor consumed");
      return {
        status: "already_consumed",
        sessionId: existing.session_id,
        userId: existing.user_id,
        expiresAt: existing.expires_at,
        consumedAt: existing.consumed_at,
      };
    },
  };
}
