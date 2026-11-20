import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Insertable, Kysely, Transaction } from "kysely";
import { TEST_FILES_LIST_MAXIMUM } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import type { AuthContext } from "../database/context.js";
import { createCollectorCatalogueRepository } from "../modules/collector-catalogue/repositories/collector-catalogue-repository.js";
import { createConfigurationRepository } from "../modules/configurations/repositories/configuration-repository.js";
import { createConfigurationVersionRepository } from "../modules/configurations/repositories/configuration-version-repository.js";
import { createConfigurationVersionSelectionRepository } from "../modules/configurations/repositories/configuration-version-selection-repository.js";
import { createInvitationRepository } from "../modules/organizations/repositories/invitation-repository.js";
import { createMemberRepository } from "../modules/organizations/repositories/member-repository.js";
import { createActiveOrganizationRepository } from "../modules/organizations/repositories/organization-repository.js";
import { createQuickDeployLinkRepository } from "../modules/quick-deploy/repositories/quick-deploy-link-repository.js";
import { createApiTokenRepository } from "../modules/service-accounts/repositories/api-token-repository.js";
import { createServiceAccountRepository } from "../modules/service-accounts/repositories/service-account-repository.js";
import { createTestInputFileRepository } from "../modules/test-runs/repositories/test-input-file-repository.js";
import { createTestRunRepository } from "../modules/test-runs/repositories/test-run-repository.js";
import { createTestDefinitionInputRepository } from "../modules/test-suites/repositories/test-definition-input-repository.js";
import { createTestDefinitionRepository } from "../modules/test-suites/repositories/test-definition-repository.js";
import { createTestSuiteRepository } from "../modules/test-suites/repositories/test-suite-repository.js";
import { createValidationPipelineRepository } from "../modules/validation-pipelines/repositories/validation-pipeline-repository.js";
import { createValidationRuleRepository } from "../modules/validation-pipelines/repositories/validation-rule-repository.js";
import {
  createOrganizationScope,
  organizationScopingColumns,
  type OrganizationScopedTable,
  type ScopingColumn,
} from "./organization-scope.js";

/*
 * The resource registry: every application table, declared once as
 * `organization`, `global` or `system`. cross-tenant.integration.test.ts
 * generates organization B's attempts on organization A's rows from it,
 * so a new organization resource gets its isolation tests by being
 * registered, and fails the suite by not being.
 * docs/conventions/testing.md says how to register one.
 */

/**
 * Whom an entry's operations act for: the organization the repository is
 * scoped to, and the user in it. The configuration repositories show that
 * user's drafts and every published configuration; the others are scoped
 * by the organization alone.
 */
export type OrganizationResourceContext = Pick<AuthContext, "organizationId" | "userId">;

/** What organization B's context tries on organization A's row, through the resource's real repository. */
export interface OrganizationResourceOperations {
  /** The keys of every row the repository lists. */
  list(): Promise<string[]>;
  /** The row with this key, or undefined when the repository doesn't find it. */
  read(key: string): Promise<unknown>;
  /** Changes the row with this key in some visible way. */
  update(key: string): Promise<void>;
  /** Removes the row with this key, softly or not. */
  remove(key: string): Promise<void>;
}

/** The operations without those the entry declares unsupported. */
type OperationsWithout<Unsupported extends "update" | "remove"> = Omit<OrganizationResourceOperations, Unsupported>;

/** Builds an entry's operations over its repository bound to `transaction` and `context`. */
type OperationsFactory<Operations> = (transaction: Transaction<Database>, context: OrganizationResourceContext) => Operations;

/**
 * Whether the resource's repository changes and removes a row on its own.
 * Most do, and their operations have `update` and `remove`. One that
 * doesn't remove (a child table whose rows go with their parent's) says why
 * in `removeUnsupported` instead, and its operations have no `remove`; one
 * that doesn't change a row (a test run, which only the dispatcher's
 * functions change) says why in `updateUnsupported`, and its operations
 * have no `update`. The type requires one or the other of each. The reasons
 * are on the entry, not the operations, because the suite names the tests
 * after them when it collects the tests, before any operations exist.
 */
type OrganizationResourceCapabilities =
  | {
      updateUnsupported?: undefined;
      removeUnsupported?: undefined;
      /** The operations, over the resource's repository bound to `transaction` and `context`. */
      operations: OperationsFactory<OrganizationResourceOperations>;
    }
  | {
      updateUnsupported?: undefined;
      /** Why the repository has no remove; the suite's test for it is named with it. */
      removeUnsupported: string;
      /** The operations, with no `remove`. */
      operations: OperationsFactory<OperationsWithout<"remove">>;
    }
  | {
      /** Why the repository has no update; the suite's test for it is named with it. */
      updateUnsupported: string;
      removeUnsupported?: undefined;
      /** The operations, with no `update`. */
      operations: OperationsFactory<OperationsWithout<"update">>;
    }
  | {
      updateUnsupported: string;
      removeUnsupported: string;
      /** The operations, with neither `update` nor `remove`. */
      operations: OperationsFactory<OperationsWithout<"update" | "remove">>;
    };

type OrganizationResourceBase<Table extends OrganizationScopedTable> = OrganizationResourceCapabilities & {
  kind: "organization";
  table: Table;
  scopingColumn: ScopingColumn<Table>;
  /** The column the repository addresses a row by, as `seed` returns it and the operations take it. */
  keyColumn: keyof Database[Table] & string;
  /**
   * Inserts one row in the organization as the owner, with whatever it needs,
   * and returns its key. The organization is a live group organization with a
   * member of its own, `userId`, as whom the suite acts in A's context; anyone
   * else the row needs, the seed creates. The row is one that member can see:
   * a configuration's is published, since another member's draft is invisible
   * to them by design, and a test file is `userId`'s own.
   */
  seed(ownerDb: Kysely<Database>, organizationId: string, userId: string): Promise<string>;
};

/**
 * A table that belongs to one organization. With row-level security, it
 * also says what a raw insert naming an organization would write, so the
 * generated suite can try one from another organization's context. Without
 * a table named, it is the union of every scoped table's entry.
 */
