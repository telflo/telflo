import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeOpampServer, type FakeOpampServer } from "./fake-opamp-server.js";
import { AFTER_LATEST_INSTANT, EARLIEST_INSTANT } from "./fake-opamp-server-fleets.js";

// The fake opamp-server's fleet model (D16b Task 1, plan Preflight ruling 4):
// each of D16a's 25 operations answered as the contract documents and the
// Go server answers, through a plain HTTP client, every request and reply
// checked against vendor/opamp-server/openapi.yaml (afterEach reads
// the violations, so an undocumented reply fails the test that caused it).
// The clock is the fake's `now`, moved by each test.

let fake: FakeOpampServer;
const BASE = Date.parse("2026-10-13T09:00:00.000Z");
let clock = BASE;
const at = (offset: number) => new Date(BASE + offset).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ACTOR = { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", email: "sam@acme.io" };
/** The contract's EnrollmentTokenBearer, at the real bearer's length: base64 of 134 bytes. */
const BEARER = /^[A-Za-z0-9+/]{178}==$|^[A-Za-z0-9+/]{179}=$/;

beforeAll(async () => {
  fake = await startFakeOpampServer({ now: () => new Date(clock) });
});

beforeEach(() => {
  clock = BASE;
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
});

afterAll(async () => {
  await fake.close();
});

interface ErrorBody {
  error: { code: string; message: string };
}
interface Fleet {
  id: string;
  organizationId: string;
  label: string;
  type: string;
  status: string;
  createdBy: { id: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
  summary?: Record<string, unknown>;
}
interface Group {
  id: string;
  fleetId: string;
  name: string;
  isDefault: boolean;
  assignedPublicationId: string | null;
  annotations: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
interface Created {
  fleet: Fleet;
  defaultGroup: Group;
  tokens: { default: { id: string; bearer: string }; rotate: { id: string; bearer: string; expiresAt: string | null } };
}
interface Token {
  id: string;
  fleetId: string;
  kind: string;
  expiresAt: string | null;
  revokedAt: string | null;
  doRefresh: boolean;
  createdAt: string;
  activeCollectors?: number;
}
interface Collector {
  id: string;
  name: string;
  groupId: string;
  pin: { kind: string; id: string } | null;
  resolution: { from: string; id: string; sha256: string } | null;
  served: { kind: string | null; id: string | null; sha256: string; at: string | null } | null;
  effective: { sha256: string; status: string; error: string | null; at: string } | null;
  reported: { collectorVersion: string | null; ip: string | null; hostIp: string | null; attributes: Record<string, string> | null };
  enrollmentTokenId: string | null;
  lastSeenAt: string;
  liveness: string;
  sync: string;
  createdAt: string;
  updatedAt: string;
}
interface Page<T> {
  nextCursor: string | null;
  fleets?: T[];
  collectors?: T[];
  errors?: T[];
}

interface Answer<T> {
  status: number;
  headers: Headers;
  body: T;
}

async function call<T = ErrorBody>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  return callRaw<T>(method, path, body === undefined ? undefined : JSON.stringify(body));
}

/** A request whose body is sent as written (a number's exponent, a large body). */
async function callRaw<T = ErrorBody>(method: string, path: string, text?: string): Promise<Answer<T>> {
  const response = await fetch(`${fake.url}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${fake.secret}`,
      ...(text === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(text === undefined ? {} : { body: text }),
  });
  const replyText = await response.text();
  return { status: response.status, headers: response.headers, body: (replyText === "" ? undefined : JSON.parse(replyText)) as T };
}

const code = (answer: Answer<unknown>) => (answer.body as ErrorBody).error.code;

async function anOrganization(): Promise<string> {
  const id = randomUUID();
  expect((await call("POST", "/organizations", { id, name: "Acme" })).status).toBe(201);
  return id;
}

let labels = 0;

async function aFleet(
  organizationId: string,
  fields: { id?: string; label?: string; type?: string; rotateExpiresAt?: string | null } = {},
): Promise<Created> {
  const answer = await call<Created>("POST", `/organizations/${organizationId}/fleets`, {
    ...(fields.id === undefined ? {} : { id: fields.id }),
    label: fields.label ?? `fleet-${++labels}`,
    type: fields.type ?? "server",
    rotateExpiresAt: fields.rotateExpiresAt ?? null,
    actor: ACTOR,
  });
  expect(answer.status).toBe(201);
  return answer.body;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function aPublication(
  organizationId: string,
  fields: { configurationId?: string; number?: number; publishedAt?: string; yaml?: string } = {},
): Promise<{ id: string; sha256: string; configurationId: string }> {
  const id = randomUUID();
  const configurationId = fields.configurationId ?? randomUUID();
  const yaml = fields.yaml ?? `receivers: {}\n# ${id}\n`;
  const answer = await call("POST", `/organizations/${organizationId}/publications`, {
    id,
    configuration: { id: configurationId, name: "payments-gateway" },
    version: { id: randomUUID(), number: fields.number ?? 1, label: null },
    yaml,
    sha256: sha256(yaml),
    publishedBy: null,
    publishedAt: fields.publishedAt ?? "2026-10-03T14:02:11.000Z",
    collector: { distribution: "otelcol-contrib", version: "0.162.0" },
  });
  expect(answer.status).toBe(201);
  return { id, sha256: sha256(yaml), configurationId };
}

/** An organization with a fleet holding a second group, and a collector (with an error). */
async function aWorld() {
  const organizationId = await anOrganization();
  const created = await aFleet(organizationId);
  const fleetId = created.fleet.id;
  const group = await call<Group>("POST", `/organizations/${organizationId}/fleets/${fleetId}/groups`, { name: "gateways" });
  expect(group.status).toBe(201);
  const collector = fake.enrollCollector(organizationId, fleetId, { groupId: group.body.id });
  fake.recordCollectorError(organizationId, collector.id, { message: "bad config" });
  return {
    organizationId,
    created,
    fleetId,
    groupId: group.body.id,
    tokenId: created.tokens.rotate.id,
    collectorId: collector.id,
  };
}

interface Ids {
  org: string;
  fleet: string;
  group: string;
  token: string;
  collector: string;
  configuration: string;
}

type Request = [method: string, path: string, body?: unknown];

const fleetPath = (i: Ids) => `/organizations/${i.org}/fleets/${i.fleet}`;

/** Each of the 25 operations (D17b-2 added the token events, D17c-1 a new default token; D16a's 25 were 23 once D16c removed importing), as a valid request naming `ids`. */
const OPERATIONS: [string, (i: Ids) => Request][] = [
  ["getConfigurationUsage", (i) => ["GET", `/organizations/${i.org}/configurations/${i.configuration}/usage`]],
  ["getLimits", (i) => ["GET", `/organizations/${i.org}/limits`]],
  ["setLimits", (i) => ["PUT", `/organizations/${i.org}/limits`, { maxCollectors: 10, requestsPerMinute: null }]],
  [
    "createFleet",
    (i) => ["POST", `/organizations/${i.org}/fleets`, { id: i.fleet, label: "edge-prod", type: "server", rotateExpiresAt: null, actor: null }],
  ],
  ["listFleets", (i) => ["GET", `/organizations/${i.org}/fleets`]],
  ["getFleet", (i) => ["GET", fleetPath(i)]],
  ["updateFleet", (i) => ["PATCH", fleetPath(i), { label: "renamed" }]],
  ["deleteFleet", (i) => ["DELETE", fleetPath(i)]],
  ["listCollectorGroups", (i) => ["GET", `${fleetPath(i)}/groups`]],
  ["createCollectorGroup", (i) => ["POST", `${fleetPath(i)}/groups`, { name: "edge" }]],
  ["getCollectorGroup", (i) => ["GET", `${fleetPath(i)}/groups/${i.group}`]],
  ["updateCollectorGroup", (i) => ["PATCH", `${fleetPath(i)}/groups/${i.group}`, { name: "renamed" }]],
  ["deleteCollectorGroup", (i) => ["DELETE", `${fleetPath(i)}/groups/${i.group}`]],
  ["listEnrollmentTokens", (i) => ["GET", `${fleetPath(i)}/tokens`]],
  ["listEnrollmentTokenEvents", (i) => ["GET", `${fleetPath(i)}/tokens/events`]],
  [
    "rotateEnrollmentToken",
    (i) => ["POST", `${fleetPath(i)}/tokens/rotate`, { expiresAt: null, graceEndsAt: at(HOUR), actor: null }],
  ],
  ["issueDefaultEnrollmentToken", (i) => ["POST", `${fleetPath(i)}/tokens/default`, { actor: ACTOR }]],
  ["revealEnrollmentToken", (i) => ["POST", `${fleetPath(i)}/tokens/${i.token}/reveal`, { actor: ACTOR }]],
  ["revokeEnrollmentToken", (i) => ["POST", `${fleetPath(i)}/tokens/${i.token}/revoke`, { actor: ACTOR }]],
  ["listCollectorInstances", (i) => ["GET", `${fleetPath(i)}/collectors`]],
  ["pinCollectorInstances", (i) => ["POST", `${fleetPath(i)}/collectors/pin`, { collectorIds: [i.collector], pin: null }]],
  ["getCollectorInstance", (i) => ["GET", `${fleetPath(i)}/collectors/${i.collector}`]],
  ["updateCollectorInstance", (i) => ["PATCH", `${fleetPath(i)}/collectors/${i.collector}`, { name: "renamed" }]],
  ["deleteCollectorInstance", (i) => ["DELETE", `${fleetPath(i)}/collectors/${i.collector}`]],
  ["listCollectorInstanceErrors", (i) => ["GET", `${fleetPath(i)}/collectors/${i.collector}/errors`]],
];

const randomIds = (): Ids => ({
  org: randomUUID(),
  fleet: randomUUID(),
  group: randomUUID(),
  token: randomUUID(),
  collector: randomUUID(),
  configuration: randomUUID(),
});

const send = <T = ErrorBody>([method, path, body]: Request) => call<T>(method, path, body);

describe("the fleet model's tenancy and check order", () => {
  it("serves all 25 operations", () => {
    expect(OPERATIONS).toHaveLength(25);
  });

  it.each(OPERATIONS)("answers %s under an unregistered organization 404 organization_not_found", async (_id, request) => {
    const answer = await send(request(randomIds()));

    expect(answer.status).toBe(404);
    expect(code(answer)).toBe("organization_not_found");
  });

  it.each(OPERATIONS)("reads %s's path ids first: an organization id that isn't a UUID is 400", async (operationId, request) => {
    const answer = await send(request({ ...randomIds(), org: "42" }));

    expect(answer.status).toBe(400);
    expect(code(answer)).toBe("invalid_request");
    expect(fake.takeViolations()).toEqual([expect.stringMatching(new RegExp(`^${operationId} request: path parameter organizationId `))]);
  });

  it("reads the body after the organization: an unregistered organization's bad body is a 404", async () => {
    const answer = await call("POST", `/organizations/${randomUUID()}/fleets`, { label: "" });

    expect(answer.status).toBe(404);
    expect(code(answer)).toBe("organization_not_found");
    expect(fake.takeViolations()).not.toEqual([]);
  });

  const FLEET_SCOPED = OPERATIONS.filter(([id]) => !["getConfigurationUsage", "getLimits", "setLimits", "createFleet", "listFleets"].includes(id));

  it.each(FLEET_SCOPED)("answers %s with another organization's ids 404 fleet_not_found, changing nothing", async (_id, request) => {
    const world = await aWorld();
    const other = await anOrganization();
    await aFleet(other);
    const before = [fake.snapshotOf(world.organizationId), fake.snapshotOf(other)];

    const answer = await send(
      request({
        org: other,
        fleet: world.fleetId,
        group: world.groupId,
        token: world.tokenId,
        collector: world.collectorId,
        configuration: randomUUID(),
      }),
    );

    expect(answer.status).toBe(404);
    expect(code(answer)).toBe("fleet_not_found");
    expect([fake.snapshotOf(world.organizationId), fake.snapshotOf(other)]).toEqual(before);
  });

  it("answers another organization's fleet id on a create 409 fleet_conflict, and lists none of its fleets", async () => {
    const world = await aWorld();
    const other = await anOrganization();
    const before = fake.snapshotOf(world.organizationId);

    const conflict = await call("POST", `/organizations/${other}/fleets`, {
      id: world.fleetId,
      label: world.created.fleet.label,
      type: "server",
      rotateExpiresAt: null,
      actor: null,
    });
    const listed = await call<Page<Fleet>>("GET", `/organizations/${other}/fleets`);

    expect(conflict.status).toBe(409);
    expect(code(conflict)).toBe("fleet_conflict");
    expect(listed.body).toEqual({ fleets: [], nextCursor: null });
    expect(fake.snapshotOf(world.organizationId)).toEqual(before);
  });

  it.each([
    ["getCollectorGroup", "collector_group_not_found"],
    ["updateCollectorGroup", "collector_group_not_found"],
    ["deleteCollectorGroup", "collector_group_not_found"],
    ["revealEnrollmentToken", "enrollment_token_not_found"],
    ["revokeEnrollmentToken", "enrollment_token_not_found"],
    ["getCollectorInstance", "collector_not_found"],
    ["updateCollectorInstance", "collector_not_found"],
    ["deleteCollectorInstance", "collector_not_found"],
    ["listCollectorInstanceErrors", "collector_not_found"],
  ])("answers %s naming another fleet's child 404 %s, changing nothing", async (operationId, expected) => {
    const world = await aWorld();
    const sibling = await aFleet(world.organizationId);
    const before = fake.snapshotOf(world.organizationId);
    const request = OPERATIONS.find(([id]) => id === operationId)?.[1] as (i: Ids) => Request;

    const answer = await send(
      request({
        org: world.organizationId,
        fleet: sibling.fleet.id,
        group: world.groupId,
        token: world.tokenId,
        collector: world.collectorId,
        configuration: randomUUID(),
      }),
    );

    expect(answer.status).toBe(404);
    expect(code(answer)).toBe(expected);
    expect(fake.snapshotOf(world.organizationId)).toEqual(before);
  });

  it("pins none of another fleet's collectors, listing them notFound, and filters another fleet's group to nothing", async () => {
    const world = await aWorld();
    const sibling = await aFleet(world.organizationId);
    const before = fake.snapshotOf(world.organizationId);

    const pinned = await call(`POST`, `/organizations/${world.organizationId}/fleets/${sibling.fleet.id}/collectors/pin`, {
      collectorIds: [world.collectorId],
      pin: null,
    });
    const listed = await call<Page<Collector>>(
      "GET",
      `/organizations/${world.organizationId}/fleets/${sibling.fleet.id}/collectors?groupId=${world.groupId}`,
    );

    expect(pinned.body).toEqual({ updated: [], notFound: [world.collectorId] });
    expect(listed.body).toEqual({ collectors: [], nextCursor: null });
    expect(fake.snapshotOf(world.organizationId)).toEqual(before);
  });

  it.each(OPERATIONS)("answers %s 500 when it alone is faulted, then as usual", async (operationId, request) => {
    const world = await aWorld();
    const ids: Ids = {
      org: world.organizationId,
      fleet: world.fleetId,
      group: world.groupId,
      token: world.tokenId,
      collector: world.collectorId,
      configuration: randomUUID(),
    };
    fake.nextFault("error_500", operationId);
    // Another operation first: the fault waits for its own.
    expect((await call("GET", `/organizations/${world.organizationId}/fleets/${randomUUID()}/collectors/${randomUUID()}`)).status).toBe(
      operationId === "getCollectorInstance" ? 500 : 404,
    );

    const answer = await send(request(ids));

    if (operationId === "getCollectorInstance") {
      expect(answer.status).toBe(200);
    } else {
      expect(answer.status).toBe(500);
      expect(answer.body).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
      expect((await send(request(ids))).status).not.toBe(500);
    }
  });
});

describe("the fleet model's bodies", () => {
  const BODIES = OPERATIONS.filter(([, request]) => request(randomIds())[2] !== undefined);

  it.each(BODIES)("refuses %s's body the contract refuses, 400 after the organization, recording the violation", async (operationId, request) => {
    const world = await aWorld();
    const [method, path] = request({
      org: world.organizationId,
      fleet: world.fleetId,
      group: world.groupId,
      token: world.tokenId,
      collector: world.collectorId,
      configuration: randomUUID(),
    });
    const before = fake.snapshotOf(world.organizationId);

    const answer = await call(method, path, { unexpected: true });

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: { code: "invalid_request", message: "The request body doesn't match the API." } });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(new RegExp(`^${operationId} request body: `))]);
    expect(fake.snapshotOf(world.organizationId)).toEqual(before);
  });

  // D17d-1 decision 2: openapi.yaml lost role, namespace, replicas and volumes.
  it.each(["role", "namespace", "replicas", "volumes"])(
    "refuses a group's old Kubernetes field %s as the contract does, 400 on either fleet type, recording the violation",
    async (field) => {
      const organizationId = await anOrganization();
      const created = await aFleet(organizationId, { type: "kubernetes-supervisor" });
      const groups = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
      const before = fake.snapshotOf(organizationId);

      for (const [method, path, operationId, body] of [
        ["POST", groups, "createCollectorGroup", { name: "gateways", [field]: null }],
        ["PATCH", `${groups}/${created.defaultGroup.id}`, "updateCollectorGroup", { [field]: null }],
      ] as const) {
        const answer = await call(method, path, body);
        expect(answer.status).toBe(400);
        expect(answer.body).toEqual({ error: { code: "invalid_request", message: "The request body doesn't match the API." } });
        expect(fake.takeViolations()).toEqual([expect.stringMatching(new RegExp(`^${operationId} request body: `))]);
      }
      expect(fake.snapshotOf(organizationId)).toEqual(before);
    },
  );
});

