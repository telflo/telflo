import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import type { Database } from "@telflo/db";
import {
  addInvitation,
  addMembership,
  createUserWithOrganization,
  openTestDatabases,
  truncateAll,
  type TestDatabases,
} from "@telflo/db/testing";
import type { ServerDependencies } from "../../dependencies.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { TEST_RATE_LIMITS } from "../../http/rate-limits.js";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { createOpampServerClient, sha256Hex, type OpampServerClient } from "../../opamp-server/client.js";
import { buildServer } from "../../server.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { startFakeOidcProvider, type FakeOidcProvider } from "../../testing/fake-oidc-provider.js";
import { startFakeOpampServer, type FakeOpampServer } from "../../testing/fake-opamp-server.js";
import { hashPassword } from "../identity/password.js";
import { hashToken } from "../identity/tokens.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { TEST_TERMS_VERSION } from "../../testing/site.js";

/*
 * D11a decision 20, through the routes, against the real database and the
 * OpenAPI-checked fake opamp-server: each way an organization is created
 * (password, Google and invitation sign-up, and "New organization") registers
 * it after the response, and a rename and a delete follow it there. The
 * request never waits for the opamp-server and never fails for it; a miss is
 * a warning that names neither the organization nor its owner.
 */

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
/** The flow cookie's name: the test settings' cookies are Secure. */
const FLOW_COOKIE = "__Secure-telflo_oidc";

function cookieValue(response: LightMyRequestResponse, name: string): string {
  const header = response.headers["set-cookie"];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`the response set no ${name} cookie`);
  return line.slice(name.length + 1, line.indexOf(";"));
}

