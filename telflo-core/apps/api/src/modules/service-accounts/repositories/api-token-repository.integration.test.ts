import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@telflo/db";
import {
  addApiToken,
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withDatabaseContext } from "../../../database/context.js";
import { createApiTokenRepository, type IApiTokenRepository } from "./api-token-repository.js";

/*
 * The API token repository's reads, against the test database as the API's
 * role, through the organization scope and row-level security: no read hands
 * back a token's hash, and /whoami's name read never names a revoked token.
 * Tokens are built at run time by addApiToken and never printed: a row that
 * holds a hash or a prefix is compared by booleans and its keys only.
 */

const APPLICATION_NAME = "api-token-repository-test";

describe("the API token repository's reads", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;

  beforeAll(() => {
    databases = openTestDatabases({ applicationName: APPLICATION_NAME });
    ({ db, ownerDb } = databases);
  });
  afterAll(async () => {
    await databases.destroy();
  });
  beforeEach(async () => {
    await truncateAll(ownerDb);
  });

  /** An admin of a new group organization, and a service account in it. */
  const accountInGroup = async () => {
    const { user: admin } = await createUserWithOrganization(ownerDb);
    const { organization: group } = await addMembership(ownerDb, { userId: admin.id, role: "admin" });
    const { user: serviceAccount } = await addServiceAccount(ownerDb, {
      organizationId: group.id,
      createdAt: new Date(Date.now() - 120_000),
    });
    return { adminId: admin.id, organizationId: group.id, serviceAccountId: serviceAccount.id };
  };

  /** Runs `work` with the repository in `userId`'s context in the organization, as the routes and the check do. */
  const asUser = <Result>(
    userId: string,
    organizationId: string,
    work: (repository: IApiTokenRepository) => Promise<Result>,
  ): Promise<Result> =>
    withDatabaseContext(db, { userId, organizationId }, (transaction) =>
      work(createApiTokenRepository(transaction, { organizationId })),
    );

  it("list() hands back no token_hash: each item's keys are the listed fields exactly, and no item holds a hash", async () => {
    const { adminId, organizationId, serviceAccountId } = await accountInGroup();
    const added = [
      await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, created_at: new Date(Date.now() - 60_000) }),
      await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, created_at: new Date(Date.now() - 30_000) }),
    ];

    const items = await asUser(adminId, organizationId, (repository) => repository.list(serviceAccountId));

    // The canaries first: booleans, so a failure prints no hash or token.
    expect(items).toHaveLength(added.length);
    const serialized = JSON.stringify(items);
    expect(added.some(({ apiToken }) => serialized.includes(apiToken.token_hash))).toBe(false);
    expect(added.some(({ token }) => serialized.includes(token.slice(3)))).toBe(false);
    expect(items.some((item) => Object.hasOwn(item, "token_hash") || Object.hasOwn(item, "tokenHash"))).toBe(false);
    // Then the keys, which name fields only.
    expect(items.map((item) => Object.keys(item).sort())).toEqual(
      items.map(() => [
        "access",
        "createdAt",
        "expiresAt",
        "id",
        "lastUsedAt",
        "name",
        "organizationId",
        "prefix",
        "serviceAccountId",
      ]),
    );
  });

  it("findName names a live token, and a revoked one not at all (/whoami's read)", async () => {
    const { adminId, organizationId, serviceAccountId } = await accountInGroup();
    const createdAt = new Date(Date.now() - 60_000);
    const live = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: serviceAccountId, created_at: createdAt });
    const revoked = await addApiToken(ownerDb, {
      organizationId,
      serviceAccountUserId: serviceAccountId,
      created_at: createdAt,
      revoked_at: new Date(Date.now() - 30_000),
      revoked_by_user_id: adminId,
    });

    // In the token's own context, as /whoami reads it.
    const names = await asUser(serviceAccountId, organizationId, async (repository) => ({
      live: await repository.findName(live.apiToken.id),
      revoked: await repository.findName(revoked.apiToken.id),
    }));

    expect(names).toEqual({ live: live.apiToken.name, revoked: undefined });
  });
});
