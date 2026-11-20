import { sql, type Transaction } from "kysely";
import type { ApiTokenAccess, Database } from "@telflo/db";

/*
 * A person's own API tokens (migration 1700000000038's personal_api_tokens).
 * Row-level security shows the context's user their own rows only, whatever
 * organization the context names, so the transaction must carry a database
 * context naming the person (`{ userId, organizationId }`, the organization's
 * null or the session's, it doesn't matter to these rows). Every query here
 * filters by the person too, as the first condition: the policies are the
 * backstop, not the only guard.
 *
 * The token is never here, and its hash enters only through `create` and
 * leaves no method. The prefix and the name are the person's to see in the
 * masked list only, never logged.
 *
 * The browser's routes (personal-api-tokens.ts) and the token check (the
 * public surface's "Last used" and /whoami's name, in `{ userId,
 * organizationId: null }`) share it.
 */

/** "Last used" is written at most once a minute per token. */
const LAST_USED_INTERVAL_MS = 60_000;

/** Postgres error code for a unique-constraint (or unique-index) violation. */
const UNIQUE_VIOLATION = "23505";

/** A name is unique, case aside, among a person's tokens not revoked (migration 1700000000038). */
const NAME_UNIQUE_INDEX = "uq_personal_api_tokens_user_id_lower_name";

/** True only for a violation of the name index: any other unique index (the hash's) is a bug, and surfaces as one. */
function isNameViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === NAME_UNIQUE_INDEX
  );
}

/** Thrown by `create` when a token of the person's not yet revoked has the name. Its message names no name. */
export class PersonalApiTokenNameTakenError extends Error {
  constructor() {
    super("a token of the person's not yet revoked already has that name");
    this.name = "PersonalApiTokenNameTakenError";
  }
}

/** A person's token not revoked: live, or expired (by the caller's clock) and still listed. */
export interface PersonalApiToken {
  id: string;
  name: string;
  /** Its first 11 characters (tf_ and 8). */
  prefix: string;
  access: ApiTokenAccess;
  /** Null: never expires. */
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface CreatePersonalApiTokenInput {
  userId: string;
  name: string;
  /** sha-256 (hex) of the token; the token itself never reaches the repository. */
  tokenHash: string;
  /** Its first 11 characters. */
  tokenPrefix: string;
  access: ApiTokenAccess;
  /** Null: never expires. */
  expiresAt: Date | null;
  /** The clock's time: its creation. */
  at: Date;
}

export interface IPersonalApiTokenRepository {
  /** The person's tokens not revoked, expired ones included, newest first. */
  list(userId: string): Promise<PersonalApiToken[]>;
  /**
   * How many of the person's tokens are live at `at`: neither revoked nor
   * expired (the limit's count). An expired token doesn't count, though it
   * keeps its name until revoked.
   */
  countLive(userId: string, at: Date): Promise<number>;
  /** Whether a token of the person's not yet revoked, expired ones included, has the name, case aside. */
  isNameTaken(userId: string, name: string): Promise<boolean>;
  /** Inserts the token's row. Throws PersonalApiTokenNameTakenError for a name taken. */
  create(input: CreatePersonalApiTokenInput): Promise<PersonalApiToken>;
  /** Revokes the person's token once, at `at`, in one conditional update. False when they have no such token not yet revoked. */
  revoke(userId: string, id: string, at: Date): Promise<boolean>;
  /**
   * "Last used": sets the token's last_used_at to `at`, unless it was set
   * less than a minute before `at` or the token is revoked, in one
   * conditional update. True when it wrote.
   */
  touchLastUsed(userId: string, id: string, at: Date): Promise<boolean>;
  /** The name of the person's token with this id, not revoked, or undefined (/whoami's read). */
  findName(userId: string, id: string): Promise<string | undefined>;
}

/** Bound to a transaction that carries a database context naming the person. */
export function createPersonalApiTokenRepository(transaction: Transaction<Database>): IPersonalApiTokenRepository {
  /** A person's tokens not revoked; never the hash. */
  const listed = (userId: string) =>
    transaction
      .selectFrom("personal_api_tokens")
      .select([
        "personal_api_tokens.id as id",
        "personal_api_tokens.name as name",
        "personal_api_tokens.token_prefix as prefix",
        "personal_api_tokens.access as access",
        "personal_api_tokens.expires_at as expiresAt",
        "personal_api_tokens.last_used_at as lastUsedAt",
        "personal_api_tokens.created_at as createdAt",
      ])
      .where("personal_api_tokens.user_id", "=", userId)
      .where("personal_api_tokens.revoked_at", "is", null);

  return {
    async list(userId) {
      return listed(userId)
        .orderBy("personal_api_tokens.created_at", "desc")
        .orderBy("personal_api_tokens.id", "desc")
        .execute();
    },

    async countLive(userId, at) {
      const row = await transaction
        .selectFrom("personal_api_tokens")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("personal_api_tokens.user_id", "=", userId)
        .where("personal_api_tokens.revoked_at", "is", null)
        .where((eb) => eb.or([eb("personal_api_tokens.expires_at", "is", null), eb("personal_api_tokens.expires_at", ">", at)]))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async isNameTaken(userId, name) {
      const row = await transaction
        .selectFrom("personal_api_tokens")
        .select("personal_api_tokens.id")
        .where("personal_api_tokens.user_id", "=", userId)
        .where("personal_api_tokens.revoked_at", "is", null)
        .where(sql<string>`lower(${sql.ref("personal_api_tokens.name")})`, "=", sql<string>`lower(${name})`)
        .executeTakeFirst();
      return row !== undefined;
    },

    async create(input) {
      let id: string;
      try {
        ({ id } = await transaction
          .insertInto("personal_api_tokens")
          .values({
            user_id: input.userId,
            name: input.name,
            token_hash: input.tokenHash,
            token_prefix: input.tokenPrefix,
            access: input.access,
            expires_at: input.expiresAt,
            created_at: input.at,
          })
          .returning("personal_api_tokens.id")
          .executeTakeFirstOrThrow());
      } catch (error) {
        if (isNameViolation(error)) throw new PersonalApiTokenNameTakenError();
        throw error;
      }
      return listed(input.userId).where("personal_api_tokens.id", "=", id).executeTakeFirstOrThrow();
    },

    async revoke(userId, id, at) {
      const result = await transaction
        .updateTable("personal_api_tokens")
        .set({ revoked_at: at })
        .where("personal_api_tokens.user_id", "=", userId)
        .where("personal_api_tokens.id", "=", id)
        .where("personal_api_tokens.revoked_at", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async touchLastUsed(userId, id, at) {
      const result = await transaction
        .updateTable("personal_api_tokens")
        .set({ last_used_at: at })
        .where("personal_api_tokens.user_id", "=", userId)
        .where("personal_api_tokens.id", "=", id)
        .where("personal_api_tokens.revoked_at", "is", null)
        .where((eb) =>
          eb.or([
            eb("personal_api_tokens.last_used_at", "is", null),
            eb("personal_api_tokens.last_used_at", "<=", new Date(at.getTime() - LAST_USED_INTERVAL_MS)),
          ]),
        )
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async findName(userId, id) {
      const row = await transaction
        .selectFrom("personal_api_tokens")
        .select("personal_api_tokens.name")
        .where("personal_api_tokens.user_id", "=", userId)
        .where("personal_api_tokens.id", "=", id)
        .where("personal_api_tokens.revoked_at", "is", null)
        .executeTakeFirst();
      return row?.name;
    },
  };
}
