import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Insertable, Kysely, Selectable } from "kysely";
import type {
  ApiTokenAccess,
  ApiTokensTable,
  ConfigurationsTable,
  ConfigurationVersionSelectionsTable,
  ConfigurationVersionsTable,
  Database,
  LibraryFilesTable,
  OrganizationInvitationsTable,
  OrganizationMembersTable,
  OrganizationRole,
  OrganizationsTable,
  PersonalApiTokensTable,
  QuickDeployLinksTable,
  ServiceAccountsTable,
  TestDefinitionInputsTable,
  TestDefinitionsTable,
  TestInputFilesTable,
  TestRunsTable,
  TestRunStatus,
  TestSuitesTable,
  TestTemplatesTable,
  UserFeedbackTable,
  UsersTable,
  ValidationPipelinesTable,
  ValidationRulesTable,
} from "./schema.js";
import { createDb, createPool } from "./pool.js";
import { APPLICATION_ROLE } from "./application-role.js";
import { testDatabaseUrl, testMigrationDatabaseUrl } from "./test-database.js";

/** The mark of a test's own catalogue fixture row: test-database.ts' TEST_CATALOGUE_FIXTURE_NOTE. */
export { TEST_CATALOGUE_FIXTURE_NOTE } from "./test-database.js";

/**
 * Test helpers. Exported only from the `@telflo/db/testing` subpath, never
 * from the package root, so production code cannot import them by accident.
 */

export interface TestDatabases {
  /** The API's login role (TELFLO_DATABASE_URL): for the server under test and the repositories it uses. */
  db: Kysely<Database>;
  /**
   * The tables' owner (TELFLO_MIGRATION_DATABASE_URL): for fixtures,
   * `truncateAll`, `withFailingInsert` and reading rows back. Never given to
   * a server under test.
   */
  ownerDb: Kysely<Database>;
  /** Ends both pools. */
  destroy(): Promise<void>;
}

export interface OpenTestDatabasesOptions {
  /** Sets `application_name` on the application role's connections, so a test can pick them out in pg_stat_activity. */
  applicationName?: string;
}

/**
 * Opens a pool on the test database as each role, from the URLs
 * vitest.setup.ts points at it. Both are checked to name a `_test` database.
 */
export function openTestDatabases(options: OpenTestDatabasesOptions = {}): TestDatabases {
  const applicationUrl = new URL(testDatabaseUrl({ TELFLO_TEST_DATABASE_URL: process.env.TELFLO_DATABASE_URL }));
  const ownerUrl = testMigrationDatabaseUrl({
    TELFLO_TEST_MIGRATION_DATABASE_URL: process.env.TELFLO_MIGRATION_DATABASE_URL,
  });
  if (options.applicationName !== undefined) {
    applicationUrl.searchParams.set("application_name", options.applicationName);
  }
  const db = createDb(createPool(applicationUrl.toString()));
  const ownerDb = createDb(createPool(ownerUrl));
  return {
    db,
    ownerDb,
    destroy: async () => {
      await Promise.all([db.destroy(), ownerDb.destroy()]);
    },
  };
}

/**
 * Every application table, in the order `truncateAll` names them.
 *
 * A migration that adds a table must add it here. schema.integration.test.ts
 * compares this list against information_schema, so a table left out fails
 * the suite rather than leaking rows between tests.
 */
export const applicationTables = [
  "user_feedback",
  "user_deletion_records",
  "user_identities",
  "password_reset_tokens",
  "refresh_tokens",
  "sessions",
  "validation_rules",
  "validation_pipelines",
  "test_runs",
  "test_definitions",
  "test_definition_inputs",
  "test_suites",
  "test_input_files",
  "configuration_version_selections",
  "configuration_versions",
  "configurations",
  "test_templates",
  "library_files",
  "test_regex",
  "flows",
  "quick_deploy_links",
  "api_tokens",
  "personal_api_tokens",
  "service_accounts",
  "organization_invitations",
  "organization_members",
  "organizations",
  "audit_events",
  "email_verification_tokens",
  "user_settings",
  "users",
] as const;

/**
 * The collector catalogue's tables (migration 1700000000023): global, written
 * only by the migration step's sync, which globalSetup runs once per run.
 * `truncateAll` leaves them, so every test sees the committed catalogue; a
 * test that needs another catalogue uses a throwaway database or a rolled-back
 * transaction, never `telflo_platform_test` itself. Every table is in this
 * list or in `applicationTables`, which schema.integration.test.ts checks
 * against the database.
 */
export const catalogueTables = ["collector_versions", "collector_distributions"] as const;

/**
 * Global tables of one row each (migration 1700000000028's
 * otelcol_testing_state, the tester's health, migration 1700000000030's
 * ottl_evaluator_state, the OTTL evaluator's, and migration 1700000000044's
 * site_settings, who may create an organization): `truncateAll` resets their
 * row rather than empties them, since the application finds the row there
 * and never inserts it. Every table is in this list, `applicationTables` or
 * `catalogueTables`, which schema.integration.test.ts checks.
 */
export const singletonTables = ["otelcol_testing_state", "ottl_evaluator_state", "site_settings"] as const;

/**
 * Empties every application table, with `cascade`. A migration that adds a
 * table must add it to `applicationTables` above (or, if it is the
 * catalogue's, to `catalogueTables`, which this leaves). `truncate` rather
 * than `delete`: it is the only way to empty append-only `audit_events`,
 * whose trigger blocks row deletes, and row-level triggers do not fire on
 * it. `cascade` reaches only the tables that reference a truncated one,
 * and the catalogue's tables reference no application table (the
 * references run the other way: configurations, configuration_versions and
 * flows reference the catalogue's), so the cascade never reaches them.
 *
 * It empties `flows` too, the seeded flows (migration 1700000000026)
 * included: a test that needs them calls `insertSeededFlows` afterwards. So
 * too `test_regex` and its 35 seeded entries (migration 1700000000031):
 * `insertSeededTestRegexes` puts them back. And it marks the tester and the
 * evaluator up and lets everyone create an organization again
 * (`singletonTables`), so a test that changed one leaves nothing behind.
 * That last is the TESTS' baseline, not the migration's default: a freshly
 * migrated database lets only product admins create organizations
 * (migration 1700000000044), but most tests, and the browser tests
 * (e2e/global-setup.ts), create them as ordinary accounts; a test of the
 * switch turns it on itself, and schema.integration.test.ts pins the
 * migration's default.
 */
