import type { Kysely, Selectable, Transaction } from "kysely";
import type { Database, UserIdentitiesTable } from "@telflo/db";
import { toUser, type UserWithDeletion } from "./user-repository.js";

/** A user's identity at a federated provider. */
export interface UserIdentity {
  id: string;
  userId: string;
  provider: string;
  providerSubject: string;
  /** The provider's email at link time: a snapshot for the audit trail, never used to sign in. */
  email: string;
  linkedAt: Date;
}

export interface LinkIdentityInput {
  userId: string;
  provider: string;
  subject: string;
  email: string;
}

/** Postgres error code for a unique-constraint (or unique-index) violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The two unique indexes on user_identities
 * (packages/db/migrations/1700000000007_federated_identity.js), and what a
 * violation of each means.
 */
const IDENTITY_CONFLICTS = {
  uq_user_identities_provider_subject: "subject_taken",
  uq_user_identities_user_id_provider: "provider_taken",
} as const;

export type IdentityLinkConflict = (typeof IDENTITY_CONFLICTS)[keyof typeof IDENTITY_CONFLICTS];

/**
 * Thrown by `link()` when a unique index refuses the link:
 * - `subject_taken`: the provider's subject is already linked, normally by a
 *   concurrent sign-in of the same person that won the race;
 * - `provider_taken`: the user already has a different identity at this
 *   provider (one per provider per user).
 *
 * Any other error is re-thrown unchanged. Inside a transaction, Postgres
 * aborts the transaction on the violation, so a caller that catches this must
 * let that transaction roll back before reading again.
 */
export class IdentityLinkConflictError extends Error {
  readonly reason: IdentityLinkConflict;

  constructor(reason: IdentityLinkConflict) {
    super(`The identity cannot be linked: ${reason}.`);
    this.name = "IdentityLinkConflictError";
    this.reason = reason;
  }
}

function identityConflict(error: unknown): IdentityLinkConflictError | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    typeof error.constraint === "string" &&
    Object.hasOwn(IDENTITY_CONFLICTS, error.constraint)
  ) {
    return new IdentityLinkConflictError(
      IDENTITY_CONFLICTS[error.constraint as keyof typeof IDENTITY_CONFLICTS],
    );
  }
  return undefined;
}

export interface IUserIdentityRepository {
  findUserBySubject(provider: string, subject: string): Promise<UserWithDeletion | undefined>;
  link(input: LinkIdentityInput): Promise<UserIdentity>;
  /**
   * The user's identities, oldest link first: every one, whether or not
   * its provider is still configured.
   */
  listForUser(userId: string): Promise<UserIdentity[]>;
  /** The user's identity at `provider`: at most one (`uq_user_identities_user_id_provider`). */
  findForUser(userId: string, provider: string): Promise<UserIdentity | undefined>;
  /** Deletes the user's identity at `provider`; false when they have none there. */
  unlink(userId: string, provider: string): Promise<boolean>;
}

/** The single place a user_identities row becomes camelCase. */
function toUserIdentity(row: Selectable<UserIdentitiesTable>): UserIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerSubject: row.provider_subject,
    email: row.email,
    linkedAt: row.linked_at,
  };
}

export function createUserIdentityRepository(
  db: Kysely<Database> | Transaction<Database>,
): IUserIdentityRepository {
  return {
    /**
     * The user linked to `(provider, subject)`. A soft-deleted user is
     * returned with `isDeleted: true` rather than hidden, so sign-in can
     * refuse them instead of treating the subject as unknown and creating a
     * second account. Hence not "findLiveUserBySubject".
     */
    async findUserBySubject(provider: string, subject: string): Promise<UserWithDeletion | undefined> {
      const row = await db
        .selectFrom("user_identities")
        .innerJoin("users", "users.id", "user_identities.user_id")
        .selectAll("users")
        .where("user_identities.provider", "=", provider)
        .where("user_identities.provider_subject", "=", subject)
        .executeTakeFirst();
      return row ? { user: toUser(row), isDeleted: row.deleted_at !== null } : undefined;
    },

    /**
     * Links `(provider, subject)` to the user. Throws
     * IdentityLinkConflictError when either unique index refuses it.
     */
    async link(input: LinkIdentityInput): Promise<UserIdentity> {
      try {
        const row = await db
          .insertInto("user_identities")
          .values({
            user_id: input.userId,
            provider: input.provider,
            provider_subject: input.subject,
            email: input.email,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toUserIdentity(row);
      } catch (error) {
        throw identityConflict(error) ?? error;
      }
    },

    async listForUser(userId: string): Promise<UserIdentity[]> {
      const rows = await db
        .selectFrom("user_identities")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("linked_at")
        .orderBy("provider")
        .execute();
      return rows.map(toUserIdentity);
    },

    async findForUser(userId: string, provider: string): Promise<UserIdentity | undefined> {
      const row = await db
        .selectFrom("user_identities")
        .selectAll()
        .where("user_id", "=", userId)
        .where("provider", "=", provider)
        .executeTakeFirst();
      return row ? toUserIdentity(row) : undefined;
    },

    async unlink(userId: string, provider: string): Promise<boolean> {
      const result = await db
        .deleteFrom("user_identities")
        .where("user_id", "=", userId)
        .where("provider", "=", provider)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    },
  };
}
