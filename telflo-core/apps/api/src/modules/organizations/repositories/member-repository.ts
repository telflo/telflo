import type { Selectable, Transaction } from "kysely";
import type { Database, OrganizationMembersTable, OrganizationRole, UserKind } from "@telflo/db";
import { createOrganizationScope, type OrganizationScopeContext } from "../../../tenancy/organization-scope.js";

/*
 * The members of the context's organization (D5 decisions 5, 7 and 8),
 * through the organization scope. Row-level security on
 * organization_members (decision 3) stands behind it: the transaction must
 * carry a database context naming the same organization, or the policies
 * show and admit nothing.
 */

/** A membership row, as registration and the switch see it. */
export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: Date;
}

/** A member as the Permissions page lists them (decision 7's member shape). */
export interface Member {
  userId: string;
  email: string;
  role: OrganizationRole;
  /** The user whose personal organization this is (Preflight ruling 11): their membership can't be changed. */
  isOrganizationOwner: boolean;
  createdAt: Date;
  /** When the member was removed; null for an active member. */
  deletedAt: Date | null;
  /**
   * Whether the account is a service account (`users.kind`, D22 decision
   * 30): the service refuses a role change, a removal or a restoration of
   * one with 409. Internal: the members' reply picks its fields and never
   * carries it, and `list()` holds people only.
   */
  isServiceAccount: boolean;
}

export interface AddMemberInput {
  userId: string;
  role: OrganizationRole;
}

