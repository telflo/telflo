import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, UsersTable } from "@telflo/db";
import { setDatabaseContext, setOrganizationContext } from "../../../database/context.js";
import { createAuditRepository, type IAuditRepository } from "./audit-repository.js";
import { createCollectorCatalogueRepository } from "../../collector-catalogue/repositories/collector-catalogue-repository.js";
import { createConfigurationRepository } from "../../configurations/repositories/configuration-repository.js";
import { createConfigurationVersionRepository } from "../../configurations/repositories/configuration-version-repository.js";
import {
  STARTER_CONFIGURATION_DESCRIPTION,
  STARTER_CONFIGURATION_NAME,
  STARTER_CONFIGURATION_YAML,
  STARTER_VERSION_LABEL,
} from "../../configurations/starter-configuration.js";
import { createInvitationRepository } from "../../organizations/repositories/invitation-repository.js";
import {
  createMemberRepository,
  type OrganizationMembership,
} from "../../organizations/repositories/member-repository.js";
import {
  createActiveOrganizationRepository,
  createOrganizationRepository,
  type Organization,
} from "../../organizations/repositories/organization-repository.js";
import type { OrganizationRepositories } from "../../organizations/service.js";
import {
  createUserIdentityRepository,
  type IUserIdentityRepository,
} from "./user-identity-repository.js";
import {
  createVerificationTokenRepository,
  type IVerificationTokenRepository,
} from "./verification-token-repository.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  /** Null for a user who has accepted no terms yet (D2c decision 6). */
  acceptedTermsVersion: string | null;
  createdAt: Date;
}

/** A user found whether or not they are soft-deleted, and which. */
export interface UserWithDeletion {
  user: User;
  isDeleted: boolean;
}

/**
 * The accepted terms, recorded together or not at all
 * (chk_users_terms_accepted_together).
 */
export interface TermsAcceptance {
  version: string;
  acceptedAt: Date;
}

/** Where the request that creates an account came from, recorded on the audit rows `createAccount` writes itself. */
export interface AccountOrigin {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Every kind of account goes through `createAccount` with this. Email
 * registration gives a password, its checkbox's terms, and no verification
 * yet; a federated sign-up (`createFederatedAccount`) gives no password, no
 * terms, and the provider's verification.
 */
export interface CreateUserInput {
  email: string;
  passwordHash: string | null;
  terms: TermsAcceptance | null;
  /** Null until the email is proven: by the emailed link, or by an authoritative provider. */
  emailVerifiedAt: Date | null;
  /**
   * The caller's clock: when the starter configuration and its version 1
   * are created (D8 decision 10), never SQL `now()`.
   */
  createdAt: Date;
  /** Recorded on the starter configuration's audit row, as on the account's own. */
  origin: AccountOrigin;
}

export interface CreateFederatedUserInput {
  email: string;
  /** When the provider proved the email: the sign-in's time, and the account's `createdAt`. */
  verifiedAt: Date;
  origin: AccountOrigin;
}

/**
 * The single place snake_case becomes camelCase (Global Constraints). Callers
 * above this line never see a database column name. Exported for the
 * repositories that join `users` (user-identity-repository.ts), not for
 * services.
 */
export function toUser(row: Selectable<UsersTable>): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    acceptedTermsVersion: row.accepted_terms_version,
    createdAt: row.created_at,
  };
}

/** Emails are compared and stored lowercased; the unique index enforces it too. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface Account {
  user: User;
  organization: Organization;
  membership: OrganizationMembership;
}

/**
 * The repositories `createAccount` hands its callback, bound to the
 * account's transaction: whatever is written through them commits with the
 * account or not at all.
 */