export type OrganizationResource<Table extends OrganizationScopedTable = OrganizationScopedTable> =
  Table extends OrganizationScopedTable
    ?
        | (OrganizationResourceBase<Table> & { hasRowLevelSecurity: false })
        | (OrganizationResourceBase<Table> & {
            hasRowLevelSecurity: true;
            /**
             * A new row naming the organization, valid but for row-level
             * security. The owner may create what it references.
             */
            rowToInsert(ownerDb: Kysely<Database>, organizationId: string): Promise<Insertable<Database[Table]>>;
          })
    : never;

/** A table no organization owns. The reason is for the reviewer who asks why it isn't scoped. */
export interface GlobalResource {
  kind: "global";
  table: keyof Database;
  reason: string;
  /**
   * Set when the table has row-level security of another kind than an
   * organization's: a person's own rows, on the context's user
   * (personal_api_tokens). Absent: none.
   */
  hasRowLevelSecurity?: true;
}

/**
 * A table only the product's own administration reaches: no organization
 * owns it and it has no row-level security; the API's role holds no SELECT
 * on it, and reads it only through the product-admin functions, in the
 * product admin's database context, from the SystemRepository.
 */
export interface SystemResource {
  kind: "system";
  table: keyof Database;
  reason: string;
}

export type RegisteredResource = OrganizationResource | GlobalResource | SystemResource;

/** A user whose account the invariant accepts: their own personal organization and an admin membership of it. */
async function seedUserWithPersonalOrganization(ownerDb: Kysely<Database>): Promise<string> {
  return ownerDb.transaction().execute(async (transaction) => {
    const email = `resource-${randomUUID()}@example.com`;
    const user = await transaction
      .insertInto("users")
      .values({ email, email_verified_at: new Date() })
      .returning("id")
      .executeTakeFirstOrThrow();
    const organization = await transaction
      .insertInto("organizations")
      .values({ name: email, type: "personal", owner_user_id: user.id })
      .returning("id")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("organization_members")
      .values({ organization_id: organization.id, user_id: user.id, role: "admin" })
      .execute();
    return user.id;
  });
}

/** A member of `organizationId`, beside their own personal organization, as the owner. */
async function seedMember(ownerDb: Kysely<Database>, organizationId: string): Promise<string> {
  const userId = await seedUserWithPersonalOrganization(ownerDb);
  await ownerDb
    .insertInto("organization_members")
    .values({ organization_id: organizationId, user_id: userId, role: "contributor" })
    .execute();
  return userId;
}

const organizationMembers: OrganizationResource<"organization_members"> = {
  kind: "organization",
  table: "organization_members",
  scopingColumn: organizationScopingColumns.organization_members,
  hasRowLevelSecurity: true,
  keyColumn: "user_id",
  seed: seedMember,
  async rowToInsert(ownerDb, organizationId) {
    return { organization_id: organizationId, user_id: await seedUserWithPersonalOrganization(ownerDb), role: "admin" };
  },
  operations(transaction, context) {
    const members = createMemberRepository(transaction, context);
    return {
      list: async () => (await members.list()).map((member) => member.userId),
      read: (userId) => members.find(userId),
      update: async (userId) => {
        await members.changeRole(userId, "admin");
      },
      remove: async (userId) => {
        await members.remove(userId, new Date());
      },
    };
  },
};

