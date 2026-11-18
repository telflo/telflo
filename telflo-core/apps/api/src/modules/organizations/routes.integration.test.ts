import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Pool, PoolClient } from "pg";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, ORGANIZATION_LOGO_MAXIMUM_BYTES } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addApiToken,
  addMembership,
  addServiceAccount,
  createUserWithOrganization,
  removeMembership,
  truncateAll,
  withFailingInsert,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createFileStore } from "../../file-store/create-file-store.js";
import { FileStoreError, type FileKey, type IFileStore } from "../../file-store/file-store.js";
import { hashPassword } from "../identity/password.js";
import { hashToken } from "../identity/tokens.js";
import { createAccessTokens } from "../sessions/access-tokens.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

describe("organization routes", () => {
  let settings: AppSettings;
  /** The tables' owner's pool, whose connections hold row locks. */
  let pool: Pool;
  /** The server's connection, as the API's own role. */
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation, test-only DDL and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began. */
  let logLines: string[] = [];
  /**
   * The file store the shared server reaches: UNCALLED_FILE_STORE, so every
   * test but the logos' fails should it touch the store (an organization
   * with no logo never does: D23-2 decision 38). The logos' tests point it
   * at their recording store for the test's length.
   */
  let currentStore: IFileStore = UNCALLED_FILE_STORE;
  const sharedStore: IFileStore = {
    write: (key, content, options) => currentStore.write(key, content, options),
    read: (key) => currentStore.read(key),
    copy: (from, to) => currentStore.copy(from, to),
    remove: (key) => currentStore.remove(key),
  };
  /** Servers built by a test, closed at the end. */
  const extraServers: FastifyInstance[] = [];

  /**
   * A server on the test database: by default with no file store
   * (UNCALLED_FILE_STORE) and the tests' rate limits. Server errors are
   * logged to `logLines`, so a test can name the database error behind a
   * 500. Tests otherwise run silent.
   */
  const buildTestServer = (options: { fileStore?: IFileStore; rateLimits?: RateLimits } = {}) => {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error";
    try {
      return buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: options.fileStore ?? UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits: options.rateLimits ?? TEST_RATE_LIMITS,
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  };

  beforeAll(async () => {
    settings = loadSettings(process.env);
    pool = createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!);
    ownerDb = createDb(pool);
    db = createDb(createPool(settings.databaseUrl));
    server = buildTestServer({ fileStore: sharedStore });
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await Promise.all(extraServers.map((extra) => extra.close()));
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    clock = new Date();
    logLines = [];
  });

  /** The SQLSTATE of every database error the server logged, in order. */
  const loggedDatabaseErrorCodes = () =>
    logLines.flatMap((line) => {
      const entry = JSON.parse(line) as { err?: { code?: unknown } };
      const code = entry.err?.code;
      return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? [code] : [];
    });

  const verifiedUser = (overrides: Parameters<typeof createUserWithOrganization>[1] = {}) =>
    createUserWithOrganization(ownerDb, {
      ...overrides,
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash, ...overrides.user },
    });

  /** Signs in, which lands in the personal organization, and returns the two cookie values. */
  const signedIn = async (email: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return { access: cookieValue(response, "telflo_access"), refresh: cookieValue(response, "telflo_refresh") };
  };

  /** Switches the session to `organizationId`; returns the new access cookie's value. */
  const switchTo = async (access: string, organizationId: string) => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { organizationId },
    });
    expect(response.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return response.headers["set-cookie"] === undefined ? access : cookieValue(response, "telflo_access");
  };

  const me = (access: string) =>
    server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } });

  const refresh = (refreshToken: string) =>
    server.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: csrfHeaders,
      cookies: { telflo_refresh: refreshToken },
    });

  const create = (access: string, name: unknown) =>
    server.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name },
    });

  const rename = (access: string, organizationId: string, name: string) =>
    server.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${organizationId}`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name },
    });

  const remove = (access: string, organizationId: string) =>
    server.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${organizationId}`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
    });

  const organizationRow = (id: string) =>
    ownerDb.selectFrom("organizations").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

  const auditRows = (action: string) =>
    ownerDb.selectFrom("audit_events").selectAll().where("action", "=", action).orderBy("id").execute();

  const auditActions = async () =>
    (await ownerDb.selectFrom("audit_events").select("action").execute()).map((row) => row.action);

  /** A group organization with an exact name, whose only member is a new user (so it has an admin). */
  const groupNamed = async (name: string) =>
    (await createUserWithOrganization(ownerDb, { organization: { type: "group", name } })).organization;

  /**
   * A signed-in user who is a `role` of a group organization and has
   * switched into it, so it is their active organization.
   */
  const memberActiveInGroup = async (role: OrganizationRole = "admin", organizationId?: string) => {
    const account = await verifiedUser();
    const { organization: group } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const cookies = await signedIn(account.user.email);
    const access = await switchTo(cookies.access, group.id);
    return { account, personal: account.organization, group, access, refresh: cookies.refresh };
  };

  describe("POST /api/v1/organizations", () => {
    it("creates a group organization with the caller as its admin and no owner, without switching to it", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);

      const response = await create(access, "  Acme Corp  ");

      expect(response.statusCode).toBe(201);
      const { organization } = response.json<{ organization: { id: string } }>();
      expect(organization).toEqual({ id: expect.any(String), name: "Acme Corp", type: "group", logoId: null });
      expect(await organizationRow(organization.id)).toMatchObject({
        name: "Acme Corp",
        type: "group",
        owner_user_id: null,
        deleted_at: null,
      });
      const members = await ownerDb
        .selectFrom("organization_members")
        .selectAll()
        .where("organization_id", "=", organization.id)
        .execute();
      expect(members).toEqual([expect.objectContaining({ user_id: account.user.id, role: "admin", deleted_at: null })]);

      const after = await me(access);
      expect(after.json()).toMatchObject({
        organization: { id: account.organization.id },
        organizations: [
          { id: account.organization.id, type: "personal", role: "admin" },
          { id: organization.id, name: "Acme Corp", type: "group", logoId: null, role: "admin" },
        ],
      });
    });

    it("writes organization.created and organization_member.added, in the new organization", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);

      const { organization } = (await create(access, "Acme")).json<{ organization: { id: string } }>();

      const actor = { actor_user_id: account.user.id, actor_email: account.user.email, organization_id: organization.id };
      expect(await auditRows("organization.created")).toEqual([
        expect.objectContaining({
          ...actor,
          subject_type: "organization",
          subject_id: organization.id,
          metadata: { type: "group", name: "Acme" },
        }),
      ]);
      expect(await auditRows("organization_member.added")).toEqual([
        expect.objectContaining({
          ...actor,
          subject_type: "user",
          subject_id: account.user.id,
          metadata: { role: "admin" },
        }),
      ]);
    });

    it("lets anyone signed in create one, whatever their role in the active organization", async () => {
      const { access } = await memberActiveInGroup("contributor");
      expect((await create(access, "Mine")).statusCode).toBe(201);
    });

    it.each(["Acme Corp", "ACME CORP", "acme corp"])(
      "answers %s, while a live group organization is Acme Corp, with 409 organization_name_taken",
      async (name) => {
        const taken = await groupNamed("Acme Corp");
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);

        const response = await create(access, name);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          error: { code: "organization_name_taken", message: "That name is invalid or already exists" },
        });
        const groups = await ownerDb.selectFrom("organizations").select("id").where("type", "=", "group").execute();
        expect(groups).toEqual([{ id: taken.id }]);
        expect(await auditActions()).not.toContain("organization.created");
      },
    );

    it("allows a name taken only by a personal organization or a deleted group organization", async () => {
      await verifiedUser({ organization: { name: "Personal Name" } });
      const formerMember = await verifiedUser();
      const { organization: deleted } = await addMembership(ownerDb, { userId: formerMember.user.id });
      await ownerDb
        .updateTable("organizations")
        .set({ name: "Deleted Name", deleted_at: new Date() })
        .where("id", "=", deleted.id)
        .execute();
      const holder = await verifiedUser();
      const { access } = await signedIn(holder.user.email);

      expect((await create(access, "personal name")).statusCode).toBe(201);
      expect((await create(access, "DELETED NAME")).statusCode).toBe(201);
    });

    it("rolls everything back when the membership insert fails", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);

      await withFailingInsert(ownerDb, "organization_members", "raise exception 'membership insert refused'", async () => {
        const response = await create(access, "Doomed");
        expect(response.statusCode).toBe(500);
      });

      expect(await ownerDb.selectFrom("organizations").select("name").where("name", "=", "Doomed").execute()).toEqual([]);
      expect(await auditActions()).toEqual(["user.signed_in"]);
    });

    it("refuses an empty or whitespace-only name with 400 and its message", async () => {
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);

      for (const name of ["", "   "]) {
        const response = await create(access, name);
        expect(response.statusCode).toBe(400);
        expect(JSON.stringify(response.json())).toContain("Organization name is required");
      }
      expect((await create(access, "a".repeat(101))).statusCode).toBe(400);
    });

    it("is 401 unauthenticated without a session", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: csrfHeaders,
        payload: { name: "Acme" },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("PATCH /api/v1/organizations/:organizationId", () => {
    it("renames the active organization for an admin, and audits from and to", async () => {
      const { account, group, access } = await memberActiveInGroup("admin");

      const response = await rename(access, group.id, "  Renamed  ");

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ organization: { id: group.id, name: "Renamed", type: "group", logoId: null } });
      expect((await organizationRow(group.id)).name).toBe("Renamed");
      expect(await auditRows("organization.renamed")).toEqual([
        expect.objectContaining({
          actor_user_id: account.user.id,
          actor_email: account.user.email,
          organization_id: group.id,
          subject_type: "organization",
          subject_id: group.id,
          metadata: { from: group.name, to: "Renamed" },
        }),
      ]);
    });

    it("answers renaming to the current name with 200, changing and auditing nothing", async () => {
      const { group, access } = await memberActiveInGroup("admin");

      const response = await rename(access, group.id, group.name);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ organization: { id: group.id, name: group.name, type: "group", logoId: null } });
      expect((await organizationRow(group.id)).updated_at).toEqual(group.updated_at);
      expect(await auditRows("organization.renamed")).toEqual([]);
    });

    it("refuses a contributor with 403 organization_admin_required, changing nothing", async () => {
      const { group, access } = await memberActiveInGroup("contributor");

      const response = await rename(access, group.id, "Renamed");

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "organization_admin_required" } });
      expect((await organizationRow(group.id)).name).toBe(group.name);
      expect(await auditRows("organization.renamed")).toEqual([]);
    });

    it("answers a clash with a live group organization's name, in any case, with 409", async () => {
      await groupNamed("Taken");
      const { group, access } = await memberActiveInGroup("admin");

      const response = await rename(access, group.id, "TAKEN");

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: { code: "organization_name_taken", message: "That name is invalid or already exists" },
      });
      expect((await organizationRow(group.id)).name).toBe(group.name);
    });

    it("answers another organization's id with 404 organization_not_found, even for its admin", async () => {
      // An admin of both, acting in their personal organization.
      const account = await verifiedUser();
      // Signed in before joining: the session starts in the personal organization (D36-1 decision 56).
      const { access } = await signedIn(account.user.email);
      const { organization: other } = await addMembership(ownerDb, { userId: account.user.id, role: "admin" });

      for (const organizationId of [other.id, "0190a5b0-0000-7000-8000-00000000abcd", "not-an-id"]) {
        const response = await rename(access, organizationId, "Renamed");
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { code: "organization_not_found", message: "Organization not found" } });
      }
      expect((await organizationRow(other.id)).name).toBe(other.name);
      expect(await auditRows("organization.renamed")).toEqual([]);
    });

    it("answers another organization's id with 404 for a non-admin too, before the role check", async () => {
      const { access } = await memberActiveInGroup("contributor");
      const stranger = await groupNamed("Stranger");
      const response = await rename(access, stranger.id, "Renamed");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "organization_not_found" } });
    });

    it("refuses an admin demoted while their rename waited on the organization lock (decision 8)", async () => {
      // A separate connection holds the organization `for no key update`, as a
      // concurrent role change does, and demotes the admin. Their request
      // read the role as admin before it reached the lock; the re-check
      // under the lock must see the demotion once it commits.
      const { account, group, access } = await memberActiveInGroup("admin");

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from organizations where id = $1 for no key update", [group.id]);
        await locker.query(
          "update organization_members set role = 'contributor' where organization_id = $1 and user_id = $2",
          [group.id, account.user.id],
        );

        const renaming = rename(access, group.id, "Renamed");
        renaming.catch(() => undefined);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const { rows } = await sql<{ waiting: number }>`
            select count(*)::int as waiting
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%organizations%'
          `.execute(ownerDb);
          if ((rows[0]?.waiting ?? 0) >= 1) break;
          if (Date.now() > deadline) throw new Error("timed out waiting for the rename to wait on the organization");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        await locker.query("commit");
        lockerInTransaction = false;

        const response = await renaming;
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "organization_admin_required" } });
        expect((await organizationRow(group.id)).name).toBe(group.name);
        expect(await auditRows("organization.renamed")).toEqual([]);
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });
  });

  describe("settings (D17d-2 decision 20)", () => {
    const readSettings = (access: string, organizationId: string) =>
      server.inject({ method: "GET", url: `/api/v1/organizations/${organizationId}/settings`, cookies: { telflo_access: access } });

    const changeSettings = (access: string, organizationId: string, payload: unknown, headers: Record<string, string> = csrfHeaders) =>
      server.inject({
        method: "PATCH",
        url: `/api/v1/organizations/${organizationId}/settings`,
        headers,
        cookies: { telflo_access: access },
        payload: payload as Record<string, unknown>,
      });

    const switchOf = async (organizationId: string) => (await organizationRow(organizationId)).public_install_links_enabled;

    it("GET settings answers any member publicInstallLinks true by default", async () => {
      for (const role of ["admin", "contributor"] as const) {
        const { group, access } = await memberActiveInGroup(role);
        const response = await readSettings(access, group.id);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ publicInstallLinks: true });
      }
      // A personal organization's own member too, and an organization switched off reads false.
      const account = await verifiedUser();
      const { access } = await signedIn(account.user.email);
      expect((await readSettings(access, account.organization.id)).json()).toEqual({ publicInstallLinks: true });
      await ownerDb
        .updateTable("organizations")
        .set({ public_install_links_enabled: false })
        .where("id", "=", account.organization.id)
        .execute();
      expect((await readSettings(access, account.organization.id)).json()).toEqual({ publicInstallLinks: false });
    });

    it("PATCH settings by an admin turns it off and on, audited organization.settings_changed with its value; the same value writes nothing", async () => {
      const { account, group, access } = await memberActiveInGroup("admin");
      const audited = { actor_user_id: account.user.id, actor_email: account.user.email, organization_id: group.id };

      const off = await changeSettings(access, group.id, { publicInstallLinks: false });
      expect(off.statusCode).toBe(200);
      expect(off.json()).toEqual({ publicInstallLinks: false });
      expect(await switchOf(group.id)).toBe(false);
      expect((await readSettings(access, group.id)).json()).toEqual({ publicInstallLinks: false });

      // The same value again: 200, nothing written, nothing audited.
      const offRow = await organizationRow(group.id);
      const again = await changeSettings(access, group.id, { publicInstallLinks: false });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ publicInstallLinks: false });
      expect(await organizationRow(group.id)).toEqual(offRow);

      const on = await changeSettings(access, group.id, { publicInstallLinks: true });
      expect(on.statusCode).toBe(200);
      expect(on.json()).toEqual({ publicInstallLinks: true });
      expect(await switchOf(group.id)).toBe(true);

      expect(await auditRows("organization.settings_changed")).toEqual([
        expect.objectContaining({ ...audited, subject_type: "organization", subject_id: group.id, metadata: { publicInstallLinks: false } }),
        expect.objectContaining({ ...audited, subject_type: "organization", subject_id: group.id, metadata: { publicInstallLinks: true } }),
      ]);
      // The body is the switch alone: anything else is 400, changing nothing.
      for (const payload of [{}, { publicInstallLinks: "false" }, { publicInstallLinks: false, name: "Renamed" }]) {
        expect((await changeSettings(access, group.id, payload)).statusCode).toBe(400);
      }
      expect(await switchOf(group.id)).toBe(true);
      expect(await auditRows("organization.settings_changed")).toHaveLength(2);
    });

    it("PATCH settings by a contributor is 403 organization_admin_required, changing nothing", async () => {
      const { group, access } = await memberActiveInGroup("contributor");

      for (const publicInstallLinks of [false, true]) {
        const response = await changeSettings(access, group.id, { publicInstallLinks });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "organization_admin_required" } });
      }
      expect(await switchOf(group.id)).toBe(true);
      expect(await auditRows("organization.settings_changed")).toEqual([]);
    });

    it("another organization's settings are 404", async () => {
      // An admin of both, acting in their personal organization.
      const account = await verifiedUser();
      // Signed in before joining: the session starts in the personal organization (D36-1 decision 56).
      const { access } = await signedIn(account.user.email);
      const { organization: other } = await addMembership(ownerDb, { userId: account.user.id, role: "admin" });
      const stranger = await groupNamed("Stranger");

      for (const organizationId of [other.id, stranger.id, "0190a5b0-0000-7000-8000-00000000abcd", "not-an-id"]) {
        const read = await readSettings(access, organizationId);
        expect(read.statusCode).toBe(404);
        expect(read.json()).toEqual({ error: { code: "organization_not_found", message: "Organization not found" } });
        const change = await changeSettings(access, organizationId, { publicInstallLinks: false });
        expect(change.statusCode).toBe(404);
        expect(change.json()).toEqual({ error: { code: "organization_not_found", message: "Organization not found" } });
      }
      expect(await switchOf(other.id)).toBe(true);
      expect(await switchOf(stranger.id)).toBe(true);
      expect(await auditRows("organization.settings_changed")).toEqual([]);
    });

    it("PATCH without the CSRF header is refused", async () => {
      const { group, access } = await memberActiveInGroup("admin");

      const response = await changeSettings(access, group.id, { publicInstallLinks: false }, {});

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "csrf_header_missing" } });
      expect(await switchOf(group.id)).toBe(true);
      expect(await auditRows("organization.settings_changed")).toEqual([]);
    });

    it("refuses an admin demoted while their settings change waited on the organization lock (Ruling 39)", async () => {
      // The rename's sibling: a separate connection holds the organization
      // `for no key update`, as a concurrent role change does, and demotes the
      // admin. Their request read the role as admin before it reached the
      // lock; the re-check under the lock must see the demotion once it commits.
      const { account, group, access } = await memberActiveInGroup("admin");

      const locker = await pool.connect();
      let lockerInTransaction = false;
      try {
        await locker.query("begin");
        lockerInTransaction = true;
        await locker.query("select id from organizations where id = $1 for no key update", [group.id]);
        await locker.query(
          "update organization_members set role = 'contributor' where organization_id = $1 and user_id = $2",
          [group.id, account.user.id],
        );

        const changing = changeSettings(access, group.id, { publicInstallLinks: false });
        changing.catch(() => undefined);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const { rows } = await sql<{ waiting: number }>`
            select count(*)::int as waiting
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ilike '%organizations%'
          `.execute(ownerDb);
          if ((rows[0]?.waiting ?? 0) >= 1) break;
          if (Date.now() > deadline) throw new Error("timed out waiting for the settings change to wait on the organization");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        await locker.query("commit");
        lockerInTransaction = false;

        const response = await changing;
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "organization_admin_required" } });
        expect(await switchOf(group.id)).toBe(true);
        expect(await auditRows("organization.settings_changed")).toEqual([]);
      } finally {
        if (lockerInTransaction) await locker.query("rollback");
        locker.release();
      }
    });

    it("a removed member's settings GET and PATCH are 404 once their token refreshes, changing and auditing nothing", async () => {
      const admin = await memberActiveInGroup("admin");
      const member = await memberActiveInGroup("admin", admin.group.id);
      const removed = await server.inject({
        method: "DELETE",
        url: `/api/v1/organizations/${admin.group.id}/members/${member.account.user.id}`,
        headers: csrfHeaders,
        cookies: { telflo_access: admin.access },
      });
      expect(removed.statusCode).toBe(204);

      // The token from before the removal is refused outright.
      expect((await changeSettings(member.access, admin.group.id, { publicInstallLinks: false })).statusCode).toBe(401);
      const access = cookieValue(await refresh(member.refresh), "telflo_access");

      const read = await readSettings(access, admin.group.id);
      expect(read.statusCode).toBe(404);
      expect(read.json()).toEqual({ error: { code: "organization_not_found", message: "Organization not found" } });
      const change = await changeSettings(access, admin.group.id, { publicInstallLinks: false });
      expect(change.statusCode).toBe(404);
      expect(change.json()).toEqual({ error: { code: "organization_not_found", message: "Organization not found" } });
      expect(await switchOf(admin.group.id)).toBe(true);
      expect(await auditRows("organization.settings_changed")).toEqual([]);
    });

    it("a deleted organization's settings GET and PATCH are 404 once its admins' tokens refresh, changing and auditing nothing", async () => {
      const admin = await memberActiveInGroup("admin");
      const second = await memberActiveInGroup("admin", admin.group.id);
      expect((await remove(admin.access, admin.group.id)).statusCode).toBe(204);

      // Both admins' sessions were reassigned: the tokens from before are refused outright.
      expect((await changeSettings(second.access, admin.group.id, { publicInstallLinks: false })).statusCode).toBe(401);
      for (const { refresh: refreshToken } of [admin, second]) {
        const access = cookieValue(await refresh(refreshToken), "telflo_access");
        const read = await readSettings(access, admin.group.id);
        expect(read.statusCode).toBe(404);
        expect(read.json()).toEqual({ error: { code: "organization_not_found", message: "Organization not found" } });
        const change = await changeSettings(access, admin.group.id, { publicInstallLinks: false });
        expect(change.statusCode).toBe(404);
        expect(change.json()).toEqual({ error: { code: "organization_not_found", message: "Organization not found" } });
      }
      expect(await switchOf(admin.group.id)).toBe(true);
      expect(await auditRows("organization.settings_changed")).toEqual([]);
    });
  });

  describe("DELETE /api/v1/organizations/:organizationId", () => {
    it("marks a group organization deleted; the admin stays signed in and it disappears from their /me", async () => {
      const { account, personal, group, access, refresh: refreshToken } = await memberActiveInGroup("admin");

      const response = await remove(access, group.id);

      expect(response.statusCode).toBe(204);
      expect((await organizationRow(group.id)).deleted_at).not.toBeNull();
      // Their own session was reassigned: the old token is stale, and a refresh lands in the fallback.
      expect((await me(access)).json()).toMatchObject({ error: { code: "access_token_expired" } });
      const refreshed = await refresh(refreshToken);
      expect(refreshed.statusCode).toBe(200);
      const after = await me(cookieValue(refreshed, "telflo_access"));
      expect(after.json()).toMatchObject({
        user: { id: account.user.id },
        organization: { id: personal.id, type: "personal" },
        organizations: [{ id: personal.id }],
      });
    });

    it("reassigns members' sessions active in it, and they stay signed in", async () => {
      const admin = await memberActiveInGroup("admin");
      const member = await memberActiveInGroup("contributor", admin.group.id);
      const elsewhere = await verifiedUser();
      // Signed in before joining: the session starts in the personal organization (D36-1 decision 56).
      const elsewhereCookies = await signedIn(elsewhere.user.email);
      await addMembership(ownerDb, { userId: elsewhere.user.id, organizationId: admin.group.id });

      expect((await remove(admin.access, admin.group.id)).statusCode).toBe(204);

      // The member's next request refreshes, then /me shows their personal organization.
      const stale = await me(member.access);
      expect(stale.statusCode).toBe(401);
      expect(stale.json()).toMatchObject({ error: { code: "access_token_expired" } });
      const refreshed = await refresh(member.refresh);
      expect(refreshed.statusCode).toBe(200);
      const after = await me(cookieValue(refreshed, "telflo_access"));
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({
        organization: { id: member.personal.id },
        organizations: [{ id: member.personal.id }],
      });
      const memberSession = await ownerDb
        .selectFrom("sessions")
        .selectAll()
        .where("user_id", "=", member.account.user.id)
        .executeTakeFirstOrThrow();
      expect(memberSession).toMatchObject({ active_organization_id: member.personal.id, revoked_at: null });
      // A member whose session was elsewhere is untouched.
      expect((await me(elsewhereCookies.access)).statusCode).toBe(200);
    });

    it("soft-deletes the accounts whose only membership it held, a service account's among them, ends their sessions, and audits the counts", async () => {
      const admin = await memberActiveInGroup("admin");
      const member = await memberActiveInGroup("contributor", admin.group.id);
      // A person whose only membership is here, with a session: a shape the
      // owner writes and no API path creates (a service account can have no
      // session, D22 decision 18), which the deletion must still handle.
      const onlyHere = await ownerDb.transaction().execute(async (transaction) => {
        const user = await transaction
          .insertInto("users")
          .values({ email: "only-here@example.com", email_verified_at: new Date() })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("organization_members")
          .values({ organization_id: admin.group.id, user_id: user.id, role: "contributor" })
          .execute();
        return { user };
      });
      const session = await ownerDb
        .insertInto("sessions")
        .values({ user_id: onlyHere.user.id, active_organization_id: admin.group.id })
        .returning("id")
        .executeTakeFirstOrThrow();
      const token = await createAccessTokens({
        secret: settings.accessTokenSecret,
        ttlMinutes: settings.accessTokenTtlMinutes,
        now: () => clock,
      }).issue({ userId: onlyHere.user.id, sessionId: session.id, organizationId: admin.group.id });
      expect((await me(token.token)).statusCode).toBe(200);
      // A real service account of the group, with a live token (D22
      // decisions 20 and 21): its only membership is here too. The token
      // check's lookup is called as the API's role, as the check will.
      const { user: serviceAccount } = await addServiceAccount(ownerDb, { organizationId: admin.group.id });
      const { apiToken } = await addApiToken(ownerDb, {
        organizationId: admin.group.id,
        serviceAccountUserId: serviceAccount.id,
      });
      const lookUp = async () =>
        (
          await sql<{ token_id: string }>`
            select token_id from find_live_api_token_by_hash(${apiToken.token_hash}, ${clock})
          `.execute(db)
        ).rows.map((row) => row.token_id);
      expect(await lookUp()).toEqual([apiToken.id]);

      expect((await remove(admin.access, admin.group.id)).statusCode).toBe(204);

      const user = await ownerDb
        .selectFrom("users")
        .selectAll()
        .where("id", "=", onlyHere.user.id)
        .executeTakeFirstOrThrow();
      expect(user.deleted_at).not.toBeNull();
      // D5's deletion, unchanged: the service account's user soft-deleted,
      // its row, membership and token left as they were, and the lookup
      // answering no row.
      const serviceUser = await ownerDb
        .selectFrom("users")
        .select("deleted_at")
        .where("id", "=", serviceAccount.id)
        .executeTakeFirstOrThrow();
      expect(serviceUser.deleted_at).not.toBeNull();
      expect(
        await ownerDb
          .selectFrom("api_tokens")
          .select("revoked_at")
          .where("id", "=", apiToken.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: null });
      expect(await lookUp()).toEqual([]);
      const response = await me(token.token);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "unauthenticated" } });
      expect(
        await ownerDb.selectFrom("sessions").selectAll().where("id", "=", session.id).executeTakeFirstOrThrow(),
      ).toMatchObject({ revoked_reason: "organization_access_lost" });
      const memberSession = await ownerDb
        .selectFrom("sessions")
        .select("active_organization_id")
        .where("user_id", "=", member.account.user.id)
        .executeTakeFirstOrThrow();
      expect(memberSession).toEqual({ active_organization_id: member.personal.id });

      expect(await auditRows("organization.deleted")).toEqual([
        expect.objectContaining({
          actor_user_id: admin.account.user.id,
          actor_email: admin.account.user.email,
          organization_id: admin.group.id,
          subject_type: "organization",
          subject_id: admin.group.id,
          // The person and the service account; the admin's, the member's
          // and the person's sessions (the service account has none).
          metadata: { deletedAccounts: 2, reassignedSessions: 3 },
        }),
      ]);
    });

    it("refuses a personal organization with 409 personal_organization_protected, changing nothing", async () => {
      const account = await verifiedUser();
      // Signed in before joining: the session starts in the personal organization (D36-1 decision 56).
      const { access } = await signedIn(account.user.email);
      await addMembership(ownerDb, { userId: account.user.id });

      const response = await remove(access, account.organization.id);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "personal_organization_protected" } });
      expect((await organizationRow(account.organization.id)).deleted_at).toBeNull();
      expect((await me(access)).statusCode).toBe(200);
      expect(await auditRows("organization.deleted")).toEqual([]);
    });

    it("refuses a contributor with 403, changing nothing", async () => {
      const { group, access } = await memberActiveInGroup("contributor");

      const response = await remove(access, group.id);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "organization_admin_required" } });
      expect((await organizationRow(group.id)).deleted_at).toBeNull();
    });

    it("answers another organization's id with 404, even for its admin", async () => {
      const account = await verifiedUser();
      // Signed in before joining: the session starts in the personal organization (D36-1 decision 56).
      const { access } = await signedIn(account.user.email);
      const { organization: other } = await addMembership(ownerDb, { userId: account.user.id });

      const response = await remove(access, other.id);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "organization_not_found" } });
      expect((await organizationRow(other.id)).deleted_at).toBeNull();
    });
  });

  describe("members (D5 decisions 7, 8 and 9)", () => {
    const membersUrl = (organizationId: string, userId?: string) =>
      `/api/v1/organizations/${organizationId}/members${userId === undefined ? "" : `/${userId}`}`;

    const listMembers = (access: string, organizationId: string) =>
      server.inject({ method: "GET", url: membersUrl(organizationId), cookies: { telflo_access: access } });

    const changeRole = (access: string, organizationId: string, userId: string, role: unknown) =>
      server.inject({
        method: "PATCH",
        url: membersUrl(organizationId, userId),
        headers: csrfHeaders,
        cookies: { telflo_access: access },
        payload: { role },
      });

    const removeMember = (access: string, organizationId: string, userId: string) =>
      server.inject({
        method: "DELETE",
        url: membersUrl(organizationId, userId),
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });

    const restoreMember = (access: string, organizationId: string, userId: string) =>
      server.inject({
        method: "PUT",
        url: `${membersUrl(organizationId, userId)}/restoration`,
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });

    type MemberRequest = (access: string, organizationId: string, userId: string) => Promise<LightMyRequestResponse>;

    const changeRoleToAdmin: MemberRequest = (access, organizationId, userId) =>
      changeRole(access, organizationId, userId, "admin");

    /** The three changes, as `[name, request]`, for the tests every one of them must pass. */
    const changes = [
      ["a role change", changeRoleToAdmin],
      ["a removal", removeMember],
      ["a restore", restoreMember],
    ] as const;

    /** Every member endpoint, the list included, as `[name, request]`. */
    const endpoints = [
      ["the list", ((access, organizationId) => listMembers(access, organizationId)) satisfies MemberRequest],
      ...changes,
    ] as const;

    const switchResponse = (access: string, organizationId: string) =>
      server.inject({
        method: "PUT",
        url: "/api/v1/auth/sessions/current/organization",
        headers: csrfHeaders,
        cookies: { telflo_access: access },
        payload: { organizationId },
      });

    const membershipRow = (organizationId: string, userId: string) =>
      ownerDb
        .selectFrom("organization_members")
        .selectAll()
        .where("organization_id", "=", organizationId)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();

    /** Every membership of the organization and every session, to show a refusal changed nothing. */
    const snapshot = async (organizationId: string) => ({
      memberships: await ownerDb
        .selectFrom("organization_members")
        .selectAll()
        .where("organization_id", "=", organizationId)
        .orderBy("id")
        .execute(),
      sessions: await ownerDb.selectFrom("sessions").selectAll().orderBy("id").execute(),
    });

    const memberAudits = async () =>
      (
        await ownerDb
          .selectFrom("audit_events")
          .select("action")
          .where("action", "like", "organization_member.%")
          .where("action", "<>", "organization_member.added")
          .execute()
      ).map((row) => row.action);

    const sessionRowsOf = (userId: string) =>
      ownerDb.selectFrom("sessions").selectAll().where("user_id", "=", userId).orderBy("id").execute();

    /** Asserts a refusal's status, code and message. */
    const expectRefusal = (response: LightMyRequestResponse, statusCode: number, code: string, message?: string) => {
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: message === undefined ? expect.objectContaining({ code }) : { code, message },
      });
    };

    /** An admin active in a group organization, and another member of it, signed in and active there too. */
    const adminAndMember = async (role: OrganizationRole = "contributor") => {
      const admin = await memberActiveInGroup("admin");
      const member = await memberActiveInGroup(role, admin.group.id);
      return { admin, member, group: admin.group };
    };

    /** A member of `organizationId` who has been removed from it. */
    const removedMember = async (organizationId: string, role: OrganizationRole = "contributor") => {
      const account = await verifiedUser();
      await addMembership(ownerDb, { userId: account.user.id, organizationId, role });
      await removeMembership(ownerDb, { userId: account.user.id, organizationId });
      return account;
    };

    /**
     * Resolves once `count` backends other than this test's own are waiting
     * on a lock (D2a Ruling 6), or once `isSettled()` holds: the requests
     * have reached the locks a held transaction blocks, or didn't block at
     * all (which the test's assertions then catch). Throws after five
     * seconds.
     */
    const waitForLockWaits = async (count: number, isSettled: () => boolean = () => false): Promise<void> => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (isSettled()) return;
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::int as waiting
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
        `.execute(ownerDb);
        if ((rows[0]?.waiting ?? 0) >= count) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} backends to wait on a lock`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    /** Starts a request, and tracks whether it has finished. */
    const started = (request: Promise<LightMyRequestResponse>) => {
      const tracked = { isSettled: false, response: request };
      request.then(
        () => {
          tracked.isSettled = true;
        },
        () => {
          tracked.isSettled = true;
        },
      );
      return tracked;
    };

    /** Runs `work` while a separate connection holds a transaction open; always ends it. */
    const withLocker = async (work: (locker: PoolClient, release: () => Promise<void>) => Promise<void>) => {
      const locker = await pool.connect();
      let isInTransaction = false;
      try {
        await locker.query("begin");
        isInTransaction = true;
        await work(locker, async () => {
          await locker.query("rollback");
          isInTransaction = false;
        });
      } finally {
        if (isInTransaction) await locker.query("rollback");
        locker.release();
      }
    };

    describe("GET /api/v1/organizations/:organizationId/members", () => {
      it("lists active and removed members with live accounts, newest first, for an admin", async () => {
        const { admin, member, group } = await adminAndMember("contributor");
        const removed = await removedMember(group.id, "contributor");
        const deletedAccount = await verifiedUser();
        await addMembership(ownerDb, { userId: deletedAccount.user.id, organizationId: group.id });
        await ownerDb
          .updateTable("users")
          .set({ deleted_at: new Date() })
          .where("id", "=", deletedAccount.user.id)
          .execute();

        const response = await listMembers(admin.access, group.id);

        expect(response.statusCode).toBe(200);
        const rows = await Promise.all(
          [removed, member.account, admin.account].map((account) => membershipRow(group.id, account.user.id)),
        );
        expect(response.json()).toEqual({
          items: [
            {
              userId: removed.user.id,
              email: removed.user.email,
              role: "contributor",
              isOrganizationOwner: false,
              createdAt: rows[0]!.created_at.toISOString(),
              deletedAt: rows[0]!.deleted_at!.toISOString(),
            },
            {
              userId: member.account.user.id,
              email: member.account.user.email,
              role: "contributor",
              isOrganizationOwner: false,
              createdAt: rows[1]!.created_at.toISOString(),
              deletedAt: null,
            },
            {
              userId: admin.account.user.id,
              email: admin.account.user.email,
              role: "admin",
              isOrganizationOwner: false,
              createdAt: rows[2]!.created_at.toISOString(),
              deletedAt: null,
            },
          ],
        });
      });

      it("marks the personal organization's owner (Preflight ruling 11)", async () => {
        const owner = await verifiedUser();
        const admin = await memberActiveInGroup("admin", owner.organization.id);

        const response = await listMembers(admin.access, owner.organization.id);

        expect(response.statusCode).toBe(200);
        const items = response.json<{ items: { userId: string; isOrganizationOwner: boolean }[] }>().items;
        expect(items.map(({ userId, isOrganizationOwner }) => ({ userId, isOrganizationOwner }))).toEqual([
          { userId: admin.account.user.id, isOrganizationOwner: false },
          { userId: owner.user.id, isOrganizationOwner: true },
        ]);
      });
    });

    describe("who may", () => {
      it.each(endpoints)(
        "refuses a contributor's %s with 403 organization_admin_required, changing nothing",
        async (_name, request) => {
          const { member, group } = await adminAndMember();
          const removed = await removedMember(group.id);
          const caller = await memberActiveInGroup("contributor", group.id);
          const before = await snapshot(group.id);

          for (const target of [member.account, removed]) {
            const response = await request(caller.access, group.id, target.user.id);
            expectRefusal(response, 403, "organization_admin_required", "Only an admin of this organization can do that");
          }
          expect(await snapshot(group.id)).toEqual(before);
          expect(await memberAudits()).toEqual([]);
        },
      );

      it.each(endpoints)("answers %s by a non-member with 404 organization_not_found", async (_name, request) => {
        const { member, group } = await adminAndMember();
        const stranger = await verifiedUser();
        const { access } = await signedIn(stranger.user.email);
        const before = await snapshot(group.id);

        const response = await request(access, group.id, member.account.user.id);

        expectRefusal(response, 404, "organization_not_found", "Organization not found");
        expect(await snapshot(group.id)).toEqual(before);
      });

      it.each(endpoints)("answers %s naming another organization with 404, even for its admin", async (_, request) => {
        // An admin of both, acting in their personal organization: signed in before joining (D36-1 decision 56).
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);
        const { organization: other } = await addMembership(ownerDb, { userId: account.user.id, role: "admin" });
        const member = await verifiedUser();
        await addMembership(ownerDb, { userId: member.user.id, organizationId: other.id });
        const before = await snapshot(other.id);

        const response = await request(access, other.id, member.user.id);

        expectRefusal(response, 404, "organization_not_found", "Organization not found");
        expect(await snapshot(other.id)).toEqual(before);
      });
    });

    describe("decision 8's refusals", () => {
      it("refuses changing your own role with 409 cannot_change_own_membership", async () => {
        const { admin, group } = await adminAndMember();
        const before = await snapshot(group.id);

        for (const userId of [admin.account.user.id, admin.account.user.id.toUpperCase()]) {
          const response = await changeRole(admin.access, group.id, userId, "contributor");
          expectRefusal(response, 409, "cannot_change_own_membership", "You cannot change your own role");
        }
        expect(await snapshot(group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });

      it("refuses removing yourself with 409 cannot_change_own_membership", async () => {
        const { admin, group } = await adminAndMember();
        const before = await snapshot(group.id);

        for (const userId of [admin.account.user.id, admin.account.user.id.toUpperCase()]) {
          const response = await removeMember(admin.access, group.id, userId);
          const message = "You cannot remove yourself from the organization";
          expectRefusal(response, 409, "cannot_change_own_membership", message);
        }
        expect(await snapshot(group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });

      it.each(changes)(
        "answers %s of no such member, or of one whose account is deleted, with 404 member_not_found",
        async (_name, request) => {
          const { admin, group } = await adminAndMember();
          const elsewhere = await verifiedUser();
          const deletedAccount = await removedMember(group.id);
          await ownerDb
            .updateTable("users")
            .set({ deleted_at: new Date() })
            .where("id", "=", deletedAccount.user.id)
            .execute();
          const deletedActive = await verifiedUser();
          await addMembership(ownerDb, { userId: deletedActive.user.id, organizationId: group.id });
          await ownerDb
            .updateTable("users")
            .set({ deleted_at: new Date() })
            .where("id", "=", deletedActive.user.id)
            .execute();
          const before = await snapshot(group.id);

          for (const userId of [
            "0190a5b0-0000-7000-8000-00000000abcd",
            elsewhere.user.id,
            deletedAccount.user.id,
            deletedActive.user.id,
            "not-a-member",
            elsewhere.user.id.replaceAll("-", ""),
          ]) {
            expectRefusal(await request(admin.access, group.id, userId), 404, "member_not_found", "Member not found");
          }
          expect(await snapshot(group.id)).toEqual(before);
          expect(await memberAudits()).toEqual([]);
        },
      );

      it("refuses changing a removed member's role with 409 member_not_active", async () => {
        const { admin, group } = await adminAndMember();
        const removed = await removedMember(group.id);
        const before = await snapshot(group.id);

        const response = await changeRole(admin.access, group.id, removed.user.id, "admin");

        expectRefusal(response, 409, "member_not_active", "Only active members can have their role changed");
        expect(await snapshot(group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });

      it("refuses removing a removed member with 409 member_not_active", async () => {
        const { admin, group } = await adminAndMember();
        const removed = await removedMember(group.id);
        const before = await snapshot(group.id);

        const response = await removeMember(admin.access, group.id, removed.user.id);

        expectRefusal(response, 409, "member_not_active", "Only active members can be removed");
        expect(await snapshot(group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });

      it("refuses restoring an active member with 409 member_not_removed", async () => {
        const { admin, member, group } = await adminAndMember();
        const before = await snapshot(group.id);

        for (const userId of [member.account.user.id, admin.account.user.id]) {
          const response = await restoreMember(admin.access, group.id, userId);
          expectRefusal(response, 409, "member_not_removed", "Only deleted members can be restored");
        }
        expect(await snapshot(group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });

      it.each([
        [
          "changing the role of",
          ((access, organizationId, userId) =>
            changeRole(access, organizationId, userId, "contributor")) satisfies MemberRequest,
        ],
        ["removing", removeMember],
      ] as const)(
        "refuses %s a personal organization's owner with 409 personal_organization_protected",
        async (_name, request) => {
          const owner = await verifiedUser();
          const guest = await memberActiveInGroup("admin", owner.organization.id);
          const before = await snapshot(owner.organization.id);

          const response = await request(guest.access, owner.organization.id, owner.user.id);

          expectRefusal(
            response,
            409,
            "personal_organization_protected",
            "The owner of a personal organization can't be removed or have their role changed",
          );
          expect(await snapshot(owner.organization.id)).toEqual(before);
          expect(await memberAudits()).toEqual([]);
        },
      );

      it("answers setting the role a member already has with 204, changing and auditing nothing", async () => {
        const { admin, member, group } = await adminAndMember("contributor");
        const before = await snapshot(group.id);

        const response = await changeRole(admin.access, group.id, member.account.user.id, "contributor");

        expect(response.statusCode).toBe(204);
        expect(await snapshot(group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });

      it("refuses an unknown role with 400", async () => {
        const { admin, member, group } = await adminAndMember();
        const response = await changeRole(admin.access, group.id, member.account.user.id, "owner");
        expect(response.statusCode).toBe(400);
        expect((await membershipRow(group.id, member.account.user.id)).role).toBe("contributor");
      });

      it("refuses viewer, which is retired, with 400 invalid_request, changing and auditing nothing (D7 decision 2)", async () => {
        const { admin, member, group } = await adminAndMember();
        const before = await snapshot(group.id);

        const response = await changeRole(admin.access, group.id, member.account.user.id, "viewer");

        expectRefusal(response, 400, "invalid_request");
        expect(await snapshot(group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });
    });

    describe("PATCH /api/v1/organizations/:organizationId/members/:userId", () => {
      it.each([
        ["contributor", "admin"],
        ["admin", "contributor"],
      ] as const)("changes a %s's role to %s and audits it", async (from, role) => {
        const { admin, member, group } = await adminAndMember(from);

        const response = await changeRole(admin.access, group.id, member.account.user.id, role);

        expect(response.statusCode).toBe(204);
        expect(response.body).toBe("");
        expect((await membershipRow(group.id, member.account.user.id)).role).toBe(role);
        expect(await auditRows("organization_member.role_changed")).toEqual([
          expect.objectContaining({
            actor_user_id: admin.account.user.id,
            actor_email: admin.account.user.email,
            organization_id: group.id,
            subject_type: "user",
            subject_id: member.account.user.id,
            metadata: from === "admin" ? { from, to: role, revokedInvitations: 0 } : { from, to: role },
          }),
        ]);
        // The member's next request acts in their new role.
        expect((await me(member.access)).json()).toMatchObject({ organization: { id: group.id, role } });
      });
    });

    describe("DELETE /api/v1/organizations/:organizationId/members/:userId", () => {
      it("removes the member softly and audits the sessions it reassigned", async () => {
        const { admin, member, group } = await adminAndMember();
        // A second session of theirs, active in the group too.
        const second = await signedIn(member.account.user.email);
        await switchTo(second.access, group.id);
        // And a third, in their personal organization (a new sign-in starts where they last were, D36-1 decision 56).
        await switchTo((await signedIn(member.account.user.email)).access, member.personal.id);

        const response = await removeMember(admin.access, group.id, member.account.user.id);

        expect(response.statusCode).toBe(204);
        expect(response.body).toBe("");
        const row = await membershipRow(group.id, member.account.user.id);
        expect(row.deleted_at).not.toBeNull();
        expect(row.role).toBe("contributor");
        expect(await auditRows("organization_member.removed")).toEqual([
          expect.objectContaining({
            actor_user_id: admin.account.user.id,
            actor_email: admin.account.user.email,
            organization_id: group.id,
            subject_type: "user",
            subject_id: member.account.user.id,
            metadata: { reassignedSessions: 2 },
          }),
        ]);
        const sessions = await sessionRowsOf(member.account.user.id);
        expect(sessions).toHaveLength(3);
        for (const session of sessions) {
          expect(session).toMatchObject({ active_organization_id: member.personal.id, revoked_at: null });
        }
        // The admin's own session is untouched.
        expect((await me(admin.access)).json()).toMatchObject({ organization: { id: group.id } });
      });

      it("keeps the removed member signed in: their token refreshes into their personal organization", async () => {
        const { admin, member, group } = await adminAndMember();

        expect((await removeMember(admin.access, group.id, member.account.user.id)).statusCode).toBe(204);

        const stale = await me(member.access);
        expect(stale.statusCode).toBe(401);
        expect(stale.json()).toMatchObject({ error: { code: "access_token_expired" } });
        const refreshed = await refresh(member.refresh);
        expect(refreshed.statusCode).toBe(200);
        const after = await me(cookieValue(refreshed, "telflo_access"));
        expect(after.statusCode).toBe(200);
        expect(after.json()).toMatchObject({
          user: { id: member.account.user.id },
          organization: { id: member.personal.id, type: "personal" },
          organizations: [{ id: member.personal.id }],
        });
        expect(after.json<{ organizations: unknown[] }>().organizations).toHaveLength(1);
      });

      it("leaves the removed member unable to switch back in (403)", async () => {
        const { admin, member, group } = await adminAndMember();
        expect((await removeMember(admin.access, group.id, member.account.user.id)).statusCode).toBe(204);
        const access = cookieValue(await refresh(member.refresh), "telflo_access");

        const response = await switchResponse(access, group.id);

        expectRefusal(response, 403, "organization_access_denied", "You are not an active member of this organization");
        expect((await sessionRowsOf(member.account.user.id))[0]).toMatchObject({
          active_organization_id: member.personal.id,
        });
      });
    });

    describe("PUT /api/v1/organizations/:organizationId/members/:userId/restoration", () => {
      it("restores a removed member with their role, audits it, and lets them switch back in", async () => {
        const { admin, member, group } = await adminAndMember("contributor");
        expect((await removeMember(admin.access, group.id, member.account.user.id)).statusCode).toBe(204);

        const response = await restoreMember(admin.access, group.id, member.account.user.id);

        expect(response.statusCode).toBe(204);
        expect(response.body).toBe("");
        const row = await membershipRow(group.id, member.account.user.id);
        expect(row).toMatchObject({ deleted_at: null, role: "contributor" });
        expect(await auditRows("organization_member.restored")).toEqual([
          expect.objectContaining({
            actor_user_id: admin.account.user.id,
            actor_email: admin.account.user.email,
            organization_id: group.id,
            subject_type: "user",
            subject_id: member.account.user.id,
            metadata: {},
          }),
        ]);
        const access = cookieValue(await refresh(member.refresh), "telflo_access");
        const switched = await switchResponse(access, group.id);
        expect(switched.statusCode).toBe(200);
        expect(switched.json()).toMatchObject({ organization: { id: group.id, role: "contributor" } });
      });
    });

    describe("service accounts (D22 decisions 6 and 30)", () => {
      /**
       * A service account of `organizationId` in the real shape (D22
       * decision 27), written by the owner at the clock's time: the API
       * deletes with the clock, and not before the creation.
       */
      const serviceAccountIn = async (organizationId: string) =>
        (await addServiceAccount(ownerDb, { organizationId, createdAt: clock })).user;

      it("the members list and the page's counts leave out service accounts", async () => {
        const { admin, member, group } = await adminAndMember("contributor");
        const removed = await removedMember(group.id);
        await serviceAccountIn(group.id);
        await serviceAccountIn(group.id);

        const response = await listMembers(admin.access, group.id);

        expect(response.statusCode).toBe(200);
        const items = response.json<{ items: { userId: string; deletedAt: string | null }[] }>().items;
        // The rows, and so the page's Active, Deleted and Invited counts (routes/org-admin.tsx).
        expect(items.map((item) => item.userId).sort()).toEqual(
          [admin.account.user.id, member.account.user.id, removed.user.id].sort(),
        );
        expect(items.filter((item) => item.deletedAt === null)).toHaveLength(2);
      });

      it("a role change, a removal and a restoration naming a service account are 409 member_is_service_account and change nothing", async () => {
        const admin = await memberActiveInGroup("admin");
        const serviceAccount = await serviceAccountIn(admin.group.id);
        const before = await snapshot(admin.group.id);
        const userBefore = await ownerDb
          .selectFrom("users")
          .selectAll()
          .where("id", "=", serviceAccount.id)
          .executeTakeFirstOrThrow();

        for (const [, request] of changes) {
          for (const userId of [serviceAccount.id, serviceAccount.id.toUpperCase()]) {
            const response = await request(admin.access, admin.group.id, userId);
            expectRefusal(
              response,
              409,
              "member_is_service_account",
              "Service accounts are managed in Settings › Service Accounts.",
            );
          }
        }
        // A role change to the role it already has is refused the same way, before the no-op.
        expectRefusal(
          await changeRole(admin.access, admin.group.id, serviceAccount.id, "contributor"),
          409,
          "member_is_service_account",
        );
        expect(await snapshot(admin.group.id)).toEqual(before);
        expect(
          await ownerDb.selectFrom("users").selectAll().where("id", "=", serviceAccount.id).executeTakeFirstOrThrow(),
        ).toEqual(userBefore);
        expect(await memberAudits()).toEqual([]);
        expect(loggedDatabaseErrorCodes()).toEqual([]);
      });

      it("a deleted service account is 404 member_not_found", async () => {
        const admin = await memberActiveInGroup("admin");
        const serviceAccount = await serviceAccountIn(admin.group.id);
        const deleted = await server.inject({
          method: "DELETE",
          url: `/api/v1/organizations/${admin.group.id}/service-accounts/${serviceAccount.id}`,
          headers: csrfHeaders,
          cookies: { telflo_access: admin.access },
        });
        expect(deleted.statusCode).toBe(204);
        const before = await snapshot(admin.group.id);

        for (const [, request] of changes) {
          const response = await request(admin.access, admin.group.id, serviceAccount.id);
          expectRefusal(response, 404, "member_not_found", "Member not found");
        }
        expect(await snapshot(admin.group.id)).toEqual(before);
        expect(await memberAudits()).toEqual([]);
      });
    });

    describe("under concurrency (decision 8's lock)", () => {
      it("a restore of a member a product admin's delete takes while it waits: the account's row locked after the organization, 404 member_not_found, the membership still removed (D29 Ruling 272)", async () => {
        const { admin, member, group } = await adminAndMember("contributor");
        expect((await removeMember(admin.access, group.id, member.account.user.id)).statusCode).toBe(204);

        await withLocker(async (locker) => {
          // The delete's lock on the person (migration 1700000000042: their organizations, then their row for update) and its write.
          await locker.query("select id from users where id = $1 for update", [member.account.user.id]);
          await locker.query("update users set deleted_at = now(), updated_at = now() where id = $1", [member.account.user.id]);
          const restoring = started(restoreMember(admin.access, group.id, member.account.user.id));
          await waitForLockWaits(1, () => restoring.isSettled);
          expect(restoring.isSettled).toBe(false);
          await locker.query("commit");
          const response = await restoring.response;
          expect({ status: response.statusCode, code: response.json().error.code }).toEqual({ status: 404, code: "member_not_found" });
        });
        const row = await membershipRow(group.id, member.account.user.id);
        expect(row?.deleted_at).not.toBeNull();
        expect(await auditRows("organization_member.restored")).toEqual([]);
      });

      it("two admins demoting each other at once: exactly one stays an admin, and the other gets 403", async () => {
        // A separate connection holds both memberships, so each request is
        // held at its update: A's while it holds the organization lock, and
        // B's, started meanwhile, waiting on that lock. Without the lock,
        // both would pass the re-check and wait on the memberships, and both
        // demotions would commit, leaving no admin.
        const a = await memberActiveInGroup("admin");
        const b = await memberActiveInGroup("admin", a.group.id);
        const group = a.group;

        await withLocker(async (locker, release) => {
          await locker.query("select id from organization_members where organization_id = $1 for update", [group.id]);

          const aDemotesB = started(changeRole(a.access, group.id, b.account.user.id, "contributor"));
          await waitForLockWaits(1, () => aDemotesB.isSettled);
          const bDemotesA = started(changeRole(b.access, group.id, a.account.user.id, "contributor"));
          await waitForLockWaits(2, () => bDemotesA.isSettled);

          await release();

          const responses = [await aDemotesB.response, await bDemotesA.response];
          expect(responses.map((response) => response.statusCode)).toEqual([204, 403]);
          expect(responses[1]!.json()).toMatchObject({ error: { code: "organization_admin_required" } });
        });

        const admins = await ownerDb
          .selectFrom("organization_members")
          .select("user_id")
          .where("organization_id", "=", group.id)
          .where("role", "=", "admin")
          .where("deleted_at", "is", null)
          .execute();
        expect(admins).toEqual([{ user_id: a.account.user.id }]);
        expect(await auditRows("organization_member.role_changed")).toEqual([
          expect.objectContaining({ actor_user_id: a.account.user.id, subject_id: b.account.user.id }),
        ]);
      });

      it.each(changes)(
        "refuses %s by an admin demoted while it waited on the organization lock, changing nothing",
        async (name, request) => {
          // A separate connection holds the organization `for no key update`, as a
          // concurrent role change does, and demotes the admin. The request
          // read the role as admin before it reached the lock; the re-check
          // under the lock must see the demotion once it commits.
          const { admin, group } = await adminAndMember();
          const target =
            name === "a restore"
              ? await removedMember(group.id)
              : (await memberActiveInGroup("contributor", group.id)).account;
          const before = await snapshot(group.id);

          await withLocker(async (locker) => {
            await locker.query("select id from organizations where id = $1 for no key update", [group.id]);
            await locker.query(
              "update organization_members set role = 'contributor' where organization_id = $1 and user_id = $2",
              [group.id, admin.account.user.id],
            );

            const changing = started(request(admin.access, group.id, target.user.id));
            await waitForLockWaits(1, () => changing.isSettled);
            await locker.query("commit");

            expectRefusal(await changing.response, 403, "organization_admin_required");
          });

          const after = await snapshot(group.id);
          expect(after.sessions).toEqual(before.sessions);
          expect(after.memberships.find((row) => row.user_id === target.user.id)).toEqual(
            before.memberships.find((row) => row.user_id === target.user.id),
          );
          expect(await memberAudits()).toEqual([]);
        },
      );

      it("removing a member as they switch to the organization they're in doesn't deadlock (Ruling 16)", async () => {
        // A separate connection holds the member's membership, so the
        // removal holds the organization lock while it waits on it. The
        // member's switch to the organization their session is already in
        // must not wait on the organization while it holds the session: the
        // removal, reaching the session to reassign it, would close the
        // cycle (40P01). The no-op takes no lock (Ruling 22), so it answers
        // 200 before the removal, which then reassigns the session.
        const { admin, member, group } = await adminAndMember();

        await withLocker(async (locker, release) => {
          await locker.query(
            "select id from organization_members where organization_id = $1 and user_id = $2 for update",
            [group.id, member.account.user.id],
          );

          const removal = started(removeMember(admin.access, group.id, member.account.user.id));
          await waitForLockWaits(1, () => removal.isSettled);
          const switching = started(switchResponse(member.access, group.id));
          await waitForLockWaits(2, () => switching.isSettled);

          await release();

          const switched = await switching.response;
          expect(switched.statusCode).toBe(200);
          expect(switched.json()).toEqual({
            organization: { id: group.id, name: group.name, type: "group", logoId: null, role: "contributor" },
          });
          expect((await removal.response).statusCode).toBe(204);
        });

        expect((await sessionRowsOf(member.account.user.id))[0]).toMatchObject({
          active_organization_id: member.personal.id,
          revoked_at: null,
        });
        expect(await auditRows("organization_member.removed")).toEqual([
          expect.objectContaining({ metadata: { reassignedSessions: 1 } }),
        ]);
      });

      it("a switch to the organization already active, while a removal waits on the session, answers at once", async () => {
        // A separate connection holds the member's session, so the removal,
        // holding the organization and the membership, waits on it to
        // reassign it. The switch, whose session still acts in the
        // organization, is a no-op: it takes no lock (Ruling 22), so it
        // doesn't queue behind the removal, and answers from what is
        // committed, before the removal. The removal then reassigns the
        // session, and the member's next request refreshes out.
        const { admin, member, group } = await adminAndMember();
        const [session] = await sessionRowsOf(member.account.user.id);
        // The setup's switches (no-ops when the sign-in landed in the group, D36-1 decision 56) audited what they did.
        const switchesBefore = (await auditRows("session.organization_switched")).length;

        await withLocker(async (locker, release) => {
          await locker.query("select id from sessions where id = $1 for update", [session!.id]);

          const removal = started(removeMember(admin.access, group.id, member.account.user.id));
          await waitForLockWaits(1, () => removal.isSettled);
          const switched = await switchResponse(member.access, group.id);
          expect(switched.statusCode).toBe(200);
          expect(switched.json()).toMatchObject({ organization: { id: group.id } });
          expect(removal.isSettled).toBe(false);

          await release();

          expect((await removal.response).statusCode).toBe(204);
        });

        expect((await sessionRowsOf(member.account.user.id))[0]).toMatchObject({
          active_organization_id: member.personal.id,
        });
        // The no-op switch audited nothing.
        expect(await auditRows("session.organization_switched")).toHaveLength(switchesBefore);
      });

      /** A live session of `userId` acting in `organizationId`, written directly. */
      const sessionIn = async (userId: string, organizationId: string) =>
        (
          await ownerDb
            .insertInto("sessions")
            .values({ user_id: userId, active_organization_id: organizationId })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;

      const sessionRow = (id: string) =>
        ownerDb.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

      /** The ids of `userId`'s live sessions acting in `organizationId`, oldest first. */
      const sessionsActingIn = async (userId: string, organizationId: string) =>
        (
          await ownerDb
            .selectFrom("sessions")
            .select("id")
            .where("user_id", "=", userId)
            .where("active_organization_id", "=", organizationId)
            .where("revoked_at", "is", null)
            .orderBy("id")
            .execute()
        ).map((row) => row.id);

      /**
       * A person whose only memberships are in these organizations, with no
       * personal organization: a shape the owner writes and no API path
       * creates, which the locks must still handle. Not a service account:
       * the database refuses one a session (D22 decision 18, Preflight
       * ruling 8), and the member routes refuse to change one (409). Such an
       * account can't sign in, so its sessions are written directly
       * (sessionIn).
       */
      const accountInGroupsOnly = (organizationIds: string[]) =>
        ownerDb.transaction().execute(async (transaction) => {
          const user = await transaction
            .insertInto("users")
            .values({ email: `service-${randomUUID()}@example.com` })
            .returningAll()
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("organization_members")
            .values(
              organizationIds.map((organizationId) => ({
                organization_id: organizationId,
                user_id: user.id,
                role: "contributor" as const,
              })),
            )
            .execute();
          return user;
        });

      it("two owners removing each other from their personal organizations at once both succeed (no deadlock)", async () => {
        // Each is a member of the other's personal organization, with a
        // session acting there. Each removal moves the removed member's
        // session back into their own personal organization, which the other
        // removal holds locked, and the move's foreign-key check takes `key
        // share` on it. A separate connection
        // holds both sessions, so both removals hold their organization's
        // lock before either moves a session. Were the organization lock
        // `for update`, each move would wait on the other's lock (40P01);
        // `for no key update` lets the key share through.
        const u = await verifiedUser();
        const v = await verifiedUser();
        // Signed in at home before joining: a sign-in starts in the organization joined most recently (D36-1 decision 56).
        const uAtHome = (await signedIn(u.user.email)).access;
        const vAtHome = (await signedIn(v.user.email)).access;
        await addMembership(ownerDb, { userId: v.user.id, organizationId: u.organization.id, role: "contributor" });
        await addMembership(ownerDb, { userId: u.user.id, organizationId: v.organization.id, role: "contributor" });
        await switchTo((await signedIn(u.user.email)).access, v.organization.id);
        await switchTo((await signedIn(v.user.email)).access, u.organization.id);
        const [uAway] = await sessionsActingIn(u.user.id, v.organization.id);
        const [vAway] = await sessionsActingIn(v.user.id, u.organization.id);

        await withLocker(async (locker, release) => {
          await locker.query("select id from sessions where id = any($1::uuid[]) for update", [[uAway, vAway]]);

          const uRemovesV = started(removeMember(uAtHome, u.organization.id, v.user.id));
          await waitForLockWaits(1, () => uRemovesV.isSettled);
          const vRemovesU = started(removeMember(vAtHome, v.organization.id, u.user.id));
          await waitForLockWaits(2, () => vRemovesU.isSettled);

          await release();

          expect({
            statuses: [(await uRemovesV.response).statusCode, (await vRemovesU.response).statusCode],
            databaseErrors: loggedDatabaseErrorCodes(),
          }).toEqual({ statuses: [204, 204], databaseErrors: [] });
        });

        expect(await sessionRow(uAway!)).toMatchObject({ active_organization_id: u.organization.id, revoked_at: null });
        expect(await sessionRow(vAway!)).toMatchObject({ active_organization_id: v.organization.id, revoked_at: null });
      });

      it("two removals reassigning sessions into each other's organization both succeed (no deadlock)", async () => {
        // Two people without a personal organization (accountInGroupsOnly),
        // each a member of groups A and B: one acting in A, the other in B. Removing the first
        // from A moves its session into B, and removing the second from B
        // moves its session into A, each while the other removal holds that
        // organization's lock. As above, a separate connection holds both
        // sessions until both removals hold their organization's lock.
        const adminOfA = await memberActiveInGroup("admin");
        const adminOfB = await memberActiveInGroup("admin");
        const a = adminOfA.group;
        const b = adminOfB.group;
        const x = await accountInGroupsOnly([a.id, b.id]);
        const y = await accountInGroupsOnly([a.id, b.id]);
        const xInA = await sessionIn(x.id, a.id);
        const yInB = await sessionIn(y.id, b.id);

        await withLocker(async (locker, release) => {
          await locker.query("select id from sessions where id = any($1::uuid[]) for update", [[xInA, yInB]]);

          const xLeavesA = started(removeMember(adminOfA.access, a.id, x.id));
          await waitForLockWaits(1, () => xLeavesA.isSettled);
          const yLeavesB = started(removeMember(adminOfB.access, b.id, y.id));
          await waitForLockWaits(2, () => yLeavesB.isSettled);

          await release();

          expect({
            statuses: [(await xLeavesA.response).statusCode, (await yLeavesB.response).statusCode],
            databaseErrors: loggedDatabaseErrorCodes(),
          }).toEqual({ statuses: [204, 204], databaseErrors: [] });
        });

        expect(await sessionRow(xInA)).toMatchObject({ active_organization_id: b.id, revoked_at: null });
        expect(await sessionRow(yInB)).toMatchObject({ active_organization_id: a.id, revoked_at: null });
      });

      /** A password reset token for `userId`, written directly; returns the plaintext. */
      const resetTokenFor = async (userId: string) => {
        const token = `reset-${randomUUID()}`;
        await ownerDb
          .insertInto("password_reset_tokens")
          .values({ user_id: userId, token_hash: hashToken(token), expires_at: new Date(clock.getTime() + 3_600_000) })
          .execute();
        return token;
      };

      const completeReset = (token: string) =>
        server.inject({
          method: "POST",
          url: "/api/v1/auth/password-resets",
          headers: csrfHeaders,
          payload: { token, password: "another-sufficiently-long-password" },
        });

      const deleteOrganization: MemberRequest = (access, organizationId) => remove(access, organizationId);

      it.each([
        ["a removal of them", removeMember],
        ["a deletion of the organization", deleteOrganization],
      ] as const)(
        "a member's password reset, racing %s, doesn't deadlock",
        async (_name, change) => {
          // A reset locks the user, then revokes their sessions. The change
          // reassigns the member's sessions acting in the organization, and
          // the membership invariant locks the member at commit. Were the
          // change to take the member's lock only then, holding a session the
          // reset waits on, the two would deadlock (40P01). It locks the
          // member's account before any session. The member has two sessions
          // acting in the organization; a separate connection holds the
          // second, so the change holds the first (in id order) while the
          // reset starts.
          const { admin, member, group } = await adminAndMember();
          await switchTo((await signedIn(member.account.user.email)).access, group.id);
          const [, second] = await sessionsActingIn(member.account.user.id, group.id);
          const token = await resetTokenFor(member.account.user.id);

          await withLocker(async (locker, release) => {
            await locker.query("select id from sessions where id = $1 for update", [second]);

            const changing = started(change(admin.access, group.id, member.account.user.id));
            await waitForLockWaits(1, () => changing.isSettled);
            const resetting = started(completeReset(token));
            await waitForLockWaits(2, () => resetting.isSettled);

            await release();

            expect({
              statuses: [(await changing.response).statusCode, (await resetting.response).statusCode],
              databaseErrors: loggedDatabaseErrorCodes(),
            }).toEqual({ statuses: [204, 204], databaseErrors: [] });
          });

          expect(await sessionRowsOf(member.account.user.id)).toEqual([
            expect.objectContaining({ revoked_reason: "password_reset" }),
            expect.objectContaining({ revoked_reason: "password_reset" }),
          ]);
        },
      );

      it.each([
        { change: "a removal of them from it", isMember: true, switchStatus: 401 },
        { change: "a deletion of it", isMember: true, switchStatus: 403 },
        { change: "a restore of them in it", isMember: false, switchStatus: 401 },
      ] as const)(
        "a member's password reset, their switch into an organization, and $change don't deadlock (Ruling 22)",
        async ({ change, isMember, switchStatus }) => {
          // Three transactions, one member. The reset locks the member and
          // then revokes their sessions. The change locks the organization
          // and then the member (a removal or deletion early, a restore at
          // commit). A switch that locked its session and then waited on the
          // organization would close the cycle: reset -> session -> switch
          // -> organization -> change -> member -> reset (40P01). The switch
          // locks the organization first. A separate connection holds the
          // reset's token, so the reset holds the member while the change
          // starts, and the change holds the organization while the switch
          // starts.
          const admin = await memberActiveInGroup("admin");
          const organization = admin.group;
          const account = await verifiedUser();
          // Signed in before joining: the session starts in the personal organization (D36-1 decision 56).
          const { access } = await signedIn(account.user.email);
          await addMembership(ownerDb, { userId: account.user.id, organizationId: organization.id, role: "contributor" });
          if (!isMember) await removeMembership(ownerDb, { userId: account.user.id, organizationId: organization.id });
          const token = await resetTokenFor(account.user.id);
          const changes = {
            "a removal of them from it": () => removeMember(admin.access, organization.id, account.user.id),
            "a deletion of it": () => remove(admin.access, organization.id),
            "a restore of them in it": () => restoreMember(admin.access, organization.id, account.user.id),
          };

          await withLocker(async (locker, release) => {
            await locker.query("select id from password_reset_tokens where token_hash = $1 for update", [
              hashToken(token),
            ]);

            const resetting = started(completeReset(token));
            await waitForLockWaits(1, () => resetting.isSettled);
            const changing = started(changes[change]());
            await waitForLockWaits(2, () => changing.isSettled);
            const switching = started(switchResponse(access, organization.id));
            await waitForLockWaits(3, () => switching.isSettled);

            await release();

            expect({
              statuses: [
                (await resetting.response).statusCode,
                (await changing.response).statusCode,
                (await switching.response).statusCode,
              ],
              databaseErrors: loggedDatabaseErrorCodes(),
            }).toEqual({ statuses: [204, 204, switchStatus], databaseErrors: [] });
          });

          // The reset committed before the switch took the session: it was
          // revoked, and never switched.
          expect(await sessionRowsOf(account.user.id)).toEqual([
            expect.objectContaining({ active_organization_id: account.organization.id, revoked_reason: "password_reset" }),
          ]);
        },
      );
    });
  });

  /*
   * D23-2: organization logos in the API (decisions 1 to 3, 8, 9, 12 to 16
   * and 32 to 40; Preflight rulings 3 to 8). The shared server's store is
   * pointed, for each test here, at a real store on a temporary directory
   * that records every write and removal: a refusal writes nothing, and a
   * failure after the write leaves nothing.
   */
  describe("logos (D23-2)", () => {
    let root: string | undefined;
    let store: IFileStore;
    /** Every key written and removed since the test began, in order. */
    let storeCalls: Array<{ operation: "write" | "remove"; key: FileKey }> = [];
    let isWriteFailing = false;
    /** Awaited before each removal, while set: a test watches what the database holds at that moment. */
    let beforeRemove: ((key: FileKey) => Promise<void>) | undefined;

    const recordingStore: IFileStore = {
      write: async (key, content, options) => {
        storeCalls.push({ operation: "write", key });
        if (isWriteFailing) throw new FileStoreError("ENOSPC", "write");
        return store.write(key, content, options);
      },
      read: (key) => store.read(key),
      copy: () => Promise.reject(new Error("logos never copy")),
      remove: async (key) => {
        storeCalls.push({ operation: "remove", key });
        await beforeRemove?.(key);
        await store.remove(key);
      },
    };

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "telflo-organization-logos-"));
      store = await createFileStore({ kind: "local", root });
      storeCalls = [];
      isWriteFailing = false;
      beforeRemove = undefined;
      currentStore = recordingStore;
    });

    afterEach(async () => {
      currentStore = UNCALLED_FILE_STORE;
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });

    /** Every file the store holds, as paths under its root. */
    const storedFiles = async (): Promise<string[]> => {
      const found: string[] = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else found.push(relative(root!, path));
        }
      };
      await walk(root!);
      return found.sort();
    };

    const writes = () => storeCalls.filter((call) => call.operation === "write");

    // Images by their first bytes (decision 32): only the signature matters to the API.
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
    const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 body")]);
    const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const GIF = Buffer.from("GIF89a-gif-body");

    type Part =
      | { name: string; value: string }
      | { name: string; filename: string; data: Buffer; contentType?: string };

    /** A multipart/form-data body of `parts`, in their order. */
    const multipartBody = (parts: Part[]) => {
      const boundary = `----telflo-${randomUUID()}`;
      const chunks: Buffer[] = [];
      for (const part of parts) {
        if ("value" in part) {
          chunks.push(
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`),
            Buffer.from(part.value, "utf8"),
            Buffer.from("\r\n"),
          );
        } else {
          chunks.push(
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
                `Content-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`,
            ),
            part.data,
            Buffer.from("\r\n"),
          );
        }
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
    };

    /** The two parts in order: the name, then the file. */
    const logoParts = (name: string, data: Buffer, file: { filename?: string; contentType?: string } = {}): Part[] => [
      { name: "name", value: name },
      { name: "file", filename: file.filename ?? "logo.png", data, contentType: file.contentType ?? "image/png" },
    ];

    const send = (method: "POST" | "PATCH", url: string, access: string, parts: Part[], headers = csrfHeaders) => {
      const body = multipartBody(parts);
      return server.inject({
        method,
        url,
        headers: { ...headers, ...body.headers },
        cookies: { telflo_access: access },
        payload: body.payload,
      });
    };

    const createWithLogo = (access: string, parts: Part[]) => send("POST", "/api/v1/organizations", access, parts);
    const changeWithLogo = (access: string, organizationId: string, parts: Part[], headers = csrfHeaders) =>
      send("PATCH", `/api/v1/organizations/${organizationId}`, access, parts, headers);

    const changeJson = (access: string, organizationId: string, payload: Record<string, unknown>) =>
      server.inject({
        method: "PATCH",
        url: `/api/v1/organizations/${organizationId}`,
        headers: csrfHeaders,
        cookies: { telflo_access: access },
        payload,
      });

    const readLogo = (organizationId: string, logoId: string, cookies: Record<string, string> = {}) =>
      server.inject({ method: "GET", url: `/api/v1/organization-logos/${organizationId}/${logoId}`, cookies });

    const organizationsNamed = async (name: string) =>
      ownerDb.selectFrom("organizations").selectAll().where("name", "=", name).execute();

    /** The logo audit rows' actions and metadata keys: ids only (decision 37). */
    const logoAuditRows = async () =>
      (await ownerDb.selectFrom("audit_events").selectAll().where("action", "like", "organization.logo_%").orderBy("id").execute()).map(
        (row) => ({
          action: row.action,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          organizationId: row.organization_id,
          metadataKeys: Object.keys((row.metadata ?? {}) as Record<string, unknown>).sort(),
        }),
      );

    /** A signed-in admin active in a group organization that already has `logo` as its logo. */
    const adminWithLogo = async (logo: Buffer = PNG) => {
      const admin = await memberActiveInGroup("admin");
      const response = await changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, logo));
      expect(response.statusCode).toBe(200);
      const logoId = response.json<{ organization: { logoId: string } }>().organization.logoId;
      storeCalls = [];
      return { ...admin, logoId };
    };

    describe("create (decisions 8, 33 to 35)", () => {
      it.each([
        ["a PNG", PNG, "image/png"],
        ["a JPEG", JPEG, "image/jpeg"],
        ["a WebP", WEBP, "image/webp"],
      ] as const)("creates with %s in one request: the bytes under new ids, the row, the audits, /me", async (_label, data, type) => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);

        const response = await createWithLogo(access, logoParts("  Logo Corp  ", data));

        expect(response.statusCode).toBe(201);
        const { organization } = response.json<{ organization: { id: string; logoId: string } }>();
        expect(organization).toEqual({ id: expect.any(String), name: "Logo Corp", type: "group", logoId: expect.any(String) });
        expect(organization.logoId).not.toBe(organization.id);
        expect(await organizationRow(organization.id)).toMatchObject({ logo_id: organization.logoId, logo_content_type: type });
        expect(storeCalls).toEqual([
          { operation: "write", key: { kind: "organization-logo", organizationId: organization.id, logoId: organization.logoId } },
        ]);
        expect(await storedFiles()).toEqual([`organizations/${organization.id}/logos/${organization.logoId}`]);
        expect(await logoAuditRows()).toEqual([
          {
            action: "organization.logo_changed",
            subjectType: "organization",
            subjectId: organization.id,
            organizationId: organization.id,
            metadataKeys: ["logoId"],
          },
        ]);
        expect((await auditRows("organization.logo_changed"))[0]!.metadata).toEqual({ logoId: organization.logoId });
        expect(await auditActions()).toEqual(
          expect.arrayContaining(["organization.created", "organization_member.added", "organization.logo_changed"]),
        );
        const listed = (await me(access)).json<{ organizations: Array<{ id: string; logoId: string | null }> }>();
        expect(listed.organizations.find((entry) => entry.id === organization.id)?.logoId).toBe(organization.logoId);

        const read = await readLogo(organization.id, organization.logoId);
        expect(read.statusCode).toBe(200);
        expect(read.headers["content-type"]).toBe(type);
        expect(read.rawPayload.equals(data)).toBe(true);
      });

      it("types the logo from its bytes, never its name or its declared type", async () => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);

        const response = await createWithLogo(
          access,
          logoParts("Named SVG", PNG, { filename: "logo.svg", contentType: "image/svg+xml" }),
        );

        expect(response.statusCode).toBe(201);
        const { organization } = response.json<{ organization: { id: string } }>();
        expect((await organizationRow(organization.id)).logo_content_type).toBe("image/png");
      });

      it.each([
        ["SVG bytes named .png and declared image/png", SVG],
        ["a GIF", GIF],
        ["an empty file", Buffer.alloc(0)],
        ["HTML", Buffer.from("<!doctype html><title>x</title>")],
      ])("refuses %s with 415 organization_logo_type_unsupported, writing nothing and creating nothing", async (_label, data) => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);

        const response = await createWithLogo(access, logoParts("Refused Corp", data));

        expect(response.statusCode).toBe(415);
        expect(response.json()).toEqual({
          error: { code: "organization_logo_type_unsupported", message: "The logo must be a PNG, JPEG or WebP image." },
        });
        expect(storeCalls).toEqual([]);
        expect(await organizationsNamed("Refused Corp")).toEqual([]);
        expect(await auditActions()).toEqual(["user.signed_in"]);
      });

      it("refuses 2,097,153 bytes with 413 organization_logo_too_large, writing nothing; 2,097,152 are accepted", async () => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);
        const exactly = Buffer.concat([PNG, Buffer.alloc(ORGANIZATION_LOGO_MAXIMUM_BYTES - PNG.length)]);
        const over = Buffer.concat([exactly, Buffer.from([0])]);

        const refused = await createWithLogo(access, logoParts("Big Corp", over));
        expect(refused.statusCode).toBe(413);
        expect(refused.json()).toEqual({
          error: { code: "organization_logo_too_large", message: "The logo must be 2 MB or smaller." },
        });
        expect(storeCalls).toEqual([]);
        expect(await organizationsNamed("Big Corp")).toEqual([]);

        const accepted = await createWithLogo(access, logoParts("Big Corp", exactly));
        expect(accepted.statusCode).toBe(201);
        const { organization } = accepted.json<{ organization: { id: string; logoId: string } }>();
        const read = await readLogo(organization.id, organization.logoId);
        expect(read.headers["content-length"]).toBe(String(ORGANIZATION_LOGO_MAXIMUM_BYTES));
      });

      it.each([
        ["an empty name", logoParts("   ", PNG)],
        ["a 101-character name", logoParts("a".repeat(101), PNG)],
        ["the file before the name", [logoParts("Order Corp", PNG)[1]!, logoParts("Order Corp", PNG)[0]!]],
        ["a part after the file", [...logoParts("Order Corp", PNG), { name: "extra", value: "x" }]],
        ["a second file", [...logoParts("Order Corp", PNG), { name: "file", filename: "b.png", data: PNG }]],
        ["no file", [{ name: "name", value: "Order Corp" }]],
      ] as Array<[string, Part[]]>)("refuses %s with 400 invalid_request and no details, writing nothing", async (_label, parts) => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);

        const response = await createWithLogo(access, parts);

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { code: "invalid_request", message: "The request was not valid." } });
        expect(writes()).toEqual([]);
        expect(await storedFiles()).toEqual([]);
        expect(await auditActions()).toEqual(["user.signed_in"]);
      });

      it("removes the written bytes after a name clash: 409, no organization, no file left", async () => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);
        await groupNamed("Taken Corp");

        const response = await createWithLogo(access, logoParts("taken corp", PNG));

        expect(response.statusCode).toBe(409);
        expect(response.json<{ error: { code: string } }>().error.code).toBe("organization_name_taken");
        const [write] = writes();
        expect(storeCalls).toEqual([write, { operation: "remove", key: write!.key }]);
        expect(await storedFiles()).toEqual([]);
        expect(await organizationsNamed("taken corp")).toEqual([]);
      });

      it("removes the written bytes when the transaction fails: 500, no organization, no file left", async () => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);

        await withFailingInsert(ownerDb, "organization_members", "raise exception 'membership insert refused'", async () => {
          const response = await createWithLogo(access, logoParts("Doomed Logo", PNG));
          expect(response.statusCode).toBe(500);
        });

        expect(storeCalls.map((call) => call.operation)).toEqual(["write", "remove"]);
        expect(await storedFiles()).toEqual([]);
        expect(await organizationsNamed("Doomed Logo")).toEqual([]);
        expect(await auditActions()).toEqual(["user.signed_in"]);
      });

      it("creates nothing when the store's write fails, and removes what it may have left", async () => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);
        isWriteFailing = true;

        const response = await createWithLogo(access, logoParts("No Disk", PNG));

        expect(response.statusCode).toBe(500);
        expect(storeCalls.map((call) => call.operation)).toEqual(["write", "remove"]);
        expect(await organizationsNamed("No Disk")).toEqual([]);
        expect(await auditActions()).toEqual(["user.signed_in"]);
      });

      it("keeps JSON for a create without a logo, which never calls the store; no body is 400; a body nothing parses is 415", async () => {
        const account = await verifiedUser();
        const { access } = await signedIn(account.user.email);

        const json = await create(access, "Plain Corp");
        expect(json.statusCode).toBe(201);
        expect(json.json<{ organization: { logoId: unknown } }>().organization.logoId).toBeNull();

        const empty = await server.inject({
          method: "POST",
          url: "/api/v1/organizations",
          headers: csrfHeaders,
          cookies: { telflo_access: access },
        });
        expect(empty.statusCode).toBe(400);
        expect(empty.json<{ error: { code: string } }>().error.code).toBe("invalid_request");

        const form = await server.inject({
          method: "POST",
          url: "/api/v1/organizations",
          headers: { ...csrfHeaders, "content-type": "application/x-www-form-urlencoded" },
          cookies: { telflo_access: access },
          payload: "name=Form+Corp",
        });
        expect(form.statusCode).toBe(415);
        expect(storeCalls).toEqual([]);
      });

      it("refuses a multipart create without a session with 401 before reading the body or writing", async () => {
        const body = multipartBody(logoParts("Anonymous", PNG));
        const response = await server.inject({
          method: "POST",
          url: "/api/v1/organizations",
          headers: { ...csrfHeaders, ...body.headers },
          payload: body.payload,
        });
        expect(response.statusCode).toBe(401);
        expect(storeCalls).toEqual([]);
      });
    });

    describe("change (decisions 9, 15, 36 and 37)", () => {
      it("sets a first logo: the new bytes, the row, organization.logo_changed with ids only, and the name kept", async () => {
        const admin = await memberActiveInGroup("admin");

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, JPEG));

        expect(response.statusCode).toBe(200);
        const { organization } = response.json<{ organization: { logoId: string } }>();
        expect(organization).toEqual({ id: admin.group.id, name: admin.group.name, type: "group", logoId: expect.any(String) });
        expect(await organizationRow(admin.group.id)).toMatchObject({
          name: admin.group.name,
          logo_id: organization.logoId,
          logo_content_type: "image/jpeg",
        });
        expect(storeCalls).toEqual([
          { operation: "write", key: { kind: "organization-logo", organizationId: admin.group.id, logoId: organization.logoId } },
        ]);
        expect(await logoAuditRows()).toEqual([
          {
            action: "organization.logo_changed",
            subjectType: "organization",
            subjectId: admin.group.id,
            organizationId: admin.group.id,
            metadataKeys: ["logoId"],
          },
        ]);
        expect(await auditRows("organization.renamed")).toEqual([]);
      });

      it("replaces a logo: the old bytes are removed only after the commit, and the old address answers 404", async () => {
        const admin = await adminWithLogo(PNG);
        const oldKey: FileKey = { kind: "organization-logo", organizationId: admin.group.id, logoId: admin.logoId };
        /** What the row held when the old bytes were removed. */
        const seenAtRemoval: Array<string | null> = [];
        beforeRemove = async () => {
          seenAtRemoval.push((await organizationRow(admin.group.id)).logo_id);
        };

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, WEBP));

        expect(response.statusCode).toBe(200);
        const newLogoId = response.json<{ organization: { logoId: string } }>().organization.logoId;
        expect(newLogoId).not.toBe(admin.logoId);
        expect(storeCalls).toEqual([
          { operation: "write", key: { kind: "organization-logo", organizationId: admin.group.id, logoId: newLogoId } },
          { operation: "remove", key: oldKey },
        ]);
        // Read from outside the transaction: the new logo had committed when the old bytes went.
        expect(seenAtRemoval).toEqual([newLogoId]);
        expect(await storedFiles()).toEqual([`organizations/${admin.group.id}/logos/${newLogoId}`]);
        expect((await readLogo(admin.group.id, admin.logoId)).statusCode).toBe(404);
        const current = await readLogo(admin.group.id, newLogoId);
        expect(current.statusCode).toBe(200);
        expect(current.headers["content-type"]).toBe("image/webp");
      });

      it("renames and replaces in one request, with both audit rows", async () => {
        const admin = await adminWithLogo();

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts("Renamed With Logo", PNG));

        expect(response.statusCode).toBe(200);
        expect(response.json<{ organization: { name: string } }>().organization.name).toBe("Renamed With Logo");
        expect((await auditActions()).filter((action) => action.startsWith("organization."))).toEqual([
          "organization.logo_changed",
          "organization.renamed",
          "organization.logo_changed",
        ]);
      });

      it("removes the logo with JSON removeLogo: the columns cleared, organization.logo_removed {}, the bytes after the commit", async () => {
        const admin = await adminWithLogo();
        const seenAtRemoval: Array<string | null> = [];
        beforeRemove = async () => {
          seenAtRemoval.push((await organizationRow(admin.group.id)).logo_id);
        };

        const response = await changeJson(admin.access, admin.group.id, { name: admin.group.name, removeLogo: true });

        expect(response.statusCode).toBe(200);
        expect(response.json<{ organization: { logoId: unknown } }>().organization.logoId).toBeNull();
        expect(await organizationRow(admin.group.id)).toMatchObject({ logo_id: null, logo_content_type: null });
        expect(storeCalls).toEqual([
          { operation: "remove", key: { kind: "organization-logo", organizationId: admin.group.id, logoId: admin.logoId } },
        ]);
        expect(seenAtRemoval).toEqual([null]);
        expect(await storedFiles()).toEqual([]);
        const removed = await auditRows("organization.logo_removed");
        expect(removed).toHaveLength(1);
        expect(removed[0]!.metadata).toEqual({});
        expect((await readLogo(admin.group.id, admin.logoId)).statusCode).toBe(404);
      });

      it("removing when there is none, and the current name with nothing else, change, audit and store nothing", async () => {
        const admin = await memberActiveInGroup("admin");

        expect((await changeJson(admin.access, admin.group.id, { name: admin.group.name, removeLogo: true })).statusCode).toBe(200);
        expect((await changeJson(admin.access, admin.group.id, { name: admin.group.name })).statusCode).toBe(200);

        expect(storeCalls).toEqual([]);
        expect((await auditActions()).filter((action) => action.startsWith("organization."))).toEqual([]);
      });

      it.each([
        ["SVG bytes named .png", SVG, 415, "organization_logo_type_unsupported"],
        ["an empty file", Buffer.alloc(0), 415, "organization_logo_type_unsupported"],
        ["2,097,153 bytes", Buffer.concat([PNG, Buffer.alloc(ORGANIZATION_LOGO_MAXIMUM_BYTES + 1 - PNG.length)]), 413, "organization_logo_too_large"],
      ] as const)("refuses %s before any write, keeping the name and the old logo", async (_label, data, status, code) => {
        const admin = await adminWithLogo();

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts("Not Renamed", data));

        expect(response.statusCode).toBe(status);
        expect(response.json<{ error: { code: string } }>().error.code).toBe(code);
        expect(storeCalls).toEqual([]);
        expect(await organizationRow(admin.group.id)).toMatchObject({ name: admin.group.name, logo_id: admin.logoId });
        expect((await readLogo(admin.group.id, admin.logoId)).statusCode).toBe(200);
      });

      it("removes the new bytes after a name clash and keeps the old logo and the name", async () => {
        const admin = await adminWithLogo();
        const taken = await groupNamed(`Taken ${randomUUID()}`);

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts(taken.name.toUpperCase(), JPEG));

        expect(response.statusCode).toBe(409);
        const [write] = writes();
        expect(write!.key).not.toEqual({ kind: "organization-logo", organizationId: admin.group.id, logoId: admin.logoId });
        expect(storeCalls).toEqual([write, { operation: "remove", key: write!.key }]);
        expect(await storedFiles()).toEqual([`organizations/${admin.group.id}/logos/${admin.logoId}`]);
        expect(await organizationRow(admin.group.id)).toMatchObject({ name: admin.group.name, logo_id: admin.logoId });
        expect(await auditRows("organization.renamed")).toEqual([]);
      });

      it("removes the new bytes when the transaction fails, and keeps the old logo", async () => {
        const admin = await adminWithLogo();
        const before = await auditActions();

        await withFailingInsert(ownerDb, "audit_events", "raise exception 'audit insert refused'", async () => {
          const response = await changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, JPEG));
          expect(response.statusCode).toBe(500);
        });

        expect(storeCalls.map((call) => call.operation)).toEqual(["write", "remove"]);
        expect(await storedFiles()).toEqual([`organizations/${admin.group.id}/logos/${admin.logoId}`]);
        expect(await organizationRow(admin.group.id)).toMatchObject({ logo_id: admin.logoId, logo_content_type: "image/png" });
        expect(await auditActions()).toEqual(before);
      });

      it("removes nothing of the old logo when the store's write fails", async () => {
        const admin = await adminWithLogo();
        isWriteFailing = true;

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, JPEG));

        expect(response.statusCode).toBe(500);
        expect(storeCalls.map((call) => call.operation)).toEqual(["write", "remove"]);
        expect(storeCalls[1]!.key).toEqual(storeCalls[0]!.key);
        expect(await storedFiles()).toEqual([`organizations/${admin.group.id}/logos/${admin.logoId}`]);
      });

      it("removes the new bytes when the admin is demoted between the write and the lock: 403, the row, the name and the old logo kept", async () => {
        const admin = await adminWithLogo(PNG);
        const before = await auditActions();
        const real = store;
        store = {
          // The demotion commits while the new bytes are written: after the request's role check, before the lock.
          write: async (key, content, options) => {
            await ownerDb
              .updateTable("organization_members")
              .set({ role: "contributor" })
              .where("organization_id", "=", admin.group.id)
              .where("user_id", "=", admin.account.user.id)
              .execute();
            return real.write(key, content, options);
          },
          read: (key) => real.read(key),
          copy: (from, to) => real.copy(from, to),
          remove: (key) => real.remove(key),
        };

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts("Renamed At The Lock", JPEG));

        expect(response.statusCode).toBe(403);
        expect(response.json<{ error: { code: string } }>().error.code).toBe("organization_admin_required");
        const [write] = writes();
        expect(write!.key).not.toEqual({ kind: "organization-logo", organizationId: admin.group.id, logoId: admin.logoId });
        expect(storeCalls).toEqual([write, { operation: "remove", key: write!.key }]);
        expect(await storedFiles()).toEqual([`organizations/${admin.group.id}/logos/${admin.logoId}`]);
        expect(await organizationRow(admin.group.id)).toMatchObject({
          name: admin.group.name,
          logo_id: admin.logoId,
          logo_content_type: "image/png",
        });
        expect(await auditActions()).toEqual(before);
      });

      it("of two Saves at once, keeps exactly the final row's logo and removes the other two (decision 36)", async () => {
        const admin = await adminWithLogo(PNG);
        const real = store;
        // A barrier: neither write goes on until both have started, so both requests read their parts,
        // write and then race for the lock.
        let started = 0;
        let releaseBoth!: () => void;
        const bothStarted = new Promise<void>((resolve) => (releaseBoth = resolve));
        store = {
          write: async (key, content, options) => {
            started += 1;
            if (started === 2) releaseBoth();
            await bothStarted;
            return real.write(key, content, options);
          },
          read: (key) => real.read(key),
          copy: (from, to) => real.copy(from, to),
          remove: (key) => real.remove(key),
        };

        const [first, second] = await Promise.all([
          changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, JPEG)),
          changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, WEBP)),
        ]);

        expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
        const firstId = first.json<{ organization: { logoId: string } }>().organization.logoId;
        const secondId = second.json<{ organization: { logoId: string } }>().organization.logoId;
        const final = (await organizationRow(admin.group.id)).logo_id!;
        expect([firstId, secondId]).toContain(final);
        expect(await storedFiles()).toEqual([`organizations/${admin.group.id}/logos/${final}`]);
        const removed = storeCalls
          .filter((call) => call.operation === "remove")
          .map((call) => (call.key.kind === "organization-logo" ? call.key.logoId : call.key.kind));
        expect(removed.sort()).toEqual([admin.logoId, firstId, secondId].filter((id) => id !== final).sort());
        expect((await auditRows("organization.logo_changed")).map((row) => row.metadata)).toEqual([
          { logoId: admin.logoId },
          { logoId: final === firstId ? secondId : firstId },
          { logoId: final },
        ]);
      });

      it("refuses a contributor with 403 organization_admin_required before reading or writing anything", async () => {
        const contributor = await memberActiveInGroup("contributor");

        const response = await changeWithLogo(contributor.access, contributor.group.id, logoParts(contributor.group.name, PNG));

        expect(response.statusCode).toBe(403);
        expect(response.json<{ error: { code: string } }>().error.code).toBe("organization_admin_required");
        expect(storeCalls).toEqual([]);
        expect((await organizationRow(contributor.group.id)).logo_id).toBeNull();
        const removing = await changeJson(contributor.access, contributor.group.id, { name: contributor.group.name, removeLogo: true });
        expect(removing.statusCode).toBe(403);
      });

      it("answers any organization but the active one with 404 before writing", async () => {
        const admin = await memberActiveInGroup("admin");
        const other = await groupNamed(`Other ${randomUUID()}`);

        const response = await changeWithLogo(admin.access, other.id, logoParts("Hijacked", PNG));

        expect(response.statusCode).toBe(404);
        expect(storeCalls).toEqual([]);
        expect((await organizationRow(other.id)).logo_id).toBeNull();
      });

      it("refuses a multipart PATCH without the CSRF header with 403, before anything is read or written", async () => {
        const admin = await memberActiveInGroup("admin");

        const response = await changeWithLogo(admin.access, admin.group.id, logoParts(admin.group.name, PNG), {} as typeof csrfHeaders);

        expect(response.statusCode).toBe(403);
        expect(storeCalls).toEqual([]);
        expect((await organizationRow(admin.group.id)).logo_id).toBeNull();
      });

      it("refuses removeLogo as anything but true with 400", async () => {
        const admin = await adminWithLogo();
        const response = await changeJson(admin.access, admin.group.id, { name: admin.group.name, removeLogo: false });
        expect(response.statusCode).toBe(400);
        expect((await organizationRow(admin.group.id)).logo_id).toBe(admin.logoId);
        expect(storeCalls).toEqual([]);
      });
    });

    describe("delete (decision 38)", () => {
      it("removes the logo's bytes after the commit; the public read then answers 404", async () => {
        const admin = await adminWithLogo();
        const seenAtRemoval: Array<Date | null> = [];
        beforeRemove = async () => {
          seenAtRemoval.push((await organizationRow(admin.group.id)).deleted_at);
        };

        const response = await remove(admin.access, admin.group.id);

        expect(response.statusCode).toBe(204);
        expect(storeCalls).toEqual([
          { operation: "remove", key: { kind: "organization-logo", organizationId: admin.group.id, logoId: admin.logoId } },
        ]);
        expect(seenAtRemoval).toEqual([expect.any(Date)]);
        expect(await storedFiles()).toEqual([]);
        expect((await readLogo(admin.group.id, admin.logoId)).statusCode).toBe(404);
      });
    });

    describe("the public read (decisions 3, 16 and 39)", () => {
      it("streams the bytes with no session, with exactly decision 39's headers", async () => {
        const admin = await adminWithLogo(JPEG);

        const response = await readLogo(admin.group.id, admin.logoId);

        expect(response.statusCode).toBe(200);
        expect(response.rawPayload.equals(JPEG)).toBe(true);
        expect(response.headers).toMatchObject({
          "content-type": "image/jpeg",
          "content-length": String(JPEG.length),
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "public, max-age=31536000, immutable",
          "cross-origin-resource-policy": "cross-origin",
        });
        // No other header but the server-wide ones (the per-IP limit's counters, CORS's, the connection's):
        // no Content-Disposition, no Set-Cookie, nothing a later hook adds unnoticed.
        const isServerWide = (name: string) =>
          /^(x-ratelimit-|access-control-)/.test(name) || ["vary", "date", "connection", "keep-alive"].includes(name);
        expect(Object.keys(response.headers).filter((name) => !isServerWide(name)).sort()).toEqual([
          "cache-control",
          "content-length",
          "content-security-policy",
          "content-type",
          "cross-origin-resource-policy",
          "x-content-type-options",
        ]);
      });

      it("destroys the store's read stream when the client goes mid-body (real HTTP)", async () => {
        const big = Buffer.concat([PNG, Buffer.alloc(ORGANIZATION_LOGO_MAXIMUM_BYTES - PNG.length, 7)]);
        const admin = await adminWithLogo(big);
        const real = store;
        /** Every stream the store opened for a read. */
        const opened: Array<{ destroyed: boolean; readableEnded: boolean }> = [];
        store = {
          write: (key, content, options) => real.write(key, content, options),
          read: async (key) => {
            const result = await real.read(key);
            if (result.found) opened.push(result.stream);
            return result;
          },
          copy: (from, to) => real.copy(from, to),
          remove: (key) => real.remove(key),
        };
        const listening = buildTestServer({ fileStore: sharedStore });
        extraServers.push(listening);
        const address = await listening.listen({ port: 0, host: "127.0.0.1" });
        const url = new URL(`/api/v1/organization-logos/${admin.group.id}/${admin.logoId}`, address);

        // The first chunk arrives, then the client goes, far from the end of 2 MiB. Both waits below are
        // capped well under vitest's 5 s (2 s each at most), so a break fails on the check, not the timeout.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no body arrived")), 2_000);
          const outgoing = httpRequest(url, (incoming) => {
            incoming.once("data", () => {
              incoming.pause();
              outgoing.destroy();
              clearTimeout(timer);
              resolve();
            });
          });
          outgoing.on("error", () => undefined);
          outgoing.end();
        });
        for (let attempt = 0; attempt < 100 && !(opened[0]?.destroyed ?? false); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(opened).toHaveLength(1);
        const [stream] = opened;
        expect(stream!.destroyed && !stream!.readableEnded).toBe(true);
      });

      it("reads no session: a garbage access cookie changes nothing", async () => {
        const admin = await adminWithLogo();
        const response = await readLogo(admin.group.id, admin.logoId, { telflo_access: "not-a-token" });
        expect(response.statusCode).toBe(200);
      });

      it("answers the ids in capitals as the same logo (canonicalIdOf)", async () => {
        const admin = await adminWithLogo();
        const response = await readLogo(admin.group.id.toUpperCase(), admin.logoId.toUpperCase());
        expect(response.statusCode).toBe(200);
      });

      it("answers every miss with the same plain-text 404 \"Not found.\"", async () => {
        const admin = await adminWithLogo();
        const other = await adminWithLogo();
        const deleted = await adminWithLogo();
        expect((await remove(deleted.access, deleted.group.id)).statusCode).toBe(204);
        const gone = await adminWithLogo();
        await rm(join(root!, "organizations", gone.group.id), { recursive: true, force: true });

        const misses: Array<[string, string]> = [
          [admin.group.id, randomUUID()],
          [admin.group.id, other.logoId],
          [other.group.id, admin.logoId],
          [randomUUID(), admin.logoId],
          [deleted.group.id, deleted.logoId],
          [gone.group.id, gone.logoId],
          ["not-a-uuid", admin.logoId],
          [admin.group.id, "not-a-uuid"],
          [admin.group.id.replaceAll("-", ""), admin.logoId],
          [`{${admin.group.id}}`, admin.logoId],
          [`${admin.group.id}a`, admin.logoId],
          [admin.group.id, `${admin.logoId}0`],
          ["00000000-0000-0000-0000-000000000000", admin.logoId],
          [admin.group.id, "00000000-0000-0000-0000-000000000000"],
        ];
        for (const [organizationId, logoId] of misses) {
          const response = await readLogo(organizationId, logoId);
          expect(response.statusCode).toBe(404);
          expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
          expect(response.headers["cache-control"]).toBe("no-store");
          expect(response.body).toBe("Not found.\n");
        }
        // Each malformed id stopped before the database: nothing cast and failed there.
        expect(loggedDatabaseErrorCodes()).toEqual([]);
      });

      it("routes no HEAD (exposeHeadRoute: false)", async () => {
        const admin = await adminWithLogo();
        const response = await server.inject({
          method: "HEAD",
          url: `/api/v1/organization-logos/${admin.group.id}/${admin.logoId}`,
        });
        expect(response.statusCode).toBe(404);
      });

      it("is counted per IP on organizationLogosPerIp, every request, a miss's included; its 429 is plain text", async () => {
        const admin = await adminWithLogo();
        const limited = buildTestServer({
          fileStore: sharedStore,
          rateLimits: { ...TEST_RATE_LIMITS, organizationLogosPerIp: { max: 2, windowMs: 60_000 } },
        });
        extraServers.push(limited);
        await limited.ready();
        const url = `/api/v1/organization-logos/${admin.group.id}/${admin.logoId}`;

        expect((await limited.inject({ method: "GET", url })).statusCode).toBe(200);
        expect((await limited.inject({ method: "GET", url: `/api/v1/organization-logos/x/y` })).statusCode).toBe(404);
        const refused = await limited.inject({ method: "GET", url });
        expect(refused.statusCode).toBe(429);
        expect(refused.headers["content-type"]).toBe("text/plain; charset=utf-8");
        expect(refused.headers["retry-after"]).toBeDefined();
      });
    });

    describe("the read model (decision 40)", () => {
      it("/me's organization and organizations, and the switch's answer, carry logoId", async () => {
        const admin = await adminWithLogo();

        const current = (await me(admin.access)).json<{
          organization: { id: string; logoId: string | null };
          organizations: Array<{ id: string; logoId: string | null }>;
        }>();
        expect(current.organization).toMatchObject({ id: admin.group.id, logoId: admin.logoId });
        expect(current.organizations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: admin.group.id, logoId: admin.logoId }),
            expect.objectContaining({ id: admin.personal.id, logoId: null }),
          ]),
        );

        const toPersonal = await server.inject({
          method: "PUT",
          url: "/api/v1/auth/sessions/current/organization",
          headers: csrfHeaders,
          cookies: { telflo_access: admin.access },
          payload: { organizationId: admin.personal.id },
        });
        expect(toPersonal.json<{ organization: { logoId: unknown } }>().organization.logoId).toBeNull();
        const back = await server.inject({
          method: "PUT",
          url: "/api/v1/auth/sessions/current/organization",
          headers: csrfHeaders,
          cookies: { telflo_access: cookieValue(toPersonal, "telflo_access") },
          payload: { organizationId: admin.group.id },
        });
        expect(back.json<{ organization: { id: string; logoId: unknown } }>().organization).toMatchObject({
          id: admin.group.id,
          logoId: admin.logoId,
        });
      });
    });
  });
});