export interface AccountWrites {
  audit: IAuditRepository;
  verificationTokens: IVerificationTokenRepository;
  identities: IUserIdentityRepository;
  /**
   * Points the account's transaction at another organization and hands out
   * its repositories: an account created from an invitation joins the
   * inviting organization in the same transaction (D6 decision 9), and
   * row-level security admits that membership, and shows that invitation,
   * only in the context's organization. After it, the context no longer
   * names the personal organization, until `createAccount` points it back
   * there for the starter configuration.
   */
  enterOrganization?(organizationId: string): Promise<OrganizationRepositories>;
  /**
   * Makes the new account the site's first product admin (D36-1 decisions
   * 36 and 37, Preflight ruling 3): migration 043's
   * `bootstrap_first_product_admin`, in the account's transaction, so a
   * refusal rolls the account back. Throws `ProductAdminExistsError` when a
   * product admin already exists. `telflo-admin bootstrap` is its one
   * caller.
   */
  bootstrapFirstProductAdmin?(userId: string, at: Date): Promise<void>;
}

/**
 * Runs inside the account's transaction, after its three rows are inserted.
 * It must write only through `writes` and must not do anything that cannot
 * be rolled back, such as sending email: it runs before the commit. This
 * rule is enforced by convention and review, not by the type system.
 */
export type AccountCreatedCallback = (account: Account, writes: AccountWrites) => Promise<void>;

/** Postgres error code for a unique-constraint (or unique-index) violation. */
const UNIQUE_VIOLATION = "23505";

/** The unique index on lower(email) (packages/db/migrations/1700000000001_identity.js). */
const EMAIL_UNIQUE_INDEX = "uq_users_lower_email";

/**
 * True only for a unique violation on the email index. Checked by name, not
 * just by SQLSTATE: `createAccount` runs three inserts, and the organization
 * and membership tables carry unique indexes of their own. A violation of
 * one of those is a bug, and must surface as one, not be reported to the
 * caller as "that email is taken".
 */
function isDuplicateEmailViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === EMAIL_UNIQUE_INDEX
  );
}

/**
 * Thrown by `createAccount()` and `createFederatedAccount()` when
 * `uq_users_lower_email` refuses the email: normally because a concurrent
 * request won the race to insert it first, but also when a soft-deleted
 * account still holds it (the index covers soft-deleted rows; see
 * ../service.ts). Distinct from a plain re-throw so callers can catch
 * exactly this case (and only this case) without pattern-matching on a raw
 * Postgres error code themselves.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super("A user with this email already exists.");
    this.name = "DuplicateEmailError";
  }
}

/**
 * Thrown by `bootstrapFirstProductAdmin` and answered by
 * `productAdminExists`: the bootstrap function's refusal because a product
 * admin already exists (42501 with its own hint; migration 043).
 */
export class ProductAdminExistsError extends Error {
  constructor() {
    super("A product admin already exists.");
    this.name = "ProductAdminExistsError";
  }
}

/** The bootstrap function's refusals (migration 043): 42501 with these hints, nothing else. */
const PRODUCT_ADMIN_EXISTS_HINT = "telflo_product_admin_exists";
const BOOTSTRAP_USER_NOT_FOUND_HINT = "telflo_bootstrap_user_not_found";

/** The hint of the bootstrap function's 42501, or undefined for any other error. */
function bootstrapRefusalHint(error: unknown): string | undefined {
  const { code, hint } = (error ?? {}) as { code?: unknown; hint?: unknown };
  return code === "42501" && typeof hint === "string" ? hint : undefined;
}

/** Calls the bootstrap function for `userId` in `db`'s transaction; its "admin exists" refusal as ProductAdminExistsError. */
async function callBootstrapFunction(db: Kysely<Database> | Transaction<Database>, userId: string, at: Date): Promise<void> {
  try {
    await sql`select bootstrap_first_product_admin(${userId}::uuid, ${at}::timestamptz)`.execute(db);
  } catch (error) {
    if (bootstrapRefusalHint(error) === PRODUCT_ADMIN_EXISTS_HINT) throw new ProductAdminExistsError();
    throw error;
  }
}

