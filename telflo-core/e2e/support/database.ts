import { randomBytes, randomUUID } from "node:crypto";
import {
  createDb,
  createPool,
  type CollectorDistributionsTable,
  type CollectorVersionsTable,
  type ConfigurationsTable,
  type ConfigurationVersionSelectionsTable,
  type ConfigurationVersionsTable,
  type Database,
  type FlowsTable,
  type OrganizationMembersTable,
  type OrganizationRole,
  type SessionsTable,
  type UserIdentitiesTable,
  type UsersTable,
} from "@telflo/db";
import { addConfiguration, addConfigurationVersion, addInvitation, addMembership, createUserWithOrganization } from "@telflo/db/testing";
import { sql, type Kysely, type Selectable } from "kysely";
import { hashPassword } from "../../apps/api/src/modules/identity/password.js";
import { hashToken } from "../../apps/api/src/modules/identity/tokens.js";
import { e2eOwnerDatabaseUrl } from "./environment.js";

// Direct access to the E2E database, as the tables' owner, for seeding users
// and checking what the API wrote. Never truncates: global-setup.ts empties it once per run, and
// each test works only with users it seeded itself, so tests and browsers run
// in parallel.

let database: Kysely<Database> | undefined;

/** One pool per Playwright worker, made on first use; the worker's exit ends it. */
function db(): Kysely<Database> {
  database ??= createDb(createPool(e2eOwnerDatabaseUrl()));
  return database;
}

export interface SeededUser {
  email: string;
  password: string;
  userId: string;
  /** The personal organization's name, as the sidebar footer shows it. */
  organizationName: string;
  /** The personal organization's id. */
  organizationId: string;
}

/**
 * An address no other test uses. `@gmail.com` is one Google is
 * authoritative for (D2c Ruling 7), so the fake provider's sign-in with it
 * can create, link or take over; `@example.com` is not.
 */
export function uniqueEmail(domain: "gmail.com" | "example.com" = "example.com"): string {
  return `e2e-${randomUUID()}@${domain}`;
}

/**
 * A user with a personal organization and a known password: the shape
 * registration and verification leave behind, without going through email.
 * `verified: false` leaves the email unconfirmed, as registration alone does.
 * `termsVersion` is the accepted terms version (default: the current one).
 * The address is unique unless one is given, so no two tests share a user.
 */
export async function seedUser({
  password,
  verified = true,
  email = uniqueEmail(),
  termsVersion,
}: {
  password: string;
  verified?: boolean;
  email?: string;
  termsVersion?: string;
}): Promise<SeededUser> {
  const { user, organization } = await createUserWithOrganization(db(), {
    user: {
      email,
      password_hash: await hashPassword(password),
      ...(verified ? {} : { email_verified_at: null }),
      ...(termsVersion === undefined ? {} : { accepted_terms_version: termsVersion }),
    },
  });
  return { email, password, userId: user.id, organizationName: organization.name, organizationId: organization.id };
}

export interface SeededMembership {
  organizationId: string;
  /** The organization's name, as the sidebar footer and its popover show it. */
  organizationName: string;
}

/**
 * Adds a member by SQL, as the tables' owner, for tests about something other
 * than joining (invitations.e2e.ts joins through D6's invitations). With no
 * `organizationId`, a new group organization (named `group-<random uuid>`, so
 * no two tests share one) is created with the user as its first member. The
 * user's sessions stay where they are: switching is the test's business.
 */
export async function addMember({
  userId,
  organizationId,
  role = "admin",
}: {
  userId: string;
  organizationId?: string;
  role?: OrganizationRole;
}): Promise<SeededMembership> {
  const { organization } = await addMembership(db(), {
    userId,
    role,
    ...(organizationId === undefined ? {} : { organizationId }),
  });
  return { organizationId: organization.id, organizationName: organization.name };
}

/** Every user row with this email (any case), live or deleted. */
export async function findUsersByEmail(email: string): Promise<Selectable<UsersTable>[]> {
  return db().selectFrom("users").selectAll().where((eb) => eb(eb.fn("lower", ["email"]), "=", email.toLowerCase())).execute();
}

/** The user's linked provider identities. */
export async function findIdentities(userId: string): Promise<Selectable<UserIdentitiesTable>[]> {
  return db().selectFrom("user_identities").selectAll().where("user_id", "=", userId).execute();
}