function toOrganizationMembership(row: Selectable<OrganizationMembersTable>): OrganizationMembership {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export interface IMemberRepository {
  /**
   * Active and removed members with a live account, newest first: people
   * only, never a service account (D22 decision 30), so the Permissions
   * page's rows and its three counts leave them out.
   */
  list(): Promise<Member[]>;
  /**
   * One member, active or removed, of either kind (`isServiceAccount` says
   * which). Undefined when there is no membership or the account is deleted.
   */
  find(userId: string): Promise<Member | undefined>;
  /**
   * The member whose account holds `email` (lowercased already, as the
   * account's is stored), active or removed; undefined when there is none
   * or the account is deleted. Inviting checks it (D6 decision 8), and it
   * says nothing about whether an account exists outside the organization.
   */
  findByEmail(email: string): Promise<Member | undefined>;
  /**
   * The user's live membership, locked `for share` until the transaction
   * ends, so a concurrent removal waits for it (decision 10's switch).
   * Undefined when there is none, or it is removed.
   */
  findForShare(userId: string): Promise<OrganizationMembership | undefined>;
  add(input: AddMemberInput): Promise<OrganizationMembership>;
  /** Changes an active member's role. False when there is no active member, or the role is already that. */
  changeRole(userId: string, role: OrganizationRole): Promise<boolean>;
  /** Removes an active member softly. False when there is no active member. */
  remove(userId: string, at: Date): Promise<boolean>;
  /** Restores a removed member. False when there is no removed member. */
  restore(userId: string): Promise<boolean>;
  /**
   * Locks the accounts of the organization's live members (only `userId`'s,
   * when given) `for no key update`, in id order, until the transaction
   * ends. The membership invariant takes the same lock at commit (migration
   * 1700000000012), on the users a removal or a deletion may strand. Taken
   * here first, before any of their sessions: a password reset or a takeover
   * locks the user and then revokes their sessions, so a removal holding a
   * reassigned session and only then, at commit, asking for the user would
   * deadlock with one (40P01). One statement, in id order, so two deletions
   * sharing members lock them in the same order.
   *
   * A restore doesn't call this: it touches no session, and takes the
   * member's lock only at commit, holding the organization and the
   * membership. That is a new wait (organization -> user), and it is safe
   * because nothing locks a session and then an organization any more: the
   * switch locks its target organization before its session (Ruling 22).
   * Every path goes organization -> user -> session.
   */
  lockAccounts(userId?: string): Promise<void>;
  /**
   * The joining user's own account, locked `for share` until the
   * transaction ends; whether it is still live under the lock (D29 Ruling
   * 271: an invitation's acceptance). `users` is global and has no
   * row-level security, so any context may lock it. A product admin's
   * delete holding the row `for update` makes this wait, and the row it
   * then reads is the committed one: deleted, false.
   */
  lockJoiningAccountForShare(userId: string): Promise<boolean>;
  /**
   * A removed member's account, locked `for no key update` until the
   * transaction ends; whether it is still live under the lock (D29 Ruling
   * 272: a restore). The mode the membership invariant's commit-time
   * trigger takes on the same row (migration 1700000000012), so the
   * trigger needs no upgrade: two restores of one person in two
   * organizations queue here rather than deadlock. A product admin's
   * delete holding the row `for update` makes this wait, and the row it
   * then reads is the committed one: deleted, false.
   */
  lockRestoredAccount(userId: string): Promise<boolean>;
}

/** Bound to a transaction that carries the database context and to the context whose organization it acts on. */
export function createMemberRepository(
  transaction: Transaction<Database>,
  context: OrganizationScopeContext,
): IMemberRepository {
  const scope = createOrganizationScope(transaction, context);

  /** Members with a live account, of either kind, joined to their email and kind and to the organization's owner. */
  const members = () =>
    scope
      .selectFrom("organization_members")
      .innerJoin("users", "users.id", "organization_members.user_id")
      .innerJoin("organizations", "organizations.id", "organization_members.organization_id")
      .select([
        "organization_members.user_id as userId",
        "users.email as email",
        "organization_members.role as role",
        "organization_members.created_at as createdAt",
        "organization_members.deleted_at as deletedAt",
        "organizations.owner_user_id as ownerUserId",
        "users.kind as kind",
      ])
      .where("users.deleted_at", "is", null);

  const toMember = ({
    ownerUserId,
    kind,
    ...member
  }: Omit<Member, "isOrganizationOwner" | "isServiceAccount"> & { ownerUserId: string | null; kind: UserKind }): Member => ({
    ...member,
    isOrganizationOwner: ownerUserId === member.userId,
    isServiceAccount: kind === "service",
  });

  return {
    async list(): Promise<Member[]> {
      const rows = await members()
        .where("users.kind", "=", "human")
        .orderBy("organization_members.created_at", "desc")
        .orderBy("organization_members.id", "desc")
        .execute();
      return rows.map(toMember);
    },

    async find(userId: string): Promise<Member | undefined> {
      const row = await members().where("organization_members.user_id", "=", userId).executeTakeFirst();
      return row ? toMember(row) : undefined;
    },

    async findByEmail(email: string): Promise<Member | undefined> {
      const row = await members().where("users.email", "=", email).executeTakeFirst();
      return row ? toMember(row) : undefined;
    },

    // No join: a `for share` over a join would lock the joined rows too
    // (Preflight ruling 8). Under row-level security a locking read applies
    // the update policy (Preflight ruling 1), so the context must name this
    // organization, as the scope's filter does.
    async findForShare(userId: string): Promise<OrganizationMembership | undefined> {
      const row = await scope
        .selectFrom("organization_members")
        .selectAll()
        .where("user_id", "=", userId)
        .where("deleted_at", "is", null)
        .forShare()
        .executeTakeFirst();
      return row ? toOrganizationMembership(row) : undefined;
    },

    async add(input: AddMemberInput): Promise<OrganizationMembership> {
      const row = await scope
        .insertInto("organization_members", { user_id: input.userId, role: input.role })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toOrganizationMembership(row);
    },

    async changeRole(userId: string, role: OrganizationRole): Promise<boolean> {
      const result = await scope
        .updateTable("organization_members", { role, updated_at: new Date() })
        .where("user_id", "=", userId)
        .where("deleted_at", "is", null)
        .where("role", "<>", role)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async remove(userId: string, at: Date): Promise<boolean> {
      const result = await scope
        .updateTable("organization_members", { deleted_at: at, updated_at: at })
        .where("user_id", "=", userId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async restore(userId: string): Promise<boolean> {
      const result = await scope
        .updateTable("organization_members", { deleted_at: null, updated_at: new Date() })
        .where("user_id", "=", userId)
        .where("deleted_at", "is not", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    // `users` is global; the members are chosen through the scope. The
    // locking clause covers only the outer query's table, so the
    // memberships the subquery reads are not locked.
    async lockAccounts(userId?: string): Promise<void> {
      let live = scope.selectFrom("organization_members").select("user_id").where("deleted_at", "is", null);
      if (userId !== undefined) live = live.where("user_id", "=", userId);
      await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "in", live)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
    },

    async lockRestoredAccount(userId: string): Promise<boolean> {
      const row = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      return row !== undefined;
    },

    async lockJoiningAccountForShare(userId: string): Promise<boolean> {
      const row = await transaction
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .forShare()
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
