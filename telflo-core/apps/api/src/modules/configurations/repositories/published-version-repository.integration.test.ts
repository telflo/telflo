import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext, withOrganizationContext } from "../../../database/context.js";
import { createPublishedVersionRepository } from "./published-version-repository.js";

/*
 * D16b decision 5 and Preflight ruling 5 (Ruling 23): a published version
 * resolves, and is described, only from the organization's own versions.
 * Row-level security is the backstop behind the code's own organization
 * filter (the organization scope); these tests pin the filter itself, so
 * most run as the tables' owner, whom row-level security doesn't constrain.
 * The case that needs the filter: a person who belongs to two
 * organizations, whose own published version in one is asked for while
 * acting in the other.
 */
describe("published version repository", () => {
  /** The API's own role, which row-level security constrains. */
  let db: Kysely<Database>;
  /** The tables' owner: past row-level security. */
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

  /** A person in two group organizations, A and B, with a published version of their own configuration in B. */
  const personInTwoOrganizations = async () => {
    const person = await createUserWithOrganization(ownerDb);
    const a = (await addMembership(ownerDb, { userId: person.user.id })).organization;
    const b = (await addMembership(ownerDb, { userId: person.user.id })).organization;
    const configuration = await addConfiguration(ownerDb, {
      organizationId: b.id,
      created_by_user_id: person.user.id,
      name: "B's configuration",
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId: b.id,
      created_by_user_id: person.user.id,
      label: "B's label",
      yaml_content: "receivers: {}\n",
      publishedAt: new Date(),
      publishedByUserId: person.user.id,
    });
    return { userId: person.user.id, a: a.id, b: b.id, configuration, version, publicationId: version.publication_id as string };
  };

  /**
   * The repository bound to an owner's transaction in `context`'s database
   * context (which `configuration_is_published` reads), so only row-level
   * security is missing: the owner isn't constrained by it.
   */
  const asOwner = <Result>(
    context: { organizationId: string; userId: string },
    work: (repository: ReturnType<typeof createPublishedVersionRepository>) => Promise<Result>,
  ) => withDatabaseContext(ownerDb, context, (transaction) => work(createPublishedVersionRepository(transaction, context)));

  it("as the tables' owner: resolves and describes the person's own version in its organization, and nothing of it in their other one", async () => {
    const world = await personInTwoOrganizations();
    const inB = { organizationId: world.b, userId: world.userId };
    const inA = { organizationId: world.a, userId: world.userId };

    expect(await asOwner(inB, (repository) => repository.resolve(world.version.id))).toEqual({ publicationId: world.publicationId });
    const describedInB = await asOwner(inB, (repository) => repository.describe([world.publicationId.toUpperCase()]));
    expect(describedInB.get(world.publicationId)).toEqual({
      configurationId: world.configuration.id,
      configurationName: "B's configuration",
      versionId: world.version.id,
      versionNumber: world.version.version_number,
      versionLabel: "B's label",
      // D17c-1 decision 33: the collector the version is built for, from its own row.
      collectorDistribution: world.version.collector_distribution,
      collectorVersion: world.version.collector_version,
    });
    // A version pinned to a collector version other than the catalogue's default reads its own.
    const other = await ownerDb
      .selectFrom("collector_versions")
      .select("version")
      .where("distribution", "=", world.version.collector_distribution)
      .where("is_default", "=", false)
      .where("deprecated", "=", false)
      .executeTakeFirstOrThrow();
    const pinned = await addConfigurationVersion(ownerDb, {
      configurationId: world.configuration.id,
      organizationId: world.b,
      version_number: 2,
      collector_distribution: world.version.collector_distribution,
      collector_version: other.version,
      publishedAt: new Date(),
      publishedByUserId: world.userId,
    });
    const describedPinned = await asOwner(inB, (repository) => repository.describe([pinned.publication_id as string]));
    expect(describedPinned.get(pinned.publication_id as string)).toMatchObject({
      versionNumber: 2,
      collectorDistribution: world.version.collector_distribution,
      collectorVersion: other.version,
    });
    expect(other.version).not.toBe(world.version.collector_version);

    expect(await asOwner(inA, (repository) => repository.resolve(world.version.id))).toBeUndefined();
    expect((await asOwner(inA, (repository) => repository.describe([world.publicationId]))).size).toBe(0);
  });

  it("as the tables' owner: resolves and describes nothing of another member's draft or a deleted configuration", async () => {
    const world = await personInTwoOrganizations();
    const colleague = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: colleague.user.id, organizationId: world.b });
    const inB = { organizationId: world.b, userId: colleague.user.id };
    // The person's draft in B: theirs alone to see.
    const draft = await addConfiguration(ownerDb, { organizationId: world.b, created_by_user_id: world.userId });
    const draftVersion = await addConfigurationVersion(ownerDb, {
      configurationId: draft.id,
      organizationId: world.b,
      created_by_user_id: world.userId,
      yaml_content: "receivers: {}\n",
    });
    expect(await asOwner(inB, (repository) => repository.resolve(draftVersion.id))).toBeUndefined();
    // Their published version: everyone's in B.
    expect(await asOwner(inB, (repository) => repository.resolve(world.version.id))).toEqual({ publicationId: world.publicationId });

    await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", world.configuration.id).execute();
    expect(await asOwner(inB, (repository) => repository.resolve(world.version.id))).toBeUndefined();
    expect((await asOwner(inB, (repository) => repository.describe([world.publicationId]))).size).toBe(0);
  });

  it("with no viewer (D17c-2's public download, Preflight ruling 9): only a published configuration's version, never a draft's, even where row-level security would show the draft", async () => {
    const world = await personInTwoOrganizations();
    // The person's draft in B: with no viewer, only the filter itself (isPublished) keeps its version out of resolve.
    const draft = await addConfiguration(ownerDb, { organizationId: world.b, created_by_user_id: world.userId });
    const draftVersion = await addConfigurationVersion(ownerDb, {
      configurationId: draft.id,
      organizationId: world.b,
      created_by_user_id: world.userId,
      yaml_content: "receivers: {}\n",
    });
    const noViewer = { organizationId: world.b, userId: null };
    const runs = {
      // The tables' owner, past row-level security, in B's context with no person (as the public download opens it).
      "the tables' owner": <Result>(work: (repository: ReturnType<typeof createPublishedVersionRepository>) => Promise<Result>) =>
        withOrganizationContext(ownerDb, world.b, (transaction) => work(createPublishedVersionRepository(transaction, noViewer))),
      // The API's role in the draft's creator's own context, where row-level security shows the draft.
      "the API's role as the draft's creator": <Result>(work: (repository: ReturnType<typeof createPublishedVersionRepository>) => Promise<Result>) =>
        withDatabaseContext(db, { organizationId: world.b, userId: world.userId }, (transaction) => work(createPublishedVersionRepository(transaction, noViewer))),
    };
    for (const [who, run] of Object.entries(runs)) {
      expect({ who, published: await run((repository) => repository.resolve(world.version.id)) }).toEqual({ who, published: { publicationId: world.publicationId } });
      expect({ who, draft: await run((repository) => repository.resolve(draftVersion.id)) }).toEqual({ who, draft: undefined });
      expect({ who, described: [...(await run((repository) => repository.describe([world.publicationId]))).keys()] }).toEqual({ who, described: [world.publicationId] });
      expect({ who, install: await run((repository) => repository.findForInstall(world.publicationId)) }).toMatchObject({ who, install: { yaml: "receivers: {}\n" } });
    }
    // Row-level security alone would show the draft to its creator: the viewer's own read finds it.
    expect(
      await withDatabaseContext(db, { organizationId: world.b, userId: world.userId }, (transaction) =>
        createPublishedVersionRepository(transaction, { organizationId: world.b, userId: world.userId }).resolve(draftVersion.id),
      ),
    ).toEqual({ publicationId: null });
  });

  it("as the API's role, in the organization's database context: the same answers", async () => {
    const world = await personInTwoOrganizations();
    const run = <Result>(organizationId: string, work: (repository: ReturnType<typeof createPublishedVersionRepository>) => Promise<Result>) =>
      withDatabaseContext(db, { userId: world.userId, organizationId }, (transaction) =>
        work(createPublishedVersionRepository(transaction, { organizationId, userId: world.userId })),
      );
    expect(await run(world.b, (repository) => repository.resolve(world.version.id))).toEqual({ publicationId: world.publicationId });
    expect((await run(world.b, (repository) => repository.describe([world.publicationId]))).size).toBe(1);
    expect(await run(world.a, (repository) => repository.resolve(world.version.id))).toBeUndefined();
    expect((await run(world.a, (repository) => repository.describe([world.publicationId]))).size).toBe(0);
  });

  it("finds a published version for an install (D17c-1 Preflight ruling 8): its YAML and collector, under the same organization and visibility filter", async () => {
    const world = await personInTwoOrganizations();
    const colleague = await createUserWithOrganization(ownerDb);
    await addMembership(ownerDb, { userId: colleague.user.id, organizationId: world.b });
    const expected = {
      yaml: "receivers: {}\n",
      collectorDistribution: world.version.collector_distribution,
      collectorVersion: world.version.collector_version,
    };
    // The person's own, and a colleague's view of it (published: everyone's in B), by the id in any case.
    expect(await asOwner({ organizationId: world.b, userId: world.userId }, (repository) => repository.findForInstall(world.publicationId.toUpperCase()))).toEqual(expected);
    expect(await asOwner({ organizationId: world.b, userId: colleague.user.id }, (repository) => repository.findForInstall(world.publicationId))).toEqual(expected);
    // Their other organization: nothing.
    expect(await asOwner({ organizationId: world.a, userId: world.userId }, (repository) => repository.findForInstall(world.publicationId))).toBeUndefined();
    // As the API's role, alike.
    const run = (organizationId: string) =>
      withDatabaseContext(db, { userId: world.userId, organizationId }, (transaction) =>
        createPublishedVersionRepository(transaction, { organizationId, userId: world.userId }).findForInstall(world.publicationId),
      );
    expect(await run(world.b)).toEqual(expected);
    expect(await run(world.a)).toBeUndefined();
    // An unknown publication, and a deleted configuration's.
    expect(await asOwner({ organizationId: world.b, userId: world.userId }, (repository) => repository.findForInstall(world.version.id))).toBeUndefined();
    await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", world.configuration.id).execute();
    expect(await asOwner({ organizationId: world.b, userId: colleague.user.id }, (repository) => repository.findForInstall(world.publicationId))).toBeUndefined();
  });
});