/** A pending invitation's columns, to a fresh address with a fresh token, in `organizationId`. */
function pendingInvitation(organizationId: string): Insertable<Database["organization_invitations"]> {
  return {
    organization_id: organizationId,
    email: `resource-${randomUUID()}@example.com`,
    role: "contributor",
    token_hash: randomBytes(32).toString("hex"),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

/*
 * The operations reach only pending invitations, since those are what the
 * repository lists, reads and changes: `update` resends (a new token and
 * expiry) and `remove` cancels.
 */
const organizationInvitations: OrganizationResource<"organization_invitations"> = {
  kind: "organization",
  table: "organization_invitations",
  scopingColumn: organizationScopingColumns.organization_invitations,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    const row = await ownerDb
      .insertInto("organization_invitations")
      .values(pendingInvitation(organizationId))
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async rowToInsert(_ownerDb, organizationId) {
    return pendingInvitation(organizationId);
  },
  operations(transaction, context) {
    const invitations = createInvitationRepository(transaction, context);
    return {
      list: async () => (await invitations.listPending()).map((invitation) => invitation.id),
      read: (id) => invitations.findPending(id),
      update: async (id) => {
        await invitations.reissue(id, randomBytes(32).toString("hex"), new Date(Date.now() + 60 * 60 * 1000), new Date());
      },
      remove: async (id) => {
        await invitations.revoke(id, new Date());
      },
    };
  },
};

/**
 * The fleet every seeded link is made in: the repository reaches a fleet's
 * links only (it has no organization-wide list), and the fleet lives in the
 * opamp-server, so any id serves.
 */
const REGISTRY_FLEET_ID = "0192a6b0-0000-7000-8000-00000000f1ee";

/** A link's columns, active for a day, with a fresh hash and fresh opamp-server ids, in `organizationId`'s registry fleet. */
function activeQuickDeployLink(organizationId: string): Insertable<Database["quick_deploy_links"]> {
  const now = new Date();
  return {
    organization_id: organizationId,
    fleet_id: REGISTRY_FLEET_ID,
    group_id: randomUUID(),
    default_token_id: randomUUID(),
    secret_hash: randomBytes(32).toString("hex"),
    choices: JSON.stringify({ method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", executablePath: null, systemd: true, envNames: [] }),
    created_at: now,
    expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
}

/*
 * The operations reach the registry fleet's links, since those are what the
 * repository lists, reads and changes: `update` extends (a new expiry) and
 * `remove` revokes, the repository's soft removal. A fleet's delete
 * (removeForFleet) takes a fleet, not a key.
 */
const quickDeployLinks: OrganizationResource<"quick_deploy_links"> = {
  kind: "organization",
  table: "quick_deploy_links",
  scopingColumn: organizationScopingColumns.quick_deploy_links,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId, userId) {
    const row = await ownerDb
      .insertInto("quick_deploy_links")
      .values({ ...activeQuickDeployLink(organizationId), created_by_user_id: userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async rowToInsert(_ownerDb, organizationId) {
    return activeQuickDeployLink(organizationId);
  },
  operations(transaction, context) {
    const links = createQuickDeployLinkRepository(transaction, context);
    return {
      list: async () => (await links.list(REGISTRY_FLEET_ID, { limit: 100 })).map((link) => link.id),
      read: (id) => links.find(REGISTRY_FLEET_ID, id),
      update: async (id) => {
        const now = new Date();
        await links.extend(REGISTRY_FLEET_ID, id, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), now);
      },
      remove: async (id) => {
        await links.revoke(REGISTRY_FLEET_ID, id, context.userId, new Date());
      },
    };
  },
};

/**
 * A service account in `organizationId`, as the owner, in the shape the
 * service-account create writes, in one transaction: a user of kind service
 * at the reserved domain, verified and password-less; its service_accounts
 * row, unless `withRow` is false; and its one contributor membership, which
 * the membership invariant needs at commit. Its id is `userId` when given.
 */
async function seedServiceAccount(
  ownerDb: Kysely<Database>,
  organizationId: string,
  { userId, createdByUserId = null, withRow = true }: { userId?: string; createdByUserId?: string | null; withRow?: boolean } = {},
): Promise<string> {
  return ownerDb.transaction().execute(async (transaction) => {
    const at = new Date();
    const user = await transaction
      .insertInto("users")
      .values({
        ...(userId === undefined ? {} : { id: userId }),
        email: `resource-${randomUUID()}@service-accounts.telflo.invalid`,
        email_verified_at: at,
        kind: "service",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (withRow) {
      await transaction
        .insertInto("service_accounts")
        .values(serviceAccountRow(organizationId, user.id, createdByUserId, at))
        .execute();
    }
    await transaction
      .insertInto("organization_members")
      .values({ organization_id: organizationId, user_id: user.id, role: "contributor" })
      .execute();
    return user.id;
  });
}

/** A service_accounts row for the service user `userId` in `organizationId`, with a fresh name. */
function serviceAccountRow(
  organizationId: string,
  userId: string,
  createdByUserId: string | null,
  at: Date,
): Insertable<Database["service_accounts"]> {
  return {
    user_id: userId,
    organization_id: organizationId,
    name: `resource-${randomUUID()}`,
    created_by_user_id: createdByUserId,
    created_at: at,
    updated_at: at,
  };
}

/*
 * The operations reach the organization's live accounts, since those are
 * what the repository lists, reads and changes: `update` renames and
 * `remove` marks the account deleted (its row's and its user's deleted_at,
 * the user reached only through the scoped row).
 */
const serviceAccounts: OrganizationResource<"service_accounts"> = {
  kind: "organization",
  table: "service_accounts",
  scopingColumn: organizationScopingColumns.service_accounts,
  hasRowLevelSecurity: true,
  keyColumn: "user_id",
  seed: (ownerDb, organizationId, userId) => seedServiceAccount(ownerDb, organizationId, { createdByUserId: userId }),
  async rowToInsert(ownerDb, organizationId) {
    // The service user and its membership, committed without the row (the owner may create what it references).
    const userId = await seedServiceAccount(ownerDb, organizationId, { withRow: false });
    return serviceAccountRow(organizationId, userId, null, new Date());
  },
  operations(transaction, context) {
    const accounts = createServiceAccountRepository(transaction, context);
    return {
      list: async () => (await accounts.list()).map((account) => account.id),
      read: (id) => accounts.find(id),
      update: async (id) => {
        await accounts.rename(id, `renamed-${randomUUID()}`, new Date());
      },
      remove: async (id) => {
        await accounts.markDeleted(id, new Date());
      },
    };
  },
};

/**
 * The service account every seeded token is made on: the repository reaches
 * an account's tokens only (it has no organization-wide list), so the seed
 * makes A's account with this id, and B's context names it as A's does.
 * A fresh test database holds no such user.
 */
const REGISTRY_SERVICE_ACCOUNT_ID = "0192a6b0-0000-7000-8000-0000000005ac";

/** A token's columns, live, with a fresh hash and prefix, on `serviceAccountUserId` in `organizationId`. */
function liveApiToken(organizationId: string, serviceAccountUserId: string): Insertable<Database["api_tokens"]> {
  return {
    organization_id: organizationId,
    service_account_user_id: serviceAccountUserId,
    name: `resource-${randomUUID()}`,
    token_hash: randomBytes(32).toString("hex"),
    token_prefix: `tf_${randomBytes(6).toString("base64url")}`,
    access: "read",
    created_at: new Date(),
  };
}

/*
 * The operations reach the registry account's tokens not revoked, since
 * those are what the repository lists, reads and revokes: `update` is "Last
 * used", the token check's one write, which the check makes in the token's
 * own context; `remove` revokes, the repository's soft removal. An admin
 * never changes a token otherwise.
 */
const apiTokens: OrganizationResource<"api_tokens"> = {
  kind: "organization",
  table: "api_tokens",
  scopingColumn: organizationScopingColumns.api_tokens,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId, userId) {
    await seedServiceAccount(ownerDb, organizationId, { userId: REGISTRY_SERVICE_ACCOUNT_ID });
    const row = await ownerDb
      .insertInto("api_tokens")
      .values({ ...liveApiToken(organizationId, REGISTRY_SERVICE_ACCOUNT_ID), created_by_user_id: userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async rowToInsert(ownerDb, organizationId) {
    return liveApiToken(organizationId, await seedServiceAccount(ownerDb, organizationId));
  },
  operations(transaction, context) {
    const tokens = createApiTokenRepository(transaction, context);
    return {
      list: async () => (await tokens.list(REGISTRY_SERVICE_ACCOUNT_ID)).map((token) => token.id),
      read: (id) => tokens.find(REGISTRY_SERVICE_ACCOUNT_ID, id),
      update: async (id) => {
        await tokens.touchLastUsed(id, new Date());
      },
      remove: async (id) => {
        await tokens.revoke(REGISTRY_SERVICE_ACCOUNT_ID, id, context.userId, new Date());
      },
    };
  },
};

/**
 * A configuration's columns, created by `createdByUserId` in
 * `organizationId`, built for the catalogue's default distribution, read as
 * the API reads it. The table has no default for the timestamps (the API
 * writes them from its clock) or the distribution, so they are written here.
 */
async function configurationRow(
  ownerDb: Kysely<Database>,
  organizationId: string,
  createdByUserId: string,
): Promise<Insertable<Database["configurations"]>> {
  const at = new Date();
  const { distribution } = await createCollectorCatalogueRepository(ownerDb).findDefaults();
  return {
    organization_id: organizationId,
    name: `resource-${randomUUID()}`,
    created_by_user_id: createdByUserId,
    collector_distribution: distribution,
    created_at: at,
    updated_at: at,
  };
}

/*
 * The operations reach only live configurations the viewer can see, since
 * those are what the repository lists, reads and changes: `update` renames
 * and `remove` deletes softly. `list` is the first page at its largest. The
 * seed is another member's configuration with a published version 1, which
 * A's own member can see.
 */
const configurations: OrganizationResource<"configurations"> = {
  kind: "organization",
  table: "configurations",
  scopingColumn: organizationScopingColumns.configurations,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    const { configurationId } = await seedPublishedConfiguration(ownerDb, organizationId);
    return configurationId;
  },
  async rowToInsert(ownerDb, organizationId) {
    return configurationRow(ownerDb, organizationId, await seedMember(ownerDb, organizationId));
  },
  operations(transaction, context) {
    const repository = createConfigurationRepository(transaction, context);
    return {
      list: async () => (await repository.listPage({ limit: 100 })).items.map((configuration) => configuration.id),
      read: (id) => repository.find(id),
      update: async (id) => {
        await repository.update(id, { name: "changed" }, new Date());
      },
      remove: async (id) => {
        await repository.markDeleted(id, new Date());
      },
    };
  },
};

/**
 * The configuration each seeded version belongs to, by the version's id. The
 * suite hands the operations only the version's key, but the repository
 * addresses a version through its configuration. For B's attempt to test the
 * repository's own filter, the call must carry A's real configuration id:
 * looked up from the version in B's context, it wouldn't be found, and the
 * repository would be asked about nothing. So `seed` records the pair, and
 * `read` and `update` pass it. Module-level: the entry's `seed` and
 * `operations` share nothing else.
 */
const configurationOfSeededVersion = new Map<string, string>();

/** The configuration `seed` recorded for this version. */
function seededConfigurationOf(versionId: string): string {
  const configurationId = configurationOfSeededVersion.get(versionId);
  if (configurationId === undefined) throw new Error(`no seeded configuration_versions row ${versionId}`);
  return configurationId;
}

/**
 * A configuration's version, with empty YAML, as the configuration's
 * create writes a version 1: a draft, every publish column null, pinned to
 * the catalogue's default version of its default distribution, which every
 * seeded configuration is built for.
 */
async function draftVersionRow(
  ownerDb: Kysely<Database>,
  organizationId: string,
  configurationId: string,
  createdByUserId: string,
  versionNumber: number,
): Promise<Insertable<Database["configuration_versions"]>> {
  const at = new Date();
  const pin = await createCollectorCatalogueRepository(ownerDb).findDefaults();
  return {
    configuration_id: configurationId,
    organization_id: organizationId,
    version_number: versionNumber,
    yaml_content: "",
    created_by_user_id: createdByUserId,
    collector_distribution: pin.distribution,
    collector_version: pin.version,
    created_at: at,
    updated_at: at,
  };
}

/**
 * A configuration in `organizationId`, created by a new member of it, with
 * its version 1 published by them, as the owner (the API's role can't insert
 * a published version, migration 021): a configuration every member of the
 * organization can see.
 */
async function seedPublishedConfiguration(
  ownerDb: Kysely<Database>,
  organizationId: string,
): Promise<{ configurationId: string; createdByUserId: string; publishedVersionId: string }> {
  const createdByUserId = await seedMember(ownerDb, organizationId);
  const row = await ownerDb
    .insertInto("configurations")
    .values(await configurationRow(ownerDb, organizationId, createdByUserId))
    .returning("id")
    .executeTakeFirstOrThrow();
  const version = await ownerDb
    .insertInto("configuration_versions")
    .values({
      ...(await draftVersionRow(ownerDb, organizationId, row.id, createdByUserId, 1)),
      yaml_content: "receivers: {}\n",
      published_at: new Date(),
      publication_id: randomUUID(),
      published_by_user_id: createdByUserId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { configurationId: row.id, createdByUserId, publishedVersionId: version.id };
}

/**
 * A published configuration's draft version 2, as the owner: a version every
 * member can see and save, unlike the published version 1, which can't be
 * changed.
 */
async function seedDraftOfPublished(
  ownerDb: Kysely<Database>,
  organizationId: string,
): Promise<{ configurationId: string; createdByUserId: string; versionId: string }> {
  const { configurationId, createdByUserId } = await seedPublishedConfiguration(ownerDb, organizationId);
  const row = await ownerDb
    .insertInto("configuration_versions")
    .values(await draftVersionRow(ownerDb, organizationId, configurationId, createdByUserId, 2))
    .returning("id")
    .executeTakeFirstOrThrow();
  return { configurationId, createdByUserId, versionId: row.id };
}

/*
 * The first child table. A version is reached only through its live
 * configuration, so `read` and `update` name A's configuration with A's
 * version (see configurationOfSeededVersion). `list` goes through the scope
 * itself, as the tenant row's does: the repository has no list, and every
 * version id the context can select shows a lost filter every time. `update`
 * saves the text "changed". There is no remove: a version is deleted with its
 * configuration. The seed, the key, is the draft version 2 of another member's
 * published configuration: A's member can see and save it.
 */
const configurationVersions: OrganizationResource<"configuration_versions"> = {
  kind: "organization",
  table: "configuration_versions",
  scopingColumn: organizationScopingColumns.configuration_versions,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    const { configurationId, versionId } = await seedDraftOfPublished(ownerDb, organizationId);
    configurationOfSeededVersion.set(versionId, configurationId);
    return versionId;
  },
  async rowToInsert(ownerDb, organizationId) {
    const { configurationId, createdByUserId } = await seedPublishedConfiguration(ownerDb, organizationId);
    return draftVersionRow(ownerDb, organizationId, configurationId, createdByUserId, 2);
  },
  removeUnsupported: "A version is deleted with its configuration; it has no delete of its own.",
  operations(transaction, context) {
    const versions = createConfigurationVersionRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () =>
        (await scope.selectFrom("configuration_versions").select("id").execute()).map((row) => row.id),
      read: (id) => versions.find(seededConfigurationOf(id), id),
      update: async (id) => {
        await versions.save(
          seededConfigurationOf(id),
          id,
          { yamlContent: "changed", nodes: [], edges: [], pipelines: [] },
          new Date(),
        );
      },
    };
  },
};

/** What `seed` made for a selection: the person, and the configuration and version they selected. */
interface SeededSelection {
  userId: string;
  configurationId: string;
  versionId: string;
}

/**
 * The person, configuration and version of each seeded selection, by the
 * selection's id: the repository addresses a selection by person and
 * configuration, never by id, so `read` and `update` look A's real ids up
 * here, as configurationOfSeededVersion does for a version.
 */
const seededSelections = new Map<string, SeededSelection>();

/** What `seed` recorded for this selection. */
function seededSelectionOf(selectionId: string): SeededSelection {
  const seeded = seededSelections.get(selectionId);
  if (seeded === undefined) throw new Error(`no seeded configuration_version_selections row ${selectionId}`);
  return seeded;
}

/**
 * A member of `organizationId`, a configuration they created and published
 * (version 1), and its draft version 2, which the selection names, as the
 * owner.
 */
async function seedSelectableVersion(ownerDb: Kysely<Database>, organizationId: string): Promise<SeededSelection> {
  const { configurationId, createdByUserId, versionId } = await seedDraftOfPublished(ownerDb, organizationId);
  return { userId: createdByUserId, configurationId, versionId };
}

/** A selection's columns: `selected` chose its version, at `selectedAt`. */
function selectionRow(
  organizationId: string,
  selected: SeededSelection,
  selectedAt: Date,
): Insertable<Database["configuration_version_selections"]> {
  return {
    organization_id: organizationId,
    configuration_id: selected.configurationId,
    version_id: selected.versionId,
    user_id: selected.userId,
    selected_at: selectedAt,
  };
}

/*
 * A table with a composite key into a child table: a selection names a
 * configuration and one of its versions. The repository addresses it by
 * person and configuration, so `read` and `update` pass A's real ids (see
 * seededSelections). `read` is `find`; `update` records the seeded
 * version again at a fresh time, so A's row changes visibly (it was
 * seeded in 2000), and in B's context the read before the upsert finds
 * nothing and writes nothing. `list` goes through the scope itself: the
 * repository has no list. There is no remove: a selection goes with its
 * configuration, its version or its person.
 */
const configurationVersionSelections: OrganizationResource<"configuration_version_selections"> = {
  kind: "organization",
  table: "configuration_version_selections",
  scopingColumn: organizationScopingColumns.configuration_version_selections,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    const selected = await seedSelectableVersion(ownerDb, organizationId);
    const row = await ownerDb
      .insertInto("configuration_version_selections")
      .values(selectionRow(organizationId, selected, new Date("2000-01-01T00:00:00.000Z")))
      .returning("id")
      .executeTakeFirstOrThrow();
    seededSelections.set(row.id, selected);
    return row.id;
  },
  async rowToInsert(ownerDb, organizationId) {
    return selectionRow(organizationId, await seedSelectableVersion(ownerDb, organizationId), new Date());
  },
  removeUnsupported: "A selection goes with its configuration or its person.",
  operations(transaction, context) {
    const selections = createConfigurationVersionSelectionRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () =>
        (await scope.selectFrom("configuration_version_selections").select("id").execute()).map((row) => row.id),
      read: (id) => {
        const { userId, configurationId } = seededSelectionOf(id);
        return selections.find(userId, configurationId);
      },
      update: async (id) => {
        const { userId, configurationId, versionId } = seededSelectionOf(id);
        await selections.record(userId, configurationId, versionId, new Date());
      },
    };
  },
};

/** A test file's columns, `ownerUserId`'s in `organizationId`: a row only, with no bytes behind it. */
function testInputFileRow(organizationId: string, ownerUserId: string): Insertable<Database["test_input_files"]> {
  return {
    organization_id: organizationId,
    owner_user_id: ownerUserId,
    display_name: `resource-${randomUUID()}`,
    file_name: "input.json",
    content_type: "application/json",
    size_bytes: 0,
    sha256: createHash("sha256").digest(),
  };
}

/*
 * A person's test file: visible to its owner alone, so the seed is the file
 * of A's own member (`userId`), whom the suite acts as. `list`, `read` and
 * `remove` are the repository's own (listOwn, findOwn, removeOwn), narrowed
 * to the context's user, so a lost organization filter shows A's row every
 * time. A file never changes: no update.
 */
const testInputFiles: OrganizationResource<"test_input_files"> = {
  kind: "organization",
  table: "test_input_files",
  scopingColumn: organizationScopingColumns.test_input_files,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId, userId) {
    const row = await ownerDb
      .insertInto("test_input_files")
      .values(testInputFileRow(organizationId, userId))
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async rowToInsert(ownerDb, organizationId) {
    return testInputFileRow(organizationId, await seedMember(ownerDb, organizationId));
  },
  updateUnsupported: "A test file never changes: it is uploaded, read and deleted.",
  operations(transaction, context) {
    const files = createTestInputFileRepository(transaction, context);
    return {
      list: async () => (await files.listOwn(TEST_FILES_LIST_MAXIMUM)).map((file) => file.id),
      read: (id) => files.findOwn(id),
      remove: async (id) => {
        await files.removeOwn(id);
      },
    };
  },
};

/**
 * A queued run's columns on a configuration's version, queued by
 * `queuedByUserId`, pinned to the catalogue's defaults, which every seeded
 * configuration is built for. queued_at is left to the table's now(), the
 * only time the insert policy admits.
 */
async function testRunRow(
  ownerDb: Kysely<Database>,
  organizationId: string,
  configurationId: string,
  versionId: string,
  queuedByUserId: string,
): Promise<Insertable<Database["test_runs"]>> {
  const pin = await createCollectorCatalogueRepository(ownerDb).findDefaults();
  return {
    organization_id: organizationId,
    configuration_id: configurationId,
    configuration_version_id: versionId,
    queued_by_user_id: queuedByUserId,
    yaml: "receivers: {}\n",
    target_pipeline: "logs",
    signal: "logs",
    duration_seconds: 5,
    collector_distribution: pin.distribution,
    collector_version: pin.version,
    input_name: "input.json",
    input_size_bytes: 0,
  };
}

/*
 * A test run: the seed is a run A's own member (`userId`) queued on
 * another member's published configuration, which every member can see. A
 * run changes only through the dispatcher's functions and is never
 * deleted, so there is neither an update nor a remove. `read` is the
 * repository's `find`; `list` goes through the scope itself, as the
 * versions' does: the repository lists one version's runs, and every run
 * id the context can select shows a lost filter every time.
 */
const testRuns: OrganizationResource<"test_runs"> = {
  kind: "organization",
  table: "test_runs",
  scopingColumn: organizationScopingColumns.test_runs,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId, userId) {
    const { configurationId, publishedVersionId } = await seedPublishedConfiguration(ownerDb, organizationId);
    const row = await ownerDb
      .insertInto("test_runs")
      .values(await testRunRow(ownerDb, organizationId, configurationId, publishedVersionId, userId))
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async rowToInsert(ownerDb, organizationId) {
    const { configurationId, publishedVersionId } = await seedPublishedConfiguration(ownerDb, organizationId);
    return testRunRow(
      ownerDb,
      organizationId,
      configurationId,
      publishedVersionId,
      await seedMember(ownerDb, organizationId),
    );
  },
  updateUnsupported:
    "A run changes only through the dispatcher's functions; the API's role updates no row.",
  removeUnsupported: "A run is never deleted; it goes only with its organization.",
  operations(transaction, context) {
    const runs = createTestRunRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () => (await scope.selectFrom("test_runs").select("id").execute()).map((row) => row.id),
      read: (id) => runs.find(id),
    };
  },
};

/**
 * A suite's columns on `versionId` of a configuration in `organizationId`,
 * created by `createdByUserId` now.
 */
function testSuiteRow(
  organizationId: string,
  configurationId: string,
  versionId: string,
  createdByUserId: string,
): Insertable<Database["test_suites"]> {
  const at = new Date();
  return {
    organization_id: organizationId,
    configuration_id: configurationId,
    configuration_version_id: versionId,
    name: `resource-${randomUUID()}`,
    created_by_user_id: createdByUserId,
    created_at: at,
    updated_at: at,
  };
}

/** A definition input's columns on a configuration in `organizationId`: a row only, with no bytes behind it. */
function testDefinitionInputRow(
  organizationId: string,
  configurationId: string,
): Insertable<Database["test_definition_inputs"]> {
  return {
    organization_id: organizationId,
    configuration_id: configurationId,
    file_name: "input.json",
    content_type: "application/json",
    size_bytes: 0,
    sha256: createHash("sha256").digest(),
  };
}

/**
 * Another member's published configuration in `organizationId`, a suite on its
 * version 1 and an unused input, all theirs, as the owner: what every member
 * of the organization can see.
 */
async function seedSuiteAndInput(
  ownerDb: Kysely<Database>,
  organizationId: string,
): Promise<{
  configurationId: string;
  versionId: string;
  createdByUserId: string;
  suiteId: string;
  inputId: string;
}> {
  const { configurationId, createdByUserId, publishedVersionId } = await seedPublishedConfiguration(
    ownerDb,
    organizationId,
  );
  const suite = await ownerDb
    .insertInto("test_suites")
    .values(testSuiteRow(organizationId, configurationId, publishedVersionId, createdByUserId))
    .returning("id")
    .executeTakeFirstOrThrow();
  const input = await ownerDb
    .insertInto("test_definition_inputs")
    .values(testDefinitionInputRow(organizationId, configurationId))
    .returning("id")
    .executeTakeFirstOrThrow();
  return { configurationId, versionId: publishedVersionId, createdByUserId, suiteId: suite.id, inputId: input.id };
}

/** A definition's columns: `seeded`'s suite running its input, created by `seeded`'s member. */
function testDefinitionRow(
  organizationId: string,
  seeded: Awaited<ReturnType<typeof seedSuiteAndInput>>,
): Insertable<Database["test_definitions"]> {
  return {
    organization_id: organizationId,
    configuration_id: seeded.configurationId,
    configuration_version_id: seeded.versionId,
    test_suite_id: seeded.suiteId,
    input_id: seeded.inputId,
    name: `resource-${randomUUID()}`,
    target_pipeline: "logs",
    signal: "logs",
    duration_seconds: 5,
    created_by_user_id: seeded.createdByUserId,
    created_at: new Date(),
  };
}

/*
 * A configuration version's test suite: the seed is another member's
 * suite on their published configuration, which every member can see.
 * `read`, `update` (a rename) and `remove` (the suite's definitions go
 * with it) are its repository's; `list` goes through the scope itself, as
 * the runs' does: the repository lists one version's suites, and every
 * suite id the context can select shows a lost filter every time.
 */
const testSuites: OrganizationResource<"test_suites"> = {
  kind: "organization",
  table: "test_suites",
  scopingColumn: organizationScopingColumns.test_suites,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    return (await seedSuiteAndInput(ownerDb, organizationId)).suiteId;
  },
  async rowToInsert(ownerDb, organizationId) {
    const { configurationId, createdByUserId, publishedVersionId } = await seedPublishedConfiguration(
      ownerDb,
      organizationId,
    );
    return testSuiteRow(organizationId, configurationId, publishedVersionId, createdByUserId);
  },
  operations(transaction, context) {
    const suites = createTestSuiteRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () => (await scope.selectFrom("test_suites").select("id").execute()).map((row) => row.id),
      read: (id) => suites.find(id),
      update: async (id) => {
        await suites.update(id, { name: `renamed-${randomUUID()}` }, new Date());
      },
      remove: async (id) => {
        await suites.remove(id);
      },
    };
  },
};

/*
 * A definition's input: the seed is an input no definition names yet, on
 * another member's published configuration. An input never changes. `remove`
 * is the reference count's free: it deletes the input only while no definition
 * names it. `read` and `remove` are its repository's (find, freeUnused);
 * `list` goes through the scope itself, since the repository lists none.
 */
const testDefinitionInputs: OrganizationResource<"test_definition_inputs"> = {
  kind: "organization",
  table: "test_definition_inputs",
  scopingColumn: organizationScopingColumns.test_definition_inputs,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    return (await seedSuiteAndInput(ownerDb, organizationId)).inputId;
  },
  async rowToInsert(ownerDb, organizationId) {
    const { configurationId } = await seedPublishedConfiguration(ownerDb, organizationId);
    return testDefinitionInputRow(organizationId, configurationId);
  },
  updateUnsupported: "A definition's input never changes: it is copied once, shared, and freed.",
  operations(transaction, context) {
    const inputs = createTestDefinitionInputRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () =>
        (await scope.selectFrom("test_definition_inputs").select("id").execute()).map((row) => row.id),
      read: (id) => inputs.find(id),
      remove: async (id) => {
        await inputs.freeUnused([id]);
      },
    };
  },
};

/*
 * A suite's test configuration: the seed is another member's definition in
 * their suite on their published configuration. A definition is created and
 * deleted, never changed. `read` and `remove` are its repository's; `list`
 * goes through the scope itself, as the suites' does.
 */
const testDefinitions: OrganizationResource<"test_definitions"> = {
  kind: "organization",
  table: "test_definitions",
  scopingColumn: organizationScopingColumns.test_definitions,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    const seeded = await seedSuiteAndInput(ownerDb, organizationId);
    const row = await ownerDb
      .insertInto("test_definitions")
      .values(testDefinitionRow(organizationId, seeded))
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async rowToInsert(ownerDb, organizationId) {
    return testDefinitionRow(organizationId, await seedSuiteAndInput(ownerDb, organizationId));
  },
  updateUnsupported: "A definition is created and deleted, never changed.",
  operations(transaction, context) {
    const definitions = createTestDefinitionRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () => (await scope.selectFrom("test_definitions").select("id").execute()).map((row) => row.id),
      read: (id) => definitions.find(id),
      remove: async (id) => {
        await definitions.remove(id);
      },
    };
  },
};

/**
 * A validation pipeline's columns for the `logs` pipeline on `versionId` of
 * a configuration in `organizationId`, created by `createdByUserId` now.
 */
function validationPipelineRow(
  organizationId: string,
  configurationId: string,
  versionId: string,
  createdByUserId: string,
): Insertable<Database["validation_pipelines"]> {
  return {
    organization_id: organizationId,
    configuration_id: configurationId,
    configuration_version_id: versionId,
    pipeline_name: "logs",
    signal: "logs",
    created_by_user_id: createdByUserId,
    created_at: new Date(),
  };
}

/**
 * Another member's published configuration in `organizationId` and a
 * validation pipeline on its version 1, theirs, as the owner: what every
 * member of the organization can see.
 */
async function seedValidationPipeline(
  ownerDb: Kysely<Database>,
  organizationId: string,
): Promise<{ configurationId: string; versionId: string; createdByUserId: string; validationPipelineId: string }> {
  const { configurationId, createdByUserId, publishedVersionId } = await seedPublishedConfiguration(
    ownerDb,
    organizationId,
  );
  const pipeline = await ownerDb
    .insertInto("validation_pipelines")
    .values(validationPipelineRow(organizationId, configurationId, publishedVersionId, createdByUserId))
    .returning("id")
    .executeTakeFirstOrThrow();
  return { configurationId, versionId: publishedVersionId, createdByUserId, validationPipelineId: pipeline.id };
}

/** A text rule's columns, first in `seeded`'s validation pipeline, added by `seeded`'s member now. */
function validationRuleRow(
  organizationId: string,
  seeded: Awaited<ReturnType<typeof seedValidationPipeline>>,
): Insertable<Database["validation_rules"]> {
  const at = new Date();
  return {
    organization_id: organizationId,
    configuration_id: seeded.configurationId,
    configuration_version_id: seeded.versionId,
    validation_pipeline_id: seeded.validationPipelineId,
    position: 1,
    kind: "contains_text",
    target: "output",
    pattern: `resource-${randomUUID()}`,
    created_by_user_id: seeded.createdByUserId,
    created_at: at,
    updated_at: at,
  };
}

/*
 * A configuration version's validation pipeline: the seed is another member's,
 * on their published configuration, which every member can see. It is created
 * and deleted, never changed. `read` and `remove` are its repository's; `list`
 * goes through the scope itself, as the suites' does: the repository lists one
 * version's pipelines, and every pipeline id the context can select shows a
 * lost filter every time.
 */
const validationPipelines: OrganizationResource<"validation_pipelines"> = {
  kind: "organization",
  table: "validation_pipelines",
  scopingColumn: organizationScopingColumns.validation_pipelines,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    return (await seedValidationPipeline(ownerDb, organizationId)).validationPipelineId;
  },
  async rowToInsert(ownerDb, organizationId) {
    const { configurationId, createdByUserId, publishedVersionId } = await seedPublishedConfiguration(
      ownerDb,
      organizationId,
    );
    return validationPipelineRow(organizationId, configurationId, publishedVersionId, createdByUserId);
  },
  updateUnsupported: "A validation pipeline is created and deleted, never changed.",
  operations(transaction, context) {
    const pipelines = createValidationPipelineRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () => (await scope.selectFrom("validation_pipelines").select("id").execute()).map((row) => row.id),
      read: (id) => pipelines.find(id),
      remove: async (id) => {
        await pipelines.remove(id);
      },
    };
  },
};

