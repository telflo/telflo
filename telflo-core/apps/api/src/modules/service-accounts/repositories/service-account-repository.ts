import { SERVICE_ACCOUNTS_MAXIMUM } from "@telflo/contracts";
import { sql, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import { createOrganizationScope, type OrganizationScopeContext } from "../../../tenancy/organization-scope.js";

/*
 * Service accounts (migration 1700000000035): the context's organization's
 * accounts, reached only through the organization scope, row-level security on
 * service_accounts behind it, so the transaction must carry a database context
 * naming the same organization. An account is live while its row's deleted_at
 * and its user's are both null; every read here asks for both.
 *
 * The resource registry's operations and the routes' service share it. The
 * name and the address are organization content: an object that holds either
 * is never logged, and the errors thrown here carry neither.
 */

/** Postgres error code for a unique-constraint (or unique-index) violation. */
const UNIQUE_VIOLATION = "23505";

/** Every address is unique, case aside, deleted users' included (migration 1700000000001). */
const EMAIL_UNIQUE_INDEX = "uq_users_lower_email";

/** A live account's name is unique in its organization, case aside (migration 1700000000035). */
const NAME_UNIQUE_INDEX = "uq_service_accounts_organization_id_lower_name";

/**
 * The unique index a violation names, or undefined for any other error. The
 * caller tells the two apart by name, as identity's
 * `isDuplicateEmailViolation` does: any other unique index is a bug, and
 * surfaces as one.
 */
function violatedUniqueIndex(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error) || error.code !== UNIQUE_VIOLATION) return undefined;
  return "constraint" in error && typeof error.constraint === "string" ? error.constraint : undefined;
}

/**
 * Thrown by `create` when another user already holds the address (decision
 * 27: eight hex digits under one slug can collide). The statement failed, so
 * the transaction is aborted: the service rolls it back and tries again
 * with new digits. Its message names no address.
 */
export class ServiceAccountAddressTakenError extends Error {
  constructor() {
    super("another user already holds the service account's address");
    this.name = "ServiceAccountAddressTakenError";
  }
}

/**
 * Thrown by `create` and `rename` when a live account of the organization
 * already has the name, case aside: the unique index behind the service's
 * own check under the organization lock. Its message names no name.
 */
export class ServiceAccountNameTakenError extends Error {
  constructor() {
    super("a live service account of the organization already has that name");
    this.name = "ServiceAccountNameTakenError";
  }
}

/** Runs `write`, turning the two unique violations a service account can meet into their errors. */
async function withUniqueViolationsAsErrors<Result>(write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    const index = violatedUniqueIndex(error);
    if (index === EMAIL_UNIQUE_INDEX) throw new ServiceAccountAddressTakenError();
    if (index === NAME_UNIQUE_INDEX) throw new ServiceAccountNameTakenError();
    throw error;
  }
}

/** A live service account. */
export interface ServiceAccount {
  /** Its user's id. */
  id: string;
  organizationId: string;
  name: string;
  /** Its address at the reserved domain, fixed at creation. */
  email: string;
  /** The admin who made it; null once their account is hard-deleted. */
  createdBy: { userId: string; email: string } | null;
  createdAt: Date;
  updatedAt: Date;
  /** Its tokens not revoked, expired ones included: those its page lists. */
  tokenCount: number;
}

export interface CreateServiceAccountInput {
  name: string;
  /** The slug address, at the reserved domain. */
  email: string;
  createdByUserId: string;
  /** The clock's time: the email's verification, the row's creation and update. */
  at: Date;
}

export interface IServiceAccountRepository {
  /** The organization's live accounts, newest first, at most 100 (the limit). */
  list(): Promise<ServiceAccount[]>;
  /** The live account with this id, or undefined: unknown, deleted and another organization's alike. */
  find(id: string): Promise<ServiceAccount | undefined>;
  /** How many live accounts the organization has (the limit's count). */
  countLive(): Promise<number>;
  /** Whether a live account other than `exceptId` has the name, case aside. */
  isNameTaken(name: string, exceptId?: string): Promise<boolean>;
  /**
   * Inserts the account's user (kind service, the address, verified at
   * `at`, no password, no terms) and its row, in the caller's transaction.
   * Its membership is the caller's, next. Throws
   * ServiceAccountAddressTakenError when the address is taken, and
   * ServiceAccountNameTakenError when a live account has the name.
   */
  create(input: CreateServiceAccountInput): Promise<ServiceAccount>;
  /**
   * Renames a live account at `at` (its updated_at). False when there is
   * none; throws ServiceAccountNameTakenError when another live account has
   * the name.
   */
  rename(id: string, name: string, at: Date): Promise<boolean>;
  /**
   * Marks a live account deleted at `at`: its row's deleted_at and then its
   * user's, the user reached only through the row this organization's scope
   * found. False when there is none. Its tokens and its membership are the
   * caller's, before this.
   */
  markDeleted(id: string, at: Date): Promise<boolean>;
}

/**
 * Bound to a transaction that carries the database context (context.ts) and
 * to the context whose organization it acts on.
 */
