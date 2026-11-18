import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, OrganizationInvitationsTable, OrganizationRole, OrganizationType } from "@telflo/db";
import {
  createOrganizationScope,
  type OrganizationScopeContext,
  type ScopedUpdateable,
} from "../../../tenancy/organization-scope.js";

/*
 * The invitations of the context's organization (D6 decisions 1, 2 and 9),
 * through the organization scope. Row-level security on
 * organization_invitations (migration 1700000000013) stands behind it: the
 * transaction must carry a database context naming the same organization,
 * or the policies show and admit nothing.
 *
 * The one read that isn't scoped is `findInvitationByTokenHash`, below: an
 * invitee holds the token before they belong to the organization.
 *
 * No method returns the token's hash but `lockForUpdate`, whose caller
 * compares it with the token under the lock (Preflight ruling 1). Nothing
 * else needs it, and an object that doesn't carry it can't log it.
 */

/** An invitation in any state. Pending while neither accepted nor revoked; expired is the caller's comparison. */
export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  /** Null once the inviter's account is hard-deleted. */
  invitedByUserId: string | null;
  expiresAt: Date;
  /** "Invited At". */
  createdAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  revokedAt: Date | null;
}

/** An invitation as `lockForUpdate` returns it: with the hash of its current token. */
export interface LockedInvitation extends Invitation {
  tokenHash: string;
}

export interface CreateInvitationInput {
  /** Lowercased already: the contract lowercases it, and the table refuses anything else. */
  email: string;
  role: OrganizationRole;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
}

function toInvitation(row: Selectable<OrganizationInvitationsTable>): Invitation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    invitedByUserId: row.invited_by_user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    acceptedByUserId: row.accepted_by_user_id,
    revokedAt: row.revoked_at,
  };
}

/** Postgres error code for a unique-constraint (or unique-index) violation. */
const UNIQUE_VIOLATION = "23505";

/** One pending invitation per address per organization (migration 1700000000013). */
const ONE_PENDING_UNIQUE_INDEX = "uq_organization_invitations_one_pending";

/**
 * True only for a unique violation on the one-pending index. Checked by
 * name, not just by SQLSTATE, as identity's `isDuplicateEmailViolation` is:
 * a clash on the token hash, say, is a bug, and must surface as one, not be
 * reported to the admin as "already invited".
 */
function isOnePendingViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === ONE_PENDING_UNIQUE_INDEX
  );
}

/**
 * Thrown by `create` when the address already has a pending invitation to
 * the organization: normally a concurrent invite that committed first, since
 * the service checks `findPendingByEmail` before it inserts. The statement
 * failed, so the transaction it ran in is aborted: the caller lets it roll
 * back. It carries no cause: the database error's detail names the address,
 * and a caller has no use for it.
 */
export class InvitationAlreadyPendingError extends Error {
  constructor() {
    super("the address already has a pending invitation to this organization");
    this.name = "InvitationAlreadyPendingError";
  }
}

export interface IInvitationRepository {
  /** A new pending invitation. A pending one to the same address throws InvitationAlreadyPendingError. */
  create(input: CreateInvitationInput): Promise<Invitation>;
  /** Pending invitations, expired ones included, newest first. */
  listPending(): Promise<Invitation[]>;
  /** The invitation, if it is pending (expired or not). */
  findPending(id: string): Promise<Invitation | undefined>;
  /** The address's pending invitation (expired or not), if there is one. */
  findPendingByEmail(email: string): Promise<Invitation | undefined>;
  /**
   * The invitation in any state, locked `for update` until the transaction
   * ends, with its current token's hash; undefined when there is none. The
   * caller has already locked the organization (D6 decision 10). Under
   * row-level security a locking read applies the update policy, so the
   * context must name this organization.
   */
  lockForUpdate(id: string): Promise<LockedInvitation | undefined>;
  /**
   * A new token and expiry for a pending invitation, reviving an expired one,
   * sent `at`. False when it isn't pending.
   */
  reissue(id: string, tokenHash: string, expiresAt: Date, at: Date): Promise<boolean>;
  /** Cancels a pending invitation. False when it isn't pending. */
  revoke(id: string, at: Date): Promise<boolean>;
  /** Marks a pending invitation accepted by `userId`. False when it isn't pending. */
  markAccepted(id: string, userId: string, at: Date): Promise<boolean>;
  /**
   * Cancels every pending invitation `userId` sent, expired ones included,
   * and returns them, oldest first (D6 Ruling 17: an admin's invitations don't outlive
   * their removal or demotion). The caller holds the organization's lock,
   * which every other writer of these rows takes first, so this waits on
   * nothing. It changes no foreign-key column, so it takes no lock on a user.
   */
  revokePendingInvitedBy(userId: string, at: Date): Promise<Invitation[]>;
}