describe("the fleet model's fleets", () => {
  it("creates a fleet with its Default group and both tokens' bearers, no-store, once", async () => {
    const organizationId = await anOrganization();
    const id = randomUUID();

    const answer = await call<Created>("POST", `/organizations/${organizationId}/fleets`, {
      id: id.toUpperCase(),
      label: "edge-prod",
      type: "server",
      rotateExpiresAt: "2027-04-10T00:00:00.000123Z",
      actor: { id: ACTOR.id.toUpperCase(), email: ACTOR.email },
    });

    expect(answer.status).toBe(201);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const { fleet, defaultGroup, tokens } = answer.body;
    expect(fleet).toEqual({
      id,
      organizationId,
      label: "edge-prod",
      type: "server",
      status: "active",
      createdBy: ACTOR,
      createdAt: at(0),
      updatedAt: at(0),
    });
    expect(defaultGroup).toEqual({
      id: expect.any(String),
      fleetId: id,
      name: "Default",
      isDefault: true,
      assignedPublicationId: null,
      annotations: null,
      variableGroupId: null,
      createdAt: at(0),
      updatedAt: at(0),
    });
    expect(tokens.default.bearer).toMatch(BEARER);
    expect(tokens.rotate.bearer).toMatch(BEARER);
    expect(tokens.default.bearer).not.toBe(tokens.rotate.bearer);
    expect(tokens.rotate.expiresAt).toBe("2027-04-10T00:00:00.000Z");

    const listed = await call<{ tokens: Token[] }>("GET", `/organizations/${organizationId}/fleets/${id}/tokens`);
    expect(listed.headers.get("cache-control")).toBeNull();
    expect(listed.body.tokens.map((t) => [t.id, t.kind, t.expiresAt, t.activeCollectors])).toEqual(
      expect.arrayContaining([
        [tokens.default.id, "default", null, 0],
        [tokens.rotate.id, "rotate", "2027-04-10T00:00:00.000Z", 0],
      ]),
    );
    expect(JSON.stringify(listed.body)).not.toContain(tokens.default.bearer);
  });

  it("answers a create's retry 200 with the fleet alone, changing nothing; another label or type for the id 409 fleet_conflict", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { label: "edge-prod" });
    const before = fake.snapshotOf(organizationId);
    clock += MINUTE;
    const retry = (fields: Record<string, unknown>) =>
      call<{ fleet: Fleet }>("POST", `/organizations/${organizationId}/fleets`, {
        id: created.fleet.id,
        label: "edge-prod",
        type: "server",
        rotateExpiresAt: at(2 * HOUR),
        actor: null,
        ...fields,
      });

    const again = await retry({});
    expect(again.status).toBe(200);
    expect(again.headers.get("cache-control")).toBeNull();
    expect(again.body).toEqual({ fleet: created.fleet });
    expect(fake.snapshotOf(organizationId)).toEqual(before);

    for (const fields of [{ label: "edge-staging" }, { type: "kubernetes-supervisor" }]) {
      const conflict = await retry(fields);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({ error: { code: "fleet_conflict", message: "A different fleet already has this id." } });
    }
    expect(fake.snapshotOf(organizationId)).toEqual(before);
  });

  it("answers another of the organization's fleets' label 409 fleet_label_taken, compared as written", async () => {
    const organizationId = await anOrganization();
    await aFleet(organizationId, { label: "edge-prod" });

    const taken = await call("POST", `/organizations/${organizationId}/fleets`, {
      label: "edge-prod",
      type: "server",
      rotateExpiresAt: null,
      actor: null,
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({
      error: { code: "fleet_label_taken", message: "Another of the organization's fleets has this label." },
    });
    // Case-sensitive; and another organization may hold the label.
    await aFleet(organizationId, { label: "Edge-Prod" });
    await aFleet(await anOrganization(), { label: "edge-prod" });
  });

  it("makes a version 4 id without one", async () => {
    const created = await aFleet(await anOrganization());

    expect(created.fleet.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([
    ["now", at(0), "rotateExpiresAt must be in the future, or null."],
    ["in the past", at(-HOUR), "rotateExpiresAt must be in the future, or null."],
    ["a leap second", "2027-12-31T23:59:60Z", "rotateExpiresAt must be an RFC 3339 date-time."],
    ["in the year 10000 in UTC", "9999-12-31T23:59:59-01:00", "rotateExpiresAt must be from the year 0001 to 9999, in UTC."],
  ])("refuses a rotateExpiresAt %s, 400", async (_label, rotateExpiresAt, message) => {
    const organizationId = await anOrganization();

    const answer = await call("POST", `/organizations/${organizationId}/fleets`, {
      label: "edge-prod",
      type: "server",
      rotateExpiresAt,
      actor: null,
    });

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: { code: "invalid_request", message } });
    expect(fake.snapshotOf(organizationId)).toMatchObject({ fleets: [], tokens: [] });
  });

  it("refuses a body the contract refuses (400) and one over 2 MiB (413)", async () => {
    const organizationId = await anOrganization();

    const unknownField = await call("POST", `/organizations/${organizationId}/fleets`, {
      label: " edge",
      type: "server",
      rotateExpiresAt: null,
      actor: null,
    });
    expect(unknownField.status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^createFleet request body: \/label must match pattern/)]);

    const created = await aFleet(organizationId, { type: "kubernetes-supervisor" });
    const tooLarge = await call("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`, {
      name: "huge",
      annotations: { a: "x".repeat(2 * 1024 * 1024) },
    });
    expect(tooLarge.status).toBe(413);
    expect(code(tooLarge)).toBe("payload_too_large");
  });

  it("lists the organization's fleets newest first, ties by id, filtered by status and paged by cursor, each with its summary", async () => {
    const organizationId = await anOrganization();
    const first = await aFleet(organizationId);
    clock += MINUTE;
    const tied = [await aFleet(organizationId), await aFleet(organizationId)].map((c) => c.fleet.id).sort().reverse();
    clock += MINUTE;
    const archived = await aFleet(organizationId);
    await call("PATCH", `/organizations/${organizationId}/fleets/${archived.fleet.id}`, { status: "archived" });
    fake.enrollCollector(organizationId, first.fleet.id);

    const all = await call<Page<Fleet>>("GET", `/organizations/${organizationId}/fleets`);
    expect(all.body.fleets?.map((f) => f.id)).toEqual([archived.fleet.id, ...tied, first.fleet.id]);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.fleets?.at(-1)?.summary).toEqual({
      collectors: 1,
      online: 1,
      warning: 0,
      unknown: 0,
      offline: 0,
      inSync: 0,
      pending: 0,
      failed: 0,
      drifted: 0,
      unassigned: 1,
      lastSeenAt: at(2 * MINUTE),
      rotateToken: { expiresAt: null, graceEndsAt: null, validCount: 1 },
    });

    const active = await call<Page<Fleet>>("GET", `/organizations/${organizationId}/fleets?status=active&limit=2`);
    expect(active.body.fleets?.map((f) => f.id)).toEqual(tied);
    const next = await call<Page<Fleet>>(
      "GET",
      `/organizations/${organizationId}/fleets?status=active&limit=2&cursor=${active.body.nextCursor ?? ""}`,
    );
    expect(next.body).toMatchObject({ fleets: [{ id: first.fleet.id }], nextCursor: null });
    const archivedOnly = await call<Page<Fleet>>("GET", `/organizations/${organizationId}/fleets?status=archived`);
    expect(archivedOnly.body.fleets?.map((f) => f.id)).toEqual([archived.fleet.id]);
  });

  it.each([
    ["not base64url", "!!"],
    ["padded", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
    ["the wrong length", "AAAA"],
    ["not a whole millisecond", Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), Buffer.alloc(16)]).toString("base64url")],
    ["before the year 0001", Buffer.concat([Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(16)]).toString("base64url")],
  ])("refuses a fleet list's cursor %s, 400", async (_label, cursor) => {
    const answer = await call("GET", `/organizations/${await anOrganization()}/fleets?cursor=${encodeURIComponent(cursor)}`);

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: { code: "invalid_request", message: "cursor isn't one this API gave." } });
  });

  it("reads one fleet with its summary, and 404 for one the organization doesn't hold", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);

    const read = await call<Fleet>("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}`);
    const missing = await call("GET", `/organizations/${organizationId}/fleets/${randomUUID()}`);

    expect(read.body).toEqual({ ...created.fleet, summary: expect.objectContaining({ collectors: 0 }) });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: "fleet_not_found", message: "The organization has no fleet with this id." } });
  });

  it("renames and archives a fleet, moving updatedAt only on a change; another fleet's label is 409", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { label: "edge-prod" });
    await aFleet(organizationId, { label: "edge-staging" });
    const path = `/organizations/${organizationId}/fleets/${created.fleet.id}`;

    clock += MINUTE;
    const same = await call<Fleet>("PATCH", path, { label: "edge-prod", status: "active" });
    expect(same.body).toEqual(created.fleet);

    const taken = await call("PATCH", path, { label: "edge-staging" });
    expect(taken.status).toBe(409);
    expect(code(taken)).toBe("fleet_label_taken");

    const renamed = await call<Fleet>("PATCH", path, { label: "edge-eu", status: "archived" });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ ...created.fleet, label: "edge-eu", status: "archived", updatedAt: at(MINUTE) });
    expect(renamed.body).not.toHaveProperty("summary");

    const missing = await call("PATCH", `/organizations/${organizationId}/fleets/${randomUUID()}`, { status: "active" });
    expect(missing.status).toBe(404);
    const empty = await call("PATCH", path, {});
    expect(empty.status).toBe(400);
    expect(fake.takeViolations()).toEqual(["updateFleet request body: (root) must NOT have fewer than 1 properties"]);
  });

  it("deletes a fleet with everything it holds, freeing its id; a second delete is 404", async () => {
    const world = await aWorld();
    const path = `/organizations/${world.organizationId}/fleets/${world.fleetId}`;

    expect((await call("DELETE", path)).status).toBe(204);

    expect(fake.snapshotOf(world.organizationId)).toMatchObject({
      fleets: [],
      groups: [],
      tokens: [],
      collectors: [],
      collectorErrors: [],
      tokenEvents: [],
    });
    expect(code(await call("GET", `${path}/groups/${world.groupId}`))).toBe("fleet_not_found");
    expect((await call("DELETE", path)).status).toBe(404);
    await aFleet(await anOrganization(), { id: world.fleetId });
  });
});

