import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import { createDb, createPool, type Database } from "@telflo/db";
import { addMembership, createUserWithOrganization, removeMembership, truncateAll } from "@telflo/db/testing";
import { createSessionRepository, type ISessionRepository } from "./session-repository.js";
import { createRefreshTokenRepository, type IRefreshTokenRepository } from "./refresh-token-repository.js";
import { withUserContext } from "../../../database/context.js";

const UNKNOWN_ID = "0190a5b0-0000-7000-8000-000000000000";

describe("sessions repositories", () => {
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The repositories' connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let sessions: ISessionRepository;
  let refreshTokens: IRefreshTokenRepository;

  beforeAll(() => {
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(process.env.TELFLO_DATABASE_URL!));
    sessions = createSessionRepository(db);
    refreshTokens = createRefreshTokenRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A verified user with a personal organization, signed in to it. */
  const signedInUser = async (overrides: Parameters<typeof createUserWithOrganization>[1] = {}) => {
    const account = await createUserWithOrganization(ownerDb, overrides);
    const session = await sessions.create({
      userId: account.user.id,
      activeOrganizationId: account.organization.id,
      ipAddress: "203.0.113.7",
      userAgent: "vitest",
    });
    return { ...account, session };
  };

  const future = () => new Date(Date.now() + 3_600_000);

  /**
   * `findLiveWithUser` as refresh runs it: in the session's user's database
   * context, without which row-level security hides every membership.
   */
  const findLive = async (sessionId: string) => {
    const row = await ownerDb.selectFrom("sessions").select("user_id").where("id", "=", sessionId).executeTakeFirst();
    return withUserContext(db, row?.user_id ?? UNKNOWN_ID, (transaction) =>
      createSessionRepository(transaction).findLiveWithUser(sessionId),
    );
  };

  /**
   * Resolves once `count` backends other than `lockerPid` are waiting on a
   * lock while running a statement against refresh_tokens; throws after
   * five seconds rather than hanging the suite.
   */
  const waitForBlockedBackends = async (lockerPid: number, count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await sql<{ blocked: number }>`
        select count(*)::int as blocked
        from pg_stat_activity
        where datname = current_database()
          and pid <> ${lockerPid}
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%refresh_tokens%'
      `.execute(ownerDb);
      if ((rows[0]?.blocked ?? 0) >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} backends blocked on refresh_tokens`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  describe("session repository", () => {
    it("creates a session with camelCase properties and no revocation", async () => {
      const { user, organization, session } = await signedInUser();
      expect(session).toMatchObject({
        userId: user.id,
        activeOrganizationId: organization.id,
        ipAddress: "203.0.113.7",
        userAgent: "vitest",
        revokedAt: null,
        revokedReason: null,
      });
      expect(session.lastRefreshedAt).toBeInstanceOf(Date);
      expect(session).not.toHaveProperty("user_id");
    });

    it("stores an IPv6 address in the inet column", async () => {
      const { user, organization } = await createUserWithOrganization(ownerDb);
      const session = await sessions.create({
        userId: user.id,
        activeOrganizationId: organization.id,
        ipAddress: "2001:db8::1",
        userAgent: null,
      });
      expect(session.ipAddress).toBe("2001:db8::1");
    });

    it("finds a live session with its user, active organization and role", async () => {
      const { user, organization, session } = await signedInUser({ role: "contributor" });
      const live = await findLive(session.id);
      expect(live?.session.id).toBe(session.id);
      expect(live?.user).toEqual({
        id: user.id,
        email: user.email,
        acceptedTermsVersion: "2026-01-01",
        isProductAdmin: false,
      });
      expect(live?.organization).toEqual({
        id: organization.id,
        name: organization.name,
        type: "personal",
        logoId: null,
        role: "contributor",
      });
    });

    it("reads the user's accepted terms version, null for a user who has accepted none (D7 decision 10)", async () => {
      const { session } = await signedInUser({
        user: { accepted_terms_version: null, terms_accepted_at: null },
      });
      expect((await findLive(session.id))?.user.acceptedTermsVersion).toBeNull();
    });

    it("reads the user's product-admin flag from the row, each time, so the owner's change shows on the next read (D12 decision 3)", async () => {
      const { user, session } = await signedInUser({ user: { is_product_admin: true } });
      expect((await findLive(session.id))?.user.isProductAdmin).toBe(true);

      await ownerDb.updateTable("users").set({ is_product_admin: false }).where("id", "=", user.id).execute();
      expect((await findLive(session.id))?.user.isProductAdmin).toBe(false);
    });

    it("reports the role in the active organization, not in another membership", async () => {
      const { user } = await createUserWithOrganization(ownerDb, { role: "admin" });
      const group = await addMembership(ownerDb, { userId: user.id, role: "contributor" });
      const session = await sessions.create({
        userId: user.id,
        activeOrganizationId: group.organization.id,
        ipAddress: null,
        userAgent: null,
      });
      const live = await findLive(session.id);
      expect(live?.organization).toEqual({
        id: group.organization.id,
        name: group.organization.name,
        type: "group",
        logoId: null,
        role: "contributor",
      });
    });

    it("reads the active organization's logo id (D23-2 decision 40)", async () => {
      const { user } = await createUserWithOrganization(ownerDb, { role: "admin" });
      const group = await addMembership(ownerDb, { userId: user.id, role: "contributor" });
      const logoId = "0199e000-0000-7000-8000-00000000a001";
      await ownerDb
        .updateTable("organizations")
        .set({ logo_id: logoId, logo_content_type: "image/webp" })
        .where("id", "=", group.organization.id)
        .execute();
      const session = await sessions.create({
        userId: user.id,
        activeOrganizationId: group.organization.id,
        ipAddress: null,
        userAgent: null,
      });
      expect((await findLive(session.id))?.organization.logoId).toBe(logoId);
    });

    it("does not find an unknown session", async () => {
      expect(await findLive(UNKNOWN_ID)).toBeUndefined();
    });

    it("finds nothing outside a database context: row-level security hides the membership", async () => {
      const { session } = await signedInUser();
      expect(await findLive(session.id)).toBeDefined();
      expect(await sessions.findLiveWithUser(session.id)).toBeUndefined();
    });

    it("does not find a session whose user has lost the membership of its active organization", async () => {
      // The invariant refuses deleting a user's only membership, so the user
      // keeps their personal one and loses a second, group membership.
      const { user } = await createUserWithOrganization(ownerDb);
      const group = await addMembership(ownerDb, { userId: user.id });
      const session = await sessions.create({
        userId: user.id,
        activeOrganizationId: group.organization.id,
        ipAddress: null,
        userAgent: null,
      });
      expect(await findLive(session.id)).toBeDefined();

      await ownerDb.deleteFrom("organization_members").where("id", "=", group.membership.id).execute();

      expect(await findLive(session.id)).toBeUndefined();
    });

    it("does not find a session whose membership of its active organization was removed", async () => {
      const { user } = await createUserWithOrganization(ownerDb);
      const group = await addMembership(ownerDb, { userId: user.id });
      const session = await sessions.create({
        userId: user.id,
        activeOrganizationId: group.organization.id,
        ipAddress: null,
        userAgent: null,
      });
      expect(await findLive(session.id)).toBeDefined();

      await removeMembership(ownerDb, { userId: user.id, organizationId: group.organization.id });

      expect(await findLive(session.id)).toBeUndefined();
    });

    it("does not find a session whose active organization is soft-deleted", async () => {
      // The invariant needs a live membership in a live organization to remain.
      const { user, organization, session } = await signedInUser();
      await addMembership(ownerDb, { userId: user.id });
      await ownerDb
        .updateTable("organizations")
        .set({ deleted_at: new Date() })
        .where("id", "=", organization.id)
        .execute();
      expect(await findLive(session.id)).toBeUndefined();
    });

    it("does not find a revoked session", async () => {
      const { session } = await signedInUser();
      await sessions.revoke(session.id, "logout");
      expect(await findLive(session.id)).toBeUndefined();
    });

    it("does not find a session whose user is soft-deleted", async () => {
      const { user, session } = await signedInUser();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", user.id).execute();
      expect(await findLive(session.id)).toBeUndefined();
    });

    it("does not find a session whose user is unverified", async () => {
      const { session } = await signedInUser({ user: { email_verified_at: null } });
      expect(await findLive(session.id)).toBeUndefined();
    });

    it("revokes idempotently, reporting whether the call revoked the session", async () => {
      const { session } = await signedInUser();
      expect(await sessions.revoke(session.id, "logout")).toBe(true);
      expect(await sessions.revoke(session.id, "sign_out_everywhere")).toBe(false);

      const row = await ownerDb
        .selectFrom("sessions")
        .select(["revoked_at", "revoked_reason"])
        .where("id", "=", session.id)
        .executeTakeFirstOrThrow();
      expect(row.revoked_reason).toBe("logout");
      expect(row.revoked_at).toBeInstanceOf(Date);
    });

    it("reports false when revoking an unknown session", async () => {
      expect(await sessions.revoke("0190a5b0-0000-7000-8000-000000000000", "logout")).toBe(false);
    });

    it("revokes all of a user's live sessions and leaves other users' sessions live", async () => {
      const first = await signedInUser();
      const second = await sessions.create({
        userId: first.user.id,
        activeOrganizationId: first.organization.id,
        ipAddress: null,
        userAgent: null,
      });
      const alreadyRevoked = await sessions.create({
        userId: first.user.id,
        activeOrganizationId: first.organization.id,
        ipAddress: null,
        userAgent: null,
      });
      await sessions.revoke(alreadyRevoked.id, "logout");
      const other = await signedInUser();

      expect(await sessions.revokeAllForUser(first.user.id, "sign_out_everywhere")).toBe(2);

      expect(await findLive(first.session.id)).toBeUndefined();
      expect(await findLive(second.id)).toBeUndefined();
      expect(await findLive(other.session.id)).toBeDefined();
    });

    it("lockLive locks a live session for update until the transaction ends", async () => {
      const { session } = await signedInUser();
      await db.transaction().execute(async (transaction) => {
        expect(await createSessionRepository(transaction).lockLive(session.id)).toMatchObject({ id: session.id });
        const probe = ownerDb
          .transaction()
          .execute((probing) => sql`select 1 from sessions where id = ${session.id} for share nowait`.execute(probing));
        await expect(probe).rejects.toMatchObject({ code: "55P03" });
      });
    });

    it("findLive reads a live session without locking it, and finds neither a revoked nor an unknown one", async () => {
      const { session } = await signedInUser();
      await db.transaction().execute(async (transaction) => {
        expect(await createSessionRepository(transaction).findLive(session.id)).toMatchObject({ id: session.id });
        const probe = ownerDb
          .transaction()
          .execute((probing) => sql`select 1 from sessions where id = ${session.id} for update nowait`.execute(probing));
        await expect(probe).resolves.toBeDefined();
      });
      await sessions.revoke(session.id, "logout");
      expect(await sessions.findLive(session.id)).toBeUndefined();
      expect(await sessions.findLive(UNKNOWN_ID)).toBeUndefined();
    });

    it("findLiveForShare holds the user's live session for share until the transaction ends", async () => {
      const { user, session } = await signedInUser();
      await db.transaction().execute(async (transaction) => {
        expect(await createSessionRepository(transaction).findLiveForShare(session.id, user.id)).toMatchObject({
          id: session.id,
          userId: user.id,
        });
        const update = ownerDb
          .transaction()
          .execute((probing) => sql`select 1 from sessions where id = ${session.id} for update nowait`.execute(probing));
        await expect(update).rejects.toMatchObject({ code: "55P03" });
        const share = ownerDb
          .transaction()
          .execute((probing) => sql`select 1 from sessions where id = ${session.id} for share nowait`.execute(probing));
        await expect(share).resolves.toBeDefined();
      });
    });

    it("findLiveForShare finds neither another user's session, nor a revoked or an unknown one", async () => {
      const { user, session } = await signedInUser();
      const stranger = await signedInUser();

      expect(await sessions.findLiveForShare(stranger.session.id, user.id)).toBeUndefined();
      expect(await sessions.findLiveForShare(session.id, stranger.user.id)).toBeUndefined();
      expect(await sessions.findLiveForShare(UNKNOWN_ID, user.id)).toBeUndefined();
      await sessions.revoke(session.id, "logout");
      expect(await sessions.findLiveForShare(session.id, user.id)).toBeUndefined();
      expect(await sessions.findLiveForShare(stranger.session.id, stranger.user.id)).toMatchObject({ id: stranger.session.id });
    });

    it("lockLive finds neither a revoked nor an unknown session", async () => {
      const { session } = await signedInUser();
      await sessions.revoke(session.id, "logout");
      expect(await sessions.lockLive(session.id)).toBeUndefined();
      expect(await sessions.lockLive(UNKNOWN_ID)).toBeUndefined();
    });

    it("points a session at another organization, and no other session", async () => {
      const { user, organization, session } = await signedInUser();
      const group = await addMembership(ownerDb, { userId: user.id });
      const other = await sessions.create({
        userId: user.id,
        activeOrganizationId: organization.id,
        ipAddress: null,
        userAgent: null,
      });

      await sessions.setActiveOrganization(session.id, group.organization.id);

      const rows = await ownerDb.selectFrom("sessions").select(["id", "active_organization_id"]).execute();
      expect(rows.find((row) => row.id === session.id)?.active_organization_id).toBe(group.organization.id);
      expect(rows.find((row) => row.id === other.id)?.active_organization_id).toBe(organization.id);
    });

    it("finds the active organization of the user's most recently used session, revoked or not: refreshed last, then made last (D36-1 decision 56)", async () => {
      const { user, organization, session } = await signedInUser();
      const group = await addMembership(ownerDb, { userId: user.id });
      const other = await signedInUser();
      expect(await sessions.findMostRecentlyUsedOrganizationId(user.id)).toBe(organization.id);
      expect(await sessions.findMostRecentlyUsedOrganizationId(UNKNOWN_ID)).toBeUndefined();

      // A newer session, made later, in the group: it is the most recently used.
      const later = await sessions.create({ userId: user.id, activeOrganizationId: group.organization.id, ipAddress: null, userAgent: null });
      expect(await sessions.findMostRecentlyUsedOrganizationId(user.id)).toBe(group.organization.id);
      // The first one refreshed after it, then signed out: it is, revoked as it is.
      await sessions.touchRefreshed(session.id, new Date(later.lastRefreshedAt.getTime() + 60_000));
      await sessions.revoke(session.id, "logout");
      expect(await sessions.findMostRecentlyUsedOrganizationId(user.id)).toBe(organization.id);
      // Never another user's.
      expect(await sessions.findMostRecentlyUsedOrganizationId(other.user.id)).toBe(other.organization.id);
    });

    it("records when a session was last refreshed", async () => {
      const { session } = await signedInUser();
      const at = new Date("2030-01-02T03:04:05.000Z");
      await sessions.touchRefreshed(session.id, at);
      const live = await findLive(session.id);
      expect(live?.session.lastRefreshedAt).toEqual(at);
    });
  });

  describe("the sessions list and signing out one session (D21 decision 40, Preflight rulings 13 and 14)", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = new Date("2030-06-01T12:00:00.000Z");
    /** Live means refreshed after this: now less a 30-day refresh lifetime. */
    const liveSince = new Date(now.getTime() - 30 * DAY);

    /** Another session of the user, last refreshed at `lastRefreshedAt` (written directly: sign-in stamps the database's clock). */
    const anotherSession = async (
      account: { user: { id: string }; organization: { id: string } },
      lastRefreshedAt: Date,
      ipAddress: string | null = null,
    ) => {
      const session = await sessions.create({
        userId: account.user.id,
        activeOrganizationId: account.organization.id,
        ipAddress,
        userAgent: null,
      });
      await ownerDb.updateTable("sessions").set({ last_refreshed_at: lastRefreshedAt }).where("id", "=", session.id).execute();
      return session.id;
    };

    const sessionRow = (id: string) =>
      ownerDb
        .selectFrom("sessions")
        .select(["revoked_at", "revoked_reason"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

    it("lists only live sessions: a revoked one and one idle past the refresh lifetime are left out", async () => {
      const account = await signedInUser();
      await ownerDb.updateTable("sessions").set({ last_refreshed_at: now }).where("id", "=", account.session.id).execute();
      const recent = await anotherSession(account, new Date(now.getTime() - DAY));
      const revoked = await anotherSession(account, new Date(now.getTime() - DAY));
      await sessions.revoke(revoked, "logout");
      await anotherSession(account, liveSince);
      await anotherSession(account, new Date(liveSince.getTime() - DAY));
      const other = await signedInUser();
      await ownerDb.updateTable("sessions").set({ last_refreshed_at: now }).where("id", "=", other.session.id).execute();

      const page = await sessions.listLiveForUser(account.user.id, account.session.id, liveSince, 100);

      expect(page.sessions.map((session) => session.id)).toEqual([account.session.id, recent]);
      expect(page.total).toBe(2);
    });

    it("reads the address as inet's own text, never cast (no /32)", async () => {
      const account = await signedInUser();
      await ownerDb.updateTable("sessions").set({ last_refreshed_at: now }).where("id", "=", account.session.id).execute();
      await anotherSession(account, now, "2001:db8::1");

      const page = await sessions.listLiveForUser(account.user.id, account.session.id, liveSince, 100);

      expect(page.sessions.map((session) => session.ipAddress).sort()).toEqual(["2001:db8::1", "203.0.113.7"]);
    });

    it("puts the current one first and keeps it at the 101st", async () => {
      const account = await signedInUser();
      // The current session is the least recently active of 101.
      await ownerDb
        .updateTable("sessions")
        .set({ last_refreshed_at: new Date(now.getTime() - 2 * DAY) })
        .where("id", "=", account.session.id)
        .execute();
      const others: string[] = [];
      for (let index = 0; index < 100; index += 1) {
        others.push(await anotherSession(account, new Date(now.getTime() - DAY + index * 1000)));
      }

      const page = await sessions.listLiveForUser(account.user.id, account.session.id, liveSince, 100);

      expect(page.sessions).toHaveLength(100);
      expect(page.sessions[0]!.id).toBe(account.session.id);
      // Then by last activity, newest first: the oldest of the others is the one left out.
      expect(page.sessions.slice(1).map((session) => session.id)).toEqual(others.slice(1).reverse());
      expect(page.total).toBe(101);
    });

    it("counts the total exactly", async () => {
      const account = await signedInUser();
      await ownerDb.updateTable("sessions").set({ last_refreshed_at: now }).where("id", "=", account.session.id).execute();
      for (let index = 0; index < 4; index += 1) await anotherSession(account, now);

      expect((await sessions.listLiveForUser(account.user.id, account.session.id, liveSince, 2)).total).toBe(5);
      expect((await sessions.listLiveForUser(account.user.id, account.session.id, liveSince, 100)).total).toBe(5);
      const nobody = await createUserWithOrganization(ownerDb);
      expect(await sessions.listLiveForUser(nobody.user.id, UNKNOWN_ID, liveSince, 100)).toEqual({ sessions: [], total: 0 });
    });

    it("revokeOwn revokes only the user's own live session", async () => {
      const account = await signedInUser();
      const at = new Date("2030-06-01T12:34:56.000Z");
      const target = await anotherSession(account, now);
      const idle = await anotherSession(account, new Date(liveSince.getTime() - DAY));
      const ended = await anotherSession(account, now);
      await sessions.revoke(ended, "logout");
      const endedBefore = await sessionRow(ended);
      const stranger = await signedInUser();
      // Live by the same clock, so only the user's filter refuses it.
      await ownerDb.updateTable("sessions").set({ last_refreshed_at: now }).where("id", "=", stranger.session.id).execute();

      // Another user's, an unknown, an idle and an ended session: refused alike, nothing changed.
      expect(await sessions.revokeOwn(stranger.session.id, account.user.id, account.session.id, liveSince, "signed_out_elsewhere", at)).toBe(false);
      expect(await sessions.revokeOwn(UNKNOWN_ID, account.user.id, account.session.id, liveSince, "signed_out_elsewhere", at)).toBe(false);
      expect(await sessions.revokeOwn(idle, account.user.id, account.session.id, liveSince, "signed_out_elsewhere", at)).toBe(false);
      expect(await sessions.revokeOwn(ended, account.user.id, account.session.id, liveSince, "signed_out_elsewhere", at)).toBe(false);
      expect(await sessionRow(stranger.session.id)).toEqual({ revoked_at: null, revoked_reason: null });
      expect(await sessionRow(idle)).toEqual({ revoked_at: null, revoked_reason: null });
      expect(await sessionRow(ended)).toEqual(endedBefore);

      expect(await sessions.revokeOwn(target, account.user.id, account.session.id, liveSince, "signed_out_elsewhere", at)).toBe(true);
      expect(await sessionRow(target)).toEqual({ revoked_at: at, revoked_reason: "signed_out_elsewhere" });
      // Once: a second call changes nothing.
      expect(await sessions.revokeOwn(target, account.user.id, account.session.id, liveSince, "signed_out_elsewhere", now)).toBe(false);
      expect(await sessionRow(target)).toEqual({ revoked_at: at, revoked_reason: "signed_out_elsewhere" });
      expect(await sessionRow(account.session.id)).toEqual({ revoked_at: null, revoked_reason: null });
    });

    it("revokeOwn never revokes the caller's current session, in any case (Ruling 85's defence in depth)", async () => {
      const account = await signedInUser();
      const at = new Date("2030-06-01T12:34:56.000Z");
      // Live by the same clock, so only the current-session filter refuses it.
      await ownerDb.updateTable("sessions").set({ last_refreshed_at: now }).where("id", "=", account.session.id).execute();
      const current = account.session.id;

      expect(await sessions.revokeOwn(current, account.user.id, current, liveSince, "signed_out_elsewhere", at)).toBe(false);
      expect(
        await sessions.revokeOwn(current.toUpperCase(), account.user.id, current, liveSince, "signed_out_elsewhere", at),
      ).toBe(false);
      expect(
        await sessions.revokeOwn(current, account.user.id, current.toUpperCase(), liveSince, "signed_out_elsewhere", at),
      ).toBe(false);
      expect(await sessionRow(current)).toEqual({ revoked_at: null, revoked_reason: null });
    });
  });

  describe("refresh token repository", () => {
    it("consumes a token once, then reports already_consumed with its session and user, expiry and consumption time", async () => {
      const { user, session } = await signedInUser();
      const expiresAt = future();
      await refreshTokens.create({ sessionId: session.id, tokenHash: "hash-once", expiresAt });
      const consumedAt = new Date("2030-01-02T03:04:05.678Z");

      expect(await refreshTokens.consume("hash-once", consumedAt)).toEqual({
        status: "consumed",
        sessionId: session.id,
        userId: user.id,
        expiresAt,
      });
      // The later presentation's own time is not what it reports: it
      // carries the consumedAt the first one wrote.
      expect(await refreshTokens.consume("hash-once", new Date("2030-01-02T03:04:09.000Z"))).toEqual({
        status: "already_consumed",
        sessionId: session.id,
        userId: user.id,
        expiresAt,
        consumedAt,
      });
    });

    it("consumes an expired token, leaving the expiry check to the caller", async () => {
      const { user, session } = await signedInUser();
      const expiresAt = new Date(Date.now() - 1_000);
      await refreshTokens.create({ sessionId: session.id, tokenHash: "hash-expired", expiresAt });
      expect(await refreshTokens.consume("hash-expired", new Date())).toEqual({
        status: "consumed",
        sessionId: session.id,
        userId: user.id,
        expiresAt,
      });
    });

    it("records the consumption time it is given", async () => {
      const { session } = await signedInUser();
      await refreshTokens.create({ sessionId: session.id, tokenHash: "hash-at", expiresAt: future() });
      const at = new Date("2030-01-02T03:04:05.000Z");
      await refreshTokens.consume("hash-at", at);
      const row = await ownerDb
        .selectFrom("refresh_tokens")
        .select("consumed_at")
        .where("token_hash", "=", "hash-at")
        .executeTakeFirstOrThrow();
      expect(row.consumed_at).toEqual(at);
    });

    it("reports not_found for an unknown hash", async () => {
      expect(await refreshTokens.consume("never-issued", new Date())).toEqual({ status: "not_found" });
    });

    it("of two concurrent consumes of one token, exactly one consumes and the other sees already_consumed", async () => {
      // Forces the overlap rather than hoping for it. A separate connection
      // holds the token's row lock while both consumes start, and is
      // released only once both are blocked at the database. Both then race
      // for the same row: an implementation that reads first and updates
      // after, or whose UPDATE lacks `consumed_at is null`, sees two
      // `consumed`.
      const { session } = await signedInUser();
      await refreshTokens.create({ sessionId: session.id, tokenHash: "hash-race", expiresAt: future() });

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from refresh_tokens where token_hash = $1 for update", ["hash-race"]);
        const lockerPid = (await locker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

        const racing = Promise.all([
          refreshTokens.consume("hash-race", new Date()),
          refreshTokens.consume("hash-race", new Date()),
        ]);
        // Keeps an early rejection from going unhandled while we wait.
        racing.catch(() => undefined);

        await waitForBlockedBackends(lockerPid, 2);

        await locker.query("rollback");
        lockerInTransaction = false;

        const results = await racing;
        expect(results.map((result) => result.status).sort()).toEqual(["already_consumed", "consumed"]);
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });
  });
});
