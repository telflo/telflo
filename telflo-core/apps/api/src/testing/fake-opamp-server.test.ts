import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpampServer, type FakeOpampServer } from "./fake-opamp-server.js";

// The fake opamp-server's own contract checks: it must catch a request that
// breaks vendor/opamp-server/openapi.yaml, and a reply of its own that does,
// or the client's tests against it prove nothing; and it must answer in the
// real server's order: the path's ids, then the organization, then the query
// or the body. These tests send raw requests, shaped as the client's are,
// then broken.

let fake: FakeOpampServer;
/** Registered in beforeAll: the organization the publication requests use unless they say otherwise. */
let registered: string;

beforeAll(async () => {
  fake = await startFakeOpampServer();
  registered = randomUUID();
  const response = await post({ id: registered, name: "Acme" });
  expect(response.status).toBe(201);
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
});

afterAll(async () => {
  await fake.close();
});

function aBody(): Record<string, unknown> {
  const yaml = "receivers:\n  otlp:\n";
  return {
    configuration: { id: randomUUID(), name: "payments-gateway" },
    version: { id: randomUUID(), number: 3, label: "TLS on" },
    yaml,
    sha256: createHash("sha256").update(yaml, "utf8").digest("hex"),
    publishedBy: null,
    publishedAt: "2026-10-03T14:02:11.000Z",
    collector: { distribution: "otelcol-contrib", version: "0.161.0" },
  };
}

function publicationsUrl(organizationId = registered): string {
  return `${fake.url}/api/v1/organizations/${organizationId}/publications`;
}

function publicationUrl(organizationId: string = registered, publicationId: string = randomUUID()): string {
  return `${publicationsUrl(organizationId)}/${publicationId}`;
}

/**
 * POST …/publications (0.2.4's postPublication) of `body`, under the
 * organization and with the id a publication's `url` names, as the client
 * sends it: the id in the body (a body that isn't an object goes as it is).
 */