describe("the fleet model's collector groups", () => {
  it("lists the Default group first, then by name as bytes, then by id", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const path = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
    for (const name of ["émile", "beta", "Zeta"]) expect((await call("POST", path, { name })).status).toBe(201);

    const listed = await call<{ groups: Group[] }>("GET", path);

    expect(listed.body.groups.map((g) => g.name)).toEqual(["Default", "Zeta", "beta", "émile"]);
  });

  it("creates a group: 409 for a name the fleet's groups have, 422 for a published version the organization doesn't hold", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const path = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
    const own = await aPublication(organizationId);
    const another = await aPublication(await anOrganization());

    const group = await call<Group>("POST", path, { name: "gateways", assignedPublicationId: own.id.toUpperCase() });
    expect(group.status).toBe(201);
    expect(group.body).toMatchObject({ name: "gateways", isDefault: false, assignedPublicationId: own.id, createdAt: at(0) });

    const before = fake.snapshotOf(organizationId);
    for (const name of ["gateways", "Default"]) {
      const taken = await call("POST", path, { name });
      expect(taken.status).toBe(409);
      expect(code(taken)).toBe("collector_group_name_taken");
    }
    const unknown = await call("POST", path, { name: "edge", assignedPublicationId: another.id });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toEqual({
      error: { code: "publication_not_found", message: "The organization holds no published version with this id." },
    });
    expect((await call("POST", `/organizations/${organizationId}/fleets/${randomUUID()}/groups`, { name: "x" })).status).toBe(404);
    expect(fake.snapshotOf(organizationId)).toEqual(before);
  });

  // D17d-1 decision 2: the opamp-server keeps no Kubernetes field and never reads a group's annotations.
  it.each(["server", "kubernetes-supervisor"])(
    "keeps a Kubernetes group's settings in a %s fleet's group's annotations, unread, in canonical form",
    async (type) => {
      const organizationId = await anOrganization();
      const created = await aFleet(organizationId, { type });
      const groups = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;

      const group = await callRaw<Group>(
        "POST",
        groups,
        '{"name":"nodes","annotations":{"telflo":{"kubernetes":{"volumes":[{"readOnly":true,"mountPath":"/b","hostPath":"/a"}],"role":"node","namespace":"otel"}}}}',
      );
      expect(group.status).toBe(201);
      expect(JSON.stringify(group.body.annotations)).toBe(
        '{"telflo":{"kubernetes":{"namespace":"otel","role":"node","volumes":[{"hostPath":"/a","mountPath":"/b","readOnly":true}]}}}',
      );
      for (const field of ["role", "namespace", "replicas", "volumes"]) expect(group.body).not.toHaveProperty(field);
    },
  );

  // D17c-1 decision 30: collector_groups.go and store/collectorgroups' CanonicalAnnotations.
  it.each(["server", "kubernetes-supervisor"])(
    "keeps a %s fleet's group's annotations in canonical form (keys sorted at every level): created, kept by a rename, replaced whole, cleared; updatedAt only on a change",
    async (type) => {
      const organizationId = await anOrganization();
      const created = await aFleet(organizationId, { type });
      const groups = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;

      const made = await callRaw<Group>("POST", groups, '{"name":"edge","annotations":{"z":{"b":[1,{"y":null,"x":"<&>"}],"a":true},"telflo":{}}}');
      expect(made.status).toBe(201);
      expect(made.body.annotations).toEqual({ telflo: {}, z: { a: true, b: [1, { x: "<&>", y: null }] } });
      expect(JSON.stringify(made.body.annotations)).toBe('{"telflo":{},"z":{"a":true,"b":[1,{"x":"<&>","y":null}]}}');
      const path = `${groups}/${made.body.id}`;
      expect((await call<Group>("GET", path)).body).toEqual(made.body);

      clock += MINUTE;
      const same = await call<Group>("PATCH", path, { annotations: { z: { a: true, b: [1, { y: null, x: "<&>" }] }, telflo: {} } });
      expect(same.body).toEqual(made.body);
      const renamed = await call<Group>("PATCH", path, { name: "edges" });
      expect(renamed.body).toEqual({ ...made.body, name: "edges", updatedAt: at(MINUTE) });
      clock += MINUTE;
      const replaced = await call<Group>("PATCH", path, { annotations: { other: 1 } });
      expect(replaced.body).toMatchObject({ annotations: { other: 1 }, updatedAt: at(2 * MINUTE) });
      const cleared = await call<Group>("PATCH", path, { annotations: null });
      expect(cleared.body.annotations).toBeNull();
      const onDefault = await call<Group>("PATCH", `${groups}/${created.defaultGroup.id}`, { annotations: {} });
      expect(onDefault.body.annotations).toEqual({});
    },
  );

  it.each([
    ["a number with an exponent", '{"n":1e2}'],
    ["a negative zero", '{"n":-0}'],
    ["U+0000 in a string", '{"s":"a\\u0000b"}'],
    ["U+0000 in a key", '{"a\\u0000":1}'],
    ["over 16384 bytes", JSON.stringify({ a: "x".repeat(16_377) })],
  ])("refuses annotations with %s, 400, before the fleet is read", async (_label, annotations) => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const before = fake.snapshotOf(organizationId);

    for (const fleetId of [created.fleet.id, randomUUID()]) {
      const groups = `/organizations/${organizationId}/fleets/${fleetId}/groups`;
      for (const [method, path, body] of [
        ["POST", groups, `{"name":"edge","annotations":${annotations}}`],
        ["PATCH", `${groups}/${created.defaultGroup.id}`, `{"annotations":${annotations}}`],
      ] as const) {
        const answer = await callRaw(method, path, body);
        expect(answer.status).toBe(400);
        expect((answer.body as ErrorBody).error.message).toBe("annotations must be a JSON object of at most 16384 bytes, or null.");
      }
    }
    expect(fake.snapshotOf(organizationId)).toEqual(before);
  });

  it("takes annotations of 16384 canonical bytes; refuses ones that aren't an object as the contract does, recording the violation", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const groups = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
    // {"a":"…"}: 8 bytes and the x's.
    expect((await call("POST", groups, { name: "fits", annotations: { a: "x".repeat(16_376) } })).status).toBe(201);
    for (const annotations of [[], "telflo", 1]) {
      const answer = await call("POST", groups, { name: "refused", annotations });
      expect(answer.body).toEqual({ error: { code: "invalid_request", message: "The request body doesn't match the API." } });
      expect(fake.takeViolations()).toEqual([expect.stringMatching(/^createCollectorGroup request body: /)]);
    }
  });

  it("takes annotations of 16384 canonical bytes, counting U+2028 as Go escapes it (six bytes)", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { type: "kubernetes-supervisor" });
    const path = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
    const separator = String.fromCharCode(0x2028);
    // {"a":"…"}: 8 bytes and the string's.
    expect((await call("POST", path, { name: "a", annotations: { a: `${"x".repeat(16_370)}${separator}` } })).status).toBe(201);
    expect((await call("POST", path, { name: "b", annotations: { a: `${"x".repeat(16_371)}${separator}` } })).status).toBe(400);
  });

  it("bounds annotations by their canonical text with each number as written (1.50 is four bytes), as CanonicalAnnotations", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const path = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
    // {"n":1.50,"s":"x…"}: 17 bytes and the x's. JSON.stringify would write 1.5, a byte fewer.
    const body = (name: string, xs: number) => `{"name":"${name}","annotations":{"n":1.50,"s":"${"x".repeat(xs)}"}}`;

    expect((await callRaw("POST", path, body("fits", 16_367))).status).toBe(201);
    const over = await callRaw("POST", path, body("over", 16_368));
    expect(over.status).toBe(400);
    expect((over.body as ErrorBody).error.message).toBe("annotations must be a JSON object of at most 16384 bytes, or null.");
  });

  it("counts a lone surrogate in annotations as the U+FFFD Go's decoder reads it (3 bytes), and \\b and \\f as two", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const path = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
    // {"a":"…"}: 8 bytes and the string's. JSON.stringify writes a lone surrogate as \udXXX, 6 bytes.
    const surrogate = (name: string, xs: number) => `{"name":"${name}","annotations":{"a":"${"x".repeat(xs)}\\ud800"}}`;
    expect((await callRaw("POST", path, surrogate("a", 16_373))).status).toBe(201);
    expect((await callRaw("POST", path, surrogate("b", 16_374))).status).toBe(400);

    const controls = (name: string, xs: number) => `{"name":"${name}","annotations":{"a":"${"x".repeat(xs)}\\b\\f"}}`;
    expect((await callRaw("POST", path, controls("c", 16_372))).status).toBe(201);
    expect((await callRaw("POST", path, controls("d", 16_373))).status).toBe(400);
  });

  it("updates a group: rename, assign, clear; updatedAt only on a change; the Default group keeps its name", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const groups = `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`;
    const group = (await call<Group>("POST", groups, { name: "gateways" })).body;
    await call("POST", groups, { name: "edge" });
    const publication = await aPublication(organizationId);
    const path = `${groups}/${group.id}`;
    clock += MINUTE;

    const unchanged = await call<Group>("PATCH", path, { name: "gateways", assignedPublicationId: null });
    expect(unchanged.body).toEqual(group);

    const assigned = await call<Group>("PATCH", path, { name: "relays", assignedPublicationId: publication.id });
    expect(assigned.body).toEqual({ ...group, name: "relays", assignedPublicationId: publication.id, updatedAt: at(MINUTE) });
    const read = await call<Group>("GET", path);
    expect(read.body).toEqual(assigned.body);

    clock += MINUTE;
    const before = fake.snapshotOf(organizationId);
    const taken = await call("PATCH", path, { name: "edge" });
    expect([taken.status, code(taken)]).toEqual([409, "collector_group_name_taken"]);
    const unknown = await call("PATCH", path, { assignedPublicationId: randomUUID() });
    expect([unknown.status, code(unknown)]).toEqual([422, "publication_not_found"]);
    expect(fake.snapshotOf(organizationId)).toEqual(before);

    const cleared = await call<Group>("PATCH", path, { assignedPublicationId: null });
    expect(cleared.body).toMatchObject({ assignedPublicationId: null, updatedAt: at(2 * MINUTE) });

    const defaultPath = `${groups}/${created.defaultGroup.id}`;
    const renameDefault = await call("PATCH", defaultPath, { name: "Main" });
    expect(renameDefault.status).toBe(409);
    expect(renameDefault.body).toEqual({
      error: { code: "collector_group_is_default", message: "The fleet's Default group can't be renamed or deleted." },
    });
    expect((await call<Group>("PATCH", defaultPath, { name: "Default", assignedPublicationId: publication.id })).body).toMatchObject({
      name: "Default",
      assignedPublicationId: publication.id,
    });
    expect(code(await call("PATCH", `${groups}/${randomUUID()}`, { name: "x" }))).toBe("collector_group_not_found");
  });

  it("deletes a group with its collectors and their errors (D17d-1 decision 3), no other's; the Default group itself is 409", async () => {
    const world = await aWorld();
    const groups = `/organizations/${world.organizationId}/fleets/${world.fleetId}/groups`;
    const collectors = `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors`;
    const another = (await call<Group>("POST", groups, { name: "relays" })).body;
    const kept = [
      fake.enrollCollector(world.organizationId, world.fleetId),
      fake.enrollCollector(world.organizationId, world.fleetId, { groupId: another.id }),
    ];
    for (const collector of kept) fake.recordCollectorError(world.organizationId, collector.id, { message: "kept" });
    const second = fake.enrollCollector(world.organizationId, world.fleetId, { groupId: world.groupId });
    clock += MINUTE;

    const refused = await call("DELETE", `${groups}/${world.created.defaultGroup.id}`);
    expect([refused.status, code(refused)]).toEqual([409, "collector_group_is_default"]);

    expect((await call("DELETE", `${groups}/${world.groupId}`)).status).toBe(204);
    for (const id of [world.collectorId, second.id]) {
      const gone = await call("GET", `${collectors}/${id}`);
      expect([gone.status, code(gone)]).toEqual([404, "collector_not_found"]);
      const errors = await call("GET", `${collectors}/${id}/errors`);
      expect([errors.status, code(errors)]).toEqual([404, "collector_not_found"]);
    }
    const snapshot = JSON.stringify(fake.snapshotOf(world.organizationId));
    expect(snapshot).not.toContain(world.collectorId);
    expect(snapshot).not.toContain("bad config");
    for (const collector of kept) {
      expect((await call<Collector>("GET", `${collectors}/${collector.id}`)).body).toMatchObject({ id: collector.id, updatedAt: at(0) });
      const errors = await call<{ errors: { message: string }[] }>("GET", `${collectors}/${collector.id}/errors`);
      expect(errors.body.errors.map((e) => e.message)).toEqual(["kept"]);
    }
    const again = await call("DELETE", `${groups}/${world.groupId}`);
    expect([again.status, code(again)]).toEqual([404, "collector_group_not_found"]);
  });
});

