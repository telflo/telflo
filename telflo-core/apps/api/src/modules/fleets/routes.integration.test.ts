import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql, type Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, FLEETS_UNAVAILABLE_MESSAGE } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import { addMembership, createUserWithOrganization, truncateAll, withFailingInsert } from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { createOpampServerClient, OpampServerMisconfigurationError, type OpampServerClient } from "../../opamp-server/client.js";
import type { FakeOpampServerFault } from "../../testing/fake-opamp-server.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";
const DAY = 24 * 60 * 60 * 1000;

const MESSAGES = {
  organizationNotFound: "Organization not found",
  fleetNotFound: "Fleet not found",
  tokenNotFound: "Enrollment token not found",
  terms: "Accept the current Terms of Service to continue.",
  rateLimited: "Too many attempts. Please wait and try again.",
};

/** Ids that aren't canonical UUIDs, as a path segment carries them. */
const MALFORMED_PATH_IDS = ["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F", "%7B0192f1a4-7b3c-7d2e-8f10-1a2b3c4d5e6f%7D"];

interface FleetBody {
  id: string;
  label: string;
  type: string;
  status: string;
  createdBy: { userId: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
  summary?: Record<string, unknown>;
}

interface CreatedBody {
  fleet: FleetBody;
  defaultGroup: { id: string; isDefault: boolean; name: string; assignedPublishedVersionId: string | null; assignedVersion: unknown };
  tokens: { default: { id: string; bearer: string }; rotate: { id: string; bearer: string; expiresAt: string | null } };
}

interface TokenBody {
  id: string;
  fleetId: string;
  kind: string;
  expiresAt: string | null;
  revokedAt: string | null;
  doRefresh: boolean;
  createdBy: { userId: string; email: string } | null;
  createdAt: string;
  activeCollectors?: number;
}

/** One call the server made to the opamp-server, through the wrapper. */
interface Call {
  operation: keyof OpampServerClient;
  args: unknown[];
}

/** A one-shot gate: `hold` waits until `release`, and `reached` resolves once something holds. */
function createGate() {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (open = resolve));
  return {
    reached,
    release: () => open(),
    hold: async () => {
      reach();
      await released;
    },
  };
}

/**
 * D16b decisions 1, 4 to 6, 13, 15 to 18 and 21 and Preflight rulings 8 to
 * 16 and 19, for the fleet and token routes (Task 3), against Postgres
 * through the API as its own role, with the OpenAPI-checked fake as the
 * opamp-server. The server's client is the fake's, wrapped: every call is
 * recorded, and a test can put a hook in front of any method.
 */
