import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createUserWithOrganization, openTestDatabases, truncateAll, type TestDatabases } from "@telflo/db/testing";
import type { FileKey, IFileStore } from "../../file-store/file-store.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { buildServer } from "../../server.js";
import { loadSettings } from "../../settings.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { hashPassword } from "../identity/password.js";

/*
 * The product admins' switch, "Only product admins can create organizations",
 * through the real server and database:
 *   * `GET`/`PATCH /api/v1/product-admin/settings`: a product admin reads
 *     and changes it (each change, and an unchanged value, audited with
 *     from and to); anyone else is answered as every product-admin route
 *     answers them (401 signed out, 403 `product_admin_required`), with
 *     nothing changed; `no-store`;
 *   * `POST /api/v1/organizations`: allowed for anyone while it is off;
 *     while it is on, refused 403 `organization_creation_restricted` in
 *     fixed words to a person who isn't a product admin, with a logo sent
 *     or not, before any logo byte is written (the store is never called,
 *     no organization, no audit row); allowed for a product admin;
 *   * `/me`'s `mayCreateOrganizations`: true while it is off, or for a
 *     product admin; false for anyone else while it is on.
 * The tests start from truncateAll's baseline, off (`everyone`); the
 * migration's default is on, checked here from the column's default.
 * Seeded addresses are made-up @example.com fixtures; nothing here prints one.
 */

const opamp = useFakeOpampServer();
const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const ROUTE = "/api/v1/product-admin/settings";
const RESTRICTED = {
  error: { code: "organization_creation_restricted", message: "Only product admins can create organizations on this site." },
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);