describe("the fleet model's enrollment tokens", () => {
  const tokensOf = async (organizationId: string, fleetId: string) =>
    (await call<{ tokens: Token[] }>("GET", `/organizations/${organizationId}/fleets/${fleetId}/tokens`)).body.tokens;

  type TokenEvent = { id: string; tokenId: string; event: string; actor: { id: string; email: string } | null; occurredAt: string };
  const eventsOf = async (organizationId: string, fleetId: string, query = "") =>
    (await call<{ events: TokenEvent[]; nextCursor: string | null }>("GET", `/organizations/${organizationId}/fleets/${fleetId}/tokens/events${query}`))
      .body;

  it("records the token events as the server's stores: issued ×2 on a create, rotated (a valid predecessor) and issued on a rotation, viewed on a reveal of a valid token, revoked on the first revoke, each with its actor", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const fleet = `/organizations/${organizationId}/fleets/${created.fleet.id}`;
    const first = await eventsOf(organizationId, created.fleet.id);
    expect(first.nextCursor).toBeNull();
    expect(first.events.map((e) => [e.event, e.tokenId]).sort()).toEqual(
      [["issued", created.tokens.default.id], ["issued", created.tokens.rotate.id]].sort(),
    );

    clock += MINUTE;
    const rotated = await call<{ id: string; predecessorId: string | null }>("POST", `${fleet}/tokens/rotate`, { expiresAt: null, graceEndsAt: at(HOUR), actor: ACTOR });
    clock += MINUTE;
    await call("POST", `${fleet}/tokens/${created.tokens.default.id}/reveal`, { actor: ACTOR });
    clock += MINUTE;
    await call("POST", `${fleet}/tokens/${created.tokens.rotate.id}/revoke`, { actor: null });
    clock += MINUTE;
    await call("POST", `${fleet}/tokens/${created.tokens.rotate.id}/revoke`, { actor: ACTOR });
    await call("POST", `${fleet}/tokens/${created.tokens.rotate.id}/reveal`, { actor: ACTOR });

    const { events } = await eventsOf(organizationId, created.fleet.id);
    expect(events.slice(0, 2).map((e) => [e.event, e.tokenId, e.actor])).toEqual([
      ["revoked", created.tokens.rotate.id, null],
      ["viewed", created.tokens.default.id, ACTOR],
    ]);
    // One instant: ordered by id.
    expect(events.slice(2, 4).map((e) => [e.event, e.tokenId, e.actor])).toEqual(
      expect.arrayContaining([
        ["rotated", created.tokens.rotate.id, ACTOR],
        ["issued", rotated.body.id, ACTOR],
      ]),
    );
    expect(events).toHaveLength(6);

    // No valid rotate token: the rotation writes issued alone, predecessorId null.
    await call("POST", `${fleet}/tokens/${rotated.body.id}/revoke`, { actor: null });
    clock += MINUTE;
    const none = await call<{ id: string; predecessorId: string | null }>("POST", `${fleet}/tokens/rotate`, {
      expiresAt: null,
      graceEndsAt: at(2 * HOUR),
      actor: ACTOR,
    });
    expect(none.body.predecessorId).toBeNull();
    const after = (await eventsOf(organizationId, created.fleet.id)).events;
    expect(after).toHaveLength(8);
    expect(after[0]).toMatchObject({ event: "issued", tokenId: none.body.id, actor: ACTOR });
  });

  it("pages the token events newest first by the error history's cursor, refuses a cursor it didn't give, and answers another organization's fleet 404", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    fake.recordTokenEvents(organizationId, created.fleet.id, { count: 3, actor: ACTOR });
    const whole = await eventsOf(organizationId, created.fleet.id);
    expect(whole.events).toHaveLength(5);
    const joined: TokenEvent[] = [];
    let query = "?limit=2";
    for (;;) {
      const page = await eventsOf(organizationId, created.fleet.id, query);
      joined.push(...page.events);
      if (page.nextCursor === null) break;
      query = `?limit=2&cursor=${page.nextCursor}`;
    }
    expect(joined).toEqual(whole.events);

    const refused = await call("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/events?cursor=x`);
    expect(refused.status).toBe(400);
    const other = await anOrganization();
    const foreign = await call("GET", `/organizations/${other}/fleets/${created.fleet.id}/tokens/events`);
    expect(foreign.status).toBe(404);
    expect(code(foreign)).toBe("fleet_not_found");
  });

  // Task 1's review (Ruling 19): every seeded event a time the contract's date-time can carry.
  it("seeds token events only at times from the year 0001 to 9999, recording nothing otherwise", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const lastMs = AFTER_LATEST_INSTANT - 1;

    for (const occurredAt of [new Date(AFTER_LATEST_INSTANT), new Date(AFTER_LATEST_INSTANT + 1)]) {
      expect(() => fake.recordTokenEvents(organizationId, created.fleet.id, { count: 1, occurredAt })).toThrow(
        "recordTokenEvents: the newest event is after the year 9999",
      );
    }
    expect(() => fake.recordTokenEvents(organizationId, created.fleet.id, { count: 2, occurredAt: new Date(EARLIEST_INSTANT) })).toThrow(
      "recordTokenEvents: the oldest event is before the year 0001",
    );
    expect((await eventsOf(organizationId, created.fleet.id)).events).toHaveLength(2);

    // The last millisecond of 9999, and the first of 0001, are kept.
    expect(fake.recordTokenEvents(organizationId, created.fleet.id, { count: 1, occurredAt: new Date(lastMs) })).toEqual({ count: 1 });
    expect(fake.recordTokenEvents(organizationId, created.fleet.id, { count: 1, occurredAt: new Date(EARLIEST_INSTANT) })).toEqual({ count: 1 });
    const { events } = await eventsOf(organizationId, created.fleet.id);
    expect(events).toHaveLength(4);
    expect(events[0]!.occurredAt).toBe("9999-12-31T23:59:59.999Z");
    expect(events.at(-1)!.occurredAt).toBe("0001-01-01T00:00:00.000Z");
  });

  it("rotates: the current rotate token's grace ends at graceEndsAt, it pushes its successor, and the new one is current", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const rotate = `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/rotate`;

    const first = await call<{ id: string; bearer: string; expiresAt: string | null; predecessorId: string | null }>("POST", rotate, {
      expiresAt: at(30 * 24 * HOUR),
      graceEndsAt: at(24 * HOUR),
      actor: ACTOR,
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toEqual({
      id: expect.any(String),
      bearer: expect.stringMatching(BEARER),
      expiresAt: at(30 * 24 * HOUR),
      predecessorId: created.tokens.rotate.id,
    });

    // Rotated again in the same millisecond: the token in its grace, made at
    // the same instant, isn't current (doRefresh first, whatever the ids),
    // the one made by the first rotation is.
    const second = await call<{ id: string; predecessorId: string }>("POST", rotate, {
      expiresAt: null,
      graceEndsAt: at(2 * HOUR),
      actor: null,
    });
    expect(second.body.predecessorId).toBe(first.body.id);

    // All made at one instant: listed by id, descending.
    const listed = await tokensOf(organizationId, created.fleet.id);
    expect(listed.map((t) => t.id)).toEqual(listed.map((t) => t.id).sort().reverse());
    expect(listed.map((t) => [t.id, t.kind, t.expiresAt, t.doRefresh])).toEqual(
      expect.arrayContaining([
        [second.body.id, "rotate", null, false],
        [first.body.id, "rotate", at(2 * HOUR), true],
        [created.tokens.rotate.id, "rotate", at(24 * HOUR), true],
        [created.tokens.default.id, "default", null, false],
      ]),
    );
    expect(listed).toHaveLength(4);
  });

  it("answers each fleet's last seen and rotate token state in its summary, as the server's stores (D17a Preflight ruling 2)", async () => {
    const organizationId = await anOrganization();
    const other = await anOrganization();
    const DAY = 24 * HOUR;
    const YEAR = 365 * DAY;
    const names = new Map<string, string>();
    const fleet = async (name: string, rotateExpiresAt: string | null, organization = organizationId) => {
      const created = await aFleet(organization, { rotateExpiresAt });
      names.set(created.fleet.id, name);
      return created;
    };
    const rotate = async (created: Created, expiresAt: string | null, graceEndsAt: string) => {
      const answer = await call<{ id: string }>("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/rotate`, {
        expiresAt,
        graceEndsAt,
        actor: null,
      });
      expect(answer.status).toBe(201);
      return answer.body.id;
    };
    const revoke = async (created: Created, tokenId: string) =>
      expect((await call("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/${tokenId}/revoke`, { actor: null })).status).toBe(200);

    const dated = await fleet("dated", at(YEAR));
    await fleet("never", null);
    const revoked = await fleet("revoked", at(YEAR));
    await revoke(revoked, revoked.tokens.rotate.id);
    const theirs = await fleet("theirs", at(YEAR), other);
    // The latest last seen: neither the last enrolled nor another organization's.
    fake.enrollCollector(organizationId, dated.fleet.id, { lastSeenAt: new Date(BASE + 2 * MINUTE) });
    fake.enrollCollector(organizationId, dated.fleet.id, { lastSeenAt: new Date(BASE + MINUTE) });
    fake.enrollCollector(other, theirs.fleet.id, { lastSeenAt: new Date(BASE + 5 * MINUTE) });

    clock += MINUTE;
    const several = await fleet("several", at(YEAR));
    await rotate(several, at(180 * DAY), at(2 * HOUR));
    const capped = await fleet("capped", at(YEAR));
    await rotate(capped, null, at(2 * YEAR));
    const fallback = await fleet("fallback", at(YEAR));
    await revoke(fallback, await rotate(fallback, at(180 * DAY), at(2 * HOUR)));
    const expiring = await fleet("expiring", at(YEAR));
    await rotate(expiring, at(2 * HOUR), at(HOUR));
    clock = BASE + 90 * MINUTE;
    await rotate(several, null, at(3 * HOUR));

    const read = async (now: number) => {
      clock = now;
      const page = await call<Page<Fleet>>("GET", `/organizations/${organizationId}/fleets`);
      const one = await call<Fleet>("GET", `/organizations/${organizationId}/fleets/${dated.fleet.id}`);
      expect(one.body.summary).toEqual(page.body.fleets?.find((f) => f.id === dated.fleet.id)?.summary);
      return Object.fromEntries(
        (page.body.fleets ?? []).map((f) => [names.get(f.id), f.summary?.rotateToken]).filter(([, state]) => state !== null),
      );
    };
    const token = (expiresAt: string | null, graceEndsAt: string | null, validCount: number) => ({ expiresAt, graceEndsAt, validCount });

    expect(await read(BASE + 100 * MINUTE)).toEqual({
      dated: token(at(YEAR), null, 1),
      never: token(null, null, 1),
      several: token(null, at(3 * HOUR), 3),
      capped: token(null, at(YEAR), 2),
      fallback: token(at(2 * HOUR), null, 1),
      expiring: token(at(2 * HOUR), null, 1),
    });
    expect(await read(BASE + 2 * HOUR)).toEqual({
      dated: token(at(YEAR), null, 1),
      never: token(null, null, 1),
      several: token(null, at(3 * HOUR), 2),
      capped: token(null, at(YEAR), 2),
    });
    expect(await read(BASE + 3 * HOUR)).toEqual({
      dated: token(at(YEAR), null, 1),
      never: token(null, null, 1),
      several: token(null, null, 1),
      capped: token(null, at(YEAR), 2),
    });
    expect(await read(BASE + YEAR - 1)).toMatchObject({ dated: token(at(YEAR), null, 1), capped: token(null, at(YEAR), 2) });
    expect(await read(BASE + YEAR)).toEqual({
      never: token(null, null, 1),
      several: token(null, null, 1),
      capped: token(null, null, 1),
    });

    const page = await call<Page<Fleet>>("GET", `/organizations/${organizationId}/fleets`);
    const lastSeen = Object.fromEntries((page.body.fleets ?? []).map((f) => [names.get(f.id), f.summary?.lastSeenAt]));
    expect(lastSeen).toMatchObject({ dated: at(2 * MINUTE), never: null, revoked: null });
    expect(page.body.fleets?.find((f) => f.id === revoked.fleet.id)?.summary).toMatchObject({ rotateToken: null });
  });

  it("lists a fleet's tokens newest first", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    clock += MINUTE;
    const rotated = await call<{ id: string }>("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/rotate`, {
      expiresAt: null,
      graceEndsAt: at(2 * MINUTE),
      actor: null,
    });

    const listed = await tokensOf(organizationId, created.fleet.id);

    expect(listed[0]).toMatchObject({ id: rotated.body.id, createdAt: at(MINUTE), createdBy: null });
    expect(listed.slice(1).map((t) => t.createdAt)).toEqual([at(0), at(0)]);
  });

  it("never lengthens a token's life: a grace past the token's own expiry leaves its expiry", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { rotateExpiresAt: at(HOUR) });

    const rotated = await call<{ predecessorId: string }>("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/rotate`, {
      expiresAt: null,
      graceEndsAt: at(24 * HOUR),
      actor: null,
    });

    expect(rotated.body.predecessorId).toBe(created.tokens.rotate.id);
    const old = (await tokensOf(organizationId, created.fleet.id)).find((t) => t.id === created.tokens.rotate.id);
    expect(old).toMatchObject({ expiresAt: at(HOUR), doRefresh: true });
  });

  it.each([
    ["the newer", MINUTE],
    ["at one instant, the greater id", 0],
  ])("picks, among rotate tokens all in their grace, %s as current", async (_label, step) => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const fleetId = created.fleet.id;
    const tokens = `/organizations/${organizationId}/fleets/${fleetId}/tokens`;
    const rotation = { expiresAt: null, graceEndsAt: at(24 * HOUR), actor: null };
    clock += step;
    const first = await call<{ id: string }>("POST", `${tokens}/rotate`, rotation);
    clock += step;
    const second = await call<{ id: string }>("POST", `${tokens}/rotate`, rotation);
    // The current one revoked: the original and the first are both in their grace.
    await call("POST", `${tokens}/${second.body.id}/revoke`, { actor: null });

    const third = await call<{ predecessorId: string }>("POST", `${tokens}/rotate`, { ...rotation, graceEndsAt: at(HOUR) });

    const expected = step > 0 ? first.body.id : [created.tokens.rotate.id, first.body.id].sort().reverse()[0];
    expect(third.body.predecessorId).toBe(expected);
    const listed = await tokensOf(organizationId, fleetId);
    expect(listed.find((t) => t.id === expected)).toMatchObject({ expiresAt: at(HOUR), doRefresh: true });
  });

  it("names no predecessor when the fleet has no valid rotate token", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { rotateExpiresAt: at(MINUTE) });
    clock += MINUTE;

    const rotated = await call<{ predecessorId: string | null }>(
      "POST",
      `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/rotate`,
      { expiresAt: null, graceEndsAt: at(2 * MINUTE), actor: null },
    );

    expect(rotated.status).toBe(201);
    expect(rotated.body.predecessorId).toBeNull();
  });

  it.each([
    ["a grace end now", { expiresAt: null, graceEndsAt: at(0) }, "graceEndsAt must be in the future."],
    ["a grace end after the expiry", { expiresAt: at(HOUR), graceEndsAt: at(HOUR + 1) }, "graceEndsAt must not be after expiresAt."],
    ["a leap second", { expiresAt: "2027-06-30T23:59:60Z", graceEndsAt: at(HOUR) }, "expiresAt must be an RFC 3339 date-time."],
    ["a grace end at a leap second", { expiresAt: null, graceEndsAt: "2027-06-30T23:59:60Z" }, "graceEndsAt must be an RFC 3339 date-time."],
  ])("refuses a rotation with %s, 400, rotating nothing", async (_label, fields, message) => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const before = fake.snapshotOf(organizationId);

    const answer = await call("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/rotate`, { ...fields, actor: null });

    expect(answer.body).toEqual({ error: { code: "invalid_request", message } });
    expect(fake.snapshotOf(organizationId)).toEqual(before);
  });

  it("refuses rotating an archived fleet's token, 409 fleet_archived, and a fleet the organization doesn't hold, 404", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    await call("PATCH", `/organizations/${organizationId}/fleets/${created.fleet.id}`, { status: "archived" });
    const before = fake.snapshotOf(organizationId);
    const body = { expiresAt: null, graceEndsAt: at(HOUR), actor: null };

    const archived = await call("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/rotate`, body);
    const missing = await call("POST", `/organizations/${organizationId}/fleets/${randomUUID()}/tokens/rotate`, body);

    expect(archived.body).toEqual({ error: { code: "fleet_archived", message: "The fleet is archived." } });
    expect(archived.status).toBe(409);
    expect([missing.status, code(missing)]).toEqual([404, "fleet_not_found"]);
    expect(fake.snapshotOf(organizationId)).toEqual(before);
  });

  it("reveals a fresh bearer each time, no-store, an archived fleet's too; 409 for a revoked or an expired token", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { rotateExpiresAt: at(HOUR) });
    const tokens = `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens`;
    await call("PATCH", `/organizations/${organizationId}/fleets/${created.fleet.id}`, { status: "archived" });

    const first = await call<{ id: string; kind: string; bearer: string; expiresAt: string | null }>(
      "POST",
      `${tokens}/${created.tokens.default.id}/reveal`,
      { actor: null },
    );
    const second = await call<{ bearer: string }>("POST", `${tokens}/${created.tokens.default.id}/reveal`, { actor: ACTOR });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toEqual({ id: created.tokens.default.id, kind: "default", bearer: expect.stringMatching(BEARER), expiresAt: null });
    expect(second.body.bearer).not.toBe(first.body.bearer);

    clock += HOUR - 1;
    expect((await call("POST", `${tokens}/${created.tokens.rotate.id}/reveal`, { actor: null })).status).toBe(200);
    clock += 1;
    const expired = await call("POST", `${tokens}/${created.tokens.rotate.id}/reveal`, { actor: null });
    expect(expired.status).toBe(409);
    expect(expired.body).toEqual({ error: { code: "enrollment_token_expired", message: "The enrollment token has expired." } });

    await call("POST", `${tokens}/${created.tokens.default.id}/revoke`, { actor: null });
    const revoked = await call("POST", `${tokens}/${created.tokens.default.id}/reveal`, { actor: null });
    expect(revoked.body).toEqual({ error: { code: "enrollment_token_revoked", message: "The enrollment token is revoked." } });
    const missing = await call("POST", `${tokens}/${randomUUID()}/reveal`, { actor: null });
    expect([missing.status, code(missing)]).toEqual([404, "enrollment_token_not_found"]);
  });

  // D17c-1 decision 29: enrollment_tokens.go's issueDefaultEnrollmentToken.
  it("issues a new default token only once the fleet's default token is revoked: 201 no-store with an issued event, the revoked one kept; 409 enrollment_token_default_exists otherwise, changing nothing", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const tokens = `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens`;
    const before = fake.snapshotOf(organizationId);

    const valid = await call("POST", `${tokens}/default`, { actor: ACTOR });
    expect([valid.status, valid.body]).toEqual([
      409,
      { error: { code: "enrollment_token_default_exists", message: "The fleet already has a valid default token." } },
    ]);
    expect(fake.snapshotOf(organizationId)).toEqual(before);

    await call("POST", `${tokens}/${created.tokens.default.id}/revoke`, { actor: null });
    clock += MINUTE;
    const issued = await call<{ id: string; kind: string; bearer: string; expiresAt: string | null }>("POST", `${tokens}/default`, {
      actor: ACTOR,
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(issued.body).toEqual({ id: expect.any(String), kind: "default", bearer: expect.stringMatching(BEARER), expiresAt: null });
    expect(issued.body.id).not.toBe(created.tokens.default.id);
    const listed = await tokensOf(organizationId, created.fleet.id);
    expect(listed.filter((t) => t.kind === "default").map((t) => [t.id, t.revokedAt])).toEqual([
      [issued.body.id, null],
      [created.tokens.default.id, at(0)],
    ]);
    expect((await eventsOf(organizationId, created.fleet.id)).events[0]).toMatchObject({ event: "issued", tokenId: issued.body.id, actor: ACTOR, occurredAt: at(MINUTE) });

    const again = await call("POST", `${tokens}/default`, { actor: null });
    expect([again.status, code(again)]).toEqual([409, "enrollment_token_default_exists"]);
    // The new token is what enrolls and what a seeding names by default.
    const enrolled = fake.enrollCollector(organizationId, created.fleet.id);
    const read = await call<Collector>("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/${enrolled.id}`);
    expect(read.body.enrollmentTokenId).toBe(issued.body.id);
    fake.recordTokenEvents(organizationId, created.fleet.id, { count: 1, event: "viewed", occurredAt: new Date(BASE + 2 * MINUTE) });
    expect((await eventsOf(organizationId, created.fleet.id)).events[0]).toMatchObject({ event: "viewed", tokenId: issued.body.id });
  });

  it("names, once every default token is revoked, the newest as the token list orders them (createdAt, then id), whatever order they were made in", async () => {
    const organizationId = await anOrganization();
    // Two revoked default tokens made at one instant: the map's order is
    // the order they were made, the list's the larger id first. Fleets until
    // both cases are seen (each fleet is either at even odds).
    const seen = new Set<boolean>();
    for (let n = 0; n < 40 && seen.size < 2; n++) {
      const created = await aFleet(organizationId);
      const tokens = `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens`;
      await call("POST", `${tokens}/${created.tokens.default.id}/revoke`, { actor: null });
      const issued = await call<{ id: string }>("POST", `${tokens}/default`, { actor: null });
      await call("POST", `${tokens}/${issued.body.id}/revoke`, { actor: null });
      const listed = (await tokensOf(organizationId, created.fleet.id)).filter((t) => t.kind === "default").map((t) => t.id);
      expect(listed).toEqual([issued.body.id, created.tokens.default.id].sort().reverse());
      seen.add(issued.body.id > created.tokens.default.id);
      fake.recordTokenEvents(organizationId, created.fleet.id, { count: 1, event: "viewed", occurredAt: new Date(clock + MINUTE) });
      expect((await eventsOf(organizationId, created.fleet.id)).events[0]).toMatchObject({ event: "viewed", tokenId: listed[0] });
    }
    expect(seen.size).toBe(2);
  });

  it("refuses a new default token on an archived fleet 409 fleet_archived, before its default token is looked at, and a fleet the organization doesn't hold 404", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const archived = await aFleet(organizationId);
    await call("POST", `/organizations/${organizationId}/fleets/${archived.fleet.id}/tokens/${archived.tokens.default.id}/revoke`, { actor: null });
    await call("PATCH", `/organizations/${organizationId}/fleets/${archived.fleet.id}`, { status: "archived" });
    await call("PATCH", `/organizations/${organizationId}/fleets/${created.fleet.id}`, { status: "archived" });
    const other = await anOrganization();
    const before = [fake.snapshotOf(organizationId), fake.snapshotOf(other)];

    for (const fleetId of [archived.fleet.id, created.fleet.id]) {
      const answer = await call("POST", `/organizations/${organizationId}/fleets/${fleetId}/tokens/default`, { actor: ACTOR });
      expect([answer.status, answer.body]).toEqual([409, { error: { code: "fleet_archived", message: "The fleet is archived." } }]);
    }
    const missing = await call("POST", `/organizations/${organizationId}/fleets/${randomUUID()}/tokens/default`, { actor: ACTOR });
    expect([missing.status, code(missing)]).toEqual([404, "fleet_not_found"]);
    const theirs = await call("POST", `/organizations/${other}/fleets/${archived.fleet.id}/tokens/default`, { actor: ACTOR });
    expect([theirs.status, code(theirs)]).toEqual([404, "fleet_not_found"]);
    expect([fake.snapshotOf(organizationId), fake.snapshotOf(other)]).toEqual(before);
  });

  it("revokes once: a revoked token's revoke answers it as it is", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const revoke = `/organizations/${organizationId}/fleets/${created.fleet.id}/tokens/${created.tokens.default.id}/revoke`;

    const first = await call<Token>("POST", revoke, { actor: ACTOR });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: created.tokens.default.id, kind: "default", revokedAt: at(0), createdBy: ACTOR });
    expect(first.body).not.toHaveProperty("activeCollectors");
    expect(first.headers.get("cache-control")).toBeNull();

    clock += HOUR;
    const before = fake.snapshotOf(organizationId);
    const again = await call<Token>("POST", revoke, { actor: null });
    expect(again.body).toEqual(first.body);
    expect(fake.snapshotOf(organizationId)).toEqual(before);
  });

  it("counts the collectors seen on each token in the last 5 minutes, the edge excluded", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    fake.enrollCollector(organizationId, created.fleet.id, { lastSeenAt: new Date(BASE - 5 * MINUTE + 1) });
    fake.enrollCollector(organizationId, created.fleet.id, { lastSeenAt: new Date(BASE - 5 * MINUTE) });
    fake.enrollCollector(organizationId, created.fleet.id, { tokenId: created.tokens.rotate.id });

    const listed = await tokensOf(organizationId, created.fleet.id);

    expect(Object.fromEntries(listed.map((t) => [t.kind, t.activeCollectors]))).toEqual({ default: 1, rotate: 1 });
  });
});

