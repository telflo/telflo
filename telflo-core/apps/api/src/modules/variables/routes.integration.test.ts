import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "@telflo/contracts";
import { createDb, createPool, type Database, type OrganizationRole } from "@telflo/db";
import {
  addConfiguration,
  addConfigurationVersion,
  addMembership,
  catalogueDefaults,
  createUserWithOrganization,
  truncateAll,
} from "@telflo/db/testing";
import { createInMemoryMailer } from "../../mail/in-memory-mailer.js";
import { loadSettings, type AppSettings } from "../../settings.js";
import { buildServer } from "../../server.js";
import { TEST_RATE_LIMITS, type RateLimits } from "../../http/rate-limits.js";
import { createCollectingRunner, type CollectingRunner } from "../../http/after-response.js";
import { OpampServerMisconfigurationError, sha256Hex, type OpampServerClient } from "../../opamp-server/client.js";
import type { FakeOpampServerFault } from "../../testing/fake-opamp-server.js";
import { useFakeOpampServer } from "../../testing/opamp-server.js";
import { UNCALLED_OTELCOL_VALIDATOR } from "../../testing/otelcol-validator.js";
import { UNCALLED_FILE_STORE } from "../../testing/file-store.js";
import { UNCALLED_TESTING } from "../../testing/otelcol-testing.js";
import { hashPassword } from "../identity/password.js";
import { VARIABLES_UNAVAILABLE_MESSAGE } from "./errors.js";

// The opamp-server every server needs (D11b decision 8): this file's own fake.
const opamp = useFakeOpampServer();

const csrfHeaders = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const PASSWORD = "a-sufficiently-long-password";

/** The routes' fixed words (errors.ts). */
const MESSAGES = {
  organizationNotFound: "Organization not found",
  variableNotFound: "Variable not found",
  variableGroupNotFound: "Variable group not found",
  variableNameTaken: "Another of the organization's variables has this name.",
  variableGroupNameTaken: "Another of the organization's variable groups has this name.",
  variableInUse:
    "A published version that a collector group or a collector uses references this variable: assign or pin another version first.",
  variableGroupInUse: "A collector group or a collector uses this variable group: choose another for them first.",
  variableLimit: "The organization has 150 variables, the most it may have.",
  variableGroupLimit: "The organization has 100 variable groups, the most it may have.",
  variableConflict: "A different variable already has this id.",
  variableGroupConflict: "A different variable group already has this id.",
};

/** Ids that aren't canonical UUIDs, as a path segment carries them. */
const MALFORMED_PATH_IDS = ["not-a-uuid", "42", "0192F1A47B3C7D2E8F101A2B3C4D5E6F"];

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** A variable's reference as a configuration writes it (never a template literal's `${…}`). */
const ref = (name: string) => "${org:" + name + "}";

/** An UPPER_CASE name no other test uses. */
const uniqueName = (prefix = "VAR") => `${prefix}_${randomUUID().replaceAll("-", "").toUpperCase()}`;

interface VariableBody {
  id: string;
  name: string;
  value: string;
  description: string | null;
  changedBy: { userId: string; email: string } | null;
  changedAt: string;
}

interface VariableGroupBody {
  id: string;
  name: string;
  description: string | null;
  overrideCount: number;
  usage: { collectorGroups: number; pinnedCollectors: number };
  changedBy: { userId: string; email: string } | null;
  changedAt: string;
}

/** One call the server made to the opamp-server, through the wrapper. */
interface Call {
  operation: keyof OpampServerClient;
  args: unknown[];
}

/**
 * D20 decisions 1, 6, 14, 15, 18, 21 and 37 and Preflight rulings 25 to 27,
 * 39, 44 and 46, for the variables and variable groups routes (Task 10),
 * against Postgres through the API as its own role, with the
 * OpenAPI-checked fake as the opamp-server. The server's client is the
 * fake's, wrapped: every call is recorded, and a test can put a hook in
 * front of any method.
 */