export function createServiceAccountRepository(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): IServiceAccountRepository {
  const scope = createOrganizationScope(transaction, context);
  /** The users still live (users is global; the accounts are chosen through the scope). */
  const liveUserIds = () => transaction.selectFrom("users").select("users.id").where("users.deleted_at", "is", null);
  /** The live accounts, with their address and their creator's. */
  const accounts = () =>
    scope
      .selectFrom("service_accounts")
      .innerJoin("users", "users.id", "service_accounts.user_id")
      .leftJoin("users as creators", "creators.id", "service_accounts.created_by_user_id")
      .select([
        "service_accounts.user_id as id",
        "service_accounts.organization_id as organizationId",
        "service_accounts.name as name",
        "users.email as email",
        "service_accounts.created_by_user_id as createdByUserId",
        "creators.email as creatorEmail",
        "service_accounts.created_at as createdAt",
        "service_accounts.updated_at as updatedAt",
      ])
      .where("service_accounts.deleted_at", "is", null)
      .where("users.deleted_at", "is", null);

  type Row = Awaited<ReturnType<ReturnType<typeof accounts>["executeTakeFirstOrThrow"]>>;
  const toServiceAccount = (
    { createdByUserId, creatorEmail, ...account }: Row,
    tokenCounts: ReadonlyMap<string, number>,
  ): ServiceAccount => ({
    ...account,
    createdBy: createdByUserId === null || creatorEmail === null ? null : { userId: createdByUserId, email: creatorEmail },
    tokenCount: tokenCounts.get(account.id) ?? 0,
  });

  /**
   * The listed tokens (not revoked, expired included) of each of `ids`, by
   * account, through the scope: one grouped count, never a token's row.
   */
  const tokenCountsOf = async (ids: readonly string[]): Promise<Map<string, number>> => {
    if (ids.length === 0) return new Map();
    const rows = await scope
      .selectFrom("api_tokens")
      .select((eb) => ["api_tokens.service_account_user_id as id", eb.fn.countAll<string>().as("count")])
      .where("api_tokens.service_account_user_id", "in", ids)
      .where("api_tokens.revoked_at", "is", null)
      .groupBy("api_tokens.service_account_user_id")
      .execute();
    return new Map(rows.map((row) => [row.id, Number(row.count)]));
  };

  /** Each account read, with its listed tokens' count. */
  const withTokenCounts = async (rows: Row[]): Promise<ServiceAccount[]> => {
    const counts = await tokenCountsOf(rows.map((row) => row.id));
    return rows.map((row) => toServiceAccount(row, counts));
  };

  /** Live accounts with this name, case aside, as the unique index compares them. */
  const liveNamed = (name: string) =>
    scope
      .selectFrom("service_accounts")
      .select("service_accounts.user_id")
      .where(sql<string>`lower(${sql.ref("service_accounts.name")})`, "=", sql<string>`lower(${name})`)
      .where("service_accounts.deleted_at", "is", null);

  return {
    async list() {
      // At most the limit, the reply's own bound.
      const rows = await accounts()
        .orderBy("service_accounts.created_at", "desc")
        .orderBy("service_accounts.user_id", "desc")
        .limit(SERVICE_ACCOUNTS_MAXIMUM)
        .execute();
      return withTokenCounts(rows);
    },

    async find(id) {
      const row = await accounts().where("service_accounts.user_id", "=", id).executeTakeFirst();
      return row === undefined ? undefined : (await withTokenCounts([row]))[0];
    },

    async countLive() {
      const row = await scope
        .selectFrom("service_accounts")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("service_accounts.deleted_at", "is", null)
        .where("service_accounts.user_id", "in", liveUserIds())
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async isNameTaken(name, exceptId) {
      let query = liveNamed(name);
      if (exceptId !== undefined) query = query.where("service_accounts.user_id", "<>", exceptId);
      return (await query.executeTakeFirst()) !== undefined;
    },

    async create({ name, email, createdByUserId, at }) {
      return withUniqueViolationsAsErrors(async () => {
        // users is global: the new user is reached only through the row
        // inserted next, in this organization's scope.
        const user = await transaction
          .insertInto("users")
          .values({ email, kind: "service", email_verified_at: at, password_hash: null })
          .returning(["id", "email"])
          .executeTakeFirstOrThrow();
        await scope
          .insertInto("service_accounts", {
            user_id: user.id,
            name,
            created_by_user_id: createdByUserId,
            created_at: at,
            updated_at: at,
          })
          .execute();
        const created = await accounts().where("service_accounts.user_id", "=", user.id).executeTakeFirstOrThrow();
        return toServiceAccount(created, new Map());
      });
    },

    async rename(id, name, at) {
      const result = await withUniqueViolationsAsErrors(() =>
        scope
          .updateTable("service_accounts", { name, updated_at: at })
          .where("service_accounts.user_id", "=", id)
          .where("service_accounts.deleted_at", "is", null)
          .where("service_accounts.user_id", "in", liveUserIds())
          .executeTakeFirst(),
      );
      return result.numUpdatedRows > 0n;
    },

    async markDeleted(id, at) {
      const row = await scope
        .updateTable("service_accounts", { deleted_at: at })
        .where("service_accounts.user_id", "=", id)
        .where("service_accounts.deleted_at", "is", null)
        .where("service_accounts.user_id", "in", liveUserIds())
        .returning("service_accounts.user_id")
        .executeTakeFirst();
      if (row === undefined) return false;
      // Both columns, as delete_accounts_only_in_organization sets them
      // (migration 1700000000010). The row was live with a live user under
      // the caller's locks, so exactly one user changes; anything else is a
      // bug, and rolls the deletion back.
      const result = await transaction
        .updateTable("users")
        .set({ deleted_at: at, updated_at: at })
        .where("users.id", "=", row.user_id)
        .where("users.kind", "=", "service")
        .where("users.deleted_at", "is", null)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw new Error("a service account's deletion changed no user, or more than one");
      return true;
    },
  };
}
