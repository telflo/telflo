import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";

/*
 * Migration 1700000000043's bootstrap_first_product_admin from the API's own
 * role, telflo_platform: the one way that role makes a product admin without
 * being one. Once: refused while any user holds the flag, deleted or not, a
 * service account included; only for a live human; nulls refused; the flag
 * and the audit row written together. Concurrent calls run one after the
 * other under its advisory lock, so two bootstraps never make two admins.
 * The owner-only trigger still refuses the API's role a direct change.
 * Seeded addresses are @example.com fixtures; nothing here prints one.
 */

describe("bootstrap_first_product_admin (migration 1700000000043) as the API's role", () => {
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

  const AT = new Date("2030-01-02T03:04:05.678Z");

  /** A live, verified person; holding the flag when `admin`. */
  const person = async (admin = false) => {
    const created = await createUserWithOrganization(ownerDb, { user: { is_product_admin: admin } });
    return { userId: created.user.id, organizationId: created.organization.id };
  };

  const bootstrap = (userId: string | null, at: Date | null = AT) =>
    sql`select bootstrap_first_product_admin(${userId}::uuid, ${at}::timestamptz)`;

  /** "ran", or the error's SQLSTATE and its hint after a space when it has one. */
  const outcomeOf = async (connection: Kysely<Database> | Transaction<Database>, userId: string | null, at: Date | null = AT) => {
    try {
      await bootstrap(userId, at).execute(connection);
      return "ran";
    } catch (error) {
      const { code, hint } = error as { code?: string; hint?: string };
      return hint === undefined ? (code ?? "no code") : `${code} ${hint}`;
    }
  };

  const flagHolders = async () =>
    (await ownerDb.selectFrom("users").select("id").where("is_product_admin", "=", true).orderBy("id").execute()).map(
      (row) => row.id,
    );
  const bootstrapAudits = () =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "=", "product_admin.bootstrapped").execute();
  /** The users and the audit trail, as the owner reads them: what a refusal must leave as it was. */
  const everything = async () => ({
    users: await ownerDb.selectFrom("users").selectAll().orderBy("id").execute(),
    audits: await ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute(),
  });

  it("makes a live person the first product admin: the flag (updated_at the given time) and one audit row, the person as actor and subject", async () => {
    const ana = await person();

    expect(await outcomeOf(db, ana.userId)).toBe("ran");

    expect(await flagHolders()).toEqual([ana.userId]);
    const row = await ownerDb.selectFrom("users").select(["email", "updated_at"]).where("id", "=", ana.userId).executeTakeFirstOrThrow();
    expect(row.updated_at).toEqual(AT);
    const audits = await bootstrapAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      occurred_at: AT,
      actor_user_id: ana.userId,
      organization_id: null,
      subject_type: "user",
      subject_id: ana.userId,
      metadata: {},
      ip_address: null,
      user_agent: null,
    });
    expect(audits[0]!.actor_email === row.email).toBe(true);
  });

  it("refuses a second call with 42501 telflo_product_admin_exists, changing nothing: the first admin stays the only one", async () => {
    const ana = await person();
    const ben = await person();
    expect(await outcomeOf(db, ana.userId)).toBe("ran");
    const before = await everything();

    expect(await outcomeOf(db, ben.userId)).toBe("42501 telflo_product_admin_exists");
    // Again for the admin herself.
    expect(await outcomeOf(db, ana.userId)).toBe("42501 telflo_product_admin_exists");
    expect(await everything()).toEqual(before);
  });

  it("counts every flag holder: a deleted admin and a service account holding the flag refuse it too", async () => {
    const gone = await person(true);
    await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", gone.userId).execute();
    const ana = await person();
    const before = await everything();
    expect(await outcomeOf(db, ana.userId)).toBe("42501 telflo_product_admin_exists");
    expect(await everything()).toEqual(before);

    await truncateAll(ownerDb);
    const owner = await person();
    const bot = await addServiceAccount(ownerDb, { organizationId: owner.organizationId });
    await ownerDb.updateTable("users").set({ is_product_admin: true }).where("id", "=", bot.user.id).execute();
    const cara = await person();
    const beforeBot = await everything();
    expect(await outcomeOf(db, cara.userId)).toBe("42501 telflo_product_admin_exists");
    expect(await everything()).toEqual(beforeBot);
  });

  it("refuses with 42501 telflo_bootstrap_user_not_found, changing nothing, unless the user is a live human: unknown, deleted, a service account", async () => {
    const owner = await person();
    const gone = await person();
    await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", gone.userId).execute();
    const bot = await addServiceAccount(ownerDb, { organizationId: owner.organizationId });
    const before = await everything();

    expect({
      unknown: await outcomeOf(db, randomUUID()),
      deleted: await outcomeOf(db, gone.userId),
      service: await outcomeOf(db, bot.user.id),
    }).toEqual({
      unknown: "42501 telflo_bootstrap_user_not_found",
      deleted: "42501 telflo_bootstrap_user_not_found",
      service: "42501 telflo_bootstrap_user_not_found",
    });
    expect(await everything()).toEqual(before);
  });

  it("refuses a null user or time with 22023, changing nothing", async () => {
    const ana = await person();
    const before = await everything();

    expect(await outcomeOf(db, null)).toBe("22023");
    expect(await outcomeOf(db, ana.userId, null)).toBe("22023");
    expect(await everything()).toEqual(before);
  });

  it("its messages are fixed words: never the person's email or id", async () => {
    const ana = await person(true);
    const ben = await person();
    const messages: string[] = [];
    for (const userId of [ben.userId, randomUUID()]) {
      try {
        await bootstrap(userId).execute(db);
      } catch (error) {
        const { message, detail } = error as { message: string; detail?: string };
        messages.push(`${message} ${detail ?? ""}`);
      }
    }
    await truncateAll(ownerDb);
    try {
      await bootstrap(randomUUID()).execute(db);
    } catch (error) {
      messages.push((error as Error).message);
    }
    const emails = (await everything()).users.map((user) => user.email);
    expect(messages).toEqual([
      "a product admin already exists ",
      "a product admin already exists ",
      "no live person has that id",
    ]);
    expect(messages.some((message) => message.includes(ana.userId) || message.includes(ben.userId) || emails.some((email) => message.includes(email)))).toBe(false);
  });

  it("leaves the owner-only trigger standing: the API's role still can't set or clear the flag directly", async () => {
    const ana = await person();
    await expect(
      db.updateTable("users").set({ is_product_admin: true }).where("id", "=", ana.userId).execute(),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await outcomeOf(db, ana.userId)).toBe("ran");
    await expect(
      db.updateTable("users").set({ is_product_admin: false }).where("id", "=", ana.userId).execute(),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await flagHolders()).toEqual([ana.userId]);
  });

  it("can't be replaced or dropped by the API's role", async () => {
    await expect(
      sql`create or replace function bootstrap_first_product_admin(p_user_id uuid, p_at timestamptz) returns void language sql as 'select'`.execute(db),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(sql`drop function bootstrap_first_product_admin(uuid, timestamptz)`.execute(db)).rejects.toMatchObject({
      code: "42501",
    });
  });

  describe("two connections at once", () => {
    /**
     * Ana's bootstrap runs on one connection and holds its transaction open;
     * Ben's runs on another and is seen waiting on a lock (or settles
     * without ever waiting: what a missing lock would let it do); then Ana's
     * transaction ends (`end` commits, or rolls back by throwing). Answers
     * Ben's outcome and whether it ever waited.
     */
    const race = async (end: "commit" | "rollback") => {
      const ana = await person();
      const ben = await person();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let ranYet!: () => void;
      const ran = new Promise<void>((resolve) => {
        ranYet = resolve;
      });
      const rollback = new Error("rolled back on purpose");
      const first = db
        .transaction()
        .execute(async (transaction) => {
          const outcome = await outcomeOf(transaction, ana.userId);
          ranYet();
          await held;
          if (end === "rollback") throw rollback;
          return outcome;
        })
        .catch((error: unknown) => (error === rollback ? "rolled back" : Promise.reject(error)));
      await ran;
      let settled = false;
      const second = outcomeOf(db, ben.userId).finally(() => {
        settled = true;
      });
      let waited = false;
      for (let attempt = 0; attempt < 500 && !settled && !waited; attempt += 1) {
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::integer as waiting from pg_stat_activity
           where wait_event_type = 'Lock' and wait_event = 'advisory' and datname = current_database()
        `.execute(ownerDb);
        waited = rows[0]!.waiting > 0;
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      finish();
      return { ana, ben, first: await first, second: await second, waited };
    };

    it("the second waits on the first's advisory lock, then is refused telflo_product_admin_exists: one admin, one audit row", async () => {
      const { ana, first, second, waited } = await race("commit");

      expect({ first, second, waited }).toEqual({ first: "ran", second: "42501 telflo_product_admin_exists", waited: true });
      expect(await flagHolders()).toEqual([ana.userId]);
      expect(await bootstrapAudits()).toHaveLength(1);
    });

    it("when the first rolls back, the second, having waited, makes its person the admin", async () => {
      const { ben, first, second, waited } = await race("rollback");

      expect({ first, second, waited }).toEqual({ first: "rolled back", second: "ran", waited: true });
      expect(await flagHolders()).toEqual([ben.userId]);
      expect((await bootstrapAudits()).map((row) => row.subject_id)).toEqual([ben.userId]);
    });
  });
});

describe("the bootstrap function's callers", () => {
  /** telflo-core: the Node workspace. */
  const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const skipped = new Set(["node_modules", "dist", "build", "coverage", ".react-router", "test-results"]);
  const sources = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return skipped.has(entry.name) ? [] : sources(path);
      return /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(entry.name) && !/\.timestamp-\d+-[0-9a-f]+\.mjs$/.test(entry.name) ? [path] : [];
    });

  it("names bootstrap_first_product_admin only in user-repository.ts and the migrations: no other code calls it through raw SQL", () => {
    const namers = ["apps", "packages"]
      .flatMap((directory) => sources(join(workspaceRoot, directory)))
      .map((path) => relative(workspaceRoot, path).split(sep).join("/"))
      .filter((path) => !/\.test\.[jt]sx?$/.test(path) && !path.startsWith("packages/db/migrations/"))
      .filter((path) => /bootstrap_first_product_admin/.test(readFileSync(join(workspaceRoot, path), "utf8")));
    expect(namers).toEqual(["apps/api/src/modules/identity/repositories/user-repository.ts"]);
  });
});
