import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
} from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * configuration_versions (migration 1700000000016; its graph, migration
 * 1700000000017; its label, migration 1700000000018; its publish columns and
 * the immutability of a published version, migration 1700000000020): its
 * constraints and its composite foreign key, as the owner; its row-level
 * security, as the API's role (`db`), which the policies constrain; the
 * immutability trigger, as both. The migrations' effect on existing rows is
 * tested in schema.integration.test.ts, which has the throwaway database it
 * needs.
 */
describe("configuration_versions", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  /** The catalogue's default distribution and version, which a row written by hand names. */
  let pin: { distribution: string; version: string };
  /** Another version of the default distribution in the catalogue, not deprecated: a pin a draft may move to. */
  let otherVersion: string;

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    pin = await catalogueDefaults(ownerDb);
    const other = await ownerDb
      .selectFrom("collector_versions")
      .select("version")
      .where("distribution", "=", pin.distribution)
      .where("is_default", "=", false)
      .where("deprecated", "=", false)
      .orderBy("version", "desc")
      .executeTakeFirstOrThrow();
    otherVersion = other.version;
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A live group organization with an admin, who also keeps their personal organization, and a configuration in it. */
  const createConfiguration = async () => {
    const admin = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: admin.user.id });
    const configuration = await addConfiguration(ownerDb, {
      organizationId: group.organization.id,
      created_by_user_id: admin.user.id,
    });
    return { adminId: admin.user.id, organizationId: group.organization.id, configuration };
  };

  const versionRow = (id: string) =>
    ownerDb.selectFrom("configuration_versions").selectAll().where("id", "=", id).executeTakeFirst();

  /**
   * Runs `work` as the API's role in a transaction whose context is
   * `organizationId` and, when given, `userId`, as context.ts sets them
   * (null: no organization). A published configuration's versions are
   * visible with the organization alone; a draft's only to its creator.
   */
  const inContext = <T>(
    organizationId: string | null,
    work: (transaction: Kysely<Database>) => Promise<T>,
    userId?: string,
  ) =>
    db.transaction().execute(async (transaction) => {
      if (organizationId !== null) {
        await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
      }
      if (userId !== undefined) {
        await sql`select set_config('telflo.user_id', ${userId}, true)`.execute(transaction);
      }
      return work(transaction);
    });

  describe("constraints", () => {
    it("stores a version as given, with a uuidv7 id", async () => {
      const { adminId, organizationId, configuration } = await createConfiguration();
      const at = new Date("2030-01-01T00:00:00.123Z");
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "receivers:\n  otlp: {}\n",
        created_by_user_id: adminId,
        created_at: at,
        updated_at: at,
      });
      expect(version).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        configuration_id: configuration.id,
        organization_id: organizationId,
        version_number: 1,
        yaml_content: "receivers:\n  otlp: {}\n",
        label: null,
        created_by_user_id: adminId,
        created_at: at,
        updated_at: at,
        nodes: [],
        edges: [],
        pipelines: [],
        published_at: null,
        published_by_user_id: null,
        publication_id: null,
        // The fixture's pin: the configuration's distribution at its default version, from the catalogue.
        collector_distribution: pin.distribution,
        collector_version: pin.version,
      });
    });

    it("refuses version number 0, and a negative one", async () => {
      const { organizationId, configuration } = await createConfiguration();
      for (const version_number of [0, -1]) {
        await expect(
          addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number }),
        ).rejects.toThrow(/ck_configuration_versions_version_number/);
      }
    });

    it("refuses a second row with a configuration's version number, and allows the next number and another configuration's 1", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const other = await addConfiguration(ownerDb, { organizationId });
      await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });

      await expect(
        addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId }),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_configuration_versions_organization_configuration_version",
      });
      await expect(
        addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number: 2 }),
      ).resolves.toMatchObject({ version_number: 2 });
      await expect(
        addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId }),
      ).resolves.toMatchObject({ version_number: 1 });
    });

    it("accepts 262,144 characters of YAML and refuses 262,145", async () => {
      const { organizationId, configuration } = await createConfiguration();
      await expect(
        addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId,
          yaml_content: "y".repeat(262_145),
        }),
      ).rejects.toThrow(/ck_configuration_versions_yaml_content_length/);
      const stored = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "y".repeat(262_144),
      });
      expect(stored.yaml_content).toHaveLength(262_144);
    });

    it("refuses a row without yaml_content, created_at or updated_at (23502): none has a default, so a write that forgets one fails", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const now = new Date();
      await expect(
        sql`insert into configuration_versions (configuration_id, organization_id, version_number, created_at, updated_at)
            values (${configuration.id}, ${organizationId}, 1, ${now}, ${now})`.execute(ownerDb),
      ).rejects.toMatchObject({ code: "23502", column: "yaml_content" });
      await expect(
        sql`insert into configuration_versions (configuration_id, organization_id, version_number, yaml_content, updated_at)
            values (${configuration.id}, ${organizationId}, 1, '', ${now})`.execute(ownerDb),
      ).rejects.toMatchObject({ code: "23502", column: "created_at" });
      await expect(
        sql`insert into configuration_versions (configuration_id, organization_id, version_number, yaml_content, created_at)
            values (${configuration.id}, ${organizationId}, 1, '', ${now})`.execute(ownerDb),
      ).rejects.toMatchObject({ code: "23502", column: "updated_at" });
    });

    it("refuses a version of a configuration that does not exist", async () => {
      const { organizationId } = await createConfiguration();
      await expect(
        addConfigurationVersion(ownerDb, { configurationId: "00000000-0000-7000-8000-000000000000", organizationId }),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_configuration_versions_configuration" });
    });

    it("keeps the version, with no creator, when the creator's account is hard-deleted", async () => {
      // In a group organization: a personal one cascades with its owner and
      // would take the configuration, and its versions, with it.
      const { organizationId, configuration } = await createConfiguration();
      const creator = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: creator.user.id, organizationId, role: "contributor" });
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        created_by_user_id: creator.user.id,
      });

      await ownerDb.deleteFrom("users").where("id", "=", creator.user.id).execute();

      expect(await versionRow(version.id)).toEqual({ ...version, created_by_user_id: null });
    });
  });

  describe("the label", () => {
    it("accepts a label of 80 characters, and of 1", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const long = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        label: "l".repeat(80),
      });
      expect(long.label).toBe("l".repeat(80));
      const short = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        label: "l",
      });
      expect(short.label).toBe("l");
    });

    it("counts characters, not bytes: 80 characters outside the Basic Multilingual Plane are accepted", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const stored = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        label: "📈".repeat(80),
      });
      expect(stored.label).toBe("📈".repeat(80));
    });

    it("refuses a label of 81 characters (23514)", async () => {
      const { organizationId, configuration } = await createConfiguration();
      await expect(
        addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, label: "l".repeat(81) }),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_configuration_versions_label_length" });
    });

    it("refuses the empty label (23514): an unnamed version stores null", async () => {
      const { organizationId, configuration } = await createConfiguration();
      await expect(
        addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, label: "" }),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_configuration_versions_label_length" });
    });

    it("accepts null, and makes a label left out null", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const unnamed = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      expect(unnamed.label).toBeNull();
      const explicit = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
        label: null,
      });
      expect(explicit.label).toBeNull();
    });

    it("refuses renaming a version to 81 characters or '', even as the owner, and keeps its label", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        label: "kept",
      });
      for (const label of ["l".repeat(81), ""]) {
        await expect(
          ownerDb.updateTable("configuration_versions").set({ label }).where("id", "=", version.id).execute(),
        ).rejects.toMatchObject({ code: "23514", constraint: "ck_configuration_versions_label_length" });
      }
      expect(await versionRow(version.id)).toEqual(version);
    });
  });

  describe("the graph columns", () => {
    const graphColumns = ["nodes", "edges", "pipelines"] as const;

    /** Sets one graph column of a new version to `value`, as SQL: `json` is JSON text, `null` is SQL NULL. */
    const insertWithColumn = async (column: (typeof graphColumns)[number], json: string | null) => {
      const { organizationId, configuration } = await createConfiguration();
      const now = new Date();
      return sql<{ id: string }>`
        insert into configuration_versions
          (configuration_id, organization_id, version_number, yaml_content, created_at, updated_at,
           collector_distribution, collector_version, ${sql.ref(column)})
        values (${configuration.id}, ${organizationId}, 1, '', ${now}, ${now}, ${pin.distribution}, ${pin.version},
                ${json}::jsonb)
        returning id
      `.execute(ownerDb);
    };

    /** The column's size as the backstop measures it: jsonb's own text, in bytes. */
    const printedBytes = async (id: string, column: (typeof graphColumns)[number]) => {
      const { rows } = await sql<{ bytes: number }>`
        select octet_length(${sql.ref(column)}::text) as bytes from configuration_versions where id = ${id}
      `.execute(ownerDb);
      return rows[0]?.bytes;
    };

    it.each(graphColumns)("stores %s as given, and reads it back as JSON", async (column) => {
      const value = [{ id: "n-1", position: { x: 1.5, y: -2 }, data: { label: "é 📈", config: null } }, 0, "s"];
      const { rows } = await insertWithColumn(column, JSON.stringify(value));
      expect((await versionRow(rows[0]!.id))?.[column]).toEqual(value);
    });

    it.each(graphColumns)(
      "refuses %s holding an object, JSON null, a string or a number (23514): it must be an array",
      async (column) => {
        for (const json of ["{}", '{"nodes":[]}', "null", '"[]"', "0"]) {
          await expect(insertWithColumn(column, json)).rejects.toMatchObject({
            code: "23514",
            constraint: `ck_configuration_versions_${column}_array`,
          });
        }
      },
    );

    it.each(graphColumns)("refuses %s as SQL NULL (23502)", async (column) => {
      await expect(insertWithColumn(column, null)).rejects.toMatchObject({ code: "23502", column });
    });

    it.each(graphColumns)(
      "allows %s at exactly 4,194,304 bytes of jsonb text, and refuses a byte more (23514): the backstop",
      async (column) => {
        // ["xxx…"] prints as itself: the string's length plus 4 bytes.
        const atLimit = await insertWithColumn(column, JSON.stringify(["x".repeat(4_194_300)]));
        expect(await printedBytes(atLimit.rows[0]!.id, column)).toBe(4_194_304);

        await expect(insertWithColumn(column, JSON.stringify(["x".repeat(4_194_301)]))).rejects.toMatchObject({
          code: "23514",
          constraint: `ck_configuration_versions_${column}_size`,
        });
      },
    );

    it("measures jsonb's own text, which is longer than JSON.stringify's, and stores 1 MiB of it (the contract's bound) well within the backstop", async () => {
      // [0,0,…] of 1,048,575 bytes: jsonb prints a space after each comma.
      const zeros = Array.from({ length: 524_287 }, () => 0);
      expect(Buffer.byteLength(JSON.stringify(zeros))).toBe(1_048_575);
      const { rows } = await insertWithColumn("nodes", JSON.stringify(zeros));
      expect(await printedBytes(rows[0]!.id, "nodes")).toBe(1_572_861);
    });
  });

  describe("publishing", () => {
    const publishedAt = new Date("2030-01-02T00:00:00.456Z");

    /**
     * A version 1, published or a draft, with content in every column, of a
     * configuration in a group organization. Its creator and its publisher
     * are separate members, each with a personal organization of their own,
     * so either account can be hard-deleted without taking the group with it.
     * Also: a second configuration in the same organization, another
     * organization's configuration and another member, as targets a guarded
     * column could be moved to.
     */
    const createVersion = async (published: boolean) => {
      const { adminId, organizationId, configuration } = await createConfiguration();
      const publisher = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: publisher.user.id, organizationId, role: "contributor" });
      const other = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: other.user.id, organizationId, role: "contributor" });
      const sibling = await addConfiguration(ownerDb, { organizationId, created_by_user_id: adminId });
      const elsewhere = await createConfiguration();
      const at = new Date("2030-01-01T00:00:00.123Z");
      const version = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        yaml_content: "receivers:\n  otlp: {}\n",
        label: "Initial version",
        nodes: JSON.stringify([{ id: "n-1" }]),
        edges: JSON.stringify([{ id: "e-1" }]),
        pipelines: JSON.stringify([{ id: "p-1" }]),
        created_by_user_id: adminId,
        created_at: at,
        updated_at: at,
        ...(published ? { publishedAt, publishedByUserId: publisher.user.id } : {}),
      });
      return {
        version,
        organizationId,
        creatorId: adminId,
        publisherId: publisher.user.id,
        otherUserId: other.user.id,
        siblingConfigurationId: sibling.id,
        elsewhere,
      };
    };
    const createPublished = () => createVersion(true);
    type Published = Awaited<ReturnType<typeof createVersion>>;

    /** `update configuration_versions set <column> = <value>, … where id = <id>`, as `executor`; SQL NULL for null. */
    const updateVersion = (executor: Kysely<Database>, id: string, set: Record<string, unknown>) =>
      sql`
        update configuration_versions
           set ${sql.join(Object.entries(set).map(([column, value]) => sql`${sql.ref(column)} = ${value}`))}
         where id = ${id}
      `.execute(executor);

    const refusal = (id: string) => ({
      code: "P0001",
      message: `configuration version ${id} is published and can't be changed`,
    });

    /**
     * One change per guarded column (and the ways to clear the publish
     * record), each a change the table would otherwise accept from the
     * owner, except organization_id and collector_distribution, which the
     * composite foreign keys would refuse on their own (23503, not the
     * trigger's P0001).
     */
    const guardedChanges: Array<[string, (published: Published) => Record<string, unknown>]> = [
      ["yaml_content", () => ({ yaml_content: "exporters: {}\n" })],
      ["nodes", () => ({ nodes: JSON.stringify([{ id: "n-2" }]) })],
      ["edges", () => ({ edges: JSON.stringify([]) })],
      ["pipelines", () => ({ pipelines: JSON.stringify([{ id: "p-2" }]) })],
      ["label", () => ({ label: "Renamed" })],
      ["label, to null", () => ({ label: null })],
      ["published_at", () => ({ published_at: new Date("2031-01-01T00:00:00.000Z") })],
      [
        "published_at and publication_id, both to null (an unpublish)",
        () => ({ published_at: null, publication_id: null }),
      ],
      ["publication_id", () => ({ publication_id: randomUUID() })],
      ["published_by_user_id, to another member", ({ otherUserId }) => ({ published_by_user_id: otherUserId })],
      [
        "published_by_user_id to null together with the label",
        () => ({ published_by_user_id: null, label: "Renamed" }),
      ],
      ["version_number", () => ({ version_number: 2 })],
      ["configuration_id", ({ siblingConfigurationId }) => ({ configuration_id: siblingConfigurationId })],
      ["organization_id", ({ elsewhere }) => ({ organization_id: elsewhere.organizationId })],
      ["created_at", () => ({ created_at: new Date("2029-01-01T00:00:00.000Z") })],
      ["id", () => ({ id: randomUUID() })],
      // Migration 1700000000023: the pin is the version's content too.
      ["collector_version, to another version of the catalogue", () => ({ collector_version: otherVersion })],
      ["collector_distribution", () => ({ collector_distribution: "fixture-distribution" })],
    ];

    describe("the publish columns", () => {
      it("makes a version left unpublished a draft: all three columns null", async () => {
        const { organizationId, configuration } = await createConfiguration();
        const draft = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
        expect(draft).toMatchObject({ published_at: null, published_by_user_id: null, publication_id: null });
      });

      it("stores a published version's three columns as given", async () => {
        const { version, publisherId } = await createPublished();
        expect(await versionRow(version.id)).toMatchObject({
          published_at: publishedAt,
          published_by_user_id: publisherId,
          publication_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
      });

      it("refuses published_at without publication_id, and publication_id without published_at (23514)", async () => {
        const { organizationId, configuration } = await createConfiguration();
        await expect(
          addConfigurationVersion(ownerDb, {
            configurationId: configuration.id,
            organizationId,
            publishedAt,
            publicationId: null,
          }),
        ).rejects.toMatchObject({ code: "23514", constraint: "ck_configuration_versions_published_at_publication_id" });
        await expect(
          addConfigurationVersion(ownerDb, {
            configurationId: configuration.id,
            organizationId,
            publicationId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "23514", constraint: "ck_configuration_versions_published_at_publication_id" });
        expect(await ownerDb.selectFrom("configuration_versions").select("id").execute()).toEqual([]);
      });

      it("refuses publishing a draft with only one of published_at and publication_id (23514), and accepts both", async () => {
        const { organizationId, configuration } = await createConfiguration();
        const draft = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
        await expect(updateVersion(ownerDb, draft.id, { published_at: publishedAt })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_configuration_versions_published_at_publication_id",
        });
        await expect(updateVersion(ownerDb, draft.id, { publication_id: randomUUID() })).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_configuration_versions_published_at_publication_id",
        });
        expect(await versionRow(draft.id)).toEqual(draft);

        const publicationId = randomUUID();
        await updateVersion(ownerDb, draft.id, { published_at: publishedAt, publication_id: publicationId });
        expect(await versionRow(draft.id)).toEqual({
          ...draft,
          published_at: publishedAt,
          publication_id: publicationId,
        });
      });

      it("refuses a second version with the same publication_id (23505), even in another configuration", async () => {
        const { version } = await createPublished();
        const other = await createConfiguration();
        await expect(
          addConfigurationVersion(ownerDb, {
            configurationId: other.configuration.id,
            organizationId: other.organizationId,
            publishedAt,
            publicationId: version.publication_id,
          }),
        ).rejects.toMatchObject({ code: "23505", constraint: "uq_configuration_versions_publication_id" });
      });

      it("allows many drafts: a null publication_id collides with nothing", async () => {
        const { organizationId, configuration } = await createConfiguration();
        for (const version_number of [1, 2, 3]) {
          await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId, version_number });
        }
        const { rows } = await sql<{ drafts: number }>`
          select count(*)::int as drafts from configuration_versions where publication_id is null
        `.execute(ownerDb);
        expect(rows[0]!.drafts).toBe(3);
      });

      it("refuses inserting a draft with a publisher (23514), and accepts a published version with none", async () => {
        const { adminId, organizationId, configuration } = await createConfiguration();
        await expect(
          addConfigurationVersion(ownerDb, {
            configurationId: configuration.id,
            organizationId,
            publishedByUserId: adminId,
          }),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "ck_configuration_versions_publisher_only_when_published",
        });
        const unattributed = await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId,
          publishedAt,
        });
        expect(unattributed).toMatchObject({ published_at: publishedAt, published_by_user_id: null });
      });

      it("refuses a publisher who does not exist (23503)", async () => {
        const { organizationId, configuration } = await createConfiguration();
        await expect(
          addConfigurationVersion(ownerDb, {
            configurationId: configuration.id,
            organizationId,
            publishedAt,
            publishedByUserId: "00000000-0000-7000-8000-000000000000",
          }),
        ).rejects.toMatchObject({ code: "23503", constraint: "configuration_versions_published_by_user_id_fkey" });
      });
    });

    describe("a published version is immutable", () => {
      it.each(guardedChanges)(
        "refuses changing %s on a published version, as the application role (P0001), and keeps the row",
        async (_, change) => {
          const published = await createPublished();
          const { version, organizationId } = published;
          await expect(
            inContext(organizationId, (transaction) => updateVersion(transaction, version.id, change(published))),
          ).rejects.toMatchObject(refusal(version.id));
          expect(await versionRow(version.id)).toEqual(version);
        },
      );

      it.each(guardedChanges)(
        "refuses changing %s on a published version, as the tables' owner with a plain update (P0001), and keeps the row",
        async (_, change) => {
          const published = await createPublished();
          const { version } = published;
          await expect(updateVersion(ownerDb, version.id, change(published))).rejects.toMatchObject(
            refusal(version.id),
          );
          expect(await versionRow(version.id)).toEqual(version);
        },
      );

      it("names only the version's id in the refusal: no content, label or user", async () => {
        const { version, organizationId } = await createPublished();
        const error = await inContext(organizationId, (transaction) =>
          updateVersion(transaction, version.id, { label: "Secret name", yaml_content: "secret: yaml\n" }),
        ).then(
          () => undefined,
          (caught: unknown) => caught as { message: string; detail?: string; hint?: string },
        );
        expect(error).toMatchObject(refusal(version.id));
        expect(error?.detail).toBeUndefined();
        expect(error?.hint).toBeUndefined();
      });

      it("refuses an update of many rows outright when one is published, and changes none of them", async () => {
        const { version, organizationId } = await createPublished();
        const draft = await addConfigurationVersion(ownerDb, {
          configurationId: version.configuration_id,
          organizationId,
          version_number: 2,
        });
        await expect(
          inContext(organizationId, (transaction) =>
            transaction
              .updateTable("configuration_versions")
              .set({ yaml_content: "changed" })
              .where("configuration_id", "=", version.configuration_id)
              .execute(),
          ),
        ).rejects.toMatchObject(refusal(version.id));
        expect(await versionRow(version.id)).toEqual(version);
        expect(await versionRow(draft.id)).toEqual(draft);
      });

      it("allows an update of updated_at alone, as the application role and as the owner", async () => {
        const { version, organizationId } = await createPublished();
        const first = new Date("2030-03-01T00:00:00.000Z");
        await inContext(organizationId, (transaction) => updateVersion(transaction, version.id, { updated_at: first }));
        expect(await versionRow(version.id)).toEqual({ ...version, updated_at: first });

        const second = new Date("2030-04-01T00:00:00.000Z");
        await updateVersion(ownerDb, version.id, { updated_at: second });
        expect(await versionRow(version.id)).toEqual({ ...version, updated_at: second });
      });

      it("allows a write of every guarded column's own value, as the application role and as the owner", async () => {
        const { version, organizationId } = await createPublished();
        const same = {
          id: version.id,
          configuration_id: version.configuration_id,
          organization_id: version.organization_id,
          version_number: version.version_number,
          created_at: version.created_at,
          yaml_content: version.yaml_content,
          nodes: JSON.stringify(version.nodes),
          edges: JSON.stringify(version.edges),
          pipelines: JSON.stringify(version.pipelines),
          label: version.label,
          published_at: version.published_at,
          publication_id: version.publication_id,
          published_by_user_id: version.published_by_user_id,
          collector_distribution: version.collector_distribution,
          collector_version: version.collector_version,
        };
        const asApplication = await inContext(organizationId, (transaction) =>
          updateVersion(transaction, version.id, same),
        );
        expect(asApplication.numAffectedRows).toBe(1n);
        const asOwner = await updateVersion(ownerDb, version.id, same);
        expect(asOwner.numAffectedRows).toBe(1n);
        expect(await versionRow(version.id)).toEqual(version);
      });

      it("lets a draft's collector version change, as the application role and as the owner: only a published pin is fixed", async () => {
        const { version: draft, organizationId, creatorId } = await createVersion(false);
        expect(draft.collector_version).toBe(pin.version);
        // A draft is its creator's alone.
        const moved = await inContext(
          organizationId,
          (transaction) => updateVersion(transaction, draft.id, { collector_version: otherVersion }),
          creatorId,
        );
        expect(moved.numAffectedRows).toBe(1n);
        expect(await versionRow(draft.id)).toEqual({ ...draft, collector_version: otherVersion });
        await updateVersion(ownerDb, draft.id, { collector_version: pin.version });
        expect(await versionRow(draft.id)).toEqual(draft);
      });

      it("leaves created_by_user_id free: it may be changed, and becomes null when the creator's account is hard-deleted", async () => {
        const { version, organizationId, creatorId, otherUserId } = await createPublished();
        await inContext(organizationId, (transaction) =>
          updateVersion(transaction, version.id, { created_by_user_id: otherUserId }),
        );
        expect(await versionRow(version.id)).toEqual({ ...version, created_by_user_id: otherUserId });

        await updateVersion(ownerDb, version.id, { created_by_user_id: creatorId });
        await ownerDb.deleteFrom("users").where("id", "=", creatorId).execute();
        expect(await versionRow(version.id)).toEqual({ ...version, created_by_user_id: null });
      });

      it("lets published_by_user_id alone become null, as the application role", async () => {
        const { version, organizationId } = await createPublished();
        await inContext(organizationId, (transaction) =>
          updateVersion(transaction, version.id, { published_by_user_id: null }),
        );
        expect(await versionRow(version.id)).toEqual({ ...version, published_by_user_id: null });
      });

      it("nulls only published_by_user_id when the publisher's account is hard-deleted, and the version stays published", async () => {
        const { version, publisherId } = await createPublished();
        await ownerDb.deleteFrom("users").where("id", "=", publisherId).execute();
        const after = await versionRow(version.id);
        expect(after).toEqual({ ...version, published_by_user_id: null });
        expect(after?.published_at).toEqual(publishedAt);
        expect(after?.publication_id).toBe(version.publication_id);
      });

      it("nulls both when one account created and published the version, and it stays published", async () => {
        const { version, publisherId } = await createPublished();
        await updateVersion(ownerDb, version.id, { created_by_user_id: publisherId });
        await ownerDb.deleteFrom("users").where("id", "=", publisherId).execute();
        expect(await versionRow(version.id)).toEqual({
          ...version,
          created_by_user_id: null,
          published_by_user_id: null,
        });
      });

      it("once the publisher is gone, refuses naming another publisher", async () => {
        const { version, organizationId, publisherId, otherUserId } = await createPublished();
        await ownerDb.deleteFrom("users").where("id", "=", publisherId).execute();
        await expect(
          inContext(organizationId, (transaction) =>
            updateVersion(transaction, version.id, { published_by_user_id: otherUserId }),
          ),
        ).rejects.toMatchObject(refusal(version.id));
        await expect(updateVersion(ownerDb, version.id, { published_by_user_id: otherUserId })).rejects.toMatchObject(
          refusal(version.id),
        );
        expect(await versionRow(version.id)).toEqual({ ...version, published_by_user_id: null });
      });

      it("still goes with its configuration when the configuration's row is hard-deleted: the trigger is update only", async () => {
        const { version, organizationId } = await createPublished();
        const second = await addConfigurationVersion(ownerDb, {
          configurationId: version.configuration_id,
          organizationId,
          version_number: 2,
          publishedAt,
        });
        await ownerDb.deleteFrom("configurations").where("id", "=", version.configuration_id).execute();
        expect(await versionRow(version.id)).toBeUndefined();
        expect(await versionRow(second.id)).toBeUndefined();
      });

      it("still goes, through its configuration, with its organization when the organization is hard-deleted", async () => {
        const { version, organizationId, elsewhere } = await createPublished();
        const kept = await addConfigurationVersion(ownerDb, {
          configurationId: elsewhere.configuration.id,
          organizationId: elsewhere.organizationId,
          publishedAt,
        });
        await ownerDb.deleteFrom("organizations").where("id", "=", organizationId).execute();
        expect(await versionRow(version.id)).toBeUndefined();
        expect(await versionRow(kept.id)).toEqual(kept);
      });
    });

    describe("a draft is not", () => {
      /**
       * One change per column the trigger guards on a published version, each
       * valid for a draft. Publishing is one of them: it is an update of a
       * draft.
       */
      const draftChanges: Array<[string, (published: Published) => Record<string, unknown>]> = [
        ["yaml_content", () => ({ yaml_content: "exporters: {}\n" })],
        ["nodes", () => ({ nodes: JSON.stringify([{ id: "n-2" }]) })],
        ["edges", () => ({ edges: JSON.stringify([]) })],
        ["pipelines", () => ({ pipelines: JSON.stringify([{ id: "p-2" }]) })],
        ["label", () => ({ label: "Renamed" })],
        ["label, to null", () => ({ label: null })],
        [
          "the publish columns (publishing it)",
          ({ otherUserId }) => ({
            published_at: publishedAt,
            publication_id: randomUUID(),
            published_by_user_id: otherUserId,
          }),
        ],
        ["version_number", () => ({ version_number: 2 })],
        ["configuration_id", ({ siblingConfigurationId }) => ({ configuration_id: siblingConfigurationId })],
        ["created_at", () => ({ created_at: new Date("2029-01-01T00:00:00.000Z") })],
        ["created_by_user_id", ({ otherUserId }) => ({ created_by_user_id: otherUserId })],
        ["updated_at", () => ({ updated_at: new Date("2030-05-01T00:00:00.000Z") })],
        ["id", () => ({ id: randomUUID() })],
      ];

      const createDraft = () => createVersion(false);

      /** The row after `set`, read back by its (possibly new) id, as the columns read: jsonb parsed. */
      const expectedAfter = (draft: Published["version"], set: Record<string, unknown>) => {
        const parsed = Object.fromEntries(
          Object.entries(set).map(([column, value]) => [
            column,
            ["nodes", "edges", "pipelines"].includes(column) ? JSON.parse(value as string) : value,
          ]),
        );
        return { ...draft, ...parsed };
      };

      it.each(draftChanges)("allows changing %s on a draft, as the application role", async (_, change) => {
        const fixture = await createDraft();
        const set = change(fixture);
        // As its creator: a draft is visible to no one else.
        const result = await inContext(
          fixture.organizationId,
          (transaction) => updateVersion(transaction, fixture.version.id, set),
          fixture.creatorId,
        );
        expect(result.numAffectedRows).toBe(1n);
        const id = (set.id as string | undefined) ?? fixture.version.id;
        expect(await versionRow(id)).toEqual(expectedAfter(fixture.version, set));
      });

      it.each([
        ...draftChanges,
        [
          "organization_id, with a configuration there",
          ({ elsewhere }: Published) => ({
            organization_id: elsewhere.organizationId,
            configuration_id: elsewhere.configuration.id,
          }),
        ] as [string, (published: Published) => Record<string, unknown>],
      ])("allows changing %s on a draft, as the owner", async (_, change) => {
        const fixture = await createDraft();
        const set = change(fixture);
        const result = await updateVersion(ownerDb, fixture.version.id, set);
        expect(result.numAffectedRows).toBe(1n);
        const id = (set.id as string | undefined) ?? fixture.version.id;
        expect(await versionRow(id)).toEqual(expectedAfter(fixture.version, set));
      });

      it("refuses a publisher on a draft (23514, ck_configuration_versions_publisher_only_when_published), as the application role and as the owner, and keeps the row", async () => {
        const fixture = await createDraft();
        const set = { published_by_user_id: fixture.otherUserId };
        const violation = { code: "23514", constraint: "ck_configuration_versions_publisher_only_when_published" };
        await expect(
          inContext(
            fixture.organizationId,
            (transaction) => updateVersion(transaction, fixture.version.id, set),
            fixture.creatorId,
          ),
        ).rejects.toMatchObject(violation);
        await expect(updateVersion(ownerDb, fixture.version.id, set)).rejects.toMatchObject(violation);
        expect(await versionRow(fixture.version.id)).toEqual(fixture.version);
      });
    });
  });

  describe("the composite foreign key", () => {
    describe("to the catalogue (migration 1700000000023)", () => {
      /** `insert` in a savepoint, rolled back to on failure, so the transaction goes on; its error, if any. */
      const attempt = async (transaction: Kysely<Database>, insert: () => Promise<unknown>) => {
        await sql`savepoint attempt`.execute(transaction);
        try {
          await insert();
          await sql`release savepoint attempt`.execute(transaction);
          return undefined;
        } catch (error) {
          await sql`rollback to savepoint attempt`.execute(transaction);
          return error;
        }
      };

      /** Sets a draft's pin columns as the owner, in a plain update. */
      const updateVersionPin = (id: string, set: { collector_version: string }) =>
        sql`update configuration_versions set collector_version = ${set.collector_version} where id = ${id}`.execute(
          ownerDb,
        );

      it("refuses a version pinned to a version its distribution doesn't have (23503), even as the owner", async () => {
        const { organizationId, configuration } = await createConfiguration();
        await expect(
          addConfigurationVersion(ownerDb, {
            configurationId: configuration.id,
            organizationId,
            collector_distribution: pin.distribution,
            collector_version: "0.0.1",
          }),
        ).rejects.toMatchObject({ code: "23503", constraint: "fk_configuration_versions_collector_version" });
        const draft = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
        await expect(updateVersionPin(draft.id, { collector_version: "0.0.1" })).rejects.toMatchObject({
          code: "23503",
          constraint: "fk_configuration_versions_collector_version",
        });
        expect(await versionRow(draft.id)).toEqual(draft);
      });

      it("refuses a version naming another distribution's version, or another distribution than its configuration's (23503), even as the owner", async () => {
        const { organizationId, configuration } = await createConfiguration();
        // A second distribution, only inside this transaction, which is
        // always rolled back: telflo_platform_test's catalogue stays the committed one.
        const rollback = new Error("rollback");
        await expect(
          ownerDb.transaction().execute(async (transaction) => {
            await sql`
              insert into collector_distributions (id, label, sort_order, is_default)
              values ('fixture-distribution', 'A fixture distribution', 9, false)
            `.execute(transaction);
            await sql`
              insert into collector_versions
                (distribution, version, label, released_at, is_default, deprecated, container_image,
                 otelcol_contrib, opamp_supervisor)
              values ('fixture-distribution', '1.0.0', 'v1.0.0', '2026-01-01', true, false,
                      'example/fixture-collector:1.0.0', '{}', '{}')
            `.execute(transaction);
            const insert = (pinned: { collector_distribution: string; collector_version: string }) => () =>
              addConfigurationVersion(transaction, { configurationId: configuration.id, organizationId, ...pinned });

            // Its distribution's, but naming the other distribution's version.
            expect(
              await attempt(transaction, insert({ collector_distribution: pin.distribution, collector_version: "1.0.0" })),
            ).toMatchObject({ code: "23503", constraint: "fk_configuration_versions_collector_version" });
            // A real pair of the catalogue, but not its configuration's distribution.
            expect(
              await attempt(
                transaction,
                insert({ collector_distribution: "fixture-distribution", collector_version: "1.0.0" }),
              ),
            ).toMatchObject({ code: "23503", constraint: "fk_configuration_versions_configuration_distribution" });
            // The configuration's own distribution and one of its versions passes.
            expect(
              await attempt(transaction, insert({ collector_distribution: pin.distribution, collector_version: pin.version })),
            ).toBeUndefined();
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect(
          await ownerDb.selectFrom("configuration_versions").select("id").where("configuration_id", "=", configuration.id).execute(),
        ).toEqual([]);
      });
    });

    it("refuses a version naming a configuration with another organization's id (23503), even as the owner", async () => {
      const { configuration } = await createConfiguration();
      const other = await createConfiguration();

      await expect(
        addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId: other.organizationId }),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_configuration_versions_configuration" });
      const smuggled = await ownerDb
        .selectFrom("configuration_versions")
        .select("id")
        .where("configuration_id", "=", configuration.id)
        .execute();
      expect(smuggled).toEqual([]);
    });

    it("refuses moving a version into another organization, even as the owner", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const other = await createConfiguration();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });

      await expect(
        ownerDb
          .updateTable("configuration_versions")
          .set({ organization_id: other.organizationId })
          .where("id", "=", version.id)
          .execute(),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_configuration_versions_configuration" });
      expect(await versionRow(version.id)).toEqual(version);
    });

    it("removes a configuration's versions when its row is deleted, and leaves other configurations' versions", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const kept = await addConfiguration(ownerDb, { organizationId });
      const first = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });
      const second = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
      });
      const elsewhere = await addConfigurationVersion(ownerDb, { configurationId: kept.id, organizationId });

      await ownerDb.deleteFrom("configurations").where("id", "=", configuration.id).execute();

      expect(await versionRow(first.id)).toBeUndefined();
      expect(await versionRow(second.id)).toBeUndefined();
      expect(await versionRow(elsewhere.id)).toEqual(elsewhere);
    });

    it("keeps a soft-deleted configuration's versions: only its row's removal takes them", async () => {
      const { organizationId, configuration } = await createConfiguration();
      const version = await addConfigurationVersion(ownerDb, { configurationId: configuration.id, organizationId });

      await ownerDb
        .updateTable("configurations")
        .set({ deleted_at: new Date() })
        .where("id", "=", configuration.id)
        .execute();

      expect(await versionRow(version.id)).toEqual(version);
    });

    it("goes, through its configuration, with its organization when the organization is hard-deleted", async () => {
      const doomed = await createConfiguration();
      const kept = await createConfiguration();
      const gone = await addConfigurationVersion(ownerDb, {
        configurationId: doomed.configuration.id,
        organizationId: doomed.organizationId,
      });
      const elsewhere = await addConfigurationVersion(ownerDb, {
        configurationId: kept.configuration.id,
        organizationId: kept.organizationId,
      });

      await ownerDb.deleteFrom("organizations").where("id", "=", doomed.organizationId).execute();

      expect(await versionRow(gone.id)).toBeUndefined();
      expect(await versionRow(elsewhere.id)).toEqual(elsewhere);
    });
  });

  describe("row-level security, as the application role", () => {
    const visibleIds = (transaction: Kysely<Database>) =>
      transaction
        .selectFrom("configuration_versions")
        .select("id")
        .execute()
        .then((rows) => rows.map((row) => row.id).sort());

    /**
     * Two organizations with a configuration (by its admin) and its version
     * each, and a deleted configuration's version in A, which the policy
     * doesn't hide.
     */
    const twoOrganizations = async () => {
      const a = await createConfiguration();
      const b = await createConfiguration();
      const deleted = await addConfiguration(ownerDb, {
        organizationId: a.organizationId,
        created_by_user_id: a.adminId,
        deleted_at: new Date(),
      });
      const inA = await addConfigurationVersion(ownerDb, {
        configurationId: a.configuration.id,
        organizationId: a.organizationId,
      });
      const ofDeletedInA = await addConfigurationVersion(ownerDb, {
        configurationId: deleted.id,
        organizationId: a.organizationId,
      });
      const inB = await addConfigurationVersion(ownerDb, {
        configurationId: b.configuration.id,
        organizationId: b.organizationId,
      });
      return {
        a: a.organizationId,
        aAdmin: a.adminId,
        configurationInA: a.configuration.id,
        b: b.organizationId,
        configurationInB: b.configuration.id,
        inA,
        ofDeletedInA,
        inB,
      };
    };

    /** A row a raw insert writes, by `createdByUserId`; `extra` adds columns. */
    const newVersion = (
      configurationId: string,
      organizationId: string,
      versionNumber: number,
      yaml: string,
      extra: Record<string, unknown> = {},
    ) => {
      const at = new Date();
      return {
        configuration_id: configurationId,
        organization_id: organizationId,
        version_number: versionNumber,
        yaml_content: yaml,
        collector_distribution: pin.distribution,
        collector_version: pin.version,
        created_at: at,
        updated_at: at,
        ...extra,
      };
    };

    const versionsWithYaml = (yaml: string) =>
      ownerDb.selectFrom("configuration_versions").select("id").where("yaml_content", "=", yaml).execute();

    it("shows nothing without a context", async () => {
      const { aAdmin } = await twoOrganizations();
      expect(await visibleIds(db)).toEqual([]);
      expect(await inContext(null, visibleIds)).toEqual([]);
      expect(await inContext(null, visibleIds, aAdmin)).toEqual([]);
    });

    it("shows the versions of the context's user's configurations in the context's organization, a deleted configuration's included, and no other organization's", async () => {
      const { a, aAdmin, inA, ofDeletedInA } = await twoOrganizations();
      expect(await inContext(a, visibleIds, aAdmin)).toEqual([inA.id, ofDeletedInA.id].sort());
    });

    it("refuses an insert naming another organization with 42501", async () => {
      const { a, aAdmin, b, configurationInB } = await twoOrganizations();
      await expect(
        inContext(
          a,
          (transaction) =>
            transaction
              .insertInto("configuration_versions")
              .values(newVersion(configurationInB, b, 2, "smuggled"))
              .execute(),
          aAdmin,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await versionsWithYaml("smuggled")).toEqual([]);
    });

    it("inserts a draft of a configuration the context's user can see", async () => {
      const { a, aAdmin, configurationInA } = await twoOrganizations();
      const row = await inContext(
        a,
        (transaction) =>
          transaction
            .insertInto("configuration_versions")
            .values(newVersion(configurationInA, a, 2, "drafted"))
            .returning("id")
            .executeTakeFirstOrThrow(),
        aAdmin,
      );
      expect(await versionRow(row.id)).toMatchObject({
        version_number: 2,
        yaml_content: "drafted",
        published_at: null,
      });
    });

    it("refuses inserting a version already published, or with any publish column set (42501): only the update that records a publish publishes", async () => {
      const { a, aAdmin, configurationInA } = await twoOrganizations();
      const publishColumns: Array<Record<string, unknown>> = [
        { published_at: new Date(), publication_id: randomUUID() },
        { published_at: new Date(), publication_id: randomUUID(), published_by_user_id: aAdmin },
      ];
      for (const extra of publishColumns) {
        await expect(
          inContext(
            a,
            (transaction) =>
              transaction
                .insertInto("configuration_versions")
                .values(newVersion(configurationInA, a, 2, "pre-published", extra))
                .execute(),
            aAdmin,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
      expect(await versionsWithYaml("pre-published")).toEqual([]);
    });

    it("updates nothing in another organization", async () => {
      const { a, aAdmin, b, inB } = await twoOrganizations();
      const result = await inContext(
        a,
        (transaction) =>
          transaction
            .updateTable("configuration_versions")
            .set({ yaml_content: "changed" })
            .where("organization_id", "=", b)
            .executeTakeFirst(),
        aAdmin,
      );
      expect(result.numUpdatedRows).toBe(0n);
      expect(await versionRow(inB.id)).toEqual(inB);
    });

    it("refuses moving a version out of the context's organization with 42501", async () => {
      const { a, aAdmin, b, inA } = await twoOrganizations();
      await expect(
        inContext(
          a,
          (transaction) =>
            transaction
              .updateTable("configuration_versions")
              .set({ organization_id: b })
              .where("id", "=", inA.id)
              .execute(),
          aAdmin,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await versionRow(inA.id)).toEqual(inA);
    });

    it("deletes nothing in another organization", async () => {
      const { a, aAdmin, b, inB } = await twoOrganizations();
      const result = await inContext(
        a,
        (transaction) =>
          transaction.deleteFrom("configuration_versions").where("organization_id", "=", b).executeTakeFirst(),
        aAdmin,
      );
      expect(result.numDeletedRows).toBe(0n);
      expect(await versionRow(inB.id)).toEqual(inB);
    });

    // Migration 021 let it delete a draft of a configuration the context's
    // user can see; nothing in the platform does, and migration 022 refuses
    // every delete.
    it("deletes no draft either, even of the context's user's own configuration: 0 rows (migration 1700000000022)", async () => {
      const { a, aAdmin, inA } = await twoOrganizations();
      const result = await inContext(
        a,
        (transaction) => transaction.deleteFrom("configuration_versions").where("id", "=", inA.id).executeTakeFirst(),
        aAdmin,
      );
      expect(result.numDeletedRows).toBe(0n);
      expect(await versionRow(inA.id)).toEqual(inA);
    });

    describe("a published version can't be deleted", () => {
      it("deletes no published version, even its configuration's author's: 0 rows, and the row as it was", async () => {
        const { a, aAdmin, configurationInA } = await twoOrganizations();
        const published = await addConfigurationVersion(ownerDb, {
          configurationId: configurationInA,
          organizationId: a,
          version_number: 2,
          yaml_content: "published: yaml\n",
          publishedAt: new Date("2030-01-02T00:00:00.456Z"),
          publishedByUserId: aAdmin,
        });
        const result = await inContext(
          a,
          (transaction) =>
            transaction.deleteFrom("configuration_versions").where("id", "=", published.id).executeTakeFirst(),
          aAdmin,
        );
        expect(result.numDeletedRows).toBe(0n);
        expect(await versionRow(published.id)).toEqual(published);
      });

      it("so it can't be replaced by a delete and an insert under its id and publication id", async () => {
        const { a, aAdmin, configurationInA } = await twoOrganizations();
        const published = await addConfigurationVersion(ownerDb, {
          configurationId: configurationInA,
          organizationId: a,
          version_number: 2,
          yaml_content: "published: yaml\n",
          publishedAt: new Date("2030-01-02T00:00:00.456Z"),
        });
        const deleted = await inContext(
          a,
          (transaction) =>
            transaction.deleteFrom("configuration_versions").where("id", "=", published.id).executeTakeFirst(),
          aAdmin,
        );
        expect(deleted.numDeletedRows).toBe(0n);
        await expect(
          inContext(
            a,
            (transaction) =>
              transaction
                .insertInto("configuration_versions")
                .values(
                  newVersion(configurationInA, a, 3, "REPLACED", {
                    published_at: published.published_at,
                    publication_id: published.publication_id,
                  }),
                )
                .execute(),
            aAdmin,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        expect(await versionRow(published.id)).toEqual(published);
        expect(await versionsWithYaml("REPLACED")).toEqual([]);
      });
    });

    describe("drafts are private (migration 1700000000021)", () => {
      /**
       * One organization: an author's draft (v1) and their published
       * configuration (v1 published, v2 a draft), and a teammate.
       */
      const oneOrganization = async () => {
        const { adminId: authorId, organizationId, configuration: draft } = await createConfiguration();
        const teammate = await createUserWithOrganization(ownerDb);
        await addMembership(ownerDb, { userId: teammate.user.id, organizationId, role: "contributor" });
        const draftV1 = await addConfigurationVersion(ownerDb, { configurationId: draft.id, organizationId });
        const published = await addConfiguration(ownerDb, { organizationId, created_by_user_id: authorId });
        const publishedV1 = await addConfigurationVersion(ownerDb, {
          configurationId: published.id,
          organizationId,
          publishedAt: new Date(),
        });
        const publishedV2 = await addConfigurationVersion(ownerDb, {
          configurationId: published.id,
          organizationId,
          version_number: 2,
        });
        return {
          organizationId,
          authorId,
          teammateId: teammate.user.id,
          draft,
          draftV1,
          published,
          publishedV1,
          publishedV2,
        };
      };

      it("shows a teammate every version of a published configuration, its draft v2 included, and none of another member's draft", async () => {
        const { organizationId, authorId, teammateId, draftV1, publishedV1, publishedV2 } = await oneOrganization();
        expect(await inContext(organizationId, visibleIds, teammateId)).toEqual(
          [publishedV1.id, publishedV2.id].sort(),
        );
        expect(await inContext(organizationId, visibleIds, authorId)).toEqual(
          [draftV1.id, publishedV1.id, publishedV2.id].sort(),
        );
      });

      it("refuses a teammate adding a version to another member's draft (42501), and lets them add one to a published configuration", async () => {
        const { organizationId, teammateId, draft, published } = await oneOrganization();
        await expect(
          inContext(
            organizationId,
            (transaction) =>
              transaction
                .insertInto("configuration_versions")
                .values(newVersion(draft.id, organizationId, 2, "slipped"))
                .execute(),
            teammateId,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        expect(await versionsWithYaml("slipped")).toEqual([]);
        const added = await inContext(
          organizationId,
          (transaction) =>
            transaction
              .insertInto("configuration_versions")
              .values(newVersion(published.id, organizationId, 3, "added"))
              .returning("version_number")
              .execute(),
          teammateId,
        );
        expect(added).toEqual([{ version_number: 3 }]);
      });

      it("saves nothing over another member's draft, and lets a teammate save a published configuration's draft version", async () => {
        const { organizationId, teammateId, draftV1, publishedV2 } = await oneOrganization();
        const ofDraft = await inContext(
          organizationId,
          (transaction) =>
            transaction
              .updateTable("configuration_versions")
              .set({ yaml_content: "overwritten" })
              .where("id", "=", draftV1.id)
              .executeTakeFirst(),
          teammateId,
        );
        expect(ofDraft.numUpdatedRows).toBe(0n);
        expect(await versionRow(draftV1.id)).toEqual(draftV1);
        const ofPublished = await inContext(
          organizationId,
          (transaction) =>
            transaction
              .updateTable("configuration_versions")
              .set({ yaml_content: "saved" })
              .where("id", "=", publishedV2.id)
              .executeTakeFirst(),
          teammateId,
        );
        expect(ofPublished.numUpdatedRows).toBe(1n);
      });
    });
  });
});