describe("the fleet routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began, at info and above. */
  let logLines: string[] = [];
  /** The after-response runner: nothing runs until `settle()`. */
  let runner: CollectingRunner;
  let calls: Call[] = [];
  let hooks: Partial<Record<keyof OpampServerClient, (...args: unknown[]) => Promise<unknown>>> = {};

  /** The wrapper the server calls: each method records the call, then runs the test's hook or the fake's client. */
  const serverClient = new Proxy({} as OpampServerClient, {
    get(_target, property) {
      const operation = property as keyof OpampServerClient;
      return (...args: unknown[]) => {
        calls.push({ operation, args });
        const target = (hooks[operation] ?? opamp.client[operation]) as (...given: unknown[]) => Promise<unknown>;
        return target(...args);
      };
    },
  });

  function build(rateLimits: RateLimits): FastifyInstance {
    const previousLevel = process.env.LOG_LEVEL;
    // Info, so each request's own log line is captured too.
    process.env.LOG_LEVEL = "info";
    try {
      return buildServer({
        opampServer: serverClient,
        otelcolValidator: UNCALLED_OTELCOL_VALIDATOR,
        fileStore: UNCALLED_FILE_STORE,
        testing: UNCALLED_TESTING,
        settings,
        db,
        mailer: createInMemoryMailer(),
        now: () => clock,
        rateLimits,
        runAfterResponse: (task) => runner.run(task),
        logStream: { write: (line) => void logLines.push(line) },
      });
    } finally {
      process.env.LOG_LEVEL = previousLevel;
    }
  }

  beforeAll(async () => {
    settings = loadSettings(process.env);
    ownerDb = createDb(createPool(process.env.TELFLO_MIGRATION_DATABASE_URL!));
    db = createDb(createPool(settings.databaseUrl));
    server = build(TEST_RATE_LIMITS);
    await server.ready();
    passwordHash = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    await server.close();
    await db.destroy();
    await ownerDb.destroy();
  });

  beforeEach(async () => {
    await truncateAll(ownerDb);
    // Whole seconds, as the access tokens' clock reads it.
    clock = new Date(Math.floor(Date.now() / 1000) * 1000);
    logLines = [];
    runner = createCollectingRunner();
    calls = [];
    hooks = {};
  });

  const operations = () => calls.map((call) => call.operation);

  function expectRefusal(response: LightMyRequestResponse, statusCode: number, code: string, message?: string): void {
    expect({ status: response.statusCode, code: response.json<{ error: { code: string } }>().error.code }).toEqual({
      status: statusCode,
      code,
    });
    if (message !== undefined) expect(response.json<{ error: { message: string } }>().error.message).toBe(message);
  }

  /** The fields a 400's `details` name, by their instancePath: the contract's and the service's alike (Ruling 31). */
  function detailPaths(response: LightMyRequestResponse): string[] {
    return (response.json<{ error: { details?: { instancePath: string }[] } }>().error.details ?? []).map((detail) => detail.instancePath);
  }

  /** No log line holds any of `privates`. */
  function expectNotLogged(...privates: string[]): void {
    expect(logLines.length).toBeGreaterThan(0);
    for (const value of privates) expect(logLines.filter((line) => line.includes(value))).toEqual([]);
  }

  const logged = () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

  const cookieValue = (response: LightMyRequestResponse, name: string): string => {
    const header = response.headers["set-cookie"];
    const lines = header === undefined ? [] : Array.isArray(header) ? header : [header];
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) throw new Error(`the response set no ${name} cookie`);
    return line.slice(name.length + 1, line.indexOf(";"));
  };

  const verifiedUser = (overrides: Parameters<typeof createUserWithOrganization>[1] = {}) =>
    createUserWithOrganization(ownerDb, {
      ...overrides,
      user: {
        email: `person-${Math.random().toString(36).slice(2)}@example.com`,
        password_hash: passwordHash,
        ...overrides.user,
      },
    });

  const signedIn = async (on: FastifyInstance, email: string) => {
    const response = await on.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

  const switchTo = async (on: FastifyInstance, access: string, organizationId: string) => {
    const response = await on.inject({
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

  interface Person {
    userId: string;
    email: string;
    access: string;
  }

  /** A signed-in user who is a `role` of a group organization (a new one unless given) and active in it. */
  const member = async (role: OrganizationRole, organizationId?: string, on: FastifyInstance = server) => {
    const account = await verifiedUser();
    const { organization } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(on, await signedIn(on, account.user.email), organization.id);
    return { organizationId: organization.id, person: { userId: account.user.id, email: account.user.email, access } };
  };

  /** A group organization with an admin and a contributor, both active in it. */
  const team = async (on: FastifyInstance = server) => {
    const { organizationId, person: admin } = await member("admin", undefined, on);
    const { person: contributor } = await member("contributor", organizationId, on);
    return { organizationId, admin, contributor };
  };

  const fleetsPath = (organizationId: string) => `/api/v1/organizations/${organizationId}/fleets`;
  const fleetPath = (organizationId: string, fleetId: string) => `${fleetsPath(organizationId)}/${fleetId}`;

  const send = (
    person: Pick<Person, "access"> | undefined,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
    on: FastifyInstance = server,
  ) =>
    on.inject({
      method,
      url,
      headers: csrfHeaders,
      ...(person === undefined ? {} : { cookies: { telflo_access: person.access } }),
      ...(payload === undefined ? {} : { payload }),
    });

  let labels = 0;
  const tomorrow = () => new Date(clock.getTime() + DAY).toISOString();

  /** A fleet created through the API, 201. */
  const created = async (person: Person, organizationId: string, fields: Record<string, unknown> = {}, on = server) => {
    const response = await send(
      person,
      "POST",
      fleetsPath(organizationId),
      { label: `fleet-${++labels}`, type: "server", rotateExpiresAt: null, ...fields },
      on,
    );
    expect(response.statusCode).toBe(201);
    return response.json<CreatedBody>();
  };

  /** The organization's audit rows, oldest first: action, subject and metadata. */
  const auditRows = async (organizationId: string) =>
    (
      await ownerDb
        .selectFrom("audit_events")
        .selectAll()
        .where("organization_id", "=", organizationId)
        .where((eb) => eb.or([eb("action", "like", "fleet.%"), eb("action", "like", "enrollment_token.%")]))
        .orderBy("id")
        .execute()
    ).map((row) => ({
      action: row.action,
      actorUserId: row.actor_user_id,
      actorEmail: row.actor_email,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      metadata: row.metadata,
    }));

  /** Every audit row of the organization, every column, as text. */
  const auditText = async (organizationId: string) =>
    JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().where("organization_id", "=", organizationId).execute());

  // -------------------------------------------------------------------------

  describe.each(["admin", "contributor"] as const)("for a %s (decision 6: every member)", (role) => {
    it("creates a fleet (201, no-store, both bearers once), lists it, reads it, renames and archives it, and deletes it", async () => {
      const { organizationId, admin, contributor } = await team();
      const person = role === "admin" ? admin : contributor;
      const id = randomUUID();

      const create = await send(person, "POST", fleetsPath(organizationId), {
        id: id.toUpperCase(),
        label: "edge-prod",
        type: "server",
        rotateExpiresAt: tomorrow(),
      });
      expect(create.statusCode).toBe(201);
      expect(create.headers["cache-control"]).toBe("no-store");
      const body = create.json<CreatedBody>();
      expect(body.fleet).toEqual({
        id,
        label: "edge-prod",
        type: "server",
        status: "active",
        createdBy: { userId: person.userId, email: person.email },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(body.defaultGroup).toMatchObject({ name: "Default", isDefault: true, assignedPublishedVersionId: null, assignedVersion: null });
      expect(body.tokens.default.bearer).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(body.tokens.rotate.bearer).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(body.tokens.rotate.expiresAt).toBe(tomorrow());
      // Registered first (decision 15); the actor is the session's.
      expect(operations()).toEqual(["createOrganization", "createFleet"]);
      expect(calls[1]?.args[1]).toMatchObject({ id, actor: { id: person.userId, email: person.email } });
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({
        organization: { id: organizationId },
        fleets: [{ id, createdBy: { id: person.userId, email: person.email } }],
      });

      const list = await send(person, "GET", fleetsPath(organizationId));
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        fleets: [{ ...body.fleet, summary: expect.objectContaining({ collectors: 0, unassigned: 0 }) }],
        nextCursor: null,
      });

      const read = await send(person, "GET", fleetPath(organizationId, id));
      expect(read.statusCode).toBe(200);
      expect(read.json<{ fleet: FleetBody }>().fleet).toMatchObject({ id, label: "edge-prod", summary: { collectors: 0 } });

      const renamed = await send(person, "PATCH", fleetPath(organizationId, id), { label: "edge-renamed" });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json<{ fleet: FleetBody }>().fleet).toMatchObject({ label: "edge-renamed", status: "active" });
      const archived = await send(person, "PATCH", fleetPath(organizationId, id), { status: "archived" });
      expect(archived.json<{ fleet: FleetBody }>().fleet).toMatchObject({ status: "archived" });
      const archivedList = await send(person, "GET", `${fleetsPath(organizationId)}?status=active`);
      expect(archivedList.json()).toEqual({ fleets: [], nextCursor: null });

      const removed = await send(person, "DELETE", fleetPath(organizationId, id));
      expect(removed.statusCode).toBe(204);
      expectRefusal(await send(person, "GET", fleetPath(organizationId, id)), 404, "fleet_not_found", MESSAGES.fleetNotFound);
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ fleets: [], tokens: [], groups: [] });

      expect(await auditRows(organizationId)).toEqual([
        { action: "fleet.created", actorUserId: person.userId, actorEmail: person.email, subjectType: "fleet", subjectId: id, metadata: { fleetId: id, type: "server" } },
        { action: "fleet.updated", actorUserId: person.userId, actorEmail: person.email, subjectType: "fleet", subjectId: id, metadata: { fleetId: id, fields: ["label"], status: "active" } },
        { action: "fleet.updated", actorUserId: person.userId, actorEmail: person.email, subjectType: "fleet", subjectId: id, metadata: { fleetId: id, fields: ["status"], status: "archived" } },
        { action: "fleet.deleted", actorUserId: person.userId, actorEmail: person.email, subjectType: "fleet", subjectId: id, metadata: { fleetId: id } },
      ]);
    });

    it("lists the tokens without bearers, rotates (201, no-store), reveals (no-store), and revokes, every time audited", async () => {
      const { organizationId, admin, contributor } = await team();
      const person = role === "admin" ? admin : contributor;
      const fleet = await created(admin, organizationId);
      const fleetId = fleet.fleet.id;

      const tokens = await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens`);
      expect(tokens.statusCode).toBe(200);
      expect(tokens.body).not.toContain("bearer");
      expect(tokens.json<{ tokens: TokenBody[] }>().tokens.map((token) => [token.id, token.kind, token.activeCollectors]).sort()).toEqual(
        [
          [fleet.tokens.default.id, "default", 0],
          [fleet.tokens.rotate.id, "rotate", 0],
        ].sort(),
      );

      const rotate = await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/rotate`, {
        expiresAt: null,
        graceEndsAt: tomorrow(),
      });
      expect(rotate.statusCode).toBe(201);
      expect(rotate.headers["cache-control"]).toBe("no-store");
      const rotated = rotate.json<{ token: { id: string; bearer: string; expiresAt: null; predecessorId: string } }>().token;
      expect(rotated).toEqual({ id: expect.any(String), bearer: expect.any(String), expiresAt: null, predecessorId: fleet.tokens.rotate.id });
      expect(calls.at(-1)?.args[2]).toMatchObject({ actor: { id: person.userId, email: person.email } });

      const reveal = await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/${fleet.tokens.default.id}/reveal`);
      expect(reveal.statusCode).toBe(200);
      expect(reveal.headers["cache-control"]).toBe("no-store");
      expect(reveal.json()).toEqual({ token: { id: fleet.tokens.default.id, kind: "default", bearer: expect.any(String), expiresAt: null } });
      expect(calls.at(-1)?.args[3]).toEqual({ id: person.userId, email: person.email });

      const revokePath = `${fleetPath(organizationId, fleetId)}/tokens/${fleet.tokens.default.id}/revoke`;
      const revoke = await send(person, "POST", revokePath);
      expect(revoke.statusCode).toBe(200);
      const revokedAt = revoke.json<{ token: TokenBody }>().token.revokedAt;
      expect(revokedAt).not.toBeNull();
      expect(revoke.headers["cache-control"]).toBeUndefined();
      // Again: the token as it is, and a second row (the person's request).
      const again = await send(person, "POST", revokePath);
      expect(again.json<{ token: TokenBody }>().token.revokedAt).toBe(revokedAt);
      expectRefusal(
        await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/${fleet.tokens.default.id}/reveal`),
        409,
        "enrollment_token_revoked",
      );

      const subject = { actorUserId: person.userId, actorEmail: person.email, subjectType: "enrollment_token" };
      expect((await auditRows(organizationId)).slice(1)).toEqual([
        { action: "enrollment_token.rotated", ...subject, subjectId: rotated.id, metadata: { fleetId, tokenId: rotated.id, predecessorId: fleet.tokens.rotate.id } },
        { action: "enrollment_token.revealed", ...subject, subjectId: fleet.tokens.default.id, metadata: { fleetId, tokenId: fleet.tokens.default.id, kind: "default" } },
        { action: "enrollment_token.revoked", ...subject, subjectId: fleet.tokens.default.id, metadata: { fleetId, tokenId: fleet.tokens.default.id } },
        { action: "enrollment_token.revoked", ...subject, subjectId: fleet.tokens.default.id, metadata: { fleetId, tokenId: fleet.tokens.default.id } },
      ]);
    });
  });

  describe.each(["admin", "contributor"] as const)("a new default token, for a %s (D17c-1 decisions 29 and 45)", (role) => {
    it("answers 409 enrollment_token_default_exists while the default token is valid; once it is revoked, 201 no-store with the reveal's shape, audited enrollment_token.issued with ids only", async () => {
      const { organizationId, admin, contributor } = await team();
      const person = role === "admin" ? admin : contributor;
      const fleet = await created(admin, organizationId);
      const fleetId = fleet.fleet.id;
      const issuePath = `${fleetPath(organizationId, fleetId)}/tokens/default`;

      const exists = await send(person, "POST", issuePath);
      expectRefusal(exists, 409, "enrollment_token_default_exists", "The fleet already has a valid default token.");
      expect(exists.headers["cache-control"]).toBeUndefined();
      expect(await auditRows(organizationId)).toHaveLength(1);

      expect((await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/${fleet.tokens.default.id}/revoke`)).statusCode).toBe(200);
      calls = [];
      const issued = await send(person, "POST", issuePath);
      expect(issued.statusCode).toBe(201);
      expect(issued.headers["cache-control"]).toBe("no-store");
      const token = issued.json<{ token: { id: string; kind: string; bearer: string; expiresAt: null } }>().token;
      expect(issued.json()).toEqual({ token: { id: expect.any(String), kind: "default", bearer: expect.any(String), expiresAt: null } });
      expect(token.id).not.toBe(fleet.tokens.default.id);
      // The actor is the session's person.
      expect(calls).toEqual([{ operation: "issueDefaultEnrollmentToken", args: [organizationId, fleetId, { id: person.userId, email: person.email }] }]);

      // The new token is listed beside the revoked one, and revealing it answers it again.
      const listed = (await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens`)).json<{ tokens: TokenBody[] }>().tokens;
      expect(listed.filter((t) => t.kind === "default").map((t) => [t.id, t.revokedAt === null]).sort()).toEqual(
        [
          [fleet.tokens.default.id, false],
          [token.id, true],
        ].sort(),
      );
      expect((await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/${token.id}/reveal`)).statusCode).toBe(200);
      expectRefusal(await send(person, "POST", issuePath), 409, "enrollment_token_default_exists");

      const subject = { actorUserId: person.userId, actorEmail: person.email, subjectType: "enrollment_token" };
      expect((await auditRows(organizationId)).slice(1, 3)).toEqual([
        { action: "enrollment_token.revoked", ...subject, subjectId: fleet.tokens.default.id, metadata: { fleetId, tokenId: fleet.tokens.default.id } },
        { action: "enrollment_token.issued", ...subject, subjectId: token.id, metadata: { fleetId, tokenId: token.id } },
      ]);
      expect(await auditText(organizationId)).not.toContain(token.bearer);
      expectNotLogged(token.bearer);
    });

    it("refuses an archived fleet's new default token 409 fleet_archived, auditing nothing", async () => {
      const { organizationId, admin, contributor } = await team();
      const person = role === "admin" ? admin : contributor;
      const fleet = await created(admin, organizationId);
      const fleetId = fleet.fleet.id;
      expect((await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/${fleet.tokens.default.id}/revoke`)).statusCode).toBe(200);
      expect((await send(person, "PATCH", fleetPath(organizationId, fleetId), { status: "archived" })).statusCode).toBe(200);
      const before = await auditRows(organizationId);

      expectRefusal(await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/default`), 409, "fleet_archived", "This fleet is archived.");
      expect(await auditRows(organizationId)).toEqual(before);
    });
  });

  describe.each(["admin", "contributor"] as const)("the token history, for a %s (D17b-2 decision 20)", (role) => {
    it("pages the fleet's token events newest first, each actor as {userId, email}, no bearer, not no-store; a cursor the opamp-server refuses 400", async () => {
      const { organizationId, admin, contributor } = await team();
      const person = role === "admin" ? admin : contributor;
      const fleet = await created(admin, organizationId);
      const fleetId = fleet.fleet.id;
      const reveal = await send(person, "POST", `${fleetPath(organizationId, fleetId)}/tokens/${fleet.tokens.default.id}/reveal`);
      const bearer = reveal.json<{ token: { bearer: string } }>().token.bearer;
      calls = [];

      const history = await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens/events`);
      expect(history.statusCode).toBe(200);
      expect(history.headers["cache-control"]).toBeUndefined();
      expect(history.body).not.toContain(bearer);
      expect(history.body).not.toContain(fleet.tokens.default.bearer);
      const page = history.json<{ events: { event: string; tokenId: string; actor: unknown }[]; nextCursor: string | null }>();
      expect(page.nextCursor).toBeNull();
      expect(page.events[0]).toEqual({
        id: expect.any(String),
        tokenId: fleet.tokens.default.id,
        event: "viewed",
        actor: { userId: person.userId, email: person.email },
        occurredAt: expect.any(String),
      });
      expect(page.events.slice(1).map((e) => [e.event, e.actor])).toEqual([
        ["issued", { userId: admin.userId, email: admin.email }],
        ["issued", { userId: admin.userId, email: admin.email }],
      ]);
      expect(operations()).toEqual(["listEnrollmentTokenEvents"]);
      expect(calls[0]?.args).toEqual([organizationId, fleetId, { limit: 50 }]);

      const first = await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens/events?limit=1`);
      const cursor = first.json<{ nextCursor: string }>().nextCursor;
      expect(cursor).toEqual(expect.any(String));
      const next = await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens/events?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(next.json<{ events: unknown[]; nextCursor: null }>()).toMatchObject({ nextCursor: null });
      expect(next.json<{ events: unknown[] }>().events).toHaveLength(2);
      const bogus = await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens/events?cursor=bogus`);
      expectRefusal(bogus, 400, "invalid_request", "The list's cursor isn't valid: reload the list.");
      expect(detailPaths(bogus)).toEqual(["/cursor"]);
      expect(opamp.fake.takeViolations()).toEqual([]);
    });

    // Task 1's review (Ruling 19): service.ts answers an invalid answer to a cursor 400, any other the one 503.
    it("answers the opamp-server's invalid_request 503 when no cursor was sent, logged at error with the code only; 400 on /cursor when one was", async () => {
      const { organizationId, admin, contributor } = await team();
      const person = role === "admin" ? admin : contributor;
      const fleetId = (await created(admin, organizationId)).fleet.id;
      logLines = [];
      hooks.listEnrollmentTokenEvents = async () => ({ kind: "invalid", code: "invalid_request" });

      expectRefusal(
        await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens/events?limit=10`),
        503,
        "fleets_unavailable",
        FLEETS_UNAVAILABLE_MESSAGE,
      );
      expect(logged().filter((line) => line.operation === "listEnrollmentTokenEvents")).toEqual([
        expect.objectContaining({ level: 50, organizationId, fleetId, result: "invalid", code: "invalid_request" }),
      ]);

      logLines = [];
      const withCursor = await send(person, "GET", `${fleetPath(organizationId, fleetId)}/tokens/events?cursor=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
      expectRefusal(withCursor, 400, "invalid_request", "The list's cursor isn't valid: reload the list.");
      expect(detailPaths(withCursor)).toEqual(["/cursor"]);
      expect(logged().filter((line) => line.operation === "listEnrollmentTokenEvents")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("a fleet's create (decision 15; Preflight ruling 13)", () => {
    it("answers a retry with the same id, label and type 200 with the fleet alone, no-store, auditing nothing more", async () => {
      const { organizationId, admin } = await team();
      const id = randomUUID();
      const first = await created(admin, organizationId, { id, label: "edge-prod" });

      const retry = await send(admin, "POST", fleetsPath(organizationId), { id, label: "edge-prod", type: "server", rotateExpiresAt: null });
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["cache-control"]).toBe("no-store");
      expect(retry.json()).toEqual({ fleet: first.fleet });
      expect(retry.body).not.toContain("bearer");
      expect((opamp.fake.snapshotOf(organizationId) as { fleets: unknown[] }).fleets).toHaveLength(1);
      expect((await auditRows(organizationId)).map((row) => row.action)).toEqual(["fleet.created"]);

      // The same id with another label or type is another fleet's.
      expectRefusal(
        await send(admin, "POST", fleetsPath(organizationId), { id, label: "other", type: "server", rotateExpiresAt: null }),
        409,
        "fleet_conflict",
      );
    });

    it("makes an id of its own without one, and registers the organization under its current name", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      expect(fleet.fleet.id).toMatch(/^[0-9a-f-]{36}$/);
      const name = (await ownerDb.selectFrom("organizations").select("name").where("id", "=", organizationId).executeTakeFirstOrThrow()).name;
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: { name } });

      // Renamed in the platform without the hook: the next create renames it there.
      await ownerDb.updateTable("organizations").set({ name: "renamed-quietly" }).where("id", "=", organizationId).execute();
      await created(admin, organizationId);
      expect(operations().slice(-3)).toEqual(["createOrganization", "renameOrganization", "createFleet"]);
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: { name: "renamed-quietly" } });
    });

    it("refuses a rotate expiry not after the platform's clock 400 invalid_request, calling nothing; the opamp-server's own refusal too", async () => {
      const { organizationId, admin } = await team();
      for (const rotateExpiresAt of [clock.toISOString(), new Date(clock.getTime() - 1).toISOString(), "0001-01-01T00:00:00Z"]) {
        const refused = await send(admin, "POST", fleetsPath(organizationId), { label: "a", type: "server", rotateExpiresAt });
        expectRefusal(refused, 400, "invalid_request", "rotateExpiresAt must be a time in the future.");
        expect(detailPaths(refused)).toEqual(["/rotateExpiresAt"]);
      }
      expect(calls).toEqual([]);

      // Clock skew: the opamp-server's clock is ahead of the platform's.
      hooks.createFleet = async () => ({ kind: "invalid", code: "invalid_request" });
      const skewed = await send(admin, "POST", fleetsPath(organizationId), { label: "a", type: "server", rotateExpiresAt: tomorrow() });
      expectRefusal(skewed, 400, "invalid_request", "rotateExpiresAt must be a time in the future.");
      expect(detailPaths(skewed)).toEqual(["/rotateExpiresAt"]);
    });

    it("refuses a body the contract refuses 400 invalid_request, calling nothing: an edge space, an actor, an organization", async () => {
      const { organizationId, admin } = await team();
      for (const payload of [
        { label: " edge", type: "server", rotateExpiresAt: null },
        { label: "edge", type: "server", rotateExpiresAt: null, actor: { id: randomUUID(), email: "x@example.com" } },
        { label: "edge", type: "server", rotateExpiresAt: null, organizationId: randomUUID() },
        { label: "a".repeat(81), type: "server", rotateExpiresAt: null },
      ]) {
        expectRefusal(await send(admin, "POST", fleetsPath(organizationId), payload), 400, "invalid_request");
      }
      expect(calls).toEqual([]);
    });

    it("answers another of the organization's fleets' label 409 fleet_label_taken, on a create and a rename", async () => {
      const { organizationId, admin } = await team();
      await created(admin, organizationId, { label: "edge-prod" });
      const other = await created(admin, organizationId, { label: "edge-dev" });
      expectRefusal(
        await send(admin, "POST", fleetsPath(organizationId), { label: "edge-prod", type: "server", rotateExpiresAt: null }),
        409,
        "fleet_label_taken",
        "Another of the organization's fleets has this label.",
      );
      expectRefusal(await send(admin, "PATCH", fleetPath(organizationId, other.fleet.id), { label: "edge-prod" }), 409, "fleet_label_taken");
    });

    it("answers 404 organization_not_found when its organization was deleted while it ran, and deletes it in the opamp-server again (the re-check finds it gone)", async () => {
      const { organizationId, admin } = await team();
      const gate = createGate();
      hooks.createOrganization = async (...args: unknown[]) => {
        await gate.hold();
        return opamp.client.createOrganization(...(args as Parameters<OpampServerClient["createOrganization"]>));
      };
      const creating = send(admin, "POST", fleetsPath(organizationId), { label: "edge-prod", type: "server", rotateExpiresAt: null });
      await gate.reached;

      // The organization's delete commits, and its DELETE lands (the
      // organization was registered once before, by an earlier publish say).
      await opamp.client.createOrganization({ id: organizationId, name: "registered-earlier" });
      expect((await send(admin, "DELETE", `/api/v1/organizations/${organizationId}`)).statusCode).toBe(204);
      await runner.settle();
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null });

      // The create goes on: its ensure registers the organization again, its fleet is created, and the re-check finds the organization gone.
      gate.release();
      const response = await creating;
      expectRefusal(response, 404, "organization_not_found", MESSAGES.organizationNotFound);
      expect(response.body).not.toContain("bearer");
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: { id: organizationId }, fleets: [{ label: "edge-prod" }] });

      // The delete hook ran again: after the response, it removes the organization and its fleet.
      await runner.settle();
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null, fleets: [], tokens: [] });
      expect((await auditRows(organizationId)).map((row) => row.action)).toEqual([]);
      expect(logged().some((line) => line.msg === "the organization was deleted while its fleet was created: it is deleted in the opamp-server again" && line.organizationId === organizationId)).toBe(true);
    });

    it("re-checks a retry's 200 too: its organization deleted while the retry ran answers 404 organization_not_found, and deletes it in the opamp-server again", async () => {
      const { organizationId, admin } = await team();
      const id = randomUUID();
      await created(admin, organizationId, { id, label: "edge-prod" });

      // The retry's create reaches the opamp-server, which answers it
      // unchanged; its answer is held while the organization is deleted.
      const gate = createGate();
      hooks.createFleet = async (...args: unknown[]) => {
        const result = await opamp.client.createFleet(...(args as Parameters<OpampServerClient["createFleet"]>));
        await gate.hold();
        return result;
      };
      const retrying = send(admin, "POST", fleetsPath(organizationId), { id, label: "edge-prod", type: "server", rotateExpiresAt: null });
      await gate.reached;
      expect((await send(admin, "DELETE", `/api/v1/organizations/${organizationId}`)).statusCode).toBe(204);
      await runner.settle();
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null, fleets: [] });
      const deletesBefore = operations().filter((operation) => operation === "deleteOrganization").length;
      expect(deletesBefore).toBe(1);

      gate.release();
      const response = await retrying;
      expectRefusal(response, 404, "organization_not_found", MESSAGES.organizationNotFound);
      expect(response.body).not.toContain(id);
      expect(calls.filter((call) => call.operation === "createFleet").at(-1)?.args[1]).toMatchObject({ id });

      // The delete hook ran again after the response.
      await runner.settle();
      expect(operations().filter((operation) => operation === "deleteOrganization")).toHaveLength(deletesBefore + 1);
      expect(calls.filter((call) => call.operation === "deleteOrganization").map((call) => call.args[0])).toEqual([organizationId, organizationId]);
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null, fleets: [] });
      expect((await auditRows(organizationId)).map((row) => row.action)).toEqual(["fleet.created"]);
      expect(
        logged().some(
          (line) =>
            line.msg === "the organization was deleted while its fleet was created: it is deleted in the opamp-server again" &&
            line.organizationId === organizationId &&
            line.fleetId === id,
        ),
      ).toBe(true);
    });

    // The hang guard: each wait below gives up well before the test's own
    // timeout, so a failure runs the clean-up (the lock released, the
    // requests settled, the trigger dropped) before the next test starts.
    it("answers 201 when the re-check holds the organization first: the delete waits for it, then its DELETE removes the fleet", { timeout: 20_000 }, async () => {
      const { organizationId, admin } = await team();
      const LOCK = 4_216_016;
      // The re-check's transaction, holding the organization `for share`,
      // waits in the audit row's insert until the test lets it go, or gives
      // up after its lock_timeout should the test never let it.
      await withFailingInsert(
        ownerDb,
        "audit_events",
        `if new.action = 'fleet.created' then set local lock_timeout = '5s'; perform pg_advisory_xact_lock(${LOCK}); end if; return new`,
        async () => {
          // The test's own session holds the lock until `unlock`, and gives it back whatever happens.
          const unlock = createGate();
          let locked!: () => void;
          const isLocked = new Promise<void>((resolve) => (locked = resolve));
          const holder = ownerDb.connection().execute(async (connection) => {
            await sql`select pg_advisory_lock(${LOCK})`.execute(connection);
            try {
              locked();
              await unlock.hold();
            } finally {
              await sql`select pg_advisory_unlock(${LOCK})`.execute(connection);
            }
          });
          const requests: Promise<LightMyRequestResponse>[] = [];

          const waiting = async (condition: string) => {
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline) {
              const { rows } = await sql<{ count: string }>`select count(*)::text as count from pg_stat_activity where datname = current_database() and ${sql.raw(condition)}`.execute(ownerDb);
              if (Number(rows[0]?.count) > 0) return;
            }
            throw new Error(`nothing waited: ${condition}`);
          };

          try {
            await Promise.race([isLocked, holder.then(() => Promise.reject(new Error("the lock's holder ended before locking")))]);
            const creating = send(admin, "POST", fleetsPath(organizationId), { label: "edge-prod", type: "server", rotateExpiresAt: null });
            requests.push(creating);
            await waiting("wait_event_type = 'Lock' and wait_event = 'advisory'");
            const deleting = send(admin, "DELETE", `/api/v1/organizations/${organizationId}`);
            requests.push(deleting);
            await waiting("wait_event_type = 'Lock' and wait_event in ('transactionid', 'tuple')");

            unlock.release();
            const response = await creating;
            expect(response.statusCode).toBe(201);
            expect((await deleting).statusCode).toBe(204);
          } finally {
            unlock.release();
            await holder;
            await Promise.allSettled(requests);
          }
        },
      );
      expect((await auditRows(organizationId)).map((row) => row.action)).toEqual(["fleet.created"]);
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: { id: organizationId }, fleets: [{ label: "edge-prod" }] });
      // The delete's DELETE, after its response, removes the fleet with the organization.
      await runner.settle();
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null, fleets: [], tokens: [] });
    });

    it("answers 503 when the organization vanishes from the opamp-server between the ensure and the create, logged at warn (a race, not a fault)", async () => {
      const { organizationId, admin } = await team();
      hooks.createFleet = async () => ({ kind: "organization_not_found" });
      expectRefusal(
        await send(admin, "POST", fleetsPath(organizationId), { label: "a", type: "server", rotateExpiresAt: null }),
        503,
        "fleets_unavailable",
        FLEETS_UNAVAILABLE_MESSAGE,
      );
      expect(logged().filter((line) => line.operation === "createFleet")).toEqual([
        expect.objectContaining({ level: 40, organizationId, fleetId: expect.any(String), result: "organization_not_found" }),
      ]);
    });

    it("answers the opamp-server's 400 invalid_request 503 when no time was sent, logged at warn with the ids and the code only", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      logLines = [];
      hooks.createFleet = async () => ({ kind: "invalid", code: "invalid_request" });
      expectRefusal(
        await send(admin, "POST", fleetsPath(organizationId), { label: "a", type: "server", rotateExpiresAt: null }),
        503,
        "fleets_unavailable",
        FLEETS_UNAVAILABLE_MESSAGE,
      );
      expect(logged().filter((line) => line.operation === "createFleet")).toEqual([
        expect.objectContaining({ level: 40, organizationId, fleetId: expect.any(String), result: "invalid", code: "invalid_request" }),
      ]);
      // A rotation always sends its grace's end: the opamp-server's 400 is the time's.
      hooks.rotateEnrollmentToken = async () => ({ kind: "invalid", code: "invalid_request" });
      const graceRefused = await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/rotate`, { expiresAt: null, graceEndsAt: tomorrow() });
      expectRefusal(graceRefused, 400, "invalid_request", "graceEndsAt must be a time in the future.");
      expect(detailPaths(graceRefused)).toEqual(["/graceEndsAt"]);
      // With the new token's expiry sent too, either time may be the one
      // refused (the opamp-server's reply isn't passed on): both named.
      const bothRefused = await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/rotate`, {
        expiresAt: new Date(clock.getTime() + 2 * DAY).toISOString(),
        graceEndsAt: tomorrow(),
      });
      expectRefusal(bothRefused, 400, "invalid_request", "expiresAt and graceEndsAt must be times in the future.");
      expect(detailPaths(bothRefused)).toEqual(["/expiresAt", "/graceEndsAt"]);
      // A 413 is never the person's: the one 503, logged at error.
      hooks.createFleet = async () => ({ kind: "invalid", code: "payload_too_large" });
      expectRefusal(
        await send(admin, "POST", fleetsPath(organizationId), { label: "a", type: "server", rotateExpiresAt: tomorrow() }),
        503,
        "fleets_unavailable",
      );
      expect(logged().filter((line) => line.operation === "createFleet").at(-1)).toMatchObject({ level: 50, code: "payload_too_large" });
    });

    it("refuses a time Go's RFC 3339 refuses 400 invalid_request before any call: an offset without its colon, or past 23:59, or no seconds", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      calls = [];
      const day = new Date(clock.getTime() + 2 * DAY).toISOString().slice(0, 19);
      const minute = day.slice(0, 16);
      const times = [...["+0530", "+99:00", "+24:00", "-23:60"].map((offset) => `${day}${offset}`), `${minute}Z`, `${minute}+05:30`];
      for (const time of times) {
        expectRefusal(
          await send(admin, "POST", fleetsPath(organizationId), { label: "a", type: "server", rotateExpiresAt: time }),
          400,
          "invalid_request",
        );
        const rotate = `${fleetPath(organizationId, fleet.fleet.id)}/tokens/rotate`;
        expectRefusal(await send(admin, "POST", rotate, { expiresAt: time, graceEndsAt: tomorrow() }), 400, "invalid_request");
        expectRefusal(await send(admin, "POST", rotate, { expiresAt: null, graceEndsAt: time }), 400, "invalid_request");
      }
      expect(calls).toEqual([]);
      // An offset Go takes is a time like any other.
      expect((await send(admin, "POST", fleetsPath(organizationId), { label: "b", type: "server", rotateExpiresAt: `${day}+05:30` })).statusCode).toBe(201);
    });
  });

  // -------------------------------------------------------------------------

  describe("the refusals that are the person's to fix (Preflight ruling 8)", () => {
    it("answers a fleet the organization doesn't hold 404 fleet_not_found on every fleet route, and a token it doesn't 404 enrollment_token_not_found", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      const unknown = randomUUID();
      for (const [method, url, payload] of fleetRoutes(organizationId, unknown, randomUUID())) {
        expectRefusal(await send(admin, method, url, payload), 404, "fleet_not_found", MESSAGES.fleetNotFound);
      }
      for (const action of ["reveal", "revoke"]) {
        expectRefusal(
          await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/${randomUUID()}/${action}`),
          404,
          "enrollment_token_not_found",
          MESSAGES.tokenNotFound,
        );
      }
    });

    it("answers an organization the opamp-server doesn't know as one with no fleets: an empty list, fleet_not_found", async () => {
      const { organizationId, admin } = await team();
      expect((await send(admin, "GET", fleetsPath(organizationId))).json()).toEqual({ fleets: [], nextCursor: null });
      expectRefusal(await send(admin, "GET", fleetPath(organizationId, randomUUID())), 404, "fleet_not_found");
      expectRefusal(await send(admin, "GET", `${fleetPath(organizationId, randomUUID())}/tokens`), 404, "fleet_not_found");
      // Nothing registers it but a create.
      expect(operations()).not.toContain("createOrganization");
      expect(opamp.fake.snapshotOf(organizationId)).toMatchObject({ organization: null });
    });

    it("pages the list by cursor, and answers a cursor the opamp-server didn't give 400 invalid_request", async () => {
      const { organizationId, admin } = await team();
      for (let n = 0; n < 3; n++) await created(admin, organizationId);
      const first = await send(admin, "GET", `${fleetsPath(organizationId)}?limit=2`);
      const page = first.json<{ fleets: FleetBody[]; nextCursor: string }>();
      expect(page.fleets).toHaveLength(2);
      const next = await send(admin, "GET", `${fleetsPath(organizationId)}?limit=2&cursor=${page.nextCursor}`);
      expect(next.json<{ fleets: FleetBody[]; nextCursor: null }>()).toMatchObject({ nextCursor: null });
      expect(next.json<{ fleets: FleetBody[] }>().fleets).toHaveLength(1);
      const bogus = await send(admin, "GET", `${fleetsPath(organizationId)}?cursor=bogus`);
      expectRefusal(bogus, 400, "invalid_request", "The list's cursor isn't valid: reload the list.");
      expect(detailPaths(bogus)).toEqual(["/cursor"]);
      expect(opamp.fake.takeViolations()).toEqual([]);
    });

    it("refuses rotating an archived fleet's token 409 fleet_archived, and an expired token's reveal 409 enrollment_token_expired", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      await send(admin, "PATCH", fleetPath(organizationId, fleet.fleet.id), { status: "archived" });
      expectRefusal(
        await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/rotate`, { expiresAt: null, graceEndsAt: tomorrow() }),
        409,
        "fleet_archived",
        "This fleet is archived.",
      );
      hooks.revealEnrollmentToken = async () => ({ kind: "enrollment_token_expired" });
      expectRefusal(
        await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/${fleet.tokens.rotate.id}/reveal`),
        409,
        "enrollment_token_expired",
        "This enrollment token has expired.",
      );
      expect((await auditRows(organizationId)).map((row) => row.action)).toEqual(["fleet.created", "fleet.updated"]);
    });

    it("refuses a rotation's grace not after the platform's clock, or after the new token's expiry, 400, calling nothing", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      calls = [];
      const rotate = `${fleetPath(organizationId, fleet.fleet.id)}/tokens/rotate`;
      const past = await send(admin, "POST", rotate, { expiresAt: null, graceEndsAt: clock.toISOString() });
      expectRefusal(past, 400, "invalid_request", "graceEndsAt must be a time in the future.");
      expect(detailPaths(past)).toEqual(["/graceEndsAt"]);
      const afterExpiry = await send(admin, "POST", rotate, { expiresAt: tomorrow(), graceEndsAt: new Date(clock.getTime() + 2 * DAY).toISOString() });
      expectRefusal(afterExpiry, 400, "invalid_request", "graceEndsAt must not be after expiresAt.");
      expect(detailPaths(afterExpiry)).toEqual(["/graceEndsAt"]);
      // The contract's own 400 (expiresAt missing): its details in the same shape, so a client reads both alike.
      const contracts = await send(admin, "POST", rotate, { graceEndsAt: tomorrow() });
      expectRefusal(contracts, 400, "invalid_request");
      expect(detailPaths(contracts)).toEqual(["/expiresAt"]);
      type Detail = { params: { issue: Record<string, unknown> } } & Record<string, unknown>;
      const [theirs] = contracts.json<{ error: { details: Detail[] } }>().error.details;
      const [ours] = afterExpiry.json<{ error: { details: Detail[] } }>().error.details;
      expect(Object.keys(ours as Detail).sort()).toEqual(Object.keys(theirs as Detail).sort());
      expect(ours).toEqual({
        keyword: "custom",
        instancePath: "/graceEndsAt",
        schemaPath: "#/graceEndsAt/custom",
        params: { issue: { code: "custom", path: ["graceEndsAt"], message: "Must not be after expiresAt." } },
        message: "Must not be after expiresAt.",
      });
      for (const key of ["code", "path", "message"]) expect(theirs?.params.issue).toHaveProperty(key);
      expect(calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  /** Every fleet route's request naming the fleet and the token, with a valid body. */
  function fleetRoutes(organizationId: string, fleetId: string, tokenId: string) {
    const fleet = fleetPath(organizationId, fleetId);
    return [
      ["GET", fleet, undefined],
      ["PATCH", fleet, { label: "renamed" }],
      ["DELETE", fleet, undefined],
      ["GET", `${fleet}/tokens`, undefined],
      ["GET", `${fleet}/tokens/events`, undefined],
      ["POST", `${fleet}/tokens/rotate`, { expiresAt: null, graceEndsAt: tomorrow() }],
      ["POST", `${fleet}/tokens/default`, undefined],
      ["POST", `${fleet}/tokens/${tokenId}/reveal`, undefined],
      ["POST", `${fleet}/tokens/${tokenId}/revoke`, undefined],
    ] as const satisfies readonly (readonly ["GET" | "POST" | "PATCH" | "DELETE", string, Record<string, unknown> | undefined])[];
  }

  /** Every route, the list and the create included. */
  function allRoutes(organizationId: string, fleetId: string, tokenId: string) {
    return [
      ["GET", fleetsPath(organizationId), undefined],
      ["POST", fleetsPath(organizationId), { label: "edge", type: "server", rotateExpiresAt: null }],
      ...fleetRoutes(organizationId, fleetId, tokenId),
    ] as const;
  }

  describe("tenancy (decisions 4 and 5)", () => {
    it("answers another organization's fleet and token ids 404, changing nothing of theirs", async () => {
      const mine = await team();
      const theirs = await team();
      const ours = await created(mine.admin, mine.organizationId);
      const their = await created(theirs.admin, theirs.organizationId);
      const before = opamp.fake.snapshotOf(theirs.organizationId);
      const beforeAudit = await auditRows(theirs.organizationId);
      calls = [];

      for (const person of [mine.admin, mine.contributor]) {
        // Their fleet, under my organization.
        for (const [method, url, payload] of fleetRoutes(mine.organizationId, their.fleet.id, their.tokens.default.id)) {
          expectRefusal(await send(person, method, url, payload), 404, "fleet_not_found");
        }
        // Their tokens, under my fleet.
        for (const action of ["reveal", "revoke"]) {
          expectRefusal(
            await send(person, "POST", `${fleetPath(mine.organizationId, ours.fleet.id)}/tokens/${their.tokens.default.id}/${action}`),
            404,
            "enrollment_token_not_found",
          );
        }
        // A create with their fleet's id.
        expectRefusal(
          await send(person, "POST", fleetsPath(mine.organizationId), { id: their.fleet.id, label: their.fleet.label, type: "server", rotateExpiresAt: null }),
          409,
          "fleet_conflict",
        );
      }
      expect(opamp.fake.snapshotOf(theirs.organizationId)).toEqual(before);
      expect(await auditRows(theirs.organizationId)).toEqual(beforeAudit);
      // Every call named my organization.
      expect(calls.every((call) => call.args[0] === mine.organizationId || (call.args[0] as { id?: string }).id === mine.organizationId)).toBe(true);
    });

    it("answers a path naming another organization 404 organization_not_found on every route, calling nothing", async () => {
      const mine = await team();
      const theirs = await team();
      const their = await created(theirs.admin, theirs.organizationId);
      const before = opamp.fake.snapshotOf(theirs.organizationId);
      calls = [];
      for (const [method, url, payload] of allRoutes(theirs.organizationId, their.fleet.id, their.tokens.default.id)) {
        expectRefusal(await send(mine.admin, method, url, payload), 404, "organization_not_found", MESSAGES.organizationNotFound);
      }
      expect(calls).toEqual([]);
      expect(opamp.fake.snapshotOf(theirs.organizationId)).toEqual(before);
    });

    it("answers a non-member 404 organization_not_found on every route, calling nothing", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      const account = await verifiedUser();
      const outsider = { access: await signedIn(server, account.user.email) };
      calls = [];
      for (const [method, url, payload] of allRoutes(organizationId, fleet.fleet.id, fleet.tokens.default.id)) {
        expectRefusal(await send(outsider, method, url, payload), 404, "organization_not_found");
      }
      expect(calls).toEqual([]);
    });

    it("answers a malformed fleet id 404 fleet_not_found and a malformed token id 404 enrollment_token_not_found, calling nothing", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      calls = [];
      for (const malformed of MALFORMED_PATH_IDS) {
        for (const [method, url, payload] of fleetRoutes(organizationId, malformed, fleet.tokens.default.id)) {
          expectRefusal(await send(admin, method, url, payload), 404, "fleet_not_found");
        }
        for (const action of ["reveal", "revoke"]) {
          expectRefusal(
            await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/${malformed}/${action}`),
            404,
            "enrollment_token_not_found",
          );
        }
      }
      expect(calls).toEqual([]);
    });

    it("refuses a person who hasn't accepted the current terms 403 terms_acceptance_required on every route, calling nothing", async () => {
      const account = await verifiedUser({ user: { accepted_terms_version: "2025-01-01" } });
      const person = { access: await signedIn(server, account.user.email) };
      for (const [method, url, payload] of allRoutes(account.organization.id, randomUUID(), randomUUID())) {
        expectRefusal(await send(person, method, url, payload), 403, "terms_acceptance_required", MESSAGES.terms);
      }
      expect(calls).toEqual([]);
    });

    it("refuses a signed-out request 401 on every route, calling nothing", async () => {
      for (const [method, url, payload] of allRoutes(randomUUID(), randomUUID(), randomUUID())) {
        expectRefusal(await send(undefined, method, url, payload), 401, "unauthenticated");
      }
      expect(calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  // D17a decision 17: the fleet's reads pass the opamp-server's last seen
  // and rotate token state through, copied field by field.
  describe("a fleet's summary", () => {
    it("answers the latest last seen and the rotate token's state in the list and the read, through a rotation and its revokes", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId, { rotateExpiresAt: tomorrow() });
      const fleetId = fleet.fleet.id;
      const summaries = async () => {
        const list = await send(admin, "GET", fleetsPath(organizationId));
        const read = await send(admin, "GET", fleetPath(organizationId, fleetId));
        expect([list.statusCode, read.statusCode]).toEqual([200, 200]);
        const listed = list.json<{ fleets: FleetBody[] }>().fleets.find((f) => f.id === fleetId)?.summary;
        expect(read.json<{ fleet: FleetBody }>().fleet.summary).toEqual(listed);
        return listed;
      };

      expect(await summaries()).toMatchObject({ lastSeenAt: null, rotateToken: { expiresAt: tomorrow(), graceEndsAt: null, validCount: 1 } });

      const seen = new Date(clock.getTime() - 60_000);
      opamp.fake.enrollCollector(organizationId, fleetId, { lastSeenAt: seen });
      opamp.fake.enrollCollector(organizationId, fleetId, { lastSeenAt: new Date(clock.getTime() - 120_000) });
      expect(await summaries()).toMatchObject({ collectors: 2, lastSeenAt: seen.toISOString() });

      const rotate = await send(admin, "POST", `${fleetPath(organizationId, fleetId)}/tokens/rotate`, { expiresAt: null, graceEndsAt: tomorrow() });
      expect(rotate.statusCode).toBe(201);
      expect((await summaries())?.rotateToken).toEqual({ expiresAt: null, graceEndsAt: tomorrow(), validCount: 2 });

      const revoke = (tokenId: string) => send(admin, "POST", `${fleetPath(organizationId, fleetId)}/tokens/${tokenId}/revoke`);
      expect((await revoke(rotate.json<{ token: { id: string } }>().token.id)).statusCode).toBe(200);
      expect((await summaries())?.rotateToken).toEqual({ expiresAt: tomorrow(), graceEndsAt: null, validCount: 1 });
      expect((await revoke(fleet.tokens.rotate.id)).statusCode).toBe(200);
      expect(await summaries()).toEqual({
        collectors: 2,
        online: 0,
        warning: 1,
        unknown: 1,
        offline: 0,
        inSync: 0,
        pending: 0,
        failed: 0,
        drifted: 0,
        unassigned: 2,
        lastSeenAt: seen.toISOString(),
        rotateToken: null,
      });
    });

    it.each(["lastSeenAt", "rotateToken"])("answers 503 when the opamp-server's summary lacks %s: the client refuses it", async (field) => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      const strip = (f: { summary: Record<string, unknown> }) => {
        const { [field]: _dropped, ...summary } = f.summary;
        return { ...f, summary };
      };
      const stripping = createOpampServerClient({
        url: opamp.fake.url,
        secret: opamp.fake.secret,
        fetch: async (url, init) => {
          const reply = await fetch(url, init);
          const body = (await reply.json()) as { fleets?: { summary: Record<string, unknown> }[]; summary: Record<string, unknown> };
          const changed = body.fleets === undefined ? strip(body) : { ...body, fleets: body.fleets.map(strip) };
          return new Response(JSON.stringify(changed), { status: reply.status, headers: { "content-type": "application/json" } });
        },
      });
      hooks.listFleets = (...args: unknown[]) => stripping.listFleets(...(args as Parameters<OpampServerClient["listFleets"]>));
      hooks.getFleet = (...args: unknown[]) => stripping.getFleet(...(args as Parameters<OpampServerClient["getFleet"]>));

      expectRefusal(await send(admin, "GET", fleetsPath(organizationId)), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
      expectRefusal(await send(admin, "GET", fleetPath(organizationId, fleet.fleet.id)), 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
      expect(logged().filter((line) => line.operation === "listFleets" || line.operation === "getFleet")).toEqual([
        expect.objectContaining({ level: 50, operation: "listFleets", error: expect.stringContaining("listFleets") }),
        expect.objectContaining({ level: 50, operation: "getFleet", error: expect.stringContaining("getFleet") }),
      ]);
    });
  });

  describe("the one 503 (Preflight rulings 8 and 19)", () => {
    const ROUTE_OPERATIONS = [
      ["the list", "listFleets"],
      ["the create", "createFleet"],
      ["a read", "getFleet"],
      ["an update", "updateFleet"],
      ["a delete", "deleteFleet"],
      ["the token list", "listEnrollmentTokens"],
      ["the token history", "listEnrollmentTokenEvents"],
      ["a rotation", "rotateEnrollmentToken"],
      ["a new default token", "issueDefaultEnrollmentToken"],
      ["a reveal", "revealEnrollmentToken"],
      ["a revoke", "revokeEnrollmentToken"],
    ] as const;
    const FAULTS = ["error_500", "hang", "reset", "malformed_reply", "oversized"] as const;

    /** A client of the fake that gives up fast (a hang) or reads nothing (an oversized reply). */
    const faultyClient = (fault: (typeof FAULTS)[number]) =>
      createOpampServerClient({
        url: opamp.fake.url,
        secret: opamp.fake.secret,
        ...(fault === "hang" ? { timeoutMs: 200 } : {}),
        ...(fault === "oversized" ? { maxReplyBytes: { S: 8, M: 8, U: 8, L: 8 } } : {}),
      });

    /** The route's request for `operation`, naming the fleet and its default token. */
    function requestFor(operation: string, organizationId: string, fleet: CreatedBody) {
      const routes = allRoutes(organizationId, fleet.fleet.id, fleet.tokens.default.id);
      const index = ROUTE_OPERATIONS.findIndex(([, op]) => op === operation);
      return routes[index] as (typeof routes)[number];
    }

    describe.each(ROUTE_OPERATIONS)("%s (%s)", (_label, operation) => {
      it.each(FAULTS)("answers %s 503 fleets_unavailable with the general message, logging ids and the kind only", async (fault) => {
        const { organizationId, admin } = await team();
        const fleet = await created(admin, organizationId);
        logLines = [];
        if (fault === "oversized" && operation === "deleteFleet") {
          // A 204 has no body to be over any cap: the client's answer to an oversized one, injected.
          hooks.deleteFleet = async () => ({ kind: "unavailable", reason: "oversized_reply" });
        } else if (fault === "hang" || fault === "oversized") {
          const client = faultyClient(fault);
          hooks[operation] = (...args: unknown[]) => (client[operation] as unknown as (...given: unknown[]) => Promise<unknown>)(...args);
        }
        if (fault !== "oversized") opamp.fake.nextFault(fault as FakeOpampServerFault, operation);

        const [method, url, payload] = requestFor(operation, organizationId, fleet);
        const response = await send(admin, method, url, payload);

        expectRefusal(response, 503, "fleets_unavailable", FLEETS_UNAVAILABLE_MESSAGE);
        if (fault === "malformed_reply") expect(opamp.fake.takeViolations()).toHaveLength(1);
        const line = logged().find((entry) => entry.operation === operation);
        expect(line).toMatchObject({ operation, organizationId });
        if (fault === "malformed_reply") expect(line).toMatchObject({ level: 50, error: expect.stringContaining(operation) });
        else expect(line).toMatchObject({ level: 40, result: "unavailable" });
        expectNotLogged(opamp.fake.url, opamp.fake.secret, "127.0.0.1:", fleet.fleet.label, fleet.tokens.default.bearer);
      });
    });

    it("answers a secret the opamp-server refuses (401) 503, logged at error, never naming the secret", async () => {
      const { organizationId, admin } = await team();
      const wrong = createOpampServerClient({ url: opamp.fake.url, secret: "a-wrong-management-secret-0123456789" });
      hooks.listFleets = (...args: unknown[]) => wrong.listFleets(...(args as Parameters<OpampServerClient["listFleets"]>));
      expectRefusal(await send(admin, "GET", fleetsPath(organizationId)), 503, "fleets_unavailable");
      expect(logged().find((line) => line.operation === "listFleets")).toMatchObject({ level: 50, error: expect.stringContaining("401") });
      expectNotLogged("a-wrong-management-secret-0123456789", opamp.fake.secret);
    });

    it("answers any other throw of the client 503 fleets_unavailable, logged at error with its name only (Ruling 34)", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      const canary = `CANARY-THROWN-${randomUUID()}`;
      hooks.getFleet = async () => {
        throw new RangeError(`a message quoting ${canary}`);
      };
      logLines = [];
      expectRefusal(await send(admin, "GET", fleetPath(organizationId, fleet.fleet.id)), 503, "fleets_unavailable");
      expect(logged().filter((line) => line.operation === "getFleet")).toEqual([
        expect.objectContaining({
          level: 50,
          operation: "getFleet",
          organizationId,
          fleetId: fleet.fleet.id,
          error: "RangeError",
          msg: "fleet management failed: calling the opamp-server threw",
        }),
      ]);
      expectNotLogged(canary);
    });

    it("answers a 413, an undocumented answer and a reply naming another fleet 503", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      hooks.updateFleet = async () => ({ kind: "invalid", code: "payload_too_large" });
      expectRefusal(await send(admin, "PATCH", fleetPath(organizationId, fleet.fleet.id), { label: "x" }), 503, "fleets_unavailable");
      hooks.getFleet = async () => {
        throw new OpampServerMisconfigurationError("The opamp-server's reply to getFleet (200) named another fleet.");
      };
      expectRefusal(await send(admin, "GET", fleetPath(organizationId, fleet.fleet.id)), 503, "fleets_unavailable");
      // The person's own request: a create's ensure that fails.
      hooks.createOrganization = async () => ({ kind: "unavailable", reason: "timeout" });
      expectRefusal(
        await send(admin, "POST", fleetsPath(organizationId), { label: "y", type: "server", rotateExpiresAt: null }),
        503,
        "fleets_unavailable",
      );
      expect(logged().find((line) => line.operation === "createOrganization")).toMatchObject({ result: "unavailable", reason: "timeout" });
    });
  });

  // -------------------------------------------------------------------------

  describe("the person's limits (decision 17; Preflight ruling 12)", () => {
    let limited: FastifyInstance;

    beforeAll(async () => {
      limited = build({
        ...TEST_RATE_LIMITS,
        fleetReadsPerUser: { max: 3, windowMs: 60_000 },
        fleetWritesPerUser: { max: 2, windowMs: 60_000 },
        fleetBearerRepliesPerUser: { max: 2, windowMs: 60_000 },
      });
      await limited.ready();
    });

    afterAll(async () => {
      await limited.close();
    });

    const expectLimited = (response: LightMyRequestResponse) => {
      expectRefusal(response, 429, "rate_limited", MESSAGES.rateLimited);
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    };

    it("answers a person's reads past theirs 429 rate_limited with Retry-After, calling nothing; their refusals before a call spend nothing", async () => {
      const { organizationId, admin, contributor } = await team(limited);
      const fleet = await created(admin, organizationId, {}, limited);
      for (const malformed of MALFORMED_PATH_IDS) {
        expectRefusal(await send(admin, "GET", fleetPath(organizationId, malformed), undefined, limited), 404, "fleet_not_found");
      }
      expect((await send(admin, "GET", fleetsPath(organizationId), undefined, limited)).statusCode).toBe(200);
      expect((await send(admin, "GET", fleetPath(organizationId, fleet.fleet.id), undefined, limited)).statusCode).toBe(200);
      expect((await send(admin, "GET", `${fleetPath(organizationId, fleet.fleet.id)}/tokens`, undefined, limited)).statusCode).toBe(200);
      calls = [];
      expectLimited(await send(admin, "GET", fleetsPath(organizationId), undefined, limited));
      expect(calls).toEqual([]);
      // Their writes, and another member's reads, are their own counts.
      expect((await send(admin, "PATCH", fleetPath(organizationId, fleet.fleet.id), { label: "renamed" }, limited)).statusCode).toBe(200);
      expect((await send(contributor, "GET", fleetsPath(organizationId), undefined, limited)).statusCode).toBe(200);
    });

    it("counts the token history as a read (D17b-2 decision 20): past the person's reads it is 429, calling nothing; their writes are their own count", async () => {
      const { organizationId, admin } = await team(limited);
      const fleet = await created(admin, organizationId, {}, limited);
      const tokens = `${fleetPath(organizationId, fleet.fleet.id)}/tokens`;
      for (let read = 0; read < 3; read += 1) {
        expect((await send(admin, "GET", `${tokens}/events`, undefined, limited)).statusCode).toBe(200);
      }
      calls = [];
      expectLimited(await send(admin, "GET", `${tokens}/events`, undefined, limited));
      expectLimited(await send(admin, "GET", tokens, undefined, limited));
      expect(calls).toEqual([]);
      expect((await send(admin, "POST", `${tokens}/${fleet.tokens.rotate.id}/revoke`, undefined, limited)).statusCode).toBe(200);
    });

    it("counts nothing for a time Go's RFC 3339 refuses (the contract's 400 comes before admission)", async () => {
      const { organizationId, admin } = await team(limited);
      const fleet = await created(admin, organizationId, {}, limited);
      const day = new Date(clock.getTime() + 2 * DAY).toISOString().slice(0, 19);
      for (const offset of ["+0530", "+99:00", "+0530", "+99:00"]) {
        expectRefusal(
          await send(admin, "POST", fleetsPath(organizationId), { label: "a", type: "server", rotateExpiresAt: `${day}${offset}` }, limited),
          400,
          "invalid_request",
        );
        expectRefusal(
          await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/rotate`, { expiresAt: null, graceEndsAt: `${day}${offset}` }, limited),
          400,
          "invalid_request",
        );
      }
      // The second of the two bearer replies is still theirs; the third isn't.
      expect((await send(admin, "POST", `${fleetPath(organizationId, fleet.fleet.id)}/tokens/rotate`, { expiresAt: null, graceEndsAt: tomorrow() }, limited)).statusCode).toBe(201);
      expectLimited(await send(admin, "POST", fleetsPath(organizationId), { label: "z", type: "server", rotateExpiresAt: null }, limited));
    });

    it("counts a new default token as a bearer reply (D17c-1 decision 45), apart from the writes", async () => {
      const { organizationId, admin } = await team(limited);
      const fleet = await created(admin, organizationId, {}, limited);
      const tokens = `${fleetPath(organizationId, fleet.fleet.id)}/tokens`;
      expect((await send(admin, "POST", `${tokens}/${fleet.tokens.default.id}/revoke`, undefined, limited)).statusCode).toBe(200);
      expect((await send(admin, "POST", `${tokens}/default`, undefined, limited)).statusCode).toBe(201);
      calls = [];
      expectLimited(await send(admin, "POST", `${tokens}/default`, undefined, limited));
      expectLimited(await send(admin, "POST", `${tokens}/${fleet.tokens.rotate.id}/reveal`, undefined, limited));
      expect(calls).toEqual([]);
      expect((await send(admin, "PATCH", fleetPath(organizationId, fleet.fleet.id), { label: "renamed" }, limited)).statusCode).toBe(200);
    });

    it("counts a create, a reveal and a rotation together, apart from the writes", async () => {
      const { organizationId, admin } = await team(limited);
      const fleet = await created(admin, organizationId, {}, limited);
      const tokens = `${fleetPath(organizationId, fleet.fleet.id)}/tokens`;
      expect((await send(admin, "POST", `${tokens}/${fleet.tokens.default.id}/reveal`, undefined, limited)).statusCode).toBe(200);
      expectLimited(await send(admin, "POST", `${tokens}/rotate`, { expiresAt: null, graceEndsAt: tomorrow() }, limited));
      expectLimited(await send(admin, "POST", fleetsPath(organizationId), { label: "z", type: "server", rotateExpiresAt: null }, limited));
      expect((await send(admin, "POST", `${tokens}/${fleet.tokens.default.id}/revoke`, undefined, limited)).statusCode).toBe(200);
      expect((await send(admin, "PATCH", fleetPath(organizationId, fleet.fleet.id), { status: "archived" }, limited)).statusCode).toBe(200);
      expectLimited(await send(admin, "DELETE", fleetPath(organizationId, fleet.fleet.id), undefined, limited));
    });

    it("holds 16 of a person's requests in flight; the 17th is 429 with Retry-After 1, and once one ends another is let in", async () => {
      const { organizationId, admin, contributor } = await team();
      const fleet = await created(admin, organizationId);
      const gate = createGate();
      let held = 0;
      let allHeld!: () => void;
      const sixteenHeld = new Promise<void>((resolve) => (allHeld = resolve));
      hooks.getFleet = async (...args: unknown[]) => {
        if (++held === 16) allHeld();
        await gate.hold();
        return opamp.client.getFleet(...(args as Parameters<OpampServerClient["getFleet"]>));
      };
      const reads = Array.from({ length: 16 }, () => send(admin, "GET", fleetPath(organizationId, fleet.fleet.id)));
      await sixteenHeld;

      const refused = await send(admin, "GET", fleetsPath(organizationId));
      expectRefusal(refused, 429, "rate_limited");
      expect(refused.headers["retry-after"]).toBe("1");
      // Another person's slots are their own.
      expect((await send(contributor, "GET", fleetsPath(organizationId))).statusCode).toBe(200);

      gate.release();
      expect((await Promise.all(reads)).map((response) => response.statusCode)).toEqual(Array(16).fill(200));
      expect((await send(admin, "GET", fleetsPath(organizationId))).statusCode).toBe(200);
    });

    it("gives a request's slot back however it fails: after 14 failing at once every way, 16 are held again and the 17th is 429", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      const fleetId = fleet.fleet.id;
      const tokens = `${fleetPath(organizationId, fleetId)}/tokens`;
      expect((await send(admin, "POST", `${tokens}/${fleet.tokens.rotate.id}/revoke`)).statusCode).toBe(200);

      // Every call waits at the gate, then fails its own way.
      const failing = createGate();
      let held = 0;
      let heldAll!: () => void;
      const allHeld = new Promise<void>((resolve) => (heldAll = resolve));
      const FAILURES = 14;
      const holding = <Args extends unknown[], Result>(fail: (...args: Args) => Promise<Result>) => async (...args: Args) => {
        if (++held === FAILURES) heldAll();
        await failing.hold();
        return fail(...args);
      };
      hooks.getFleet = holding((...args: unknown[]) => opamp.client.getFleet(...(args as Parameters<OpampServerClient["getFleet"]>)));
      hooks.listFleets = holding(async () => ({ kind: "unavailable", reason: "timeout" }));
      hooks.listEnrollmentTokens = holding(async () => {
        throw new OpampServerMisconfigurationError("The opamp-server's reply to listEnrollmentTokens (200) isn't the API's.");
      });
      hooks.updateFleet = holding(async () => {
        throw new Error("a plain failure");
      });
      hooks.revealEnrollmentToken = holding((...args: unknown[]) =>
        opamp.client.revealEnrollmentToken(...(args as Parameters<OpampServerClient["revealEnrollmentToken"]>)),
      );
      hooks.createFleet = holding(async (...args: unknown[]) => {
        const [, request] = args as Parameters<OpampServerClient["createFleet"]>;
        if (request.label === "throws") throw new Error("a throwing createFleet");
        return opamp.client.createFleet(...(args as Parameters<OpampServerClient["createFleet"]>));
      });

      const FAILING = [
        [() => send(admin, "GET", fleetPath(organizationId, randomUUID())), 404, "fleet_not_found"],
        [() => send(admin, "GET", fleetsPath(organizationId)), 503, "fleets_unavailable"],
        [() => send(admin, "GET", tokens), 503, "fleets_unavailable"],
        [() => send(admin, "PATCH", fleetPath(organizationId, fleetId), { label: "renamed" }), 503, "fleets_unavailable"],
        [() => send(admin, "POST", fleetsPath(organizationId), { label: fleet.fleet.label, type: "server", rotateExpiresAt: null }), 409, "fleet_label_taken"],
        [() => send(admin, "POST", `${tokens}/${fleet.tokens.rotate.id}/reveal`), 409, "enrollment_token_revoked"],
        [() => send(admin, "POST", fleetsPath(organizationId), { label: "throws", type: "server", rotateExpiresAt: null }), 503, "fleets_unavailable"],
      ] as const;
      // Twice each: 14 requests in flight at once.
      const failures = [...FAILING, ...FAILING].map(([request, status, code]) => ({ response: request(), status, code }));
      // Any answer before all are held is a refusal (a slot short): it ends the wait instead of hanging it.
      try {
        await Promise.race([allHeld, ...failures.map(({ response }) => response)]);
        expect(held).toBe(FAILURES);
      } finally {
        failing.release();
      }
      const answers = await Promise.all(failures.map(({ response }) => response));
      expect(answers.map((response) => [response.statusCode, response.json<{ error: { code: string } }>().error.code])).toEqual(
        failures.map(({ status, code }) => [status, code]),
      );

      // Every slot came back, and none twice: 16 are held, the 17th is refused.
      hooks = {};
      const gate = createGate();
      let reading = 0;
      let readAll!: () => void;
      const sixteenHeld = new Promise<void>((resolve) => (readAll = resolve));
      hooks.getFleet = async (...args: unknown[]) => {
        if (++reading === 16) readAll();
        await gate.hold();
        return opamp.client.getFleet(...(args as Parameters<OpampServerClient["getFleet"]>));
      };
      const reads = Array.from({ length: 16 }, () => send(admin, "GET", fleetPath(organizationId, fleetId)));
      try {
        await Promise.race([sixteenHeld, ...reads]);
        expect(reading).toBe(16);
        const refused = await send(admin, "GET", fleetsPath(organizationId));
        expect(refused.statusCode).toBe(429);
        expectRefusal(refused, 429, "rate_limited");
      } finally {
        gate.release();
      }
      expect((await Promise.all(reads)).map((response) => response.statusCode)).toEqual(Array(16).fill(200));
    });
  });

  // -------------------------------------------------------------------------

  describe("audit rows (decision 18; Preflight ruling 15)", () => {
    it("lets the change stand when its audit row can't be written, logging an error with ids only", async () => {
      const { organizationId, admin } = await team();
      const fleet = await created(admin, organizationId);
      const fleetId = fleet.fleet.id;
      await withFailingInsert(
        ownerDb,
        "audit_events",
        "if new.action like 'fleet.%' or new.action like 'enrollment_token.%' then raise exception 'the audit row is refused'; end if; return new",
        async () => {
          const create = await send(admin, "POST", fleetsPath(organizationId), { label: "edge-2", type: "server", rotateExpiresAt: null });
          expect(create.statusCode).toBe(201);
          expect(create.json<CreatedBody>().tokens.default.bearer).toEqual(expect.any(String));
          const tokens = `${fleetPath(organizationId, fleetId)}/tokens`;
          expect((await send(admin, "PATCH", fleetPath(organizationId, fleetId), { label: "renamed" })).statusCode).toBe(200);
          expect((await send(admin, "POST", `${tokens}/rotate`, { expiresAt: null, graceEndsAt: tomorrow() })).statusCode).toBe(201);
          expect((await send(admin, "POST", `${tokens}/${fleet.tokens.default.id}/reveal`)).statusCode).toBe(200);
          expect((await send(admin, "POST", `${tokens}/${fleet.tokens.default.id}/revoke`)).statusCode).toBe(200);
          expect((await send(admin, "POST", `${tokens}/default`)).statusCode).toBe(201);
          expect((await send(admin, "DELETE", fleetPath(organizationId, fleetId))).statusCode).toBe(204);
        },
      );
      expect((await auditRows(organizationId)).map((row) => row.action)).toEqual(["fleet.created"]);
      const errors = logged().filter((line) => line.level === 50);
      expect(errors.map((line) => line.msg)).toEqual([
        "the fleet's create couldn't re-check its organization or write its audit row: the fleet stands",
        ...Array(6).fill("the fleet change's audit row wasn't written: the change stands"),
      ]);
      expect(errors.map((line) => line.action ?? line.operation)).toEqual([
        "createFleet",
        "fleet.updated",
        "enrollment_token.rotated",
        "enrollment_token.revealed",
        "enrollment_token.revoked",
        "enrollment_token.issued",
        "fleet.deleted",
      ]);
      expect(errors.every((line) => line.organizationId === organizationId)).toBe(true);
      expectNotLogged("edge-2", "renamed", "the audit row is refused");
    });
  });

  // -------------------------------------------------------------------------

  describe("privacy (decisions 1 and 21; Preflight ruling 16)", () => {
    it("logs no bearer and no label, and writes neither into an audit row or an error answer (canaries)", async () => {
      const { organizationId, admin } = await team();
      const label = `CANARY-LABEL-${randomUUID()}`;
      const fleet = await created(admin, organizationId, { label });
      const fleetPathOf = fleetPath(organizationId, fleet.fleet.id);
      const reveal = await send(admin, "POST", `${fleetPathOf}/tokens/${fleet.tokens.rotate.id}/reveal`);
      const rotate = await send(admin, "POST", `${fleetPathOf}/tokens/rotate`, { expiresAt: null, graceEndsAt: tomorrow() });
      await send(admin, "POST", `${fleetPathOf}/tokens/${fleet.tokens.default.id}/revoke`);
      const issued = await send(admin, "POST", `${fleetPathOf}/tokens/default`);
      expect(issued.statusCode).toBe(201);
      const renamed = `CANARY-RENAMED-${randomUUID()}`;
      await send(admin, "PATCH", fleetPathOf, { label: renamed });
      const taken = await send(admin, "POST", fleetsPath(organizationId), { label: renamed, type: "server", rotateExpiresAt: null });
      expectRefusal(taken, 409, "fleet_label_taken");
      const refused = await send(admin, "POST", fleetsPath(organizationId), { label: ` ${label}`, type: "server", rotateExpiresAt: null });
      expect(refused.statusCode).toBe(400);
      const bearers = [
        fleet.tokens.default.bearer,
        fleet.tokens.rotate.bearer,
        reveal.json<{ token: { bearer: string } }>().token.bearer,
        rotate.json<{ token: { bearer: string } }>().token.bearer,
        issued.json<{ token: { bearer: string } }>().token.bearer,
      ];

      expectNotLogged(label, renamed, ...bearers);
      const audit = await auditText(organizationId);
      for (const secret of [label, renamed, ...bearers]) expect(audit).not.toContain(secret);
      expect(audit).toContain(fleet.fleet.id);
      for (const answer of [taken, refused]) for (const secret of [label, renamed]) expect(answer.body).not.toContain(secret);
    });

    it.each([
      ["the list's cursor", (o: string) => `${fleetsPath(o)}?cursor=CANARY-CURSOR`],
      ["a token list's query", (o: string) => `${fleetPath(o, randomUUID())}/tokens?q=CANARY-Q`],
      ["a percent-encoded path", (o: string) => `/api/v1/organizations/${o}/%66leets?cursor=CANARY-ENCODED`],
      ["a trailing slash (no route)", (o: string) => `${fleetsPath(o)}/?q=CANARY-SLASH`],
      ["an encoded trailing slash", (o: string) => `/api/v1/organizations/${o}/%66leets/?q=CANARY-ENCODED-SLASH`],
      // D16b Ruling 30: a doubled slash matches no route.
      ["a doubled slash before the organizations", (o: string) => `/api/v1//organizations/${o}/fleets/${randomUUID()}/collectors?q=CANARY-DOUBLED`],
      ["a doubled slash before the fleets", (o: string) => `/api/v1/organizations/${o}//fleets/${randomUUID()}/collectors?q=CANARY-DOUBLED-FLEETS`],
      ["a doubled slash before the configurations", (o: string) => `/api/v1/organizations/${o}//configurations?q=CANARY-CONFIGURATIONS`],
    ])("logs a request under /fleets (or the configurations list) without its query: %s", async (_label, urlOf) => {
      const { organizationId, admin } = await team();
      const url = urlOf(organizationId);
      await send(admin, "GET", url);
      const requests = logged().filter((line) => line.req !== undefined);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.map((line) => (line.req as { url: string }).url)).toContain(url.slice(0, url.indexOf("?")));
      expectNotLogged("CANARY-");
      opamp.fake.takeViolations();
    });
  });
});
