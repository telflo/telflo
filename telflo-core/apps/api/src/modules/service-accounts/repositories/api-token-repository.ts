import { sql, type Kysely, type Transaction } from "kysely";
import type { ApiTokenAccess, Database, OrganizationRole } from "@telflo/db";
import type { ApiTokenKind } from "../../../database/context.js";
import { createOrganizationScope, type OrganizationScopeContext } from "../../../tenancy/organization-scope.js";

/*
 * A service account's API tokens (D22 decisions 7 to 9 and 31; migration
 * 1700000000035): the context's organization's rows, reached only through
 * the organization scope, row-level security on api_tokens behind it, so
 * the transaction must carry a database context naming the same
 * organization. Every query is an account's, its first filter the
 * organization (the scope's).
 *
 * The token is never here, and its hash enters only through `create` and
 * leaves no method: no read selects token_hash, so an object that doesn't
 * carry it can't log it. The prefix
 * and the name are shown in the masked list only, never logged.
 *
 * The resource registry (D22 Task 1), the account's deletion (Task 4), the
 * token routes (Task 5) and the token check (Task 6) share it: "Last used",
 * the check's one write (decision 38), and the token's name, which /whoami
 * reads (decision 39), go through the scope in the token's own context.
 * `findLiveApiTokenByHash`, below, is the definer lookup's one caller.
 */

/** "Last used" is written at most once a minute per token (decision 38). */
const LAST_USED_INTERVAL_MS = 60_000;

/** Postgres error code for a unique-constraint (or unique-index) violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * A name is unique, case aside, among an account's tokens not revoked,
 * expired ones included (migration 1700000000035; D22 Preflight ruling 3).
 */
const NAME_UNIQUE_INDEX = "uq_api_tokens_service_account_user_id_lower_name";

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

/**
 * Thrown by `create` when a token of the account not yet revoked has the
 * name: the unique index behind the service's own check under the
 * organization lock. Its message names no name.
 */
export class ApiTokenNameTakenError extends Error {
  constructor() {
    super("a token of the account not yet revoked already has that name");
    this.name = "ApiTokenNameTakenError";
  }
}

