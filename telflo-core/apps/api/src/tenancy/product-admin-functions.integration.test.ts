import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  addMembership,
  addServiceAccount,
  addUserFeedback,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import {
  withDatabaseContext,
  withDispatcherContext,
  withProductAdminContext,
  withUserContext,
} from "../database/context.js";

/*
 * The product-admin functions of migrations 1700000000041, 042 (the
 * delete) and 044 (the organization-creation switch, D36-1 decision 51)
 * from the API's real database contexts (D29 decisions 18, 21 and 44;
 * Preflight rulings 1 and 3; Rulings 257, 258 and 260). Each is
 * SECURITY DEFINER and reaches every organization's people and the
 * feedback, so each refuses with the gate's 42501 (its dedicated hint,
 * which the SystemRepository alone answers 403), and changes nothing, in
 * any context but withProductAdminContext's for a live human product
 * admin. One test per condition (Ruling 260), every function under it: no
 * context, a member's (a product admin's own), a user's, the dispatcher's,
 * an organization or the dispatcher's setting beside the product-admin
 * setting, that setting other than on, and a product-admin context whose
 * user isn't one (the flag false, a deleted admin, a service account
 * holding the flag, an unknown, empty, malformed or upper-case id). A flag
 * cleared mid-session refuses the next call. The
 * API's role holds no SELECT on either table (INSERT only on user_feedback,
 * nothing on user_deletion_records).
 *
 * Every function that writes re-reads the caller under a row lock after
 * its other locks (Rulings 257 and 258): a removal of the caller committed
 * while the write waited wins, and the write answers `forbidden` and
 * changes nothing. Each is shown with two connections: the removal holds
 * its locks, the write is seen waiting on a lock, then the removal commits.
 *
 * The functions' own answers (the list's search and blocks, grant and
 * revoke's outcomes, feedback's) are the tasks' integration suites'; the
 * delete's own answers are below (Task 2's). Seeded
 * addresses are @example.com fixtures; nothing here prints one.
 */

