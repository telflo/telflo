import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext } from "../../../database/context.js";
import {
  createConfigurationRepository,
  type Configuration,
  type IConfigurationRepository,
} from "./configuration-repository.js";

describe("configuration repository", () => {
  /** The repository's connection, as the API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;
  /** The catalogue's default distribution, which a configuration is created for. */
  let distribution: string;

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    ({ distribution } = await catalogueDefaults(ownerDb));
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A clock's reading, with milliseconds, as the API's clock gives them. */
  const at = (iso: string) => new Date(iso);

  const configurationRow = (id: string) =>
    ownerDb.selectFrom("configurations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  /**
   * A member acting in a live group organization (they keep their personal
   * one), and another organization with a configuration of its own.
   */
  const organizationWithNeighbour = async () => {
    const member = await createUserWithOrganization(ownerDb, { user: { email: "member@example.com" } });
    const group = await addMembership(ownerDb, { userId: member.user.id, role: "contributor" });
    const neighbour = await createUserWithOrganization(ownerDb);
    const elsewhere = await addConfiguration(ownerDb, {
      organizationId: neighbour.organization.id,
      name: "Elsewhere gateway",
      created_by_user_id: neighbour.user.id,
    });
    return { memberId: member.user.id, organizationId: group.organization.id, elsewhere };
  };

  /** Runs `work` in `organizationId`'s database context, as `userId`, with the repository bound to it. */
  const inOrganization = <Result>(
    userId: string,
    organizationId: string,
    work: (configurations: IConfigurationRepository) => Promise<Result>,
  ) =>
    withDatabaseContext(db, { userId, organizationId }, (transaction) =>
      work(createConfigurationRepository(transaction, { organizationId, userId })),
    );

  /**
   * Fails with 55P03 while another transaction holds a conflicting lock on
   * the row: the deterministic way to see a lock held.
   */
  const probeLock = (table: "configurations" | "users", id: string) =>
    ownerDb
      .transaction()
      .execute((transaction) =>
        sql`select 1 from ${sql.table(table)} where id = ${id} for update nowait`.execute(transaction),
      );

  describe("create", () => {
    it("creates a configuration in the context's organization, created and updated at the clock's time, and returns it with its creator", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const now = at("2030-01-01T00:00:00.123Z");

      const configuration = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.create({
          name: "Gateway",
          description: "Collects logs",
          createdByUserId: memberId,
          collectorDistribution: distribution,
          at: now,
        }),
      );

      expect(configuration).toEqual({
        id: expect.any(String),
        name: "Gateway",
        description: "Collects logs",
        createdAt: now,
        updatedAt: now,
        createdBy: { userId: memberId, email: "member@example.com" },
        // No version yet: a draft.
        published: false,
        collectorDistribution: distribution,
      });
      expect(await configurationRow(configuration.id)).toEqual({
        id: configuration.id,
        organization_id: organizationId,
        name: "Gateway",
        description: "Collects logs",
        created_by_user_id: memberId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        collector_distribution: distribution,
        // Created blank, from no flow.
        source_flow_slug: null,
      });
    });

    it("reads a timestamp written from the clock back equal, to the millisecond", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const now = at("2030-06-15T12:34:56.789Z");
      const created = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.create({
          name: "Gateway",
          description: "",
          createdByUserId: memberId,
          collectorDistribution: distribution,
          at: now,
        }),
      );

      const found = await inOrganization(memberId, organizationId, (configurations) => configurations.find(created.id));
      expect(found?.updatedAt.getTime()).toBe(now.getTime());
      expect(found?.createdAt.toISOString()).toBe("2030-06-15T12:34:56.789Z");
      // And as a cursor it names exactly that row: the next page after it holds nothing at or before it.
      const page = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.listPage({ limit: 10, after: { updatedAt: found!.updatedAt, id: found!.id } }),
      );
      expect(page).toEqual({ items: [], hasMore: false });
    });
  });

  describe("find", () => {
    it("finds a live configuration with its creator's email", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const row = await addConfiguration(ownerDb, { organizationId, name: "Gateway", created_by_user_id: memberId });

      expect(await inOrganization(memberId, organizationId, (configurations) => configurations.find(row.id))).toEqual({
        id: row.id,
        name: "Gateway",
        description: "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: { userId: memberId, email: "member@example.com" },
        published: false,
        collectorDistribution: distribution,
      });
    });

    it("finds nothing for a deleted configuration, or one in another organization", async () => {
      const { memberId, organizationId, elsewhere } = await organizationWithNeighbour();
      const deleted = await addConfiguration(ownerDb, {
        organizationId,
        created_by_user_id: memberId,
        deleted_at: new Date(),
      });

      await inOrganization(memberId, organizationId, async (configurations) => {
        expect(await configurations.find(deleted.id)).toBeUndefined();
        expect(await configurations.find(elsewhere.id)).toBeUndefined();
      });
    });

    it("keeps a soft-deleted creator's email, and has no creator once the account is hard-deleted", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const departed = await createUserWithOrganization(ownerDb, { user: { email: "departed@example.com" } });
      await addMembership(ownerDb, { userId: departed.user.id, organizationId, role: "contributor" });
      const gone = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: gone.user.id, organizationId, role: "contributor" });
      const byDeparted = await addConfiguration(ownerDb, { organizationId, created_by_user_id: departed.user.id });
      const byGone = await addConfiguration(ownerDb, { organizationId, created_by_user_id: gone.user.id });
      // Published, so the member sees them.
      for (const configuration of [byDeparted, byGone]) {
        await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId,
          publishedAt: new Date(),
        });
      }

      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", departed.user.id).execute();
      await ownerDb.deleteFrom("users").where("id", "=", gone.user.id).execute();

      await inOrganization(memberId, organizationId, async (configurations) => {
        expect((await configurations.find(byDeparted.id))?.createdBy).toEqual({
          userId: departed.user.id,
          email: "departed@example.com",
        });
        expect((await configurations.find(byGone.id))?.createdBy).toBeNull();
      });
    });
  });

  describe("lockForUpdate", () => {
    it("returns the live configuration's own columns, and holds its row for update until the transaction ends", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const row = await addConfiguration(ownerDb, {
        organizationId,
        name: "Gateway",
        description: "Collects logs",
        created_by_user_id: memberId,
      });

      await inOrganization(memberId, organizationId, async (configurations) => {
        expect(await configurations.lockForUpdate(row.id)).toEqual({
          id: row.id,
          name: "Gateway",
          description: "Collects logs",
          createdByUserId: memberId,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          collectorDistribution: distribution,
        });
        await expect(probeLock("configurations", row.id)).rejects.toMatchObject({ code: "55P03" });
      });
      await expect(probeLock("configurations", row.id)).resolves.toBeDefined();
    });

    it("locks only the configuration: the creator's account stays free", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const row = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });

      await inOrganization(memberId, organizationId, async (configurations) => {
        await configurations.lockForUpdate(row.id);
        await expect(probeLock("users", memberId)).resolves.toBeDefined();
      });
    });

    it("finds nothing, and locks nothing, for a deleted configuration or one in another organization", async () => {
      const { memberId, organizationId, elsewhere } = await organizationWithNeighbour();
      const deleted = await addConfiguration(ownerDb, {
        organizationId,
        created_by_user_id: memberId,
        deleted_at: new Date(),
      });

      await inOrganization(memberId, organizationId, async (configurations) => {
        expect(await configurations.lockForUpdate(deleted.id)).toBeUndefined();
        expect(await configurations.lockForUpdate(elsewhere.id)).toBeUndefined();
        await expect(probeLock("configurations", deleted.id)).resolves.toBeDefined();
        await expect(probeLock("configurations", elsewhere.id)).resolves.toBeDefined();
      });
    });
  });

  describe("update", () => {
    it("changes the name alone, the description alone, or both, sets updated_at to the clock's time, and returns the configuration with its creator", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const created = at("2030-01-01T00:00:00.000Z");
      const row = await addConfiguration(ownerDb, {
        organizationId,
        name: "Gateway",
        description: "Collects logs",
        created_by_user_id: memberId,
        created_at: created,
        updated_at: created,
      });

      const renamed = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.update(row.id, { name: "Edge gateway" }, at("2030-01-02T00:00:00.001Z")),
      );
      expect(renamed).toEqual({
        id: row.id,
        name: "Edge gateway",
        description: "Collects logs",
        createdAt: created,
        updatedAt: at("2030-01-02T00:00:00.001Z"),
        createdBy: { userId: memberId, email: "member@example.com" },
        published: false,
        collectorDistribution: distribution,
      });

      const described = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.update(row.id, { description: "" }, at("2030-01-03T00:00:00.002Z")),
      );
      expect(described).toMatchObject({ name: "Edge gateway", description: "", updatedAt: at("2030-01-03T00:00:00.002Z") });

      const both = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.update(row.id, { name: "Gateway", description: "Traces" }, at("2030-01-04T00:00:00.003Z")),
      );
      expect(both).toMatchObject({ name: "Gateway", description: "Traces", updatedAt: at("2030-01-04T00:00:00.003Z") });
      expect(await configurationRow(row.id)).toEqual({
        ...row,
        name: "Gateway",
        description: "Traces",
        updated_at: at("2030-01-04T00:00:00.003Z"),
      });
    });

    it("returns undefined and changes nothing for a deleted configuration, or one in another organization", async () => {
      const { memberId, organizationId, elsewhere } = await organizationWithNeighbour();
      const deleted = await addConfiguration(ownerDb, {
        organizationId,
        created_by_user_id: memberId,
        deleted_at: new Date(),
      });

      await inOrganization(memberId, organizationId, async (configurations) => {
        expect(await configurations.update(deleted.id, { name: "Changed" }, new Date())).toBeUndefined();
        expect(await configurations.update(elsewhere.id, { name: "Changed" }, new Date())).toBeUndefined();
      });
      expect(await configurationRow(deleted.id)).toEqual(deleted);
      expect(await configurationRow(elsewhere.id)).toEqual(elsewhere);
    });

    it("takes no lock on the creator's account, though it returns their email", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const row = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });

      await inOrganization(memberId, organizationId, async (configurations) => {
        await configurations.update(row.id, { name: "Changed" }, new Date());
        await expect(probeLock("users", memberId)).resolves.toBeDefined();
      });
    });
  });

  describe("touch", () => {
    it("sets only updated_at to the clock's time, and writes again when touched again", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const row = await addConfiguration(ownerDb, {
        organizationId,
        name: "Gateway",
        description: "Collects logs",
        created_by_user_id: memberId,
        created_at: at("2030-01-01T00:00:00.000Z"),
        updated_at: at("2030-01-01T00:00:00.000Z"),
      });

      expect(
        await inOrganization(memberId, organizationId, (configurations) =>
          configurations.touch(row.id, at("2030-01-02T00:00:00.005Z")),
        ),
      ).toBe(true);
      expect(await configurationRow(row.id)).toEqual({ ...row, updated_at: at("2030-01-02T00:00:00.005Z") });

      expect(
        await inOrganization(memberId, organizationId, (configurations) =>
          configurations.touch(row.id, at("2030-01-03T00:00:00.006Z")),
        ),
      ).toBe(true);
      expect(await configurationRow(row.id)).toEqual({ ...row, updated_at: at("2030-01-03T00:00:00.006Z") });
    });

    it("returns false and changes nothing for a deleted configuration, or one in another organization", async () => {
      const { memberId, organizationId, elsewhere } = await organizationWithNeighbour();
      const deleted = await addConfiguration(ownerDb, {
        organizationId,
        created_by_user_id: memberId,
        deleted_at: new Date(),
      });

      await inOrganization(memberId, organizationId, async (configurations) => {
        expect(await configurations.touch(deleted.id, new Date())).toBe(false);
        expect(await configurations.touch(elsewhere.id, new Date())).toBe(false);
      });
      expect(await configurationRow(deleted.id)).toEqual(deleted);
      expect(await configurationRow(elsewhere.id)).toEqual(elsewhere);
    });

    it("takes no lock on the creator's account", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const row = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });

      await inOrganization(memberId, organizationId, async (configurations) => {
        await configurations.touch(row.id, new Date());
        await expect(probeLock("users", memberId)).resolves.toBeDefined();
      });
    });
  });

  describe("markDeleted", () => {
    it("sets deleted_at and updated_at to the clock's time, once: a second delete changes nothing", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const row = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });
      const now = at("2030-01-05T00:00:00.004Z");

      expect(
        await inOrganization(memberId, organizationId, (configurations) => configurations.markDeleted(row.id, now)),
      ).toBe(true);
      const deleted = await configurationRow(row.id);
      expect(deleted).toEqual({ ...row, deleted_at: now, updated_at: now });

      expect(
        await inOrganization(memberId, organizationId, (configurations) =>
          configurations.markDeleted(row.id, at("2030-01-06T00:00:00.000Z")),
        ),
      ).toBe(false);
      expect(await configurationRow(row.id)).toEqual(deleted);
    });

    it("returns false and changes nothing for a configuration in another organization", async () => {
      const { memberId, organizationId, elsewhere } = await organizationWithNeighbour();
      expect(
        await inOrganization(memberId, organizationId, (configurations) =>
          configurations.markDeleted(elsewhere.id, new Date()),
        ),
      ).toBe(false);
      expect(await configurationRow(elsewhere.id)).toEqual(elsewhere);
    });
  });

  describe("listPage", () => {
    const ids = (items: Configuration[]) => items.map((item) => item.id);

    /**
     * Seeds configurations in `organizationId` updated at each of `times`,
     * created by `createdByUserId`, and returns them in the list's order.
     */
    const seedAt = async (organizationId: string, times: string[], createdByUserId: string) => {
      const rows = [];
      for (const time of times) {
        rows.push(
          await addConfiguration(ownerDb, {
            organizationId,
            created_by_user_id: createdByUserId,
            created_at: at("2029-01-01T00:00:00.000Z"),
            updated_at: at(time),
          }),
        );
      }
      return rows.sort(
        (a, b) => b.updated_at.getTime() - a.updated_at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    };

    it("lists live configurations newest change first, then by id descending, with each creator, and none from another organization or deleted", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const ordered = await seedAt(
        organizationId,
        ["2030-01-01T00:00:00.000Z", "2030-01-03T00:00:00.000Z", "2030-01-02T00:00:00.000Z", "2030-01-02T00:00:00.000Z"],
        memberId,
      );
      await addConfiguration(ownerDb, {
        organizationId,
        created_by_user_id: memberId,
        deleted_at: new Date(),
        updated_at: at("2031-01-01T00:00:00.000Z"),
      });

      const page = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.listPage({ limit: 50 }),
      );

      expect(ids(page.items)).toEqual(ordered.map((row) => row.id));
      expect(page.hasMore).toBe(false);
      expect(page.items[0]).toEqual({
        id: ordered[0]!.id,
        name: ordered[0]!.name,
        description: "",
        createdAt: ordered[0]!.created_at,
        updatedAt: ordered[0]!.updated_at,
        createdBy: { userId: memberId, email: "member@example.com" },
        published: false,
        collectorDistribution: distribution,
      });
    });

    it("returns at most limit items, and says whether more follow", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const ordered = await seedAt(organizationId, [
        "2030-01-01T00:00:00.000Z",
        "2030-01-02T00:00:00.000Z",
        "2030-01-03T00:00:00.000Z",
      ], memberId);

      const list = (limit: number) =>
        inOrganization(memberId, organizationId, (configurations) => configurations.listPage({ limit }));

      expect(await list(1)).toMatchObject({ hasMore: true });
      expect(ids((await list(2)).items)).toEqual([ordered[0]!.id, ordered[1]!.id]);
      expect((await list(2)).hasMore).toBe(true);
      expect(await list(3)).toMatchObject({ hasMore: false });
      expect((await list(3)).items).toHaveLength(3);
      expect(await list(4)).toMatchObject({ hasMore: false });
    });

    it("returns an empty page, with no more, for an organization with none", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      expect(
        await inOrganization(memberId, organizationId, (configurations) => configurations.listPage({ limit: 50 })),
      ).toEqual({ items: [], hasMore: false });
    });

    it("continues strictly after the after pair, including past rows that share its updated_at", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const shared = "2030-01-02T00:00:00.000Z";
      const ordered = await seedAt(organizationId, [
        "2030-01-03T00:00:00.000Z",
        shared,
        shared,
        shared,
        shared,
        "2030-01-01T00:00:00.000Z",
      ], memberId);
      // The second of the four rows sharing updated_at.
      const cursor = ordered[2]!;
      expect(cursor.updated_at).toEqual(at(shared));

      const page = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.listPage({ limit: 50, after: { updatedAt: cursor.updated_at, id: cursor.id } }),
      );
      // The two rows at the same time with a lower id, then the older row; nothing at or before the cursor.
      expect(ids(page.items)).toEqual([ordered[3]!.id, ordered[4]!.id, ordered[5]!.id]);
    });

    it("walks every row exactly once, page by page, when many share an updated_at", async () => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const ordered = await seedAt(organizationId, [
        "2030-01-02T00:00:00.000Z",
        "2030-01-02T00:00:00.000Z",
        "2030-01-02T00:00:00.000Z",
        "2030-01-02T00:00:00.000Z",
        "2030-01-02T00:00:00.000Z",
        "2030-01-03T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
      ], memberId);

      const seen: string[] = [];
      let after: { updatedAt: Date; id: string } | undefined;
      for (let pages = 0; pages < 10; pages += 1) {
        const page = await inOrganization(memberId, organizationId, (configurations) =>
          configurations.listPage({ limit: 2, ...(after && { after }) }),
        );
        seen.push(...ids(page.items));
        if (!page.hasMore) break;
        const last = page.items.at(-1)!;
        after = { updatedAt: last.updatedAt, id: last.id };
      }

      expect(seen).toEqual(ordered.map((row) => row.id));
    });

    type Change = (configurations: IConfigurationRepository, id: string) => Promise<unknown>;
    it.each<[string, Change]>([
      ["deleted", (configurations, id) => configurations.markDeleted(id, at("2030-02-01T00:00:00.000Z"))],
      [
        "renamed, so its updated_at moved",
        (configurations, id) => configurations.update(id, { name: "Renamed meanwhile" }, at("2030-02-01T00:00:00.000Z")),
      ],
      [
        "touched by a save of its YAML, so its updated_at moved",
        (configurations, id) => configurations.touch(id, at("2030-02-01T00:00:00.000Z")),
      ],
    ])("pages on from a cursor whose row was since %s, strictly after the cursor's own pair", async (_how, change) => {
      const { memberId, organizationId } = await organizationWithNeighbour();
      const shared = "2030-01-02T00:00:00.000Z";
      const ordered = await seedAt(organizationId, [
        "2030-01-03T00:00:00.000Z",
        shared,
        shared,
        shared,
        "2030-01-01T00:00:00.000Z",
      ], memberId);
      // The cursor names the middle of the rows sharing updated_at: its values
      // are what the page's last item said, not what the row says now.
      const cursorRow = ordered[2]!;
      const after = { updatedAt: cursorRow.updated_at, id: cursorRow.id };
      await inOrganization(memberId, organizationId, (configurations) => change(configurations, cursorRow.id));

      const page = await inOrganization(memberId, organizationId, (configurations) =>
        configurations.listPage({ limit: 50, after }),
      );

      // The row at the same time with a lower id, then the older row. Neither
      // the changed row (gone, or now first) nor anything before the cursor.
      expect(ids(page.items)).toEqual([ordered[3]!.id, ordered[4]!.id]);
      expect(page.hasMore).toBe(false);
    });

    describe("search", () => {
      const seedNamed = async (
        organizationId: string,
        createdByUserId: string,
        rows: { name: string; description?: string }[],
      ) => {
        const byName: Record<string, string> = {};
        for (const row of rows) {
          byName[row.name] = (
            await addConfiguration(ownerDb, { organizationId, created_by_user_id: createdByUserId, ...row })
          ).id;
        }
        return byName;
      };

      const search = (memberId: string, organizationId: string, text: string) =>
        inOrganization(memberId, organizationId, async (configurations) =>
          ids((await configurations.listPage({ limit: 50, search: text })).items).sort(),
        );

      it("matches a substring of the name or the description, ignoring case", async () => {
        const { memberId, organizationId } = await organizationWithNeighbour();
        const byName = await seedNamed(organizationId, memberId, [
          { name: "Edge Gateway" },
          { name: "Collector", description: "Forwards to the GATEWAY" },
          { name: "Agent", description: "Scrapes metrics" },
        ]);

        expect(await search(memberId, organizationId, "gateway")).toEqual(
          [byName["Edge Gateway"], byName["Collector"]].sort(),
        );
        expect(await search(memberId, organizationId, "RAPES MET")).toEqual([byName["Agent"]]);
        expect(await search(memberId, organizationId, "nothing like it")).toEqual([]);
      });

      it("searches only live configurations in the context's organization", async () => {
        const { memberId, organizationId } = await organizationWithNeighbour();
        await addConfiguration(ownerDb, {
          organizationId,
          name: "Deleted gateway",
          created_by_user_id: memberId,
          deleted_at: new Date(),
        });
        // organizationWithNeighbour's other organization has "Elsewhere gateway".
        expect(await search(memberId, organizationId, "gateway")).toEqual([]);
      });

      it("treats the empty string as no search", async () => {
        const { memberId, organizationId } = await organizationWithNeighbour();
        const byName = await seedNamed(organizationId, memberId, [{ name: "Gateway" }, { name: "Agent" }]);
        expect(await search(memberId, organizationId, "")).toEqual([byName["Gateway"], byName["Agent"]].sort());
      });

      it("matches %, _ and \\ only as themselves", async () => {
        const { memberId, organizationId } = await organizationWithNeighbour();
        const byName = await seedNamed(organizationId, memberId, [
          { name: "100% ready" },
          { name: "100 ready" },
          { name: "snake_case" },
          { name: "snakeXcase" },
          { name: "back\\slash" },
          { name: "backslash" },
          { name: "Plain", description: "50% off" },
        ]);

        expect(await search(memberId, organizationId, "%")).toEqual([byName["100% ready"], byName["Plain"]].sort());
        expect(await search(memberId, organizationId, "0% r")).toEqual([byName["100% ready"]]);
        expect(await search(memberId, organizationId, "_")).toEqual([byName["snake_case"]]);
        expect(await search(memberId, organizationId, "e_c")).toEqual([byName["snake_case"]]);
        expect(await search(memberId, organizationId, "\\")).toEqual([byName["back\\slash"]]);
        expect(await search(memberId, organizationId, "k\\s")).toEqual([byName["back\\slash"]]);
      });
    });

    describe("the filter and the viewer", () => {
      /**
       * The member's own draft and published configuration; a colleague's
       * draft and published one; and a never-published and a published
       * configuration whose author's account is gone. Updated in that order,
       * newest first.
       */
      const seedEveryKind = async () => {
        const { memberId, organizationId } = await organizationWithNeighbour();
        const colleague = await createUserWithOrganization(ownerDb);
        await addMembership(ownerDb, { userId: colleague.user.id, organizationId, role: "contributor" });
        const make = async (createdByUserId: string | null, time: string, published: boolean) => {
          const row = await addConfiguration(ownerDb, {
            organizationId,
            created_by_user_id: createdByUserId,
            created_at: at(time),
            updated_at: at(time),
          });
          await addConfigurationVersion(ownerDb, {
            configurationId: row.id,
            organizationId,
            ...(published ? { publishedAt: at(time) } : {}),
          });
          return row;
        };
        const myDraft = await make(memberId, "2030-01-06T00:00:00.000Z", false);
        const myPublished = await make(memberId, "2030-01-05T00:00:00.000Z", true);
        const theirDraft = await make(colleague.user.id, "2030-01-04T00:00:00.000Z", false);
        const theirPublished = await make(colleague.user.id, "2030-01-03T00:00:00.000Z", true);
        const orphanDraft = await make(null, "2030-01-02T00:00:00.000Z", false);
        const orphanPublished = await make(null, "2030-01-01T00:00:00.000Z", true);
        return {
          memberId,
          colleagueId: colleague.user.id,
          organizationId,
          myDraft,
          myPublished,
          theirDraft,
          theirPublished,
          orphanDraft,
          orphanPublished,
        };
      };

      it("lists, for all, the viewer's drafts and every published configuration, each with its published flag, and never another member's draft or an authorless draft", async () => {
        const seeded = await seedEveryKind();
        const page = await inOrganization(seeded.memberId, seeded.organizationId, (configurations) =>
          configurations.listPage({ limit: 50, filter: "all" }),
        );
        expect(page.items.map(({ id, published }) => [id, published])).toEqual([
          [seeded.myDraft.id, false],
          [seeded.myPublished.id, true],
          [seeded.theirPublished.id, true],
          [seeded.orphanPublished.id, true],
        ]);
        // Left out, the filter is all.
        const unfiltered = await inOrganization(seeded.memberId, seeded.organizationId, (configurations) =>
          configurations.listPage({ limit: 50 }),
        );
        expect(ids(unfiltered.items)).toEqual(ids(page.items));
      });

      it("lists, for mine, only the viewer's own, published or not", async () => {
        const seeded = await seedEveryKind();
        const page = await inOrganization(seeded.memberId, seeded.organizationId, (configurations) =>
          configurations.listPage({ limit: 50, filter: "mine" }),
        );
        expect(ids(page.items)).toEqual([seeded.myDraft.id, seeded.myPublished.id]);
      });

      it("lists, for published, every published configuration, the viewer's and others'", async () => {
        const seeded = await seedEveryKind();
        const page = await inOrganization(seeded.memberId, seeded.organizationId, (configurations) =>
          configurations.listPage({ limit: 50, filter: "published" }),
        );
        expect(ids(page.items)).toEqual([seeded.myPublished.id, seeded.theirPublished.id, seeded.orphanPublished.id]);
      });

      it("shows the colleague their own draft and not the viewer's", async () => {
        const seeded = await seedEveryKind();
        const page = await inOrganization(seeded.colleagueId, seeded.organizationId, (configurations) =>
          configurations.listPage({ limit: 50 }),
        );
        expect(ids(page.items)).toEqual([
          seeded.myPublished.id,
          seeded.theirDraft.id,
          seeded.theirPublished.id,
          seeded.orphanPublished.id,
        ]);
      });

      it("finds, locks, changes, touches and deletes none of another member's drafts, nor an authorless draft, and changes nothing", async () => {
        const seeded = await seedEveryKind();
        await inOrganization(seeded.memberId, seeded.organizationId, async (configurations) => {
          for (const hidden of [seeded.theirDraft, seeded.orphanDraft]) {
            expect(await configurations.find(hidden.id)).toBeUndefined();
            expect(await configurations.lockForUpdate(hidden.id)).toBeUndefined();
            await expect(probeLock("configurations", hidden.id)).resolves.toBeDefined();
            expect(await configurations.update(hidden.id, { name: "Taken" }, new Date())).toBeUndefined();
            expect(await configurations.touch(hidden.id, new Date())).toBe(false);
            expect(await configurations.markDeleted(hidden.id, new Date())).toBe(false);
          }
        });
        expect(await configurationRow(seeded.theirDraft.id)).toEqual(seeded.theirDraft);
        expect(await configurationRow(seeded.orphanDraft.id)).toEqual(seeded.orphanDraft);
      });

      it("finds, locks and changes another member's published configuration, as published", async () => {
        const seeded = await seedEveryKind();
        await inOrganization(seeded.memberId, seeded.organizationId, async (configurations) => {
          expect(await configurations.find(seeded.theirPublished.id)).toMatchObject({
            id: seeded.theirPublished.id,
            published: true,
            createdBy: { userId: seeded.colleagueId },
          });
          expect(await configurations.lockForUpdate(seeded.theirPublished.id)).toMatchObject({
            id: seeded.theirPublished.id,
          });
          expect(
            await configurations.update(seeded.theirPublished.id, { name: "Renamed" }, at("2030-02-01T00:00:00.000Z")),
          ).toMatchObject({ name: "Renamed", published: true });
          expect(await configurations.touch(seeded.theirPublished.id, at("2030-02-02T00:00:00.000Z"))).toBe(true);
        });
      });

      it("combines the after pair, the search and each filter", async () => {
        const { memberId, organizationId } = await organizationWithNeighbour();
        const make = async (name: string, time: string, createdByUserId: string | null, published: boolean) => {
          const row = await addConfiguration(ownerDb, {
            organizationId,
            name,
            created_by_user_id: createdByUserId,
            created_at: at(time),
            updated_at: at(time),
          });
          if (published)
            await addConfigurationVersion(ownerDb, { configurationId: row.id, organizationId, publishedAt: at(time) });
          return row;
        };
        const newest = await make("Gateway A", "2030-01-04T00:00:00.000Z", memberId, true);
        const mineDraft = await make("Gateway B", "2030-01-03T00:00:00.000Z", memberId, false);
        const orphanPublished = await make("Gateway C", "2030-01-02T00:00:00.000Z", null, true);
        await make("Agent", "2030-01-01T00:00:00.000Z", memberId, true);

        const after = { updatedAt: newest.updated_at, id: newest.id };
        const listed = (filter: "all" | "mine" | "published") =>
          inOrganization(memberId, organizationId, async (configurations) =>
            ids((await configurations.listPage({ limit: 50, after, search: "gateway", filter })).items),
          );
        expect(await listed("all")).toEqual([mineDraft.id, orphanPublished.id]);
        expect(await listed("mine")).toEqual([mineDraft.id]);
        expect(await listed("published")).toEqual([orphanPublished.id]);
      });
    });
  });
});