/** A token not revoked: live, or expired (by the caller's clock) and still listed. */
export interface ApiToken {
  id: string;
  organizationId: string;
  /** The account's (its user's) id. */
  serviceAccountId: string;
  name: string;
  /** Its first 11 characters (tf_ and 8). */
  prefix: string;
  access: ApiTokenAccess;
  /** Null: never expires. */
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface CreateApiTokenInput {
  serviceAccountId: string;
  name: string;
  /** sha-256 (hex) of the token; the token itself never reaches the repository. */
  tokenHash: string;
  /** Its first 11 characters. */
  tokenPrefix: string;
  access: ApiTokenAccess;
  /** Null: never expires. */
  expiresAt: Date | null;
  createdByUserId: string;
  /** The clock's time: its creation. */
  at: Date;
}

export interface IApiTokenRepository {
  /** The account's tokens not revoked, expired ones included, newest first. */
  list(serviceAccountId: string): Promise<ApiToken[]>;
  /** The account's token with this id, not revoked, or undefined: unknown, revoked and another account's alike. */
  find(serviceAccountId: string, id: string): Promise<ApiToken | undefined>;
  /** How many of the account's tokens are live at `at`: neither revoked nor expired (the limit's count, decision 8). */
  countLive(serviceAccountId: string, at: Date): Promise<number>;
  /** Whether a token of the account not yet revoked, expired ones included, has the name, case aside. */
  isNameTaken(serviceAccountId: string, name: string): Promise<boolean>;
  /**
   * Inserts the token's row (decision 31). Throws ApiTokenNameTakenError
   * when a token of the account not yet revoked has the name.
   */
  create(input: CreateApiTokenInput): Promise<ApiToken>;
  /**
   * Revokes the account's token once, by `userId` at `at`, in one
   * conditional update. False when the account has no such token not yet
   * revoked.
   */
  revoke(serviceAccountId: string, id: string, userId: string, at: Date): Promise<boolean>;
  /**
   * Revokes every token of the account not yet revoked, expired ones
   * included, by `userId` at `at`: the account's deletion (D22 decision 28's
   * step 3). Resolves with how many it revoked.
   */
  revokeAllOf(serviceAccountId: string, userId: string, at: Date): Promise<number>;
  /**
   * "Last used" (decision 38): sets the token's last_used_at to `at`, unless
   * it was set less than a minute before `at` or the token is revoked
   * (Preflight ruling 5: a check that waited on the revoke never stamps a
   * revoked token), in one conditional update. Concurrent checks of one
   * token write once: each waits on the first's row lock and then reads its
   * time. True when it wrote. A clock earlier than the token's creation
   * fails `ck_api_tokens_last_used_after_created` (23514): the caller's
   * best-effort catch takes it (Preflight ruling 12).
   */
  touchLastUsed(id: string, at: Date): Promise<boolean>;
  /** The name of the token with this id, not revoked, or undefined (/whoami's read, decision 39). */
  findName(id: string): Promise<string | undefined>;
}

/**
 * Bound to a transaction that carries the database context (context.ts) and
 * to the context whose organization it acts on.
 */
export function createApiTokenRepository(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): IApiTokenRepository {
  const scope = createOrganizationScope(transaction, context);
  /**
   * An account's tokens not revoked; never the hash, and not their creator,
   * whom no reply shows (an address read for nothing is personal data read
   * for nothing).
   */
  const listed = (serviceAccountId: string) =>
    scope
      .selectFrom("api_tokens")
      .select([
        "api_tokens.id as id",
        "api_tokens.organization_id as organizationId",
        "api_tokens.service_account_user_id as serviceAccountId",
        "api_tokens.name as name",
        "api_tokens.token_prefix as prefix",
        "api_tokens.access as access",
        "api_tokens.expires_at as expiresAt",
        "api_tokens.last_used_at as lastUsedAt",
        "api_tokens.created_at as createdAt",
      ])
      .where("api_tokens.service_account_user_id", "=", serviceAccountId)
      .where("api_tokens.revoked_at", "is", null);

  /**
   * The one revocation, a revoke's and a deletion's alike (decision 31):
   * the account's tokens not yet revoked, revoked at `at` by `userId`. An
   * expired token is revoked as any.
   */
  const revocation = (serviceAccountId: string, userId: string, at: Date) =>
    scope
      .updateTable("api_tokens", { revoked_at: at, revoked_by_user_id: userId })
      .where("api_tokens.service_account_user_id", "=", serviceAccountId)
      .where("api_tokens.revoked_at", "is", null);

  return {
    async list(serviceAccountId) {
      return listed(serviceAccountId)
        .orderBy("api_tokens.created_at", "desc")
        .orderBy("api_tokens.id", "desc")
        .execute();
    },

    async find(serviceAccountId, id) {
      return listed(serviceAccountId).where("api_tokens.id", "=", id).executeTakeFirst();
    },

    async countLive(serviceAccountId, at) {
      const row = await scope
        .selectFrom("api_tokens")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("api_tokens.service_account_user_id", "=", serviceAccountId)
        .where("api_tokens.revoked_at", "is", null)
        .where((eb) => eb.or([eb("api_tokens.expires_at", "is", null), eb("api_tokens.expires_at", ">", at)]))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async isNameTaken(serviceAccountId, name) {
      const row = await scope
        .selectFrom("api_tokens")
        .select("api_tokens.id")
        .where("api_tokens.service_account_user_id", "=", serviceAccountId)
        .where("api_tokens.revoked_at", "is", null)
        .where(sql<string>`lower(${sql.ref("api_tokens.name")})`, "=", sql<string>`lower(${name})`)
        .executeTakeFirst();
      return row !== undefined;
    },

    async create(input) {
      let id: string;
      try {
        ({ id } = await scope
          .insertInto("api_tokens", {
            service_account_user_id: input.serviceAccountId,
            name: input.name,
            token_hash: input.tokenHash,
            token_prefix: input.tokenPrefix,
            access: input.access,
            expires_at: input.expiresAt,
            created_by_user_id: input.createdByUserId,
            created_at: input.at,
          })
          .returning("api_tokens.id")
          .executeTakeFirstOrThrow());
      } catch (error) {
        if (isNameViolation(error)) throw new ApiTokenNameTakenError();
        throw error;
      }
      return listed(input.serviceAccountId).where("api_tokens.id", "=", id).executeTakeFirstOrThrow();
    },

    async revoke(serviceAccountId, id, userId, at) {
      const result = await revocation(serviceAccountId, userId, at).where("api_tokens.id", "=", id).executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async revokeAllOf(serviceAccountId, userId, at) {
      const result = await revocation(serviceAccountId, userId, at).executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async touchLastUsed(id, at) {
      const result = await scope
        .updateTable("api_tokens", { last_used_at: at })
        .where("api_tokens.id", "=", id)
        .where("api_tokens.revoked_at", "is", null)
        .where((eb) =>
          eb.or([
            eb("api_tokens.last_used_at", "is", null),
            eb("api_tokens.last_used_at", "<=", new Date(at.getTime() - LAST_USED_INTERVAL_MS)),
          ]),
        )
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async findName(id) {
      const row = await scope
        .selectFrom("api_tokens")
        .select("api_tokens.name")
        .where("api_tokens.id", "=", id)
        .where("api_tokens.revoked_at", "is", null)
        .executeTakeFirst();
      return row?.name;
    },
  };
}

/**
 * What the token check learns from a live token (D22 decision 18, D25
 * decision 21): enough to build the token's context, and nothing else (not
 * its name: /whoami reads that afterwards, through the policies).
 * - A service account's (`kind: "service_account"`): its token's
 *   organization and the account's membership's role, as D22's.
 * - A person's own (`kind: "person"`, migration 1700000000038's
 *   personal_api_tokens): no organization and no role; the organization
 *   comes per request (decision 24).
 */
export interface LiveApiToken {
  kind: ApiTokenKind;
  tokenId: string;
  /** The token's user: the service account's (its user's) id, or the person's. */
  userId: string;
  /**
   * The user's address (decision 12): a service account's
   * `…@service-accounts.telflo.invalid`, or the person's email. Personal
   * data: never logged.
   */
  email: string;
  access: ApiTokenAccess;
  /** A service account's token's organization; null for a person's. */
  organizationId: string | null;
  /** The account's membership's role, as the lookup read it; null for a person's. */
  role: OrganizationRole | null;
}

/**
 * The token check's lookup (D22 decisions 11 and 18, D25 decision 21):
 * `find_live_api_token_by_hash`, the definer function only the API's role
 * may run, keyed by the token's sha-256 (hex). Undefined for every refusal
 * alike: an unknown hash, a revoked token or one expired at `at`; for a
 * service account's, a deleted account, user, membership or organization;
 * for a person's, a deleted user or one who isn't a person. `at` is the
 * API's clock, never the database's. It needs no database context: the
 * definer reads past row-level security, and only by the hash.
 *
 * Its one caller is modules/public-api/authenticate-api-token.ts, and this
 * file the only one naming the SQL function outside the migrations (D22
 * Preflight ruling 9; database/context-source.test.ts scans for others).
 */
export async function findLiveApiTokenByHash(
  db: Kysely<Database>,
  tokenHash: string,
  at: Date,
): Promise<LiveApiToken | undefined> {
  const { rows } = await sql<{
    kind: ApiTokenKind;
    token_id: string;
    user_id: string;
    email: string;
    access: ApiTokenAccess;
    organization_id: string | null;
    role: OrganizationRole | null;
  }>`
    select kind, token_id, user_id, email, access, organization_id, role
      from find_live_api_token_by_hash(${tokenHash}, ${at})
  `.execute(db);
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        kind: row.kind,
        tokenId: row.token_id,
        userId: row.user_id,
        email: row.email,
        access: row.access,
        organizationId: row.organization_id,
        role: row.role,
      };
}