/*
 * A validation pipeline's rule: the seed is another member's rule in
 * their validation pipeline on their published configuration. `update`
 * renames it, which the editor's save does among its changes; `remove`
 * deletes it. `read`, `update` and `remove` are its repository's; `list`
 * goes through the scope itself, as the pipelines' does.
 */
const validationRules: OrganizationResource<"validation_rules"> = {
  kind: "organization",
  table: "validation_rules",
  scopingColumn: organizationScopingColumns.validation_rules,
  hasRowLevelSecurity: true,
  keyColumn: "id",
  async seed(ownerDb, organizationId) {
    const seeded = await seedValidationPipeline(ownerDb, organizationId);
    const row = await ownerDb
      .insertInto("validation_rules")
      .values(validationRuleRow(organizationId, seeded))
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  },
  async rowToInsert(ownerDb, organizationId) {
    return validationRuleRow(organizationId, await seedValidationPipeline(ownerDb, organizationId));
  },
  operations(transaction, context) {
    const rules = createValidationRuleRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () => (await scope.selectFrom("validation_rules").select("id").execute()).map((row) => row.id),
      read: (id) => rules.find(id),
      update: async (id) => {
        await rules.update(id, { name: `renamed-${randomUUID()}` }, new Date());
      },
      remove: async (id) => {
        await rules.remove(id);
      },
    };
  },
};