/**
 * Whether the site has a product admin, as the bootstrap function answers
 * it (D36-1 Preflight ruling 3; Ruling 353). How: it calls the definer,
 * bootstrap_first_product_admin, with a random uuid no user holds, in a
 * transaction of its own that always rolls back (the function's refusal
 * aborts it; were it ever to return, the throw after it rolls it back).
 * The call briefly takes the function's global advisory lock, released at
 * that rollback: it leaves no lock, no audit row and no change. The answer
 * is read from the refusal's HINT alone: `telflo_product_admin_exists`
 * means one exists, `telflo_bootstrap_user_not_found` means none does. So
 * the flag itself is never read here (database/context-source.test.ts pins
 * who may). `telflo-admin bootstrap` asks it first, so a rerun is refused
 * before anything else; the function stays the real guard, in the
 * account's own transaction.
 */
export async function productAdminExists(db: Kysely<Database>, at: Date): Promise<boolean> {
  try {
    await db.transaction().execute(async (transaction) => {
      await callBootstrapFunction(transaction, randomUUID(), at);
      // Only a user holding that new id could get here: roll it back all the same.
      throw new Error("the bootstrap check found a user with an id no user holds");
    });
  } catch (error) {
    if (error instanceof ProductAdminExistsError) return true;
    if (bootstrapRefusalHint(error) === BOOTSTRAP_USER_NOT_FOUND_HINT) return false;
    throw error;
  }
  // The transaction above never commits: it ends in the function's refusal or in the throw after it.
  throw new Error("the bootstrap check's transaction committed");
}

/** What `setPasswordAndConfirmEmail` reports about the user it changed. */
export interface PasswordSet {
  email: string;
  /** True when this call confirmed the email; false when it was already confirmed. */
  wasUnconfirmed: boolean;
}

/** What `takeOverUnverified` reports about the account it took over. */
export interface AccountTakenOver {
  email: string;
  /** True when a password was deleted; false when the account had none. */
  hadPassword: boolean;
  /**
   * True when a terms acceptance was cleared. It was the pre-registrant's
   * consent, not the owner's, who accepts for themselves (D2c Ruling 14).
   */
  hadTerms: boolean;
}

export interface IUserRepository {
  findByEmail(email: string): Promise<User | undefined>;
  findByEmailIncludingDeleted(email: string): Promise<UserWithDeletion | undefined>;
  findById(id: string): Promise<User | undefined>;
  createAccount(input: CreateUserInput, onCreated?: AccountCreatedCallback): Promise<Account>;
  createFederatedAccount(input: CreateFederatedUserInput, onCreated?: AccountCreatedCallback): Promise<Account>;
  markEmailVerified(userId: string): Promise<void>;
  setPasswordAndConfirmEmail(userId: string, passwordHash: string, at: Date): Promise<PasswordSet | undefined>;
  setPasswordHash(userId: string, passwordHash: string, at: Date): Promise<boolean>;
  takeOverUnverified(userId: string, at: Date): Promise<AccountTakenOver | undefined>;
  acceptTerms(userId: string, version: string, at: Date): Promise<boolean>;
  findPasswordHashForShare(userId: string): Promise<string | null | undefined>;
  lockForUpdate(userId: string): Promise<void>;
}