/** Bound to a transaction that carries the database context and to the context whose organization it acts on. */
export function createInvitationRepository(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): IInvitationRepository {
  const scope = createOrganizationScope(transaction, context);

  const pending = () =>
    scope
      .selectFrom("organization_invitations")
      .selectAll()
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null);

  /** Sets `values` on the invitation if it is pending; true when a row changed. */
  const updatePending = async (
    id: string,
    values: ScopedUpdateable<"organization_invitations">,
  ): Promise<boolean> => {
    const result = await scope
      .updateTable("organization_invitations", values)
      .where("id", "=", id)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  };

  return {
    async create(input: CreateInvitationInput): Promise<Invitation> {
      try {
        const row = await scope
          .insertInto("organization_invitations", {
            email: input.email,
            role: input.role,
            token_hash: input.tokenHash,
            invited_by_user_id: input.invitedByUserId,
            expires_at: input.expiresAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toInvitation(row);
      } catch (error) {
        if (isOnePendingViolation(error)) throw new InvitationAlreadyPendingError();
        throw error;
      }
    },

    async listPending(): Promise<Invitation[]> {
      const rows = await pending().orderBy("created_at", "desc").orderBy("id", "desc").execute();
      return rows.map(toInvitation);
    },

    async findPending(id: string): Promise<Invitation | undefined> {
      const row = await pending().where("id", "=", id).executeTakeFirst();
      return row ? toInvitation(row) : undefined;
    },

    async findPendingByEmail(email: string): Promise<Invitation | undefined> {
      const row = await pending().where("email", "=", email).executeTakeFirst();
      return row ? toInvitation(row) : undefined;
    },

    async lockForUpdate(id: string): Promise<LockedInvitation | undefined> {
      const row = await scope
        .selectFrom("organization_invitations")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      return row ? { ...toInvitation(row), tokenHash: row.token_hash } : undefined;
    },

    async reissue(id: string, tokenHash: string, expiresAt: Date, at: Date): Promise<boolean> {
      return updatePending(id, { token_hash: tokenHash, expires_at: expiresAt, updated_at: at });
    },

    async revoke(id: string, at: Date): Promise<boolean> {
      return updatePending(id, { revoked_at: at, updated_at: at });
    },

    async markAccepted(id: string, userId: string, at: Date): Promise<boolean> {
      return updatePending(id, { accepted_at: at, accepted_by_user_id: userId, updated_at: at });
    },

    async revokePendingInvitedBy(userId: string, at: Date): Promise<Invitation[]> {
      const rows = await scope
        .updateTable("organization_invitations", { revoked_at: at, updated_at: at })
        .where("invited_by_user_id", "=", userId)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .returningAll()
        .execute();
      // Oldest first, so the audit rows written for them are in a stable order: ids are uuidv7.
      return rows.map(toInvitation).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}

/** An invitation as its token finds it, before the invitee belongs to its organization. */
export interface InvitationByToken {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  organizationName: string;
  /** Personal or group: under invite-only, a personal one's invitation can't register (D36-1 decision 52). */
  organizationType: OrganizationType;
  /** False once the organization is soft-deleted. */
  organizationIsLive: boolean;
}

/**
 * The invitation whose token hashes to `tokenHash`, in any state, or
 * undefined. Outside the scope on purpose (D6 decision 9): it calls
 * organization_invitation_by_token_hash, the SECURITY DEFINER function that
 * reads past row-level security, and is that function's only caller. The
 * token is the credential; the caller decides what each state means, then
 * sets the database context to the invitation's organization for everything
 * after. The organization's type is read beside it from organizations
 * (no row-level security; the API's role reads it), by the id the function
 * found (D36-1 decision 52).
 */
export async function findInvitationByTokenHash(
  db: Kysely<Database>,
  tokenHash: string,
): Promise<InvitationByToken | undefined> {
  const { rows } = await sql<{
    id: string;
    organization_id: string;
    email: string;
    role: OrganizationRole;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
    organization_name: string;
    organization_type: OrganizationType;
    organization_is_live: boolean;
  }>`
    select f.*, o.type as organization_type
      from organization_invitation_by_token_hash(${tokenHash}) f
      join organizations o on o.id = f.organization_id
  `.execute(db);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    organizationName: row.organization_name,
    organizationType: row.organization_type,
    organizationIsLive: row.organization_is_live,
  };
}