describe("the fleet model's collectors: liveness and drift at the injected clock", () => {
  it.each([
    [-5_000, "online"],
    [0, "online"],
    [59_999, "online"],
    [60_000, "warning"],
    [119_999, "warning"],
    [120_000, "unknown"],
    [299_999, "unknown"],
    [300_000, "offline"],
  ])("a collector last seen %i ms ago is %s, in its read and in its fleet's summary", async (age, liveness) => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const collector = fake.enrollCollector(organizationId, created.fleet.id);
    clock += age;

    const read = await call<Collector>("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/${collector.id}`);
    const fleet = await call<Fleet>("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}`);

    expect(read.body.liveness).toBe(liveness);
    expect(fleet.body.summary).toMatchObject({ collectors: 1, [liveness]: 1 });
  });

  it("derives drift from hashes: unassigned, pending, inSync, drifted, failed; a pin wins over the group", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const fleetId = created.fleet.id;
    const assigned = await aPublication(organizationId);
    const pinned = await aPublication(organizationId);
    const collector = fake.enrollCollector(organizationId, fleetId, { name: "edge-01" });
    const path = `/organizations/${organizationId}/fleets/${fleetId}/collectors/${collector.id}`;
    const read = async () => (await call<Collector>("GET", path)).body;

    expect(await read()).toMatchObject({ resolution: null, sync: "unassigned", served: null, effective: null });

    await call("PATCH", `/organizations/${organizationId}/fleets/${fleetId}/groups/${created.defaultGroup.id}`, {
      assignedPublicationId: assigned.id,
    });
    expect(await read()).toMatchObject({
      resolution: { from: "groupPublication", id: assigned.id, sha256: assigned.sha256 },
      sync: "pending",
    });

    fake.setCollectorState(organizationId, collector.id, { served: { kind: "publication", id: assigned.id } });
    expect((await read()).sync).toBe("pending");
    const states: [NonNullable<Parameters<FakeOpampServer["setCollectorState"]>[2]["effective"]>, string][] = [
      [{ sha256: assigned.sha256, status: "applying" }, "pending"],
      [{ sha256: assigned.sha256, status: "applied" }, "inSync"],
      [{ sha256: pinned.sha256, status: "applied" }, "drifted"],
      [{ sha256: assigned.sha256, status: "failed", error: "bad receiver" }, "failed"],
      [{ sha256: assigned.sha256, status: "applied", at: new Date(BASE - 1) }, "pending"],
    ];
    for (const [effective, drift] of states) {
      fake.setCollectorState(organizationId, collector.id, { effective });
      expect((await read()).sync).toBe(drift);
    }
    expect((await read()).effective).toEqual({ sha256: assigned.sha256, status: "applied", error: null, at: at(-1) });

    const pin = await call<Collector>("PATCH", path, { pin: { kind: "publication", id: pinned.id } });
    expect(pin.body).toMatchObject({
      pin: { kind: "publication", id: pinned.id },
      resolution: { from: "pinnedPublication", id: pinned.id, sha256: pinned.sha256 },
      sync: "pending",
    });

    const summary = (await call<Fleet>("GET", `/organizations/${organizationId}/fleets/${fleetId}`)).body.summary;
    expect(summary).toMatchObject({ collectors: 1, pending: 1 });
  });

  it("answers a collector as the contract has it: served, effective, reported and its token", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const publication = await aPublication(organizationId);
    const collector = fake.enrollCollector(organizationId, created.fleet.id, {
      name: "edge-01",
      tokenId: created.tokens.rotate.id,
      reported: { collectorVersion: "0.162.0", ip: "10.0.0.5", hostIp: "192.168.1.5", attributes: { "host.name": "edge-01" } },
    });
    fake.setCollectorState(organizationId, collector.id, {
      served: { kind: "publication", id: publication.id, at: new Date(BASE + 1) },
      effective: { sha256: publication.sha256, status: "applied", at: new Date(BASE + 2) },
      reported: { ip: null },
      lastSeenAt: new Date(BASE + 3),
    });
    clock += 3;

    const read = await call<Collector>("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/${collector.id}`);

    expect(read.body).toEqual({
      id: collector.id,
      instanceUid: collector.instanceUid,
      name: "edge-01",
      fleetId: created.fleet.id,
      groupId: created.defaultGroup.id,
      pin: null,
      pinnedVariableGroupId: null,
      resolution: null,
      served: { kind: "publication", id: publication.id, sha256: publication.sha256, at: at(1) },
      effective: { sha256: publication.sha256, status: "applied", error: null, at: at(2) },
      reported: { collectorVersion: "0.162.0", ip: null, hostIp: "192.168.1.5", attributes: { "host.name": "edge-01" } },
      enrollmentTokenId: created.tokens.rotate.id,
      lastSeenAt: at(3),
      liveness: "online",
      sync: "unassigned",
      createdAt: at(0),
      updatedAt: at(0),
    });
  });
});