export async function truncateAll(db: Kysely<Database>): Promise<void> {
  await withTestLockTimeout(db, async (transaction) => {
    await sql`truncate table ${sql.join(applicationTables.map((table) => sql.table(table)))} cascade`.execute(
      transaction,
    );
    // The tester and the evaluator up again, as a fresh database has them (singletonTables).
    await sql`update otelcol_testing_state set down_since = null`.execute(transaction);
    await sql`update ottl_evaluator_state set down_since = null`.execute(transaction);
    // Anyone may create an organization again: the tests' baseline, not the
    // migration's default (product_admins).
    await sql`update site_settings set organization_creation = 'everyone'`.execute(transaction);
  });
}

/**
 * How long test-only DDL waits for a table lock before failing. Below
 * vitest's 5 s test and 10 s hook timeouts, so a stuck lock fails the test
 * that hit it, naming the lock, rather than hanging the run.
 */
const TEST_LOCK_TIMEOUT = "3s";

/**
 * Runs test-only DDL (`truncate`, `create`/`drop trigger`) in a transaction
 * with a short `lock_timeout`. Postgres sets none by default, so without it
 * a connection left idle in a transaction holding any lock on these tables
 * makes the DDL wait forever. On a lock timeout, the error lists the
 * sessions holding locks on application tables, which is the leak to fix.
 */
