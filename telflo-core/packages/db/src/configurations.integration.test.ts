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
 * configurations (migration 1700000000015): its constraints, as the owner;
 * its row-level security, as the API's role (`db`), which the policies
 * constrain.
 */
describe("configurations", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  /** The catalogue's default distribution and version, which a row written by hand names. */
  let pin: { distribution: string; version: string };

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    pin = await catalogueDefaults(ownerDb);
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A live group organization with an admin, who also keeps their personal organization. */
  const createOrganization = async () => {
    const admin = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: admin.user.id });
    return { adminId: admin.user.id, organization: group.organization };
  };

  /** A new user, a member of `organizationId` with `role` besides their personal organization; their id. */
  const addMember = async (organizationId: string, role: "admin" | "contributor") => {
    const member = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: member.user.id, organizationId, role });
    return member.user.id;
  };

  const configurationRow = (id: string) =>
    ownerDb.selectFrom("configurations").selectAll().where("id", "=", id).executeTakeFirst();

  describe("constraints", () => {
    it("stores a configuration with its defaults: no description, not deleted, a uuidv7 id", async () => {
      const { adminId, organization } = await createOrganization();
      const at = new Date("2030-01-01T00:00:00.123Z");
      const configuration = await addConfiguration(ownerDb, {
        organizationId: organization.id,
        name: "Gateway",
        created_by_user_id: adminId,
        created_at: at,
        updated_at: at,
      });
      expect(configuration).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        organization_id: organization.id,
        name: "Gateway",
        description: "",
        created_by_user_id: adminId,
        created_at: at,
        updated_at: at,
        deleted_at: null,
        // The fixture's: the catalogue's default distribution.
        collector_distribution: pin.distribution,
        // Created blank, from no flow.
        source_flow_slug: null,
      });
    });

    it("refuses a row without created_at or updated_at (23502): they have no default, so a write that forgets the clock fails", async () => {
      const { organization } = await createOrganization();
      await expect(
        sql`insert into configurations (organization_id, name, updated_at) values (${organization.id}, 'a', ${new Date()})`.execute(
          ownerDb,
        ),
      ).rejects.toMatchObject({ code: "23502", column: "created_at" });
      await expect(
        sql`insert into configurations (organization_id, name, created_at) values (${organization.id}, 'a', ${new Date()})`.execute(
          ownerDb,
        ),
      ).rejects.toMatchObject({ code: "23502", column: "updated_at" });
    });

    it("refuses a name with a leading or a trailing space", async () => {
      const { organization } = await createOrganization();
      for (const name of [" Gateway", "Gateway ", " Gateway "]) {
        await expect(addConfiguration(ownerDb, { organizationId: organization.id, name })).rejects.toThrow(
          /ck_configurations_name_trimmed/,
        );
      }
    });

    it("refuses an empty name", async () => {
      const { organization } = await createOrganization();
      await expect(addConfiguration(ownerDb, { organizationId: organization.id, name: "" })).rejects.toThrow(
        /ck_configurations_name_length/,
      );
    });

    it("refuses a 201-character name and accepts a 200-character one", async () => {
      const { organization } = await createOrganization();
      await expect(addConfiguration(ownerDb, { organizationId: organization.id, name: "n".repeat(201) })).rejects.toThrow(
        /ck_configurations_name_length/,
      );
      await expect(
        addConfiguration(ownerDb, { organizationId: organization.id, name: "n".repeat(200) }),
      ).resolves.toMatchObject({ name: "n".repeat(200) });
    });

    it("refuses a description with a leading or a trailing space", async () => {
      const { organization } = await createOrganization();
      for (const description of [" Collects logs", "Collects logs "]) {
        await expect(addConfiguration(ownerDb, { organizationId: organization.id, description })).rejects.toThrow(
          /ck_configurations_description_trimmed/,
        );
      }
    });

    it("refuses a 501-character description and accepts a 500-character one", async () => {
      const { organization } = await createOrganization();
      await expect(
        addConfiguration(ownerDb, { organizationId: organization.id, description: "d".repeat(501) }),
      ).rejects.toThrow(/ck_configurations_description_length/);
      await expect(
        addConfiguration(ownerDb, { organizationId: organization.id, description: "d".repeat(500) }),
      ).resolves.toMatchObject({ description: "d".repeat(500) });
    });

    it("allows two configurations with the same name in one organization", async () => {
      const { organization } = await createOrganization();
      const first = await addConfiguration(ownerDb, { organizationId: organization.id, name: "Gateway" });
      const second = await addConfiguration(ownerDb, { organizationId: organization.id, name: "Gateway" });
      expect(second.id).not.toBe(first.id);
    });

    it("refuses a configuration in an organization that does not exist", async () => {
      await expect(
        addConfiguration(ownerDb, { organizationId: "00000000-0000-7000-8000-000000000000" }),
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("is the target of a composite foreign key on (id, organization_id): a child naming another organization is refused", async () => {
      const first = await createOrganization();
      const second = await createOrganization();
      const configuration = await addConfiguration(ownerDb, { organizationId: first.organization.id });

      // Rolled back: the referencing table exists only inside this
      // transaction. A temporary table can't reference a permanent one.
      const rollback = new Error("rollback");
      await expect(
        ownerDb.transaction().execute(async (transaction) => {
          await sql`
            create table test_configuration_children (
              configuration_id uuid not null,
              organization_id  uuid not null,
              foreign key (configuration_id, organization_id) references configurations (id, organization_id)
            )
          `.execute(transaction);
          await sql`
            insert into test_configuration_children values (${configuration.id}, ${first.organization.id})
          `.execute(transaction);
          await expect(
            sql`
              insert into test_configuration_children values (${configuration.id}, ${second.organization.id})
            `.execute(transaction),
          ).rejects.toMatchObject({ code: "23503" });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });

    it("keeps the configuration, with no creator, when the creator's account is hard-deleted", async () => {
      // In a group organization: a personal one cascades with its owner and
      // would take the configuration with it.
      const { organization } = await createOrganization();
      const creator = await createUserWithOrganization(ownerDb);
      await addMembership(ownerDb, { userId: creator.user.id, organizationId: organization.id, role: "contributor" });
      const configuration = await addConfiguration(ownerDb, {
        organizationId: organization.id,
        created_by_user_id: creator.user.id,
      });

      await ownerDb.deleteFrom("users").where("id", "=", creator.user.id).execute();

      expect(await configurationRow(configuration.id)).toEqual({ ...configuration, created_by_user_id: null });
    });

    it("goes with its organization when the organization is hard-deleted, and leaves other organizations' configurations", async () => {
      const doomed = await createOrganization();
      const kept = await createOrganization();
      const live = await addConfiguration(ownerDb, { organizationId: doomed.organization.id });
      const deleted = await addConfiguration(ownerDb, { organizationId: doomed.organization.id, deleted_at: new Date() });
      const elsewhere = await addConfiguration(ownerDb, { organizationId: kept.organization.id });

      await ownerDb.deleteFrom("organizations").where("id", "=", doomed.organization.id).execute();

      expect(await configurationRow(live.id)).toBeUndefined();
      expect(await configurationRow(deleted.id)).toBeUndefined();
      expect(await configurationRow(elsewhere.id)).toEqual(elsewhere);
    });
  });

  describe("row-level security, as the application role", () => {
    /**
     * Runs `work` in a transaction whose context is `organizationId` and
     * `userId`, as context.ts sets them (null: that setting left unset).
     */
    const inContext = <T>(
      organizationId: string | null,
      userId: string | null,
      work: (transaction: Kysely<Database>) => Promise<T>,
    ) =>
      db.transaction().execute(async (transaction) => {
        if (organizationId !== null) {
          await sql`select set_config('telflo.organization_id', ${organizationId}, true)`.execute(transaction);
        }
        if (userId !== null) {
          await sql`select set_config('telflo.user_id', ${userId}, true)`.execute(transaction);
        }
        return work(transaction);
      });

    const visibleIds = (transaction: Kysely<Database>) =>
      transaction
        .selectFrom("configurations")
        .select("id")
        .execute()
        .then((rows) => rows.map((row) => row.id).sort());

    /**
     * Two organizations with a configuration each, created by their admin,
     * and a deleted one in A, which the policy doesn't hide.
     */
    const twoOrganizations = async () => {
      const a = await createOrganization();
      const b = await createOrganization();
      const inA = await addConfiguration(ownerDb, { organizationId: a.organization.id, created_by_user_id: a.adminId });
      const deletedInA = await addConfiguration(ownerDb, {
        organizationId: a.organization.id,
        created_by_user_id: a.adminId,
        deleted_at: new Date(),
      });
      const inB = await addConfiguration(ownerDb, { organizationId: b.organization.id, created_by_user_id: b.adminId });
      return { a: a.organization.id, aAdmin: a.adminId, b: b.organization.id, bAdmin: b.adminId, inA, deletedInA, inB };
    };

    const newRow = (organizationId: string, name: string, createdByUserId: string | null) => {
      const at = new Date();
      return {
        organization_id: organizationId,
        name,
        created_by_user_id: createdByUserId,
        collector_distribution: pin.distribution,
        created_at: at,
        updated_at: at,
      };
    };

    it("shows nothing without a context", async () => {
      const { aAdmin } = await twoOrganizations();
      expect(await visibleIds(db)).toEqual([]);
      expect(await inContext(null, null, visibleIds)).toEqual([]);
      // The author alone, with no organization, still sees nothing.
      expect(await inContext(null, aAdmin, visibleIds)).toEqual([]);
    });

    it("shows the context's user's configurations in the context's organization, deleted ones included, and no other organization's", async () => {
      const { a, aAdmin, inA, deletedInA } = await twoOrganizations();
      expect(await inContext(a, aAdmin, visibleIds)).toEqual([inA.id, deletedInA.id].sort());
    });

    it("refuses an insert naming another organization with 42501", async () => {
      const { a, aAdmin, b } = await twoOrganizations();
      await expect(
        inContext(a, aAdmin, (transaction) =>
          transaction
            .insertInto("configurations")
            .values(newRow(b, "Smuggled", aAdmin))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const smuggled = await ownerDb.selectFrom("configurations").select("id").where("name", "=", "Smuggled").execute();
      expect(smuggled).toEqual([]);
    });

    it("inserts in the context's organization, created by the context's user", async () => {
      const { a, aAdmin } = await twoOrganizations();
      const row = await inContext(a, aAdmin, (transaction) =>
        transaction
          .insertInto("configurations")
          .values(newRow(a, "Welcome", aAdmin))
          .returning("id")
          .executeTakeFirstOrThrow(),
      );
      expect(await configurationRow(row.id)).toMatchObject({
        organization_id: a,
        name: "Welcome",
        created_by_user_id: aAdmin,
      });
    });

    it("refuses an insert created by anyone but the context's user, or by no one, with 42501 (a new configuration is its creator's draft)", async () => {
      const { a, aAdmin } = await twoOrganizations();
      const teammateId = await addMember(a, "contributor");
      for (const creator of [teammateId, null]) {
        await expect(
          inContext(a, aAdmin, (transaction) =>
            transaction
              .insertInto("configurations")
              .values(newRow(a, "Forged", creator))
              .execute(),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
      // With only the organization in the context, none passes.
      await expect(
        inContext(a, null, (transaction) =>
          transaction
            .insertInto("configurations")
            .values(newRow(a, "Forged", aAdmin))
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await ownerDb.selectFrom("configurations").select("id").where("name", "=", "Forged").execute()).toEqual(
        [],
      );
    });

    it("updates nothing in another organization", async () => {
      const { a, aAdmin, b, inB } = await twoOrganizations();
      const result = await inContext(a, aAdmin, (transaction) =>
        transaction
          .updateTable("configurations")
          .set({ name: "Changed" })
          .where("organization_id", "=", b)
          .executeTakeFirst(),
      );
      expect(result.numUpdatedRows).toBe(0n);
      expect(await configurationRow(inB.id)).toEqual(inB);
    });

    it("refuses moving a configuration out of the context's organization with 42501", async () => {
      const { a, aAdmin, b, inA } = await twoOrganizations();
      await expect(
        inContext(a, aAdmin, (transaction) =>
          transaction.updateTable("configurations").set({ organization_id: b }).where("id", "=", inA.id).execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await configurationRow(inA.id)).toEqual(inA);
    });

    it("deletes nothing in another organization", async () => {
      const { a, aAdmin, b, inB } = await twoOrganizations();
      const result = await inContext(a, aAdmin, (transaction) =>
        transaction.deleteFrom("configurations").where("organization_id", "=", b).executeTakeFirst(),
      );
      expect(result.numDeletedRows).toBe(0n);
      expect(await configurationRow(inB.id)).toEqual(inB);
    });

    describe("drafts are private (migration 1700000000021)", () => {
      /**
       * One organization: an author's draft, the author's published
       * configuration (v1 published, v2 a draft), and a never-published one
       * whose author's account is gone. Two other members: a contributor and
       * an admin.
       */
      const oneOrganization = async () => {
        const { adminId: authorId, organization } = await createOrganization();
        const teammateId = await addMember(organization.id, "contributor");
        const adminId = await addMember(organization.id, "admin");
        const draft = await addConfiguration(ownerDb, {
          organizationId: organization.id,
          created_by_user_id: authorId,
        });
        await addConfigurationVersion(ownerDb, { configurationId: draft.id, organizationId: organization.id });
        const published = await addConfiguration(ownerDb, {
          organizationId: organization.id,
          created_by_user_id: authorId,
        });
        await addConfigurationVersion(ownerDb, {
          configurationId: published.id,
          organizationId: organization.id,
          publishedAt: new Date(),
        });
        await addConfigurationVersion(ownerDb, {
          configurationId: published.id,
          organizationId: organization.id,
          version_number: 2,
        });
        const authorless = await addConfiguration(ownerDb, { organizationId: organization.id });
        await addConfigurationVersion(ownerDb, { configurationId: authorless.id, organizationId: organization.id });
        return {
          organizationId: organization.id,
          authorId,
          teammateId,
          adminId,
          draft,
          published,
          authorless,
        };
      };

      it("shows a member their own drafts and every published configuration, never another member's draft, whatever their role", async () => {
        const { organizationId, authorId, teammateId, adminId, draft, published } = await oneOrganization();
        expect(await inContext(organizationId, authorId, visibleIds)).toEqual([draft.id, published.id].sort());
        expect(await inContext(organizationId, teammateId, visibleIds)).toEqual([published.id]);
        expect(await inContext(organizationId, adminId, visibleIds)).toEqual([published.id]);
      });

      it("shows a never-published configuration whose author is gone to no one, admins included", async () => {
        const { organizationId, authorId, teammateId, adminId, authorless } = await oneOrganization();
        for (const viewer of [authorId, teammateId, adminId]) {
          expect(await inContext(organizationId, viewer, visibleIds)).not.toContain(authorless.id);
        }
      });

      it("shows a published configuration whose author is gone to every member", async () => {
        const { organizationId, teammateId, authorless } = await oneOrganization();
        await addConfigurationVersion(ownerDb, {
          configurationId: authorless.id,
          organizationId,
          version_number: 2,
          publishedAt: new Date(),
        });
        expect(await inContext(organizationId, teammateId, visibleIds)).toContain(authorless.id);
      });

      it("lets no member change, lock or delete another member's draft: no row matches", async () => {
        const { organizationId, teammateId, adminId, draft } = await oneOrganization();
        for (const viewer of [teammateId, adminId]) {
          const updated = await inContext(organizationId, viewer, (transaction) =>
            transaction
              .updateTable("configurations")
              .set({ name: "Taken" })
              .where("id", "=", draft.id)
              .executeTakeFirst(),
          );
          expect(updated.numUpdatedRows).toBe(0n);
          const locked = await inContext(organizationId, viewer, (transaction) =>
            transaction.selectFrom("configurations").select("id").where("id", "=", draft.id).forUpdate().execute(),
          );
          expect(locked).toEqual([]);
          const deleted = await inContext(organizationId, viewer, (transaction) =>
            transaction.deleteFrom("configurations").where("id", "=", draft.id).executeTakeFirst(),
          );
          expect(deleted.numDeletedRows).toBe(0n);
        }
        expect(await configurationRow(draft.id)).toEqual(draft);
      });

      it("lets a teammate change and lock a published configuration", async () => {
        const { organizationId, teammateId, published } = await oneOrganization();
        const renamed = await inContext(organizationId, teammateId, async (transaction) => {
          await transaction
            .selectFrom("configurations")
            .select("id")
            .where("id", "=", published.id)
            .forUpdate()
            .execute();
          return transaction
            .updateTable("configurations")
            .set({ name: "Renamed" })
            .where("id", "=", published.id)
            .returning("name")
            .execute();
        });
        expect(renamed).toEqual([{ name: "Renamed" }]);
      });

      describe("configuration_is_published, the policies' definer helper", () => {
        const isPublished = (transaction: Kysely<Database>, configurationId: string, organizationId: string) =>
          sql<{ published: boolean | null }>`
            select configuration_is_published(${configurationId}, ${organizationId}) as published
          `
            .execute(transaction)
            .then(({ rows }) => rows[0]!.published);

        it("answers true for a published configuration and false for a draft, to any member, as the API's role", async () => {
          const { organizationId, teammateId, draft, published } = await oneOrganization();
          expect(
            await inContext(organizationId, teammateId, (transaction) =>
              isPublished(transaction, published.id, organizationId),
            ),
          ).toBe(true);
          expect(
            await inContext(organizationId, teammateId, (transaction) =>
              isPublished(transaction, draft.id, organizationId),
            ),
          ).toBe(false);
        });

        it("answers false, never null, for any organization but the context's, or with no context, though the configuration is published there", async () => {
          const { organizationId, published } = await oneOrganization();
          const elsewhere = await createOrganization();
          expect(
            await inContext(elsewhere.organization.id, elsewhere.adminId, (transaction) =>
              isPublished(transaction, published.id, organizationId),
            ),
          ).toBe(false);
          expect(
            await inContext(null, null, (transaction) => isPublished(transaction, published.id, organizationId)),
          ).toBe(false);
        });
      });

      // Out of their own sight, which the update policy's check refuses
      // (42501); since migration 022 the author trigger, which fires before
      // that check, refuses it first (P0001).
      it("refuses the author handing their draft to another member (P0001, migration 1700000000022)", async () => {
        const { organizationId, authorId, teammateId, draft } = await oneOrganization();
        await expect(
          inContext(organizationId, authorId, (transaction) =>
            transaction
              .updateTable("configurations")
              .set({ created_by_user_id: teammateId })
              .where("id", "=", draft.id)
              .execute(),
          ),
        ).rejects.toMatchObject({ code: "P0001" });
        expect(await configurationRow(draft.id)).toEqual(draft);
      });

      describe("never hard-deleted, and keeping its author (migration 1700000000022)", () => {
        const versionIds = (configurationId: string) =>
          ownerDb
            .selectFrom("configuration_versions")
            .select("id")
            .where("configuration_id", "=", configurationId)
            .execute()
            .then((rows) => rows.map((row) => row.id).sort());

        it("deletes no configuration as the API's role, whoever asks: its author's own draft, a published one, 0 rows and every version kept", async () => {
          const { organizationId, authorId, teammateId, adminId, draft, published } = await oneOrganization();
          const versionsBefore = { draft: await versionIds(draft.id), published: await versionIds(published.id) };
          expect(versionsBefore.published).toHaveLength(2);
          const attempts: Array<[string, string]> = [
            [authorId, draft.id],
            [authorId, published.id],
            [teammateId, published.id],
            [adminId, published.id],
          ];
          for (const [viewer, id] of attempts) {
            const deleted = await inContext(organizationId, viewer, (transaction) =>
              transaction.deleteFrom("configurations").where("id", "=", id).executeTakeFirst(),
            );
            expect(deleted.numDeletedRows, `${viewer} deleting ${id}`).toBe(0n);
          }
          // Nor every row it can see at once.
          const all = await inContext(organizationId, authorId, (transaction) =>
            transaction.deleteFrom("configurations").executeTakeFirst(),
          );
          expect(all.numDeletedRows).toBe(0n);
          expect(await configurationRow(draft.id)).toEqual(draft);
          expect(await configurationRow(published.id)).toEqual(published);
          expect({ draft: await versionIds(draft.id), published: await versionIds(published.id) }).toEqual(
            versionsBefore,
          );
        });

        it("refuses a teammate making themselves a published configuration's author with P0001, naming only its id", async () => {
          const { organizationId, teammateId, published } = await oneOrganization();
          const attempt = inContext(organizationId, teammateId, (transaction) =>
            sql`update configurations set created_by_user_id = ${teammateId} where id = ${published.id}`.execute(
              transaction,
            ),
          );
          await expect(attempt).rejects.toMatchObject({
            code: "P0001",
            message: `configuration ${published.id} keeps its author`,
          });
          expect(await configurationRow(published.id)).toEqual(published);
        });

        it("refuses it for every role, the tables' owner included, and from no author to one", async () => {
          const { teammateId, published, authorless } = await oneOrganization();
          for (const configuration of [published, authorless]) {
            await expect(
              ownerDb
                .updateTable("configurations")
                .set({ created_by_user_id: teammateId })
                .where("id", "=", configuration.id)
                .execute(),
            ).rejects.toMatchObject({ code: "P0001" });
            expect(await configurationRow(configuration.id)).toEqual(configuration);
          }
        });

        it("passes a write of the same author, and the author's account's hard delete setting it to null", async () => {
          const { organizationId, authorId, teammateId, published } = await oneOrganization();
          const renamed = await inContext(organizationId, teammateId, (transaction) =>
            transaction
              .updateTable("configurations")
              .set({ name: "Renamed", created_by_user_id: authorId })
              .where("id", "=", published.id)
              .executeTakeFirst(),
          );
          expect(renamed.numUpdatedRows).toBe(1n);
          const versionsBefore = await versionIds(published.id);

          await ownerDb.deleteFrom("users").where("id", "=", authorId).execute();

          expect(await configurationRow(published.id)).toEqual({
            ...published,
            name: "Renamed",
            created_by_user_id: null,
          });
          expect(await versionIds(published.id)).toEqual(versionsBefore);
        });
      });

      describe("keeping its collector distribution (migration 1700000000023)", () => {
        const refusal = (id: string) => ({ code: "P0001", message: `configuration ${id} keeps its collector distribution` });

        /**
         * Runs `work` as the owner in a transaction that adds a second
         * distribution to the catalogue, `fixture-distribution` with one
         * version, and is always rolled back, so telflo_platform_test's catalogue
         * stays the committed one.
         */
        const withFixtureDistribution = async (work: (transaction: Kysely<Database>) => Promise<void>) => {
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
              await work(transaction);
              throw rollback;
            }),
          ).rejects.toBe(rollback);
        };

        /** `update` in a savepoint, rolled back to on failure, so the transaction goes on; its error, if any. */
        const attempt = async (transaction: Kysely<Database>, update: () => Promise<unknown>) => {
          await sql`savepoint attempt`.execute(transaction);
          try {
            await update();
            await sql`release savepoint attempt`.execute(transaction);
            return undefined;
          } catch (error) {
            await sql`rollback to savepoint attempt`.execute(transaction);
            return error;
          }
        };

        it("refuses the API's role changing a configuration's distribution with P0001, naming only its id, before any foreign key's check would", async () => {
          const { organizationId, authorId, teammateId, draft, published } = await oneOrganization();
          for (const [viewer, configuration] of [
            [authorId, draft],
            [teammateId, published],
          ] as const) {
            // A distribution the catalogue doesn't have: only the trigger, a
            // before trigger, can answer P0001; the foreign keys would say 23503.
            await expect(
              inContext(organizationId, viewer, (transaction) =>
                sql`update configurations set collector_distribution = 'fixture-distribution' where id = ${configuration.id}`.execute(
                  transaction,
                ),
              ),
            ).rejects.toMatchObject(refusal(configuration.id));
            expect(await configurationRow(configuration.id)).toEqual(configuration);
          }
        });

        it("refuses the tables' owner too, to a distribution the catalogue has, a configuration with no version included", async () => {
          const { organizationId, published } = await oneOrganization();
          await withFixtureDistribution(async (transaction) => {
            const versionless = await addConfiguration(transaction, { organizationId });
            for (const configuration of [versionless, published]) {
              const error = await attempt(transaction, () =>
                transaction
                  .updateTable("configurations")
                  .set({ collector_distribution: "fixture-distribution" } as never)
                  .where("id", "=", configuration.id)
                  .execute(),
              );
              expect(error).toMatchObject(refusal(configuration.id));
            }
            expect(
              await transaction
                .selectFrom("configurations")
                .select("collector_distribution")
                .where("id", "=", versionless.id)
                .executeTakeFirstOrThrow(),
            ).toEqual({ collector_distribution: versionless.collector_distribution });
          });
          expect(await configurationRow(published.id)).toEqual(published);
        });

        it("passes a write of the same distribution, as the API's role and as the owner", async () => {
          const { organizationId, authorId, draft } = await oneOrganization();
          const asApplication = await inContext(organizationId, authorId, (transaction) =>
            sql`update configurations set name = 'Renamed', collector_distribution = ${draft.collector_distribution} where id = ${draft.id}`.execute(
              transaction,
            ),
          );
          expect(asApplication.numAffectedRows).toBe(1n);
          const asOwner = await sql`
            update configurations set collector_distribution = ${draft.collector_distribution} where id = ${draft.id}
          `.execute(ownerDb);
          expect(asOwner.numAffectedRows).toBe(1n);
          expect(await configurationRow(draft.id)).toEqual({ ...draft, name: "Renamed" });
        });
      });
    });
  });
});
