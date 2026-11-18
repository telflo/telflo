import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "@telflo/db";
import { addConfiguration, addConfigurationVersion, addMembership, createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import { withDatabaseContext, withOrganizationContext } from "../../database/context.js";
import { createPublishedVersionRepository } from "../configurations/repositories/published-version-repository.js";
import { createCollectorCatalogueRepository } from "../collector-catalogue/repositories/collector-catalogue-repository.js";

/* D17c-2 Preflight ruling 9 (preflight A, item 4): the install's read with no person, as the public download makes it. */
describe("an install's read with no person (the public download)", () => {
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

  const seed = async () => {
    const person = await createUserWithOrganization(ownerDb);
    const group = await addMembership(ownerDb, { userId: person.user.id });
    const organizationId = group.organization.id;
    const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: person.user.id });
    const publicationId = randomUUID();
    await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      yaml_content: "receivers: {}\n",
      publishedAt: new Date(),
      publicationId,
      publishedByUserId: person.user.id,
    });
    const other = await createUserWithOrganization(ownerDb);
    const otherGroup = await addMembership(ownerDb, { userId: other.user.id });
    return { userId: person.user.id, organizationId, publicationId, otherOrganizationId: otherGroup.organization.id };
  };

  it("finds the group's published version and its catalogue state in the link's organization, with no viewer", async () => {
    const { organizationId, publicationId } = await seed();
    const read = await withOrganizationContext(db, organizationId, async (transaction) => {
      const version = await createPublishedVersionRepository(transaction, { organizationId, userId: null }).findForInstall(publicationId);
      const state = version && (await createCollectorCatalogueRepository(transaction).findVersionState(version.collectorDistribution, version.collectorVersion));
      return { version, state };
    });
    expect(read.version).toMatchObject({ yaml: "receivers: {}\n" });
    expect(read.state).toBe("offered");
  });

  it("finds nothing in another organization's context", async () => {
    const { otherOrganizationId, publicationId } = await seed();
    expect(
      await withOrganizationContext(db, otherOrganizationId, (transaction) =>
        createPublishedVersionRepository(transaction, { organizationId: otherOrganizationId, userId: null }).findForInstall(publicationId),
      ),
    ).toBeUndefined();
  });

  it("is why visibleTo can't take an empty viewer: '' isn't a uuid (22P02)", async () => {
    const { organizationId, publicationId } = await seed();
    await expect(
      withDatabaseContext(db, { userId: "", organizationId }, (transaction) =>
        createPublishedVersionRepository(transaction, { organizationId, userId: "" }).findForInstall(publicationId),
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });
});
