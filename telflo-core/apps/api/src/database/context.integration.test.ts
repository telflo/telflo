import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import {
  createAuthContext,
  setOrganizationContext,
  withAuthContext,
  withDatabaseContext,
  withDispatcherContext,
  withProductAdminContext,
  withUserContext,
  type AuthContext,
} from "./context.js";

/** The two settings as the policies read them: null when unset or empty. */
const readContext = async (db: Kysely<Database>) => {
  const { rows } = await sql<{ userId: string | null; organizationId: string | null }>`
    select nullif(current_setting('telflo.user_id', true), '') as "userId",
           nullif(current_setting('telflo.organization_id', true), '') as "organizationId"
  `.execute(db);
  return rows[0]!;
};

describe("the database context (D5 decision 2)", () => {
  /** The API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;

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

  const authContext = (overrides: Partial<AuthContext> = {}): AuthContext =>
    createAuthContext({
      userId: "0190a5b0-0000-7000-8000-000000000001",
      organizationId: "0190a5b0-0000-7000-8000-000000000002",
      role: "admin",
      sessionId: "0190a5b0-0000-7000-8000-000000000003",
      ...overrides,
    });

  it("sets both settings inside withAuthContext", async () => {
    const context = authContext();
    expect(await withAuthContext(db, context, (transaction) => readContext(transaction))).toEqual({
      userId: context.userId,
      organizationId: context.organizationId,
    });
  });

  it("leaves nothing behind on the pooled connection once the transaction ends", async () => {
    // One connection throughout, so the second read is on the connection
    // the context was set on.
    await db.connection().execute(async (connection) => {
      const inside = await withAuthContext(connection, authContext(), async (transaction) => ({
        pid: (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(transaction)).rows[0]!.pid,
        context: await readContext(transaction),
      }));
      expect(inside.context.userId).not.toBeNull();

      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(connection);
      expect(rows[0]!.pid).toBe(inside.pid);
      expect(await readContext(connection)).toEqual({ userId: null, organizationId: null });
    });
  });

  it("rolls back when work rejects, and the rejection propagates", async () => {
    const { user } = await createUserWithOrganization(ownerDb);
    const failure = new Error("work failed");
    await expect(
      withUserContext(db, user.id, async (transaction) => {
        await transaction.updateTable("users").set({ accepted_terms_version: "rolled-back" }).where("id", "=", user.id).execute();
        throw failure;
      }),
    ).rejects.toBe(failure);

    const row = await ownerDb
      .selectFrom("users")
      .select("accepted_terms_version")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(row.accepted_terms_version).toBe("2026-01-01");
  });

  it("shows a withUserContext transaction the user's memberships in two organizations, but not a third user's", async () => {
    const { user, organization: personal } = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: user.id });
    const stranger = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: stranger.user.id, organizationId: group.organization.id });

    const visible = await withUserContext(db, user.id, (transaction) =>
      transaction.selectFrom("organization_members").select(["user_id", "organization_id"]).execute(),
    );

    expect(visible).toHaveLength(2);
    expect(visible.every((membership) => membership.user_id === user.id)).toBe(true);
    expect(visible.map((membership) => membership.organization_id).sort()).toEqual(
      [personal.id, group.organization.id].sort(),
    );
  });

  it("sets only the user when withUserContext or a null organization is given", async () => {
    const userId = "0190a5b0-0000-7000-8000-000000000004";
    expect(await withUserContext(db, userId, (transaction) => readContext(transaction))).toEqual({
      userId,
      organizationId: null,
    });
    expect(
      await withDatabaseContext(db, { userId, organizationId: null }, (transaction) => readContext(transaction)),
    ).toEqual({ userId, organizationId: null });
  });

  it("sets the organization on an open transaction with setOrganizationContext", async () => {
    const organizationId = "0190a5b0-0000-7000-8000-000000000005";
    const read = await db.transaction().execute(async (transaction) => {
      await setOrganizationContext(transaction, organizationId);
      return readContext(transaction);
    });
    expect(read).toEqual({ userId: null, organizationId });
  });

  it("passes values as bind parameters: a quote in a value is stored, not executed", async () => {
    const hostile = "x', true), set_config('telflo.organization_id', 'injected";
    const read = await db.transaction().execute(async (transaction) => {
      await setOrganizationContext(transaction, hostile);
      return readContext(transaction);
    });
    expect(read.organizationId).toBe(hostile);
  });

  it("sets the dispatcher's context in withDispatcherContext: the setting on, no user, no organization; and leaves nothing behind", async () => {
    const readDispatcher = async (connection: Kysely<Database>) => ({
      ...(await readContext(connection)),
      dispatcher: (
        await sql<{ dispatcher: string | null }>`
          select nullif(current_setting('telflo.dispatcher', true), '') as dispatcher
        `.execute(connection)
      ).rows[0]!.dispatcher,
    });
    await db.connection().execute(async (connection) => {
      expect(await withDispatcherContext(connection, (transaction) => readDispatcher(transaction))).toEqual({
        userId: null,
        organizationId: null,
        dispatcher: "on",
      });
      expect(await readDispatcher(connection)).toEqual({ userId: null, organizationId: null, dispatcher: null });
    });
  });

  it("sets the product admin's context in withProductAdminContext: the setting on, the caller, no organization, READ COMMITTED; and leaves nothing behind (D29 decision 17)", async () => {
    const caller = "0190a5b0-0000-7000-8000-000000000009";
    const readProductAdmin = async (connection: Kysely<Database>) => ({
      ...(await readContext(connection)),
      ...(
        await sql<{ productAdmin: string | null; isolation: string }>`
          select nullif(current_setting('telflo.product_admin', true), '') as "productAdmin",
                 current_setting('transaction_isolation') as isolation
        `.execute(connection)
      ).rows[0]!,
    });
    await db.connection().execute(async (connection) => {
      expect(await withProductAdminContext(connection, caller, (transaction) => readProductAdmin(transaction))).toEqual({
        userId: caller,
        organizationId: null,
        productAdmin: "on",
        isolation: "read committed",
      });
      expect(await readProductAdmin(connection)).toMatchObject({ userId: null, organizationId: null, productAdmin: null });
    });
  });

  it("freezes an AuthContext", () => {
    const context = authContext();
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      (context as { role: string }).role = "contributor";
    }).toThrow(TypeError);
  });
});