/*
 * The tenant row is its own organization: the repository reaches only the
 * context's, and has no way to address another by key. So `update` and
 * `remove` act on the context's organization whatever key they are given,
 * and the suite checks that A's row is untouched when B's context tries
 * them. `list` and `read` go through the scope itself: the repository's
 * single-row `findActive` would return an arbitrary organization, not
 * certainly A's, if the filter were lost, and `organizations` has no
 * row-level security behind it.
 */
const organizations: OrganizationResource<"organizations"> = {
  kind: "organization",
  table: "organizations",
  scopingColumn: organizationScopingColumns.organizations,
  hasRowLevelSecurity: false,
  keyColumn: "id",
  async seed(_ownerDb, organizationId) {
    return organizationId;
  },
  operations(transaction, context) {
    const organization = createActiveOrganizationRepository(transaction, context);
    const scope = createOrganizationScope(transaction, context);
    return {
      list: async () => (await scope.selectFrom("organizations").select("id").execute()).map((row) => row.id),
      read: (id) => scope.selectFrom("organizations").selectAll().where("id", "=", id).executeTakeFirst(),
      update: async () => {
        await organization.rename(`renamed-${randomUUID()}`);
        await organization.setPublicInstallLinks(false);
        await organization.setLogo({ logoId: randomUUID(), contentType: "image/png" });
      },
      remove: async () => {
        await organization.markDeleted(new Date());
      },
    };
  },
};

