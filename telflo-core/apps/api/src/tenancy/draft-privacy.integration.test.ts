import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addConfigurationVersionSelection,
  addMembership,
  addTestDefinition,
  addTestDefinitionInput,
  addTestInputFile,
  addTestRun,
  addTestSuite,
  addValidationPipeline,
  addValidationRule,
  catalogueDefaults,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext } from "../database/context.js";
import { createConfigurationRepository } from "../modules/configurations/repositories/configuration-repository.js";
import { createConfigurationVersionRepository } from "../modules/configurations/repositories/configuration-version-repository.js";
import { createConfigurationVersionSelectionRepository } from "../modules/configurations/repositories/configuration-version-selection-repository.js";

/*
 * Drafts are private within one organization. The cross-tenant suite keeps
 * organizations apart; this one keeps members of one organization apart: a
 * member sees their own drafts and every published configuration with all its
 * versions, never another member's draft, and a configuration whose author's
 * account is gone and that was never published is visible to no one, admins
 * included.
 *
 * Each rule is checked twice: through the repositories the API uses, and in
 * raw SQL as the API's role, where row-level security (migration
 * 1700000000021) is the only thing in the way.
 *
 * Test runs follow their configuration (migration 1700000000028): a draft's
 * runs are its author's alone, and once the configuration is published every
 * member sees its runs, past and future. Test files are their owner's alone.
 * Here they are checked in raw SQL only.
 *
 * Test suites, their definitions and the definitions' inputs follow their
 * configuration too (migration 1700000000029): a draft's are its author's
 * alone; once published, every member sees them and may add and rename
 * suites, on any version. Here they are checked in raw SQL only.
 *
 * Validation pipelines and their rules follow their configuration too
 * (migration 1700000000030): a draft's are its author's alone; once
 * published, every member sees them and may add, change and delete rules, on
 * any version. Here they are checked in raw SQL only.
 */