describe("the fleet model's collector list", () => {
  async function threeCollectors() {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const fleetId = created.fleet.id;
    const group = (await call<Group>("POST", `/organizations/${organizationId}/fleets/${fleetId}/groups`, { name: "edge" })).body;
    const beta = fake.enrollCollector(organizationId, fleetId, { name: "beta", lastSeenAt: new Date(BASE + 3000) });
    clock += 1000;
    const alpha = fake.enrollCollector(organizationId, fleetId, {
      name: "Alpha",
      groupId: group.id,
      reported: { ip: "10.0.0.5" },
      lastSeenAt: new Date(BASE + 1000),
    });
    clock += 1000;
    const emile = fake.enrollCollector(organizationId, fleetId, {
      name: "émile 100%_off",
      reported: { hostIp: "192.168.7.7" },
      lastSeenAt: new Date(BASE + 2000),
    });
    return { organizationId, fleetId, groupId: group.id, beta: beta.id, alpha: alpha.id, emile: emile.id };
  }

  const list = async (organizationId: string, fleetId: string, query: string) =>
    call<Page<Collector>>("GET", `/organizations/${organizationId}/fleets/${fleetId}/collectors${query}`);

  it("sorts by created (the default, newest first), lastSeen or name as bytes, in either order", async () => {
    const w = await threeCollectors();
    const ids = async (query: string) => (await list(w.organizationId, w.fleetId, query)).body.collectors?.map((c) => c.id);

    expect(await ids("")).toEqual([w.emile, w.alpha, w.beta]);
    expect(await ids("?sort=created&order=asc")).toEqual([w.beta, w.alpha, w.emile]);
    expect(await ids("?sort=lastSeen")).toEqual([w.beta, w.emile, w.alpha]);
    expect(await ids("?sort=lastSeen&order=asc")).toEqual([w.alpha, w.emile, w.beta]);
    expect(await ids("?sort=name&order=asc")).toEqual([w.alpha, w.beta, w.emile]);
    expect(await ids("?sort=name")).toEqual([w.emile, w.beta, w.alpha]);
  });

  it("keeps q's matches in the name or either address, ignoring case, % and _ taken literally; and groupId's", async () => {
    const w = await threeCollectors();
    const ids = async (query: string) => (await list(w.organizationId, w.fleetId, query)).body.collectors?.map((c) => c.id);

    expect(await ids("?q=ALP")).toEqual([w.alpha]);
    expect(await ids("?q=0.0.5")).toEqual([w.alpha]);
    expect(await ids("?q=168.7")).toEqual([w.emile]);
    expect(await ids(`?q=${encodeURIComponent("%_")}`)).toEqual([w.emile]);
    expect(await ids(`?q=${encodeURIComponent("a%")}`)).toEqual([]);
    expect(await ids(`?groupId=${w.groupId.toUpperCase()}`)).toEqual([w.alpha]);
    expect(await ids(`?q=a&groupId=${w.groupId}`)).toEqual([w.alpha]);
  });

  it.each([
    ["created", "desc"],
    ["created", "asc"],
    ["lastSeen", "desc"],
    ["name", "asc"],
    ["name", "desc"],
  ])("pages by %s %s with cursors, a page at a time to the last", async (sort, order) => {
    const w = await threeCollectors();
    const whole = (await list(w.organizationId, w.fleetId, `?sort=${sort}&order=${order}`)).body.collectors?.map((c) => c.id);

    const paged: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const answer: Answer<Page<Collector>> = await list(
        w.organizationId,
        w.fleetId,
        `?sort=${sort}&order=${order}&limit=1${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      paged.push(...(answer.body.collectors ?? []).map((c) => c.id));
      cursor = answer.body.nextCursor;
    }

    expect(paged).toEqual(whole);
    expect(cursor).toBeNull();
  });

  it("refuses a cursor of another sort or order, or one it didn't give, 400", async () => {
    const w = await threeCollectors();
    const cursor = (await list(w.organizationId, w.fleetId, "?sort=name&limit=1")).body.nextCursor as string;

    const raw = (head: number[], key: Buffer) => Buffer.concat([Buffer.from(head), key, Buffer.alloc(16)]).toString("base64url");
    const micros = (n: bigint) => {
      const key = Buffer.alloc(8);
      key.writeBigInt64BE(n);
      return key;
    };
    const refused = [
      `?cursor=${cursor}`,
      `?sort=name&order=asc&cursor=${cursor}`,
      "?cursor=AQAA",
      `?cursor=${raw([2, 0, 1], micros(1000n))}`,
      `?cursor=${raw([1, 3, 1], micros(1000n))}`,
      `?cursor=${raw([1, 0, 2], micros(1000n))}`,
      `?cursor=${raw([1, 0, 1], Buffer.alloc(7))}`,
      `?cursor=${raw([1, 0, 1], micros(1001n))}`,
      `?cursor=${raw([1, 0, 1], micros(BigInt(Date.UTC(10000, 0, 1)) * 1000n))}`,
      `?sort=name&cursor=${raw([1, 2, 1], Buffer.from(" edge", "utf8"))}`,
      `?sort=name&cursor=${raw([1, 2, 1], Buffer.from([0xff, 0x41]))}`,
    ];
    for (const query of refused) {
      const answer = await list(w.organizationId, w.fleetId, query);
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: { code: "invalid_request", message: "cursor isn't one this API gave." } });
    }
    expect((await list(w.organizationId, w.fleetId, `?sort=name&cursor=${cursor}`)).status).toBe(200);
  });

  it("answers a fleet the organization doesn't hold 404 on a first page, and an empty page after a cursor (Ruling 38)", async () => {
    const w = await threeCollectors();
    const cursor = (await list(w.organizationId, w.fleetId, "?limit=1")).body.nextCursor as string;
    const other = randomUUID();

    const first = await list(w.organizationId, other, "");
    const after = await list(w.organizationId, other, `?cursor=${cursor}`);

    expect([first.status, code(first)]).toEqual([404, "fleet_not_found"]);
    expect(after.body).toEqual({ collectors: [], nextCursor: null });
  });
});

describe("the fleet model's collector changes", () => {
  it("pins up to 500 at once: the ids sorted and once, the fleet's updated, the others notFound; null unpins", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const other = await aFleet(organizationId);
    const publication = await aPublication(organizationId);
    const mine = [1, 2, 3].map(() => fake.enrollCollector(organizationId, created.fleet.id).id);
    const theirs = fake.enrollCollector(organizationId, other.fleet.id).id;
    const stranger = randomUUID();
    const pin = `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/pin`;
    clock += MINUTE;

    const answer = await call<{ updated: string[]; notFound: string[] }>("POST", pin, {
      collectorIds: [mine[2], stranger.toUpperCase(), mine[0], theirs, mine[0], mine[1]],
      pin: { kind: "publication", id: publication.id },
    });

    expect(answer.body).toEqual({ updated: [...mine].sort(), notFound: [stranger, theirs].sort() });
    const read = await call<Collector>("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/${mine[0]}`);
    expect(read.body).toMatchObject({ pin: { kind: "publication", id: publication.id }, updatedAt: at(MINUTE) });

    clock += MINUTE;
    const again = await call<{ updated: string[] }>("POST", pin, { collectorIds: [mine[0]], pin: { kind: "publication", id: publication.id } });
    expect(again.body.updated).toEqual([mine[0]]);
    expect((await call<Collector>("GET", `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/${mine[0]}`)).body.updatedAt).toBe(
      at(MINUTE),
    );
    await call("POST", pin, { collectorIds: mine, pin: null });
    expect(fake.snapshotOf(organizationId)).toMatchObject({ collectors: expect.not.arrayContaining([expect.objectContaining({ pinned: expect.anything() })]) });
  });

  it("pins nothing for a published version the organization doesn't hold (422), or a pin of another kind (400, an import's since D16c)", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const collector = fake.enrollCollector(organizationId, created.fleet.id);
    const anotherOrganizations = await aPublication(await anOrganization());
    const before = fake.snapshotOf(organizationId);
    const pin = `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/pin`;

    const publication = await call("POST", pin, { collectorIds: [collector.id], pin: { kind: "publication", id: anotherOrganizations.id } });
    const imported = await call("POST", pin, { collectorIds: [collector.id], pin: { kind: "import", id: randomUUID() } });

    expect([publication.status, code(publication)]).toEqual([422, "publication_not_found"]);
    expect(imported.body).toEqual({ error: { code: "invalid_request", message: "The request body doesn't match the API." } });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^pinCollectorInstances request body: /)]);
    expect(fake.snapshotOf(organizationId)).toEqual(before);
    expect((await call("POST", `/organizations/${organizationId}/fleets/${randomUUID()}/collectors/pin`, { collectorIds: [collector.id], pin: null })).status).toBe(404);
  });

  it("updates a collector all or nothing, checking the collector, the group, the pin's target, then the name", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const other = await aFleet(organizationId);
    const group = (await call<Group>("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`, { name: "edge" })).body;
    const collector = fake.enrollCollector(organizationId, created.fleet.id, { name: "edge-01" });
    fake.enrollCollector(organizationId, other.fleet.id, { name: "edge-02" });
    const publication = await aPublication(organizationId);
    const path = `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/${collector.id}`;
    const before = fake.snapshotOf(organizationId);
    const all = (fields: Record<string, unknown>) =>
      call("PATCH", path, { name: "edge-02", groupId: group.id, pin: { kind: "publication", id: publication.id }, ...fields });

    const missing = await call("PATCH", `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors/${randomUUID()}`, {
      groupId: randomUUID(),
    });
    expect([missing.status, code(missing)]).toEqual([404, "collector_not_found"]);
    const noGroup = await all({ groupId: randomUUID() });
    expect(noGroup.body).toEqual({ error: { code: "collector_group_not_found", message: "The fleet has no collector group with this id." } });
    const noTarget = await all({ pin: { kind: "publication", id: randomUUID() } });
    expect([noTarget.status, code(noTarget)]).toEqual([422, "publication_not_found"]);
    const taken = await all({});
    expect(taken.body).toEqual({ error: { code: "collector_name_taken", message: "Another of the organization's collectors has this name." } });
    expect(fake.snapshotOf(organizationId)).toEqual(before);

    clock += MINUTE;
    const unchanged = await call<Collector>("PATCH", path, { name: "edge-01", pin: null, groupId: created.defaultGroup.id });
    expect(unchanged.body.updatedAt).toBe(at(0));
    const updated = await call<Collector>("PATCH", path, { name: "edge-03", groupId: group.id, pin: { kind: "publication", id: publication.id } });
    expect(updated.body).toMatchObject({
      name: "edge-03",
      groupId: group.id,
      pin: { kind: "publication", id: publication.id },
      updatedAt: at(MINUTE),
    });
  });

  it("deletes a collector with its errors; a second delete is 404", async () => {
    const world = await aWorld();
    const path = `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors/${world.collectorId}`;

    expect((await call("DELETE", path)).status).toBe(204);
    expect(fake.snapshotOf(world.organizationId)).toMatchObject({ collectors: [], collectorErrors: [] });
    expect(code(await call("DELETE", path))).toBe("collector_not_found");
  });

  it("lists a collector's errors newest first, paged, keeping its newest 100", async () => {
    const world = await aWorld();
    const errors = `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors/${world.collectorId}/errors`;
    for (let n = 1; n <= 100; n++) {
      fake.recordCollectorError(world.organizationId, world.collectorId, {
        message: `failure ${n}`,
        configSha256: n === 100 ? sha256("x") : null,
        reportedAt: new Date(BASE + n),
      });
    }

    const page = await call<Page<{ id: string; reportedAt: string; configSha256: string | null; message: string }>>("GET", `${errors}?limit=2`);
    expect(page.body.errors).toEqual([
      { id: expect.any(String), reportedAt: at(100), configSha256: sha256("x"), message: "failure 100" },
      { id: expect.any(String), reportedAt: at(99), configSha256: null, message: "failure 99" },
    ]);
    const next = await call<Page<{ message: string }>>("GET", `${errors}?limit=2&cursor=${page.body.nextCursor ?? ""}`);
    expect(next.body.errors?.map((e) => e.message)).toEqual(["failure 98", "failure 97"]);

    const whole = await call<Page<{ message: string }>>("GET", `${errors}?limit=100`);
    expect(whole.body.errors).toHaveLength(100);
    expect(whole.body.errors?.at(-1)?.message).toBe("failure 1");
    expect(whole.body.nextCursor).toBeNull();
    // aWorld's error, recorded at BASE, was the oldest of 101: trimmed.
    expect(JSON.stringify(whole.body)).not.toContain("bad config");

    const bad = await call("GET", `${errors}?cursor=x`);
    expect(bad.status).toBe(400);
  });
});

