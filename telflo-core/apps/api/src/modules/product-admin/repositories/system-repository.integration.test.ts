import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { addUserFeedback, createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { createSystemRepository, type ISystemRepository, type ProductAdminActor } from "./system-repository.js";

/*
 * The SystemRepository (D29 decisions 19 and 20; Rulings 257 and 258): each
 * method through the real product-admin functions as the API's role, and
 * the audit row it writes in the same transaction: in no organization, the
 * actor's columns, `metadata` holding ids, counts and fixed values only
 * (never an email, a search term or a feedback's text, checked as
 * booleans); a write's refusals as `product_admin.refused` `{ operation,
 * outcome }`, a grant of an admin as `product_admin.grant_unchanged`; the
 * pending count unaudited; the gate's 42501 answered 403
 * `product_admin_required` with nothing written. The functions' search,
 * blocks and races are the tasks' suites' and
 * tenancy/product-admin-functions.integration.test.ts's.
 */

describe("the SystemRepository", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let repository: ISystemRepository;
  const at = new Date(Date.UTC(2026, 9, 26, 10, 0, 0));

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    repository = createSystemRepository(db);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  const person = async (admin = false) => {
    const created = await createUserWithOrganization(ownerDb, { user: { email: `person-${randomUUID()}@example.com`, is_product_admin: admin } });
    return { userId: created.user.id, email: created.user.email, organizationId: created.organization.id };
  };
  const actorOf = (who: { userId: string; email: string }): ProductAdminActor => ({
    userId: who.userId,
    email: who.email,
    ipAddress: "192.0.2.1",
    userAgent: "Firefox/140",
  });

  const auditRows = () =>
    ownerDb
      .selectFrom("audit_events")
      .select(["action", "actor_user_id", "actor_email", "organization_id", "subject_type", "subject_id", "metadata", "ip_address", "user_agent"])
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  /** Whether any audit row's metadata holds `text` (a boolean: nothing is printed). */
  const metadataHolds = async (text: string) => (await auditRows()).some((row) => JSON.stringify(row.metadata).includes(text));

  it("lists users and product admins, auditing a count and whether a search ran, never the term, in no organization", async () => {
    const ana = await person(true);
    const ben = await person();
    const term = ben.email.slice(0, 20);
    const all = (await repository.listUsers(actorOf(ana), { pageSize: 50, at })).rows;
    expect(all.map((row) => row.id).sort()).toEqual([ana.userId, ben.userId].sort());
    expect(all.find((row) => row.id === ana.userId)?.block).toEqual({ kind: "product_admin" });
    expect(all.find((row) => row.id === ben.userId)?.block).toBeNull();
    const searched = (await repository.listUsers(actorOf(ana), { query: term, pageSize: 50, at })).rows;
    expect(searched.map((row) => row.id)).toEqual([ben.userId]);
    const admins = await repository.listProductAdmins(actorOf(ana));
    expect(admins.map((row) => row.id)).toEqual([ana.userId]);

    const rows = await auditRows();
    expect(rows.map(({ action, metadata, organization_id, actor_user_id, subject_id }) => ({ action, metadata, organization_id, actor_user_id, subject_id }))).toEqual([
      { action: "product_admin.users_listed", metadata: { count: 2, searched: false }, organization_id: null, actor_user_id: ana.userId, subject_id: null },
      { action: "product_admin.users_listed", metadata: { count: 1, searched: true }, organization_id: null, actor_user_id: ana.userId, subject_id: null },
      { action: "product_admin.product_admins_listed", metadata: { count: 1 }, organization_id: null, actor_user_id: ana.userId, subject_id: null },
    ]);
    expect(rows.every((row) => row.actor_email === ana.email && row.ip_address === "192.0.2.1" && row.user_agent === "Firefox/140")).toBe(true);
    expect(await metadataHolds(term)).toBe(false);
  });

  it("audits a grant, a grant of an admin as grant_unchanged, and a refused grant as product_admin.refused with no subject and never the email", async () => {
    const ana = await person(true);
    const ben = await person();
    expect(await repository.grantProductAdmin(actorOf(ana), ben.email.toUpperCase(), at)).toEqual({
      outcome: "granted",
      user: { id: ben.userId, email: ben.email },
    });
    expect(await repository.grantProductAdmin(actorOf(ana), ben.email, at)).toEqual({ outcome: "unchanged", user: { id: ben.userId, email: ben.email } });
    const nobody = `nobody-${randomUUID()}@example.com`;
    expect(await repository.grantProductAdmin(actorOf(ana), nobody, at)).toEqual({ outcome: "not_found" });

    expect((await auditRows()).map(({ action, subject_type, subject_id, metadata }) => ({ action, subject_type, subject_id, metadata }))).toEqual([
      { action: "product_admin.granted", subject_type: "user", subject_id: ben.userId, metadata: {} },
      { action: "product_admin.grant_unchanged", subject_type: "user", subject_id: ben.userId, metadata: {} },
      { action: "product_admin.refused", subject_type: null, subject_id: null, metadata: { operation: "grant", outcome: "not_found" } },
    ]);
    expect((await metadataHolds(nobody)) || (await metadataHolds(ben.email))).toBe(false);
    const flag = await ownerDb.selectFrom("users").select(["is_product_admin", "updated_at"]).where("id", "=", ben.userId).executeTakeFirstOrThrow();
    expect(flag).toEqual({ is_product_admin: true, updated_at: at });
  });

  it("audits a removal with self, and refused ones (not one, the last admin) with their subject", async () => {
    const ana = await person(true);
    const ben = await person(true);
    const cara = await person();
    expect(await repository.revokeProductAdmin(actorOf(ana), cara.userId, at)).toBe("not_found");
    expect(await repository.revokeProductAdmin(actorOf(ana), ben.userId, at)).toBe("revoked");
    expect(await repository.revokeProductAdmin(actorOf(ana), ana.userId, at)).toBe("last_admin");
    await ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", ben.userId).execute();
    expect(await repository.revokeProductAdmin(actorOf(ana), ana.userId, at)).toBe("revoked");

    expect((await auditRows()).map(({ action, subject_id, metadata }) => ({ action, subject_id, metadata }))).toEqual([
      { action: "product_admin.refused", subject_id: cara.userId, metadata: { operation: "revoke", outcome: "not_found" } },
      { action: "product_admin.revoked", subject_id: ben.userId, metadata: { self: false } },
      { action: "product_admin.refused", subject_id: ana.userId, metadata: { operation: "revoke", outcome: "last_admin" } },
      { action: "product_admin.revoked", subject_id: ana.userId, metadata: { self: true } },
    ]);
  });

  it("lists and counts pending feedback (the count unaudited), handles it once, and refuses an acknowledge of a deleted sender, the item left pending; no audit row holds the text or an email", async () => {
    const ana = await person(true);
    const ben = await person();
    const text = `feedback-text-marker-${randomUUID()}`;
    const older = await addUserFeedback(ownerDb, { userId: ben.userId, organizationId: ben.organizationId, text, created_at: new Date(at.getTime() - 2000) });
    const newer = await addUserFeedback(ownerDb, { userId: ben.userId, organizationId: ben.organizationId, created_at: new Date(at.getTime() - 1000) });

    const listed = (await repository.listFeedback(actorOf(ana), { pageSize: 25 })).rows;
    expect(listed.map((row) => ({ id: row.id, authorDeleted: row.authorDeleted, isBens: row.email === ben.email }))).toEqual([
      { id: newer.id, authorDeleted: false, isBens: true },
      { id: older.id, authorDeleted: false, isBens: true },
    ]);
    expect(listed[1]!.text === text).toBe(true);
    const page = (await repository.listFeedback(actorOf(ana), { pageSize: 25, after: { createdAt: listed[0]!.createdAt, id: listed[0]!.id } })).rows;
    expect(page.map((row) => row.id)).toEqual([older.id]);
    expect(await repository.countPendingFeedback(actorOf(ana))).toBe(2);

    const dismissed = await repository.handleFeedback(actorOf(ana), newer.id, "dismissed", at);
    expect(dismissed.outcome === "handled" && dismissed.sender.userId === ben.userId && dismissed.sender.email === ben.email).toBe(true);
    expect(await repository.handleFeedback(actorOf(ana), newer.id, "acknowledged", at)).toEqual({ outcome: "not_found" });
    expect(await repository.countPendingFeedback(actorOf(ana))).toBe(1);

    await ownerDb.updateTable("users").set({ deleted_at: at }).where("id", "=", ben.userId).execute();
    expect(await repository.handleFeedback(actorOf(ana), older.id, "acknowledged", at)).toEqual({ outcome: "author_deleted" });
    const item = await ownerDb.selectFrom("user_feedback").select(["handled_at", "outcome"]).where("id", "=", older.id).executeTakeFirstOrThrow();
    expect(item).toEqual({ handled_at: null, outcome: null });
    expect((await repository.listFeedback(actorOf(ana), { pageSize: 25 })).rows.map((row) => row.authorDeleted)).toEqual([true]);

    expect((await auditRows()).map(({ action, subject_type, subject_id, metadata }) => ({ action, subject_type, subject_id, metadata }))).toEqual([
      { action: "product_admin.feedback_listed", subject_type: null, subject_id: null, metadata: { count: 2 } },
      { action: "product_admin.feedback_listed", subject_type: null, subject_id: null, metadata: { count: 1 } },
      { action: "feedback.dismissed", subject_type: "feedback", subject_id: newer.id, metadata: {} },
      { action: "product_admin.refused", subject_type: "feedback", subject_id: newer.id, metadata: { operation: "acknowledge", outcome: "not_found" } },
      { action: "product_admin.refused", subject_type: "feedback", subject_id: older.id, metadata: { operation: "acknowledge", outcome: "author_deleted" } },
      { action: "product_admin.feedback_listed", subject_type: null, subject_id: null, metadata: { count: 1 } },
    ]);
    expect((await metadataHolds(text)) || (await metadataHolds(ben.email))).toBe(false);
  });

  it("reads one row past the page to say whether another follows, and audits the rows returned: a full page its size, the last page its real count (Ruling 264)", async () => {
    const ana = await person(true);
    const people = [ana.userId];
    for (let index = 0; index < 2; index += 1) people.push((await person()).userId);
    const firstUsers = await repository.listUsers(actorOf(ana), { pageSize: 2, at });
    expect({ rows: firstUsers.rows.length, hasMore: firstUsers.hasMore }).toEqual({ rows: 2, hasMore: true });
    const last = firstUsers.rows.at(-1)!;
    const lastUsers = await repository.listUsers(actorOf(ana), { pageSize: 2, at, after: { createdAt: last.createdAt, id: last.id } });
    expect({ rows: lastUsers.rows.length, hasMore: lastUsers.hasMore }).toEqual({ rows: 1, hasMore: false });
    expect([...firstUsers.rows, ...lastUsers.rows].map((row) => row.id).sort()).toEqual([...people].sort());
    const exact = await repository.listUsers(actorOf(ana), { pageSize: 3, at });
    expect({ rows: exact.rows.length, hasMore: exact.hasMore }).toEqual({ rows: 3, hasMore: false });

    const ben = await person();
    const base = at.getTime() - 10_000;
    for (let index = 0; index < 3; index += 1) {
      await addUserFeedback(ownerDb, { userId: ben.userId, organizationId: ben.organizationId, created_at: new Date(base + index * 1000) });
    }
    const firstFeedback = await repository.listFeedback(actorOf(ana), { pageSize: 2 });
    expect({ rows: firstFeedback.rows.length, hasMore: firstFeedback.hasMore }).toEqual({ rows: 2, hasMore: true });
    const tail = firstFeedback.rows.at(-1)!;
    const lastFeedback = await repository.listFeedback(actorOf(ana), { pageSize: 2, after: { createdAt: tail.createdAt, id: tail.id } });
    expect({ rows: lastFeedback.rows.length, hasMore: lastFeedback.hasMore }).toEqual({ rows: 1, hasMore: false });

    const counted = (await auditRows()).map(({ action, metadata }) => ({ action, metadata }));
    expect(counted).toEqual([
      { action: "product_admin.users_listed", metadata: { count: 2, searched: false } },
      { action: "product_admin.users_listed", metadata: { count: 1, searched: false } },
      { action: "product_admin.users_listed", metadata: { count: 3, searched: false } },
      { action: "product_admin.feedback_listed", metadata: { count: 2 } },
      { action: "product_admin.feedback_listed", metadata: { count: 1 } },
    ]);
  });

  it("changes who may create an organization and audits it with from and to, an unchanged value as organization_creation_unchanged, in no organization with no subject (D36-1 decision 51)", async () => {
    const ana = await person(true);
    const stored = async () =>
      (await ownerDb.selectFrom("site_settings").select("organization_creation").executeTakeFirstOrThrow()).organization_creation;
    expect(await stored()).toBe("everyone");
    expect(await repository.setOrganizationCreation(actorOf(ana), "product-admins")).toEqual({ outcome: "changed", previous: "everyone" });
    expect(await stored()).toBe("product_admins");
    expect(await repository.setOrganizationCreation(actorOf(ana), "product-admins")).toEqual({ outcome: "unchanged", previous: "product-admins" });
    expect(await repository.setOrganizationCreation(actorOf(ana), "everyone")).toEqual({ outcome: "changed", previous: "product-admins" });
    expect(await stored()).toBe("everyone");

    const rows = await auditRows();
    expect(rows.map(({ action, organization_id, subject_type, subject_id, metadata, actor_user_id }) => ({ action, organization_id, subject_type, subject_id, metadata, actor_user_id }))).toEqual([
      {
        action: "product_admin.organization_creation_changed",
        organization_id: null,
        subject_type: null,
        subject_id: null,
        metadata: { from: "everyone", to: "product-admins" },
        actor_user_id: ana.userId,
      },
      {
        action: "product_admin.organization_creation_unchanged",
        organization_id: null,
        subject_type: null,
        subject_id: null,
        metadata: { from: "product-admins", to: "product-admins" },
        actor_user_id: ana.userId,
      },
      {
        action: "product_admin.organization_creation_changed",
        organization_id: null,
        subject_type: null,
        subject_id: null,
        metadata: { from: "product-admins", to: "everyone" },
        actor_user_id: ana.userId,
      },
    ]);
  });

  it("answers the gate's refusal (the caller no longer a product admin) 403 product_admin_required, writing nothing", async () => {
    const ana = await person();
    const ben = await person();
    const feedback = await addUserFeedback(ownerDb, { userId: ben.userId, organizationId: ben.organizationId });
    const calls: Array<() => Promise<unknown>> = [
      () => repository.listUsers(actorOf(ana), { pageSize: 50, at }),
      () => repository.listProductAdmins(actorOf(ana)),
      () => repository.grantProductAdmin(actorOf(ana), ben.email, at),
      () => repository.revokeProductAdmin(actorOf(ana), ben.userId, at),
      () => repository.listFeedback(actorOf(ana), { pageSize: 25 }),
      () => repository.countPendingFeedback(actorOf(ana)),
      () => repository.handleFeedback(actorOf(ana), feedback.id, "dismissed", at),
      () => repository.setOrganizationCreation(actorOf(ana), "product-admins"),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "product_admin_required", statusCode: 403 });
    }
    expect(await auditRows()).toEqual([]);
    expect((await ownerDb.selectFrom("site_settings").select("organization_creation").executeTakeFirstOrThrow()).organization_creation).toBe("everyone");
  });

  it("answers 403 only the gate's own 42501 (its hint): another 42501 inside the context, the audit row's insert refused, stays the database's error and writes nothing (Ruling 260)", async () => {
    const ana = await person(true);
    // Taken for this test only; the global setup's restoreRevokedGrantLeftovers grants it back after a killed run.
    await sql`revoke insert on audit_events from telflo_platform_runtime`.execute(ownerDb);
    try {
      const refused = await repository.listProductAdmins(actorOf(ana)).then(
        () => undefined,
        (error: unknown) => error as { code?: unknown; statusCode?: unknown; hint?: unknown },
      );
      expect({ code: refused?.code, statusCode: refused?.statusCode, hint: refused?.hint }).toEqual({
        code: "42501",
        statusCode: undefined,
        hint: undefined,
      });
    } finally {
      await sql`grant insert on audit_events to telflo_platform_runtime`.execute(ownerDb);
    }
    expect(await auditRows()).toEqual([]);
    expect((await repository.listProductAdmins(actorOf(ana))).map((row) => row.id)).toEqual([ana.userId]);
  });
});