describe("draft privacy within an organization", () => {
  /** The API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let databases: TestDatabases;
  /** The catalog's default distribution and version, which a version inserted by hand is pinned to. */
  let pin: { collector_distribution: string; collector_version: string };

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    const defaults = await catalogueDefaults(ownerDb);
    pin = { collector_distribution: defaults.distribution, collector_version: defaults.version };
  });

  afterAll(async () => {
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** A new user, a member of `organizationId` in `role` beside their personal organization; their id. */
  const addMember = async (organizationId: string, role: "admin" | "contributor") => {
    const person = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: person.user.id, organizationId, role });
    return person.user.id;
  };

  /**
   * One group organization with three members: an author and a teammate
   * (contributors) and an admin. The author has a draft (v1) and a
   * published configuration (v1 published, v2 a draft), each with the
   * author's selection and a waiting test run queued by the author (on v1
   * and on v2), and a test file of their own; a departed author left a
   * never-published configuration and a published one (their account is
   * gone, so both have no creator).
   */
  const seed = async () => {
    const founder = await createUserWithOrganization(ownerDb);
    const { organization } = await addMembership(ownerDb, { userId: founder.user.id });
    const organizationId = organization.id;
    const authorId = await addMember(organizationId, "contributor");
    const teammateId = await addMember(organizationId, "contributor");
    const adminId = await addMember(organizationId, "admin");

    const draft = await addConfiguration(ownerDb, {
      organizationId,
      name: "Author's draft",
      created_by_user_id: authorId,
    });
    const draftV1 = await addConfigurationVersion(ownerDb, {
      configurationId: draft.id,
      organizationId,
      yaml_content: "receivers: {} # private\n",
      created_by_user_id: authorId,
    });
    const published = await addConfiguration(ownerDb, {
      organizationId,
      name: "Author's published",
      created_by_user_id: authorId,
    });
    const publishedV1 = await addConfigurationVersion(ownerDb, {
      configurationId: published.id,
      organizationId,
      created_by_user_id: authorId,
      publishedAt: new Date(),
      publishedByUserId: authorId,
    });
    const publishedV2 = await addConfigurationVersion(ownerDb, {
      configurationId: published.id,
      organizationId,
      version_number: 2,
      created_by_user_id: authorId,
    });
    const draftSelection = await addConfigurationVersionSelection(ownerDb, {
      organizationId,
      configurationId: draft.id,
      versionId: draftV1.id,
      userId: authorId,
    });
    const publishedSelection = await addConfigurationVersionSelection(ownerDb, {
      organizationId,
      configurationId: published.id,
      versionId: publishedV2.id,
      userId: authorId,
    });
    const orphanDraft = await addConfiguration(ownerDb, { organizationId, name: "Departed's draft" });
    const orphanDraftV1 = await addConfigurationVersion(ownerDb, { configurationId: orphanDraft.id, organizationId });
    const orphanPublished = await addConfiguration(ownerDb, { organizationId, name: "Departed's published" });
    const orphanPublishedV1 = await addConfigurationVersion(ownerDb, {
      configurationId: orphanPublished.id,
      organizationId,
      publishedAt: new Date(),
    });
    const draftRun = await addTestRun(ownerDb, {
      organizationId,
      configurationId: draft.id,
      configurationVersionId: draftV1.id,
      queuedByUserId: authorId,
    });
    const publishedRun = await addTestRun(ownerDb, {
      organizationId,
      configurationId: published.id,
      configurationVersionId: publishedV2.id,
      queuedByUserId: authorId,
    });
    const authorFile = await addTestInputFile(ownerDb, { organizationId, ownerUserId: authorId });
    return {
      organizationId,
      authorId,
      teammateId,
      adminId,
      draft,
      draftV1,
      published,
      publishedV1,
      publishedV2,
      draftSelection,
      publishedSelection,
      orphanDraft,
      orphanDraftV1,
      orphanPublished,
      orphanPublishedV1,
      draftRun,
      publishedRun,
      authorFile,
    };
  };
  type Seeded = Awaited<ReturnType<typeof seed>>;

  /** Runs `work` as `userId` in the organization's database context, as a request would. */
  const as = <Result>(seeded: Seeded, userId: string, work: (transaction: Transaction<Database>) => Promise<Result>) =>
    withDatabaseContext(db, { userId, organizationId: seeded.organizationId }, work);

  const sorted = (ids: string[]) => [...ids].sort();

  describe("through the repositories", () => {
    /** What `userId` can reach: the list, and each configuration's versions. */
    const reachable = (seeded: Seeded, userId: string) =>
      as(seeded, userId, async (transaction) => {
        const viewer = { organizationId: seeded.organizationId, userId };
        const configurations = createConfigurationRepository(transaction, viewer);
        const versions = createConfigurationVersionRepository(transaction, viewer);
        const listed = (await configurations.listPage({ limit: 100 })).items.map((item) => item.id);
        const versionIds: string[] = [];
        for (const id of [seeded.draft.id, seeded.published.id, seeded.orphanDraft.id, seeded.orphanPublished.id]) {
          versionIds.push(...(await versions.listSummaries(id)).map((summary) => summary.id));
        }
        return { listed: sorted(listed), versionIds: sorted(versionIds) };
      });

    it("shows the author their draft, their published configuration with both its versions, and the departed author's published one", async () => {
      const seeded = await seed();
      expect(await reachable(seeded, seeded.authorId)).toEqual({
        listed: sorted([seeded.draft.id, seeded.published.id, seeded.orphanPublished.id]),
        versionIds: sorted([
          seeded.draftV1.id,
          seeded.publishedV1.id,
          seeded.publishedV2.id,
          seeded.orphanPublishedV1.id,
        ]),
      });
    });

    it.each(["teammate", "admin"] as const)(
      "shows the %s every published configuration and every version of it, the draft v2 included, and none of the author's draft",
      async (who) => {
        const seeded = await seed();
        const viewerId = who === "teammate" ? seeded.teammateId : seeded.adminId;
        expect(await reachable(seeded, viewerId)).toEqual({
          listed: sorted([seeded.published.id, seeded.orphanPublished.id]),
          versionIds: sorted([seeded.publishedV1.id, seeded.publishedV2.id, seeded.orphanPublishedV1.id]),
        });
      },
    );

    it("finds another member's draft nowhere: not by id, not its versions, not anyone's selection of it, and writes nothing to it", async () => {
      const seeded = await seed();
      for (const viewerId of [seeded.teammateId, seeded.adminId]) {
        await as(seeded, viewerId, async (transaction) => {
          const viewer = { organizationId: seeded.organizationId, userId: viewerId };
          const configurations = createConfigurationRepository(transaction, viewer);
          const versions = createConfigurationVersionRepository(transaction, viewer);
          const selections = createConfigurationVersionSelectionRepository(transaction, viewer);
          expect(await configurations.find(seeded.draft.id)).toBeUndefined();
          expect(await configurations.lockForUpdate(seeded.draft.id)).toBeUndefined();
          expect(await configurations.update(seeded.draft.id, { name: "Taken" }, new Date())).toBeUndefined();
          expect(await configurations.markDeleted(seeded.draft.id, new Date())).toBe(false);
          expect(await versions.findOpened(seeded.draft.id)).toBeUndefined();
          expect(await versions.find(seeded.draft.id, seeded.draftV1.id)).toBeUndefined();
          expect(
            await versions.save(
              seeded.draft.id,
              seeded.draftV1.id,
              { yamlContent: "taken", nodes: [], edges: [], pipelines: [] },
              new Date(),
            ),
          ).toBeUndefined();
          expect(await selections.find(viewerId, seeded.draft.id)).toBeUndefined();
          expect(await selections.record(viewerId, seeded.draft.id, seeded.draftV1.id, new Date())).toBe(false);
        });
      }
      const draftNow = await ownerDb
        .selectFrom("configurations")
        .selectAll()
        .where("id", "=", seeded.draft.id)
        .execute();
      expect(draftNow).toEqual([seeded.draft]);
      const draftVersionNow = await ownerDb
        .selectFrom("configuration_versions")
        .selectAll()
        .where("id", "=", seeded.draftV1.id)
        .execute();
      expect(draftVersionNow).toEqual([seeded.draftV1]);
    });

    it("shows a never-published configuration whose author is gone to no one, admins included", async () => {
      const seeded = await seed();
      for (const viewerId of [seeded.authorId, seeded.teammateId, seeded.adminId]) {
        const found = await as(seeded, viewerId, (transaction) =>
          createConfigurationRepository(transaction, { organizationId: seeded.organizationId, userId: viewerId }).find(
            seeded.orphanDraft.id,
          ),
        );
        expect(found).toBeUndefined();
      }
    });
  });

  describe("through the repositories alone, past row-level security (as the tables' owner)", () => {
    /*
     * The owner is exempt from row-level security (the tables aren't FORCEd),
     * so only the repositories' own filter stands between a viewer and another
     * member's draft here: the policies can't hide a lost filter.
     */
    const reachableAsOwner = (seeded: Seeded, userId: string) =>
      // The context still set, as for a request: "published" is the
      // policies' helper, which answers for the context's organization only.
      withDatabaseContext(ownerDb, { userId, organizationId: seeded.organizationId }, async (transaction) => {
        const viewer = { organizationId: seeded.organizationId, userId };
        const configurations = createConfigurationRepository(transaction, viewer);
        const versions = createConfigurationVersionRepository(transaction, viewer);
        const selections = createConfigurationVersionSelectionRepository(transaction, viewer);
        return {
          listed: sorted((await configurations.listPage({ limit: 100 })).items.map((item) => item.id)),
          found: await configurations.find(seeded.draft.id),
          locked: await configurations.lockForUpdate(seeded.draft.id),
          versions: await versions.listSummaries(seeded.draft.id),
          opened: await versions.findOpened(seeded.draft.id),
          selected: await selections.find(seeded.authorId, seeded.draft.id),
        };
      });

    it.each(["teammate", "admin"] as const)(
      "shows the %s none of the author's draft, nor the departed author's, by the repositories' filter alone",
      async (who) => {
        const seeded = await seed();
        const viewerId = who === "teammate" ? seeded.teammateId : seeded.adminId;
        expect(await reachableAsOwner(seeded, viewerId)).toEqual({
          listed: sorted([seeded.published.id, seeded.orphanPublished.id]),
          found: undefined,
          locked: undefined,
          versions: [],
          opened: undefined,
          // The author's selection, read for the author, of a configuration
          // the author can see: the selection repository's viewer is its person.
          selected: seeded.draftV1.id,
        });
      },
    );

    it("shows the author their draft, by the same filter", async () => {
      const seeded = await seed();
      const reached = await reachableAsOwner(seeded, seeded.authorId);
      expect(reached.listed).toEqual(sorted([seeded.draft.id, seeded.published.id, seeded.orphanPublished.id]));
      expect(reached.found).toMatchObject({ id: seeded.draft.id, published: false });
      expect(reached.versions.map((version) => version.id)).toEqual([seeded.draftV1.id]);
    });
  });

  describe("in raw SQL as the application role", () => {
    const idsOf = (rows: Array<{ id: string }>) => sorted(rows.map((row) => row.id));

    /** Every row of the three tables `userId` can select, with no filter of our own. */
    const selectable = (seeded: Seeded, userId: string) =>
      as(seeded, userId, async (transaction) => ({
        configurations: idsOf((await sql<{ id: string }>`select id from configurations`.execute(transaction)).rows),
        versions: idsOf((await sql<{ id: string }>`select id from configuration_versions`.execute(transaction)).rows),
        selections: idsOf(
          (await sql<{ id: string }>`select id from configuration_version_selections`.execute(transaction)).rows,
        ),
      }));

    it("lets the author select their draft, its version and its selection", async () => {
      const seeded = await seed();
      expect(await selectable(seeded, seeded.authorId)).toEqual({
        configurations: sorted([seeded.draft.id, seeded.published.id, seeded.orphanPublished.id]),
        versions: sorted([
          seeded.draftV1.id,
          seeded.publishedV1.id,
          seeded.publishedV2.id,
          seeded.orphanPublishedV1.id,
        ]),
        selections: sorted([seeded.draftSelection.id, seeded.publishedSelection.id]),
      });
    });

    it.each(["teammate", "admin"] as const)(
      "lets the %s select every published configuration and all its versions, and nothing of the author's draft or the departed author's draft",
      async (who) => {
        const seeded = await seed();
        const viewerId = who === "teammate" ? seeded.teammateId : seeded.adminId;
        expect(await selectable(seeded, viewerId)).toEqual({
          configurations: sorted([seeded.published.id, seeded.orphanPublished.id]),
          versions: sorted([seeded.publishedV1.id, seeded.publishedV2.id, seeded.orphanPublishedV1.id]),
          // The author's selection of the published configuration: the
          // policies keep selections to visible configurations, not to
          // their person (the repository does that).
          selections: [seeded.publishedSelection.id],
        });
      },
    );

    it("lets no member select a never-published configuration whose author is gone, nor its version, admins included", async () => {
      const seeded = await seed();
      for (const viewerId of [seeded.authorId, seeded.teammateId, seeded.adminId]) {
        const reached = await selectable(seeded, viewerId);
        expect(reached.configurations).not.toContain(seeded.orphanDraft.id);
        expect(reached.versions).not.toContain(seeded.orphanDraftV1.id);
      }
    });

    it("updates and deletes none of another member's draft's rows", async () => {
      const seeded = await seed();
      const results = await as(seeded, seeded.teammateId, async (transaction) => ({
        renamed: await sql`update configurations set name = 'Taken' where id = ${seeded.draft.id}`.execute(transaction),
        saved: await sql`update configuration_versions set yaml_content = 'taken'
                          where configuration_id = ${seeded.draft.id}`.execute(transaction),
        deleted: await sql`delete from configuration_versions
                            where configuration_id = ${seeded.draft.id}`.execute(transaction),
      }));
      expect(results.renamed.numAffectedRows).toBe(0n);
      expect(results.saved.numAffectedRows).toBe(0n);
      expect(results.deleted.numAffectedRows).toBe(0n);
      expect(
        await ownerDb.selectFrom("configuration_versions").selectAll().where("id", "=", seeded.draftV1.id).execute(),
      ).toEqual([seeded.draftV1]);
    });

    it("can't insert a version into another member's draft: 42501", async () => {
      const seeded = await seed();
      const at = new Date();
      await expect(
        as(seeded, seeded.teammateId, (transaction) =>
          transaction
            .insertInto("configuration_versions")
            .values({
              configuration_id: seeded.draft.id,
              organization_id: seeded.organizationId,
              version_number: 2,
              yaml_content: "slipped in",
              created_by_user_id: seeded.teammateId,
              ...pin,
              created_at: at,
              updated_at: at,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const versionsOfDraft = await ownerDb
        .selectFrom("configuration_versions")
        .select("id")
        .where("configuration_id", "=", seeded.draft.id)
        .execute();
      expect(versionsOfDraft).toEqual([{ id: seeded.draftV1.id }]);
    });

    it("can insert a version into a published configuration, and select it", async () => {
      const seeded = await seed();
      const at = new Date();
      const inserted = await as(seeded, seeded.teammateId, (transaction) =>
        transaction
          .insertInto("configuration_versions")
          .values({
            configuration_id: seeded.published.id,
            organization_id: seeded.organizationId,
            version_number: 3,
            yaml_content: "",
            created_by_user_id: seeded.teammateId,
            ...pin,
            created_at: at,
            updated_at: at,
          })
          .returning("version_number")
          .execute(),
      );
      expect(inserted).toEqual([{ version_number: 3 }]);
    });
  });

  describe("test runs and test files, in raw SQL as the application role", () => {
    const idsOf = (rows: Array<{ id: string }>) => sorted(rows.map((row) => row.id));

    /** Every test run and test file `userId` can select, with no filter of our own. */
    const selectable = (seeded: Seeded, userId: string) =>
      as(seeded, userId, async (transaction) => ({
        runs: idsOf((await sql<{ id: string }>`select id from test_runs`.execute(transaction)).rows),
        files: idsOf((await sql<{ id: string }>`select id from test_input_files`.execute(transaction)).rows),
      }));

    /** Queues a run as `userId` through the API's role, at now(), as a request would. */
    const queueAs = (seeded: Seeded, userId: string, configurationId: string, versionId: string) =>
      as(seeded, userId, (transaction) =>
        transaction
          .insertInto("test_runs")
          .values({
            organization_id: seeded.organizationId,
            configuration_id: configurationId,
            configuration_version_id: versionId,
            queued_by_user_id: userId,
            yaml: "receivers: {}\n",
            target_pipeline: "logs",
            signal: "logs",
            duration_seconds: 5,
            ...pin,
            input_name: "input.json",
            input_size_bytes: 0,
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
      );

    it("lets the author select their draft's run, the published configuration's, and their own test file", async () => {
      const seeded = await seed();
      expect(await selectable(seeded, seeded.authorId)).toEqual({
        runs: sorted([seeded.draftRun.id, seeded.publishedRun.id]),
        files: [seeded.authorFile.id],
      });
    });

    it.each(["teammate", "admin"] as const)(
      "lets the %s select the published configuration's run, and none of the author's draft's runs or test files",
      async (who) => {
        const seeded = await seed();
        const viewerId = who === "teammate" ? seeded.teammateId : seeded.adminId;
        expect(await selectable(seeded, viewerId)).toEqual({ runs: [seeded.publishedRun.id], files: [] });
      },
    );

    it("can't queue a run on another member's draft: 42501", async () => {
      const seeded = await seed();
      await expect(
        queueAs(seeded, seeded.teammateId, seeded.draft.id, seeded.draftV1.id),
      ).rejects.toMatchObject({ code: "42501" });
      const runsOfDraft = await ownerDb
        .selectFrom("test_runs")
        .select("id")
        .where("configuration_id", "=", seeded.draft.id)
        .execute();
      expect(runsOfDraft).toEqual([{ id: seeded.draftRun.id }]);
    });

    it("shows every member the draft's runs, past and future, once the configuration is published, and lets them queue their own", async () => {
      const seeded = await seed();
      await ownerDb
        .updateTable("configuration_versions")
        .set({ published_at: new Date(), publication_id: randomUUID(), published_by_user_id: seeded.authorId })
        .where("id", "=", seeded.draftV1.id)
        .execute();
      const future = await queueAs(seeded, seeded.authorId, seeded.draft.id, seeded.draftV1.id);
      const teammates = await queueAs(seeded, seeded.teammateId, seeded.draft.id, seeded.draftV1.id);
      for (const viewerId of [seeded.authorId, seeded.teammateId, seeded.adminId]) {
        expect((await selectable(seeded, viewerId)).runs).toEqual(
          sorted([seeded.draftRun.id, future.id, teammates.id, seeded.publishedRun.id]),
        );
      }
      // Test files stay their owner's, published or not.
      expect((await selectable(seeded, seeded.teammateId)).files).toEqual([]);
    });
  });

  describe("test suites, definitions and inputs, in raw SQL as the application role", () => {
    const idsOf = (rows: Array<{ id: string }>) => sorted(rows.map((row) => row.id));

    /** Every suite, definition and input `userId` can select, with no filter of our own. */
    const selectable = (seeded: Seeded, userId: string) =>
      as(seeded, userId, async (transaction) => ({
        suites: idsOf((await sql<{ id: string }>`select id from test_suites`.execute(transaction)).rows),
        definitions: idsOf((await sql<{ id: string }>`select id from test_definitions`.execute(transaction)).rows),
        inputs: idsOf((await sql<{ id: string }>`select id from test_definition_inputs`.execute(transaction)).rows),
      }));

    /**
     * The author's suite with a definition and its input on the draft's v1,
     * and on the published configuration's draft v2 (a suite belongs to any
     * version), as the owner.
     */
    const seedSuites = async (seeded: Seeded) => {
      const on = async (configurationId: string, versionId: string) => {
        const suite = await addTestSuite(ownerDb, {
          organizationId: seeded.organizationId,
          configurationId,
          configurationVersionId: versionId,
          name: "Smoke tests",
          created_by_user_id: seeded.authorId,
        });
        const input = await addTestDefinitionInput(ownerDb, {
          organizationId: seeded.organizationId,
          configurationId,
          file_name: "app-logs.json",
        });
        const definition = await addTestDefinition(ownerDb, {
          organizationId: seeded.organizationId,
          configurationId,
          configurationVersionId: versionId,
          testSuiteId: suite.id,
          inputId: input.id,
          name: "Logs only",
          created_by_user_id: seeded.authorId,
        });
        return { suite, input, definition };
      };
      return {
        draft: await on(seeded.draft.id, seeded.draftV1.id),
        published: await on(seeded.published.id, seeded.publishedV2.id),
      };
    };
    type Trees = Awaited<ReturnType<typeof seedSuites>>;
    const idsIn = (...trees: Array<Trees["draft"]>) => ({
      suites: sorted(trees.map((tree) => tree.suite.id)),
      definitions: sorted(trees.map((tree) => tree.definition.id)),
      inputs: sorted(trees.map((tree) => tree.input.id)),
    });

    /** A suite on `versionId`, inserted as `userId` through the API's role, as a request would. */
    const addSuiteAs = (seeded: Seeded, userId: string, configurationId: string, versionId: string) => {
      const at = new Date();
      return as(seeded, userId, (transaction) =>
        transaction
          .insertInto("test_suites")
          .values({
            organization_id: seeded.organizationId,
            configuration_id: configurationId,
            configuration_version_id: versionId,
            name: "Teammate's suite",
            created_by_user_id: userId,
            created_at: at,
            updated_at: at,
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
      );
    };

    it("lets the author select their draft's suites, definitions and inputs, and the published configuration's", async () => {
      const seeded = await seed();
      const trees = await seedSuites(seeded);
      expect(await selectable(seeded, seeded.authorId)).toEqual(idsIn(trees.draft, trees.published));
    });

    it.each(["teammate", "admin"] as const)(
      "lets the %s select the published configuration's suites, definitions and inputs, and none of the author's draft's",
      async (who) => {
        const seeded = await seed();
        const trees = await seedSuites(seeded);
        const viewerId = who === "teammate" ? seeded.teammateId : seeded.adminId;
        expect(await selectable(seeded, viewerId)).toEqual(idsIn(trees.published));
      },
    );

    it("can't add a suite to another member's draft (42501), nor rename or delete its suites, definitions or inputs", async () => {
      const seeded = await seed();
      const trees = await seedSuites(seeded);
      await expect(
        addSuiteAs(seeded, seeded.teammateId, seeded.draft.id, seeded.draftV1.id),
      ).rejects.toMatchObject({ code: "42501" });
      const results = await as(seeded, seeded.teammateId, async (transaction) => ({
        renamed: await sql`update test_suites set name = 'Taken' where id = ${trees.draft.suite.id}`.execute(transaction),
        definitions: await sql`delete from test_definitions where id = ${trees.draft.definition.id}`.execute(transaction),
        inputs: await sql`delete from test_definition_inputs where id = ${trees.draft.input.id}`.execute(transaction),
        suites: await sql`delete from test_suites where id = ${trees.draft.suite.id}`.execute(transaction),
      }));
      for (const result of Object.values(results)) expect(result.numAffectedRows).toBe(0n);
      expect(
        await ownerDb.selectFrom("test_suites").selectAll().where("configuration_id", "=", seeded.draft.id).execute(),
      ).toEqual([trees.draft.suite]);
    });

    /*
     * A statement with no WHERE clause and no RETURNING reads no column, so
     * Postgres applies only its command's policy, not the select policy: the
     * probes above, by id, would pass with the update and delete policies
     * cut to the organization. These reach the author's draft through the
     * update and delete policies alone.
     */
    it("updates and deletes none of the author's draft's suites, definitions or inputs by a bare statement with no WHERE clause, the teammate seeing no other row", async () => {
      const seeded = await seed();
      const trees = await seedSuites(seeded);
      // Only the draft's rows remain, so whatever a bare statement touches is the author's draft.
      await ownerDb.deleteFrom("test_suites").where("configuration_id", "=", seeded.published.id).execute();
      await ownerDb.deleteFrom("test_definition_inputs").where("configuration_id", "=", seeded.published.id).execute();
      for (const [label, statement] of [
        ["update test_suites", sql`update test_suites set name = 'Taken'`],
        ["delete from test_definitions", sql`delete from test_definitions`],
        ["delete from test_definition_inputs", sql`delete from test_definition_inputs`],
        ["delete from test_suites", sql`delete from test_suites`],
      ] as const) {
        // Each in its own transaction, checked before its commit, so one statement's rows can't hide another's.
        await as(seeded, seeded.teammateId, async (transaction) => {
          expect((await statement.execute(transaction)).numAffectedRows, label).toBe(0n);
        });
      }
      expect(await selectable(seeded, seeded.authorId)).toEqual(idsIn(trees.draft));
      expect(
        await ownerDb.selectFrom("test_suites").selectAll().where("id", "=", trees.draft.suite.id).execute(),
      ).toEqual([trees.draft.suite]);
    });

    it("shows every member the draft's suites, definitions and inputs once the configuration is published, and lets them add and rename suites", async () => {
      const seeded = await seed();
      const trees = await seedSuites(seeded);
      await ownerDb
        .updateTable("configuration_versions")
        .set({ published_at: new Date(), publication_id: randomUUID(), published_by_user_id: seeded.authorId })
        .where("id", "=", seeded.draftV1.id)
        .execute();
      for (const viewerId of [seeded.authorId, seeded.teammateId, seeded.adminId]) {
        expect(await selectable(seeded, viewerId)).toEqual(idsIn(trees.draft, trees.published));
      }
      const teammates = await addSuiteAs(seeded, seeded.teammateId, seeded.draft.id, seeded.draftV1.id);
      const renamed = await as(seeded, seeded.teammateId, (transaction) =>
        sql`update test_suites set name = 'Renamed by the teammate', updated_at = now()
             where id = ${trees.draft.suite.id}`.execute(transaction),
      );
      expect(renamed.numAffectedRows).toBe(1n);
      expect((await selectable(seeded, seeded.authorId)).suites).toEqual(
        sorted([trees.draft.suite.id, trees.published.suite.id, teammates.id]),
      );
    });
  });

  describe("validation pipelines and rules, in raw SQL as the application role", () => {
    const idsOf = (rows: Array<{ id: string }>) => sorted(rows.map((row) => row.id));

    /** Every validation pipeline and rule `userId` can select, with no filter of our own. */
    const selectable = (seeded: Seeded, userId: string) =>
      as(seeded, userId, async (transaction) => ({
        pipelines: idsOf((await sql<{ id: string }>`select id from validation_pipelines`.execute(transaction)).rows),
        rules: idsOf((await sql<{ id: string }>`select id from validation_rules`.execute(transaction)).rows),
      }));

    /**
     * The author's validation pipeline with a rule on the draft's v1, and on
     * the published configuration's draft v2 (a validation pipeline belongs
     * to any version), as the owner.
     */
    const seedValidation = async (seeded: Seeded) => {
      const on = async (configurationId: string, versionId: string) => {
        const pipeline = await addValidationPipeline(ownerDb, {
          organizationId: seeded.organizationId,
          configurationId,
          configurationVersionId: versionId,
          pipeline_name: "logs/default",
          created_by_user_id: seeded.authorId,
        });
        const rule = await addValidationRule(ownerDb, {
          organizationId: seeded.organizationId,
          configurationId,
          configurationVersionId: versionId,
          validationPipelineId: pipeline.id,
          kind: "not_contains_regex",
          pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
          name: "No SSNs",
          created_by_user_id: seeded.authorId,
        });
        return { pipeline, rule };
      };
      return {
        draft: await on(seeded.draft.id, seeded.draftV1.id),
        published: await on(seeded.published.id, seeded.publishedV2.id),
      };
    };
    type Trees = Awaited<ReturnType<typeof seedValidation>>;
    const idsIn = (...trees: Array<Trees["draft"]>) => ({
      pipelines: sorted(trees.map((tree) => tree.pipeline.id)),
      rules: sorted(trees.map((tree) => tree.rule.id)),
    });

    /**
     * A rule in `pipeline` at `position`, inserted as `userId` through the
     * API's role, naming the pipeline's own ids. No RETURNING: with one, the
     * select policy would also judge the new row, and could refuse a forged
     * insert the insert policy let through.
     */
    const addRuleAs = (
      seeded: Seeded,
      userId: string,
      pipeline: Trees["draft"]["pipeline"],
      position: number,
    ) => {
      const at = new Date();
      return as(seeded, userId, (transaction) =>
        transaction
          .insertInto("validation_rules")
          .values({
            organization_id: pipeline.organization_id,
            configuration_id: pipeline.configuration_id,
            configuration_version_id: pipeline.configuration_version_id,
            validation_pipeline_id: pipeline.id,
            position,
            kind: "contains_text",
            target: "output",
            pattern: "teammate's",
            created_by_user_id: userId,
            created_at: at,
            updated_at: at,
          })
          .execute(),
      );
    };

    it("lets the author select their draft's validation pipelines and rules, and the published configuration's", async () => {
      const seeded = await seed();
      const trees = await seedValidation(seeded);
      expect(await selectable(seeded, seeded.authorId)).toEqual(idsIn(trees.draft, trees.published));
    });

    it.each(["teammate", "admin"] as const)(
      "lets the %s select the published configuration's validation pipelines and rules, and none of the author's draft's",
      async (who) => {
        const seeded = await seed();
        const trees = await seedValidation(seeded);
        const viewerId = who === "teammate" ? seeded.teammateId : seeded.adminId;
        expect(await selectable(seeded, viewerId)).toEqual(idsIn(trees.published));
      },
    );

    it("can't add a validation pipeline or a rule to another member's draft (42501), nor change or delete its rows, by id or by a bare statement", async () => {
      const seeded = await seed();
      const trees = await seedValidation(seeded);
      const at = new Date();
      await expect(
        as(seeded, seeded.teammateId, (transaction) =>
          transaction
            .insertInto("validation_pipelines")
            .values({
              organization_id: seeded.organizationId,
              configuration_id: seeded.draft.id,
              configuration_version_id: seeded.draftV1.id,
              pipeline_name: "logs/teammate",
              signal: "logs",
              created_by_user_id: seeded.teammateId,
              created_at: at,
            })
            .execute(),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(addRuleAs(seeded, seeded.teammateId, trees.draft.pipeline, 2)).rejects.toMatchObject({ code: "42501" });
      const byId = await as(seeded, seeded.teammateId, async (transaction) => ({
        renamed: await sql`update validation_rules set name = 'Taken' where id = ${trees.draft.rule.id}`.execute(transaction),
        rules: await sql`delete from validation_rules where id = ${trees.draft.rule.id}`.execute(transaction),
        pipelines: await sql`delete from validation_pipelines where id = ${trees.draft.pipeline.id}`.execute(transaction),
      }));
      for (const result of Object.values(byId)) expect(result.numAffectedRows).toBe(0n);
      // Only the draft's rows remain, so whatever a bare statement touches is the author's draft.
      await ownerDb.deleteFrom("validation_pipelines").where("configuration_id", "=", seeded.published.id).execute();
      for (const [label, statement] of [
        ["update validation_rules", sql`update validation_rules set name = 'Taken'`],
        ["delete from validation_rules", sql`delete from validation_rules`],
        ["delete from validation_pipelines", sql`delete from validation_pipelines`],
      ] as const) {
        await as(seeded, seeded.teammateId, async (transaction) => {
          expect((await statement.execute(transaction)).numAffectedRows, label).toBe(0n);
        });
      }
      expect(await ownerDb.selectFrom("validation_rules").selectAll().execute()).toEqual([trees.draft.rule]);
      expect(await ownerDb.selectFrom("validation_pipelines").selectAll().execute()).toEqual([trees.draft.pipeline]);
    });

    it("shows every member the draft's validation pipelines and rules once the configuration is published, and lets them add and change rules", async () => {
      const seeded = await seed();
      const trees = await seedValidation(seeded);
      await ownerDb
        .updateTable("configuration_versions")
        .set({ published_at: new Date(), publication_id: randomUUID(), published_by_user_id: seeded.authorId })
        .where("id", "=", seeded.draftV1.id)
        .execute();
      for (const viewerId of [seeded.authorId, seeded.teammateId, seeded.adminId]) {
        expect(await selectable(seeded, viewerId)).toEqual(idsIn(trees.draft, trees.published));
      }
      await addRuleAs(seeded, seeded.teammateId, trees.draft.pipeline, 2);
      const teammates = await ownerDb
        .selectFrom("validation_rules")
        .select("id")
        .where("created_by_user_id", "=", seeded.teammateId)
        .executeTakeFirstOrThrow();
      const changed = await as(seeded, seeded.teammateId, (transaction) =>
        sql`update validation_rules set name = 'Changed by the teammate', updated_at = now()
             where id = ${trees.draft.rule.id}`.execute(transaction),
      );
      expect(changed.numAffectedRows).toBe(1n);
      expect((await selectable(seeded, seeded.authorId)).rules).toEqual(
        sorted([trees.draft.rule.id, trees.published.rule.id, teammates.id]),
      );
    });
  });
});