describe("the fleet model's limits", () => {
  it("reads both unset, stores both, and refuses an enrollment past the cap", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const limits = `/organizations/${organizationId}/limits`;

    expect((await call("GET", limits)).body).toEqual({ maxCollectors: null, requestsPerMinute: null });
    const set = await callRaw("PUT", limits, '{"maxCollectors":1.0,"requestsPerMinute":600}');
    expect(set.body).toEqual({ maxCollectors: 1, requestsPerMinute: 600 });
    expect((await call("GET", limits)).body).toEqual({ maxCollectors: 1, requestsPerMinute: 600 });

    fake.enrollCollector(organizationId, created.fleet.id);
    expect(() => fake.enrollCollector(organizationId, created.fleet.id)).toThrow("enrollCollector: the organization's cap is reached");

    const refused = await call("PUT", limits, { maxCollectors: -1, requestsPerMinute: null });
    expect(refused.status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^setLimits request body: \/maxCollectors must be >= 0/)]);
  });
});

describe("the fleet model's usage and the in-use refusal (D16a decision 31)", () => {
  it("answers each published version newest first, with its groups by fleet then group, its pinned collectors and inUse", async () => {
    const organizationId = await anOrganization();
    const configurationId = randomUUID();
    const older = await aPublication(organizationId, { configurationId, number: 1, publishedAt: "2026-10-01T00:00:00.000Z" });
    const newer = await aPublication(organizationId, { configurationId, number: 2, publishedAt: "2026-10-02T00:00:00.000Z" });
    await aPublication(organizationId);
    const fleets = [await aFleet(organizationId), await aFleet(organizationId)];
    const groupRefs: { fleetId: string; groupId: string }[] = [];
    for (const created of fleets) {
      for (const name of ["a", "b"]) {
        const group = await call<Group>("POST", `/organizations/${organizationId}/fleets/${created.fleet.id}/groups`, {
          name,
          assignedPublicationId: older.id,
        });
        groupRefs.push({ fleetId: created.fleet.id, groupId: group.body.id });
      }
    }
    const fleetId = (fleets[0] as Created).fleet.id;
    for (const n of [1, 2]) {
      const collector = fake.enrollCollector(organizationId, fleetId, { name: `edge-${n}` });
      await call("PATCH", `/organizations/${organizationId}/fleets/${fleetId}/collectors/${collector.id}`, {
        pin: { kind: "publication", id: newer.id },
      });
    }

    const usage = await call<Record<string, unknown>>("GET", `/organizations/${organizationId}/configurations/${configurationId.toUpperCase()}/usage`);

    expect(usage.body).toEqual({
      configurationId,
      inUse: true,
      publications: [
        {
          id: newer.id,
          version: { id: expect.any(String), number: 2, label: null },
          publishedAt: "2026-10-02T00:00:00.000Z",
          groups: [],
          pinnedCollectors: 2,
        },
        {
          id: older.id,
          version: { id: expect.any(String), number: 1, label: null },
          publishedAt: "2026-10-01T00:00:00.000Z",
          groups: groupRefs.sort((a, b) => (a.fleetId === b.fleetId ? (a.groupId < b.groupId ? -1 : 1) : a.fleetId < b.fleetId ? -1 : 1)),
          pinnedCollectors: 0,
        },
      ],
    });
  });

  it("answers a configuration with nothing published an empty list, and a marked one in use by a phantom pinned collector", async () => {
    const organizationId = await anOrganization();
    const publication = await aPublication(organizationId);
    const usagePath = (id: string) => `/organizations/${organizationId}/configurations/${id}/usage`;

    expect((await call("GET", usagePath(randomUUID()))).body).toMatchObject({ inUse: false, publications: [] });
    expect((await call("GET", usagePath(publication.configurationId))).body).toMatchObject({
      inUse: false,
      publications: [{ pinnedCollectors: 0 }],
    });
    fake.markPublicationInUse(organizationId, publication.id);
    expect((await call("GET", usagePath(publication.configurationId))).body).toMatchObject({
      inUse: true,
      publications: [{ pinnedCollectors: 1 }],
    });
  });

  it("refuses deleting a published version a group is assigned or a collector pinned to, or its configuration's, deleting nothing", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const fleetId = created.fleet.id;
    const publication = await aPublication(organizationId);
    const sibling = await aPublication(organizationId, { configurationId: publication.configurationId, number: 2 });
    const collector = fake.enrollCollector(organizationId, fleetId);
    const remove = `/organizations/${organizationId}/publications/${publication.id}`;
    const removeAll = `/organizations/${organizationId}/configurations/${publication.configurationId}/publications`;
    const group = `/organizations/${organizationId}/fleets/${fleetId}/groups/${created.defaultGroup.id}`;
    const pinPath = `/organizations/${organizationId}/fleets/${fleetId}/collectors/${collector.id}`;

    await call("PATCH", group, { assignedPublicationId: publication.id });
    const before = fake.snapshotOf(organizationId);
    for (const path of [remove, removeAll]) {
      const refused = await call("DELETE", path);
      expect([refused.status, code(refused)]).toEqual([409, "publication_in_use"]);
    }
    expect(fake.snapshotOf(organizationId)).toEqual(before);

    await call("PATCH", group, { assignedPublicationId: null });
    await call("PATCH", pinPath, { pin: { kind: "publication", id: publication.id } });
    expect((await call("DELETE", remove)).status).toBe(409);
    expect((await call("DELETE", removeAll)).status).toBe(409);

    await call("PATCH", pinPath, { pin: null });
    fake.setCollectorState(organizationId, collector.id, { served: { kind: "publication", id: publication.id } });
    expect((await call("DELETE", remove)).status).toBe(204);
    const read = await call<Collector>("GET", pinPath);
    expect(read.body.served).toEqual({ kind: null, id: null, sha256: publication.sha256, at: at(0) });
    expect((await call("DELETE", removeAll)).status).toBe(204);
    expect((await call("GET", `/organizations/${organizationId}/publications/${sibling.id}`)).status).toBe(404);
  });

  it("keeps a published version in use while an archived fleet's group is assigned it (archived fleets count)", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    const fleetPathOf = `/organizations/${organizationId}/fleets/${created.fleet.id}`;
    const publication = await aPublication(organizationId);
    const group = await call<Group>("POST", `${fleetPathOf}/groups`, { name: "gateways", assignedPublicationId: publication.id });
    expect(group.status).toBe(201);
    expect((await call<Fleet>("PATCH", fleetPathOf, { status: "archived" })).body.status).toBe("archived");

    const usage = await call<Record<string, unknown>>(
      "GET",
      `/organizations/${organizationId}/configurations/${publication.configurationId}/usage`,
    );
    expect(usage.body).toMatchObject({
      inUse: true,
      publications: [{ id: publication.id, groups: [{ fleetId: created.fleet.id, groupId: group.body.id }], pinnedCollectors: 0 }],
    });
    const before = fake.snapshotOf(organizationId);
    for (const path of [
      `/organizations/${organizationId}/publications/${publication.id}`,
      `/organizations/${organizationId}/configurations/${publication.configurationId}/publications`,
    ]) {
      const refused = await call("DELETE", path);
      expect([refused.status, code(refused)]).toEqual([409, "publication_in_use"]);
    }
    expect(fake.snapshotOf(organizationId)).toEqual(before);
  });

  it("deletes an organization's fleets with it: registered again, it holds none", async () => {
    const world = await aWorld();
    await call("PUT", `/organizations/${world.organizationId}/limits`, { maxCollectors: 5, requestsPerMinute: null });

    expect((await call("DELETE", `/organizations/${world.organizationId}`)).status).toBe(204);
    expect((await call("POST", "/organizations", { id: world.organizationId, name: "Acme" })).status).toBe(201);

    expect((await call("GET", `/organizations/${world.organizationId}/fleets`)).body).toEqual({ fleets: [], nextCursor: null });
    expect(code(await call("GET", `/organizations/${world.organizationId}/fleets/${world.fleetId}`))).toBe("fleet_not_found");
    expect((await call("GET", `/organizations/${world.organizationId}/limits`)).body).toEqual({ maxCollectors: null, requestsPerMinute: null });
    expect(fake.snapshotOf(world.organizationId)).toMatchObject({ fleets: [], groups: [], tokens: [], collectors: [] });
  });
});