async function withTestLockTimeout<T>(
  db: Kysely<Database>,
  work: (transaction: Kysely<Database>) => Promise<T>,
  lockTimeout: string = TEST_LOCK_TIMEOUT,
): Promise<T> {
  try {
    return await db.transaction().execute(async (transaction) => {
      await sql.raw(`set local lock_timeout = '${lockTimeout}'`).execute(transaction);
      return work(transaction);
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "55P03") throw error;
    const holders = await sql<{ pid: number; state: string; relation: string; mode: string; query: string }>`
      select a.pid, a.state, l.relation::regclass::text as relation, l.mode, left(a.query, 200) as query
      from pg_locks l join pg_stat_activity a using (pid)
      where l.granted and a.pid <> pg_backend_pid()
        and l.relation::regclass::text in (${sql.join([...applicationTables])})
    `.execute(db);
    throw new Error(
      `test DDL gave up after lock_timeout ${lockTimeout}; another session holds a lock on an ` +
        `application table (a transaction left open?). Holders: ${JSON.stringify(holders.rows)}`,
      { cause: error },
    );
  }
}

/**
 * A seeded flow as migration 1700000000026 holds it: its row, pinned, in the
 * flows table's column names.
 */
export interface SeededFlow {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly source: "telflo" | "community";
  readonly author_name: string | null;
  readonly author_url: string | null;
  readonly signals: readonly string[];
  readonly tags: readonly string[];
  readonly yaml_content: string;
  readonly collector_distribution: string;
  readonly collector_version: string;
  readonly source_url: string | null;
  readonly published: boolean;
  readonly sort_order: number;
}

/** What migration 1700000000026 exports beside up and down. */
export interface FlowsMigration {
  /** The 13 seeded flows, frozen, in their sort order. */
  readonly seededFlows: readonly SeededFlow[];
  /** The insert of `flows`, on conflict (slug) do nothing, dollar-quoted; refuses a text holding its quoting tag. */
  flowsInsert(flows: readonly SeededFlow[]): string;
  /** The seeded flows' insert, as the migration runs it. */
  seededFlowsInsert(): string;
}

/**
 * Migration 1700000000026's module, by a dynamic import of a computed URL:
 * a static import would bring a file outside `src` (and with no types) into
 * the typecheck. The seeded flows' one copy is the migration's, which reads
 * no file; this hands it to tests and their fixtures.
 */
export async function loadFlowsMigration(): Promise<FlowsMigration> {
  const url = new URL("../migrations/1700000000026_flows.js", import.meta.url).href;
  return (await import(url)) as FlowsMigration;
}

/**
 * Inserts the seeded flows into `db` exactly as migration 1700000000026
 * does (on conflict (slug) do nothing), as the owner: `truncateAll` empties
 * them, and a test or the browser tests' global setup that needs them
 * calls this afterwards.
 */
export async function insertSeededFlows(db: Kysely<Database>): Promise<void> {
  const migration = await loadFlowsMigration();
  await sql.raw(migration.seededFlowsInsert()).execute(db);
}

/**
 * A seeded regex library entry as migration 1700000000031 holds it: its row,
 * in the test_regex table's column names, which is regex-library.ts's entry
 * (its `pattern` is `regex`).
 */
export interface SeededTestRegex {
  readonly name: string;
  readonly category: string;
  readonly description: string | null;
  readonly regex: string;
}

/** What migration 1700000000031 exports beside up and down. */
export interface TestRegexMigration {
  /** The 35 seeded entries, frozen, in regex-library.ts's order. */
  readonly seededTestRegexes: readonly SeededTestRegex[];
  /** The insert of `test_regex`, on conflict (name) do nothing, dollar-quoted; refuses a text holding its quoting tag. */
  testRegexesInsert(rows: readonly SeededTestRegex[]): string;
  /** The seeded entries' insert, as the migration runs it. */
  seededTestRegexesInsert(): string;
}

/**
 * Migration 1700000000031's module, by a dynamic import of a computed URL,
 * as `loadFlowsMigration`: the seeded entries' one copy is the migration's,
 * which reads no file; this hands it to tests and their fixtures.
 */
export async function loadTestRegexMigration(): Promise<TestRegexMigration> {
  const url = new URL("../migrations/1700000000031_test_regex.js", import.meta.url).href;
  return (await import(url)) as TestRegexMigration;
}

/**
 * Inserts the seeded regex library entries into `db` exactly as migration
 * 1700000000031 does (on conflict (name) do nothing), as the owner:
 * `truncateAll` empties them, and a test or the browser tests' global setup
 * that needs them calls this afterwards.
 */
export async function insertSeededTestRegexes(db: Kysely<Database>): Promise<void> {
  const migration = await loadTestRegexMigration();
  await sql.raw(migration.seededTestRegexesInsert()).execute(db);
}

export interface CreateUserWithOrganizationOverrides {
  user?: Partial<Insertable<UsersTable>>;
  organization?: Partial<Omit<Insertable<OrganizationsTable>, "owner_user_id">>;
  role?: OrganizationRole;
}

export interface UserWithOrganization {
  user: Selectable<UsersTable>;
  organization: Selectable<OrganizationsTable>;
  membership: Selectable<OrganizationMembersTable>;
}

/**
 * Inserts a user, an organization and their membership of it, in one
 * transaction: the shape registration creates. The user owns the
 * organization when it is personal; a group organization has no owner
 * (ck_organizations_owner_only_personal). It names no `kind`, so the user
 * is a person, and it runs on a database before migration 1700000000035 as
 * well (the migration tests' throwaway databases). The membership
 * invariant requires only that the user commit with at least one live
 * membership in a live organization, so this is not the only shape it
 * accepts: a service account's, one contributor membership in its
 * organization and no personal organization, is `addServiceAccount`'s.
 *
 * Defaults: a unique email, a verified user with accepted terms, and a
 * personal organization named by the lowercased email (as the API names a
 * new one) with an `admin` membership.
 */
export async function createUserWithOrganization(
  db: Kysely<Database>,
  overrides: CreateUserWithOrganizationOverrides = {},
): Promise<UserWithOrganization> {
  const email = overrides.user?.email ?? `user-${randomUUID()}@example.com`;
  return db.transaction().execute(async (transaction) => {
    const user = await transaction
      .insertInto("users")
      .values({
        email,
        email_verified_at: new Date(),
        accepted_terms_version: "2026-01-01",
        terms_accepted_at: new Date(),
        ...overrides.user,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const type = overrides.organization?.type ?? "personal";
    const organization = await transaction
      .insertInto("organizations")
      .values({
        name: email.toLowerCase(),
        ...overrides.organization,
        type,
        owner_user_id: type === "personal" ? user.id : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const membership = await transaction
      .insertInto("organization_members")
      .values({
        organization_id: organization.id,
        user_id: user.id,
        role: overrides.role ?? "admin",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { user, organization, membership };
  });
}

export interface AddMembershipInput {
  userId: string;
  /** An existing organization. When omitted, a new group organization is created. */
  organizationId?: string;
  role?: OrganizationRole;
}

export interface AddedMembership {
  organization: Selectable<OrganizationsTable>;
  membership: Selectable<OrganizationMembersTable>;
}

/**
 * Gives an existing user one more membership: in `organizationId`, or in a
 * new group organization when none is given. `createUserWithOrganization`
 * makes exactly one membership, and the membership invariant refuses to
 * delete a user's last one, so a test that removes a membership adds a
 * second one with this first.
 *
 * Defaults: role `admin`, and a group organization named
 * `group-<random uuid>`.
 */
export async function addMembership(db: Kysely<Database>, input: AddMembershipInput): Promise<AddedMembership> {
  return db.transaction().execute(async (transaction) => {
    const organization =
      input.organizationId === undefined
        ? await transaction
            .insertInto("organizations")
            .values({ name: `group-${randomUUID()}`, type: "group" })
            .returningAll()
            .executeTakeFirstOrThrow()
        : await transaction
            .selectFrom("organizations")
            .selectAll()
            .where("id", "=", input.organizationId)
            .executeTakeFirstOrThrow();

    const membership = await transaction
      .insertInto("organization_members")
      .values({ organization_id: organization.id, user_id: input.userId, role: input.role ?? "admin" })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { organization, membership };
  });
}

/**
 * Removes a membership softly, as an admin removing a member does: sets
 * `deleted_at` on the user's membership of the organization. The membership
 * invariant still applies at commit, so a test that removes a user's last
 * live membership in a live organization adds another first (or expects the
 * refusal).
 */
export async function removeMembership(
  db: Kysely<Database>,
  input: { userId: string; organizationId: string },
): Promise<Selectable<OrganizationMembersTable>> {
  return db
    .updateTable("organization_members")
    .set({ deleted_at: new Date() })
    .where("user_id", "=", input.userId)
    .where("organization_id", "=", input.organizationId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddInvitationInput
  extends Partial<Omit<Insertable<OrganizationInvitationsTable>, "organization_id">> {
  organizationId: string;
}

/**
 * Inserts an invitation into an existing organization, as the owner, past
 * row-level security. Any column may be given, `accepted_at` and
 * `revoked_at` included, to start from an accepted or cancelled one.
 *
 * Defaults: a pending contributor invitation to a unique address, a random
 * 64-character hex `token_hash` (the shape of a sha-256), no inviter, and an
 * expiry 7 days from now.
 */
export async function addInvitation(
  db: Kysely<Database>,
  { organizationId, ...overrides }: AddInvitationInput,
): Promise<Selectable<OrganizationInvitationsTable>> {
  return db
    .insertInto("organization_invitations")
    .values({
      organization_id: organizationId,
      email: `invitee-${randomUUID()}@example.com`,
      role: "contributor",
      token_hash: randomBytes(32).toString("hex"),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddQuickDeployLinkInput extends Partial<Omit<Insertable<QuickDeployLinksTable>, "organization_id">> {
  organizationId: string;
}

/**
 * Inserts a quick-deploy link into an existing organization, as the owner,
 * past row-level security. Any column may be given, to start from a revoked,
 * expired, downloaded or sealed one.
 *
 * Defaults: fresh opamp-server ids (fleet, group, default token), no
 * creator, a random 64-character hex `secret_hash` (the shape of a
 * sha-256), an All In One amd64 install in /etc/otelcol as a systemd
 * service with no variables, made now and expiring in 24 hours.
 */
export async function addQuickDeployLink(
  db: Kysely<Database>,
  { organizationId, ...overrides }: AddQuickDeployLinkInput,
): Promise<Selectable<QuickDeployLinksTable>> {
  const now = new Date();
  return db
    .insertInto("quick_deploy_links")
    .values({
      organization_id: organizationId,
      fleet_id: randomUUID(),
      group_id: randomUUID(),
      default_token_id: randomUUID(),
      secret_hash: randomBytes(32).toString("hex"),
      choices: JSON.stringify({
        method: "all-in-one",
        arch: "amd64",
        rootPath: "/etc/otelcol",
        executablePath: null,
        systemd: true,
        envNames: [],
      }),
      created_at: now,
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The reserved domain every service account's address is at, and nobody else's (migration 1700000000035). */
const SERVICE_ACCOUNT_DOMAIN = "service-accounts.telflo.invalid";

export interface AddServiceAccountInput {
  /** A live organization the account joins as a contributor, its only membership. */
  organizationId: string;
  /** Defaults to a unique `service-<random uuid>`. */
  name?: string;
  /** The admin who made it; none by default. */
  createdByUserId?: string | null;
  /** The account's (its user's) id; a fresh uuidv7 by default. */
  userId?: string;
  /** created_at and updated_at; now by default. */
  createdAt?: Date;
}

export interface AddedServiceAccount {
  user: Selectable<UsersTable>;
  serviceAccount: Selectable<ServiceAccountsTable>;
  membership: Selectable<OrganizationMembersTable>;
}

/**
 * Inserts a service account in the shape the API's create writes, as the
 * owner, in one transaction: a user of kind `service` at the reserved domain
 * (`<slug of the name>-<8 hex>@service-accounts.telflo.invalid`), verified,
 * with no password and no terms; its `service_accounts` row; and one
 * `contributor` membership in `organizationId`. No personal organization, no
 * settings, no identity, no session (the database refuses the last two). Only
 * on a database at migration 1700000000035 or later.
 */
export async function addServiceAccount(
  db: Kysely<Database>,
  { organizationId, name = `service-${randomUUID()}`, createdByUserId = null, userId, createdAt = new Date() }: AddServiceAccountInput,
): Promise<AddedServiceAccount> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const local = `${slug === "" ? "" : `${slug}-`}${randomBytes(4).toString("hex")}`;
  return db.transaction().execute(async (transaction) => {
    const user = await transaction
      .insertInto("users")
      .values({
        ...(userId === undefined ? {} : { id: userId }),
        email: `${local}@${SERVICE_ACCOUNT_DOMAIN}`,
        email_verified_at: createdAt,
        kind: "service",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const serviceAccount = await transaction
      .insertInto("service_accounts")
      .values({
        user_id: user.id,
        organization_id: organizationId,
        name,
        created_by_user_id: createdByUserId,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const membership = await transaction
      .insertInto("organization_members")
      .values({ organization_id: organizationId, user_id: user.id, role: "contributor" })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { user, serviceAccount, membership };
  });
}

export interface AddApiTokenInput extends Partial<Omit<Insertable<ApiTokensTable>, "organization_id" | "service_account_user_id">> {
  organizationId: string;
  /** An existing service account of `organizationId`. */
  serviceAccountUserId: string;
}

export interface AddedApiToken {
  apiToken: Selectable<ApiTokensTable>;
  /**
   * The token itself, built at run time: a secret like a bearer. A test
   * compares it or its hash, never prints it.
   */
  token: string;
}

/**
 * Inserts an API token on an existing service account, as the owner, past
 * row-level security, and hands back the token with the row: `tf_` and the
 * base64url of 32 random bytes, stored as its SHA-256 (hex) and its first
 * 11 characters, as the API's create mints it. Any column may be
 * given, to start from a revoked, expired or used one; a given `token_hash`
 * or `token_prefix` replaces the minted token's (for a constraint's test),
 * and the token handed back then no longer matches the row.
 *
 * Defaults: a unique name, read access, no expiry, no creator, made now.
 */
export async function addApiToken(
  db: Kysely<Database>,
  { organizationId, serviceAccountUserId, ...overrides }: AddApiTokenInput,
): Promise<AddedApiToken> {
  const token = `tf_${randomBytes(32).toString("base64url")}`;
  const access: ApiTokenAccess = "read";
  const apiToken = await db
    .insertInto("api_tokens")
    .values({
      organization_id: organizationId,
      service_account_user_id: serviceAccountUserId,
      name: `token-${randomUUID()}`,
      token_hash: createHash("sha256").update(token).digest("hex"),
      token_prefix: token.slice(0, 11),
      access,
      created_at: new Date(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { apiToken, token };
}

export interface AddPersonalApiTokenInput extends Partial<Omit<Insertable<PersonalApiTokensTable>, "user_id">> {
  /** An existing user: a person's for a token the lookup answers. */
  userId: string;
}

export interface AddedPersonalApiToken {
  personalApiToken: Selectable<PersonalApiTokensTable>;
  /** The token itself, built at run time: a test compares it or its hash, never prints it. */
  token: string;
}

/**
 * Inserts a person's own API token, as the owner, past row-level security,
 * and hands back the token with the row, minted as `addApiToken`'s. Any
 * column may be given (a revoked or expired one; a given `token_hash` or
 * `token_prefix` replaces the minted token's).
 *
 * Defaults: a unique name, read access, no expiry, made now.
 */
export async function addPersonalApiToken(
  db: Kysely<Database>,
  { userId, ...overrides }: AddPersonalApiTokenInput,
): Promise<AddedPersonalApiToken> {
  const token = `tf_${randomBytes(32).toString("base64url")}`;
  const access: ApiTokenAccess = "read";
  const personalApiToken = await db
    .insertInto("personal_api_tokens")
    .values({
      user_id: userId,
      name: `token-${randomUUID()}`,
      token_hash: createHash("sha256").update(token).digest("hex"),
      token_prefix: token.slice(0, 11),
      access,
      created_at: new Date(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { personalApiToken, token };
}

export interface AddUserFeedbackInput extends Partial<Omit<Insertable<UserFeedbackTable>, "user_id" | "organization_id">> {
  /** The sender. */
  userId: string;
  /** The organization they were acting in. */
  organizationId: string;
}

/**
 * A feedback item, pending unless `handled_at` and `outcome` are given. Its
 * text defaults to a fixed sentence holding no one's data; created now. As
 * the owner (the API's role may only insert, without RETURNING): pass
 * `ownerDb`.
 */
export async function addUserFeedback(
  db: Kysely<Database>,
  { userId, organizationId, ...overrides }: AddUserFeedbackInput,
): Promise<Selectable<UserFeedbackTable>> {
  return db
    .insertInto("user_feedback")
    .values({
      id: randomUUID(),
      user_id: userId,
      organization_id: organizationId,
      text: "A test's feedback.",
      created_at: new Date(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddConfigurationInput extends Partial<Omit<Insertable<ConfigurationsTable>, "organization_id">> {
  organizationId: string;
  /**
   * `false` leaves `collector_distribution` out, for a schema before
   * migration 1700000000023 (the migration tests' throwaway databases),
   * where neither it nor the catalogue exists.
   */
  collector?: false;
}

/** The catalogue's default distribution, as `db` holds it. */
async function defaultCollectorDistribution(db: Kysely<Database>): Promise<string> {
  const row = await db
    .selectFrom("collector_distributions")
    .select("id")
    .where("is_default", "=", true)
    .executeTakeFirstOrThrow(() => new Error("the collector catalogue has no default distribution: is it synced?"));
  return row.id;
}

/** `distribution`'s default version in the catalogue, as `db` holds it. */
async function defaultCollectorVersion(db: Kysely<Database>, distribution: string): Promise<string> {
  const row = await db
    .selectFrom("collector_versions")
    .select("version")
    .where("distribution", "=", distribution)
    .where("is_default", "=", true)
    .executeTakeFirstOrThrow(
      () => new Error(`the collector catalogue has no default version of ${distribution}: is it synced?`),
    );
  return row.version;
}

/**
 * The catalogue's default distribution and its default version, as `db` holds
 * them: what a test writing a configuration or a version by hand names, so
 * that no test holds a second default (a constant `0.162.0`) beside the
 * catalogue's.
 */
export async function catalogueDefaults(db: Kysely<Database>): Promise<{ distribution: string; version: string }> {
  const distribution = await defaultCollectorDistribution(db);
  return { distribution, version: await defaultCollectorVersion(db, distribution) };
}

/**
 * Inserts a configuration into an existing organization, as the owner, past
 * row-level security. Any column may be given, `deleted_at` included, to
 * start from a deleted one.
 *
 * Defaults: a unique name, no description, no creator, `created_at` and
 * `updated_at` both the current time, and the catalogue's default
 * distribution, read from the catalogue's table (never a constant). The table
 * has no default for any of them (the API writes them), so the fixture writes
 * them.
 *
 * With no creator and no published version, the configuration is visible to
 * no one through the API's role (migration 021): a test that reads it as a
 * member names that member as `created_by_user_id`, or publishes a version
 * (`addConfigurationVersion`'s `publishedAt`).
 */
export async function addConfiguration(
  db: Kysely<Database>,
  { organizationId, collector, ...overrides }: AddConfigurationInput,
): Promise<Selectable<ConfigurationsTable>> {
  const now = new Date();
  const distribution =
    collector === false || overrides.collector_distribution !== undefined
      ? {}
      : { collector_distribution: await defaultCollectorDistribution(db) };
  return db
    .insertInto("configurations")
    .values({
      organization_id: organizationId,
      name: `configuration-${randomUUID()}`,
      created_at: now,
      updated_at: now,
      ...distribution,
      ...overrides,
    } as Insertable<ConfigurationsTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddConfigurationVersionInput
  extends Partial<
    Omit<
      Insertable<ConfigurationVersionsTable>,
      "configuration_id" | "organization_id" | "published_at" | "published_by_user_id" | "publication_id"
    >
  > {
  configurationId: string;
  /**
   * The configuration's organization. Given separately so a test can name
   * another one, which the composite foreign key refuses.
   */
  organizationId: string;
  /**
   * Publishes the version: sets `published_at`. Left out, the version is a
   * draft.
   */
  publishedAt?: Date | null;
  /**
   * The publisher, `published_by_user_id`. Defaults to none. Only with a
   * `publishedAt`: a draft with a publisher is refused (23514,
   * ck_configuration_versions_publisher_only_when_published).
   */
  publishedByUserId?: string | null;
  /**
   * The snapshot's id, `publication_id`. Defaults to a random one when
   * `publishedAt` is given (the table requires both or neither), and to none
   * otherwise. Pass `null` with a `publishedAt`, or an id without one, to
   * reach ck_configuration_versions_published_at_publication_id.
   */
  publicationId?: string | null;
  /**
   * `false` leaves `collector_distribution` and `collector_version` out, for
   * a schema before migration 1700000000023, where they don't exist.
   */
  collector?: false;
}

/**
 * A version's default pin, from the catalogue's tables: the
 * configuration's distribution (the default distribution when there is no
 * such configuration, so a test of the configuration's foreign key still
 * reaches it) and that distribution's default version.
 */
async function defaultCollectorPin(
  db: Kysely<Database>,
  configurationId: string | null,
  distribution: string | undefined,
): Promise<{ collector_distribution: string; collector_version: string }> {
  const configuration =
    distribution === undefined && configurationId !== null
      ? await db
          .selectFrom("configurations")
          .select("collector_distribution")
          .where("id", "=", configurationId)
          .executeTakeFirst()
      : undefined;
  const collectorDistribution =
    distribution ?? configuration?.collector_distribution ?? (await defaultCollectorDistribution(db));
  return {
    collector_distribution: collectorDistribution,
    collector_version: await defaultCollectorVersion(db, collectorDistribution),
  };
}

/**
 * Inserts a version of an existing configuration, as the owner, past
 * row-level security. Any column may be given; the publish columns through
 * `publishedAt`, `publishedByUserId` and `publicationId`. Pass the owner's
 * connection: the API's role can't insert a published version at all
 * (migration 021), only publish a draft by an update.
 *
 * Defaults: version 1, empty YAML, no label (pass `label` to name it), no
 * creator, a draft, `created_at` and `updated_at` both the current time, and
 * the configuration's distribution pinned to its default version, read from
 * the catalogue's tables (never a constant). The table has no default for the
 * YAML, either timestamp or the pin (the API always writes them), so the
 * fixture writes them. `nodes`, `edges` and `pipelines` take the table's
 * `'[]'`; a test that gives one passes `JSON.stringify(array)`, as the
 * repository does.
 */
export async function addConfigurationVersion(
  db: Kysely<Database>,
  {
    configurationId,
    organizationId,
    publishedAt,
    publishedByUserId,
    publicationId = publishedAt === undefined || publishedAt === null ? undefined : randomUUID(),
    collector,
    ...overrides
  }: AddConfigurationVersionInput,
): Promise<Selectable<ConfigurationVersionsTable>> {
  const now = new Date();
  const pin =
    collector === false || (overrides.collector_distribution !== undefined && overrides.collector_version !== undefined)
      ? {}
      : await defaultCollectorPin(db, configurationId, overrides.collector_distribution);
  // Only the publish columns given are written, so the fixture still inserts
  // into a schema before migration 020 (the migration tests' throwaway
  // databases), where they don't exist.
  const publish = {
    ...(publishedAt === undefined ? {} : { published_at: publishedAt }),
    ...(publishedByUserId === undefined ? {} : { published_by_user_id: publishedByUserId }),
    ...(publicationId === undefined ? {} : { publication_id: publicationId }),
  };
  return db
    .insertInto("configuration_versions")
    .values({
      configuration_id: configurationId,
      organization_id: organizationId,
      version_number: 1,
      yaml_content: "",
      created_at: now,
      updated_at: now,
      ...pin,
      ...publish,
      ...overrides,
    } as Insertable<ConfigurationVersionsTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddConfigurationVersionSelectionInput
  extends Partial<
    Omit<
      Insertable<ConfigurationVersionSelectionsTable>,
      "organization_id" | "configuration_id" | "version_id" | "user_id"
    >
  > {
  /**
   * The selection's organization, configuration and version, given
   * separately so a test can name a mismatched triple, which the composite
   * foreign keys refuse.
   */
  organizationId: string;
  configurationId: string;
  versionId: string;
  userId: string;
}

/**
 * Inserts a person's selected version of a configuration, as the owner, past
 * row-level security. Any column may be given.
 *
 * Defaults: `selected_at` the current time. The table has no default for it
 * (the API writes it from its clock), so the fixture writes it.
 */
export async function addConfigurationVersionSelection(
  db: Kysely<Database>,
  { organizationId, configurationId, versionId, userId, ...overrides }: AddConfigurationVersionSelectionInput,
): Promise<Selectable<ConfigurationVersionSelectionsTable>> {
  return db
    .insertInto("configuration_version_selections")
    .values({
      organization_id: organizationId,
      configuration_id: configurationId,
      version_id: versionId,
      user_id: userId,
      selected_at: new Date(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddTestInputFileInput
  extends Partial<Omit<Insertable<TestInputFilesTable>, "organization_id" | "owner_user_id">> {
  organizationId: string;
  /** The person whose file it is: the only one who sees it. */
  ownerUserId: string;
}

/**
 * Inserts a test file's row (migration 1700000000028), as the owner, past
 * row-level security; no bytes are written anywhere. Any column may be
 * given.
 *
 * Defaults: a unique display name, `input.json`, `application/json`, no
 * description, 0 bytes and the SHA-256 of nothing.
 */
export async function addTestInputFile(
  db: Kysely<Database>,
  { organizationId, ownerUserId, ...overrides }: AddTestInputFileInput,
): Promise<Selectable<TestInputFilesTable>> {
  return db
    .insertInto("test_input_files")
    .values({
      organization_id: organizationId,
      owner_user_id: ownerUserId,
      display_name: `file-${randomUUID()}`,
      file_name: "input.json",
      content_type: "application/json",
      size_bytes: 0,
      sha256: createHash("sha256").digest(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * What only the tables' owner may write on a run's insert: the API's role
 * inserts a queued run at `now()` and nothing else, but a test of the queue
 * needs runs queued at chosen times, running or finished.
 */
export interface TestRunState {
  status: TestRunStatus;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  lease_id: string | null;
  lease_expires_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  /**
   * The rules' results (migration 1700000000030), a JSON text, as the
   * dispatcher's finish writes them: one per rule of the run's
   * `validation_rules`, the status following them
   * (ck_test_runs_validation_outcome).
   */
  validation_results: string | null;
}

export interface AddTestRunInput
  extends Partial<
    Omit<
      Insertable<TestRunsTable>,
      "organization_id" | "configuration_id" | "configuration_version_id" | "queued_by_user_id"
    >
  > {
  organizationId: string;
  /** Both null for a YAML run (migration 1700000000040), both set otherwise. */
  configurationId: string | null;
  configurationVersionId: string | null;
  /** The member who queued it; null for an account since hard-deleted. */
  queuedByUserId: string | null;
  /** The status, times, lease and error, which the table's checks tie together. Defaults to queued now. */
  state?: Partial<TestRunState>;
}

/**
 * Inserts a test run (migration 1700000000028), as the owner, past
 * row-level security: any snapshot column may be given, and through
 * `state` a queued time, a status, a lease and an error. No file is written
 * anywhere.
 *
 * Defaults: a `logs` run of 5 seconds over `receivers: {}`, an input
 * `input.json` of 0 bytes, queued now, pinned to the configuration's
 * distribution (a YAML run's: the catalogue's default) and its default
 * version from the catalogue's tables (never a constant).
 */
export async function addTestRun(
  db: Kysely<Database>,
  { organizationId, configurationId, configurationVersionId, queuedByUserId, state = {}, ...overrides }: AddTestRunInput,
): Promise<Selectable<TestRunsTable>> {
  const pin =
    overrides.collector_distribution !== undefined && overrides.collector_version !== undefined
      ? {}
      : await defaultCollectorPin(db, configurationId, overrides.collector_distribution);
  return db
    .insertInto("test_runs")
    .values({
      organization_id: organizationId,
      configuration_id: configurationId,
      configuration_version_id: configurationVersionId,
      queued_by_user_id: queuedByUserId,
      yaml: "receivers: {}\n",
      target_pipeline: "logs",
      signal: "logs",
      duration_seconds: 5,
      input_name: "input.json",
      input_size_bytes: 0,
      ...pin,
      ...overrides,
      // The state's columns are the owner's alone: the insert type leaves them out.
      ...(state as Record<string, never>),
    } as Insertable<TestRunsTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddTestSuiteInput
  extends Partial<
    Omit<Insertable<TestSuitesTable>, "organization_id" | "configuration_id" | "configuration_version_id">
  > {
  organizationId: string;
  configurationId: string;
  configurationVersionId: string;
}

/**
 * Inserts a test suite (migration 1700000000029), as the owner, past
 * row-level security. Any column may be given.
 *
 * Defaults: a unique name, no description, no creator, created and updated
 * now.
 */
export async function addTestSuite(
  db: Kysely<Database>,
  { organizationId, configurationId, configurationVersionId, ...overrides }: AddTestSuiteInput,
): Promise<Selectable<TestSuitesTable>> {
  const at = overrides.created_at ?? new Date();
  return db
    .insertInto("test_suites")
    .values({
      organization_id: organizationId,
      configuration_id: configurationId,
      configuration_version_id: configurationVersionId,
      name: `suite-${randomUUID()}`,
      created_at: at,
      updated_at: at,
      ...overrides,
    } as Insertable<TestSuitesTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddTestDefinitionInputInput
  extends Partial<Omit<Insertable<TestDefinitionInputsTable>, "organization_id" | "configuration_id">> {
  organizationId: string;
  configurationId: string;
}

/**
 * Inserts a test definition's input row (migration 1700000000029), as the
 * owner, past row-level security; no bytes are written anywhere.
 *
 * Defaults: `input.json`, `application/json`, 0 bytes and the SHA-256 of
 * nothing.
 */
export async function addTestDefinitionInput(
  db: Kysely<Database>,
  { organizationId, configurationId, ...overrides }: AddTestDefinitionInputInput,
): Promise<Selectable<TestDefinitionInputsTable>> {
  return db
    .insertInto("test_definition_inputs")
    .values({
      organization_id: organizationId,
      configuration_id: configurationId,
      file_name: "input.json",
      content_type: "application/json",
      size_bytes: 0,
      sha256: createHash("sha256").digest(),
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddTestDefinitionInput
  extends Partial<
    Omit<
      Insertable<TestDefinitionsTable>,
      "organization_id" | "configuration_id" | "configuration_version_id" | "test_suite_id" | "input_id"
    >
  > {
  organizationId: string;
  configurationId: string;
  configurationVersionId: string;
  testSuiteId: string;
  inputId: string;
}

/**
 * Inserts a test definition (migration 1700000000029), as the owner, past
 * row-level security. Any column may be given.
 *
 * Defaults: a unique name, no description, the `logs` pipeline for 5
 * seconds, no creator, created now.
 */
export async function addTestDefinition(
  db: Kysely<Database>,
  { organizationId, configurationId, configurationVersionId, testSuiteId, inputId, ...overrides }: AddTestDefinitionInput,
): Promise<Selectable<TestDefinitionsTable>> {
  return db
    .insertInto("test_definitions")
    .values({
      organization_id: organizationId,
      configuration_id: configurationId,
      configuration_version_id: configurationVersionId,
      test_suite_id: testSuiteId,
      input_id: inputId,
      name: `definition-${randomUUID()}`,
      target_pipeline: "logs",
      signal: "logs",
      duration_seconds: 5,
      created_at: new Date(),
      ...overrides,
    } as Insertable<TestDefinitionsTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Inserts a live test template (migration 1700000000029), global, as the
 * owner; no bytes are written anywhere. Any column may be given.
 *
 * Defaults: a unique name, no description, an `otlp` receiver's `logs`
 * sample `sample.json` of 0 bytes, no creator, created and updated now.
 */
export async function addTestTemplate(
  db: Kysely<Database>,
  overrides: Partial<Insertable<TestTemplatesTable>> = {},
): Promise<Selectable<TestTemplatesTable>> {
  const at = overrides.created_at ?? new Date();
  return db
    .insertInto("test_templates")
    .values({
      name: `template-${randomUUID()}`,
      receiver_type: "otlp",
      signal: "logs",
      file_name: "sample.json",
      content_type: "application/json",
      size_bytes: 0,
      sha256: createHash("sha256").digest(),
      created_at: at,
      updated_at: at,
      ...overrides,
    } as Insertable<TestTemplatesTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A library file's row, as the API writes one: no bytes in the file store. */
export async function addLibraryFile(
  db: Kysely<Database>,
  overrides: Partial<Insertable<LibraryFilesTable>> = {},
): Promise<Selectable<LibraryFilesTable>> {
  const at = overrides.created_at ?? new Date();
  return db
    .insertInto("library_files")
    .values({
      name: `library-file-${randomUUID()}`,
      file_name: "sample.txt",
      size_bytes: 0,
      sha256: createHash("sha256").digest(),
      created_at: at,
      updated_at: at,
      ...overrides,
    } as Insertable<LibraryFilesTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddValidationPipelineInput
  extends Partial<
    Omit<Insertable<ValidationPipelinesTable>, "organization_id" | "configuration_id" | "configuration_version_id">
  > {
  organizationId: string;
  configurationId: string;
  configurationVersionId: string;
}

/**
 * Inserts a validation pipeline (migration 1700000000030), as the owner,
 * past row-level security. Any column may be given.
 *
 * Defaults: the `logs` pipeline and signal, no creator, created now.
 */
export async function addValidationPipeline(
  db: Kysely<Database>,
  { organizationId, configurationId, configurationVersionId, ...overrides }: AddValidationPipelineInput,
): Promise<Selectable<ValidationPipelinesTable>> {
  return db
    .insertInto("validation_pipelines")
    .values({
      organization_id: organizationId,
      configuration_id: configurationId,
      configuration_version_id: configurationVersionId,
      pipeline_name: "logs",
      signal: "logs",
      created_at: new Date(),
      ...overrides,
    } as Insertable<ValidationPipelinesTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface AddValidationRuleInput
  extends Partial<
    Omit<
      Insertable<ValidationRulesTable>,
      "organization_id" | "configuration_id" | "configuration_version_id" | "validation_pipeline_id"
    >
  > {
  /**
   * The rule's organization, configuration, version and validation
   * pipeline, given separately so a test can name a mismatched set, which
   * the composite foreign key refuses.
   */
  organizationId: string;
  configurationId: string;
  configurationVersionId: string;
  validationPipelineId: string;
}

/**
 * Inserts a validation rule (migration 1700000000030), as the owner, past
 * row-level security. Any column may be given.
 *
 * Defaults: a `contains_text` rule over the output, a unique pattern,
 * position 1 (a second rule in one pipeline names its own), no name or
 * description, no creator, created and updated now.
 */
export async function addValidationRule(
  db: Kysely<Database>,
  { organizationId, configurationId, configurationVersionId, validationPipelineId, ...overrides }: AddValidationRuleInput,
): Promise<Selectable<ValidationRulesTable>> {
  const at = overrides.created_at ?? new Date();
  return db
    .insertInto("validation_rules")
    .values({
      organization_id: organizationId,
      configuration_id: configurationId,
      configuration_version_id: configurationVersionId,
      validation_pipeline_id: validationPipelineId,
      position: 1,
      kind: "contains_text",
      target: "output",
      pattern: `pattern-${randomUUID()}`,
      created_at: at,
      updated_at: at,
      ...overrides,
    } as Insertable<ValidationRulesTable>)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Makes every insert into `table` fail, inside whatever transaction performs
 * it, for the duration of `body`: the honest way to prove a multi-insert
 * transaction is atomic against the real database. `raise` is the PL/pgSQL
 * statement the trigger runs, typically a `raise exception ...`; a trigger
 * that waits (a lock it takes) sets its own `lock_timeout` first.
 *
 * The trigger and its function are dropped afterwards whatever happens, so
 * no later test inherits them: an insert the trigger left waiting would
 * hold the drop, so such inserts are cancelled first (their transactions
 * roll back), and the drop is tried again only if something was cancelled.
 * The clean-up stays well under vitest's 5 s test timeout, so a drop that
 * can't finish fails the test with the sessions holding the table.
 *
 * Nesting is refused, loudly: a trigger already there is another
 * withFailingInsert's on the same table, still running. A killed run's
 * leftovers are dropped once per run, by the global setup
 * (`dropFailingInsertLeftovers`), never here. So the names `test_fail_*`
 * are reserved for withFailingInsert: the global setup drops every trigger
 * and function so named, and nothing else may use them.
 *
 * When the body fails and the clean-up then fails too, an AggregateError
 * is thrown with the clean-up's message (it names what holds the table),
 * the body's error as its `cause`, and both errors, the clean-up's first
 * (with its own `cause`, the lock timeout's), as its `errors`, so nothing
 * is lost.
 */
export async function withFailingInsert(
  db: Kysely<Database>,
  table: (typeof applicationTables)[number],
  raise: string,
  body: () => Promise<void>,
): Promise<void> {
  const name = failingInsertName(table);
  // The function and trigger are created in one transaction, so a lock
  // timeout on the trigger leaves neither behind.
  await withTestLockTimeout(db, async (transaction) => {
    const existing = await sql<{ name: string }>`
      select t.tgname as name from pg_trigger t
      where t.tgname = ${name} and t.tgrelid = ${table}::regclass
      union all
      select p.proname from pg_proc p where p.proname = ${name} and pg_function_is_visible(p.oid)
    `.execute(transaction);
    if (existing.rows.length > 0) {
      throw new Error(
        `withFailingInsert on ${table}: ${name} already exists. withFailingInsert doesn't nest; ` +
          "if no other is running, a killed run left it, which the test run's global setup drops.",
      );
    }
    await sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin ${raise}; end $$`).execute(transaction);
    await sql
      .raw(`create trigger ${name} before insert on ${table} for each row execute function ${name}()`)
      .execute(transaction);
  });
  let failure: { error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  try {
    await dropFailingInsert(db, table, name);
  } catch (dropError) {
    if (failure === undefined) throw dropError;
    const message = dropError instanceof Error ? dropError.message : String(dropError);
    throw new AggregateError(
      [dropError, failure.error],
      `${message} (withFailingInsert's body had failed first: its error is this one's cause; errors holds the clean-up's, then the body's)`,
      { cause: failure.error },
    );
  }
  if (failure !== undefined) throw failure.error;
}

/** The trigger's and its function's name: `test_fail_<table>_insert`. */
function failingInsertName(table: string): string {
  return `test_fail_${table}_insert`;
}

/** How many times withFailingInsert's clean-up tries its drop, each after cancelling what waits. */
const FAILING_INSERT_DROP_ATTEMPTS = 3;

/**
 * The drop's own lock timeout: its attempts, all of them, stay under
 * vitest's 5 s test timeout (with the test's own work before them), so a
 * drop that gives up reports its holders rather than the test timing out.
 */
const FAILING_INSERT_DROP_LOCK_TIMEOUT = "1s";

/**
 * withFailingInsert's clean-up: the trigger and its function dropped in one
 * transaction (both or neither), after cancelling every other session of
 * this database that waits on a lock while holding `RowExclusiveLock` on
 * `table`: an insert the trigger left waiting (on an advisory lock it takes,
 * or any other). A session that only reads the table (`AccessShareLock`) is
 * never cancelled: it holds the drop, which then fails naming it. The drop
 * is tried again on a lock timeout only when its attempt cancelled
 * something (a cancelled insert's rollback racing the drop).
 */
async function dropFailingInsert(
  db: Kysely<Database>,
  table: (typeof applicationTables)[number],
  name: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let cancelled = 0;
    try {
      const cancels = await sql<{ cancelled: boolean }>`
        select pg_cancel_backend(a.pid) as cancelled
        from pg_stat_activity a
        where a.datname = current_database() and a.pid <> pg_backend_pid() and a.wait_event_type = 'Lock'
          and exists (
            select 1 from pg_locks l
            where l.pid = a.pid and l.granted and l.locktype = 'relation'
              and l.relation = ${table}::regclass and l.mode = 'RowExclusiveLock'
          )
      `.execute(db);
      cancelled = cancels.rows.filter((row) => row.cancelled).length;
      await withTestLockTimeout(
        db,
        async (transaction) => {
          await sql.raw(`drop trigger if exists ${name} on ${table}`).execute(transaction);
          await sql.raw(`drop function if exists ${name}()`).execute(transaction);
        },
        FAILING_INSERT_DROP_LOCK_TIMEOUT,
      );
      return;
    } catch (error) {
      if (cancelled === 0 || attempt >= FAILING_INSERT_DROP_ATTEMPTS) throw error;
    }
  }
}

/**
 * Drops every withFailingInsert trigger and function (`test_fail_%`) a
 * killed run left in the test database `ownerUrl` names, as its owner. Run
 * once per test run, by the global setup, before any test: never while a
 * test may hold one. It refuses a URL whose database doesn't end in `_test`
 * (testMigrationDatabaseUrl's guard), whoever calls it.
 */
export async function dropFailingInsertLeftovers(ownerUrl: string): Promise<void> {
  const guarded = testMigrationDatabaseUrl({ TELFLO_TEST_MIGRATION_DATABASE_URL: ownerUrl });
  const db = createDb(createPool(guarded));
  try {
    await withTestLockTimeout(db, async (transaction) => {
      const triggers = await sql<{ trigger: string; table: string }>`
        select t.tgname as trigger, c.relname as table
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and t.tgname like 'test\\_fail\\_%' and pg_table_is_visible(c.oid)
      `.execute(transaction);
      for (const { trigger, table } of triggers.rows) {
        await sql`drop trigger if exists ${sql.id(trigger)} on ${sql.table(table)}`.execute(transaction);
      }
      const functions = await sql<{ name: string }>`
        select p.proname as name from pg_proc p
        where p.proname like 'test\\_fail\\_%' and pg_function_is_visible(p.oid)
      `.execute(transaction);
      for (const { name } of functions.rows) {
        await sql`drop function if exists ${sql.id(name)}()`.execute(transaction);
      }
    });
  } finally {
    await db.destroy();
  }
}

/**
 * Restores the grants a test takes away for a moment, which a killed run would
 * leave taken in the test database `ownerUrl` names: the application role's on
 * user_settings (migration 009's default privileges), which
 * sessions/routes.integration.test.ts revokes to make the theme's read fail
 * (left revoked, every later run's /me would answer 500), and its INSERT on
 * audit_events (migration 009's), which the SystemRepository's test of a 42501
 * that isn't the gate's revokes. Idempotent: granting what is held changes
 * nothing. Run once per test run by the global setup, beside
 * dropFailingInsertLeftovers, before any test. It refuses a URL whose database
 * doesn't end in `_test` (testMigrationDatabaseUrl's guard), whoever calls it.
 */
export async function restoreRevokedGrantLeftovers(ownerUrl: string): Promise<void> {
  const guarded = testMigrationDatabaseUrl({ TELFLO_TEST_MIGRATION_DATABASE_URL: ownerUrl });
  const db = createDb(createPool(guarded));
  try {
    await sql`grant select, insert, update, delete on user_settings to ${sql.id(APPLICATION_ROLE)}`.execute(db);
    // The SystemRepository's test of a 42501 that isn't the gate's takes this INSERT for a moment.
    await sql`grant insert on audit_events to ${sql.id(APPLICATION_ROLE)}`.execute(db);
  } finally {
    await db.destroy();
  }
}