function publish(body: unknown, headers: Record<string, string> = {}, url = publicationUrl()): Promise<Response> {
  const match = /^(.*\/publications)\/([^/]+)$/.exec(url);
  if (match === null) throw new Error("publish: not a publication's URL");
  const [, collection, id] = match;
  const sent = typeof body === "object" && body !== null && !Array.isArray(body) ? { id, ...body } : body;
  return fetch(collection as string, {
    method: "POST",
    headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(sent),
  });
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${fake.url}/api/v1/organizations`, {
    method: "POST",
    headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function patch(organizationId: string, body: unknown): Promise<Response> {
  return fetch(`${fake.url}/api/v1/organizations/${organizationId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url: string, headers: Record<string, string> = { authorization: `Bearer ${fake.secret}` }): Promise<Response> {
  return fetch(url, { headers });
}

describe("the fake opamp-server's request validation", () => {
  it("accepts a request that keeps the contract, with no violation", async () => {
    const response = await publish(aBody());

    expect(response.status).toBe(201);
    expect(fake.takeViolations()).toEqual([]);
  });

  it("refuses a request missing a required field, as the real server would (400)", async () => {
    const { collector: _omitted, ...body } = aBody();

    const response = await publish(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(fake.takeViolations()).toEqual(["postPublication request body: (root) must have required property 'collector'"]);
  });

  it.each([
    ["null", null, "/collector must be object"],
    ["an empty object", {}, "/collector must have required property 'distribution'; /collector must have required property 'version'"],
    ["without its version", { distribution: "otelcol-contrib" }, "/collector must have required property 'version'"],
    [
      "with a field the API doesn't know",
      { distribution: "otelcol-contrib", version: "0.162.0", image: "otel/x:1" },
      "/collector must NOT have additional properties",
    ],
    [
      "with a version that isn't major.minor.patch",
      { distribution: "otelcol-contrib", version: "v0.162.0" },
      '/collector/version must match pattern "^[0-9]+\\.[0-9]+\\.[0-9]+$"',
    ],
    [
      "with a distribution in capitals",
      { distribution: "Otelcol-Contrib", version: "0.162.0" },
      '/collector/distribution must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"',
    ],
    [
      "with a distribution over 64 characters",
      { distribution: "a".repeat(65), version: "0.162.0" },
      "/collector/distribution must NOT have more than 64 characters",
    ],
  ])("refuses a collector %s as a contract violation, as the real server would (400)", async (_label, collector, violation) => {
    const response = await publish({ ...aBody(), collector });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(fake.takeViolations()).toEqual([`postPublication request body: ${violation}`]);
  });

  it("stores the collector, answers it, and compares it for the same id", async () => {
    const body = aBody();
    const url = publicationUrl();

    const created = await publish(body, {}, url);
    expect(created.status).toBe(201);
    expect(((await created.json()) as { collector: unknown }).collector).toEqual({ distribution: "otelcol-contrib", version: "0.161.0" });
    const again = await publish(body, {}, url);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { collector: unknown }).collector).toEqual({ distribution: "otelcol-contrib", version: "0.161.0" });
    for (const collector of [
      { distribution: "otelcol-contrib", version: "0.162.0" },
      { distribution: "otelcol-k8s", version: "0.161.0" },
    ]) {
      const conflicting = await publish({ ...body, collector }, {}, url);
      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toMatchObject({ error: { code: "publication_conflict" } });
    }
    expect(((await (await get(url)).json()) as { collector: unknown }).collector).toEqual({ distribution: "otelcol-contrib", version: "0.161.0" });
  });

  it("makes an id for a publication posted without one, a new publication each time (201 twice, two ids, both stored)", async () => {
    const body = aBody();
    const first = await fetch(publicationsUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const second = await fetch(publicationsUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect([first.status, second.status]).toEqual([201, 201]);
    const ids = [((await first.json()) as { id: string }).id, ((await second.json()) as { id: string }).id];
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids[1]).not.toBe(ids[0]);
    for (const id of ids) expect((await get(publicationUrl(registered, id))).status).toBe(200);
  });

  it("stores a posted id as Postgres gives it back, lower case, and an identical retry in other case is the same publication (200)", async () => {
    const id = randomUUID();
    const body = aBody();

    const created = await publish(body, {}, publicationUrl(registered, id.toUpperCase()));
    const again = await publish(body, {}, publicationUrl(registered, id));

    expect([created.status, again.status]).toEqual([201, 200]);
    expect(((await created.json()) as { id: string }).id).toBe(id);
  });

  it("catches a renamed field: one missing, one the API doesn't know", async () => {
    const { sha256, ...rest } = aBody();

    const response = await publish({ ...rest, sha: sha256 });

    expect(response.status).toBe(400);
    expect(fake.takeViolations()).toEqual([
      "postPublication request body: (root) must have required property 'sha256'; (root) must NOT have additional properties",
    ]);
  });

  it("catches a field of the wrong type deep in the body", async () => {
    const body = aBody();

    const response = await publish({ ...body, version: { ...(body.version as object), number: "3" } });

    expect(response.status).toBe(400);
    expect(fake.takeViolations()).toEqual(["postPublication request body: /version/number must be integer"]);
  });

  it("catches the secret sent without the Bearer scheme, and answers 401", async () => {
    const response = await publish(aBody(), { authorization: fake.secret });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(fake.takeViolations()).toEqual(["postPublication request: no Authorization: Bearer header"]);
  });

  it("answers a wrong secret 401 without a violation: that is a documented answer", async () => {
    const response = await get(publicationUrl(), { authorization: "Bearer a-wrong-secret" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid credentials." } });
  });

  it("catches a body that isn't JSON, and the wrong Content-Type", async () => {
    const response = await fetch(publicationsUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${fake.secret}`, "content-type": "text/plain" },
      body: "receivers:",
    });

    expect(response.status).toBe(400);
    expect(fake.takeViolations()).toEqual(["postPublication request: Content-Type isn't application/json"]);

    const notJson = await fetch(publicationsUrl(), {
      method: "POST",
      headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json" },
      body: "receivers:",
    });
    expect(notJson.status).toBe(400);
    expect(fake.takeViolations()).toEqual(["postPublication request: the body isn't JSON"]);
  });

  it("catches a missing required query parameter, an undocumented one, and a repeated one", async () => {
    const base = `${fake.url}/api/v1/organizations/${registered}/publications`;

    expect((await get(`${base}?limit=2`)).status).toBe(400);
    expect(fake.takeViolations()).toEqual(["listPublications request: query parameter configurationId is required"]);

    expect((await get(`${base}?configurationId=${randomUUID()}&page=2`)).status).toBe(200);
    expect(fake.takeViolations()).toEqual(["listPublications request: query parameter page isn't documented"]);

    expect((await get(`${base}?configurationId=${randomUUID()}&limit=1&limit=2`)).status).toBe(400);
    expect(fake.takeViolations()).toEqual(["listPublications request: query parameter limit is given more than once"]);
  });

  it("catches a body on an operation that takes none", async () => {
    const response = await fetch(publicationUrl(), {
      method: "DELETE",
      headers: { authorization: `Bearer ${fake.secret}` },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(fake.takeViolations()).toEqual(["deletePublication request: has a body, which the operation doesn't take"]);
  });

  it("catches a route the file doesn't document: a method (0.1.0's PUT of a publication), a path, HEAD, and outside /api/", async () => {
    const put = await fetch(publicationUrl(), { method: "PUT", headers: { authorization: `Bearer ${fake.secret}` } });
    const v2 = await get(`${fake.url}/api/v2/organizations/${randomUUID()}/publications`);
    const head = await fetch(publicationUrl(), { method: "HEAD", headers: { authorization: `Bearer ${fake.secret}` } });
    const outside = await get(`${fake.url}/metrics`);

    expect([put.status, v2.status, head.status, outside.status]).toEqual([404, 404, 404, 404]);
    expect(fake.takeViolations()).toEqual([
      expect.stringMatching(/^PUT \/api\/v1\/organizations\/.*: the route isn't documented$/),
      expect.stringMatching(/^GET \/api\/v2\/organizations\/.*: the route isn't documented$/),
      expect.stringMatching(/^HEAD \/api\/v1\/organizations\/.*: the route isn't documented$/),
      "GET /metrics: the route isn't documented",
    ]);
  });

  it("answers the browser tests' control port's paths as undocumented routes, enrolling, recording, seeding and adding nothing", async () => {
    const created = await fetch(`${fake.url}/api/v1/organizations/${registered}/fleets`, {
      method: "POST",
      headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "edge-control", type: "server", rotateExpiresAt: null, actor: null }),
    });
    expect(created.status).toBe(201);
    const fleetId = ((await created.json()) as { fleet: { id: string } }).fleet.id;
    const collector = fake.enrollCollector(registered, fleetId, { name: "edge-control-a" });
    const before = fake.snapshotOf(registered);
    const send = (method: string, path: string, body: unknown) =>
      fetch(`${fake.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${fake.secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const enrollPath = `/organizations/${registered}/fleets/${fleetId}/collectors`;
    const collectorPath = `/organizations/${registered}/collectors/${collector.id}`;
    const errorsPath = `${collectorPath}/errors`;
    const tokenEventsPath = `/organizations/${registered}/fleets/${fleetId}/token-events`;
    // An imports path, which the control port doesn't have: a plain 404 too.
    const importsPath = `/organizations/${registered}/fleets/${fleetId}/imports`;
    const enroll = { name: "edge-control-b", reported: { ip: "10.0.0.7" } };
    const change = { lastSeenAt: "2026-10-03T14:02:11.000Z", reported: { collectorVersion: "0.162.0" } };
    const error = { message: "failed to start", reportedAt: "2026-10-03T14:02:11.000Z" };
    const added = { yaml: "receivers: {}\n", collectorVersion: "0.162.0" };
    const seeded = { count: 3 };

    const answers = [
      await send("POST", enrollPath, enroll),
      await send("PATCH", collectorPath, change),
      await send("POST", errorsPath, error),
      await send("POST", tokenEventsPath, seeded),
      await send("POST", importsPath, added),
      await send("POST", `/api/v1${enrollPath}`, enroll),
      await send("PATCH", `/api/v1${collectorPath}`, change),
      await send("POST", `/api/v1${errorsPath}`, error),
      await send("POST", `/api/v1${tokenEventsPath}`, seeded),
      await send("POST", `/api/v1${importsPath}`, added),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404, 404]);
    expect(fake.takeViolations()).toEqual([
      `POST ${enrollPath}: the route isn't documented`,
      `PATCH ${collectorPath}: the route isn't documented`,
      `POST ${errorsPath}: the route isn't documented`,
      `POST ${tokenEventsPath}: the route isn't documented`,
      `POST ${importsPath}: the route isn't documented`,
      `POST /api/v1${enrollPath}: the route isn't documented`,
      `PATCH /api/v1${collectorPath}: the route isn't documented`,
      `POST /api/v1${errorsPath}: the route isn't documented`,
      `POST /api/v1${tokenEventsPath}: the route isn't documented`,
      `POST /api/v1${importsPath}: the route isn't documented`,
    ]);
    expect(fake.snapshotOf(registered)).toEqual(before);
  });

  it("records a request it can't read (a path that isn't percent-encoded UTF-8) as its own failure, answering 500", async () => {
    const response = await get(`${fake.url}/api/v1/organizations/%E0%A4%A/limits`);

    expect(response.status).toBe(500);
    expect(fake.takeViolations()).toEqual(["the fake failed: URI malformed"]);
  });

  it("answers /health without the secret, as documented", async () => {
    const response = await get(`${fake.url}/health`, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  // As the server does, a publishedAt that is a date-time in the text but
  // an instant outside the years 0001 to 9999 in UTC is a 400 naming the
  // field, and no violation: the file allows it.
  it.each([
    "9999-12-31T23:59:59-01:00",
    "0000-01-01T00:00:00+01:00",
    "0000-12-31T23:59:59.999Z",
    "0000-02-29T12:00:00Z",
  ])("refuses publishedAt %s, outside the years 0001 to 9999 in UTC, as the server does", async (publishedAt) => {
    const response = await publish({ ...aBody(), publishedAt });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "publishedAt must be from the year 0001 to 9999, in UTC." },
    });
  });

  it.each([
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
    ["0001-01-01t01:00:00+01:00", "0001-01-01T00:00:00.000Z"],
    ["9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
  ])("accepts publishedAt %s, at an end of the years 0001 to 9999", async (publishedAt, stored) => {
    const response = await publish({ ...aBody(), publishedAt });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ publishedAt: stored });
  });

  it("refuses a leap second, as the server does, and catches a comma before the fraction", async () => {
    const leap = await publish({ ...aBody(), publishedAt: "2016-12-31T23:59:60Z" });
    expect(leap.status).toBe(400);
    expect(await leap.json()).toEqual({
      error: { code: "invalid_request", message: "publishedAt must be an RFC 3339 date-time." },
    });

    const comma = await publish({ ...aBody(), publishedAt: "2026-10-03T14:02:11,5Z" });
    expect(comma.status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/publishedAt.*date-time/)]);
  });
});

describe("the fake opamp-server's registry", () => {
  const organizationNotFound = {
    error: {
      code: "organization_not_found",
      message: "No organization with this id is registered: register it with POST /api/v1/organizations first.",
    },
  };

  it("registers without an id under a new version 4 UUID, and with one under it: 201, 200, 409", async () => {
    const generated = await post({ name: "Acme" });
    expect(generated.status).toBe(201);
    expect((await generated.json()) as unknown).toEqual({
      organizationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });

    const id = randomUUID();
    expect((await post({ id, name: "Acme" })).status).toBe(201);
    expect((await post({ id, name: "Acme" })).status).toBe(200);
    const conflict = await post({ id, name: "Acme " });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: "organization_conflict", message: "An organization with this id is already registered under another name." },
    });
  });

  it("catches a POST with a field the API doesn't know, or a null id, and answers 400", async () => {
    expect((await post({ id: randomUUID(), name: "Acme", type: "group" })).status).toBe(400);
    expect((await post({ id: null, name: "Acme" })).status).toBe(400);

    expect(fake.takeViolations()).toEqual([
      "createOrganization request body: (root) must NOT have additional properties",
      "createOrganization request body: /id must be string",
    ]);
  });

  it("reads a PATCH's body before looking the organization up", async () => {
    const response = await patch(randomUUID(), {});

    expect(response.status).toBe(400);
    expect(fake.takeViolations()).toEqual(["renameOrganization request body: (root) must have required property 'name'"]);
    expect((await patch(randomUUID(), { name: "Acme" })).status).toBe(404);
  });

  it.each([
    ["POST a body missing a field", () => publish({ collector: aBody().collector }, {}, publicationUrl(randomUUID()))],
    ["POST a body that isn't JSON", () => publish("receivers:", { "content-type": "text/plain" }, publicationUrl(randomUUID()))],
    [
      "GET a list missing its configurationId",
      () => get(`${fake.url}/api/v1/organizations/${randomUUID()}/publications?limit=101`),
    ],
  ])("answers 404 organization_not_found before the query or the body: %s", async (_label, send) => {
    const response = await send();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(organizationNotFound);
    // The request still broke the contract, and the fake says so.
    expect(fake.takeViolations()).not.toEqual([]);
  });

  it.each([
    ["GET", () => get(publicationUrl(randomUUID()))],
    ["DELETE", () => fetch(publicationUrl(randomUUID()), { method: "DELETE", headers: { authorization: `Bearer ${fake.secret}` } })],
    ["GET a list", () => get(`${fake.url}/api/v1/organizations/${randomUUID()}/publications?configurationId=${randomUUID()}`)],
    [
      "DELETE a configuration's",
      () =>
        fetch(`${fake.url}/api/v1/organizations/${randomUUID()}/configurations/${randomUUID()}/publications`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${fake.secret}` },
        }),
    ],
    ["POST", () => publish(aBody(), {}, publicationUrl(randomUUID()))],
  ])("answers %s under an unregistered organization 404 organization_not_found", async (_label, send) => {
    const response = await send();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(organizationNotFound);
  });

  it("reads the path's ids before the organization: a publication id that isn't a UUID is 400", async () => {
    const response = await get(`${fake.url}/api/v1/organizations/${randomUUID()}/publications/42`);

    expect(response.status).toBe(400);
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^getPublication request: path parameter publicationId /)]);
  });

  it("catches an Organization reply of its own missing a required field", async () => {
    fake.nextFault("malformed_reply");

    const response = await get(`${fake.url}/api/v1/organizations/${registered}`);

    expect(response.status).toBe(200);
    expect(fake.takeViolations()).toEqual([
      "getOrganization reply 200 body: (root) must have required property 'organizationId'",
    ]);
  });
});

describe("the fake opamp-server's in-use publications", () => {
  const remove = (url: string) => fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${fake.secret}` } });
  const inUse = (message: string) => ({ error: { code: "publication_in_use", message } });

  it("refuses to delete a publication marked in use, or its configuration's, deleting nothing, with a documented 409", async () => {
    const body = aBody();
    const configurationId = (body.configuration as { id: string }).id;
    const used = randomUUID();
    const unused = randomUUID();
    expect((await publish(body, {}, publicationUrl(registered, used))).status).toBe(201);
    expect((await publish({ ...aBody(), configuration: body.configuration }, {}, publicationUrl(registered, unused))).status).toBe(201);
    fake.markPublicationInUse(registered, used.toUpperCase());

    const refused = await remove(publicationUrl(registered, used));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual(inUse("A collector group or a collector uses this published version."));
    const configuration = `${fake.url}/api/v1/organizations/${registered}/configurations/${configurationId}/publications`;
    const refusedWhole = await remove(configuration);
    expect(refusedWhole.status).toBe(409);
    expect(await refusedWhole.json()).toEqual(
      inUse("A collector group or a collector uses one of the configuration's published versions."),
    );
    expect((await get(publicationUrl(registered, used))).status).toBe(200);
    expect((await get(publicationUrl(registered, unused))).status).toBe(200);

    fake.markPublicationInUse(registered, used, false);
    expect((await remove(configuration)).status).toBe(204);
    expect((await get(publicationUrl(registered, used))).status).toBe(404);
  });

  it("marks only a publication the organization holds", async () => {
    const id = randomUUID();
    expect((await publish(aBody(), {}, publicationUrl(registered, id))).status).toBe(201);

    expect(() => fake.markPublicationInUse(randomUUID(), id)).toThrow("markPublicationInUse: the organization holds no such publication");
    expect(() => fake.markPublicationInUse(registered, randomUUID())).toThrow(
      "markPublicationInUse: the organization holds no such publication",
    );
  });

  it("keys publications and marks by organization: another organization's POST of the same id is 409, and nothing of one reaches the other", async () => {
    const other = randomUUID();
    expect((await post({ id: other, name: "Other" })).status).toBe(201);
    const id = randomUUID();
    const body = aBody();
    const configurationId = (body.configuration as { id: string }).id;
    expect((await publish(body, {}, publicationUrl(registered, id))).status).toBe(201);

    // The real table's primary key is the id alone: the same id under another organization is a conflict.
    const conflict = await publish(body, {}, publicationUrl(other, id));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "publication_conflict", message: "A different publication already has this id." } });
    expect((await get(publicationUrl(other, id))).status).toBe(404);
    expect(() => fake.markPublicationInUse(other, id)).toThrow("markPublicationInUse: the organization holds no such publication");

    fake.markPublicationInUse(registered, id);
    const usage = (organizationId: string) => get(`${fake.url}/api/v1/organizations/${organizationId}/configurations/${configurationId}/usage`);
    expect(await (await usage(registered)).json()).toMatchObject({ inUse: true, publications: [{ id, pinnedCollectors: 1 }] });
    expect(await (await usage(other)).json()).toMatchObject({ inUse: false, publications: [] });
    expect(fake.snapshotOf(registered).markedInUse).toEqual([id]);
    expect(fake.snapshotOf(other)).toMatchObject({ publications: [], markedInUse: [] });
    // The other organization's delete of the id finds nothing, and the mark still holds the owner's.
    expect((await fetch(publicationUrl(other, id), { method: "DELETE", headers: { authorization: `Bearer ${fake.secret}` } })).status).toBe(404);
    expect((await remove(publicationUrl(registered, id))).status).toBe(409);
    fake.markPublicationInUse(registered, id, false);
    expect((await remove(publicationUrl(registered, id))).status).toBe(204);
  });

  it("serves the fleet model's routes: an organization's limits read unset, with no violation", async () => {
    const response = await get(`${fake.url}/api/v1/organizations/${registered}/limits`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ maxCollectors: null, requestsPerMinute: null });
  });
});

