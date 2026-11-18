import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addConfigurationVersionSelection,
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext } from "../../../database/context.js";
import {
  createConfigurationVersionSelectionRepository,
  type IConfigurationVersionSelectionRepository,
} from "./configuration-version-selection-repository.js";

describe("configuration version selection repository", () => {
  /** The repository's connection, as the API's own role, which row-level security constrains. */
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

  const selectionRows = () =>
    ownerDb.selectFrom("configuration_version_selections").selectAll().orderBy("id").execute();

  /**
   * A member acting in a live group organization (they keep their personal
   * one) with a colleague, the member's configuration with versions 1
   * (published, so the colleague sees it too: D11b decision 1) and 2, and
   * another organization with a configuration and its version 1.
   */
  const organizationWithNeighbour = async () => {
    const member = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: member.user.id, role: "contributor" });
    const colleague = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, {
      userId: colleague.user.id,
      organizationId: group.organization.id,
      role: "contributor",
    });
    const organizationId = group.organization.id;
    const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: member.user.id });
    const first = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      publishedAt: new Date(),
    });
    const second = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      version_number: 2,
    });
    const neighbour = await createUserWithOrganization(ownerDb);
    const elsewhere = await addConfiguration(ownerDb, { organizationId: neighbour.organization.id });
    const versionElsewhere = await addConfigurationVersion(ownerDb, {
      configurationId: elsewhere.id,
      organizationId: neighbour.organization.id,
    });
    return {
      memberId: member.user.id,
      colleagueId: colleague.user.id,
      organizationId,
      configuration,
      first,
      second,
      neighbour: { userId: neighbour.user.id, organizationId: neighbour.organization.id },
      elsewhere,
      versionElsewhere,
    };
  };

  /** Runs `work` in `organizationId`'s database context, as `userId`, with the repository bound to it. */
  const inOrganization = <Result>(
    userId: string,
    organizationId: string,
    work: (selections: IConfigurationVersionSelectionRepository) => Promise<Result>,
  ) =>
    withDatabaseContext(db, { userId, organizationId }, (transaction) =>
      work(createConfigurationVersionSelectionRepository(transaction, { organizationId })),
    );

  /** Deletes the configuration softly, as the configurations repository's markDeleted does. */
  const markDeleted = (configurationId: string) =>
    ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", configurationId).execute();

  describe("record and find", () => {
    it("records a selection at the clock's time, and finds it", async () => {
      const { memberId, organizationId, configuration, second } = await organizationWithNeighbour();
      const now = new Date("2030-01-01T00:00:00.123Z");

      const recorded = await inOrganization(memberId, organizationId, (selections) =>
        selections.record(memberId, configuration.id, second.id, now),
      );

      expect(recorded).toBe(true);
      expect(await selectionRows()).toEqual([
        {
          id: expect.any(String),
          organization_id: organizationId,
          configuration_id: configuration.id,
          version_id: second.id,
          user_id: memberId,
          selected_at: now,
        },
      ]);
      expect(
        await inOrganization(memberId, organizationId, (selections) => selections.find(memberId, configuration.id)),
      ).toBe(second.id);
    });

    it("replaces the selection when recorded again: one row, the new version and time, its id kept", async () => {
      const { memberId, organizationId, configuration, first, second } = await organizationWithNeighbour();
      await inOrganization(memberId, organizationId, (selections) =>
        selections.record(memberId, configuration.id, second.id, new Date("2030-01-01T00:00:00.000Z")),
      );
      const [before] = await selectionRows();
      const later = new Date("2030-01-02T00:00:00.000Z");

      const recorded = await inOrganization(memberId, organizationId, (selections) =>
        selections.record(memberId, configuration.id, first.id, later),
      );

      expect(recorded).toBe(true);
      expect(await selectionRows()).toEqual([{ ...before, version_id: first.id, selected_at: later }]);
      expect(
        await inOrganization(memberId, organizationId, (selections) => selections.find(memberId, configuration.id)),
      ).toBe(first.id);
    });

    it("keeps each person's selection to themselves: another person's isn't found for them, and theirs doesn't replace it", async () => {
      const { memberId, colleagueId, organizationId, configuration, first, second } = await organizationWithNeighbour();
      await inOrganization(memberId, organizationId, (selections) =>
        selections.record(memberId, configuration.id, second.id, new Date()),
      );

      // Only the member's selection exists: the colleague has none.
      expect(
        await inOrganization(colleagueId, organizationId, (selections) =>
          selections.find(colleagueId, configuration.id),
        ),
      ).toBeUndefined();

      await inOrganization(colleagueId, organizationId, (selections) =>
        selections.record(colleagueId, configuration.id, first.id, new Date()),
      );
      await inOrganization(memberId, organizationId, async (selections) => {
        expect(await selections.find(memberId, configuration.id)).toBe(second.id);
        expect(await selections.find(colleagueId, configuration.id)).toBe(first.id);
      });
      expect(await selectionRows()).toHaveLength(2);
    });

    it("keeps one selection per configuration: selecting another configuration's version leaves this one's", async () => {
      const { memberId, organizationId, configuration, second } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });
      const otherVersion = await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId });

      await inOrganization(memberId, organizationId, async (selections) => {
        await selections.record(memberId, configuration.id, second.id, new Date());
        await selections.record(memberId, other.id, otherVersion.id, new Date());
        expect(await selections.find(memberId, configuration.id)).toBe(second.id);
        expect(await selections.find(memberId, other.id)).toBe(otherVersion.id);
      });
    });

    it("finds nothing when the person has selected nothing", async () => {
      const { memberId, organizationId, configuration } = await organizationWithNeighbour();
      expect(
        await inOrganization(memberId, organizationId, (selections) => selections.find(memberId, configuration.id)),
      ).toBeUndefined();
    });

    it("doesn't find a selection of a deleted configuration", async () => {
      const { memberId, organizationId, configuration, second } = await organizationWithNeighbour();
      await inOrganization(memberId, organizationId, (selections) =>
        selections.record(memberId, configuration.id, second.id, new Date()),
      );
      await markDeleted(configuration.id);

      expect(
        await inOrganization(memberId, organizationId, (selections) => selections.find(memberId, configuration.id)),
      ).toBeUndefined();
      // The row stays until the configuration's row goes.
      expect(await selectionRows()).toHaveLength(1);
    });

    it("doesn't find another organization's selection, even with its real ids", async () => {
      const { memberId, organizationId, neighbour, elsewhere, versionElsewhere } = await organizationWithNeighbour();
      await addConfigurationVersionSelection(ownerDb, {
        organizationId: neighbour.organizationId,
        configurationId: elsewhere.id,
        versionId: versionElsewhere.id,
        userId: neighbour.userId,
      });

      expect(
        await inOrganization(memberId, organizationId, (selections) => selections.find(neighbour.userId, elsewhere.id)),
      ).toBeUndefined();
    });
  });

  describe("record's refusals", () => {
    it("returns false and writes nothing for a version of another configuration, an unknown version, or a deleted configuration's", async () => {
      const { memberId, organizationId, configuration, second } = await organizationWithNeighbour();
      const other = await addConfiguration(ownerDb, { organizationId });
      const versionOfOther = await addConfigurationVersion(ownerDb, { configurationId: other.id, organizationId });
      const deleted = await addConfiguration(ownerDb, { organizationId, deleted_at: new Date() });
      const ofDeleted = await addConfigurationVersion(ownerDb, { configurationId: deleted.id, organizationId });

      await inOrganization(memberId, organizationId, async (selections) => {
        expect(await selections.record(memberId, configuration.id, versionOfOther.id, new Date())).toBe(false);
        expect(await selections.record(memberId, other.id, second.id, new Date())).toBe(false);
        expect(
          await selections.record(memberId, configuration.id, "00000000-0000-7000-8000-000000000000", new Date()),
        ).toBe(false);
        expect(await selections.record(memberId, deleted.id, ofDeleted.id, new Date())).toBe(false);
      });
      expect(await selectionRows()).toEqual([]);
    });

    it("returns false and leaves the earlier selection when the configuration has since been deleted", async () => {
      const { memberId, organizationId, configuration, first, second } = await organizationWithNeighbour();
      await inOrganization(memberId, organizationId, (selections) =>
        selections.record(memberId, configuration.id, second.id, new Date()),
      );
      const before = await selectionRows();
      await markDeleted(configuration.id);

      expect(
        await inOrganization(memberId, organizationId, (selections) =>
          selections.record(memberId, configuration.id, first.id, new Date()),
        ),
      ).toBe(false);
      expect(await selectionRows()).toEqual(before);
    });

    it("returns false and writes nothing for another organization's configuration and version, without a foreign-key error", async () => {
      const { memberId, organizationId, neighbour, elsewhere, versionElsewhere } = await organizationWithNeighbour();
      const theirs = await addConfigurationVersionSelection(ownerDb, {
        organizationId: neighbour.organizationId,
        configurationId: elsewhere.id,
        versionId: versionElsewhere.id,
        userId: neighbour.userId,
        selected_at: new Date("2000-01-01T00:00:00.000Z"),
      });

      await inOrganization(memberId, organizationId, async (selections) => {
        expect(await selections.record(memberId, elsewhere.id, versionElsewhere.id, new Date())).toBe(false);
        expect(await selections.record(neighbour.userId, elsewhere.id, versionElsewhere.id, new Date())).toBe(false);
      });
      expect(await selectionRows()).toEqual([theirs]);
    });

    it("returns false and writes nothing for another member's draft, and finds none of the author's selection of it (D11b decision 1)", async () => {
      const { memberId, colleagueId, organizationId } = await organizationWithNeighbour();
      const draft = await addConfiguration(ownerDb, { organizationId, created_by_user_id: memberId });
      const draftVersion = await addConfigurationVersion(ownerDb, { configurationId: draft.id, organizationId });
      await inOrganization(memberId, organizationId, (selections) =>
        selections.record(memberId, draft.id, draftVersion.id, new Date()),
      );
      const before = await selectionRows();

      await inOrganization(colleagueId, organizationId, async (selections) => {
        expect(await selections.record(colleagueId, draft.id, draftVersion.id, new Date())).toBe(false);
        expect(await selections.find(colleagueId, draft.id)).toBeUndefined();
        expect(await selections.find(memberId, draft.id)).toBeUndefined();
      });
      expect(await selectionRows()).toEqual(before);
    });
  });
});