/** The user's organization memberships. */
export async function findMemberships(userId: string): Promise<Selectable<OrganizationMembersTable>[]> {
  return db().selectFrom("organization_members").selectAll().where("user_id", "=", userId).execute();
}

/** The user's session rows, oldest first. */
export async function findSessions(userId: string): Promise<Selectable<SessionsTable>[]> {
  return db().selectFrom("sessions").selectAll().where("user_id", "=", userId).orderBy("created_at").execute();
}

/**
 * Sets a session's sign-in IP address (D21 decision 40), for the privacy
 * checks: the browser tests all sign in from the loopback, so a test writes
 * an address of its own (from TEST-NET-3, 203.0.113.0/24, never routed) and
 * then looks for it where it must not be.
 */
export async function setSessionIpAddress(sessionId: string, ipAddress: string): Promise<void> {
  await db().updateTable("sessions").set({ ip_address: ipAddress }).where("id", "=", sessionId).execute();
}

/**
 * Links a provider identity to the user by SQL, as a past link or a
 * federated sign-up leaves it, for tests about something other than
 * linking (D21's unlink and `identity_in_use`).
 */
export async function seedIdentity({
  userId,
  subject,
  email,
  provider = "google",
}: {
  userId: string;
  subject: string;
  email: string;
  provider?: string;
}): Promise<void> {
  await db()
    .insertInto("user_identities")
    .values({ user_id: userId, provider, provider_subject: subject, email })
    .execute();
}

/**
 * Removes the user's password, as an account that signs in with Google
 * holds none. Its live sessions stay: a test signs in first, with the
 * password, then removes it, to reach Settings as a password-less account.
 */
export async function removePassword(userId: string): Promise<void> {
  await db().updateTable("users").set({ password_hash: null }).where("id", "=", userId).execute();
}

/** The user's stored theme (D21 decision 18), or undefined while there is no settings row (the default, Dark). */
export async function findStoredTheme(userId: string): Promise<string | undefined> {
  const row = await db().selectFrom("user_settings").select("theme").where("user_id", "=", userId).executeTakeFirst();
  return row?.theme;
}

/**
 * Revokes every live session of the user, as signing out everywhere does:
 * the refresh token still sits in the browser, but the API refuses it.
 */
export async function revokeSessions(userId: string): Promise<void> {
  await db()
    .updateTable("sessions")
    .set({ revoked_at: new Date(), revoked_reason: "sign_out_everywhere" })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}

/**
 * A pending contributor invitation to `email` in the organization, written
 * as the owner, as one sent while the site's registration was open would
 * be (a personal organization sends none otherwise: D36-1 decision 57).
 * Returns its token, which only the test knows (the row holds its hash).
 */
export async function seedInvitation({ organizationId, email }: { organizationId: string; email: string }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await addInvitation(db(), { organizationId, email: email.toLowerCase(), token_hash: hashToken(token) });
  return token;
}

/**
 * Moves the pending invitation to `email` in the organization past its
 * expiry, a minute ago, as seven days would: expiry is set here, never
 * waited for.
 */
export async function expireInvitation({ organizationId, email }: { organizationId: string; email: string }): Promise<void> {
  const { numUpdatedRows } = await db()
    .updateTable("organization_invitations")
    .set({ expires_at: new Date(Date.now() - 60_000) })
    .where("organization_id", "=", organizationId)
    .where("email", "=", email.toLowerCase())
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (numUpdatedRows !== 1n) throw new Error(`expireInvitation: no pending invitation to ${email}`);
}

/**
 * Expires an active quick-deploy link at once (D17c-2 Preflight ruling 27),
 * as expireInvitation does an invitation: its expiry set to a millisecond
 * after its making, which is past by the API's clock, as 24 hours would be.
 * Its making (`created_at`) is left alone (the table checks `expires_at >
 * created_at`), so the list's order stays the order the links were made in.
 */