describe("the fleet model's contract checks and faults", () => {
  it.each([
    ["getFleet", 200, "getFleet reply 200 body: (root) must have required property 'id'"],
    ["createFleet", 201, "createFleet reply 201 body: (root) must have required property 'fleet'"],
    ["listCollectorInstances", 200, "listCollectorInstances reply 200 body: (root) must have required property 'collectors'"],
    ["deleteCollectorInstance", 200, "deleteCollectorInstance reply 200: the status isn't documented"],
  ])("catches %s's reply the fake breaks (malformed_reply) as a violation", async (operationId, status, violation) => {
    const world = await aWorld();
    const request = OPERATIONS.find(([id]) => id === operationId)?.[1] as (i: Ids) => Request;
    fake.nextFault("malformed_reply", operationId);

    const answer = await send(
      request({
        org: world.organizationId,
        fleet: operationId === "createFleet" ? randomUUID() : world.fleetId,
        group: world.groupId,
        token: world.tokenId,
        collector: world.collectorId,
        configuration: randomUUID(),
      }),
    );

    expect(answer.status).toBe(status);
    expect(fake.takeViolations()).toEqual([violation]);
  });

  it("takes a fault for the operation before one for any, leaving the other pending", async () => {
    const world = await aWorld();
    fake.nextFault("error_500");
    fake.nextFault("malformed_reply", "getFleet");

    const read = await call("GET", `/organizations/${world.organizationId}/fleets/${world.fleetId}`);
    expect(read.status).toBe(200);
    expect(fake.takeViolations()).toHaveLength(1);

    expect((await call("GET", `/organizations/${world.organizationId}/fleets`)).status).toBe(500);
    expect((await call("GET", `/organizations/${world.organizationId}/fleets`)).status).toBe(200);
  });

  it("takes the operation's fault before a reset for any, which the next request then takes", async () => {
    const world = await aWorld();
    const headers = { authorization: `Bearer ${fake.secret}` };
    const fleet = `${fake.url}/api/v1/organizations/${world.organizationId}/fleets/${world.fleetId}`;
    fake.nextFault("reset");
    fake.nextFault("error_500", "getFleet");

    expect((await fetch(fleet, { headers })).status).toBe(500);
    await expect(fetch(`${fake.url}/api/v1/organizations/${world.organizationId}/fleets`, { headers })).rejects.toThrow();
    expect((await fetch(fleet, { headers })).status).toBe(200);
  });

  it("resets, or holds, only the faulted operation's request", async () => {
    const world = await aWorld();
    const path = `${fake.url}/api/v1/organizations/${world.organizationId}/fleets/${world.fleetId}`;
    const headers = { authorization: `Bearer ${fake.secret}` };
    fake.nextFault("reset", "getFleet");

    expect((await fetch(`${fake.url}/health`)).status).toBe(200);
    await expect(fetch(path, { headers })).rejects.toThrow();
    expect((await fetch(path, { headers })).status).toBe(200);

    fake.nextFault("hang", "listFleets");
    expect((await fetch(path, { headers })).status).toBe(200);
    const held = await fetch(`${fake.url}/api/v1/organizations/${world.organizationId}/fleets`, {
      headers,
      signal: AbortSignal.timeout(200),
    }).then(
      () => "answered",
      () => "held",
    );
    expect(held).toBe("held");
  });

  it("refuses to fault an operation the contract doesn't have", () => {
    expect(() => fake.nextFault("error_500", "getFleets")).toThrow("nextFault: the contract has no such operation");
  });
});

describe("the fleet model's helpers", () => {
  it("enrolls only in a fleet, group and token the organization holds, under a free valid name", async () => {
    const world = await aWorld();
    const other = await anOrganization();
    const sibling = await aFleet(world.organizationId);

    expect(() => fake.enrollCollector(other, world.fleetId)).toThrow("enrollCollector: the organization holds no such fleet");
    expect(() => fake.enrollCollector(world.organizationId, sibling.fleet.id, { groupId: world.groupId })).toThrow(
      "enrollCollector: the fleet holds no such group",
    );
    expect(() => fake.enrollCollector(world.organizationId, sibling.fleet.id, { tokenId: world.tokenId })).toThrow(
      "enrollCollector: the fleet holds no such token",
    );
    const named = fake.enrollCollector(world.organizationId, world.fleetId, { name: "edge-01" });
    expect(named.name).toBe("edge-01");
    for (const name of ["edge-01", " edge", ""]) {
      expect(() => fake.enrollCollector(world.organizationId, sibling.fleet.id, { name })).toThrow(
        "enrollCollector: the name is invalid or taken",
      );
    }
  });

  it("sets state only on the organization's collector, and a served target it holds", async () => {
    const world = await aWorld();
    const other = await anOrganization();

    expect(() => fake.setCollectorState(other, world.collectorId, { lastSeenAt: new Date() })).toThrow(
      "the organization holds no such collector",
    );
    expect(() => fake.recordCollectorError(other, world.collectorId, { message: "x" })).toThrow("the organization holds no such collector");
    expect(() =>
      fake.setCollectorState(world.organizationId, world.collectorId, { served: { kind: "publication", id: randomUUID() } }),
    ).toThrow("setCollectorState: the served target isn't held");

    fake.setCollectorState(world.organizationId, world.collectorId, {
      served: { kind: null, sha256: sha256("gone"), at: null },
      effective: { sha256: sha256("gone"), status: "applied" },
    });
    const path = `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors/${world.collectorId}`;
    expect((await call<Collector>("GET", path)).body.served).toEqual({ kind: null, id: null, sha256: sha256("gone"), at: null });
    const publication = await aPublication(world.organizationId);
    fake.setCollectorState(world.organizationId, world.collectorId, {
      served: { kind: "publication", id: publication.id, sha256: sha256("other"), at: null },
      reported: { attributes: null },
    });
    expect((await call<Collector>("GET", path)).body.served).toEqual({ kind: "publication", id: publication.id, sha256: sha256("other"), at: null });
    fake.setCollectorState(world.organizationId, world.collectorId, { served: null, effective: null });
    expect((await call<Collector>("GET", path)).body).toMatchObject({ served: null, effective: null });
  });

  it("refuses enrolling on a revoked or expired token, or in an archived fleet, as the agent side's authentication does", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { rotateExpiresAt: at(HOUR) });
    const fleet = `/organizations/${organizationId}/fleets/${created.fleet.id}`;

    clock = BASE + HOUR;
    expect(() => fake.enrollCollector(organizationId, created.fleet.id, { tokenId: created.tokens.rotate.id })).toThrow(
      "enrollCollector: the token is revoked or expired",
    );
    expect((await call("POST", `${fleet}/tokens/${created.tokens.default.id}/revoke`, { actor: ACTOR })).status).toBe(200);
    expect(() => fake.enrollCollector(organizationId, created.fleet.id)).toThrow("enrollCollector: the token is revoked or expired");

    const other = await aFleet(organizationId);
    expect((await call("PATCH", `/organizations/${organizationId}/fleets/${other.fleet.id}`, { status: "archived" })).status).toBe(200);
    expect(() => fake.enrollCollector(organizationId, other.fleet.id)).toThrow("enrollCollector: the fleet is archived");
    expect(fake.snapshotOf(organizationId)).toMatchObject({ collectors: [] });
  });

  it("bounds an error message as BoundMessage: NUL and lone surrogates replaced, cut to 8 KiB on a character's boundary", async () => {
    const world = await aWorld();
    const errors = `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors/${world.collectorId}/errors?limit=100`;
    let recorded = 0;
    const record = (message: string) =>
      fake.recordCollectorError(world.organizationId, world.collectorId, { message, reportedAt: new Date(BASE + ++recorded) });
    const messages = async () => (await call<Page<{ message: string }>>("GET", errors)).body.errors?.map((e) => e.message) ?? [];

    record(`a\u0000b\uD800\uDBFFc\uDC00`);
    expect((await messages())[0]).toBe("a\uFFFDb\uFFFDc\uFFFD");
    record("é".repeat(5000));
    expect((await messages())[0]).toBe("é".repeat(4096));
    record(`${"x".repeat(8191)}é`);
    expect((await messages())[0]).toBe("x".repeat(8191));
    record("x".repeat(8192));
    expect((await messages())[0]).toBe("x".repeat(8192));
    expect(() => record("")).toThrow("recordCollectorError: the message is empty");
  });

  it("keeps an effective error only with failed, bounded; and bounds what a collector reports as the agent side does", async () => {
    const world = await aWorld();
    const path = `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors/${world.collectorId}`;
    const read = async () => (await call<Collector>("GET", path)).body;
    const hash = sha256("x");

    fake.setCollectorState(world.organizationId, world.collectorId, { effective: { sha256: hash, status: "applied", error: "stale" } });
    expect((await read()).effective?.error).toBeNull();
    fake.setCollectorState(world.organizationId, world.collectorId, { effective: { sha256: hash, status: "applying", error: "stale" } });
    expect((await read()).effective?.error).toBeNull();
    fake.setCollectorState(world.organizationId, world.collectorId, {
      effective: { sha256: hash, status: "failed", error: `bad\u0000${"é".repeat(5000)}` },
    });
    expect((await read()).effective?.error).toBe(`bad\uFFFD${"é".repeat(4093)}`);
    // A failure without a message records report.go's emptyFailureMessage: none, empty, or Go's spaces only.
    for (const error of [undefined, null, "", " \t\u00a0\u3000"]) {
      const effective = { sha256: hash, status: "failed" as const, ...(error === undefined ? {} : { error }) };
      fake.setCollectorState(world.organizationId, world.collectorId, { effective });
      expect((await read()).effective?.error).toBe("The collector reported a failure without a message.");
    }
    // Only spaces count as none: a NUL is a message, bounded.
    fake.setCollectorState(world.organizationId, world.collectorId, { effective: { sha256: hash, status: "failed", error: "\u0000" } });
    expect((await read()).effective?.error).toBe("\uFFFD");

    fake.setCollectorState(world.organizationId, world.collectorId, {
      reported: { collectorVersion: "0.162.0", ip: " 10.0.0.1\u00a0", hostIp: "192.168.1.5", attributes: { "host.name": "edge-01" } },
    });
    fake.setCollectorState(world.organizationId, world.collectorId, {
      reported: { collectorVersion: "v".repeat(201), ip: "1".repeat(101), hostIp: "\u3000", attributes: { a: "\u0000" } },
    });
    expect((await read()).reported).toEqual({ collectorVersion: "0.162.0", ip: "10.0.0.1", hostIp: "192.168.1.5", attributes: {} });
    // A collector version trimmed of Go's spaces, as stringAttribute trims it; spaces only leave it as stored.
    fake.setCollectorState(world.organizationId, world.collectorId, { reported: { collectorVersion: "\u3000 0.163.0\t\n" } });
    expect((await read()).reported.collectorVersion).toBe("0.163.0");
    fake.setCollectorState(world.organizationId, world.collectorId, { reported: { collectorVersion: " \u00a0 " } });
    expect((await read()).reported.collectorVersion).toBe("0.163.0");
    fake.setCollectorState(world.organizationId, world.collectorId, { reported: { collectorVersion: ` ${"v".repeat(200)} ` } });
    expect((await read()).reported.collectorVersion).toBe("v".repeat(200));

    // {"a": "…", "b": "…"}: 2 + 2 + (3 + 2 + 2 + n) each. a fits in 16384 alone; b is left out.
    const big = { b: "y".repeat(10), a: "x".repeat(16_384 - 2 - 3 - 2 - 2) };
    fake.setCollectorState(world.organizationId, world.collectorId, { reported: { attributes: big } });
    expect((await read()).reported.attributes).toEqual({ a: big.a });
    const escaped = { a: `${"x".repeat(16_384 - 2 - 3 - 2 - 2 - 2)}\n` };
    fake.setCollectorState(world.organizationId, world.collectorId, { reported: { attributes: escaped } });
    expect((await read()).reported.attributes).toEqual(escaped);
    const over = { a: `${"x".repeat(16_384 - 2 - 3 - 2 - 2 - 6)}\u0001!` };
    fake.setCollectorState(world.organizationId, world.collectorId, { reported: { attributes: over } });
    expect((await read()).reported.attributes).toEqual({});

    const enrolled = fake.enrollCollector(world.organizationId, world.fleetId, { reported: { collectorVersion: "", attributes: big } });
    const enrolledRead = await call<Collector>("GET", `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors/${enrolled.id}`);
    expect(enrolledRead.body.reported).toMatchObject({ collectorVersion: null, attributes: { a: big.a } });
  });

  it("snapshots a deep copy: changing it changes nothing the fake holds", async () => {
    const world = await aWorld();
    const snapshot = fake.snapshotOf(world.organizationId) as { fleets: { label: string }[]; organization: { name: string } };
    (snapshot.fleets[0] as { label: string }).label = "changed";
    snapshot.organization.name = "changed";

    expect(fake.snapshotOf(world.organizationId)).toMatchObject({
      organization: { name: "Acme" },
      fleets: [{ label: world.created.fleet.label }],
    });
    expect(fake.snapshotOf(randomUUID())).toMatchObject({ organization: null, fleets: [], limits: null });
  });
});