describe("the product admins' organization-creation switch", () => {
  let databases: TestDatabases;
  let passwordHash: string;
  let server: FastifyInstance;
  /** Every call the server made to the file store: a refused create makes none. */
  let storeCalls: Array<{ operation: string; key: FileKey }> = [];
  const recordingStore: IFileStore = {
    write: async (key, content) => {
      storeCalls.push({ operation: "write", key });
      for await (const _chunk of content) {
        // Drained: the bytes go nowhere.
      }
      return { sizeBytes: PNG.length, sha256: "0".repeat(64) };
    },
    read: async (key) => {
      storeCalls.push({ operation: "read", key });
      return { found: false };
    },
    copy: async (from) => {
      storeCalls.push({ operation: "copy", key: from });
      return { found: false };
    },
    remove: async (key) => {
      storeCalls.push({ operation: "remove", key });
    },
  };

  beforeAll(async () => {
    databases = openTestDatabases();
    passwordHash = await hashPassword(PASSWORD);
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error";
    try {
      server = buildServer({
        opampServer: opamp.client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: recordingStore,
        testing: UNCALLED_TESTING,
        settings: loadSettings(process.env),
        db: databases.db,
        mailer: createInMemoryMailer(),
        rateLimits: TEST_RATE_LIMITS,
        logStream: { write: () => {} },
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await databases.destroy();
  });

  beforeEach(async () => {
    await truncateAll(databases.ownerDb);
    storeCalls = [];
  });

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  /** A live, verified person, signed in to their personal organization; a product admin when asked. */
  const signedIn = async (isProductAdmin = false) => {
    const created = await createUserWithOrganization(databases.ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash, is_product_admin: isProductAdmin },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: created.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return { userId: created.user.id, access: cookieValue(response, "telflo_access") };
  };

  const getSettings = (access?: string) =>
    server.inject({ method: "GET", url: ROUTE, ...(access === undefined ? {} : { cookies: { telflo_access: access } }) });

  const patchSettings = (access: string | undefined, payload: unknown) =>
    server.inject({
      method: "PATCH",
      url: ROUTE,
      headers: csrfHeaders,
      ...(access === undefined ? {} : { cookies: { telflo_access: access } }),
      payload: payload as Record<string, unknown>,
    });

  const stored = async () =>
    (await databases.ownerDb.selectFrom("site_settings").select("organization_creation").executeTakeFirstOrThrow()).organization_creation;

  const settingsAudits = async () =>
    (
      await databases.ownerDb
        .selectFrom("audit_events")
        .select(["action", "actor_user_id", "organization_id", "metadata"])
        .where("action", "like", "product_admin.%")
        .orderBy("occurred_at")
        .orderBy("id")
        .execute()
    ).map(({ action, actor_user_id, organization_id, metadata }) => ({ action, actor: actor_user_id, organization_id, metadata }));

  /** Turns the switch on, as a product admin would. */
  const turnOn = async () => {
    const admin = await signedIn(true);
    expect((await patchSettings(admin.access, { organizationCreation: "product-admins" })).statusCode).toBe(200);
    return admin;
  };

  const createJson = (access: string, name: string) =>
    server.inject({ method: "POST", url: "/api/v1/organizations", headers: csrfHeaders, cookies: { telflo_access: access }, payload: { name } });

  const createWithLogo = (access: string, name: string) => {
    const boundary = `----telflo-${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return server.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { ...csrfHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      cookies: { telflo_access: access },
      payload,
    });
  };

  const organizationsNamed = (name: string) =>
    databases.ownerDb.selectFrom("organizations").select("id").where("name", "=", name).execute();

  const mayCreate = async (access: string) =>
    (await server.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { telflo_access: access } })).json<{
      mayCreateOrganizations: boolean;
    }>().mayCreateOrganizations;

  describe("GET and PATCH /api/v1/product-admin/settings", () => {
    it("a product admin reads everyone (the tests' baseline), turns the switch on and off, and sets a value it holds: 200 each, no-store, audited with from and to in no organization", async () => {
      const admin = await signedIn(true);
      const read = await getSettings(admin.access);
      expect({ status: read.statusCode, cache: read.headers["cache-control"], body: read.json() }).toEqual({
        status: 200,
        cache: "no-store",
        body: { organizationCreation: "everyone" },
      });

      for (const value of ["product-admins", "product-admins", "everyone"]) {
        const response = await patchSettings(admin.access, { organizationCreation: value });
        expect({ status: response.statusCode, cache: response.headers["cache-control"], body: response.json() }).toEqual({
          status: 200,
          cache: "no-store",
          body: { organizationCreation: value },
        });
      }
      expect(await stored()).toBe("everyone");
      expect((await getSettings(admin.access)).json()).toEqual({ organizationCreation: "everyone" });
      expect(await settingsAudits()).toEqual([
        { action: "product_admin.organization_creation_changed", actor: admin.userId, organization_id: null, metadata: { from: "everyone", to: "product-admins" } },
        { action: "product_admin.organization_creation_unchanged", actor: admin.userId, organization_id: null, metadata: { from: "product-admins", to: "product-admins" } },
        { action: "product_admin.organization_creation_changed", actor: admin.userId, organization_id: null, metadata: { from: "product-admins", to: "everyone" } },
      ]);
    });

    it("answers anyone else as every product-admin route does (401 signed out, 403 product_admin_required), changing and auditing nothing", async () => {
      const person = await signedIn();
      const refusals = [
        await getSettings(),
        await patchSettings(undefined, { organizationCreation: "product-admins" }),
        await getSettings(person.access),
        await patchSettings(person.access, { organizationCreation: "product-admins" }),
      ];
      expect(refusals.map((response) => ({ status: response.statusCode, code: response.json().error.code, cache: response.headers["cache-control"] }))).toEqual([
        { status: 401, code: "unauthenticated", cache: "no-store" },
        { status: 401, code: "unauthenticated", cache: "no-store" },
        { status: 403, code: "product_admin_required", cache: "no-store" },
        { status: 403, code: "product_admin_required", cache: "no-store" },
      ]);
      expect(await stored()).toBe("everyone");
      expect(await settingsAudits()).toEqual([]);
    });

    it("refuses a body that isn't one of the two values with 400, changing nothing", async () => {
      const admin = await signedIn(true);
      for (const payload of [{}, { organizationCreation: "product_admins" }, { organizationCreation: true }, { organizationCreation: "everyone", other: 1 }]) {
        expect((await patchSettings(admin.access, payload)).statusCode).toBe(400);
      }
      expect(await stored()).toBe("everyone");
    });
  });

  describe("POST /api/v1/organizations under the switch", () => {
    it("off: anyone signed in creates an organization, and /me says they may", async () => {
      const person = await signedIn();
      expect(await mayCreate(person.access)).toBe(true);
      const response = await createJson(person.access, "Open Corp");
      expect(response.statusCode).toBe(201);
      expect(await organizationsNamed("Open Corp")).toHaveLength(1);
    });

    it("on: refuses a person who isn't a product admin with 403 organization_creation_restricted in fixed words, with or without a logo, before any logo byte is written; /me says they may not", async () => {
      await turnOn();
      const person = await signedIn();
      const auditsBefore = await databases.ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute();

      const plain = await createJson(person.access, "Closed Corp");
      const withLogo = await createWithLogo(person.access, "Closed Logo Corp");

      expect({ status: plain.statusCode, body: plain.json() }).toEqual({ status: 403, body: RESTRICTED });
      expect({ status: withLogo.statusCode, body: withLogo.json() }).toEqual({ status: 403, body: RESTRICTED });
      expect(storeCalls).toEqual([]);
      expect(await organizationsNamed("Closed Corp")).toEqual([]);
      expect(await organizationsNamed("Closed Logo Corp")).toEqual([]);
      expect(await databases.ownerDb.selectFrom("audit_events").selectAll().orderBy("id").execute()).toEqual(auditsBefore);
      expect(await mayCreate(person.access)).toBe(false);
    });

    it("at the migration's default, on: a person who isn't a product admin is refused 403 organization_creation_restricted and /me says they may not; a product admin reads product-admins", async () => {
      await sql`update site_settings set organization_creation = default`.execute(databases.ownerDb);
      const admin = await signedIn(true);
      expect((await getSettings(admin.access)).json()).toEqual({ organizationCreation: "product-admins" });
      const person = await signedIn();
      expect(await mayCreate(person.access)).toBe(false);
      const refused = await createJson(person.access, "Default Corp");
      expect({ status: refused.statusCode, body: refused.json() }).toEqual({ status: 403, body: RESTRICTED });
      expect(await organizationsNamed("Default Corp")).toEqual([]);
    });

    it("on: a product admin still creates one, with a logo, and /me says they may", async () => {
      const admin = await turnOn();
      expect(await mayCreate(admin.access)).toBe(true);
      const plain = await createJson(admin.access, "Admin Corp");
      const withLogo = await createWithLogo(admin.access, "Admin Logo Corp");
      expect([plain.statusCode, withLogo.statusCode]).toEqual([201, 201]);
      expect(storeCalls.map((call) => call.operation)).toEqual(["write"]);
      expect(await organizationsNamed("Admin Logo Corp")).toHaveLength(1);
    });

    it("on, then off again: the person creates one", async () => {
      const admin = await turnOn();
      const person = await signedIn();
      expect((await createJson(person.access, "Later Corp")).statusCode).toBe(403);
      expect((await patchSettings(admin.access, { organizationCreation: "everyone" })).statusCode).toBe(200);
      expect(await mayCreate(person.access)).toBe(true);
      expect((await createJson(person.access, "Later Corp")).statusCode).toBe(201);
    });
  });
});