export async function expireQuickDeployLink({ organizationId, linkId }: { organizationId: string; linkId: string }): Promise<void> {
  const { numUpdatedRows } = await db()
    .updateTable("quick_deploy_links")
    .set({ expires_at: sql<Date>`created_at + interval '1 millisecond'` })
    .where("organization_id", "=", organizationId)
    .where("id", "=", linkId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (numUpdatedRows !== 1n) throw new Error(`expireQuickDeployLink: no unrevoked link ${linkId}`);
}

/**
 * Expires an unrevoked API token at once (D22 decision 53; Preflight ruling
 * 27), as expireQuickDeployLink does a link: its expiry set to a
 * millisecond after its making, past by the API's clock, as its days would
 * be. Raw SQL: the schema types `expires_at` as fixed at the insert (the
 * API never changes it), and the tables' owner may. Ids only: the error
 * names the token's id, never its name or prefix.
 */
export async function expireApiToken({ organizationId, tokenId }: { organizationId: string; tokenId: string }): Promise<void> {
  const { numAffectedRows } = await sql`
    update api_tokens set expires_at = created_at + interval '1 millisecond'
    where organization_id = ${organizationId} and id = ${tokenId} and revoked_at is null
  `.execute(db());
  if (numAffectedRows !== 1n) throw new Error(`expireApiToken: no unrevoked token ${tokenId}`);
}

/**
 * A configuration in `organizationId`, created by `createdByUserId`, written
 * by SQL as the tables' owner: for tests about the list rather than creating.
 * The table has no default for `created_at` or `updated_at` (the API writes
 * them from its clock, D7 decision 4), so both are written here: `updatedAt`
 * (default now) orders the list, and `created_at` takes the same value.
 *
 * Its version 1 is written with it, with `yamlContent` (default empty), as
 * every configuration has one from D8 on (D8 decision 3); without it the
 * editor would find the configuration "not found" (D8 Preflight ruling 12).
 *
 * A draft unless `published`, which publishes version 1 by its creator, as
 * the owner (the API's role can't insert a published version, migration
 * 021). Another member sees only a published configuration (D11b decision
 * 1), and a published version 1 can't be changed (decision 4): a test where
 * a teammate edits seeds a draft version 2 with `seedConfigurationVersion`.
 *
 * The configuration is the catalogue's default distribution, and version 1
 * is pinned to `collectorVersion` (D13a), by default that distribution's
 * default version, read from the catalogue's tables.
 */
export async function seedConfiguration({
  organizationId,
  createdByUserId,
  name,
  description = "",
  updatedAt = new Date(),
  yamlContent = "",
  published = false,
  collectorVersion,
}: {
  organizationId: string;
  createdByUserId: string;
  name: string;
  description?: string;
  updatedAt?: Date;
  yamlContent?: string;
  published?: boolean;
  collectorVersion?: string;
}): Promise<Selectable<ConfigurationsTable>> {
  return db().transaction().execute(async (transaction) => {
    const configuration = await addConfiguration(transaction, {
      organizationId,
      created_by_user_id: createdByUserId,
      name,
      description,
      created_at: updatedAt,
      updated_at: updatedAt,
    });
    await addConfigurationVersion(transaction, {
      configurationId: configuration.id,
      organizationId,
      version_number: 1,
      yaml_content: yamlContent,
      created_by_user_id: createdByUserId,
      created_at: updatedAt,
      updated_at: updatedAt,
      ...(collectorVersion === undefined ? {} : { collector_version: collectorVersion }),
      ...(published ? { publishedAt: updatedAt, publishedByUserId: createdByUserId } : {}),
    });
    return configuration;
  });
}

/** Every configuration row in the organization, live or deleted, newest update first. */
export async function findConfigurations(organizationId: string): Promise<Selectable<ConfigurationsTable>[]> {
  return db()
    .selectFrom("configurations")
    .selectAll()
    .where("organization_id", "=", organizationId)
    .orderBy("updated_at", "desc")
    .orderBy("id", "desc")
    .execute();
}

/** Every version row of the configuration, lowest version number first. */
export async function findConfigurationVersions(configurationId: string): Promise<Selectable<ConfigurationVersionsTable>[]> {
  return db()
    .selectFrom("configuration_versions")
    .selectAll()
    .where("configuration_id", "=", configurationId)
    .orderBy("version_number")
    .execute();
}

/**
 * Another version of a configuration seeded with `seedConfiguration`, written
 * by SQL as the tables' owner: for tests about switching between versions
 * rather than creating them (D10). `updatedAt` (default now) is its "last
 * saved", and `created_at` takes the same value. It is pinned to
 * `collectorVersion`, by default the configuration's distribution's default
 * version (D13a).
 */
export async function seedConfigurationVersion({
  configurationId,
  organizationId,
  createdByUserId,
  versionNumber,
  yamlContent = "",
  label = null,
  updatedAt = new Date(),
  collectorVersion,
}: {
  configurationId: string;
  organizationId: string;
  createdByUserId: string;
  versionNumber: number;
  yamlContent?: string;
  label?: string | null;
  updatedAt?: Date;
  collectorVersion?: string;
}): Promise<Selectable<ConfigurationVersionsTable>> {
  return addConfigurationVersion(db(), {
    configurationId,
    organizationId,
    version_number: versionNumber,
    yaml_content: yamlContent,
    label,
    created_by_user_id: createdByUserId,
    created_at: updatedAt,
    updated_at: updatedAt,
    ...(collectorVersion === undefined ? {} : { collector_version: collectorVersion }),
  });
}

/**
 * The collector catalogue's default distribution, as the sync wrote it from
 * catalog/ (D13a): read only. The browser tests never write the catalogue's
 * tables: they are global, so a row one test added would be every test's,
 * and the next run's sync refuses a row the files don't list.
 */
export async function findDefaultCollectorDistribution(): Promise<Selectable<CollectorDistributionsTable>> {
  return db().selectFrom("collector_distributions").selectAll().where("is_default", "=", true).executeTakeFirstOrThrow();
}

/** The distribution's versions in the catalogue, newest first (semver, as the API orders them): read only. */
export async function findCollectorVersions(distribution: string): Promise<Selectable<CollectorVersionsTable>[]> {
  const rows = await db().selectFrom("collector_versions").selectAll().where("distribution", "=", distribution).execute();
  const parts = (version: string) => version.split(".").map(Number);
  return rows.sort((a, b) => {
    const [left, right] = [parts(a.version), parts(b.version)];
    for (let index = 0; index < 3; index += 1) {
      const difference = right[index]! - left[index]!;
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

/**
 * The person's selected version of the configuration, as the database holds
 * it (D10 decision 3), or undefined when there is none. The editor records it
 * best effort, after it settles on a version, so a test waits for it before
 * relying on it.
 */
export async function findConfigurationVersionSelection(
  userId: string,
  configurationId: string,
): Promise<Selectable<ConfigurationVersionSelectionsTable> | undefined> {
  return db()
    .selectFrom("configuration_version_selections")
    .selectAll()
    .where("user_id", "=", userId)
    .where("configuration_id", "=", configurationId)
    .executeTakeFirst();
}

/**
 * Makes the user a product admin (D12 decision 3) with the README's SQL, as
 * the tables' owner: the API's own role can't change the flag (migration
 * 026's trigger). Read live on the user's next request.
 */
export async function grantProductAdmin(email: string): Promise<void> {
  const { numUpdatedRows } = await db()
    .updateTable("users")
    .set({ is_product_admin: true })
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", email.toLowerCase()))
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (numUpdatedRows !== 1n) throw new Error(`grantProductAdmin: no live user ${email}`);
}

/**
 * Clears the user's product-admin flag, as the tables' owner, as an operator
 * would mid-session: the API reads it live on the user's next request.
 */
export async function revokeProductAdmin(email: string): Promise<void> {
  const { numUpdatedRows } = await db()
    .updateTable("users")
    .set({ is_product_admin: false })
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", email.toLowerCase()))
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (numUpdatedRows !== 1n) throw new Error(`revokeProductAdmin: no live user ${email}`);
}

/**
 * Sets the product admins' switch straight in its one row (D36-1 decision
 * 51), as the tables' owner. The browser tests' baseline is `everyone`
 * (global-setup.ts's truncation), not the migration's default
 * (`product_admins`, Q259): a test that turned it on puts `everyone` back
 * when it ends, however it ends, since the row is global and other specs
 * create organizations as ordinary accounts.
 */
export async function setOrganizationCreation(value: "everyone" | "product_admins"): Promise<void> {
  await sql`update site_settings set organization_creation = ${value}`.execute(db());
}

/** The prefix of every flow a browser test writes (D12 Preflight ruling 13), so none is mistaken for a seeded one. */
export const E2E_FLOW_SLUG_PREFIX = "e2e-";

/**
 * Writes a flow straight into the table, as the tables' owner, for what the
 * API refuses to write (a pin the catalogue no longer offers: D12 decision
 * 16's flows, from before a version was retired). Only `e2e-` slugs; the
 * test deletes it after (deleteTestFlows).
 */
export async function insertTestFlow(flow: {
  slug: string;
  name: string;
  yaml: string;
  signals: string[];
  collectorDistribution: string;
  collectorVersion: string;
  published: boolean;
}): Promise<void> {
  if (!flow.slug.startsWith(E2E_FLOW_SLUG_PREFIX)) throw new Error(`insertTestFlow: ${flow.slug} isn't a browser test's flow`);
  const now = new Date();
  await db()
    .insertInto("flows")
    .values({
      slug: flow.slug,
      name: flow.name,
      summary: "Written by a browser test.",
      description: "Written by a browser test.",
      source: "telflo",
      author_name: null,
      author_url: null,
      signals: flow.signals,
      tags: [],
      yaml_content: flow.yaml,
      collector_distribution: flow.collectorDistribution,
      collector_version: flow.collectorVersion,
      source_url: null,
      published: flow.published,
      sort_order: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

/** The flow with this slug, or undefined. */
export async function findFlow(slug: string): Promise<Selectable<FlowsTable> | undefined> {
  return db().selectFrom("flows").selectAll().where("slug", "=", slug).executeTakeFirst();
}

/**
 * Deletes the flows a test wrote, by slug, as the tables' owner: the clean-up
 * after a test that writes flows, whether or not it got as far as deleting
 * them itself. Only `e2e-` slugs: the seeded flows are every test's.
 */
export async function deleteTestFlows(slugs: readonly string[]): Promise<void> {
  for (const slug of slugs) {
    if (!slug.startsWith(E2E_FLOW_SLUG_PREFIX)) throw new Error(`deleteTestFlows: ${slug} isn't a browser test's flow`);
  }
  if (slugs.length === 0) return;
  await db().deleteFrom("flows").where("slug", "in", slugs).execute();
}

/**
 * The prefix of every test template a browser test writes (D14b Preflight
 * ruling 27): templates are global, as flows are, so every parallel test
 * sees what another wrote, and the clean-up must never reach anything else.
 */
export const E2E_TEMPLATE_NAME_PREFIX = "e2e-";

/**
 * Deletes the test templates a test wrote, by id, as the tables' owner (the
 * API's role has no DELETE: the API's deletes are soft): the clean-up after
 * a test that writes templates, whether or not it got as far as deleting
 * them itself, live or soft-deleted. Refuses, deleting none, if any of them
 * is named other than `e2e-…`. Their bytes stay in the E2E file store's
 * root, which Playwright clears before each run.
 */
export async function deleteTestTemplates(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db().selectFrom("test_templates").select(["id", "name"]).where("id", "in", ids).execute();
  for (const row of rows) {
    if (!row.name.startsWith(E2E_TEMPLATE_NAME_PREFIX)) {
      throw new Error(`deleteTestTemplates: template ${row.id} isn't a browser test's (its name doesn't start ${E2E_TEMPLATE_NAME_PREFIX})`);
    }
  }
  await db().deleteFrom("test_templates").where("id", "in", ids).execute();
}

/**
 * The ids of the test templates named any of `names`, live or soft-deleted,
 * read as the tables' owner: for deleteTestTemplates, when a test created
 * one through the page and may end before it found its id. Refuses, finding
 * none, if any name doesn't start `e2e-`: a name like that could be anyone's.
 */
export async function findTestTemplateIdsByName(names: readonly string[]): Promise<string[]> {
  for (const name of names) {
    if (!name.startsWith(E2E_TEMPLATE_NAME_PREFIX)) {
      throw new Error(`findTestTemplateIdsByName: ${name} isn't a browser test's template name (it doesn't start ${E2E_TEMPLATE_NAME_PREFIX})`);
    }
  }
  if (names.length === 0) return [];
  const rows = await db().selectFrom("test_templates").select("id").where("name", "in", names).execute();
  return rows.map((row) => row.id);
}

/**
 * The prefix of every library file a browser test writes (D23-2 Preflight
 * ruling 22): the library is global, as templates are, so every parallel
 * test sees what another wrote (three browsers at once), and the clean-up
 * must never reach anything else.
 */
export const E2E_LIBRARY_FILE_NAME_PREFIX = "e2e-";

/**
 * Deletes the library files a test wrote, by id, as the tables' owner: the
 * clean-up after a test that writes library files, whether or not it got as
 * far as deleting them itself. Refuses, deleting none, if any of them is
 * named other than `e2e-…`. Their bytes stay in the E2E file store's root,
 * which Playwright clears before each run.
 */
export async function deleteLibraryFiles(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db().selectFrom("library_files").select(["id", "name"]).where("id", "in", ids).execute();
  for (const row of rows) {
    if (!row.name.startsWith(E2E_LIBRARY_FILE_NAME_PREFIX)) {
      throw new Error(`deleteLibraryFiles: library file ${row.id} isn't a browser test's (its name doesn't start ${E2E_LIBRARY_FILE_NAME_PREFIX})`);
    }
  }
  await db().deleteFrom("library_files").where("id", "in", ids).execute();
}

/**
 * The ids of the library files named any of `names`, read as the tables'
 * owner: for deleteLibraryFiles, when a test created one through the page
 * and may end before it found its id. Refuses, finding none, if any name
 * doesn't start `e2e-`: a name like that could be anyone's.
 */
export async function findLibraryFileIdsByName(names: readonly string[]): Promise<string[]> {
  for (const name of names) {
    if (!name.startsWith(E2E_LIBRARY_FILE_NAME_PREFIX)) {
      throw new Error(`findLibraryFileIdsByName: ${name} isn't a browser test's library file name (it doesn't start ${E2E_LIBRARY_FILE_NAME_PREFIX})`);
    }
  }
  if (names.length === 0) return [];
  const rows = await db().selectFrom("library_files").select("id").where("name", "in", names).execute();
  return rows.map((row) => row.id);
}

/**
 * The prefix of every regex library entry a browser test writes (D15b
 * Preflight ruling 17): the library is global, as templates are, so every
 * parallel test sees what another wrote, and the clean-up must never reach
 * a seeded entry or anyone else's.
 */
export const E2E_TEST_REGEX_NAME_PREFIX = "e2e-";

/**
 * Writes a regex library entry straight into the table, as the tables'
 * owner, for what the API refuses to write: an entry whose regex carries
 * the fake evaluator's `invalid`, `busy` or `unavailable` marker, which the
 * API's own RE2 check turns away at create (Preflight ruling 17). Only
 * `e2e-` names; the test deletes it after (deleteTestRegexes). Its id.
 */
export async function insertTestRegex(entry: { name: string; category: string; description: string | null; regex: string }): Promise<string> {
  if (!entry.name.startsWith(E2E_TEST_REGEX_NAME_PREFIX)) throw new Error(`insertTestRegex: ${entry.name} isn't a browser test's regex name`);
  const now = new Date();
  const { id } = await db()
    .insertInto("test_regex")
    .values({ ...entry, created_at: now, updated_at: now })
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

/**
 * Deletes the regex library entries a test wrote, by id, as the tables'
 * owner: the clean-up after a test that writes entries, whether or not it
 * got as far as deleting them itself. Refuses, deleting none, if any of them
 * is named other than `e2e-…`, and the delete itself takes only `e2e-…`
 * names: the seeded 35 are every test's.
 */
export async function deleteTestRegexes(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db().selectFrom("test_regex").select(["id", "name"]).where("id", "in", ids).execute();
  for (const row of rows) {
    if (!row.name.startsWith(E2E_TEST_REGEX_NAME_PREFIX)) {
      throw new Error(`deleteTestRegexes: regex ${row.id} isn't a browser test's (its name doesn't start ${E2E_TEST_REGEX_NAME_PREFIX})`);
    }
  }
  // The name guard on the delete itself too (Ruling 29): a row renamed between the read and the delete stays.
  await db()
    .deleteFrom("test_regex")
    .where("id", "in", ids)
    .where("name", "like", `${E2E_TEST_REGEX_NAME_PREFIX}%`)
    .execute();
}

/**
 * The ids of the regex library entries named any of `names`, read as the
 * tables' owner: for deleteTestRegexes, when a test created one through the
 * page and may end before it found its id. Refuses, finding none, if any
 * name doesn't start `e2e-`: a name like that could be anyone's.
 */
export async function findTestRegexIdsByName(names: readonly string[]): Promise<string[]> {
  for (const name of names) {
    if (!name.startsWith(E2E_TEST_REGEX_NAME_PREFIX)) {
      throw new Error(`findTestRegexIdsByName: ${name} isn't a browser test's regex name (it doesn't start ${E2E_TEST_REGEX_NAME_PREFIX})`);
    }
  }
  if (names.length === 0) return [];
  const rows = await db().selectFrom("test_regex").select("id").where("name", "in", names).execute();
  return rows.map((row) => row.id);
}