describe("the fake opamp-server's reply validation", () => {
  it("catches a reply of its own missing a required field", async () => {
    const organizationId = registered;
    const publicationId = randomUUID();
    await publish(aBody(), {}, publicationUrl(organizationId, publicationId));
    fake.nextFault("malformed_reply");

    const response = await get(publicationUrl(organizationId, publicationId));

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("id");
    expect(fake.takeViolations()).toEqual(["getPublication reply 200 body: (root) must have required property 'id'"]);
  });

  it("catches a reply of its own with a status the operation doesn't document", async () => {
    fake.nextFault("malformed_reply");

    const response = await fetch(publicationUrl().replace(/publications\/.*$/, `configurations/${randomUUID()}/publications`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${fake.secret}` },
    });

    expect(response.status).toBe(200);
    expect(fake.takeViolations()).toEqual(["deleteConfigurationPublications reply 200: the status isn't documented"]);
  });

  it("catches an error reply of its own without the envelope", async () => {
    fake.nextFault("malformed_reply");

    const response = await get(publicationUrl());

    expect(response.status).toBe(404);
    expect(fake.takeViolations()).toEqual(["getPublication reply 404 body: (root) must have required property 'error'"]);
  });

  it("validates the 500 it answers when told to", async () => {
    fake.nextFault("error_500");

    const response = await get(publicationUrl());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Internal server error." } });
  });
});

describe("the fake opamp-server's close", () => {
  it("rejects while a violation is unread, so a test that forgets to look still fails", async () => {
    const careless = await startFakeOpampServer();
    await fetch(`${careless.url}/nowhere`);

    await expect(careless.close()).rejects.toThrow(
      "The fake opamp-server saw contract violations no test read:\nGET /nowhere: the route isn't documented",
    );
  });

  it("ends a request it holds (hang) when it closes", async () => {
    const holding = await startFakeOpampServer();
    holding.nextFault("hang");
    const pending = fetch(`${holding.url}/api/v1/organizations/${randomUUID()}/publications/${randomUUID()}`, {
      headers: { authorization: `Bearer ${holding.secret}` },
    }).then(
      () => "answered",
      () => "dropped",
    );
    // A second request is answered: the fault was one shot.
    const answered = await fetch(`${holding.url}/health`);
    expect(answered.status).toBe(200);

    await holding.close();

    expect(await pending).toBe("dropped");
  });
});

/** A port on 127.0.0.1 that was free a moment ago: listened on, then closed. */
async function aFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

describe("the fake opamp-server's options", () => {
  it("listens on the port it is given, as the browser tests' does (28085)", async () => {
    const port = await aFreePort();
    const fixed = await startFakeOpampServer({ port });
    try {
      expect(fixed.url).toBe(`http://127.0.0.1:${port}`);
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await fixed.close();
    }
  });

  it("refuses to start on a port that is taken, rather than hanging", async () => {
    const taken = Number(new URL(fake.url).port);

    await expect(startFakeOpampServer({ port: taken })).rejects.toThrow(/EADDRINUSE/);
  });

  it("tells onViolation each violation as it records it, and still keeps it for takeViolations", async () => {
    const told: string[] = [];
    const watched = await startFakeOpampServer({ onViolation: (message) => void told.push(message) });
    try {
      await fetch(`${watched.url}/nowhere`);
      await fetch(`${watched.url}/api/v1/organizations`, { method: "POST", body: "{}" });

      expect(told).toEqual([
        "GET /nowhere: the route isn't documented",
        "createOrganization request: no Authorization: Bearer header",
      ]);
      expect(watched.takeViolations()).toEqual(told);
    } finally {
      await watched.close();
    }
  });
});
