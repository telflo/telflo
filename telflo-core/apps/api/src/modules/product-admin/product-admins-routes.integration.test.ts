import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  LAST_PRODUCT_ADMIN_MESSAGE,
  PRODUCT_ADMIN_NOT_FOUND_MESSAGE,
  PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE,
} from "@telflo/contracts";
import {
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";

/*
 * The Product admins routes (D29 decisions 5, 27, 28 and 44's grant
 * bullet; Preflight ruling 7; Rulings 257 and 258) through the real server
 * and database: every answer of decision 28 (the list; a grant 201, 200 when
 * already one, 404 for no live, verified human — a service account, an
 * unverified person, a deleted one, nobody — 400 for a malformed address;
 * a removal 204, 404 when not one or the id isn't canonical, 409 for the
 * last admin; 429 past the writes' limit), each `cache-control: no-store`,
 * and the audit rows each writes (ids and fixed words only).
 *
 * The races go through the routes too, a connection of the tables' owner
 * holding the rows' locks while the requests queue behind it:
 *   * a grant, and a removal, by an admin whose flag is cleared while it
 *     waits: 403 `product_admin_required`, nothing changed (the functions'
 *     caller re-check under their locks);
 *   * a grant whose target is deleted while it waits: 404, nothing
 *     granted (the grant's re-read of its target under the lock);
 *   * two admins removing themselves at once: one 204, one 409
 *     `last_product_admin`, one admin left (revoke's `for update` on every
 *     live admin's row).
 * The functions' own two-connection races are
 * tenancy/product-admin-functions.integration.test.ts's.
 *
 * Seeded addresses are made-up @example.com fixtures; emails are compared
 * as booleans and never printed (ADR 0024, decision 41).
 */

const opamp = useFakeOpampServer();
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const ROUTE = "/api/v1/product-admin/product-admins";

describe("the Product admins routes", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  let limitedServer: FastifyInstance;
  let logLines: string[] = [];

  const build = (rateLimits: RateLimits) =>
    buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: UNCALLED_FILE_STORE,
      testing: UNCALLED_TESTING,
      settings: loadSettings(process.env),
      db: databases.db,
      mailer: createInMemoryMailer(),
      rateLimits,
      logStream: { write: (line) => void logLines.push(line) },
    });

  beforeAll(async () => {
    databases = openTestDatabases();
    passwordHash = await hashPassword(PASSWORD);
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "trace";
    try {
      server = build(TEST_RATE_LIMITS);
      limitedServer = build({ ...TEST_RATE_LIMITS, productAdminWritesPerUser: { max: 2, windowMs: 60_000 } });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await Promise.all([server.ready(), limitedServer.ready()]);
  });

  afterAll(async () => {
    await Promise.all([server.close(), limitedServer.close()]);
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    logLines = [];
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  /** A live, verified person with a personal organization; a product admin when asked. */
  const person = async (options: { isProductAdmin?: boolean; verified?: boolean } = {}) => {
    const created = await createUserWithOrganization(databases.ownerDb, {
      user: {
        email: `person-${randomUUID()}@example.com`,
        password_hash: passwordHash,
        is_product_admin: options.isProductAdmin ?? false,
        ...(options.verified === false ? { email_verified_at: null } : {}),
      },
    });
    return { userId: created.user.id, email: created.user.email, organizationId: created.organization.id };
  };

  /** A product admin, signed in: their id, email and access cookie. */
  const signedInAdmin = async (on: FastifyInstance = server) => {
    const admin = await person({ isProductAdmin: true });
    const response = await on.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: admin.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return { ...admin, access: cookieValue(response, "telflo_access") };
  };

  const send = (method: "GET" | "POST" | "DELETE", url: string, access: string, body?: Record<string, unknown>, on: FastifyInstance = server) =>
    on.inject({
      method,
      url,
      headers: method === "GET" ? {} : csrfHeaders,
      cookies: { telflo_access: access },
      ...(body === undefined ? {} : { payload: body }),
    });

  const errorOf = (response: LightMyRequestResponse) => {
    const error = response.body === "" ? undefined : (response.json() as { error?: { code: string; message: string } }).error;
    return { status: response.statusCode, code: error?.code, message: error?.message, cache: response.headers["cache-control"] };
  };

  const flagOf = async (userId: string) =>
    (await databases.ownerDb.selectFrom("users").select("is_product_admin").where("id", "=", userId).executeTakeFirstOrThrow()).is_product_admin;

  const liveAdminIds = async () =>
    (
      await databases.ownerDb
        .selectFrom("users")
        .select("id")
        .where("is_product_admin", "=", true)
        .where("deleted_at", "is", null)
        .where("kind", "=", "human")
        .orderBy("id")
        .execute()
    ).map((row) => row.id);

  /** The audit rows of the product-admin writes and lists, oldest first. */
  const auditRows = () =>
    databases.ownerDb
      .selectFrom("audit_events")
      .select(["action", "actor_user_id", "organization_id", "subject_type", "subject_id", "metadata"])
      .where("action", "like", "product_admin.%")
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();

  /** Whether any audit row's metadata, or any log line, holds `text` (booleans: nothing is printed). */
  const metadataHolds = async (text: string) => (await auditRows()).some((row) => JSON.stringify(row.metadata).toLowerCase().includes(text.toLowerCase()));
  const logsHold = (text: string) => logLines.some((line) => line.toLowerCase().includes(text.toLowerCase()));

  describe("GET /product-admins", () => {
    it("lists every live human product admin by email, never a non-admin, a deleted admin or a service account holding the flag; audited with a count; no-store", async () => {
      const ana = await signedInAdmin();
      const ben = await person({ isProductAdmin: true });
      await person();
      const gone = await person({ isProductAdmin: true });
      await databases.ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", gone.userId).execute();
      const group = await addMembership(databases.ownerDb, { userId: ana.userId });
      const bot = await addServiceAccount(databases.ownerDb, { organizationId: group.organization.id });
      await databases.ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", bot.user.id).execute();

      const response = await send("GET", ROUTE, ana.access);
      expect({ status: response.statusCode, cache: response.headers["cache-control"] }).toEqual({ status: 200, cache: "no-store" });
      const { items } = response.json() as { items: Array<{ id: string; email: string }> };
      const byEmail = [ana, ben].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
      expect(items.map((item) => item.id)).toEqual(byEmail.map((admin) => admin.userId));
      expect(items.every((item, index) => item.email === byEmail[index]!.email)).toBe(true);

      expect((await auditRows()).map(({ action, actor_user_id, organization_id, metadata }) => ({ action, actor_user_id, organization_id, metadata }))).toEqual([
        { action: "product_admin.product_admins_listed", actor_user_id: ana.userId, organization_id: null, metadata: { count: 2 } },
      ]);
    });
  });

  describe("POST /product-admins", () => {
    it("grants a live, verified person by their exact email (case and spaces aside): 201 { id, email }, then 200 when already one; audited granted, then grant_unchanged; the email in no log line or audit metadata", async () => {
      const ana = await signedInAdmin();
      const ben = await person();

      const granted = await send("POST", ROUTE, ana.access, { email: `  ${ben.email.toUpperCase()} ` });
      expect({ status: granted.statusCode, cache: granted.headers["cache-control"], id: granted.json().id }).toEqual({
        status: 201,
        cache: "no-store",
        id: ben.userId,
      });
      expect(granted.json().email === ben.email).toBe(true);
      expect(await flagOf(ben.userId)).toBe(true);

      const again = await send("POST", ROUTE, ana.access, { email: ben.email });
      expect({ status: again.statusCode, cache: again.headers["cache-control"], id: again.json().id }).toEqual({ status: 200, cache: "no-store", id: ben.userId });
      expect(again.json().email === ben.email).toBe(true);

      expect((await auditRows()).map(({ action, actor_user_id, organization_id, subject_type, subject_id, metadata }) => ({ action, actor_user_id, organization_id, subject_type, subject_id, metadata }))).toEqual([
        { action: "product_admin.granted", actor_user_id: ana.userId, organization_id: null, subject_type: "user", subject_id: ben.userId, metadata: {} },
        { action: "product_admin.grant_unchanged", actor_user_id: ana.userId, organization_id: null, subject_type: "user", subject_id: ben.userId, metadata: {} },
      ]);
      expect(await metadataHolds(ben.email)).toBe(false);
      expect(logLines.some((line) => line.includes("/product-admin/product-admins"))).toBe(true);
      expect(logsHold(ben.email)).toBe(false);
    });

    it("refuses 404 product_admin_target_not_found, in fixed words, for a service account, an unverified person, a deleted person and nobody: nothing granted, each audited refused with no subject and never the email", async () => {
      const ana = await signedInAdmin();
      const group = await addMembership(databases.ownerDb, { userId: ana.userId });
      const bot = await addServiceAccount(databases.ownerDb, { organizationId: group.organization.id });
      const unverified = await person({ verified: false });
      const gone = await person();
      await databases.ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", gone.userId).execute();
      const nobody = `nobody-${randomUUID()}@example.com`;

      for (const email of [bot.user.email, unverified.email, gone.email, nobody]) {
        const response = await send("POST", ROUTE, ana.access, { email });
        expect(errorOf(response)).toEqual({
          status: 404,
          code: "product_admin_target_not_found",
          message: PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE,
          cache: "no-store",
        });
        expect(response.body.toLowerCase().includes(email.toLowerCase())).toBe(false);
      }
      expect(await flagOf(bot.user.id)).toBe(false);
      expect(await flagOf(unverified.userId)).toBe(false);
      expect(await flagOf(gone.userId)).toBe(false);

      const rows = await auditRows();
      expect(rows.map(({ action, subject_type, subject_id, metadata }) => ({ action, subject_type, subject_id, metadata }))).toEqual(
        Array.from({ length: 4 }, () => ({ action: "product_admin.refused", subject_type: null, subject_id: null, metadata: { operation: "grant", outcome: "not_found" } })),
      );
      for (const email of [bot.user.email, unverified.email, gone.email, nobody]) {
        expect(await metadataHolds(email)).toBe(false);
        expect(logsHold(email)).toBe(false);
      }
    });

    it("finds a person whose stored email is mixed-case by its lower-cased address (the function's lower(email)): 201, the flag set (Ruling 263)", async () => {
      const ana = await signedInAdmin();
      const created = await createUserWithOrganization(databases.ownerDb, {
        user: { email: `Mixed.Case-${randomUUID()}@Example.test`, password_hash: passwordHash },
      });
      const stored = created.user.email;
      expect(stored !== stored.toLowerCase(), "the stored email is mixed-case").toBe(true);

      const response = await send("POST", ROUTE, ana.access, { email: stored.toLowerCase() });
      expect({ status: response.statusCode, id: response.json().id }).toEqual({ status: 201, id: created.user.id });
      expect(await flagOf(created.user.id)).toBe(true);
    });

    it("refuses a malformed body 400 before the database (no audit row)", async () => {
      const ana = await signedInAdmin();
      for (const body of [{ email: "not-an-address" }, {}, { email: "a@example.com", extra: true }]) {
        expect((await send("POST", ROUTE, ana.access, body)).statusCode).toBe(400);
      }
      expect(await auditRows()).toEqual([]);
    });
  });

  describe("DELETE /product-admins/:userId", () => {
    it("removes another product admin: 204, the flag cleared, audited revoked { self: false }; an upper-case id is the same id", async () => {
      const ana = await signedInAdmin();
      const ben = await person({ isProductAdmin: true });
      const cara = await person({ isProductAdmin: true });

      const removed = await send("DELETE", `${ROUTE}/${ben.userId}`, ana.access);
      expect({ status: removed.statusCode, body: removed.body, cache: removed.headers["cache-control"] }).toEqual({ status: 204, body: "", cache: "no-store" });
      expect(await flagOf(ben.userId)).toBe(false);
      expect((await send("DELETE", `${ROUTE}/${cara.userId.toUpperCase()}`, ana.access)).statusCode).toBe(204);
      expect(await flagOf(cara.userId)).toBe(false);

      expect((await auditRows()).map(({ action, actor_user_id, organization_id, subject_id, metadata }) => ({ action, actor_user_id, organization_id, subject_id, metadata }))).toEqual([
        { action: "product_admin.revoked", actor_user_id: ana.userId, organization_id: null, subject_id: ben.userId, metadata: { self: false } },
        { action: "product_admin.revoked", actor_user_id: ana.userId, organization_id: null, subject_id: cara.userId, metadata: { self: false } },
      ]);
    });

    it("refuses 404 product_admin_not_found for a person who isn't one, an unknown id and a non-canonical one (the last before the database: no audit row)", async () => {
      const ana = await signedInAdmin();
      await person({ isProductAdmin: true });
      const cara = await person();
      const unknown = randomUUID();
      for (const id of [cara.userId, unknown, "not-a-uuid", `${cara.userId}0`, `{${cara.userId}}`]) {
        expect(errorOf(await send("DELETE", `${ROUTE}/${encodeURIComponent(id)}`, ana.access))).toEqual({
          status: 404,
          code: "product_admin_not_found",
          message: PRODUCT_ADMIN_NOT_FOUND_MESSAGE,
          cache: "no-store",
        });
      }
      const rows = await auditRows();
      expect(rows.map(({ action, subject_id, metadata }) => ({ action, subject_id, metadata }))).toEqual([
        { action: "product_admin.refused", subject_id: cara.userId, metadata: { operation: "revoke", outcome: "not_found" } },
        { action: "product_admin.refused", subject_id: unknown, metadata: { operation: "revoke", outcome: "not_found" } },
      ]);
    });

    it("refuses the last product admin's removal of themselves 409 last_product_admin, in decision 5's words; allows it while another remains (204, audited self), after which the next request is 403", async () => {
      const ana = await signedInAdmin();
      expect(errorOf(await send("DELETE", `${ROUTE}/${ana.userId}`, ana.access))).toEqual({
        status: 409,
        code: "last_product_admin",
        message: LAST_PRODUCT_ADMIN_MESSAGE,
        cache: "no-store",
      });
      expect(await flagOf(ana.userId)).toBe(true);

      const ben = await person({ isProductAdmin: true });
      expect((await send("DELETE", `${ROUTE}/${ana.userId}`, ana.access)).statusCode).toBe(204);
      expect(await liveAdminIds()).toEqual([ben.userId]);
      expect(errorOf(await send("GET", ROUTE, ana.access))).toEqual({
        status: 403,
        code: "product_admin_required",
        message: "Only a product admin can do that.",
        cache: "no-store",
      });

      expect((await auditRows()).map(({ action, subject_id, metadata }) => ({ action, subject_id, metadata }))).toEqual([
        { action: "product_admin.refused", subject_id: ana.userId, metadata: { operation: "revoke", outcome: "last_admin" } },
        { action: "product_admin.revoked", subject_id: ana.userId, metadata: { self: true } },
      ]);
    });
  });

  describe("the races, through the routes", () => {
    /** Resolves once `count` connections wait on a lock: the requests are queued behind the owner's. */
    const waitingOnLocks = async (count: number) => {
      // A hang guard (about 2 s), inside the test's own timeout: a queued request shows up within milliseconds.
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::integer as waiting from pg_stat_activity
           where wait_event_type = 'Lock' and datname = current_database()
        `.execute(databases.ownerDb);
        if (rows[0]!.waiting >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`fewer than ${count} connections waited on a lock`);
    };

    /**
     * Opens a transaction of the tables' owner, runs `hold` in it (taking
     * row locks), runs `requests` while it is open, waits until `waiters`
     * connections queue behind it, then commits. Answers the requests'
     * responses.
     */
    const behindTheOwner = async <Responses>(
      hold: (transaction: Transaction<Database>) => Promise<unknown>,
      requests: () => Promise<Responses>,
      waiters: number,
    ): Promise<Responses> => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding!: () => void;
      const heldYet = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const owner = databases.ownerDb.transaction().execute(async (transaction) => {
        await hold(transaction);
        holding();
        await released;
      });
      await heldYet;
      const responses = requests();
      try {
        await waitingOnLocks(waiters);
      } finally {
        release();
        await owner;
      }
      return responses;
    };

    it("answers a grant 403 product_admin_required when the caller's flag is cleared while it waits on the caller's and the target's locks: nothing granted, audited refused forbidden", async () => {
      const ana = await signedInAdmin();
      await person({ isProductAdmin: true });
      const cara = await person();
      const response = await behindTheOwner(
        (transaction) => transaction.updateTable("users").set({ is_product_admin: false }).where("id", "=", ana.userId).execute(),
        () => send("POST", ROUTE, ana.access, { email: cara.email }),
        1,
      );
      expect(errorOf(response)).toEqual({ status: 403, code: "product_admin_required", message: "Only a product admin can do that.", cache: "no-store" });
      expect(await flagOf(cara.userId)).toBe(false);
      expect((await auditRows()).map(({ action, subject_id, metadata }) => ({ action, subject_id, metadata }))).toEqual([
        { action: "product_admin.refused", subject_id: null, metadata: { operation: "grant", outcome: "forbidden" } },
      ]);
    });

    it("answers a grant 404 product_admin_target_not_found when the target is deleted while it waits on the caller's and the target's locks: the flag not set, audited refused not_found (Ruling 263)", async () => {
      const ana = await signedInAdmin();
      const cara = await person();
      const response = await behindTheOwner(
        (transaction) => transaction.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", cara.userId).execute(),
        () => send("POST", ROUTE, ana.access, { email: cara.email }),
        1,
      );
      expect(errorOf(response)).toEqual({
        status: 404,
        code: "product_admin_target_not_found",
        message: PRODUCT_ADMIN_TARGET_NOT_FOUND_MESSAGE,
        cache: "no-store",
      });
      expect(await flagOf(cara.userId)).toBe(false);
      expect((await auditRows()).map(({ action, subject_id, metadata }) => ({ action, subject_id, metadata }))).toEqual([
        { action: "product_admin.refused", subject_id: null, metadata: { operation: "grant", outcome: "not_found" } },
      ]);
    });

    it("answers a removal 403 product_admin_required when the caller's flag is cleared while it waits on the admins' locks: nothing removed, audited refused forbidden", async () => {
      const ana = await signedInAdmin();
      const ben = await person({ isProductAdmin: true });
      await person({ isProductAdmin: true });
      const response = await behindTheOwner(
        (transaction) => transaction.updateTable("users").set({ is_product_admin: false }).where("id", "=", ana.userId).execute(),
        () => send("DELETE", `${ROUTE}/${ben.userId}`, ana.access),
        1,
      );
      expect(errorOf(response)).toEqual({ status: 403, code: "product_admin_required", message: "Only a product admin can do that.", cache: "no-store" });
      expect(await flagOf(ben.userId)).toBe(true);
      expect((await auditRows()).map(({ action, subject_id, metadata }) => ({ action, subject_id, metadata }))).toEqual([
        { action: "product_admin.refused", subject_id: ben.userId, metadata: { operation: "revoke", outcome: "forbidden" } },
      ]);
    });

    it("keeps one product admin when the only two remove themselves at once: one 204, one 409 last_product_admin", async () => {
      const ana = await signedInAdmin();
      const ben = await signedInAdmin();
      const responses = await behindTheOwner(
        (transaction) => sql`select id from users where id in (${ana.userId}::uuid, ${ben.userId}::uuid) order by id for update`.execute(transaction),
        () => Promise.all([send("DELETE", `${ROUTE}/${ana.userId}`, ana.access), send("DELETE", `${ROUTE}/${ben.userId}`, ben.access)]),
        2,
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 409]);
      const refused = responses.find((response) => response.statusCode === 409)!;
      expect(errorOf(refused)).toEqual({ status: 409, code: "last_product_admin", message: LAST_PRODUCT_ADMIN_MESSAGE, cache: "no-store" });
      expect((await liveAdminIds()).length).toBe(1);
      const rows = (await auditRows()).map(({ action, metadata }) => ({ action, metadata }));
      expect(rows.sort((a, b) => a.action.localeCompare(b.action))).toEqual([
        { action: "product_admin.refused", metadata: { operation: "revoke", outcome: "last_admin" } },
        { action: "product_admin.revoked", metadata: { self: true } },
      ]);
    });
  });

  describe("the writes' limit", () => {
    it("answers the third write in a minute 429 rate_limited with retry-after; a refused body and a non-canonical id count nothing", async () => {
      const ana = await signedInAdmin(limitedServer);
      const ben = await person({ isProductAdmin: true });
      const cara = await person();
      expect((await send("POST", ROUTE, ana.access, { email: "not-an-address" }, limitedServer)).statusCode).toBe(400);
      // Refused by canonicalIdOf before the limiter counts it (Ruling 263).
      expect(errorOf(await send("DELETE", `${ROUTE}/not-a-uuid`, ana.access, undefined, limitedServer))).toEqual({
        status: 404,
        code: "product_admin_not_found",
        message: PRODUCT_ADMIN_NOT_FOUND_MESSAGE,
        cache: "no-store",
      });
      expect((await send("POST", ROUTE, ana.access, { email: cara.email }, limitedServer)).statusCode).toBe(201);
      expect((await send("DELETE", `${ROUTE}/${ben.userId}`, ana.access, undefined, limitedServer)).statusCode).toBe(204);
      const limited = await send("POST", ROUTE, ana.access, { email: ben.email }, limitedServer);
      expect({ status: limited.statusCode, code: limited.json().error.code, retryAfter: limited.headers["retry-after"] !== undefined }).toEqual({
        status: 429,
        code: "rate_limited",
        retryAfter: true,
      });
      expect(await flagOf(ben.userId)).toBe(false);
      expect((await send("GET", ROUTE, ana.access, undefined, limitedServer)).statusCode).toBe(200);
    });
  });
});