export function createUserRepository(db: Kysely<Database> | Transaction<Database>): IUserRepository {
  const repository: IUserRepository = {
    /**
     * A person only (D22 decisions 12 and 22): every caller starts a
     * person's flow (registration and its race refetch, resend, password
     * sign-in, the reset request), so a service account's address reads as
     * no account there and each flow keeps its answer for an unknown
     * address. `findById` keeps every kind.
     */
    async findByEmail(email: string): Promise<User | undefined> {
      const row = await db
        .selectFrom("users")
        .selectAll()
        .where("email", "=", normalizeEmail(email))
        .where("kind", "=", "human")
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return row ? toUser(row) : undefined;
    },

    /**
     * Like `findByEmail`, but a soft-deleted user is found too, and reported
     * as one. `uq_users_lower_email` covers soft-deleted rows, so the address
     * cannot be given to a new account while one holds it (D2c decision 4).
     * A person only, as `findByEmail` (D22 decision 22): its callers (Google
     * sign-in's link, take-over or create; the invitation preview's
     * `hasAccount`; registering from an invitation) start a person's flow.
     * Google sign-in and registering from an invitation refuse the
     * reserved domain before calling it, so they never create an account
     * at a service account's address (the index backs that up). The
     * preview does reach one, for an invitation written before D22, and
     * answers `hasAccount: false` for it, as the spec wants (decision 22).
     */
    async findByEmailIncludingDeleted(email: string): Promise<UserWithDeletion | undefined> {
      const row = await db
        .selectFrom("users")
        .selectAll()
        .where("email", "=", normalizeEmail(email))
        .where("kind", "=", "human")
        .executeTakeFirst();
      return row ? { user: toUser(row), isDeleted: row.deleted_at !== null } : undefined;
    },

    /** Like `findByEmail`, a soft-deleted user is not found. */
    async findById(id: string): Promise<User | undefined> {
      const row = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return row ? toUser(row) : undefined;
    },

    /**
     * Creates an account: the user, their personal organization and an
     * `admin` membership of it, in one transaction (D1b), then runs
     * `onCreated` in that same transaction for the writes that belong with
     * the account (registration's audit trail and verification token, a
     * federated sign-up's identity link, an invitation's membership and
     * acceptance), then creates the starter configuration in the personal
     * organization (D8 decision 10). Either everything persists or nothing
     * does. Every kind of account is created here, so D1b's invariant, the
     * starter and the duplicate-email handling below hold for all of them.
     *
     * `findByEmail` then `createAccount` (in ../service.ts) is a check-then-act
     * with no transaction spanning the two, so two concurrent registrations
     * of the same brand-new address can both pass the check and both
     * attempt the insert. `uq_users_lower_email` guarantees only one
     * succeeds; the loser's user insert fails, its transaction rolls back
     * before anything else is written (and `onCreated` never runs), and it
     * must not surface
     * that as a raw 500 (Global Constraints; see also the enumeration-safety
     * comment in ../service.ts — a 500-vs-200 difference is itself an
     * enumeration signal). Catching the unique violation here, rather than
     * an `onConflict` clause, is what lets the loser fall through to the
     * exact same "email already registered" handling as a request that
     * found the row up front. It is caught outside the transaction, so the
     * rollback has already happened when DuplicateEmailError is thrown.
     */
    async createAccount(input: CreateUserInput, onCreated?: AccountCreatedCallback): Promise<Account> {
      try {
        return await db.transaction().execute(async (transaction) => {
          const userRow = await transaction
            .insertInto("users")
            .values({
              email: normalizeEmail(input.email),
              password_hash: input.passwordHash,
              email_verified_at: input.emailVerifiedAt,
              accepted_terms_version: input.terms?.version ?? null,
              terms_accepted_at: input.terms?.acceptedAt ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const user = toUser(userRow);

          const organization = await createOrganizationRepository(transaction).createPersonal({
            ownerUserId: user.id,
            ownerEmail: user.email,
          });
          // Row-level security admits a membership only into the context's
          // organization (D5 decision 3), and this one has only just been made.
          await setOrganizationContext(transaction, organization.id);
          const membership = await createMemberRepository(transaction, { organizationId: organization.id }).add({
            userId: user.id,
            role: "admin",
          });

          const account = { user, organization, membership };
          await onCreated?.(account, {
            audit: createAuditRepository(transaction),
            verificationTokens: createVerificationTokenRepository(transaction),
            identities: createUserIdentityRepository(transaction),
            enterOrganization: async (organizationId) => {
              await setOrganizationContext(transaction, organizationId);
              return {
                organization: createActiveOrganizationRepository(transaction, { organizationId }),
                members: createMemberRepository(transaction, { organizationId }),
                invitations: createInvitationRepository(transaction, { organizationId }),
              };
            },
            bootstrapFirstProductAdmin: (userId, at) => callBootstrapFunction(transaction, userId, at),
          });

          // The starter configuration (D8 decision 10), after `onCreated`, so
          // its audit row follows the account's own (D8 Preflight ruling 6).
          // `enterOrganization` may have pointed the context at an inviting
          // organization; the starter belongs to the personal one, so the
          // context names it again, and the new user too: a configuration is
          // its creator's draft, which row-level security shows (and so lets
          // an insert return) only to them (D11b decision 1, Preflight ruling
          // 2). It locks only rows this transaction made.
          await setDatabaseContext(transaction, { userId: user.id, organizationId: organization.id });
          const personal = { organizationId: organization.id, userId: user.id };
          // The catalogue's default distribution and its default version
          // (D13a decisions 3 and 9), read in this transaction, as a
          // configuration created through the API gets them.
          const pin = await createCollectorCatalogueRepository(transaction).findDefaults();
          const starter = await createConfigurationRepository(transaction, personal).create({
            name: STARTER_CONFIGURATION_NAME,
            description: STARTER_CONFIGURATION_DESCRIPTION,
            createdByUserId: user.id,
            collectorDistribution: pin.distribution,
            at: input.createdAt,
          });
          await createConfigurationVersionRepository(transaction, personal).create({
            configurationId: starter.id,
            versionNumber: 1,
            // D10 decision 14.
            label: STARTER_VERSION_LABEL,
            yamlContent: STARTER_CONFIGURATION_YAML,
            createdByUserId: user.id,
            collectorDistribution: pin.distribution,
            collectorVersion: pin.version,
            at: input.createdAt,
          });
          // As the account's own rows are written: the new user as actor, in
          // the personal organization, with the request's origin. Never the
          // YAML (D8 decision 17).
          await createAuditRepository(transaction).record({
            action: "configuration.created",
            actorUserId: user.id,
            actorEmail: user.email,
            organizationId: organization.id,
            subjectType: "configuration",
            subjectId: starter.id,
            metadata: { name: starter.name },
            ipAddress: input.origin.ipAddress,
            userAgent: input.origin.userAgent,
          });
          return account;
        });
      } catch (error) {
        if (isDuplicateEmailViolation(error)) throw new DuplicateEmailError();
        throw error;
      }
    },

    /**
     * An account created by a federated sign-in (D2c decision 4): no
     * password, the email verified by the provider, and no terms accepted,
     * so the terms dialog shows on first use. The same path as
     * `createAccount`, so the same transaction, callback and
     * DuplicateEmailError apply.
     */
    async createFederatedAccount(
      input: CreateFederatedUserInput,
      onCreated?: AccountCreatedCallback,
    ): Promise<Account> {
      return repository.createAccount(
        {
          email: input.email,
          passwordHash: null,
          terms: null,
          emailVerifiedAt: input.verifiedAt,
          createdAt: input.verifiedAt,
          origin: input.origin,
        },
        onCreated,
      );
    },

    async markEmailVerified(userId: string): Promise<void> {
      await db
        .updateTable("users")
        .set({ email_verified_at: new Date(), updated_at: new Date() })
        .where("id", "=", userId)
        .execute();
    },

    /**
     * A completed password reset (D3 decision 5): sets the new hash and
     * confirms the email if it wasn't already, since opening the emailed
     * link proves the user controls the mailbox. A soft-deleted user is not
     * touched, and gives `undefined`.
     *
     * An `UPDATE … RETURNING` returns the new `email_verified_at`, so the old
     * one is read first with `for update`, which holds the row until the
     * UPDATE in the same transaction. Bound to a transaction, this runs in
     * it; otherwise it opens its own.
     */
    async setPasswordAndConfirmEmail(
      userId: string,
      passwordHash: string,
      at: Date,
    ): Promise<PasswordSet | undefined> {
      const run = async (transaction: Kysely<Database>): Promise<PasswordSet | undefined> => {
        const before = await transaction
          .selectFrom("users")
          .select("email_verified_at")
          .where("id", "=", userId)
          .where("deleted_at", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!before) return undefined;

        const updated = await transaction
          .updateTable("users")
          .set((builder) => ({
            password_hash: passwordHash,
            updated_at: at,
            email_verified_at: builder.fn.coalesce("email_verified_at", builder.val(at)),
          }))
          .where("id", "=", userId)
          .where("deleted_at", "is", null)
          .returning("email")
          .executeTakeFirstOrThrow();
        return { email: updated.email, wasUnconfirmed: before.email_verified_at === null };
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },

    /**
     * A password changed from Settings (D21 decision 35, Preflight ruling
     * 11): sets the hash and `updated_at`, and nothing else. Unlike a reset
     * it never touches `email_verified_at`: knowing the current password
     * proves nothing about the mailbox. True when it changed the row; false
     * for a soft-deleted or unknown user. The caller holds the row (`lockForUpdate`)
     * and has rechecked the hash under that lock.
     */
    async setPasswordHash(userId: string, passwordHash: string, at: Date): Promise<boolean> {
      const result = await db
        .updateTable("users")
        .set({ password_hash: passwordHash, updated_at: at })
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    /**
     * A verified federated sign-in taking over an unverified account with
     * the same email (D2c decision 4): confirms the email and deletes the
     * password, so whoever registered the address before its owner is
     * locked out. The terms acceptance is cleared too: the consent was the
     * pre-registrant's, and the owner accepts for themselves (D2c Ruling
     * 14). Touches only a live, unverified user; a verified, soft-deleted or
     * unknown one gives `undefined` and is not changed.
     *
     * Reads `for update` first, as `setPasswordAndConfirmEmail` does, so the
     * row cannot be verified between the check and the update, and
     * `hadPassword` is the password this call deleted. Bound to a
     * transaction, this runs in it; otherwise it opens its own.
     */
    async takeOverUnverified(userId: string, at: Date): Promise<AccountTakenOver | undefined> {
      const run = async (transaction: Kysely<Database>): Promise<AccountTakenOver | undefined> => {
        const before = await transaction
          .selectFrom("users")
          .select(["email", "password_hash", "accepted_terms_version"])
          .where("id", "=", userId)
          .where("deleted_at", "is", null)
          .where("email_verified_at", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (!before) return undefined;

        await transaction
          .updateTable("users")
          .set({
            email_verified_at: at,
            password_hash: null,
            accepted_terms_version: null,
            terms_accepted_at: null,
            updated_at: at,
          })
          .where("id", "=", userId)
          .where("deleted_at", "is", null)
          .where("email_verified_at", "is", null)
          .execute();
        return {
          email: before.email,
          hadPassword: before.password_hash !== null,
          hadTerms: before.accepted_terms_version !== null,
        };
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },

    /**
     * Records the user's acceptance of `version` at `at` (D2c decision 6).
     * True when it changed the row; false for a soft-deleted or unknown
     * user, or one who had already accepted this version, whose acceptance
     * time is kept.
     */
    async acceptTerms(userId: string, version: string, at: Date): Promise<boolean> {
      const result = await db
        .updateTable("users")
        .set({ accepted_terms_version: version, terms_accepted_at: at, updated_at: at })
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .where("accepted_terms_version", "is distinct from", version)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    /**
     * The user's current password hash, read `for share` so it cannot change
     * until the caller's transaction ends: a concurrent
     * `setPasswordAndConfirmEmail` waits on it, and this waits on one already
     * holding the row. `undefined` for an unknown or soft-deleted user.
     * Meaningful only bound to a transaction; outside one the lock ends with
     * the statement.
     */
    async findPasswordHashForShare(userId: string): Promise<string | null | undefined> {
      const row = await db
        .selectFrom("users")
        .select("password_hash")
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .forShare()
        .executeTakeFirst();
      return row ? row.password_hash : undefined;
    },

    /**
     * Locks the user's row `for update` until the caller's transaction ends,
     * so work on one user that must not interleave queues behind it. A
     * missing row locks nothing. Meaningful only bound to a transaction.
     */
    async lockForUpdate(userId: string): Promise<void> {
      await db.selectFrom("users").select("id").where("id", "=", userId).forUpdate().execute();
    },
  };
  return repository;
}
