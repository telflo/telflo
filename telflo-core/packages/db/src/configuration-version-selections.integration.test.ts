import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";
import {
  addConfiguration,
  addConfigurationVersion,
  addConfigurationVersionSelection,
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
} from "./testing.js";
import type { TestDatabases } from "./testing.js";

/**
 * configuration_version_selections (D10 decision 3, migration
 * 1700000000018): its constraints and its two composite foreign keys, as the
 * owner; its row-level security, as the API's role (`db`), which the
 * policies constrain. The migration itself is tested in
 * schema.integration.test.ts, which has the throwaway database it needs.
 */
describe("configuration_version_selections", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
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

  /**
   * A live group organization with a member, who also keeps their personal
   * organization, and a configuration in it with its version 1.
   */
  const createConfiguration = async () => {
    const member = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: member.user.id });
    const configuration = await addConfiguration(ownerDb, {
      organizationId: group.organization.id,
      created_by_user_id: member.user.id,
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: group.organization.id,
    });
    return { userId: member.user.id, organizationId: group.organization.id, configuration, version };
  };

  /** Another member of `organizationId`, beside their personal organization. */
  const addMember = async (organizationId: string) => {
    const person = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: person.user.id, organizationId, role: "contributor" });
    return person.user.id;
  };

  const selectionRow = (id: string) =>
    ownerDb.selectFrom("configuration_version_selections").selectAll().where("id", "=", id).executeTakeFirst();

  describe("constraints", () => {
    it("stores a selection as given, with a uuidv7 id", async () => {
      const { userId, organizationId, configuration, version } = await createConfiguration();
      const at = new Date("2030-01-01T00:00:00.123Z");
      const selection = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId,
        selected_at: at,
      });
      expect(selection).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        organization_id: organizationId,
        configuration_id: configuration.id,
        version_id: version.id,
        user_id: userId,
        selected_at: at,
      });
    });

    it("refuses a second row for the same organization, person and configuration (23505), and allows another person's and another configuration's", async () => {
      const { userId, organizationId, configuration, version } = await createConfiguration();
      const second = await addConfigurationVersion(ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: 2,
      });
      await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId,
      });

      // Even naming another version of the configuration: one row per person.
      await expect(
        addConfigurationVersionSelection(ownerDb, {
          organizationId,
          configurationId: configuration.id,
          versionId: second.id,
          userId,
        }),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "uq_configuration_version_selections_organization_user_config",
      });

      const colleague = await addMember(organizationId);
      await expect(
        addConfigurationVersionSelection(ownerDb, {
          organizationId,
          configurationId: configuration.id,
          versionId: second.id,
          userId: colleague,
        }),
      ).resolves.toMatchObject({ user_id: colleague });

      const other = await addConfiguration(ownerDb, { organizationId });
      const otherVersion = await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId });
      await expect(
        addConfigurationVersionSelection(ownerDb, {
          organizationId,
          configurationId: other.id,
          versionId: otherVersion.id,
          userId,
        }),
      ).resolves.toMatchObject({ configuration_id: other.id });
    });

    it("refuses a row without selected_at (23502): it has no default, so a write that forgets the clock fails", async () => {
      const { userId, organizationId, configuration, version } = await createConfiguration();
      await expect(
        sql`insert into configuration_version_selections (organization_id, configuration_id, version_id, user_id)
            values (${organizationId}, ${configuration.id}, ${version.id}, ${userId})`.execute(ownerDb),
      ).rejects.toMatchObject({ code: "23502", column: "selected_at" });
    });

    it("refuses a selection by a person who does not exist (23503)", async () => {
      const { organizationId, configuration, version } = await createConfiguration();
      await expect(
        addConfigurationVersionSelection(ownerDb, {
          organizationId,
          configurationId: configuration.id,
          versionId: version.id,
          userId: "00000000-0000-7000-8000-000000000000",
        }),
      ).rejects.toMatchObject({ code: "23503", constraint: "configuration_version_selections_user_id_fkey" });
    });
  });

  describe("the composite foreign keys, as the owner", () => {
    it("refuses a selection naming another organization's configuration (23503)", async () => {
      const { userId, organizationId } = await createConfiguration();
      const other = await createConfiguration();

      await expect(
        addConfigurationVersionSelection(ownerDb, {
          organizationId,
          configurationId: other.configuration.id,
          versionId: other.version.id,
          userId,
        }),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_configuration_version_selections_configuration" });
      expect(await ownerDb.selectFrom("configuration_version_selections").selectAll().execute()).toEqual([]);
    });

    it("refuses a selection naming a version of another configuration of the same organization (23503)", async () => {
      const { userId, organizationId, configuration } = await createConfiguration();
      const other = await addConfiguration(ownerDb, { organizationId });
      const versionOfOther = await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId });

      await expect(
        addConfigurationVersionSelection(ownerDb, {
          organizationId,
          configurationId: configuration.id,
          versionId: versionOfOther.id,
          userId,
        }),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_configuration_version_selections_version" });
      expect(await ownerDb.selectFrom("configuration_version_selections").selectAll().execute()).toEqual([]);
    });

    it("refuses an upsert switching a selection to a version of another configuration (23503), and keeps the row", async () => {
      const { userId, organizationId, configuration, version } = await createConfiguration();
      const other = await addConfiguration(ownerDb, { organizationId });
      const versionOfOther = await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId });
      const selection = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId,
      });

      await expect(
        ownerDb
          .insertInto("configuration_version_selections")
          .values({
            organization_id: organizationId,
            configuration_id: configuration.id,
            version_id: versionOfOther.id,
            user_id: userId,
            selected_at: new Date(),
          })
          .onConflict((conflict) =>
            conflict
              .columns(["organization_id", "user_id", "configuration_id"])
              .doUpdateSet({ version_id: versionOfOther.id, selected_at: new Date() }),
          )
          .execute(),
      ).rejects.toMatchObject({ code: "23503", constraint: "fk_configuration_version_selections_version" });
      expect(await selectionRow(selection.id)).toEqual(selection);
    });

    it("refuses moving a selection into another organization (23503), and keeps the row", async () => {
      const { userId, organizationId, configuration, version } = await createConfiguration();
      const other = await createConfiguration();
      const selection = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId,
      });

      await expect(
        ownerDb
          .updateTable("configuration_version_selections")
          .set({ organization_id: other.organizationId })
          .where("id", "=", selection.id)
          .execute(),
      ).rejects.toMatchObject({ code: "23503" });
      expect(await selectionRow(selection.id)).toEqual(selection);
    });

    it("removes a configuration's selections when its row is deleted, and leaves other configurations'", async () => {
      const { userId, organizationId, configuration, version } = await createConfiguration();
      const kept = await addConfiguration(ownerDb, { organizationId });
      const keptVersion = await addConfigurationVersion(ownerDb, { configurationId: kept.id, organizationId });
      const colleague = await addMember(organizationId);
      const mine = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId,
      });
      const theirs = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId: colleague,
      });
      const elsewhere = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: kept.id,
        versionId: keptVersion.id,
        userId,
      });

      await ownerDb.deleteFrom("configurations").where("id", "=", configuration.id).execute();

      expect(await selectionRow(mine.id)).toBeUndefined();
      expect(await selectionRow(theirs.id)).toBeUndefined();
      expect(await selectionRow(elsewhere.id)).toEqual(elsewhere);
    });

    it("keeps a soft-deleted configuration's selections: only its row's removal takes them", async () => {
      const { userId, organizationId, configuration, version } = await createConfiguration();
      const selection = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId,
      });

      await ownerDb
        .updateTable("configurations")
        .set({ deleted_at: new Date() })
        .where("id", "=", configuration.id)
        .execute();

      expect(await selectionRow(selection.id)).toEqual(selection);
    });

    it("removes a person's selections when their account is hard-deleted, and leaves other people's", async () => {
      // In a group organization: a personal one cascades with its owner and
      // would take the configuration, and its selections, with it.
      const { userId, organizationId, configuration, version } = await createConfiguration();
      const departing = await addMember(organizationId);
      const theirs = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId: departing,
      });
      const kept = await addConfigurationVersionSelection(ownerDb, {
        organizationId,
        configurationId: configuration.id,
        versionId: version.id,
        userId,
      });

      await ownerDb.deleteFrom("users").where("id", "=", departing).execute();

      expect(await selectionRow(theirs.id)).toBeUndefined();
      expect(await selectionRow(kept.id)).toEqual(kept);
    });

    it("goes, through its configuration, with its organization when the organization is hard-deleted", async () => {
      const doomed = await createConfiguration();
      const kept = await createConfiguration();
      const gone = await addConfigurationVersionSelection(ownerDb, {
        organizationId: doomed.organizationId,
        configurationId: doomed.configuration.id,
        versionId: doomed.version.id,
        userId: doomed.userId,
      });
      const elsewhere = await addConfigurationVersionSelection(ownerDb, {
        organizationId: kept.organizationId,
        configurationId: kept.configuration.id,
        versionId: kept.version.id,
        userId: kept.userId,
      });

      await ownerDb.deleteFrom("organizations").where("id", "=", doomed.organizationId).execute();

      expect(await selectionRow(gone.id)).toBeUndefined();
      expect(await selectionRow(elsewhere.id)).toEqual(elsewhere);
    });
  });

  describe("row-level security, as the application role", () => {
    /**
     * Runs `work` in a transaction whose context is `organizationId` and,
     * when given, `userId`, as context.ts sets them (null: no organization).
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

    const visibleIds = (transaction: Kysely<Database>) =>
      transaction
        .selectFrom("configuration_version_selections")
        .select("id")
        .execute()
        .then((rows) => rows.map((row) => row.id).sort());

    /**
     * Two organizations with a configuration, its version and a selection
     * each, and a deleted configuration's selection in A, which the policy
     * doesn't hide.
     */
    const twoOrganizations = async () => {
      const a = await createConfiguration();
      const b = await createConfiguration();
      const deleted = await addConfiguration(ownerDb, {
        organizationId: a.organizationId,
        created_by_user_id: a.userId,
        deleted_at: new Date(),
      });
      const deletedVersion = await addConfigurationVersion(ownerDb, {
        configurationId: deleted.id,
        organizationId: a.organizationId,
      });
      const inA = await addConfigurationVersionSelection(ownerDb, {
        organizationId: a.organizationId,
        configurationId: a.configuration.id,
        versionId: a.version.id,
        userId: a.userId,
      });
      const ofDeletedInA = await addConfigurationVersionSelection(ownerDb, {
        organizationId: a.organizationId,
        configurationId: deleted.id,
        versionId: deletedVersion.id,
        userId: a.userId,
      });
      const inB = await addConfigurationVersionSelection(ownerDb, {
        organizationId: b.organizationId,
        configurationId: b.configuration.id,
        versionId: b.version.id,
        userId: b.userId,
      });
      return { a, b, inA, ofDeletedInA, inB };
    };

    it("shows nothing without a context", async () => {
      const { a } = await twoOrganizations();
      expect(await visibleIds(db)).toEqual([]);
      expect(await inContext(null, visibleIds)).toEqual([]);
      expect(await inContext(null, visibleIds, a.userId)).toEqual([]);
    });

    it("shows the selections of the context's user's configurations in the context's organization, a deleted configuration's included, and no other organization's", async () => {
      const { a, inA, ofDeletedInA } = await twoOrganizations();
      expect(await inContext(a.organizationId, visibleIds, a.userId)).toEqual([inA.id, ofDeletedInA.id].sort());
    });

    it("refuses an insert naming another organization with 42501", async () => {
      const { a, b } = await twoOrganizations();
      const colleague = await addMember(b.organizationId);
      await expect(
        inContext(
          a.organizationId,
          (transaction) =>
            transaction
              .insertInto("configuration_version_selections")
              .values({
                organization_id: b.organizationId,
                configuration_id: b.configuration.id,
                version_id: b.version.id,
                user_id: colleague,
                selected_at: new Date(),
              })
              .execute(),
          a.userId,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const smuggled = await ownerDb
        .selectFrom("configuration_version_selections")
        .select("id")
        .where("user_id", "=", colleague)
        .execute();
      expect(smuggled).toEqual([]);
    });

    it("updates nothing in another organization", async () => {
      const { a, b, inB } = await twoOrganizations();
      const result = await inContext(
        a.organizationId,
        (transaction) =>
          transaction
            .updateTable("configuration_version_selections")
            .set({ selected_at: new Date("2000-01-01T00:00:00.000Z") })
            .where("organization_id", "=", b.organizationId)
            .executeTakeFirst(),
        a.userId,
      );
      expect(result.numUpdatedRows).toBe(0n);
      expect(await selectionRow(inB.id)).toEqual(inB);
    });

    it("refuses moving a selection out of the context's organization with 42501", async () => {
      const { a, b, inA } = await twoOrganizations();
      await expect(
        inContext(
          a.organizationId,
          (transaction) =>
            transaction
              .updateTable("configuration_version_selections")
              .set({ organization_id: b.organizationId })
              .where("id", "=", inA.id)
              .execute(),
          a.userId,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await selectionRow(inA.id)).toEqual(inA);
    });

    it("deletes nothing in another organization", async () => {
      const { a, b, inB } = await twoOrganizations();
      const result = await inContext(
        a.organizationId,
        (transaction) =>
          transaction
            .deleteFrom("configuration_version_selections")
            .where("organization_id", "=", b.organizationId)
            .executeTakeFirst(),
        a.userId,
      );
      expect(result.numDeletedRows).toBe(0n);
      expect(await selectionRow(inB.id)).toEqual(inB);
    });

    describe("drafts are private (D11b decision 1, migration 1700000000021)", () => {
      /**
       * The author's draft with their selection of it, their published
       * configuration (v1 published), and a teammate.
       */
      const oneOrganization = async () => {
        const draft = await createConfiguration();
        const teammateId = await addMember(draft.organizationId);
        const ofDraft = await addConfigurationVersionSelection(ownerDb, {
          organizationId: draft.organizationId,
          configurationId: draft.configuration.id,
          versionId: draft.version.id,
          userId: draft.userId,
        });
        const published = await addConfiguration(ownerDb, {
          organizationId: draft.organizationId,
          created_by_user_id: draft.userId,
        });
        const publishedVersion = await addConfigurationVersion(ownerDb, {
          configurationId: published.id,
          organizationId: draft.organizationId,
          publishedAt: new Date(),
        });
        const ofPublished = await addConfigurationVersionSelection(ownerDb, {
          organizationId: draft.organizationId,
          configurationId: published.id,
          versionId: publishedVersion.id,
          userId: draft.userId,
        });
        return { draft, teammateId, ofDraft, published, publishedVersion, ofPublished };
      };

      it("shows a teammate no selection of another member's draft, and the selections of a published configuration", async () => {
        const { draft, teammateId, ofDraft, ofPublished } = await oneOrganization();
        expect(await inContext(draft.organizationId, visibleIds, teammateId)).toEqual([ofPublished.id]);
        expect(await inContext(draft.organizationId, visibleIds, draft.userId)).toEqual(
          [ofDraft.id, ofPublished.id].sort(),
        );
      });

      it("refuses a teammate recording a selection of another member's draft (42501), and lets them select a published configuration's version", async () => {
        const { draft, teammateId, published, publishedVersion } = await oneOrganization();
        const select = (configurationId: string, versionId: string) =>
          inContext(
            draft.organizationId,
            (transaction) =>
              transaction
                .insertInto("configuration_version_selections")
                .values({
                  organization_id: draft.organizationId,
                  configuration_id: configurationId,
                  version_id: versionId,
                  user_id: teammateId,
                  selected_at: new Date(),
                })
                .execute(),
            teammateId,
          );
        await expect(select(draft.configuration.id, draft.version.id)).rejects.toMatchObject({ code: "42501" });
        await select(published.id, publishedVersion.id);
        const teammates = await ownerDb
          .selectFrom("configuration_version_selections")
          .select("configuration_id")
          .where("user_id", "=", teammateId)
          .execute();
        expect(teammates).toEqual([{ configuration_id: published.id }]);
      });
    });
  });
});