describe("the product-admin functions from the API's database contexts", () => {
  let databases: TestDatabases;
  /** The API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures and reading rows back. */
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A live, verified human; a product admin when `admin`. */
  const person = async (admin = false) => {
    const created = await createUserWithOrganization(ownerDb, { user: { is_product_admin: admin } });
    return { userId: created.user.id, email: created.user.email, organizationId: created.organization.id };
  };

  /**
   * Two product admins (Ana and Ben), a person (Cara) whom a grant would
   * change, Cara's feedback that a handle would change; a deleted admin, and
   * a service account holding the flag: every function, let through, would
   * change or show something.
   */
  const seed = async () => {
    const ana = await person(true);
    const ben = await person(true);
    const cara = await person();
    const feedback = await addUserFeedback(ownerDb, { userId: cara.userId, organizationId: cara.organizationId });
    const gone = await person(true);
    await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", gone.userId).execute();
    const group = await addMembership(ownerDb, { userId: ana.userId });
    const bot = await addServiceAccount(ownerDb, { organizationId: group.organization.id });
    await ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", bot.user.id).execute();
    return { ana, ben, cara, feedback, gone, group: group.organization.id, bot: bot.user.id };
  };
  type Seeded = Awaited<ReturnType<typeof seed>>;

  /** Every product-admin function, called with arguments under which it would change or show something. */
  const calls = (seeded: Seeded): Array<[string, RawBuilder<unknown>]> => [
    ["product_admin_list_users", sql`select * from product_admin_list_users(null, null, null, 50, now())`],
    ["product_admin_list_product_admins", sql`select * from product_admin_list_product_admins()`],
    ["product_admin_grant", sql`select * from product_admin_grant(${seeded.cara.email}, now())`],
    ["product_admin_revoke", sql`select product_admin_revoke(${seeded.ben.userId}::uuid, now())`],
    ["product_admin_list_feedback", sql`select * from product_admin_list_feedback(null, null, 50)`],
    ["product_admin_count_pending_feedback", sql`select product_admin_count_pending_feedback()`],
    ["product_admin_handle_feedback", sql`select * from product_admin_handle_feedback(${seeded.feedback.id}::uuid, 'dismissed', now())`],
    ["product_admin_delete_account", sql`select * from product_admin_delete_account(${seeded.cara.userId}::uuid, now())`],
    // Migration 044's (D36-1 decision 51): the switch turned on.
    ["product_admin_set_organization_creation", sql`select * from product_admin_set_organization_creation('product_admins')`],
  ];

  /** The people, their organizations, memberships and sessions, the feedback and the deletion records, as the owner reads them. */
  const everything = async () => ({
    users: await ownerDb.selectFrom("users").selectAll().orderBy("id").execute(),
    feedback: await ownerDb.selectFrom("user_feedback").selectAll().orderBy("id").execute(),
    organizations: await ownerDb.selectFrom("organizations").selectAll().orderBy("id").execute(),
    members: await ownerDb.selectFrom("organization_members").selectAll().orderBy("id").execute(),
    sessions: await ownerDb.selectFrom("sessions").selectAll().orderBy("id").execute(),
    records: await ownerDb.selectFrom("user_deletion_records").select("user_id").execute(),
    siteSettings: await ownerDb.selectFrom("site_settings").selectAll().execute(),
  });

  /** The gate's own refusal: 42501 with its dedicated hint (Ruling 260), which the SystemRepository alone answers 403. */
  const GATE_REFUSAL = "42501 telflo_product_admin_gate";

  /**
   * Runs `call` in `transaction` and answers "ran", or its error's code,
   * with its hint after a space when it has one (GATE_REFUSAL is the
   * gate's; a missing grant is "42501" alone).
   */
  const outcomeOf = async (transaction: Transaction<Database> | Kysely<Database>, call: RawBuilder<unknown>) => {
    try {
      await call.execute(transaction);
      return "ran";
    } catch (error) {
      const { code, hint } = error as { code?: string; hint?: string };
      return hint === undefined ? (code ?? "no code") : `${code} ${hint}`;
    }
  };

  /** Sets the four settings in an open transaction exactly as given: what a context of its own would set. */
  const setSettings = (
    transaction: Transaction<Database>,
    settings: { productAdmin: string; userId: string; organizationId: string; dispatcher: string },
  ) => sql`
    select set_config('telflo.product_admin', ${settings.productAdmin}, true),
           set_config('telflo.user_id', ${settings.userId}, true),
           set_config('telflo.organization_id', ${settings.organizationId}, true),
           set_config('telflo.dispatcher', ${settings.dispatcher}, true)
  `.execute(transaction);

  it("runs every function for a live human product admin in withProductAdminContext (the gate lets the real context through)", async () => {
    const seeded = await seed();
    for (const [name, call] of calls(seeded)) {
      expect({ name, outcome: await withProductAdminContext(db, seeded.ana.userId, (transaction) => outcomeOf(transaction, call)) }).toEqual({
        name,
        outcome: "ran",
      });
    }
  });

  /** How a transaction is opened for a refusal's condition: a real context, or the settings as given. */
  type Opener = <Result>(work: (transaction: Transaction<Database>) => Promise<Result>) => Promise<Result>;
  const withSettings =
    (settings: { productAdmin: string; userId: string; organizationId: string; dispatcher: string }): Opener =>
    (work) =>
      db.transaction().execute(async (transaction) => {
        await setSettings(transaction, settings);
        return work(transaction);
      });

  /** Each condition the gate refuses (decision 44's first bullet): one test each, every function under it. */
  const refusedConditions: Array<[string, (seeded: Seeded) => Opener]> = [
    ["no context", () => (work) => db.transaction().execute(work)],
    ["a member's context: a product admin acting in their group", (seeded) => (work) => withDatabaseContext(db, { userId: seeded.ana.userId, organizationId: seeded.group }, work)],
    ["a user's context: a product admin's own, no organization, no product-admin setting", (seeded) => (work) => withUserContext(db, seeded.ana.userId, work)],
    ["the dispatcher's context", () => (work) => withDispatcherContext(db, work)],
    [
      "an organization set beside the product-admin setting (a member's context with it turned on)",
      (seeded) => withSettings({ productAdmin: "on", userId: seeded.ana.userId, organizationId: seeded.group, dispatcher: "" }),
    ],
    [
      "the dispatcher's setting on beside the product admin's",
      (seeded) => withSettings({ productAdmin: "on", userId: seeded.ana.userId, organizationId: "", dispatcher: "on" }),
    ],
    ["the product-admin setting other than on", (seeded) => withSettings({ productAdmin: "true", userId: seeded.ana.userId, organizationId: "", dispatcher: "" })],
    ["a product-admin context whose user's flag is false", (seeded) => (work) => withProductAdminContext(db, seeded.cara.userId, work)],
    ["a product-admin context whose user is a deleted product admin", (seeded) => (work) => withProductAdminContext(db, seeded.gone.userId, work)],
    ["a product-admin context whose user is a service account holding the flag", (seeded) => (work) => withProductAdminContext(db, seeded.bot, work)],
    ["a product-admin context whose user is unknown", () => (work) => withProductAdminContext(db, randomUUID(), work)],
    ["a product-admin context with no user", () => withSettings({ productAdmin: "on", userId: "", organizationId: "", dispatcher: "" })],
    ["a product-admin context whose user id is malformed", () => withSettings({ productAdmin: "on", userId: "not-a-uuid", organizationId: "", dispatcher: "" })],
    [
      "a product-admin context whose user id is in upper case",
      (seeded) => withSettings({ productAdmin: "on", userId: seeded.ana.userId.toUpperCase(), organizationId: "", dispatcher: "" }),
    ],
  ];

  it.each(refusedConditions)("refuses every function with the gate's 42501 under %s, and changes nothing", async (_condition, openerOf) => {
    const seeded = await seed();
    const before = await everything();
    const open = openerOf(seeded);
    for (const [name, call] of calls(seeded)) {
      expect({ name, outcome: await open((transaction) => outcomeOf(transaction, call)) }).toEqual({ name, outcome: GATE_REFUSAL });
    }
    expect(await everything()).toEqual(before);
  });

  it("refuses the next call once the caller's flag is cleared: in a new transaction, and in the same one at its next statement", async () => {
    const seeded = await seed();
    const list = sql`select * from product_admin_list_product_admins()`;
    expect(await withProductAdminContext(db, seeded.ana.userId, (transaction) => outcomeOf(transaction, list))).toBe("ran");
    const sameTransaction = await withProductAdminContext(db, seeded.ben.userId, async (transaction) => {
      const first = await outcomeOf(transaction, list);
      await ownerDb.updateTable("users").set({ is_product_admin: false }).where("id", "=", seeded.ben.userId).execute();
      return { first, second: await outcomeOf(transaction, list) };
    });
    expect(sameTransaction).toEqual({ first: "ran", second: GATE_REFUSAL });
    await ownerDb.updateTable("users").set({ is_product_admin: false }).where("id", "=", seeded.ana.userId).execute();
    expect(await withProductAdminContext(db, seeded.ana.userId, (transaction) => outcomeOf(transaction, list))).toBe(GATE_REFUSAL);
    // Every function, the delete's included, once the flag is gone.
    const before = await everything();
    for (const [name, call] of calls(seeded)) {
      expect({ name, outcome: await withProductAdminContext(db, seeded.ana.userId, (transaction) => outcomeOf(transaction, call)) }).toEqual({
        name,
        outcome: GATE_REFUSAL,
      });
    }
    expect(await everything()).toEqual(before);
  });

  it("refuses the API's role a select of either table, any change of user_feedback but an insert without RETURNING, and any write of user_deletion_records (decision 21, Preflight rulings 3 and 8)", async () => {
    const seeded = await seed();
    await ownerDb
      .insertInto("user_deletion_records")
      .values({ user_id: seeded.gone.userId, original_email: "someone@example.com", deleted_by_user_id: seeded.ana.userId, deleted_at: new Date() })
      .execute();
    const refused: Array<[string, RawBuilder<unknown>]> = [
      ["select user_feedback", sql`select * from user_feedback`],
      ["select user_feedback's ids", sql`select id from user_feedback`],
      ["update user_feedback", sql`update user_feedback set outcome = 'dismissed', handled_at = now()`],
      ["delete user_feedback", sql`delete from user_feedback`],
      [
        "insert user_feedback returning its id",
        sql`insert into user_feedback (id, user_id, organization_id, text, created_at)
            values (uuidv7(), ${seeded.cara.userId}::uuid, ${seeded.cara.organizationId}::uuid, 'A test''s feedback.', now()) returning id`,
      ],
      ["select user_deletion_records", sql`select * from user_deletion_records`],
      ["select user_deletion_records' ids", sql`select user_id from user_deletion_records`],
      [
        "insert user_deletion_records",
        sql`insert into user_deletion_records (user_id, original_email, deleted_at) values (${seeded.cara.userId}::uuid, 'x@example.com', now())`,
      ],
      ["update user_deletion_records", sql`update user_deletion_records set deleted_at = now()`],
      ["delete user_deletion_records", sql`delete from user_deletion_records`],
      ["the gate itself", sql`select assert_product_admin()`],
      // Migration 044's one row (D36-1 decision 51): read, never written, but through the function.
      ["update site_settings", sql`update site_settings set organization_creation = 'product_admins'`],
      ["insert site_settings", sql`insert into site_settings (id, organization_creation) values (true, 'product_admins')`],
      ["delete site_settings", sql`delete from site_settings`],
    ];
    for (const [label, statement] of refused) {
      // In a product admin's own context too: the context opens no table, only the functions.
      expect({ label, outcome: await outcomeOf(db, statement) }).toEqual({ label, outcome: "42501" });
      expect({
        label,
        outcome: await withProductAdminContext(db, seeded.ana.userId, (transaction) => outcomeOf(transaction, statement)),
      }).toEqual({ label, outcome: "42501" });
    }
    // The sender's insert: the API's id, no RETURNING.
    const id = (await sql<{ id: string }>`select uuidv7() as id`.execute(db)).rows[0]!.id;
    await db
      .insertInto("user_feedback")
      .values({ id, user_id: seeded.cara.userId, organization_id: seeded.cara.organizationId, text: "Another test's feedback.", created_at: new Date() })
      .execute();
    expect((await ownerDb.selectFrom("user_feedback").select("id").where("id", "=", id).execute()).length).toBe(1);
    expect((await ownerDb.selectFrom("user_deletion_records").select("user_id").execute()).length).toBe(1);
  });

  describe("the writes' caller re-check under a row lock (Rulings 257 and 258)", () => {
    /** Resolves once some connection of the API's role waits on a lock: the second connection is queued behind the first. */
    const waitingOnALock = async () => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::integer as waiting from pg_stat_activity
           where wait_event_type = 'Lock' and datname = current_database()
        `.execute(ownerDb);
        if (rows[0]!.waiting > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("no connection waited on a lock");
    };

    /**
     * Ben removes Ana in one connection and holds his transaction open;
     * `write` runs as Ana in another, is seen waiting on a lock, and then
     * Ben commits. Answers what `write` answered.
     */
    const againstAnaRemoved = async <Result>(seeded: Seeded, write: (transaction: Transaction<Database>) => Promise<Result>) => {
      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let removed!: () => void;
      const removedYet = new Promise<void>((resolve) => {
        removed = resolve;
      });
      const removal = withProductAdminContext(db, seeded.ben.userId, async (transaction) => {
        const { rows } = await sql<{ outcome: string }>`
          select product_admin_revoke(${seeded.ana.userId}::uuid, now()) as outcome
        `.execute(transaction);
        removed();
        await held;
        return rows[0]!.outcome;
      });
      await removedYet;
      const writing = withProductAdminContext(db, seeded.ana.userId, write);
      await waitingOnALock();
      commit();
      expect(await removal).toBe("revoked");
      return writing;
    };

    it("product_admin_revoke: two admins removing each other leave one; the second waits, then answers forbidden and changes nothing", async () => {
      const seeded = await seed();
      const outcome = await againstAnaRemoved(seeded, async (transaction) => {
        const { rows } = await sql<{ outcome: string }>`
          select product_admin_revoke(${seeded.ben.userId}::uuid, now()) as outcome
        `.execute(transaction);
        return rows[0]!.outcome;
      });
      expect(outcome).toBe("forbidden");
      const flags = await ownerDb.selectFrom("users").select(["id", "is_product_admin"]).where("id", "in", [seeded.ana.userId, seeded.ben.userId]).execute();
      expect(Object.fromEntries(flags.map((row) => [row.id, row.is_product_admin]))).toEqual({
        [seeded.ana.userId]: false,
        [seeded.ben.userId]: true,
      });
    });

    it("product_admin_grant: a grant by an admin removed while it waited on the caller's and the target's locks answers forbidden and grants nothing", async () => {
      const seeded = await seed();
      const outcome = await againstAnaRemoved(seeded, async (transaction) => {
        const { rows } = await sql<{ outcome: string; user_id: string | null }>`
          select * from product_admin_grant(${seeded.cara.email}, now())
        `.execute(transaction);
        return rows[0]!;
      });
      expect(outcome).toEqual({ outcome: "forbidden", user_id: null, email: null });
      const cara = await ownerDb.selectFrom("users").select("is_product_admin").where("id", "=", seeded.cara.userId).executeTakeFirstOrThrow();
      expect(cara.is_product_admin).toBe(false);
    });

    it("product_admin_set_organization_creation: a change by an admin removed while it waited on the caller's lock answers forbidden and changes nothing (D36-1 decision 51)", async () => {
      const seeded = await seed();
      const answer = await againstAnaRemoved(seeded, async (transaction) => {
        const { rows } = await sql<{ outcome: string; previous: string | null }>`
          select outcome, previous from product_admin_set_organization_creation('product_admins')
        `.execute(transaction);
        return rows[0]!;
      });
      expect(answer).toEqual({ outcome: "forbidden", previous: null });
      expect(await ownerDb.selectFrom("site_settings").selectAll().execute()).toEqual([{ id: true, organization_creation: "everyone" }]);
    });

    it("product_admin_set_organization_creation: answers changed with the value before, unchanged for the value held, and 22023 for any other value, as the API's role in a product admin's context", async () => {
      const seeded = await seed();
      const set = (value: string | null) =>
        withProductAdminContext(db, seeded.ana.userId, async (transaction) => {
          const { rows } = await sql<{ outcome: string; previous: string | null }>`
            select outcome, previous from product_admin_set_organization_creation(${value}::text)
          `.execute(transaction);
          return rows[0]!;
        });
      expect(await set("product_admins")).toEqual({ outcome: "changed", previous: "everyone" });
      expect(await set("product_admins")).toEqual({ outcome: "unchanged", previous: "product_admins" });
      for (const value of ["product-admins", "nobody", "", null]) {
        await expect(set(value)).rejects.toMatchObject({ code: "22023" });
      }
      expect(await set("everyone")).toEqual({ outcome: "changed", previous: "product_admins" });
      expect(await ownerDb.selectFrom("site_settings").selectAll().execute()).toEqual([{ id: true, organization_creation: "everyone" }]);
    });

    it("product_admin_handle_feedback: a dismiss by an admin removed while it waited on the caller's lock answers forbidden and leaves the item pending", async () => {
      const seeded = await seed();
      const outcome = await againstAnaRemoved(seeded, async (transaction) => {
        const { rows } = await sql<{ outcome: string; user_id: string | null }>`
          select * from product_admin_handle_feedback(${seeded.feedback.id}::uuid, 'dismissed', now())
        `.execute(transaction);
        return rows[0]!;
      });
      expect(outcome).toEqual({ outcome: "forbidden", user_id: null, email: null });
      const item = await ownerDb.selectFrom("user_feedback").selectAll().where("id", "=", seeded.feedback.id).executeTakeFirstOrThrow();
      expect({ handledAt: item.handled_at, outcome: item.outcome, handledBy: item.handled_by_user_id }).toEqual({
        handledAt: null,
        outcome: null,
        handledBy: null,
      });
    });

    it("product_admin_handle_feedback: an acknowledge racing the sender's delete waits on the sender's lock, then answers author_deleted and leaves the item pending (Ruling 271)", async () => {
      const seeded = await seed();
      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let deletedYet!: () => void;
      const deleted = new Promise<void>((resolve) => {
        deletedYet = resolve;
      });
      // Ben deletes Cara, the sender, and holds his transaction open (the person locked for update).
      const deletion = withProductAdminContext(db, seeded.ben.userId, async (transaction) => {
        const { rows } = await sql<{ outcome: string }>`
          select outcome from product_admin_delete_account(${seeded.cara.userId}::uuid, now())
        `.execute(transaction);
        deletedYet();
        await held;
        return rows[0]!.outcome;
      });
      await deleted;
      const acknowledging = withProductAdminContext(db, seeded.ana.userId, async (transaction) => {
        const { rows } = await sql<{ outcome: string; user_id: string | null; email: string | null }>`
          select * from product_admin_handle_feedback(${seeded.feedback.id}::uuid, 'acknowledged', now())
        `.execute(transaction);
        return rows[0]!;
      });
      // The acknowledge waits on the sender's row: it can't read her as she was before the delete.
      await waitingOnALock();
      commit();
      expect(await deletion).toBe("deleted");
      const outcome = await acknowledging;
      expect({ outcome: outcome.outcome, userId: outcome.user_id, email: outcome.email }).toEqual({ outcome: "author_deleted", userId: null, email: null });
      const item = await ownerDb.selectFrom("user_feedback").selectAll().where("id", "=", seeded.feedback.id).executeTakeFirstOrThrow();
      expect({ handledAt: item.handled_at, outcome: item.outcome }).toEqual({ handledAt: null, outcome: null });
    });
  });
  // Migration 1700000000042's delete (D29 Task 2, decisions 18, 21 and 29; Ruling 257): refused, and
  // changing nothing, wherever the other functions are refused. Kept apart from `calls`, which the first
  // test runs to the end in a product admin's context: a delete there would change the people the others read.
  describe("product_admin_delete_account (migration 1700000000042)", () => {
    const deleteCara = (seeded: Seeded) => sql`select * from product_admin_delete_account(${seeded.cara.userId}::uuid, now())`;
    /** Everything the delete would change, as the owner reads it. */
    const everythingTheDeleteChanges = async () => ({
      ...(await everything()),
      organizations: await ownerDb.selectFrom("organizations").selectAll().orderBy("id").execute(),
      members: await ownerDb.selectFrom("organization_members").selectAll().orderBy("id").execute(),
      sessions: await ownerDb.selectFrom("sessions").selectAll().orderBy("id").execute(),
      records: await ownerDb.selectFrom("user_deletion_records").select("user_id").execute(),
    });

    it("runs for a live human product admin in withProductAdminContext and deletes the person", async () => {
      const seeded = await seed();
      const answered = await withProductAdminContext(db, seeded.ana.userId, async (transaction) => (await deleteCara(seeded).execute(transaction)).rows);
      expect(answered).toEqual([
        {
          outcome: "deleted",
          block_kind: null,
          organizations: [{ id: seeded.cara.organizationId, logoId: null, deletedServiceAccounts: 0 }],
          deleted_service_accounts: 0,
          revoked_sessions: 0,
        },
      ]);
      const cara = await ownerDb.selectFrom("users").select("deleted_at").where("id", "=", seeded.cara.userId).executeTakeFirstOrThrow();
      expect(cara.deleted_at).not.toBeNull();
    });

    it("answers its refusals without a change: not_found (unknown, deleted, a service account), self, blocked (product_admin, member)", async () => {
      const seeded = await seed();
      const answer = async (userId: string) =>
        withProductAdminContext(db, seeded.ana.userId, async (transaction) => {
          const { rows } = await sql<{ outcome: string; block_kind: string | null }>`
            select outcome, block_kind from product_admin_delete_account(${userId}::uuid, now())
          `.execute(transaction);
          return rows[0];
        });
      const member = await person();
      await addMembership(ownerDb, { userId: member.userId, organizationId: seeded.group, role: "contributor" });
      const before = await everythingTheDeleteChanges();
      expect({
        unknown: await answer(randomUUID()),
        deleted: await answer(seeded.gone.userId),
        service: await answer(seeded.bot),
        self: await answer(seeded.ana.userId),
        admin: await answer(seeded.ben.userId),
        member: await answer(member.userId),
      }).toEqual({
        unknown: { outcome: "not_found", block_kind: null },
        deleted: { outcome: "not_found", block_kind: null },
        service: { outcome: "not_found", block_kind: null },
        self: { outcome: "self", block_kind: null },
        admin: { outcome: "blocked", block_kind: "product_admin" },
        member: { outcome: "blocked", block_kind: "member" },
      });
      expect(await everythingTheDeleteChanges()).toEqual(before);
    });
  });
});