/** A URL nothing listens on: a port just closed. */
async function closedUrl(): Promise<string> {
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((done) => closed.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

describe("the opamp-server's registry, kept by the platform's routes", () => {
  let fake: FakeOpampServer;
  let oidc: FakeOidcProvider;
  let client: OpampServerClient;
  let settings: AppSettings;
  let databases: TestDatabases;
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** Replaced before each test, so work one test queued never runs in another. */
  let runner: CollectingRunner;
  /** How many jobs the servers queued since the test began. */
  let scheduled: number;
  /** The servers' log lines (warn and above) since the test began. */
  let lines: string[];
  const servers: FastifyInstance[] = [];

  /** A server on the test database, with the fake's client, whose jobs queue on `runner`, logging at warn into `lines`. */
  async function serverWith(overrides: Partial<ServerDependencies> = {}): Promise<FastifyInstance> {
    const previousLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    let built: FastifyInstance;
    try {
      built = buildServer({
        settings,
        db: databases.db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits: TEST_RATE_LIMITS,
        runAfterResponse: (task) => {
          scheduled += 1;
          runner.run(task);
        },
        logStream: { write: (line) => void lines.push(line) },
        opampServer: client,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        ...overrides,
      });
    } finally {
      if (previousLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLevel;
    }
    servers.push(built);
    await built.ready();
    return built;
  }

  beforeAll(async () => {
    fake = await startFakeOpampServer();
    oidc = await startFakeOidcProvider();
    client = createOpampServerClient({ url: fake.url, secret: fake.secret });
    settings = {
      ...loadSettings(process.env),
      oidcProviders: [
        { id: "google", name: "Google", issuer: oidc.issuer, clientId: oidc.clientId, clientSecret: oidc.clientSecret },
      ],
    };
    databases = openTestDatabases();
    ownerDb = databases.ownerDb;
    server = await serverWith();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await Promise.all(servers.map((each) => each.close()));
    await databases.destroy();
    await oidc.close();
    await fake.close();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    clock = new Date();
    runner = createCollectingRunner();
    scheduled = 0;
    lines = [];
  });

  afterEach(() => {
    expect(fake.takeViolations()).toEqual([]);
  });

  /** The personal organization of the account with `email`, read as the owner. */
  const personalOrganizationOf = (email: string) =>
    ownerDb
      .selectFrom("organizations")
      .innerJoin("users", "users.id", "organizations.owner_user_id")
      .select(["organizations.id", "organizations.name"])
      .where("users.email", "=", email)
      .where("organizations.type", "=", "personal")
      .executeTakeFirstOrThrow();

  const register = (email: string, on: FastifyInstance = server) =>
    on.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD, acceptedTermsVersion: TEST_TERMS_VERSION },
    });

  /** A verified account, signed in to its personal organization: the access cookie's value. */
  const signedInAccount = async () => {
    const account = await createUserWithOrganization(ownerDb, {
      user: { email: `person-${randomUUID()}@example.com`, password_hash: passwordHash },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email: account.user.email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return { account, access: cookieValue(response, "telflo_access") };
  };

  /** "New organization", then the session switched into it, where a rename or a delete acts. */
  const newOrganizationActive = async (name = `Acme ${randomUUID()}`) => {
    const { access } = await signedInAccount();
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { organization: { id: string } }).organization.id;
    const switched = await server.inject({
      method: "PUT",
      url: "/api/v1/auth/sessions/current/organization",
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { organizationId: id },
    });
    expect(switched.statusCode).toBe(200);
    // A no-op when the sign-in already landed there (D36-1 decision 56): no new cookie, the token sent stands.
    return { id, name, access: (switched.headers["set-cookie"] === undefined ? access : cookieValue(switched, "telflo_access")) };
  };

  const rename = (id: string, access: string, name: string) =>
    server.inject({
      method: "PATCH",
      url: `/api/v1/organizations/${id}`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
      payload: { name },
    });

  const remove = (id: string, access: string) =>
    server.inject({
      method: "DELETE",
      url: `/api/v1/organizations/${id}`,
      headers: csrfHeaders,
      cookies: { telflo_access: access },
    });

  /** The server's warnings and errors, parsed. */
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  describe("sign-up registers the new personal organization", () => {
    it("by password, after the response", async () => {
      const email = `person-${randomUUID()}@example.com`;

      expect((await register(email)).statusCode).toBe(200);

      const personal = await personalOrganizationOf(email);
      // Queued, not sent: the response didn't wait for it.
      expect(await client.getOrganization(personal.id)).toEqual({ kind: "not_found" });
      await runner.settle();
      expect(await client.getOrganization(personal.id)).toMatchObject({
        kind: "found",
        organization: { organizationId: personal.id, name: email },
      });
      expect(logged()).toEqual([]);
    });

    it("with Google", async () => {
      const email = `person-${randomUUID()}@gmail.com`;
      const started = await server.inject({ method: "GET", url: "/api/v1/auth/oidc/google" });
      expect(started.statusCode).toBe(302);
      oidc.nextSignIn({ email });
      const atProvider = await fetch(started.headers.location as string, { redirect: "manual" });
      const back = new URL(atProvider.headers.get("location")!);

      const signedIn = await server.inject({
        method: "GET",
        url: `${back.pathname}${back.search}`,
        cookies: { [FLOW_COOKIE]: cookieValue(started, FLOW_COOKIE) },
      });

      expect(signedIn.statusCode).toBe(302);
      expect(signedIn.headers.location).toBe(`${settings.publicWebUrl}/app`);
      const personal = await personalOrganizationOf(email);
      await runner.settle();
      expect(await client.getOrganization(personal.id)).toMatchObject({
        kind: "found",
        organization: { name: email },
      });
      expect(logged()).toEqual([]);
    });

    it("from an invitation, and only the personal one", async () => {
      const admin = await createUserWithOrganization(ownerDb);
      const { organization: group } = await addMembership(ownerDb, { userId: admin.user.id, role: "admin" });
      const token = randomBytes(32).toString("base64url");
      const email = `invitee-${randomUUID()}@example.com`;
      await addInvitation(ownerDb, { organizationId: group.id, email, token_hash: hashToken(token) });

      const response = await server.inject({
        method: "POST",
        url: "/api/v1/invitation-registrations",
        headers: csrfHeaders,
        payload: { token, password: PASSWORD, acceptedTermsVersion: TEST_TERMS_VERSION },
      });

      expect(response.statusCode).toBe(201);
      const personal = await personalOrganizationOf(email);
      await runner.settle();
      expect(await client.getOrganization(personal.id)).toMatchObject({
        kind: "found",
        organization: { name: email },
      });
      // The organization joined isn't created by the sign-up: nothing is sent for it.
      expect(await client.getOrganization(group.id)).toEqual({ kind: "not_found" });
      expect(scheduled).toBe(1);
    });
  });

  describe("the organizations' routes", () => {
    it("register a new group organization", async () => {
      const { id, name } = await newOrganizationActive();

      await runner.settle();

      expect(await client.getOrganization(id)).toMatchObject({ kind: "found", organization: { organizationId: id, name } });
      expect(logged()).toEqual([]);
    });

    it("rename it with PATCH, and send nothing for its own name", async () => {
      const { id, name, access } = await newOrganizationActive();
      await runner.settle();
      const before = scheduled;

      expect((await rename(id, access, "Renamed Corp")).statusCode).toBe(200);
      await runner.settle();
      expect(await client.getOrganization(id)).toMatchObject({ organization: { name: "Renamed Corp" } });

      expect((await rename(id, access, "Renamed Corp")).statusCode).toBe(200);
      expect(scheduled).toBe(before + 1);
      expect(name).not.toBe("Renamed Corp");
    });

    it("delete it with DELETE, its publications with it", async () => {
      const { id, access } = await newOrganizationActive();
      await runner.settle();
      const yaml = "receivers:\n  otlp:\n";
      const publicationId = randomUUID();
      const put = await client.postPublication(id, publicationId, {
        configuration: { id: randomUUID(), name: "payments" },
        version: { id: randomUUID(), number: 1, label: null },
        yaml,
        sha256: sha256Hex(yaml),
        publishedBy: null,
        publishedAt: clock.toISOString(),
        collector: { distribution: "otelcol-contrib", version: "0.162.0" },
      });
      expect(put.kind).toBe("created");

      expect((await remove(id, access)).statusCode).toBe(204);
      expect(await client.getOrganization(id)).toMatchObject({ kind: "found" });
      await runner.settle();

      expect(await client.getOrganization(id)).toEqual({ kind: "not_found" });
      expect(await client.getPublication(id, publicationId)).toEqual({ kind: "organization_not_found" });
      // Registered again, it is empty: the publication went with the delete.
      await client.createOrganization({ id, name: "again" });
      expect(await client.getPublication(id, publicationId)).toEqual({ kind: "not_found" });
      expect(logged()).toEqual([]);
    });

    it("send nothing for a change the platform refused", async () => {
      const { account, access } = await signedInAccount();

      // A personal organization can't be deleted, and a name can't be empty.
      expect((await remove(account.organization.id, access)).statusCode).toBe(409);
      expect((await rename(account.organization.id, access, "")).statusCode).toBe(400);

      expect(scheduled).toBe(0);
    });
  });

  describe("when the opamp-server can't be reached", () => {
    it("signs up all the same, and warns without the name or the email", async () => {
      const down = await serverWith({
        opampServer: createOpampServerClient({ url: await closedUrl(), secret: fake.secret }),
      });
      const email = `person-${randomUUID()}@example.com`;

      expect((await register(email, down)).statusCode).toBe(200);
      await expect(runner.settle()).resolves.toBeUndefined();

      const personal = await personalOrganizationOf(email);
      expect(logged()).toEqual([
        expect.objectContaining({
          level: 40,
          operation: "createOrganization",
          organizationId: personal.id,
          result: "unavailable",
          reason: "network",
          msg: "the opamp-server didn't register the organization",
        }),
      ]);
      const log = lines.join("\n");
      // The personal organization's name is the email (Q263): one check covers both.
      expect(log).not.toContain(personal.name);
      expect(log).not.toContain(email);
      expect(log).not.toContain(fake.secret);
    });

    it("deletes all the same, retries the opamp-server's delete, and at the server's close logs it as pending (D16b Preflight ruling 14)", async () => {
      const { id, access } = await newOrganizationActive();
      await runner.settle();
      const down = await serverWith({
        opampServer: createOpampServerClient({ url: await closedUrl(), secret: fake.secret }),
      });
      lines = [];

      const removed = await down.inject({
        method: "DELETE",
        url: `/api/v1/organizations/${id}`,
        headers: csrfHeaders,
        cookies: { telflo_access: access },
      });
      expect(removed.statusCode).toBe(204);
      await runner.settle();
      expect(logged()).toEqual([
        expect.objectContaining({
          level: 40,
          operation: "deleteOrganization",
          organizationId: id,
          attempt: 1,
          attempts: 5,
          retryInSeconds: 5,
          result: "unavailable",
          reason: "network",
        }),
      ]);

      // The retry waits on its timer when the server stops: lost, and logged so.
      await down.close();
      servers.splice(servers.indexOf(down), 1);
      expect(logged().at(-1)).toMatchObject({ level: 50, operation: "deleteOrganization", organizationIds: [id] });
      expect(lines.join("\n")).not.toContain(fake.secret);
    });

    it("signs up all the same when it answers 500", async () => {
      const email = `person-${randomUUID()}@example.com`;
      fake.nextFault("error_500");

      expect((await register(email)).statusCode).toBe(200);
      await runner.settle();

      expect(logged()).toEqual([
        expect.objectContaining({ operation: "createOrganization", result: "unavailable", reason: "server_error", status: 500 }),
      ]);
      expect(lines.join("\n")).not.toContain(email);
    });
  });
});