/** Every application table (`pgmigrations` aside), exactly once. */
export const resourceRegistry: readonly RegisteredResource[] = [
  organizations,
  organizationMembers,
  organizationInvitations,
  quickDeployLinks,
  serviceAccounts,
  apiTokens,
  configurations,
  configurationVersions,
  configurationVersionSelections,
  testInputFiles,
  testRuns,
  testSuites,
  testDefinitionInputs,
  testDefinitions,
  validationPipelines,
  validationRules,
  {
    kind: "global",
    table: "test_templates",
    reason:
      "Product-wide sample test inputs: every organization picks from the same " +
      "templates, written only by product admins, which the API decides. A definition or a run made from one " +
      "keeps its own copy in its organization.",
  },
  {
    kind: "global",
    table: "library_files",
    reason:
      "Telflo's own helper files: every member reads them, only product admins write them, " +
      "which the API decides.",
  },
  {
    kind: "global",
    table: "test_regex",
    reason:
      "The regex library: every organization picks from the same named patterns, " +
      "written only by product admins, which the API decides. A rule made from one copies the regex into its " +
      "organization; nothing references an entry.",
  },
  {
    kind: "global",
    table: "otelcol_testing_state",
    reason:
      "The tester's health: one row, since one tester serves every organization. The API's " +
      "role reads it and changes it only through the dispatcher's otelcol_testing_mark.",
  },
  {
    kind: "global",
    table: "ottl_evaluator_state",
    reason:
      "The OTTL evaluator's health: one row, since one evaluator serves every " +
      "organization. The API's role reads it and changes it only through the dispatcher's ottl_evaluator_mark.",
  },
  {
    kind: "global",
    table: "site_settings",
    reason:
      "The site's settings a product admin changes: one row, who may create an organization. " +
      "The API's role reads it and changes it only through product admins' definer function, which the SystemRepository calls.",
  },
  {
    kind: "global",
    table: "users",
    reason: "An account belongs to a person, who may belong to many organizations.",
  },
  {
    kind: "global",
    table: "email_verification_tokens",
    reason: "Proves a user's email address; belongs to the user, not to an organization.",
  },
  {
    kind: "global",
    table: "password_reset_tokens",
    reason: "Resets a user's password; belongs to the user, not to an organization.",
  },
  {
    kind: "global",
    table: "user_identities",
    reason: "Links a user to a sign-in provider; belongs to the user, not to an organization.",
  },
  {
    kind: "global",
    table: "user_settings",
    reason: "A person's own preferences: belongs to the user, not to an organization.",
  },
  {
    kind: "global",
    table: "personal_api_tokens",
    hasRowLevelSecurity: true,
    reason:
      "A person's own API tokens: they belong to the user, not to an organization, which each " +
      "request names (X-Telflo-Org) and the person's membership there decides. Row-level security on the " +
      "context's user shows a person their own tokens only.",
  },
  {
    kind: "global",
    table: "sessions",
    reason:
      "A user's sign-in. active_organization_id is the organization it acts in, which the switch changes after a " +
      "membership check; the session belongs to the user.",
  },
  {
    kind: "global",
    table: "refresh_tokens",
    reason: "Belongs to a session, which belongs to a user.",
  },
  {
    kind: "global",
    table: "collector_distributions",
    reason:
      "The collector catalogue's distributions: every organization picks from the same " +
      "ones. Written only by the migration step's sync; the API's role may only read it.",
  },
  {
    kind: "global",
    table: "collector_versions",
    reason:
      "The collector catalogue's versions: every organization pins the same ones. " +
      "Written only by the migration step's sync; the API's role may only read it.",
  },
  {
    kind: "global",
    table: "flows",
    reason:
      "Prebuilt collector configurations: every organization, and every signed-out " +
      "visitor, reads the same published flows. Only a product admin writes them, which the API decides; a " +
      "configuration created from one keeps its own copy in its organization.",
  },
  {
    kind: "system",
    table: "user_feedback",
    reason:
      "\"Contact us\" messages: a person sends one from any organization, and only product admins " +
      "read and handle them, across every organization. The API's role may only insert (the sender's request); " +
      "reads and changes go through the product-admin functions.",
  },
  {
    kind: "system",
    table: "user_deletion_records",
    reason:
      "Who a deleted person was: written once by the delete function, read only by an " +
      "operator's SQL. The API's role holds nothing on it.",
  },
  {
    kind: "global",
    table: "audit_events",
    reason:
      "Append-only; every module writes it, with the organization an event happened in where there is one, and no " +
      "API path reads it yet. Nothing shows an organization its audit log, so it isn't registered as an " +
      "organization resource.",
  },
];
