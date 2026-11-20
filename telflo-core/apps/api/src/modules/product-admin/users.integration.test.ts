import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, type AdminUser, type AdminUsersPage } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import {
  addApiToken,
  addConfiguration,
  addConfigurationVersion,
  addInvitation,
  addMembership,
  addPersonalApiToken,
  addServiceAccount,
  addTestRun,
  addUserFeedback,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import { withProductAdminContext } from "../../database/context.js";
import { createFileStore } from "../../file-store/create-file-store.js";
import type { IFileStore } from "../../file-store/file-store.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";
import { organizationLogoKey } from "../organizations/service.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

/*
 * The Users routes, on the real database:
 *
 *   * the Users list: the search by email and by the name of any live
 *     organization, case aside, with LIKE's `%`, `_` and `\` taken
 *     literally; deleted people and service accounts absent; each block
 *     kind and its precedence (product_admin over member over owner, the
 *     first by name), a pending invitation blocking until it expires at the
 *     API's clock; the cursor stable across inserts and exact to the
 *     millisecond (two people microseconds apart straddling a page
 *     boundary); a malformed cursor and a long term 400; the audit row
 *     holding a count and whether a search ran, never the term;
 *   * the delete, end to end: the person's sessions, personal token and
 *     their service account's token refused at once, their old password
 *     refused, their identity, settings and links gone, the record written,
 *     the address freed (registering it again works) and the anonymous one
 *     refused, the configuration and the test run kept, the organization
 *     deleted, its logo's bytes removed and the opamp-server told; the
 *     audit rows; every refusal (404, self, each block, a block that
 *     appeared after the list) and its audit row;
 *   * the races, each with two connections: the caller removed while the
 *     delete waited (403), an organization's delete and a grant
 *     interleaved with the delete's locks (no deadlock), the membership set
 *     changing under the locks (one restart, then the delete; three, then
 *     409 user_delete_busy).
 *
 * Seeded addresses are made-up @example.com fixtures; other people's emails
 * and organization names are compared as booleans, never printed.
 */

const opamp = useFakeOpampServer();
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const USERS = "/api/v1/product-admin/users";

describe("the Users routes", () => {
  let databases: TestDatabases;
  let db: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let runner: CollectingRunner;
  let clock: Date;
  let root: string;
  let store: IFileStore;
  const mailer = createInMemoryMailer();

  beforeAll(async () => {
    databases = openTestDatabases();
    ({ db, ownerDb } = databases);
    passwordHash = await hashPassword(PASSWORD);
    root = await mkdtemp(join(tmpdir(), "telflo-users-admin-"));
    store = await createFileStore({ kind: "local", root });
    server = buildServer({
      opampServer: opamp.client,
      otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
      fileStore: store,
      testing: UNCALLED_TESTING,
      // The sales inquiries switched on, with their address (off by default
      // and no default address), as the sales-inquiry route's own tests do:
      // the delete's allowlist test sends one from the person's address.
      settings: loadSettings({ ...process.env, TELFLO_SALES_INQUIRY: "true", TELFLO_SALES_INQUIRY_TO: "inquiries@telflo.test" }),
      db,
      mailer,
      now: () => clock,
      rateLimits: TEST_RATE_LIMITS,
      runAfterResponse: (task) => runner.run(task),
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    runner = createCollectingRunner();
    clock = new Date();
  });

  afterEach(async () => {
    await runner.settle();
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  /** A live, verified person with a password and a personal organization; a product admin when asked. */
  const person = async (options: { admin?: boolean; email?: string } = {}) => {
    const created = await createUserWithOrganization(ownerDb, {
      user: { email: options.email ?? `person-${randomUUID()}@example.com`, password_hash: passwordHash, is_product_admin: options.admin ?? false },
    });
    return { userId: created.user.id, email: created.user.email, organizationId: created.organization.id };
  };

  const signIn = async (email: string) => {
    const response = await server.inject({ method: "POST", url: "/api/v1/auth/sessions", headers: csrfHeaders, payload: { email, password: PASSWORD } });
    return { status: response.statusCode, access: response.statusCode === 200 ? cookieValue(response, "telflo_access") : "", refresh: response.statusCode === 200 ? cookieValue(response, "telflo_refresh") : "" };
  };

  /** A signed-in product admin. */
  const admin = async () => {
    const who = await person({ admin: true });
    const { access } = await signIn(who.email);
    return { ...who, access };
  };

  const list = async (access: string, query: { q?: string; cursor?: string } = {}) => {
    const parameters = new URLSearchParams(query);
    const search = parameters.toString();
    return server.inject({ method: "GET", url: `${USERS}${search === "" ? "" : `?${search}`}`, cookies: { telflo_access: access } });
  };
  const page = async (access: string, query: { q?: string; cursor?: string } = {}): Promise<AdminUsersPage> => {
    const response = await list(access, query);
    expect(response.statusCode).toBe(200);
    return response.json<AdminUsersPage>();
  };
  const ids = (items: AdminUser[]) => items.map((item) => item.id).sort();

  const remove = (access: string, userId: string) =>
    server.inject({ method: "DELETE", url: `${USERS}/${userId}`, headers: csrfHeaders, cookies: { telflo_access: access } });

  const auditRows = () =>
    ownerDb
      .selectFrom("audit_events")
      .select(["action", "actor_user_id", "organization_id", "subject_type", "subject_id", "metadata"])
      .orderBy("occurred_at")
      .orderBy("id")
      .execute();
  /** Whether any audit row's metadata holds `text`: a boolean, nothing printed. */
  const metadataHolds = async (text: string) => (await auditRows()).some((row) => JSON.stringify(row.metadata).includes(text));

  /** The block a page shows for `userId`, the organization's name compared with `name` as a boolean. */
  const blockOf = (items: AdminUser[], userId: string, name?: string) => {
    const block = items.find((item) => item.id === userId)?.block;
    if (block === undefined) return "absent";
    if (block === null) return null;
    if (block.kind === "product_admin") return { kind: block.kind };
    return {
      kind: block.kind,
      named: block.organizationName === name,
      ...(block.kind === "member" ? { role: block.role } : {}),
    };
  };

  /** Another live human in `organizationId`. */
  const otherMember = async (organizationId: string, role: "admin" | "contributor" = "contributor") => {
    const other = await person();
    await addMembership(ownerDb, { userId: other.userId, organizationId, role });
    return other;
  };

  /** A new group organization named `name`, with `userId` in it. */
  const group = async (name: string, userId: string, role: "admin" | "contributor" = "admin") => {
    const { organization } = await addMembership(ownerDb, { userId, role });
    await ownerDb.updateTable("organizations").set({ name }).where("id", "=", organization.id).execute();
    return organization.id;
  };

  describe("GET /api/v1/product-admin/users", () => {
    it("searches by email and by the name of any live organization, case aside; deleted people and service accounts never listed; audited with a count and whether a search ran, never the term", async () => {
      const ana = await admin();
      const marker = randomBytes(6).toString("hex");
      const byEmail = await person({ email: `${marker}-mail@example.com` });
      const byOrganization = await person();
      await group(`Team ${marker.toUpperCase()} Ops`, byOrganization.userId);
      const inDeletedOrganization = await person();
      const gone = await group(`Gone ${marker}`, inDeletedOrganization.userId);
      await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", gone).execute();
      const removedMember = await person();
      const left = await group(`Left ${marker}`, removedMember.userId);
      await ownerDb.updateTable("organization_members").set({ deleted_at: new Date() }).where("organization_id", "=", left).execute();
      const deleted = await person({ email: `${marker}-deleted@example.com` });
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", deleted.userId).execute();
      const bot = await addServiceAccount(ownerDb, { organizationId: byOrganization.organizationId, name: `bot-${marker}` });

      const everyone = await page(ana.access);
      expect(ids(everyone.items)).toEqual(
        [ana.userId, byEmail.userId, byOrganization.userId, inDeletedOrganization.userId, removedMember.userId].sort(),
      );
      expect(everyone.items.some((item) => item.id === bot.user.id || item.id === deleted.userId)).toBe(false);
      expect(everyone.nextCursor).toBeNull();

      const searched = await page(ana.access, { q: `  ${marker.toUpperCase()}  ` });
      expect(ids(searched.items)).toEqual([byEmail.userId, byOrganization.userId].sort());
      expect(ids((await page(ana.access, { q: "" })).items)).toEqual(ids(everyone.items));

      const rows = (await auditRows()).filter((row) => row.action === "product_admin.users_listed");
      expect(rows.map(({ metadata, organization_id, actor_user_id }) => ({ metadata, organization_id, actor_user_id }))).toEqual([
        { metadata: { count: 5, searched: false }, organization_id: null, actor_user_id: ana.userId },
        { metadata: { count: 2, searched: true }, organization_id: null, actor_user_id: ana.userId },
        { metadata: { count: 5, searched: false }, organization_id: null, actor_user_id: ana.userId },
      ]);
      expect(await metadataHolds(marker)).toBe(false);
      expect(await metadataHolds(marker.toUpperCase())).toBe(false);
    });

    it("takes %, _ and \\ in a search literally: each matches only the names and emails that hold it", async () => {
      const ana = await admin();
      const marker = randomBytes(6).toString("hex");
      const named = async (name: string) => {
        const who = await person();
        await group(name, who.userId);
        return who.userId;
      };
      const percent = await named(`${marker} 50% off`);
      const noPercent = await named(`${marker} 500 off`);
      const underscore = await named(`${marker} x_y`);
      const noUnderscore = await named(`${marker} xzy`);
      const backslash = await named(`${marker} a\\b`);
      const noBackslash = await named(`${marker} ab`);
      const underscoreEmail = await person({ email: `${marker}_e@example.com` });
      const noUnderscoreEmail = await person({ email: `${marker}xe@example.com` });

      expect(ids((await page(ana.access, { q: `${marker} 50%` })).items)).toEqual([percent]);
      expect(ids((await page(ana.access, { q: "x_y" })).items)).toEqual([underscore]);
      expect(ids((await page(ana.access, { q: "a\\b" })).items)).toEqual([backslash]);
      expect(ids((await page(ana.access, { q: `${marker}_e` })).items)).toEqual([underscoreEmail.userId]);
      // The plain spellings still find what they spell.
      expect(ids((await page(ana.access, { q: `${marker} 500` })).items)).toEqual([noPercent]);
      expect(ids((await page(ana.access, { q: "xzy" })).items)).toEqual([noUnderscore]);
      expect(ids((await page(ana.access, { q: `${marker} ab` })).items)).toEqual([noBackslash]);
      expect(ids((await page(ana.access, { q: `${marker}xe` })).items)).toEqual([noUnderscoreEmail.userId]);
      // A lone wildcard matches only what holds it: none of the people above but the one.
      expect(ids((await page(ana.access, { q: "%" })).items)).toEqual([percent]);
      expect(ids((await page(ana.access, { q: "\\" })).items)).toEqual([backslash]);
    });

    it("shows each block: none when every organization is theirs alone; owner for another live member or an invitation pending at the API's clock (not an expired, accepted or revoked one); member with the role; member over owner, the first by name; product_admin over both", async () => {
      const ana = await admin();
      const alone = await person();
      await group(`Alone ${randomUUID()}`, alone.userId);
      const withMember = await person();
      await otherMember(withMember.organizationId);
      const invited = await person();
      await addInvitation(ownerDb, { organizationId: invited.organizationId, expires_at: new Date(clock.getTime() + 60_000) });
      const expired = await person();
      await addInvitation(ownerDb, { organizationId: expired.organizationId, expires_at: new Date(clock.getTime() - 1) });
      await addInvitation(ownerDb, { organizationId: expired.organizationId, expires_at: new Date(clock.getTime() + 60_000), revoked_at: clock });
      const deletedMember = await person();
      const departed = await otherMember(deletedMember.organizationId);
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", departed.userId).execute();
      const withBot = await person();
      await addServiceAccount(ownerDb, { organizationId: withBot.organizationId });

      const both = await person();
      await otherMember(both.organizationId);
      const zeta = `Zeta ${randomUUID()}`;
      const alpha = `Alpha ${randomUUID()}`;
      await otherMember(await group(zeta, both.userId, "admin"));
      await otherMember(await group(alpha, both.userId, "contributor"));

      const flagged = await person({ admin: true });
      await otherMember(flagged.organizationId);
      await otherMember(await group(`Flagged ${randomUUID()}`, flagged.userId));

      const { items } = await page(ana.access);
      expect({
        alone: blockOf(items, alone.userId),
        withMember: blockOf(items, withMember.userId, withMember.email.toLowerCase()),
        invited: blockOf(items, invited.userId, invited.email.toLowerCase()),
        expired: blockOf(items, expired.userId),
        deletedMember: blockOf(items, deletedMember.userId),
        withBot: blockOf(items, withBot.userId),
        both: blockOf(items, both.userId, alpha),
        flagged: blockOf(items, flagged.userId),
      }).toEqual({
        alone: null,
        withMember: { kind: "owner", named: true },
        invited: { kind: "owner", named: true },
        expired: null,
        deletedMember: null,
        withBot: null,
        both: { kind: "member", named: true, role: "contributor" },
        flagged: { kind: "product_admin" },
      });
      expect(items.find((item) => item.id === flagged.userId)?.isProductAdmin).toBe(true);

      // The invitation stops blocking once the API's clock passes its expiry.
      clock = new Date(clock.getTime() + 120_000);
      expect(blockOf((await page(ana.access)).items, invited.userId)).toBeNull();
    });

    it("pages 50 at a time with an opaque cursor exact to the millisecond: two people microseconds apart straddling the boundary are neither skipped nor repeated, and a newer person doesn't move page two; each page audits the rows it returned", async () => {
      const ana = await admin();
      const people: string[] = [];
      for (let index = 0; index < 51; index += 1) people.push((await person()).userId);
      // 49 newest a second apart; the last two in one millisecond, microseconds apart; the admin oldest.
      const base = Date.UTC(2026, 0, 1, 12, 0, 0);
      for (const [index, userId] of people.slice(0, 49).entries()) {
        await sql`update users set created_at = ${new Date(base + (index + 1) * 1000)} where id = ${userId}::uuid`.execute(ownerDb);
      }
      const [first, second] = [people[49]!, people[50]!];
      await sql`update users set created_at = '2026-01-01T12:00:00.123401Z' where id = ${first}::uuid`.execute(ownerDb);
      await sql`update users set created_at = '2026-01-01T12:00:00.123789Z' where id = ${second}::uuid`.execute(ownerDb);
      await sql`update users set created_at = ${new Date(base - 86_400_000)} where id = ${ana.userId}::uuid`.execute(ownerDb);

      const one = await page(ana.access);
      expect(one.items).toHaveLength(50);
      expect(one.nextCursor).not.toBeNull();
      const straddling = [first, second].sort().reverse();
      expect(one.items.at(-1)!.id).toBe(straddling[0]);
      await person();
      const two = await page(ana.access, { cursor: one.nextCursor! });
      expect(two.items.map((item) => item.id)).toEqual([straddling[1], ana.userId]);
      expect(two.nextCursor).toBeNull();
      const seen = [...one.items, ...two.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...people, ana.userId].sort());
      // Each page's audit row counts the rows it returned: the full page 50, never the look-ahead's 51.
      expect((await auditRows()).filter((row) => row.action === "product_admin.users_listed").map((row) => row.metadata)).toEqual([
        { count: 50, searched: false },
        { count: 2, searched: false },
      ]);
    });

    it("refuses a malformed cursor and a term longer than 254 characters with 400, and a member with 403; every answer no-store", async () => {
      const ana = await admin();
      for (const cursor of ["not a cursor", "eyJ4IjoxfQ", Buffer.from(JSON.stringify({ createdAt: "2026-01-01", id: randomUUID() })).toString("base64url")]) {
        const response = await list(ana.access, { cursor });
        expect({ status: response.statusCode, code: response.json().error.code, cache: response.headers["cache-control"] }).toEqual({
          status: 400,
          code: "invalid_request",
          cache: "no-store",
        });
      }
      const long = await list(ana.access, { q: "x".repeat(255) });
      expect({ status: long.statusCode, cache: long.headers["cache-control"] }).toEqual({ status: 400, cache: "no-store" });
      const listed = await list(ana.access, { q: "x".repeat(254) });
      expect({ status: listed.statusCode, cache: listed.headers["cache-control"] }).toEqual({ status: 200, cache: "no-store" });
      const all = await list(ana.access);
      expect({ status: all.statusCode, cache: all.headers["cache-control"] }).toEqual({ status: 200, cache: "no-store" });
      const member = await person();
      const { access } = await signIn(member.email);
      expect((await list(access)).statusCode).toBe(403);
    });
  });

  describe("DELETE /api/v1/product-admin/users/:userId", () => {
    /**
     * Cara: a password, a session, a personal organization registered with
     * the opamp-server holding a logo, a service account with a token, a
     * configuration and a test run; a personal token, a Google identity,
     * settings, a reset and a verification token.
     */
    const seedCara = async () => {
      const cara = await person();
      const session = await signIn(cara.email);
      const organizationId = cara.organizationId;
      await opamp.client.createOrganization({ id: organizationId, name: "a workspace" });
      const logoId = randomUUID();
      await ownerDb.updateTable("organizations").set({ logo_id: logoId, logo_content_type: "image/png" }).where("id", "=", organizationId).execute();
      await mkdir(root, { recursive: true });
      await store.write(organizationLogoKey(organizationId, logoId), Readable.from([Buffer.from("png-bytes")]), { maxBytes: 1024 });
      const bot = await addServiceAccount(ownerDb, { organizationId, createdByUserId: cara.userId });
      const botToken = await addApiToken(ownerDb, { organizationId, serviceAccountUserId: bot.user.id });
      const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: cara.userId });
      const version = await addConfigurationVersion(ownerDb, { organizationId, configurationId: configuration.id });
      const run = await addTestRun(ownerDb, { organizationId, configurationId: configuration.id, configurationVersionId: version.id, queuedByUserId: cara.userId });
      const personalToken = await addPersonalApiToken(ownerDb, { userId: cara.userId });
      await ownerDb.insertInto("user_identities").values({ user_id: cara.userId, provider: "google", provider_subject: randomUUID(), email: cara.email }).execute();
      await ownerDb.insertInto("user_settings").values({ user_id: cara.userId, created_at: clock, updated_at: clock }).execute();
      const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
      await ownerDb.insertInto("password_reset_tokens").values({ user_id: cara.userId, token_hash: hash(), expires_at: new Date(clock.getTime() + 3_600_000) }).execute();
      await ownerDb.insertInto("email_verification_tokens").values({ user_id: cara.userId, token_hash: hash(), expires_at: new Date(clock.getTime() + 3_600_000) }).execute();
      // The API's clock after every fixture: a token is revoked, an account deleted, no earlier than it was made.
      clock = new Date();
      return { ...cara, session, logoId, bot: bot.user.id, botToken: botToken.token, personalToken: personalToken.token, configurationId: configuration.id, runId: run.id };
    };

    const me = (access: string) => server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });
    const refresh = (token: string) => server.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: csrfHeaders, cookies: { telflo_refresh: token } });
    const whoami = (token: string) => server.inject({ method: "GET", url: "/api/public/v1/whoami", headers: { authorization: `Bearer ${token}` } });
    const register = (email: string) =>
      server.inject({ method: "POST", url: "/api/v1/auth/register", headers: csrfHeaders, payload: { email, password: PASSWORD, acceptedTermsVersion: TEST_TERMS_VERSION } });

    const storedFiles = async (): Promise<string[]> => {
      const found: string[] = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(join(directory, entry.name));
          else found.push(entry.name);
        }
      };
      await walk(root);
      return found;
    };

    it("deletes a person end to end: their sessions, personal token and their service account's token refused at once, the old password refused, the record written, the address freed and the anonymous one refused, the organization deleted with its service account, its logo's bytes removed and the opamp-server told; the configuration and the test run kept; audited", async () => {
      const ana = await admin();
      const cara = await seedCara();
      expect((await me(cara.session.access)).statusCode).toBe(200);
      expect((await whoami(cara.botToken)).statusCode).toBe(200);
      expect((await whoami(cara.personalToken)).statusCode).toBe(200);
      expect(await storedFiles()).toEqual([cara.logoId]);

      const response = await remove(ana.access, cara.userId.toUpperCase());
      expect(response.statusCode).toBe(204);
      expect(response.headers["cache-control"]).toBe("no-store");

      expect((await me(cara.session.access)).statusCode).toBe(401);
      expect((await refresh(cara.session.refresh)).statusCode).toBe(401);
      expect((await whoami(cara.botToken)).statusCode).toBe(401);
      expect((await whoami(cara.personalToken)).statusCode).toBe(401);
      expect((await signIn(cara.email)).status).toBe(401);

      const user = await ownerDb.selectFrom("users").selectAll().where("id", "=", cara.userId).executeTakeFirstOrThrow();
      expect({
        anonymous: /^deleted-[0-9a-f]{24}@deleted-accounts\.telflo\.invalid$/.test(user.email),
        password: user.password_hash,
        deletedAt: user.deleted_at?.getTime(),
      }).toEqual({ anonymous: true, password: null, deletedAt: clock.getTime() });
      const records = await ownerDb.selectFrom("user_deletion_records").selectAll().execute();
      expect(records.map((record) => ({ ...record, original_email: record.original_email === cara.email }))).toEqual([
        { user_id: cara.userId, original_email: true, deleted_by_user_id: ana.userId, deleted_at: clock },
      ]);
      const left = async (table: "user_identities" | "user_settings" | "password_reset_tokens" | "email_verification_tokens") =>
        (await ownerDb.selectFrom(table).select("user_id").where("user_id", "=", cara.userId).execute()).length;
      expect({
        identities: await left("user_identities"),
        settings: await left("user_settings"),
        resets: await left("password_reset_tokens"),
        verifications: await left("email_verification_tokens"),
      }).toEqual({ identities: 0, settings: 0, resets: 0, verifications: 0 });
      const sessions = await ownerDb.selectFrom("sessions").select(["revoked_reason", "revoked_at"]).where("user_id", "=", cara.userId).execute();
      expect(sessions).toEqual([{ revoked_reason: "account_deleted", revoked_at: clock }]);
      const tokens = await ownerDb.selectFrom("personal_api_tokens").select("revoked_at").where("user_id", "=", cara.userId).execute();
      expect(tokens).toEqual([{ revoked_at: clock }]);
      const botTokens = await ownerDb.selectFrom("api_tokens").select(["revoked_at", "revoked_by_user_id"]).where("service_account_user_id", "=", cara.bot).execute();
      expect(botTokens).toEqual([{ revoked_at: clock, revoked_by_user_id: ana.userId }]);
      const bot = await ownerDb
        .selectFrom("users")
        .innerJoin("service_accounts", "service_accounts.user_id", "users.id")
        .innerJoin("organization_members", "organization_members.user_id", "users.id")
        .select(["users.deleted_at as user", "service_accounts.deleted_at as account", "organization_members.deleted_at as membership"])
        .where("users.id", "=", cara.bot)
        .executeTakeFirstOrThrow();
      expect(bot).toEqual({ user: clock, account: clock, membership: clock });
      const organization = await ownerDb.selectFrom("organizations").select(["deleted_at", "logo_id"]).where("id", "=", cara.organizationId).executeTakeFirstOrThrow();
      expect(organization).toEqual({ deleted_at: clock, logo_id: cara.logoId });
      expect((await ownerDb.selectFrom("configurations").select("id").where("id", "=", cara.configurationId).execute()).length).toBe(1);
      expect((await ownerDb.selectFrom("test_runs").select("id").where("id", "=", cara.runId).execute()).length).toBe(1);
      // The logo's bytes go after the commit; the opamp-server after the response.
      expect(await storedFiles()).toEqual([]);
      expect(await opamp.client.getOrganization(cara.organizationId)).toMatchObject({ kind: "found" });
      await runner.settle();
      expect(await opamp.client.getOrganization(cara.organizationId)).toEqual({ kind: "not_found" });

      const audits = (await auditRows()).filter((row) => row.action === "organization.deleted" || row.action === "user.deleted");
      expect(audits.map(({ action, organization_id, subject_type, subject_id, metadata }) => ({ action, organization_id, subject_type, subject_id, metadata }))).toEqual([
        {
          action: "organization.deleted",
          organization_id: cara.organizationId,
          subject_type: "organization",
          subject_id: cara.organizationId,
          metadata: { reason: "account_deleted", deletedServiceAccounts: 1 },
        },
        {
          action: "user.deleted",
          organization_id: null,
          subject_type: "user",
          subject_id: cara.userId,
          metadata: { deletedOrganizations: 1, deletedServiceAccounts: 1, revokedSessions: 1 },
        },
      ]);
      expect(await metadataHolds(cara.email)).toBe(false);

      // Gone from the list; the address registers again; the anonymous one is refused.
      expect((await page(ana.access)).items.some((item) => item.id === cara.userId)).toBe(false);
      expect((await register(cara.email)).statusCode).toBe(200);
      const anonymous = await register(user.email);
      expect({ status: anonymous.statusCode, code: anonymous.json().error.code }).toEqual({ status: 422, code: "email_reserved" });
      // A second delete finds no one.
      expect((await remove(ana.access, cara.userId)).statusCode).toBe(404);
    });

    /** Where a row may still hold a deleted person's original email: a row predicate per table and column. */
    type Allowed = Record<string, ReturnType<typeof sql<boolean>>>;

    /**
     * Every text, varchar, json(b) and text[] column of every table in public,
     * as the tables' owner: how many rows hold `text` where `allowed` lets
     * them, and how many elsewhere. Counts only, never a value.
     */
    const columnsHolding = async (text: string, allowed: Allowed = {}) => {
      const { rows: columns } = await sql<{ table: string; column: string }>`
        select c.table_name::text as table, c.column_name::text as column
          from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'platform' and t.table_type = 'BASE TABLE'
           and (c.data_type in ('text', 'character varying', 'jsonb', 'json') or (c.data_type = 'ARRAY' and c.udt_name in ('_text', '_varchar')))
      `.execute(ownerDb);
      const inAllowed: Record<string, number> = {};
      const elsewhere: Record<string, number> = {};
      for (const { table, column } of columns) {
        const key = `${table}.${column}`;
        const predicate = allowed[key] ?? sql<boolean>`false`;
        const { rows } = await sql<{ allowed: number; other: number }>`
          select count(*) filter (where ${predicate})::integer as allowed,
                 count(*) filter (where not (${predicate}))::integer as other
            from ${sql.table(table)}
           where position(${text.toLowerCase()} in lower(${sql.ref(column)}::text)) > 0
        `.execute(ownerDb);
        if (rows[0]!.allowed > 0) inAllowed[key] = rows[0]!.allowed;
        if (rows[0]!.other > 0) elsewhere[key] = rows[0]!.other;
      }
      return { searched: columns.length, inAllowed, elsewhere };
    };

    it("leaves the person's original email only in the exact allowlist: the audit log (append-only, any column of any row), their deletion record, and invitations of organizations not deleted with them; their personal organization renamed and its invitations to them anonymized; their sessions without IP address or user agent", async () => {
      const ana = await admin();
      const cara = await seedCara();
      // A second, older session, already signed out: it keeps its address and browser until the delete.
      const older = await signIn(cara.email);
      expect(older.status).toBe(200);
      await ownerDb
        .updateTable("sessions")
        .set({ revoked_at: new Date(), revoked_reason: "logout" })
        .where("user_id", "=", cara.userId)
        .where("revoked_at", "is", null)
        .where("id", "in", ownerDb.selectFrom("sessions").select("id").where("user_id", "=", cara.userId).orderBy("created_at", "desc").limit(1))
        .execute();
      // A group Cara left, holding an invitation she sent; her feedback.
      const left = await group(`Left ${randomUUID()}`, cara.userId);
      await addInvitation(ownerDb, { organizationId: left, invited_by_user_id: cara.userId });
      await ownerDb.updateTable("organization_members").set({ deleted_at: new Date() }).where("organization_id", "=", left).execute();
      await addUserFeedback(ownerDb, { userId: cara.userId, organizationId: cara.organizationId });
      // She renamed her personal organization: the rename's audit row holds its old name, after her email.
      const renamed = await server.inject({
        method: "PATCH",
        url: `/api/v1/organizations/${cara.organizationId}`,
        headers: csrfHeaders,
        cookies: { telflo_access: cara.session.access },
        payload: { name: "A renamed workspace" },
      });
      expect(renamed.statusCode).toBe(200);

      /** An admin of a new group, signed in and acting in it: their invitations go through the route. */
      const groupAdmin = async () => {
        const who = await person();
        const groupId = await group(`Inviting ${randomUUID()}`, who.userId);
        const { access } = await signIn(who.email);
        const switched = await server.inject({
          method: "PUT",
          url: "/api/v1/auth/sessions/current/organization",
          headers: csrfHeaders,
          cookies: { telflo_access: access },
          payload: { organizationId: groupId },
        });
        expect(switched.statusCode).toBe(200);
        // A no-op when the sign-in already landed there: no new cookie, the token sent stands.
        return { ...who, groupId, access: (switched.headers["set-cookie"] === undefined ? access : cookieValue(switched, "telflo_access")) };
      };
      const inviteCara = async (inviter: { groupId: string; access: string }) => {
        const response = await server.inject({
          method: "POST",
          url: `/api/v1/organizations/${inviter.groupId}/invitations`,
          headers: csrfHeaders,
          cookies: { telflo_access: inviter.access },
          payload: { email: cara.email, role: "contributor" },
        });
        expect(response.statusCode).toBe(201);
        await runner.settle();
      };
      // Another organization's invitation to her address, pending: in the allowlist.
      const elsewhere = await groupAdmin();
      await inviteCara(elsewhere);
      // An invitation she accepted, in a group then hers alone (its inviter gone): deleted with her.
      const accepted = await groupAdmin();
      mailer.sent.length = 0;
      await inviteCara(accepted);
      const link = mailer.sent.find((message) => message.to === cara.email);
      const token = /\/accept-invitation#token=([A-Za-z0-9_-]+)/.exec(link?.text ?? "")?.[1] ?? "";
      const acceptance = await server.inject({
        method: "POST",
        url: "/api/v1/invitation-acceptances",
        headers: csrfHeaders,
        cookies: { telflo_access: cara.session.access },
        payload: { token },
      });
      expect(acceptance.statusCode).toBeLessThan(300);
      await ownerDb
        .updateTable("organization_members")
        .set({ deleted_at: new Date() })
        .where("organization_id", "=", accepted.groupId)
        .where("user_id", "=", accepted.userId)
        .execute();
      // A sales inquiry from her address.
      const inquiry = await server.inject({
        method: "POST",
        url: "/api/v1/sales-inquiries",
        headers: csrfHeaders,
        payload: { name: "A test's name", email: cara.email, message: "A test's message." },
      });
      expect(inquiry.statusCode).toBeLessThan(300);
      clock = new Date();

      const sessionsHoldingClientData = async () =>
        Number(
          (
            await sql<{ held: number }>`
              select count(*)::integer as held from sessions
               where user_id = ${cara.userId}::uuid and (ip_address is not null or user_agent is not null)
            `.execute(ownerDb)
          ).rows[0]!.held,
        );
      const deletedWithHer = [cara.organizationId, accepted.groupId];
      const auditColumns = (
        await sql<{ column: string }>`
          select column_name::text as column from information_schema.columns where table_schema = 'platform' and table_name = 'audit_events'
        `.execute(ownerDb)
      ).rows.map((row) => row.column);
      const allowed: Allowed = {
        "user_deletion_records.original_email": sql<boolean>`user_id = ${cara.userId}::uuid`,
        // The audit log as a whole is the one named residue (append-only).
        ...Object.fromEntries(auditColumns.map((column) => [`audit_events.${column}`, sql<boolean>`true`])),
        "organization_invitations.email": sql<boolean>`organization_id <> all (${deletedWithHer}::uuid[])`,
      };
      const before = await columnsHolding(cara.email, allowed);
      expect(before.searched).toBeGreaterThan(50);
      expect(Object.keys(before.elsewhere).sort()).toEqual(
        expect.arrayContaining(["users.email", "user_identities.email", "organization_invitations.email"]),
      );
      expect(await sessionsHoldingClientData()).toBe(2);

      expect((await remove(ana.access, cara.userId)).statusCode).toBe(204);
      const deleted = await ownerDb.selectFrom("organizations").select("id").where("deleted_at", "is not", null).execute();
      expect(deleted.map((row) => row.id).sort()).toEqual([...deletedWithHer].sort());

      const after = await columnsHolding(cara.email, allowed);
      expect(after.elsewhere, "rows holding the original email outside the allowlist, by column (counts)").toEqual({});
      expect({
        record: after.inAllowed["user_deletion_records.original_email"],
        otherInvitation: after.inAllowed["organization_invitations.email"],
      }).toEqual({ record: 1, otherInvitation: 1 });
      // In the audit log: her own rows' actor_email, and the metadata of both invitations' creation, the sales inquiry and the rename's `from`.
      const auditHolding = async (where: ReturnType<typeof sql<boolean>>) =>
        Number(
          (
            await sql<{ held: number }>`
              select count(*)::integer as held from audit_events
               where ${where} and position(${cara.email.toLowerCase()} in lower(metadata::text)) > 0
            `.execute(ownerDb)
          ).rows[0]!.held,
        );
      expect({
        actorEmail: (after.inAllowed["audit_events.actor_email"] ?? 0) > 0,
        invitationsCreated: await auditHolding(sql<boolean>`action = 'organization_invitation.created'`),
        salesInquiry: await auditHolding(sql<boolean>`action = 'sales_inquiry.received'`),
        renamedFrom: await auditHolding(sql<boolean>`action = 'organization.renamed' and position(${cara.email.toLowerCase()} in lower(metadata->>'from')) > 0`),
      }).toEqual({ actorEmail: true, invitationsCreated: 2, salesInquiry: 1, renamedFrom: 1 });
      expect(await sessionsHoldingClientData()).toBe(0);
      const user = await ownerDb.selectFrom("users").select("email").where("id", "=", cara.userId).executeTakeFirstOrThrow();
      const personal = await ownerDb.selectFrom("organizations").select("name").where("id", "=", cara.organizationId).executeTakeFirstOrThrow();
      expect(personal.name === `${user.email}'s workspace`).toBe(true);
      const anonymized = await ownerDb.selectFrom("organization_invitations").select("email").where("organization_id", "=", accepted.groupId).execute();
      expect(anonymized.map((row) => row.email === user.email)).toEqual([true]);
    });

    it("counts deletes per product admin after canonicalIdOf: a non-canonical id counts nothing, the 11th in a minute is 429 with Retry-After", async () => {
      const limited = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: store,
        testing: UNCALLED_TESTING,
        settings: loadSettings(process.env),
        db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits: { ...TEST_RATE_LIMITS, productAdminDeletesPerUser: { max: 10, windowMs: 60_000 } },
        runAfterResponse: (task) => runner.run(task),
      });
      try {
        await limited.ready();
        const ana = await admin();
        const send = (userId: string) =>
          limited.inject({ method: "DELETE", url: `${USERS}/${userId}`, headers: csrfHeaders, cookies: { telflo_access: ana.access } });
        expect((await send("not-a-uuid")).statusCode).toBe(404);
        for (let index = 0; index < 10; index += 1) {
          const response = await send(randomUUID());
          expect({ index, status: response.statusCode }).toEqual({ index, status: 404 });
        }
        const refused = await send(randomUUID());
        expect({ status: refused.statusCode, code: refused.json().error.code, retryAfter: Number(refused.headers["retry-after"]) > 0 }).toEqual({
          status: 429,
          code: "rate_limited",
          retryAfter: true,
        });
        // The refused delete never reached the database: ten refusals audited, not eleven.
        expect((await auditRows()).filter((row) => row.action === "product_admin.refused").length).toBe(10);
      } finally {
        await limited.close();
      }
    });

    it("revokes another person's session acting in an organization deleted with the person (account_deleted), counts it in revokedSessions, and leaves their account and other sessions alone", async () => {
      const ana = await admin();
      const cara = await person();
      const caraSession = await signIn(cara.email);
      expect(caraSession.status).toBe(200);
      const team = await group(`Team ${randomUUID()}`, cara.userId);
      // A former member of the group whose session still acts in it, and a session of theirs elsewhere.
      const quinn = await person();
      // Signed in twice before joining: both sessions start in the personal organization.
      expect((await signIn(quinn.email)).status).toBe(200);
      expect((await signIn(quinn.email)).status).toBe(200);
      await addMembership(ownerDb, { userId: quinn.userId, organizationId: team, role: "contributor" });
      const [acting] = await ownerDb.selectFrom("sessions").select("id").where("user_id", "=", quinn.userId).orderBy("created_at").limit(1).execute();
      await ownerDb.updateTable("sessions").set({ active_organization_id: team }).where("id", "=", acting!.id).execute();
      await ownerDb.updateTable("organization_members").set({ deleted_at: new Date() }).where("organization_id", "=", team).where("user_id", "=", quinn.userId).execute();
      clock = new Date();

      expect((await remove(ana.access, cara.userId)).statusCode).toBe(204);

      const quinnSessions = await ownerDb
        .selectFrom("sessions")
        .select(["id", "revoked_at", "revoked_reason"])
        .where("user_id", "=", quinn.userId)
        .orderBy("created_at")
        .execute();
      expect(quinnSessions.map(({ id, revoked_at, revoked_reason }) => ({ acting: id === acting!.id, revoked_at, revoked_reason }))).toEqual([
        { acting: true, revoked_at: clock, revoked_reason: "account_deleted" },
        { acting: false, revoked_at: null, revoked_reason: null },
      ]);
      const quinnAccount = await ownerDb.selectFrom("users").select("deleted_at").where("id", "=", quinn.userId).executeTakeFirstOrThrow();
      expect(quinnAccount.deleted_at).toBeNull();
      const deleted = (await auditRows()).find((row) => row.action === "user.deleted");
      expect(deleted?.metadata).toEqual({ deletedOrganizations: 2, deletedServiceAccounts: 0, revokedSessions: 2 });
    });

    it("deletes every organization theirs alone (a group, an expired invitation's), each audited with its own count, and keeps every other", async () => {
      const ana = await admin();
      const cara = await person();
      const solo = await group(`Solo ${randomUUID()}`, cara.userId);
      await addServiceAccount(ownerDb, { organizationId: solo });
      await addServiceAccount(ownerDb, { organizationId: solo });
      await addInvitation(ownerDb, { organizationId: solo, expires_at: new Date(clock.getTime() - 1) });
      const elsewhere = await person();
      for (const id of [cara.organizationId, solo]) await opamp.client.createOrganization({ id, name: "an organization" });
      clock = new Date();
      expect((await remove(ana.access, cara.userId)).statusCode).toBe(204);
      const deleted = await ownerDb.selectFrom("organizations").select("id").where("deleted_at", "is not", null).execute();
      expect(deleted.map((row) => row.id).sort()).toEqual([cara.organizationId, solo].sort());
      expect(deleted.some((row) => row.id === elsewhere.organizationId)).toBe(false);
      const rows = (await auditRows()).filter((row) => row.action === "organization.deleted");
      expect(Object.fromEntries(rows.map((row) => [row.organization_id, row.metadata]))).toEqual({
        [cara.organizationId]: { reason: "account_deleted", deletedServiceAccounts: 0 },
        [solo]: { reason: "account_deleted", deletedServiceAccounts: 2 },
      });
      await runner.settle();
      for (const id of [cara.organizationId, solo]) expect(await opamp.client.getOrganization(id)).toEqual({ kind: "not_found" });
    });

    it("refuses an unknown, a non-canonical, a deleted or a service account's id with 404, the caller's own with 409 user_delete_self, and each block with 409 user_delete_blocked naming its kind only; each audited, nothing changed", async () => {
      const ana = await admin();
      const member = await person();
      const groupName = `Shared ${randomUUID()}`;
      await otherMember(await group(groupName, member.userId));
      const owner = await person();
      await addInvitation(ownerDb, { organizationId: owner.organizationId });
      const flagged = await person({ admin: true });
      const gone = await person();
      await ownerDb.updateTable("users").set({ deleted_at: new Date() }).where("id", "=", gone.userId).execute();
      const bot = await addServiceAccount(ownerDb, { organizationId: owner.organizationId });
      const before = await ownerDb.selectFrom("users").selectAll().orderBy("id").execute();

      const unknown = randomUUID();
      for (const id of [unknown, "not-a-uuid", `{${unknown}}`, gone.userId, bot.user.id]) {
        const response = await remove(ana.access, id);
        expect({ id, status: response.statusCode, code: response.json().error.code }).toEqual({ id, status: 404, code: "user_not_found" });
      }
      const self = await remove(ana.access, ana.userId);
      expect({ status: self.statusCode, code: self.json().error.code }).toEqual({ status: 409, code: "user_delete_self" });
      for (const [who, kind] of [
        [member, "member"],
        [owner, "owner"],
        [flagged, "product_admin"],
      ] as const) {
        const response = await remove(ana.access, who.userId);
        expect({ kind, status: response.statusCode, body: response.json() }).toEqual({
          kind,
          status: 409,
          body: { error: { code: "user_delete_blocked", message: "This account can't be deleted yet.", details: { kind } } },
        });
        expect(response.body.includes(groupName) || response.body.includes(who.email)).toBe(false);
      }
      expect(await ownerDb.selectFrom("users").selectAll().orderBy("id").execute()).toEqual(before);
      expect(await ownerDb.selectFrom("user_deletion_records").selectAll().execute()).toEqual([]);
      const refused = (await auditRows()).filter((row) => row.action === "product_admin.refused");
      // A non-canonical id never reaches the database: four 404s, self and three blocks.
      expect(refused.map(({ subject_id, metadata }) => ({ subject_id, metadata }))).toEqual([
        { subject_id: unknown, metadata: { operation: "delete", outcome: "not_found" } },
        { subject_id: gone.userId, metadata: { operation: "delete", outcome: "not_found" } },
        { subject_id: bot.user.id, metadata: { operation: "delete", outcome: "not_found" } },
        { subject_id: ana.userId, metadata: { operation: "delete", outcome: "self" } },
        { subject_id: member.userId, metadata: { operation: "delete", outcome: "blocked" } },
        { subject_id: owner.userId, metadata: { operation: "delete", outcome: "blocked" } },
        { subject_id: flagged.userId, metadata: { operation: "delete", outcome: "blocked" } },
      ]);
      expect(await metadataHolds(groupName)).toBe(false);
    });

    it("re-reads the block under its locks: a person listed deletable who gained a member since is refused 409 user_delete_blocked (owner) and kept", async () => {
      const ana = await admin();
      const cara = await person();
      expect(blockOf((await page(ana.access)).items, cara.userId)).toBeNull();
      await otherMember(cara.organizationId);
      const response = await remove(ana.access, cara.userId);
      expect({ status: response.statusCode, details: response.json().error.details }).toEqual({ status: 409, details: { kind: "owner" } });
      const user = await ownerDb.selectFrom("users").select("deleted_at").where("id", "=", cara.userId).executeTakeFirstOrThrow();
      expect(user.deleted_at).toBeNull();
    });

    it("answers a member 403 product_admin_required", async () => {
      const member = await person();
      const { access } = await signIn(member.email);
      const cara = await person();
      expect((await remove(access, cara.userId)).statusCode).toBe(403);
    });

    describe("races, in two connections", () => {
      /** An owner's transaction held open: statements run in it until commit. */
      const hold = async () => {
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let opened!: (transaction: Transaction<Database>) => void;
        const transaction = new Promise<Transaction<Database>>((resolve) => {
          opened = resolve;
        });
        const done = ownerDb.transaction().execute(async (open) => {
          opened(open);
          await released;
        });
        const open = await transaction;
        const xid = (await sql<{ xid: string }>`select pg_current_xact_id()::text as xid`.execute(open)).rows[0]!.xid;
        return {
          run: (statement: ReturnType<typeof sql>) => statement.execute(open),
          xid,
          commit: async () => {
            release();
            await done;
          },
        };
      };

      /** Resolves once some connection waits on a row lock `xid`'s transaction holds. */
      const waitingOn = async (xid: string) => {
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          const { rows } = await sql<{ waiting: number }>`
            select count(*)::integer as waiting from pg_locks
             where locktype = 'transactionid' and transactionid::text = ${xid} and not granted
          `.execute(ownerDb);
          if (rows[0]!.waiting > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("no connection waited on the held transaction");
      };

      const userDeletedAt = async (userId: string) =>
        (await ownerDb.selectFrom("users").select("deleted_at").where("id", "=", userId).executeTakeFirstOrThrow()).deleted_at;

      it("a delete by an admin removed while it waited on the caller's lock answers 403 product_admin_required, audited, and deletes nothing", async () => {
        const ana = await admin();
        const ben = await person({ admin: true });
        const cara = await person();
        let commit!: () => void;
        const held = new Promise<void>((resolve) => {
          commit = resolve;
        });
        let revoked!: (xid: string) => void;
        const revokedIn = new Promise<string>((resolve) => {
          revoked = resolve;
        });
        const removal = withProductAdminContext(db, ben.userId, async (transaction) => {
          const { rows } = await sql<{ outcome: string }>`select product_admin_revoke(${ana.userId}::uuid, now()) as outcome`.execute(transaction);
          revoked((await sql<{ xid: string }>`select pg_current_xact_id()::text as xid`.execute(transaction)).rows[0]!.xid);
          await held;
          return rows[0]!.outcome;
        });
        const revocation = await revokedIn;
        const deleting = remove(ana.access, cara.userId);
        await waitingOn(revocation);
        commit();
        expect(await removal).toBe("revoked");
        const response = await deleting;
        expect({ status: response.statusCode, code: response.json().error.code }).toEqual({ status: 403, code: "product_admin_required" });
        expect(await userDeletedAt(cara.userId)).toBeNull();
        const refused = (await auditRows()).filter((row) => row.action === "product_admin.refused");
        expect(refused.map(({ subject_id, metadata }) => ({ subject_id, metadata }))).toEqual([
          { subject_id: cara.userId, metadata: { operation: "delete", outcome: "forbidden" } },
        ]);
      });

      it("an organization's delete (its organization, then its members' accounts) interleaved with the person's delete: no deadlock; the delete waits, then deletes the person with what is left", async () => {
        const ana = await admin();
        const cara = await person();
        const team = await group(`Team ${randomUUID()}`, cara.userId);
        // The organization's delete, by hand in its lock order: the organization first.
        const organizationDelete = await hold();
        await organizationDelete.run(sql`select id from organizations where id = ${team}::uuid for no key update`);
        const deleting = remove(ana.access, cara.userId);
        await waitingOn(organizationDelete.xid);
        // Then its members' accounts: the person's delete holds no user lock yet, so this doesn't wait.
        await organizationDelete.run(sql`select id from users where id = ${cara.userId}::uuid order by id for no key update`);
        await organizationDelete.run(sql`update organizations set deleted_at = now(), updated_at = now() where id = ${team}::uuid`);
        await organizationDelete.commit();
        expect((await deleting).statusCode).toBe(204);
        expect(await userDeletedAt(cara.userId)).not.toBeNull();
        const deleted = (await auditRows()).find((row) => row.action === "user.deleted");
        expect(deleted?.metadata).toEqual({ deletedOrganizations: 1, deletedServiceAccounts: 0, revokedSessions: 0 });
      });

      it("a grant's locks (the caller, then the target, by id) interleaved with the delete's: no deadlock; a grant committed meanwhile makes the person a product admin, and the delete is refused (blocked, product_admin)", async () => {
        const ana = await admin();
        const cara = await person();
        expect(ana.userId < cara.userId).toBe(true);
        // A grant by Ana of Cara, by hand in its lock order: Ana first (the lower id).
        const grant = await hold();
        await grant.run(sql`select id from users where id = ${ana.userId}::uuid for update`);
        const deleting = remove(ana.access, cara.userId);
        await waitingOn(grant.xid);
        await grant.run(sql`select id from users where id = ${cara.userId}::uuid for update`);
        await grant.run(sql`update users set is_product_admin = true where id = ${cara.userId}::uuid`);
        await grant.commit();
        const response = await deleting;
        expect({ status: response.statusCode, details: response.json().error.details }).toEqual({ status: 409, details: { kind: "product_admin" } });
        expect(await userDeletedAt(cara.userId)).toBeNull();
      });

      /**
       * Each attempt is held at an organization's lock while the person
       * joins another group, then let go: its re-read finds the set changed.
       */
      const changingSet = async (changes: number) => {
        const ana = await admin();
        const cara = await person();
        const groups: string[] = [];
        for (let index = 0; index < changes; index += 1) {
          const row = await ownerDb
            .insertInto("organizations")
            .values({ name: `Joined ${randomUUID()}`, type: "group" })
            .returning("id")
            .executeTakeFirstOrThrow();
          groups.push(row.id);
        }
        // Holder i holds the organization attempt i+1 locks last: Cara's own, then each group joined.
        const holders = [];
        for (const id of [cara.organizationId, ...groups.slice(0, changes - 1)]) {
          const holder = await hold();
          await holder.run(sql`select id from organizations where id = ${id}::uuid for no key update`);
          holders.push(holder);
        }
        const deleting = remove(ana.access, cara.userId);
        for (const [index, holder] of holders.entries()) {
          await waitingOn(holder.xid);
          await addMembership(ownerDb, { userId: cara.userId, organizationId: groups[index]! });
          await holder.commit();
        }
        return { ana, cara, groups, response: await deleting };
      };

      it("starts again when the person joined an organization while the delete took its locks, and deletes them with it", async () => {
        const { cara, groups, response } = await changingSet(1);
        expect(response.statusCode).toBe(204);
        expect(await userDeletedAt(cara.userId)).not.toBeNull();
        const deleted = await ownerDb.selectFrom("organizations").select("id").where("deleted_at", "is not", null).execute();
        expect(deleted.map((row) => row.id).sort()).toEqual([cara.organizationId, groups[0]!].sort());
      });

      it("answers 409 user_delete_busy after three attempts whose set changed each time, audited, and deletes nothing", async () => {
        const { cara, response } = await changingSet(3);
        expect({ status: response.statusCode, body: response.json() }).toEqual({
          status: 409,
          body: { error: { code: "user_delete_busy", message: "The account changed while it was being deleted. Try again." } },
        });
        expect(await userDeletedAt(cara.userId)).toBeNull();
        expect((await ownerDb.selectFrom("organizations").select("id").where("deleted_at", "is not", null).execute()).length).toBe(0);
        const refused = (await auditRows()).filter((row) => row.action === "product_admin.refused");
        expect(refused.map(({ subject_id, metadata }) => ({ subject_id, metadata }))).toEqual([
          { subject_id: cara.userId, metadata: { operation: "delete", outcome: "busy" } },
        ]);
      });
    });
  });
});
