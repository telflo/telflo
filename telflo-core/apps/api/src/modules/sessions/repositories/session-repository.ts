import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { Database, OrganizationRole, OrganizationType, SessionRevokedReason, SessionsTable } from "@telflo/db";

export interface Session {
  id: string;
  userId: string;
  activeOrganizationId: string;
  createdAt: Date;
  lastRefreshedAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateSessionInput {
  userId: string;
  activeOrganizationId: string;
  /** Already validated as an IP address by the caller (D2a decision 10). */
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * The user as the per-request check sees them: what identifies them, the
 * terms version they accepted, which `requireCurrentTerms` checks without a
 * query of its own (D7 decision 10), and whether they are a product admin,
 * which `requireProductAdmin` and `/me` read the same way (D12 decision 3).
 * Deliberately not identity's `User`: the
 * password hash and the other account columns never travel on the
 * per-request path. Distinct from the contracts package's `SessionUser`,
 * which is the wire shape.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  /** Null for a user who has accepted no terms: a federated sign-up, or a takeover (D2c decision 6). */
  acceptedTermsVersion: string | null;
  /**
   * The row's `is_product_admin` on this request: never cached, so an
   * operator's revocation takes effect on the user's next request.
   */
  isProductAdmin: boolean;
}

/** The session's active organization, with its type and the user's role in it. */
export interface SessionOrganization {
  id: string;
  name: string;
  type: OrganizationType;
  /** Its logo's id (D23-2 decision 40), null for none. */
  logoId: string | null;
  role: OrganizationRole;
}

export interface LiveSession {
  session: Session;
  user: AuthenticatedUser;
  organization: SessionOrganization;
}

/** The single place a sessions row becomes camelCase. */
function toSession(row: Selectable<SessionsTable>): Session {
  return {
    id: row.id,
    userId: row.user_id,
    activeOrganizationId: row.active_organization_id,
    createdAt: row.created_at,
    lastRefreshedAt: row.last_refreshed_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  };
}

/** A page of a user's live sessions, and how many they have in all. */
export interface LiveSessionsPage {
  sessions: Session[];
  total: number;
}

export interface ISessionRepository {
  create(input: CreateSessionInput): Promise<Session>;
  findLiveWithUser(sessionId: string): Promise<LiveSession | undefined>;
  /**
   * The session, unless revoked, unlocked: the switch's first read, which
   * decides whether it is a no-op before it takes any lock.
   */
  findLive(sessionId: string): Promise<Session | undefined>;
  /**
   * The session, unless revoked, locked `for update` until the transaction
   * ends: the switch's lock on it, taken after the target organization's
   * (Ruling 22).
   */
  lockLive(sessionId: string): Promise<Session | undefined>;
  /**
   * The user's session, unless revoked, held `for share` until the
   * transaction ends (D21 decision 38): a link's check that the session that
   * started it is still the user's and not signed out, taken after the
   * user's row (D3 Ruling 17). Another user's session is not found. Live
   * here means not revoked, without listLiveForUser's idle cut-off: a flow
   * lasts ten minutes, far inside the refresh token's lifetime.
   */
  findLiveForShare(sessionId: string, userId: string): Promise<Session | undefined>;
  /** Points a session at another organization. The caller has checked the membership under its locks. */
  setActiveOrganization(sessionId: string, organizationId: string): Promise<void>;
  revoke(sessionId: string, reason: SessionRevokedReason): Promise<boolean>;
  revokeAllForUser(userId: string, reason: SessionRevokedReason): Promise<number>;
  /**
   * The user's live sessions (D21 decision 40, Preflight ruling 13): not
   * revoked, and refreshed after `liveSince` (an idle session past the
   * refresh token's lifetime can never refresh). `currentSessionId` first,
   * then the most recently active, at most `limit`, with the exact total.
   */
  listLiveForUser(userId: string, currentSessionId: string, liveSince: Date, limit: number): Promise<LiveSessionsPage>;
  /**
   * Revokes one of the user's own live sessions (D21 decision 40, Preflight
   * ruling 14), stamped `at`. False for another user's, an unknown or an
   * ended session, alike, and for `currentSessionId`, the caller's own: the
   * route refuses that one first (409), and the database excludes it as
   * well, compared as uuids whatever the spelling (Ruling 85).
   */
  revokeOwn(
    sessionId: string,
    userId: string,
    currentSessionId: string,
    liveSince: Date,
    reason: SessionRevokedReason,
    at: Date,
  ): Promise<boolean>;
  touchRefreshed(sessionId: string, at: Date): Promise<void>;
  /**
   * The active organization of the user's most recently used session, revoked or not (D36-1 decision
   * 56, Q265): the one refreshed last (`last_refreshed_at`, which a session's creation sets and every
   * refresh advances, as the sessions list orders by it), then the newest. Undefined when the user has
   * no session. Unlocked and unchecked: the organization may since be deleted or left; a new sign-in
   * confirms it under its locks before landing there.
   */
  findMostRecentlyUsedOrganizationId(userId: string): Promise<string | undefined>;
}

export function createSessionRepository(db: Kysely<Database> | Transaction<Database>): ISessionRepository {
  return {
    async create(input: CreateSessionInput): Promise<Session> {
      const row = await db
        .insertInto("sessions")
        .values({
          user_id: input.userId,
          active_organization_id: input.activeOrganizationId,
          ip_address: input.ipAddress,
          user_agent: input.userAgent,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toSession(row);
    },

    /**
     * D2a decision 4's per-request check, in one query. A session counts as
     * live only while every link from it to an organization the user may act
     * as still holds: the session is not revoked, the user is neither
     * soft-deleted nor unverified, the active organization is not
     * soft-deleted, and the user is still a live member of it.
     *
     * The membership join, with its deleted_at filter, is the backstop that
     * refuses a removed member's session even if it was never reassigned (D5
     * decision 9 reassigns it in the removal's transaction). The
     * organization's deleted_at filter is needed separately: a live
     * membership can sit in a soft-deleted organization, so long as the user
     * has another in a live one.
     */
    async findLiveWithUser(sessionId: string): Promise<LiveSession | undefined> {
      const row = await db
        .selectFrom("sessions")
        .innerJoin("users", "users.id", "sessions.user_id")
        .innerJoin("organizations", "organizations.id", "sessions.active_organization_id")
        .innerJoin("organization_members", (join) =>
          join
            .onRef("organization_members.organization_id", "=", "sessions.active_organization_id")
            .onRef("organization_members.user_id", "=", "sessions.user_id"),
        )
        .selectAll("sessions")
        .select([
          "users.email as user_email",
          "users.accepted_terms_version as user_accepted_terms_version",
          "users.is_product_admin as user_is_product_admin",
          "organizations.name as organization_name",
          "organizations.type as organization_type",
          "organizations.logo_id as organization_logo_id",
          "organization_members.role as organization_role",
        ])
        .where("sessions.id", "=", sessionId)
        .where("sessions.revoked_at", "is", null)
        .where("users.deleted_at", "is", null)
        .where("users.email_verified_at", "is not", null)
        .where("organizations.deleted_at", "is", null)
        .where("organization_members.deleted_at", "is", null)
        .executeTakeFirst();
      if (!row) return undefined;
      return {
        session: toSession(row),
        user: {
          id: row.user_id,
          email: row.user_email,
          acceptedTermsVersion: row.user_accepted_terms_version,
          isProductAdmin: row.user_is_product_admin,
        },
        organization: {
          id: row.active_organization_id,
          name: row.organization_name,
          type: row.organization_type,
          logoId: row.organization_logo_id,
          role: row.organization_role,
        },
      };
    },

    async findLive(sessionId: string): Promise<Session | undefined> {
      const row = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return row ? toSession(row) : undefined;
    },

    // No join: a locking read over a join would lock the joined rows too
    // (Preflight ruling 8).
    async lockLive(sessionId: string): Promise<Session | undefined> {
      const row = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      return row ? toSession(row) : undefined;
    },

    // No join, as lockLive: a locking read over a join would lock the joined rows too.
    async findLiveForShare(sessionId: string, userId: string): Promise<Session | undefined> {
      const row = await db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .forShare()
        .executeTakeFirst();
      return row ? toSession(row) : undefined;
    },

    async setActiveOrganization(sessionId: string, organizationId: string): Promise<void> {
      await db
        .updateTable("sessions")
        .set({ active_organization_id: organizationId })
        .where("id", "=", sessionId)
        .execute();
    },

    /**
     * Idempotent: `revoked_at is null` sits in the UPDATE (Ruling 21), so a
     * second call, or a concurrent one, changes nothing and returns false.
     * The first revocation's reason and time are kept.
     */
    async revoke(sessionId: string, reason: SessionRevokedReason): Promise<boolean> {
      const result = await db
        .updateTable("sessions")
        .set({ revoked_at: new Date(), revoked_reason: reason })
        .where("id", "=", sessionId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    /** Revokes every live session of the user; returns how many it revoked. */
    async revokeAllForUser(userId: string, reason: SessionRevokedReason): Promise<number> {
      const result = await db
        .updateTable("sessions")
        .set({ revoked_at: new Date(), revoked_reason: reason })
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    /**
     * One query: the window's `count(*) over ()` is the total before the
     * limit. `ip_address` is read as the column (inet's own text, no `/32`),
     * never cast.
     */
    async listLiveForUser(
      userId: string,
      currentSessionId: string,
      liveSince: Date,
      limit: number,
    ): Promise<LiveSessionsPage> {
      const rows = await db
        .selectFrom("sessions")
        .selectAll()
        .select(sql<string>`count(*) over ()`.as("total"))
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .where("last_refreshed_at", ">", liveSince)
        .orderBy(sql`(id = ${currentSessionId})`, "desc")
        .orderBy("last_refreshed_at", "desc")
        .orderBy("id")
        .limit(limit)
        .execute();
      return { sessions: rows.map(toSession), total: rows.length === 0 ? 0 : Number(rows[0]!.total) };
    },

    /**
     * One update, scoped by the user and live as listed: `revoked_at is
     * null` keeps the first revocation's reason and time, as `revoke` does.
     * `id <> currentSessionId` is defence in depth behind the route's 409.
     */
    async findMostRecentlyUsedOrganizationId(userId: string): Promise<string | undefined> {
      const row = await db
        .selectFrom("sessions")
        .select("active_organization_id")
        .where("user_id", "=", userId)
        .orderBy("last_refreshed_at", "desc")
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
      return row?.active_organization_id;
    },

    async revokeOwn(
      sessionId: string,
      userId: string,
      currentSessionId: string,
      liveSince: Date,
      reason: SessionRevokedReason,
      at: Date,
    ): Promise<boolean> {
      const result = await db
        .updateTable("sessions")
        .set({ revoked_at: at, revoked_reason: reason })
        .where("id", "=", sessionId)
        .where("id", "<>", currentSessionId)
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .where("last_refreshed_at", ">", liveSince)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async touchRefreshed(sessionId: string, at: Date): Promise<void> {
      await db.updateTable("sessions").set({ last_refreshed_at: at }).where("id", "=", sessionId).execute();
    },
  };
}