describe("the variables and variable groups routes", () => {
  let settings: AppSettings;
  let db: Kysely<Database>;
  /** The tables' owner: fixtures, truncation and reading rows back. */
  let ownerDb: Kysely<Database>;
  let server: FastifyInstance;
  let passwordHash: string;
  let clock: Date;
  /** The server's log lines since the test began, at info and above. */
  let logLines: string[] = [];
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

  /** A server on the wrapped client, its log captured at info, with `rateLimits`. */
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

  const detailsOf = <Details>(response: LightMyRequestResponse) => response.json<{ error: { details: Details } }>().error.details;

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

  const verifiedUser = () =>
    createUserWithOrganization(ownerDb, {
      user: { email: `person-${Math.random().toString(36).slice(2)}@example.com`, password_hash: passwordHash },
    });

  const signedIn = async (email: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/auth/sessions",
      headers: csrfHeaders,
      payload: { email, password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    return cookieValue(response, "telflo_access");
  };

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

  interface Person {
    userId: string;
    email: string;
    access: string;
  }

  /** A signed-in user who is a `role` of a group organization (a new one unless given) and active in it. */
  const member = async (role: OrganizationRole, organizationId?: string) => {
    const account = await verifiedUser();
    const { organization } = await addMembership(ownerDb, {
      userId: account.user.id,
      role,
      ...(organizationId === undefined ? {} : { organizationId }),
    });
    const access = await switchTo(await signedIn(account.user.email), organization.id);
    return { organizationId: organization.id, person: { userId: account.user.id, email: account.user.email, access } as Person };
  };

  /** A group organization with an admin and a contributor, both active in it. */
  const team = async () => {
    const { organizationId, person: admin } = await member("admin");
    const { person: contributor } = await member("contributor", organizationId);
    return { organizationId, admin, contributor };
  };

  const variablesPath = (organizationId: string) => `/api/v1/organizations/${organizationId}/variables`;
  const variablePath = (organizationId: string, variableId: string) => `${variablesPath(organizationId)}/${variableId}`;
  const groupsPath = (organizationId: string) => `/api/v1/organizations/${organizationId}/variable-groups`;
  const groupPath = (organizationId: string, variableGroupId: string) => `${groupsPath(organizationId)}/${variableGroupId}`;
  const overridePath = (organizationId: string, variableGroupId: string, variableId: string) =>
    `${groupPath(organizationId, variableGroupId)}/overrides/${variableId}`;
  const fleetsPath = (organizationId: string) => `/api/v1/organizations/${organizationId}/fleets`;

  const send = (person: Pick<Person, "access"> | undefined, method: Method, url: string, payload?: Record<string, unknown>, on: FastifyInstance = server) =>
    on.inject({
      method,
      url,
      headers: csrfHeaders,
      ...(person === undefined ? {} : { cookies: { telflo_access: person.access } }),
      ...(payload === undefined ? {} : { payload }),
    });

  /** A variable created through the API. */
  const aVariable = async (person: Person, organizationId: string, fields: Partial<{ id: string; name: string; value: string; description: string | null }> = {}) => {
    const response = await send(person, "POST", variablesPath(organizationId), {
      id: randomUUID(),
      name: uniqueName(),
      value: "a value",
      description: null,
      ...fields,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ variable: VariableBody }>().variable;
  };

  /** A variable group created through the API. */
  const aVariableGroup = async (person: Person, organizationId: string, fields: Partial<{ id: string; name: string; description: string | null }> = {}) => {
    const response = await send(person, "POST", groupsPath(organizationId), {
      id: randomUUID(),
      name: `group ${randomUUID()}`,
      description: null,
      ...fields,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ variableGroup: VariableGroupBody }>().variableGroup;
  };

  let labels = 0;

  /** A fleet created through the API: its id and its Default group's. */
  const aFleet = async (person: Person, organizationId: string) => {
    const label = `fleet-${++labels}-${randomUUID()}`;
    const response = await send(person, "POST", fleetsPath(organizationId), { label, type: "server", rotateExpiresAt: null });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ fleet: { id: string }; defaultGroup: { id: string } }>();
    return { fleetId: body.fleet.id, defaultGroupId: body.defaultGroup.id, label };
  };

  /** A collector group created through the API, with `fields` (an assignment, a variable group). */
  const aCollectorGroup = async (person: Person, organizationId: string, fleetId: string, fields: Record<string, unknown> = {}) => {
    const name = `group-${++labels}-${randomUUID()}`;
    const response = await send(person, "POST", `${fleetsPath(organizationId)}/${fleetId}/groups`, { name, ...fields });
    expect(response.statusCode).toBe(201);
    return { groupId: response.json<{ group: { id: string } }>().group.id, name };
  };

  /** Registers the organization with the opamp-server under its own name, as a create would. */
  const registered = async (organizationId: string) => {
    const { name } = await ownerDb.selectFrom("organizations").select("name").where("id", "=", organizationId).executeTakeFirstOrThrow();
    const result = await opamp.client.createOrganization({ id: organizationId, name });
    expect(["created", "unchanged"]).toContain(result.kind);
  };

  /**
   * A version 1 of a configuration `creatorUserId` made, published as D11b
   * leaves one with `yaml`: the platform's rows (as the owner) and the
   * opamp-server's published copy, its names read from the text.
   */
  const publishedWith = async (organizationId: string, creatorUserId: string, yaml: string) => {
    const configuration = await addConfiguration(ownerDb, {
      organizationId,
      created_by_user_id: creatorUserId,
      name: `edge-config-${randomUUID()}`,
    });
    const version = await addConfigurationVersion(ownerDb, {
      configurationId: configuration.id,
      organizationId,
      created_by_user_id: creatorUserId,
      yaml_content: yaml,
      publishedAt: new Date(),
      publishedByUserId: creatorUserId,
    });
    const publicationId = version.publication_id as string;
    await registered(organizationId);
    const put = await opamp.client.postPublication(organizationId, publicationId, {
      configuration: { id: configuration.id, name: configuration.name },
      version: { id: version.id, number: version.version_number, label: null },
      yaml,
      sha256: sha256Hex(yaml),
      publishedBy: null,
      publishedAt: clock.toISOString(),
      collector: await catalogueDefaults(ownerDb),
    });
    expect(put.kind).toBe("created");
    return { configurationId: configuration.id, configurationName: configuration.name, versionId: version.id, versionNumber: version.version_number, publicationId };
  };

  /** The organization's audit rows of the variables routes, in order: action, subject and metadata. */
  const variableAudits = async (organizationId: string) =>
    (
      await ownerDb
        .selectFrom("audit_events")
        .select(["action", "subject_type", "subject_id", "metadata"])
        .where("organization_id", "=", organizationId)
        .where((eb) => eb.or([eb("action", "like", "organization_variable.%"), eb("action", "like", "variable_group.%")]))
        .orderBy("id")
        .execute()
    ).map((row) => ({ action: row.action, subjectType: row.subject_type, subjectId: row.subject_id, metadata: row.metadata }));

  const auditText = async (organizationId: string) =>
    JSON.stringify(await ownerDb.selectFrom("audit_events").selectAll().where("organization_id", "=", organizationId).execute());

  /** Every route of the module, naming `ids`, with a valid body, and the operation it calls. */
  function everyRoute(organizationId: string, ids: { variable: string; variableGroup: string }) {
    return [
      ["GET", variablesPath(organizationId), undefined, "listVariables"],
      ["POST", variablesPath(organizationId), { id: randomUUID(), name: uniqueName(), value: "v", description: null }, "createVariable"],
      ["PATCH", variablePath(organizationId, ids.variable), { value: "w" }, "updateVariable"],
      ["DELETE", variablePath(organizationId, ids.variable), undefined, "deleteVariable"],
      ["GET", `${variablePath(organizationId, ids.variable)}/drafts`, undefined, "listVariables"],
      ["GET", groupsPath(organizationId), undefined, "listVariableGroups"],
      ["POST", groupsPath(organizationId), { id: randomUUID(), name: `g ${randomUUID()}`, description: null }, "createVariableGroup"],
      ["GET", groupPath(organizationId, ids.variableGroup), undefined, "getVariableGroup"],
      ["PATCH", groupPath(organizationId, ids.variableGroup), { description: "d" }, "updateVariableGroup"],
      ["DELETE", groupPath(organizationId, ids.variableGroup), undefined, "deleteVariableGroup"],
      ["PUT", overridePath(organizationId, ids.variableGroup, ids.variable), { value: "o" }, "setVariableGroupOverride"],
      ["DELETE", overridePath(organizationId, ids.variableGroup, ids.variable), undefined, "resetVariableGroupOverride"],
    ] as const satisfies readonly (readonly [Method, string, Record<string, unknown> | undefined, keyof OpampServerClient])[];
  }

  // -------------------------------------------------------------------------

  describe("every member reads and writes every route (Preflight rulings 25 and 46: no viewer role)", () => {
    it.each(["admin", "contributor"] as const)("a variable's life, for the %s: create, a retry, list, rename, revalue, describe, delete", async (role) => {
      const world = await team();
      const person = world[role];
      const id = randomUUID();
      const body = { id, name: uniqueName(), value: "https://collector.example:4318", description: "The OTLP endpoint" };

      const created = await send(person, "POST", variablesPath(world.organizationId), body);
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const variable = created.json<{ variable: VariableBody }>().variable;
      expect(variable).toEqual({ ...body, changedBy: { userId: person.userId, email: person.email }, changedAt: expect.any(String) });

      // A retry with the same id and content: 200, the variable as it is.
      const retried = await send(person, "POST", variablesPath(world.organizationId), body);
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual({ variable });

      const listed = await send(person, "GET", variablesPath(world.organizationId));
      expect(listed.statusCode).toBe(200);
      expect(listed.headers["cache-control"]).toBe("no-store");
      expect(listed.json()).toEqual({ variables: [variable] });

      const renamed = uniqueName("RENAMED");
      for (const [changes, expected] of [
        [{ name: renamed }, { name: renamed }],
        [{ value: "a $ value" }, { value: "a $ value" }],
        [{ description: null }, { description: null }],
        [{ value: "", description: "again" }, { value: "", description: "again" }],
      ] as const) {
        const updated = await send(person, "PATCH", variablePath(world.organizationId, id), changes);
        expect(updated.statusCode).toBe(200);
        expect(updated.headers["cache-control"]).toBe("no-store");
        expect(updated.json<{ variable: VariableBody }>().variable).toMatchObject({ id, ...expected, changedBy: { userId: person.userId } });
      }

      const removed = await send(person, "DELETE", variablePath(world.organizationId, id));
      expect(removed.statusCode).toBe(204);
      expect((await send(person, "GET", variablesPath(world.organizationId))).json()).toEqual({ variables: [] });
    });

    it.each(["admin", "contributor"] as const)("a variable group's life, for the %s: create, a retry, list, read, rename, override, reset, delete", async (role) => {
      const world = await team();
      const person = world[role];
      const variable = await aVariable(person, world.organizationId, { value: "organization value" });
      const id = randomUUID();
      const body = { id, name: "Production EU", description: null };

      const created = await send(person, "POST", groupsPath(world.organizationId), body);
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const group = created.json<{ variableGroup: VariableGroupBody }>().variableGroup;
      expect(group).toEqual({
        ...body,
        overrideCount: 0,
        usage: { collectorGroups: 0, pinnedCollectors: 0 },
        changedBy: { userId: person.userId, email: person.email },
        changedAt: expect.any(String),
      });
      const retried = await send(person, "POST", groupsPath(world.organizationId), body);
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual({ variableGroup: group });

      expect((await send(person, "GET", groupsPath(world.organizationId))).json()).toEqual({ variableGroups: [group] });
      const read = await send(person, "GET", groupPath(world.organizationId, id));
      expect(read.statusCode).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.json()).toEqual({ variableGroup: group, overrides: [] });

      const updated = await send(person, "PATCH", groupPath(world.organizationId, id), { name: "Production EU-West", description: "eu-west-1" });
      expect(updated.statusCode).toBe(200);
      expect(updated.json<{ variableGroup: VariableGroupBody }>().variableGroup).toMatchObject({ name: "Production EU-West", description: "eu-west-1" });

      const set = await send(person, "PUT", overridePath(world.organizationId, id, variable.id), { value: "eu value" });
      expect(set.statusCode).toBe(200);
      expect(set.headers["cache-control"]).toBe("no-store");
      expect(set.json()).toEqual({
        override: { variableId: variable.id, value: "eu value", changedBy: { userId: person.userId, email: person.email }, changedAt: expect.any(String) },
      });
      const withOverride = (await send(person, "GET", groupPath(world.organizationId, id))).json<{ variableGroup: VariableGroupBody; overrides: unknown[] }>();
      expect(withOverride.variableGroup.overrideCount).toBe(1);
      expect(withOverride.overrides).toEqual([set.json<{ override: unknown }>().override]);

      const reset = await send(person, "DELETE", overridePath(world.organizationId, id, variable.id));
      expect(reset.statusCode).toBe(204);
      expect((await send(person, "GET", groupPath(world.organizationId, id))).json()).toMatchObject({ variableGroup: { overrideCount: 0 }, overrides: [] });
      // The Reset records its actor (Ruling 62).
      expect(calls.filter((call) => call.operation === "resetVariableGroupOverride").map((call) => call.args[3])).toEqual([
        { id: person.userId, email: person.email },
      ]);

      expect((await send(person, "DELETE", groupPath(world.organizationId, id))).statusCode).toBe(204);
      expect((await send(person, "GET", groupsPath(world.organizationId))).json()).toEqual({ variableGroups: [] });
    });

    it("answers an organization the opamp-server doesn't know with empty lists, and a write's create registers it", async () => {
      const world = await team();
      expect((await send(world.admin, "GET", variablesPath(world.organizationId))).json()).toEqual({ variables: [] });
      expect((await send(world.contributor, "GET", groupsPath(world.organizationId))).json()).toEqual({ variableGroups: [] });
      expect(operations()).toEqual(["listVariables", "listVariableGroups"]);
      calls = [];
      await aVariable(world.contributor, world.organizationId);
      expect(operations()).toEqual(["createOrganization", "createVariable"]);
    });

    it("sends the session's person as the actor, never the body's, and the session's organization", async () => {
      const world = await team();
      const response = await send(world.contributor, "POST", variablesPath(world.organizationId), {
        id: randomUUID(),
        name: uniqueName(),
        value: "v",
        description: null,
        actor: { id: world.admin.userId, email: world.admin.email },
      });
      // The contract takes no actor.
      expectRefusal(response, 400, "invalid_request");
      await aVariable(world.contributor, world.organizationId);
      const create = calls.find((call) => call.operation === "createVariable");
      expect(create?.args[0]).toBe(world.organizationId);
      expect(create?.args[1]).toMatchObject({ actor: { id: world.contributor.userId, email: world.contributor.email } });
    });
  });

  // -------------------------------------------------------------------------

  describe("the person's refusals", () => {
    it("refuses a create's taken name, another variable's id and the 150th's successor (409s); the contract's refusals with no call", async () => {
      const world = await team();
      const first = await aVariable(world.admin, world.organizationId);
      expectRefusal(
        await send(world.admin, "POST", variablesPath(world.organizationId), { id: randomUUID(), name: first.name, value: "v", description: null }),
        409,
        "variable_name_taken",
        MESSAGES.variableNameTaken,
      );
      expectRefusal(
        await send(world.admin, "POST", variablesPath(world.organizationId), { id: first.id, name: uniqueName(), value: "v", description: null }),
        409,
        "variable_conflict",
        MESSAGES.variableConflict,
      );
      calls = [];
      for (const body of [
        { id: randomUUID(), name: "lower_case", value: "v", description: null },
        { id: randomUUID(), name: "A".repeat(129), value: "v", description: null },
        { id: randomUUID(), name: uniqueName(), value: "two\nlines", description: null },
        { id: randomUUID(), name: uniqueName(), value: "x".repeat(1025), description: null },
        { id: randomUUID(), name: uniqueName(), value: "\u{1F680}".repeat(1025), description: null },
        { id: randomUUID(), name: uniqueName(), value: "v", description: " edge" },
        { id: randomUUID(), name: uniqueName(), value: "v" },
        { name: uniqueName(), value: "v", description: null },
      ]) {
        expectRefusal(await send(world.admin, "POST", variablesPath(world.organizationId), body), 400, "invalid_request");
      }
      expect(operations()).toEqual([]);
      // Q104's longest value is taken, four-byte characters counted once each.
      expect((await aVariable(world.admin, world.organizationId, { value: "\u{1F680}".repeat(1024) })).value).toBe("\u{1F680}".repeat(1024));
    });

    it("refuses a 151st variable (Q104) and a 101st variable group (409)", async () => {
      const world = await team();
      await registered(world.organizationId);
      for (let index = 0; index < 150; index += 1) {
        const made = await opamp.client.createVariable(world.organizationId, { id: randomUUID(), name: `V${index}`, value: "", description: null, actor: null });
        expect(made.kind).toBe("created");
      }
      for (let index = 0; index < 100; index += 1) {
        const made = await opamp.client.createVariableGroup(world.organizationId, { id: randomUUID(), name: `G${index}`, description: null, actor: null });
        expect(made.kind).toBe("created");
      }
      expectRefusal(
        await send(world.admin, "POST", variablesPath(world.organizationId), { id: randomUUID(), name: uniqueName(), value: "v", description: null }),
        409,
        "variable_limit_reached",
        MESSAGES.variableLimit,
      );
      expectRefusal(
        await send(world.contributor, "POST", groupsPath(world.organizationId), { id: randomUUID(), name: "one more", description: null }),
        409,
        "variable_group_limit_reached",
        MESSAGES.variableGroupLimit,
      );
      expect(await variableAudits(world.organizationId)).toEqual([]);
    });

    it("refuses a rename to a taken name, an update with no field, and unknown or malformed ids (404, no call for a malformed one)", async () => {
      const world = await team();
      const first = await aVariable(world.admin, world.organizationId);
      const second = await aVariable(world.admin, world.organizationId);
      const group = await aVariableGroup(world.admin, world.organizationId);
      const other = await aVariableGroup(world.admin, world.organizationId);
      expectRefusal(await send(world.admin, "PATCH", variablePath(world.organizationId, second.id), { name: first.name }), 409, "variable_name_taken");
      expectRefusal(await send(world.admin, "PATCH", groupPath(world.organizationId, other.id), { name: group.name }), 409, "variable_group_name_taken", MESSAGES.variableGroupNameTaken);
      expectRefusal(
        await send(world.admin, "POST", groupsPath(world.organizationId), { id: group.id, name: "something else", description: null }),
        409,
        "variable_group_conflict",
        MESSAGES.variableGroupConflict,
      );
      expectRefusal(await send(world.admin, "PATCH", variablePath(world.organizationId, first.id), {}), 400, "invalid_request");
      expectRefusal(await send(world.admin, "PATCH", groupPath(world.organizationId, group.id), {}), 400, "invalid_request");

      const unknown = randomUUID();
      for (const [method, url, payload, code] of [
        ["PATCH", variablePath(world.organizationId, unknown), { value: "v" }, "variable_not_found"],
        ["DELETE", variablePath(world.organizationId, unknown), undefined, "variable_not_found"],
        ["GET", `${variablePath(world.organizationId, unknown)}/drafts`, undefined, "variable_not_found"],
        ["GET", groupPath(world.organizationId, unknown), undefined, "variable_group_not_found"],
        ["PATCH", groupPath(world.organizationId, unknown), { name: "x" }, "variable_group_not_found"],
        ["DELETE", groupPath(world.organizationId, unknown), undefined, "variable_group_not_found"],
        ["PUT", overridePath(world.organizationId, unknown, first.id), { value: "v" }, "variable_group_not_found"],
        ["DELETE", overridePath(world.organizationId, unknown, first.id), undefined, "variable_group_not_found"],
        ["PUT", overridePath(world.organizationId, group.id, unknown), { value: "v" }, "variable_not_found"],
        ["DELETE", overridePath(world.organizationId, group.id, unknown), undefined, "variable_not_found"],
      ] as const) {
        expectRefusal(await send(world.contributor, method, url, payload), 404, code, code === "variable_not_found" ? MESSAGES.variableNotFound : MESSAGES.variableGroupNotFound);
      }

      calls = [];
      for (const malformed of MALFORMED_PATH_IDS) {
        for (const [method, url, payload, code] of [
          ["PATCH", variablePath(world.organizationId, malformed), { value: "v" }, "variable_not_found"],
          ["DELETE", variablePath(world.organizationId, malformed), undefined, "variable_not_found"],
          ["GET", `${variablePath(world.organizationId, malformed)}/drafts`, undefined, "variable_not_found"],
          ["GET", groupPath(world.organizationId, malformed), undefined, "variable_group_not_found"],
          ["PATCH", groupPath(world.organizationId, malformed), { name: "x" }, "variable_group_not_found"],
          ["DELETE", groupPath(world.organizationId, malformed), undefined, "variable_group_not_found"],
          ["PUT", overridePath(world.organizationId, malformed, first.id), { value: "v" }, "variable_group_not_found"],
          ["DELETE", overridePath(world.organizationId, group.id, malformed), undefined, "variable_not_found"],
        ] as const) {
          expectRefusal(await send(world.admin, method, url, payload), 404, code);
        }
      }
      expect(operations()).toEqual([]);
    });

    it("answers a path naming another organization than the session's active one 404 organization_not_found, with no call", async () => {
      const world = await team();
      const elsewhere = await team();
      for (const [method, url, payload] of everyRoute(elsewhere.organizationId, { variable: randomUUID(), variableGroup: randomUUID() })) {
        expectRefusal(await send(world.admin, method, url, payload), 404, "organization_not_found", MESSAGES.organizationNotFound);
      }
      expect(operations()).toEqual([]);
    });

    it("needs a session (401) and the CSRF header on a write (403)", async () => {
      const world = await team();
      for (const [method, url, payload] of everyRoute(world.organizationId, { variable: randomUUID(), variableGroup: randomUUID() })) {
        expect((await send(undefined, method, url, payload)).statusCode).toBe(401);
        if (method !== "GET") {
          const response = await server.inject({ method, url, cookies: { telflo_access: world.admin.access }, ...(payload === undefined ? {} : { payload }) });
          expect(response.statusCode).toBe(403);
        }
      }
      expect(operations()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("tenancy", () => {
    it("answers another organization's variable and variable group ids 404 on every route, changing nothing of theirs", async () => {
      const mine = await team();
      const theirs = await team();
      const myVariable = await aVariable(mine.admin, mine.organizationId);
      const myGroup = await aVariableGroup(mine.admin, mine.organizationId);
      const theirVariable = await aVariable(theirs.admin, theirs.organizationId);
      const theirGroup = await aVariableGroup(theirs.admin, theirs.organizationId);
      expect((await send(theirs.admin, "PUT", overridePath(theirs.organizationId, theirGroup.id, theirVariable.id), { value: "theirs" })).statusCode).toBe(200);
      const before = opamp.fake.snapshotOf(theirs.organizationId);
      const theirAudits = await variableAudits(theirs.organizationId);
      calls = [];

      for (const person of [mine.admin, mine.contributor]) {
        for (const [method, url, payload, code] of [
          ["PATCH", variablePath(mine.organizationId, theirVariable.id), { value: "mine" }, "variable_not_found"],
          ["PATCH", variablePath(mine.organizationId, theirVariable.id), { name: uniqueName() }, "variable_not_found"],
          ["DELETE", variablePath(mine.organizationId, theirVariable.id), undefined, "variable_not_found"],
          ["GET", `${variablePath(mine.organizationId, theirVariable.id)}/drafts`, undefined, "variable_not_found"],
          ["GET", groupPath(mine.organizationId, theirGroup.id), undefined, "variable_group_not_found"],
          ["PATCH", groupPath(mine.organizationId, theirGroup.id), { name: "mine" }, "variable_group_not_found"],
          ["DELETE", groupPath(mine.organizationId, theirGroup.id), undefined, "variable_group_not_found"],
          ["PUT", overridePath(mine.organizationId, theirGroup.id, theirVariable.id), { value: "mine" }, "variable_group_not_found"],
          ["DELETE", overridePath(mine.organizationId, theirGroup.id, theirVariable.id), undefined, "variable_group_not_found"],
          ["PUT", overridePath(mine.organizationId, myGroup.id, theirVariable.id), { value: "mine" }, "variable_not_found"],
          ["DELETE", overridePath(mine.organizationId, myGroup.id, theirVariable.id), undefined, "variable_not_found"],
          ["PUT", overridePath(mine.organizationId, theirGroup.id, myVariable.id), { value: "mine" }, "variable_group_not_found"],
        ] as const) {
          expectRefusal(await send(person, method, url, payload), 404, code);
        }
        // A create under their variable's or group's id is a conflict of mine, never theirs.
        expectRefusal(
          await send(person, "POST", variablesPath(mine.organizationId), { id: theirVariable.id, name: uniqueName(), value: "v", description: null }),
          409,
          "variable_conflict",
        );
        expectRefusal(
          await send(person, "POST", groupsPath(mine.organizationId), { id: theirGroup.id, name: "mine", description: null }),
          409,
          "variable_group_conflict",
        );
        // My lists hold nothing of theirs.
        expect((await send(person, "GET", variablesPath(mine.organizationId))).json()).toEqual({ variables: [myVariable] });
        expect((await send(person, "GET", groupsPath(mine.organizationId))).json<{ variableGroups: { id: string }[] }>().variableGroups.map((group) => group.id)).toEqual([myGroup.id]);
      }
      expect(opamp.fake.snapshotOf(theirs.organizationId)).toEqual(before);
      expect(await variableAudits(theirs.organizationId)).toEqual(theirAudits);
      // Every call named my organization (a create's registration names it in its body).
      expect(calls.length).toBeGreaterThan(0);
      const organizationOf = (call: Call) => (typeof call.args[0] === "string" ? call.args[0] : (call.args[0] as { id: string }).id);
      expect(calls.filter((call) => organizationOf(call) !== mine.organizationId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("the audit rows (decision 37; Q94)", () => {
    it("records each write after its success, ids and field names only, and none for a create's retry or a refusal", async () => {
      const world = await team();
      const canary = `CANARY_${randomUUID().replaceAll("-", "").toUpperCase()}`;
      const value = `value-canary-${randomUUID()}`;
      const description = `description-canary-${randomUUID()}`;
      const groupName = `group-canary-${randomUUID()}`;
      const variableId = randomUUID();
      const variableGroupId = randomUUID();
      const create = { id: variableId, name: canary, value, description };
      expect((await send(world.admin, "POST", variablesPath(world.organizationId), create)).statusCode).toBe(201);
      expect((await send(world.admin, "POST", variablesPath(world.organizationId), create)).statusCode).toBe(200);
      expect((await send(world.contributor, "PATCH", variablePath(world.organizationId, variableId), { value: `${value}-2` })).statusCode).toBe(200);
      expect(
        (await send(world.contributor, "PATCH", variablePath(world.organizationId, variableId), { name: `${canary}_2`, description: null })).statusCode,
      ).toBe(200);
      const group = { id: variableGroupId, name: groupName, description };
      expect((await send(world.contributor, "POST", groupsPath(world.organizationId), group)).statusCode).toBe(201);
      expect((await send(world.contributor, "POST", groupsPath(world.organizationId), group)).statusCode).toBe(200);
      expect((await send(world.admin, "PATCH", groupPath(world.organizationId, variableGroupId), { description: null })).statusCode).toBe(200);
      expect((await send(world.admin, "PUT", overridePath(world.organizationId, variableGroupId, variableId), { value: `${value}-override` })).statusCode).toBe(200);
      expect((await send(world.admin, "DELETE", overridePath(world.organizationId, variableGroupId, variableId))).statusCode).toBe(204);
      // Refusals write nothing.
      expectRefusal(
        await send(world.admin, "POST", variablesPath(world.organizationId), { id: randomUUID(), name: `${canary}_2`, value, description: null }),
        409,
        "variable_name_taken",
      );
      expect((await send(world.admin, "DELETE", groupPath(world.organizationId, variableGroupId))).statusCode).toBe(204);
      expect((await send(world.admin, "DELETE", variablePath(world.organizationId, variableId))).statusCode).toBe(204);

      const variable = { subjectType: "organization_variable", subjectId: variableId };
      const variableGroup = { subjectType: "variable_group", subjectId: variableGroupId };
      expect(await variableAudits(world.organizationId)).toEqual([
        { action: "organization_variable.created", ...variable, metadata: { variableId, fields: ["description", "name", "value"] } },
        { action: "organization_variable.updated", ...variable, metadata: { variableId, fields: ["value"] } },
        { action: "organization_variable.updated", ...variable, metadata: { variableId, fields: ["description", "name"] } },
        { action: "variable_group.created", ...variableGroup, metadata: { variableGroupId, fields: ["description", "name"] } },
        { action: "variable_group.updated", ...variableGroup, metadata: { variableGroupId, fields: ["description"] } },
        { action: "variable_group.override_set", ...variableGroup, metadata: { variableGroupId, variableId } },
        { action: "variable_group.override_reset", ...variableGroup, metadata: { variableGroupId, variableId } },
        { action: "variable_group.deleted", ...variableGroup, metadata: { variableGroupId } },
        { action: "organization_variable.deleted", ...variable, metadata: { variableId } },
      ]);
      // Who: the person and their email, as every audit row.
      const actors = await ownerDb
        .selectFrom("audit_events")
        .select(["actor_user_id", "action"])
        .where("organization_id", "=", world.organizationId)
        .where("action", "=", "variable_group.created")
        .execute();
      expect(actors).toEqual([{ actor_user_id: world.contributor.userId, action: "variable_group.created" }]);
      const text = await auditText(world.organizationId);
      for (const secretLike of [canary, value, description, groupName]) expect(text).not.toContain(secretLike);
      expectNotLogged(canary, value, description, groupName);
    });

    it("writes one override_set row for every PUT, a new override, a replace and the same value alike; one override_reset for every Reset, of a live override, of none and of a reset row alike (Preflight ruling 44)", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId);
      const group = await aVariableGroup(world.admin, world.organizationId);
      const path = overridePath(world.organizationId, group.id, variable.id);
      const base = await variableAudits(world.organizationId);

      for (const value of ["first", "replaced", "replaced"]) expect((await send(world.contributor, "PUT", path, { value })).statusCode).toBe(200);
      // A Reset of a live override, a Reset of the reset row, a Reset of none (another variable).
      const other = await aVariable(world.admin, world.organizationId);
      expect((await send(world.contributor, "DELETE", path)).statusCode).toBe(204);
      expect((await send(world.contributor, "DELETE", path)).statusCode).toBe(204);
      expect((await send(world.contributor, "DELETE", overridePath(world.organizationId, group.id, other.id))).statusCode).toBe(204);
      // Reviving the reset row: a new override to the screen.
      expect((await send(world.contributor, "PUT", path, { value: "revived" })).statusCode).toBe(200);

      const rows = (await variableAudits(world.organizationId)).slice(base.length).filter((row) => row.action.startsWith("variable_group.override"));
      const set = { action: "variable_group.override_set", subjectType: "variable_group", subjectId: group.id, metadata: { variableGroupId: group.id, variableId: variable.id } };
      const reset = { ...set, action: "variable_group.override_reset" };
      expect(rows).toEqual([set, set, set, reset, reset, { ...reset, metadata: { variableGroupId: group.id, variableId: other.id } }, set]);
    });
  });

  // -------------------------------------------------------------------------

  describe("the in-use refusals' details (decision 6; Preflight ruling 26; Q102)", () => {
    /**
     * A variable a published version references, assigned to a collector
     * group in each of two fleets and pinned on one collector; a variable
     * group bound to the first group and pinned on that collector.
     */
    const aUsedWorld = async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId, { name: uniqueName("OTLP_EP") });
      const published = await publishedWith(world.organizationId, world.admin.userId, `exporters:\n  otlp:\n    endpoint: ${ref(variable.name)}\n`);
      const variableGroup = await aVariableGroup(world.admin, world.organizationId);
      const first = await aFleet(world.admin, world.organizationId);
      const second = await aFleet(world.admin, world.organizationId);
      const firstGroup = await aCollectorGroup(world.admin, world.organizationId, first.fleetId, { assignedVersionId: published.versionId, variableGroupId: variableGroup.id });
      const secondGroup = await aCollectorGroup(world.admin, world.organizationId, second.fleetId, { assignedVersionId: published.versionId });
      const collector = opamp.fake.enrollCollector(world.organizationId, first.fleetId, { groupId: firstGroup.groupId });
      const pinned = await send(world.admin, "PATCH", `${fleetsPath(world.organizationId)}/${first.fleetId}/collectors/${collector.id}`, {
        pin: { kind: "version", versionId: published.versionId },
        pinnedVariableGroupId: variableGroup.id,
      });
      expect(pinned.statusCode).toBe(200);
      calls = [];
      logLines = [];
      return { ...world, variable, published, variableGroup, first, second, firstGroup, secondGroup, collector };
    };

    const byFleetThenGroup = <Group extends { fleetId: string; groupId: string }>(groups: Group[]) =>
      [...groups].sort((a, b) => (a.fleetId === b.fleetId ? a.groupId.localeCompare(b.groupId) : a.fleetId.localeCompare(b.fleetId)));

    it("answers a variable's delete and rename 409 variable_in_use naming the configuration, the version, the fleets and the groups, with the totals; nothing changes", async () => {
      const world = await aUsedWorld();
      const before = opamp.fake.snapshotOf(world.organizationId);
      const expected = {
        usedBy: [
          {
            publishedVersionId: world.published.publicationId,
            configurationId: world.published.configurationId,
            configurationName: world.published.configurationName,
            versionId: world.published.versionId,
            versionNumber: 1,
            groups: byFleetThenGroup([
              { fleetId: world.first.fleetId, fleetLabel: world.first.label, groupId: world.firstGroup.groupId, groupName: world.firstGroup.name },
              { fleetId: world.second.fleetId, fleetLabel: world.second.label, groupId: world.secondGroup.groupId, groupName: world.secondGroup.name },
            ]),
            pinnedCollectors: 1,
          },
        ],
        totalPublications: 1,
        totalGroups: 2,
        totalPinnedCollectors: 1,
      };
      for (const person of [world.admin, world.contributor]) {
        const removed = await send(person, "DELETE", variablePath(world.organizationId, world.variable.id));
        expectRefusal(removed, 409, "variable_in_use", MESSAGES.variableInUse);
        expect(detailsOf(removed)).toEqual(expected);
        const renamed = await send(person, "PATCH", variablePath(world.organizationId, world.variable.id), { name: uniqueName() });
        expectRefusal(renamed, 409, "variable_in_use");
        expect(detailsOf(renamed)).toEqual(expected);
      }
      expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
      // A value change is never refused (decision 6).
      expect((await send(world.admin, "PATCH", variablePath(world.organizationId, world.variable.id), { value: "changed" })).statusCode).toBe(200);
      expect((await variableAudits(world.organizationId)).map((row) => row.action).filter((action) => action !== "organization_variable.created" && action !== "variable_group.created")).toEqual([
        "organization_variable.updated",
      ]);
      // The names went into the reply only.
      expectNotLogged(world.variable.name, world.published.configurationName, world.first.label, world.firstGroup.name, world.secondGroup.name);
    });

    it("answers a variable group's delete 409 variable_group_in_use naming the collector groups, with the pinned count; nothing deleted", async () => {
      const world = await aUsedWorld();
      const before = opamp.fake.snapshotOf(world.organizationId);
      const removed = await send(world.contributor, "DELETE", groupPath(world.organizationId, world.variableGroup.id));
      expectRefusal(removed, 409, "variable_group_in_use", MESSAGES.variableGroupInUse);
      expect(detailsOf(removed)).toEqual({
        collectorGroups: [{ fleetId: world.first.fleetId, fleetLabel: world.first.label, groupId: world.firstGroup.groupId, groupName: world.firstGroup.name }],
        totalCollectorGroups: 1,
        pinnedCollectors: 1,
      });
      expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
      expect((await variableAudits(world.organizationId)).filter((row) => row.action === "variable_group.deleted")).toEqual([]);
      expectNotLogged(world.variableGroup.name, world.first.label, world.firstGroup.name);
    });

    it("leaves a name null where its lookup fails, throws or finds nothing, and the 409 stands", async () => {
      const world = await aUsedWorld();
      // The first fleet's label: the opamp-server can't be asked; its groups: the call throws.
      hooks.getFleet = async (...args: unknown[]) =>
        args[1] === world.first.fleetId ? { kind: "unavailable", reason: "timeout" } : opamp.client.getFleet(args[0] as string, args[1] as string);
      hooks.listCollectorGroups = async (...args: unknown[]) => {
        if (args[1] === world.first.fleetId) throw new OpampServerMisconfigurationError("listCollectorGroups answered 401");
        return { kind: "fleet_not_found" };
      };
      // The configuration deleted on the platform's side: describe finds no live version.
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", world.published.configurationId).execute();

      const removed = await send(world.admin, "DELETE", variablePath(world.organizationId, world.variable.id));
      expectRefusal(removed, 409, "variable_in_use");
      expect(detailsOf(removed)).toEqual({
        usedBy: [
          {
            publishedVersionId: world.published.publicationId,
            configurationId: null,
            configurationName: null,
            versionId: null,
            versionNumber: null,
            groups: byFleetThenGroup([
              { fleetId: world.first.fleetId, fleetLabel: null, groupId: world.firstGroup.groupId, groupName: null },
              { fleetId: world.second.fleetId, fleetLabel: world.second.label, groupId: world.secondGroup.groupId, groupName: null },
            ]),
            pinnedCollectors: 1,
          },
        ],
        totalPublications: 1,
        totalGroups: 2,
        totalPinnedCollectors: 1,
      });
      // Each failure logged with ids and the kind only.
      expect(logged().filter((line) => line.operation === "getFleet")).toEqual([
        expect.objectContaining({ level: 40, organizationId: world.organizationId, fleetId: world.first.fleetId, result: "unavailable" }),
      ]);
      expect(logged().filter((line) => line.operation === "listCollectorGroups")).toEqual([
        expect.objectContaining({ level: 40, fleetId: world.first.fleetId, error: "listCollectorGroups answered 401" }),
      ]);
      // A lookup that fails entirely (the database's describe) still answers the 409.
      hooks.getFleet = async () => {
        throw new Error("boom");
      };
      const group = await send(world.admin, "DELETE", groupPath(world.organizationId, world.variableGroup.id));
      expectRefusal(group, 409, "variable_group_in_use");
      expect(detailsOf(group)).toEqual({
        collectorGroups: [{ fleetId: world.first.fleetId, fleetLabel: null, groupId: world.firstGroup.groupId, groupName: null }],
        totalCollectorGroups: 1,
        pinnedCollectors: 1,
      });
    });

    it("passes the opamp-server's totals through beside at most 100 listed entries (Q102)", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId);
      calls = [];
      const usedBy = Array.from({ length: 100 }, () => ({ publicationId: randomUUID(), groups: [], pinnedCollectors: 1 }));
      hooks.deleteVariable = async () => ({
        kind: "variable_in_use",
        details: { usedBy, totalPublications: 340, totalGroups: 512, totalPinnedCollectors: 777 },
      });
      const removed = await send(world.admin, "DELETE", variablePath(world.organizationId, variable.id));
      expectRefusal(removed, 409, "variable_in_use");
      const details = detailsOf<{ usedBy: unknown[]; totalPublications: number; totalGroups: number; totalPinnedCollectors: number }>(removed);
      expect(details.usedBy).toHaveLength(100);
      expect(details).toMatchObject({ totalPublications: 340, totalGroups: 512, totalPinnedCollectors: 777 });
      expect(details.usedBy[0]).toEqual({
        publishedVersionId: usedBy[0]?.publicationId,
        configurationId: null,
        configurationName: null,
        versionId: null,
        versionNumber: null,
        groups: [],
        pinnedCollectors: 1,
      });
      // No group named, so no fleet looked up; the publications in one query.
      expect(operations()).toEqual(["deleteVariable"]);
    });
  });

  // -------------------------------------------------------------------------

  describe("the drafts warning (default 21; Preflight ruling 27)", () => {
    const draftsOf = async (person: Person, organizationId: string, variableId: string) => {
      const response = await send(person, "GET", `${variablePath(organizationId, variableId)}/drafts`);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      return response.json<{ configurations: { id: string; name: string }[] }>().configurations;
    };

    /** A configuration of `creator`'s with one version per text (version 1 first), each published or not. */
    const configurationWith = async (organizationId: string, creator: Person, name: string, versions: readonly { yaml: string; published: boolean }[]) => {
      const configuration = await addConfiguration(ownerDb, { organizationId, created_by_user_id: creator.userId, name });
      for (const [index, version] of versions.entries()) {
        await addConfigurationVersion(ownerDb, {
          configurationId: configuration.id,
          organizationId,
          created_by_user_id: creator.userId,
          version_number: index + 1,
          yaml_content: version.yaml,
          ...(version.published ? { publishedAt: new Date(), publishedByUserId: creator.userId } : {}),
        });
      }
      return { id: configuration.id, name };
    };

    it("lists the configurations whose highest-numbered version is an unpublished draft holding a live reference, among those the member can see", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId, { name: uniqueName("OTLP_EP") });
      const live = `endpoint: ${ref(variable.name)}\n`;
      const quoted = `endpoint: "${ref(variable.name)}/v1"\n`;
      const without = "receivers: {}\n";
      const mine = await configurationWith(world.organizationId, world.admin, "b-mine-draft", [{ yaml: live, published: false }]);
      const publishedThenDraft = await configurationWith(world.organizationId, world.admin, "a-published-then-draft", [
        { yaml: without, published: true },
        { yaml: quoted, published: false },
      ]);
      // An older draft referencing it, a newer one not: the current draft doesn't.
      await configurationWith(world.organizationId, world.admin, "c-older-draft-only", [
        { yaml: live, published: false },
        { yaml: without, published: false },
      ]);
      // The highest version published: no current draft.
      await configurationWith(world.organizationId, world.admin, "d-published-highest", [{ yaml: live, published: true }]);
      // Only an escaped reference, the legacy form, a longer name, a default: none is a live reference to it.
      await configurationWith(world.organizationId, world.admin, "e-escaped", [{ yaml: `a: $${ref(variable.name)}\n`, published: false }]);
      await configurationWith(world.organizationId, world.admin, "f-legacy", [{ yaml: `a: $orgvar:${variable.name}\n`, published: false }]);
      await configurationWith(world.organizationId, world.admin, "g-longer-name", [{ yaml: `a: ${ref(`${variable.name}_2`)}\n`, published: false }]);
      await configurationWith(world.organizationId, world.admin, "h-default", [{ yaml: "a: ${org:" + variable.name + ":-x}\n", published: false }]);
      // Escaped once, live once: live.
      const escapedAndLive = await configurationWith(world.organizationId, world.admin, "i-escaped-and-live", [
        { yaml: `a: $${ref(variable.name)}\nb: $$${ref(variable.name)}\n`, published: false },
      ]);
      // Another member's draft configuration: the admin can't see it, its author can.
      const theirs = await configurationWith(world.organizationId, world.contributor, "j-contributors-draft", [{ yaml: live, published: false }]);
      // A deleted configuration's draft.
      const deleted = await configurationWith(world.organizationId, world.admin, "k-deleted", [{ yaml: live, published: false }]);
      await ownerDb.updateTable("configurations").set({ deleted_at: new Date() }).where("id", "=", deleted.id).execute();
      // Another organization's.
      const elsewhere = await team();
      await configurationWith(elsewhere.organizationId, elsewhere.admin, "l-elsewhere", [{ yaml: live, published: false }]);

      expect(await draftsOf(world.admin, world.organizationId, variable.id)).toEqual([publishedThenDraft, mine, escapedAndLive]);
      // A published configuration's draft every member sees; another's draft configuration only its author.
      expect(await draftsOf(world.contributor, world.organizationId, variable.id)).toEqual([publishedThenDraft, theirs]);
      // Only the variable's id travelled: the name was read from the opamp-server.
      expect(operations().filter((operation) => operation === "listVariables")).toHaveLength(2);
      expectNotLogged(variable.name, "b-mine-draft", "endpoint");
    });

    it("answers no configurations for a variable no draft references", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId);
      await configurationWith(world.organizationId, world.admin, "unrelated", [{ yaml: "receivers: {}\n", published: false }]);
      expect(await draftsOf(world.contributor, world.organizationId, variable.id)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  describe("the one 503 (decision 1): variables_unavailable, nothing changed", () => {
    const FAULTS = ["error_500", "reset", "malformed_reply"] as const;

    // A malformed reply comes after the opamp-server's change: a write's 503 can follow a change it made (its message says so).
    it.each(FAULTS)("answers %s on every route 503, logging ids and the kind only, and changing nothing on the platform's side", async (fault) => {
      const world = await team();
      const canary = uniqueName("CANARY");
      const variable = await aVariable(world.admin, world.organizationId, { name: canary, value: `value-${canary}` });
      const group = await aVariableGroup(world.admin, world.organizationId, { name: `group-${canary}` });
      const before = opamp.fake.snapshotOf(world.organizationId);
      const audits = await variableAudits(world.organizationId);
      logLines = [];

      for (const [method, url, payload, operation] of everyRoute(world.organizationId, { variable: variable.id, variableGroup: group.id })) {
        opamp.fake.nextFault(fault as FakeOpampServerFault, operation);
        const body = payload === undefined ? undefined : "value" in payload ? { ...payload, value: `value-${canary}-2` } : payload;
        const response = await send(world.contributor, method, url, body);
        expectRefusal(response, 503, "variables_unavailable", VARIABLES_UNAVAILABLE_MESSAGE);
        if (fault === "malformed_reply") expect(opamp.fake.takeViolations()).toHaveLength(1);
        const line = logged().filter((entry) => entry.operation === operation).at(-1);
        expect(line).toMatchObject({ operation, organizationId: world.organizationId });
        if (fault === "malformed_reply") expect(line).toMatchObject({ level: 50, error: expect.stringContaining(operation) });
        else expect(line).toMatchObject({ level: 40, result: "unavailable" });
      }
      if (fault !== "malformed_reply") expect(opamp.fake.snapshotOf(world.organizationId)).toEqual(before);
      expect(await variableAudits(world.organizationId)).toEqual(audits);
      expectNotLogged(canary, `value-${canary}`, `group-${canary}`, opamp.fake.url, opamp.fake.secret);
    });

    it("answers a refusal the platform's checks should have prevented (a 400, a 413) 503, logged at error with the code", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId);
      hooks.updateVariable = async () => ({ kind: "invalid", code: "invalid_request" });
      expectRefusal(await send(world.admin, "PATCH", variablePath(world.organizationId, variable.id), { value: "v" }), 503, "variables_unavailable");
      expect(logged().find((line) => line.operation === "updateVariable")).toMatchObject({ level: 50, result: "invalid", code: "invalid_request" });
      hooks.setVariableGroupOverride = async () => ({ kind: "invalid", code: "payload_too_large" });
      const group = await aVariableGroup(world.admin, world.organizationId);
      expectRefusal(await send(world.admin, "PUT", overridePath(world.organizationId, group.id, variable.id), { value: "v" }), 503, "variables_unavailable");
      expect((await variableAudits(world.organizationId)).map((row) => row.action)).toEqual(["organization_variable.created", "variable_group.created"]);
    });
  });

  // -------------------------------------------------------------------------

  describe("an error's own words never reach a log or a reply (Ruling 71)", () => {
    it("logs no message a throw carries, on every route's call and a create's registration and in a 409's lookups; the 503 body holds none either", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId);
      const group = await aVariableGroup(world.admin, world.organizationId);
      const canary = `canary-${randomUUID()}`;
      const throws = async () => {
        throw new Error(canary);
      };
      logLines = [];
      for (const [method, url, payload, operation] of everyRoute(world.organizationId, { variable: variable.id, variableGroup: group.id })) {
        hooks = { [operation]: throws };
        const response = await send(world.contributor, method, url, payload);
        expectRefusal(response, 503, "variables_unavailable", VARIABLES_UNAVAILABLE_MESSAGE);
        expect(response.body).not.toContain(canary);
        expect(logged().filter((line) => line.operation === operation).at(-1)).toMatchObject({ level: 50, error: "Error" });
      }
      // A create's registration throwing.
      hooks = { createOrganization: throws };
      const registering = await send(world.admin, "POST", variablesPath(world.organizationId), { id: randomUUID(), name: uniqueName(), value: "v", description: null });
      expectRefusal(registering, 503, "variables_unavailable");
      expect(registering.body).not.toContain(canary);
      // A 409's lookups throwing: the names null, the 409 kept.
      hooks = {
        deleteVariable: async () => ({
          kind: "variable_in_use",
          details: { usedBy: [{ publicationId: randomUUID(), groups: [{ fleetId: randomUUID(), groupId: randomUUID() }], pinnedCollectors: 0 }], totalPublications: 1, totalGroups: 1, totalPinnedCollectors: 0 },
        }),
        getFleet: throws,
        listCollectorGroups: throws,
      };
      const inUse = await send(world.admin, "DELETE", variablePath(world.organizationId, variable.id));
      expectRefusal(inUse, 409, "variable_in_use");
      expect(detailsOf<{ usedBy: { groups: { fleetLabel: string | null; groupName: string | null }[] }[] }>(inUse).usedBy[0]?.groups).toEqual([
        expect.objectContaining({ fleetLabel: null, groupName: null }),
      ]);
      expect(inUse.body).not.toContain(canary);
      expectNotLogged(canary);
    });
  });

  describe("the person's opamp-server budget, shared with the fleet routes (D16b Preflight ruling 12)", () => {
    let limited: FastifyInstance;

    beforeAll(async () => {
      limited = build({
        ...TEST_RATE_LIMITS,
        fleetReadsPerUser: { max: 2, windowMs: 60_000 },
        fleetWritesPerUser: { max: 2, windowMs: 60_000 },
      });
      await limited.ready();
    });

    afterAll(async () => {
      await limited.close();
    });

    const expectLimited = (response: LightMyRequestResponse) => {
      expectRefusal(response, 429, "rate_limited");
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    };

    it("counts a variables read and a fleet read alike, and answers past them 429 with Retry-After, calling nothing", async () => {
      const world = await team();
      expect((await send(world.admin, "GET", variablesPath(world.organizationId), undefined, limited)).statusCode).toBe(200);
      expect((await send(world.admin, "GET", fleetsPath(world.organizationId), undefined, limited)).statusCode).toBe(200);
      calls = [];
      expectLimited(await send(world.admin, "GET", variablesPath(world.organizationId), undefined, limited));
      expectLimited(await send(world.admin, "GET", groupsPath(world.organizationId), undefined, limited));
      expectLimited(await send(world.admin, "GET", `${variablePath(world.organizationId, randomUUID())}/drafts`, undefined, limited));
      expectLimited(await send(world.admin, "GET", fleetsPath(world.organizationId), undefined, limited));
      expect(calls).toEqual([]);
      // Another member's budget is their own.
      expect((await send(world.contributor, "GET", groupsPath(world.organizationId), undefined, limited)).statusCode).toBe(200);
    });

    it("counts a variables write and a fleet write alike, and answers past them 429 with Retry-After, calling nothing", async () => {
      const world = await team();
      // A fleet's create spends a bearer reply, not a write.
      const fleet = await send(world.admin, "POST", fleetsPath(world.organizationId), { label: `fleet-${randomUUID()}`, type: "server", rotateExpiresAt: null }, limited);
      expect(fleet.statusCode).toBe(201);
      const fleetId = fleet.json<{ fleet: { id: string } }>().fleet.id;
      const created = await send(world.admin, "POST", variablesPath(world.organizationId), { id: randomUUID(), name: uniqueName(), value: "v", description: null }, limited);
      expect(created.statusCode).toBe(201);
      const variableId = created.json<{ variable: { id: string } }>().variable.id;
      expect((await send(world.admin, "PATCH", `${fleetsPath(world.organizationId)}/${fleetId}`, { label: `renamed-${randomUUID()}` }, limited)).statusCode).toBe(200);
      calls = [];
      expectLimited(await send(world.admin, "PATCH", variablePath(world.organizationId, variableId), { value: "w" }, limited));
      expectLimited(await send(world.admin, "DELETE", variablePath(world.organizationId, variableId), undefined, limited));
      expectLimited(await send(world.admin, "POST", groupsPath(world.organizationId), { id: randomUUID(), name: "g", description: null }, limited));
      expectLimited(await send(world.admin, "PATCH", `${fleetsPath(world.organizationId)}/${fleetId}`, { label: "again" }, limited));
      expect(calls).toEqual([]);
      expect(await variableAudits(world.organizationId)).toHaveLength(1);
    });
  });

  describe("a 409's name lookups, bounded (Ruling 71)", () => {
    /** A `variable_in_use` naming one group in each of `fleets` fleets, none of them the organization's. */
    const inUseAcross = (fleets: number) => ({
      kind: "variable_in_use",
      details: {
        usedBy: [{ publicationId: randomUUID(), groups: Array.from({ length: fleets }, () => ({ fleetId: randomUUID(), groupId: randomUUID() })), pinnedCollectors: 0 }],
        totalPublications: 1,
        totalGroups: fleets,
        totalPinnedCollectors: 0,
      },
    });

    /** A lookup answering `answer` after a few turns, counting how many run at once. */
    const counted = (answer: unknown) => {
      const state = { running: 0, most: 0 };
      const hook = async () => {
        state.running += 1;
        state.most = Math.max(state.most, state.running);
        for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
        state.running -= 1;
        return answer;
      };
      return { state, hook };
    };

    it("looks up at most 8 fleets at once, every fleet named, the names null where none is found", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId);
      const fleet = counted({ kind: "fleet_not_found" });
      const listed = counted({ kind: "fleet_not_found" });
      hooks = { deleteVariable: async () => inUseAcross(20), getFleet: fleet.hook, listCollectorGroups: listed.hook };
      calls = [];
      const response = await send(world.admin, "DELETE", variablePath(world.organizationId, variable.id));
      expectRefusal(response, 409, "variable_in_use");
      expect(operations().filter((operation) => operation === "getFleet")).toHaveLength(20);
      expect(operations().filter((operation) => operation === "listCollectorGroups")).toHaveLength(20);
      expect(fleet.state.most).toBe(8);
      expect(listed.state.most).toBe(8);
      const groups = detailsOf<{ usedBy: { groups: { fleetLabel: string | null; groupName: string | null }[] }[] }>(response).usedBy[0]?.groups ?? [];
      expect(groups).toHaveLength(20);
      expect(groups.every((group) => group.fleetLabel === null && group.groupName === null)).toBe(true);
    });

    it("starts no lookup after one the opamp-server couldn't answer: the first round only, the names null, the 409 kept", async () => {
      const world = await team();
      const variable = await aVariable(world.admin, world.organizationId);
      const fleet = counted({ kind: "unavailable", reason: "timeout" });
      const listed = counted({ kind: "fleet_not_found" });
      hooks = { deleteVariable: async () => inUseAcross(20), getFleet: fleet.hook, listCollectorGroups: listed.hook };
      calls = [];
      const response = await send(world.admin, "DELETE", variablePath(world.organizationId, variable.id));
      expectRefusal(response, 409, "variable_in_use");
      expect(operations().filter((operation) => operation === "getFleet")).toHaveLength(8);
      expect(detailsOf<{ usedBy: { groups: unknown[] }[]; totalGroups: number }>(response)).toMatchObject({ totalGroups: 20 });
      // A throw stops it the same way.
      hooks = {
        deleteVariable: async () => inUseAcross(20),
        getFleet: async () => {
          throw new Error("boom");
        },
        listCollectorGroups: listed.hook,
      };
      calls = [];
      expectRefusal(await send(world.admin, "DELETE", variablePath(world.organizationId, variable.id)), 409, "variable_in_use");
      expect(operations().filter((operation) => operation === "getFleet")).toHaveLength(8);
    });
  });

  describe("a create racing its organization's delete (D16b Preflight ruling 13)", () => {
    it("deletes the organization in the opamp-server again and answers 404 when it was deleted while the create ran", async () => {
      const world = await team();
      hooks.createVariable = async (...args: unknown[]) => {
        const result = await (opamp.client.createVariable as (...given: unknown[]) => Promise<unknown>)(...args);
        await ownerDb.updateTable("organizations").set({ deleted_at: new Date() }).where("id", "=", world.organizationId).execute();
        return result;
      };
      const response = await send(world.admin, "POST", variablesPath(world.organizationId), { id: randomUUID(), name: uniqueName(), value: "v", description: null });
      expectRefusal(response, 404, "organization_not_found");
      await runner.settle();
      expect(operations()).toContain("deleteOrganization");
      expect(await variableAudits(world.organizationId)).toEqual([]);
    });
  });
});
