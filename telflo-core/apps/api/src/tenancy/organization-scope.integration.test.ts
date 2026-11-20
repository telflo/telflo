import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { createOrganizationScope, type OrganizationScope } from "./organization-scope.js";

/**
 * The scope's own filter, proven on the owner's connection, which row-level
 * security exempts: nothing but the scope stands between these queries and
 * the other organization's rows.
 */
describe("the organization scope", () => {
  /** The tables' owner, which row-level security doesn't constrain. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;

  beforeAll(() => {
    databases = openTestDatabases();
    ({ ownerDb } = databases);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /**
   * Two group organizations, each with the same two people as members. Both
   * people keep their personal organizations, so a membership can be removed
   * or deleted without breaking the invariant.
   */
  const twoOrganizations = async () => {
    const first = await createUserWithOrganization(ownerDb);
    const second = await createUserWithOrganization(ownerDb);
    const a = (await addMembership(ownerDb, { userId: first.user.id })).organization;
    await addMembership(ownerDb, { userId: second.user.id, organizationId: a.id, role: "contributor" });
    const b = (await addMembership(ownerDb, { userId: first.user.id })).organization;
    await addMembership(ownerDb, { userId: second.user.id, organizationId: b.id, role: "contributor" });
    return { a, b, first: first.user.id, second: second.user.id };
  };

  /** Runs `work` with a scope on organization `organizationId`, in one owner transaction. */
  const inScope = <Result>(
    organizationId: string,
    work: (scope: OrganizationScope, transaction: Transaction<Database>) => Promise<Result>,
  ) =>
    ownerDb
      .transaction()
      .execute((transaction) => work(createOrganizationScope(transaction, { organizationId }), transaction));

  const membershipsOf = (organizationId: string) =>
    ownerDb
      .selectFrom("organization_members")
      .select(["user_id", "role", "deleted_at"])
      .where("organization_id", "=", organizationId)
      .orderBy("user_id")
      .execute();

  it("selectFrom sees only the context's organization", async () => {
    const { a, b } = await twoOrganizations();
    const members = await inScope(b.id, (scope) =>
      scope.selectFrom("organization_members").select("organization_id").execute(),
    );
    expect(members.map((member) => member.organization_id)).toEqual([b.id, b.id]);

    const organizations = await inScope(b.id, (scope) => scope.selectFrom("organizations").select("id").execute());
    expect(organizations).toEqual([{ id: b.id }]);
    expect(organizations).not.toContainEqual({ id: a.id });
  });

  it("selectFrom keeps its filter unambiguous across a join", async () => {
    const { b } = await twoOrganizations();
    const rows = await inScope(b.id, (scope) =>
      scope
        .selectFrom("organizations")
        .innerJoin("organization_members", "organization_members.organization_id", "organizations.id")
        .select(["organizations.id", "organization_members.user_id"])
        .execute(),
    );
    expect(rows.map((row) => row.id)).toEqual([b.id, b.id]);
  });

  it("updateTable changes only the context's organization", async () => {
    const { a, b } = await twoOrganizations();
    const before = await membershipsOf(a.id);
    const result = await inScope(b.id, (scope) =>
      scope.updateTable("organization_members", { role: "contributor" }).executeTakeFirst(),
    );
    expect(result.numUpdatedRows).toBe(2n);
    expect((await membershipsOf(b.id)).map((member) => member.role)).toEqual(["contributor", "contributor"]);
    expect(await membershipsOf(a.id)).toEqual(before);

    await inScope(b.id, (scope) => scope.updateTable("organizations", { name: "Renamed" }).execute());
    const names = await ownerDb
      .selectFrom("organizations")
      .select(["id", "name"])
      .where("id", "in", [a.id, b.id])
      .execute();
    expect(Object.fromEntries(names.map((row) => [row.id, row.name]))).toEqual({ [a.id]: a.name, [b.id]: "Renamed" });
  });

  it("updateTable refuses to set the scoping column, so no row moves to another organization", async () => {
    const { a, b } = await twoOrganizations();
    const membersBefore = { a: await membershipsOf(a.id), b: await membershipsOf(b.id) };
    await inScope(b.id, async (scope) => {
      expect(() =>
        // @ts-expect-error The scoping column is left out of a scoped update's values.
        scope.updateTable("organization_members", { organization_id: a.id }),
      ).toThrow("a scoped update can't set organization_members.organization_id");
      expect(() =>
        // @ts-expect-error The same for the tenant row's own id.
        scope.updateTable("organizations", { id: a.id }),
      ).toThrow("a scoped update can't set organizations.id");
    });
    expect({ a: await membershipsOf(a.id), b: await membershipsOf(b.id) }).toEqual(membersBefore);
    const ids = await ownerDb.selectFrom("organizations").select("id").where("id", "in", [a.id, b.id]).execute();
    expect(ids.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("deleteFrom deletes only the context's organization's rows", async () => {
    const { a, b } = await twoOrganizations();
    const before = await membershipsOf(a.id);
    const result = await inScope(b.id, (scope) => scope.deleteFrom("organization_members").executeTakeFirst());
    expect(result.numDeletedRows).toBe(2n);
    expect(await membershipsOf(b.id)).toEqual([]);
    expect(await membershipsOf(a.id)).toEqual(before);
  });

  it("insertInto sets the context's organization", async () => {
    const { b } = await twoOrganizations();
    const outsider = await createUserWithOrganization(ownerDb);
    const row = await inScope(b.id, (scope) =>
      scope
        .insertInto("organization_members", { user_id: outsider.user.id, role: "contributor" })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    expect(row.organization_id).toBe(b.id);
  });

  it("insertInto overwrites an organization the row names with the context's", async () => {
    const { a, b } = await twoOrganizations();
    const outsider = await createUserWithOrganization(ownerDb);
    const rows = await inScope(b.id, (scope) =>
      scope
        .insertInto("organization_members", [{ organization_id: a.id, user_id: outsider.user.id, role: "admin" }])
        .returningAll()
        .execute(),
    );
    expect(rows.map((row) => row.organization_id)).toEqual([b.id]);
    expect((await membershipsOf(a.id)).map((member) => member.user_id)).not.toContain(outsider.user.id);
  });

  it("takes only the tables in its map (a compile error otherwise)", async () => {
    const { b } = await twoOrganizations();
    await inScope(b.id, async (scope) => {
      // @ts-expect-error `users` belongs to no organization, so the scope refuses it.
      expect(() => scope.selectFrom("users")).toThrow();
    });
  });
});
