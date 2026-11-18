import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, type AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE, type FleetCreatedResponse } from "@telflo/contracts";
import { startFakeOpampServer, type FakeOpampServer } from "../apps/api/src/testing/fake-opamp-server.js";
import { seedUser } from "./support/database.js";
import { publishedConfiguration } from "./support/collectors.js";
import { E2E_OPAMP_CONTROL_URL } from "./support/environment.js";
import {
  enrollFakeCollector,
  recordFakeCollectorError,
  recordFakeTokenEvents,
  setFakeCollectorState,
  startFakeOpampServerControl,
} from "./support/fake-opamp-server.js";
import { signInThroughApi } from "./support/session.js";

// The fake opamp-server's control port (D17a decision 30, Preflight ruling
// 6; D17b-1 decision 33, Preflight ruling 3; D17b-2 decision 21, Preflight
// ruling 5): the one start-fake-opamp-server.ts serves is up beside the E2E
// API's fake, and the control port, against a fresh fake, enrolls
// collectors with what they report of themselves, sets their last-seen
// time, drift state and reported attributes, records their errors and
// seeds a fleet's token history through the fake's own helpers, which
// the fake's contract routes then answer, and refuses what it
// should (409 for a helper's refusal, 400 for a bad body, 404 for anything
// else; a sha256 or date the contract wouldn't carry and an oversized body
// among the 400s, read to its end so the connection lives on), changing
// nothing; it listens on the loopback only. As
// fake-otelcol-testing.e2e.ts does for the collector tester's control route
// (D14a Ruling 36). No page but the last two tests', which go through the
// E2E API (its request context), the platform's own routes: one pins a
// collector to a published version and reads back what the control port
// seeded, the other pages the token history the control port seeded.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Created {
  fleet: { id: string; summary?: Record<string, unknown> };
  defaultGroup: { id: string };
  tokens: { default: { id: string }; rotate: { id: string } };
}
interface Collector {
  id: string;
  instanceUid?: string;
  name: string;
  groupId: string;
  enrollmentTokenId: string | null;
  lastSeenAt: string;
  liveness: string;
  /** The opamp-server's name (0.2.4); the platform's API answers it as `drift`. */
  sync: string;
  pin: { kind: string; id: string } | null;
  resolution: { from: string; id: string; sha256: string } | null;
  served: { kind: string | null; id: string | null; sha256: string; at: string | null } | null;
  effective: { sha256: string; status: string; error: string | null; at: string } | null;
  reported: { collectorVersion: string | null; ip: string | null; hostIp: string | null; attributes: Record<string, string> | null };
}
interface CollectorError {
  id: string;
  reportedAt: string;
  configSha256: string | null;
  message: string;
}
interface Summary {
  collectors: number;
  online: number;
  warning: number;
  offline: number;
  inSync: number;
  pending: number;
  failed: number;
  lastSeenAt: string | null;
}

/** A fresh fake (real time) and its control port, each on a free port. */
async function aFakeWithControl(): Promise<{ fake: FakeOpampServer; controlUrl: string; address: AddressInfo; close(): Promise<void> }> {
  const fake = await startFakeOpampServer();
  const control = await startFakeOpampServerControl(Promise.resolve(fake), 0);
  const address = control.address() as AddressInfo;
  return {
    fake,
    controlUrl: `http://127.0.0.1:${address.port}`,
    address,
    async close() {
      control.closeAllConnections();
      await new Promise<void>((done) => control.close(() => done()));
      // Rejects on an unread contract violation: every contract request here keeps it.
      await fake.close();
    },
  };
}

/** A request to the fake's own management API (the contract's routes), with its secret. */
async function api<T>(fake: FakeOpampServer, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${fake.url}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${fake.secret}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
}

/** A server fleet in `registered`, or in a new organization, made through the contract's routes. */
async function aFleet(fake: FakeOpampServer, registered?: string): Promise<{ organizationId: string; created: Created }> {
  const organizationId = registered ?? randomUUID();
  if (registered === undefined) {
    expect((await api(fake, "POST", "/organizations", { id: organizationId, name: "Acme" })).status).toBe(201);
  }
  const created = await api<Created>(fake, "POST", `/organizations/${organizationId}/fleets`, {
    label: `edge-${randomUUID()}`,
    type: "server",
    rotateExpiresAt: null,
    actor: null,
  });
  expect(created.status).toBe(201);
  return { organizationId, created: created.body };
}

async function collectorsOf(fake: FakeOpampServer, organizationId: string, fleetId: string): Promise<Collector[]> {
  const listed = await api<{ collectors: Collector[] }>(fake, "GET", `/organizations/${organizationId}/fleets/${fleetId}/collectors`);
  expect(listed.status).toBe(200);
  return listed.body.collectors;
}

async function summaryOf(fake: FakeOpampServer, organizationId: string, fleetId: string): Promise<Summary> {
  const read = await api<{ summary: Summary }>(fake, "GET", `/organizations/${organizationId}/fleets/${fleetId}`);
  expect(read.status).toBe(200);
  return read.body.summary;
}

async function collectorOf(fake: FakeOpampServer, organizationId: string, fleetId: string, collectorId: string): Promise<Collector> {
  const read = await api<Collector>(fake, "GET", `/organizations/${organizationId}/fleets/${fleetId}/collectors/${collectorId}`);
  expect(read.status).toBe(200);
  return read.body;
}

async function errorsOf(fake: FakeOpampServer, organizationId: string, fleetId: string, collectorId: string): Promise<CollectorError[]> {
  const listed = await api<{ errors: CollectorError[]; nextCursor: string | null }>(
    fake,
    "GET",
    `/organizations/${organizationId}/fleets/${fleetId}/collectors/${collectorId}/errors?limit=100`,
  );
  expect(listed.status).toBe(200);
  expect(listed.body.nextCursor).toBeNull();
  return listed.body.errors;
}

const sha256Of = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A request to the control port as written, its answer's status and body:
 * the body parsed when it is JSON, its text when it isn't, null when empty
 * (a 204), so a row answered other than expected fails naming the row
 * rather than on the parse.
 */
async function send(method: string, url: string, body?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  if (text === "") return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}

/** A whole second, so the fake's milliseconds compare exactly. */
const secondsAgo = (seconds: number) => new Date(Math.floor(Date.now() / 1000) * 1000 - seconds * 1000);

test("the E2E fake's control port listens beside it, and refuses a fleet the fake doesn't hold", async () => {
  await expect(enrollFakeCollector(randomUUID(), randomUUID())).rejects.toThrow(
    "The fake opamp-server's control port answered 409 to enroll a collector: enrollCollector: the organization holds no such fleet",
  );
  const unknown = await fetch(`${E2E_OPAMP_CONTROL_URL}/health`);
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "no such route" });
});

test("the control port enrolls a collector on the fleet's default token, seen now, or as a test names it", async () => {
  const { fake, controlUrl, address, close } = await aFakeWithControl();
  try {
    // It listens on the loopback only, as start-fake-opamp-server.ts serves it.
    expect(address.address).toBe("127.0.0.1");
    const { organizationId, created } = await aFleet(fake);
    const fleetId = created.fleet.id;
    const group = await api<{ id: string }>(fake, "POST", `/organizations/${organizationId}/fleets/${fleetId}/groups`, { name: "gateways" });
    expect(group.status).toBe(201);
    const before = Date.now();

    const first = await enrollFakeCollector(organizationId, fleetId, {}, controlUrl);
    const after = Date.now();
    const lastSeenAt = secondsAgo(90);
    const second = await enrollFakeCollector(
      organizationId,
      fleetId,
      { name: "edge-b2", groupId: group.body.id, tokenId: created.tokens.rotate.id, lastSeenAt },
      controlUrl,
    );

    expect(first).toEqual({ id: expect.stringMatching(UUID), instanceUid: expect.stringMatching(UUID), name: expect.stringMatching(/^collector-\d+$/) });
    expect(second).toEqual({ id: expect.stringMatching(UUID), instanceUid: expect.stringMatching(UUID), name: "edge-b2" });
    const collectors = await collectorsOf(fake, organizationId, fleetId);
    const firstRead = collectors.find((c) => c.id === first.id);
    const secondRead = collectors.find((c) => c.id === second.id);
    expect(firstRead).toMatchObject({
      name: first.name,
      groupId: created.defaultGroup.id,
      enrollmentTokenId: created.tokens.default.id,
      liveness: "online",
    });
    expect(Date.parse(firstRead?.lastSeenAt ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(firstRead?.lastSeenAt ?? "")).toBeLessThanOrEqual(after);
    expect(secondRead).toMatchObject({
      name: "edge-b2",
      groupId: group.body.id,
      enrollmentTokenId: created.tokens.rotate.id,
      lastSeenAt: lastSeenAt.toISOString(),
      liveness: "warning",
    });
    // The fleet's summary (D17a decision 17) counts both, last seen the newest.
    expect(await summaryOf(fake, organizationId, fleetId)).toMatchObject({
      collectors: 2,
      online: 1,
      warning: 1,
      lastSeenAt: firstRead?.lastSeenAt,
    });
  } finally {
    await close();
  }
});

test("the control port sets a collector's last-seen time and drift state, and the fleet's summary follows", async () => {
  const { fake, controlUrl, close } = await aFakeWithControl();
  try {
    const { organizationId, created } = await aFleet(fake);
    const fleetId = created.fleet.id;
    // A published version, assigned to the Default group on the contract's routes.
    const publicationId = randomUUID();
    const yaml = `receivers: {}\n# ${publicationId}\n`;
    const sha256 = createHash("sha256").update(yaml, "utf8").digest("hex");
    const published = await api(fake, "POST", `/organizations/${organizationId}/publications`, {
      id: publicationId,
      configuration: { id: randomUUID(), name: "payments-gateway" },
      version: { id: randomUUID(), number: 1, label: null },
      yaml,
      sha256,
      publishedBy: null,
      publishedAt: "2026-10-03T14:02:11.000Z",
      collector: { distribution: "otelcol-contrib", version: "0.162.0" },
    });
    expect(published.status).toBe(201);
    const assigned = await api(fake, "PATCH", `/organizations/${organizationId}/fleets/${fleetId}/groups/${created.defaultGroup.id}`, {
      assignedPublicationId: publicationId,
    });
    expect(assigned.status).toBe(200);
    const collector = await enrollFakeCollector(organizationId, fleetId, {}, controlUrl);

    const tenMinutesAgo = secondsAgo(600);
    await setFakeCollectorState(organizationId, collector.id, { lastSeenAt: tenMinutesAgo }, controlUrl);
    expect(await summaryOf(fake, organizationId, fleetId)).toMatchObject({
      collectors: 1,
      offline: 1,
      pending: 1,
      lastSeenAt: tenMinutesAgo.toISOString(),
    });

    const now = secondsAgo(0);
    await setFakeCollectorState(
      organizationId,
      collector.id,
      { lastSeenAt: now, served: { kind: "publication", id: publicationId }, effective: { sha256, status: "applied" } },
      controlUrl,
    );
    expect(await summaryOf(fake, organizationId, fleetId)).toMatchObject({ online: 1, inSync: 1, lastSeenAt: now.toISOString() });
    expect((await collectorsOf(fake, organizationId, fleetId))[0]).toMatchObject({
      sync: "inSync",
      served: { kind: "publication", id: publicationId, sha256 },
      effective: { sha256, status: "applied", error: null },
    });

    await setFakeCollectorState(organizationId, collector.id, { effective: { sha256, status: "failed", error: "bad config" } }, controlUrl);
    expect((await collectorsOf(fake, organizationId, fleetId))[0]).toMatchObject({
      sync: "failed",
      effective: { status: "failed", error: "bad config" },
    });

    // Served what no publication holds (kind null), at a time the test names, then at none.
    const otherSha256 = createHash("sha256").update(`receivers: {}\n# other ${publicationId}\n`, "utf8").digest("hex");
    const servedAt = secondsAgo(30);
    await setFakeCollectorState(organizationId, collector.id, { served: { kind: null, sha256: otherSha256, at: servedAt } }, controlUrl);
    expect((await collectorsOf(fake, organizationId, fleetId))[0]).toMatchObject({
      served: { kind: null, id: null, sha256: otherSha256, at: servedAt.toISOString() },
    });
    await setFakeCollectorState(organizationId, collector.id, { served: { kind: "publication", id: publicationId, at: null } }, controlUrl);
    expect((await collectorsOf(fake, organizationId, fleetId))[0]).toMatchObject({
      served: { kind: "publication", id: publicationId, sha256, at: null },
    });

    await setFakeCollectorState(organizationId, collector.id, { served: null, effective: null }, controlUrl);
    expect((await collectorsOf(fake, organizationId, fleetId))[0]).toMatchObject({ sync: "pending", served: null, effective: null });
  } finally {
    await close();
  }
});

test("the control port enrolls a collector with what it reports of itself, and changes it, bounded as the agent side bounds it", async () => {
  const { fake, controlUrl, close } = await aFakeWithControl();
  try {
    const { organizationId, created } = await aFleet(fake);
    const fleetId = created.fleet.id;
    const reported = {
      collectorVersion: "0.162.0",
      ip: "10.0.0.7",
      hostIp: "192.168.1.7",
      attributes: { "host.name": "edge-a", "os.type": "linux" },
    };
    const collector = await enrollFakeCollector(organizationId, fleetId, { reported }, controlUrl);
    const silent = await enrollFakeCollector(organizationId, fleetId, {}, controlUrl);

    expect((await collectorOf(fake, organizationId, fleetId, collector.id)).reported).toEqual(reported);
    expect((await collectorOf(fake, organizationId, fleetId, silent.id)).reported).toEqual({
      collectorVersion: null,
      ip: null,
      hostIp: null,
      attributes: null,
    });

    // The fake's reportedOf bounds each value: a version trimmed of its
    // spaces, an address over 100 characters keeping the stored one, null
    // clearing a field, attributes past 16,384 bytes as jsonb losing what
    // doesn't fit.
    await setFakeCollectorState(
      organizationId,
      collector.id,
      {
        reported: {
          collectorVersion: "  0.163.0\n",
          ip: "1".repeat(101),
          hostIp: null,
          attributes: { "host.name": "x".repeat(20_000), "service.name": "otelcol" },
        },
      },
      controlUrl,
    );
    expect((await collectorOf(fake, organizationId, fleetId, collector.id)).reported).toEqual({
      collectorVersion: "0.163.0",
      ip: "10.0.0.7",
      hostIp: null,
      attributes: { "service.name": "otelcol" },
    });

    // A field left out stays; attributes null clears them; an empty report changes nothing.
    await setFakeCollectorState(organizationId, collector.id, { reported: { attributes: null } }, controlUrl);
    await setFakeCollectorState(organizationId, collector.id, { reported: {} }, controlUrl);
    expect((await collectorOf(fake, organizationId, fleetId, collector.id)).reported).toEqual({
      collectorVersion: "0.163.0",
      ip: "10.0.0.7",
      hostIp: null,
      attributes: null,
    });
  } finally {
    await close();
  }
});

test("the control port records a collector's errors, which its history answers newest first: the message cut to 8 KiB, the newest 100 kept", async () => {
  const { fake, controlUrl, close } = await aFakeWithControl();
  try {
    const { organizationId, created } = await aFleet(fake);
    const fleetId = created.fleet.id;
    const collector = await enrollFakeCollector(organizationId, fleetId, {}, controlUrl);
    const other = await enrollFakeCollector(organizationId, fleetId, {}, controlUrl);
    const configSha256 = sha256Of("receivers: {}\n");

    const oldest = secondsAgo(600);
    const first = await recordFakeCollectorError(
      organizationId,
      collector.id,
      { message: "failed to start: no receivers", configSha256, reportedAt: oldest },
      controlUrl,
    );
    const before = Date.now();
    // 5,000 two-byte characters: cut at 8,192 bytes, on a character's boundary.
    const second = await recordFakeCollectorError(organizationId, collector.id, { message: "\u00e9".repeat(5_000), configSha256: null }, controlUrl);
    const after = Date.now();

    expect(first).toEqual({ id: expect.stringMatching(UUID) });
    expect(second).toEqual({ id: expect.stringMatching(UUID) });
    const errors = await errorsOf(fake, organizationId, fleetId, collector.id);
    expect(errors).toEqual([
      { id: second.id, reportedAt: expect.any(String), configSha256: null, message: "\u00e9".repeat(4_096) },
      { id: first.id, reportedAt: oldest.toISOString(), configSha256, message: "failed to start: no receivers" },
    ]);
    // Reported now when the test names no time.
    expect(Date.parse(errors[0]?.reportedAt ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(errors[0]?.reportedAt ?? "")).toBeLessThanOrEqual(after);
    // Its own history only.
    expect(await errorsOf(fake, organizationId, fleetId, other.id)).toEqual([]);

    // 99 more, newer than the first: the history keeps its newest 100, the first gone.
    const base = secondsAgo(300).getTime();
    for (let n = 0; n < 99; n += 1) {
      await recordFakeCollectorError(organizationId, collector.id, { message: `failed ${n}`, reportedAt: new Date(base + n * 1000) }, controlUrl);
    }
    const kept = await errorsOf(fake, organizationId, fleetId, collector.id);
    expect(kept).toHaveLength(100);
    expect(kept[0]?.id).toBe(second.id);
    expect(kept[1]?.message).toBe("failed 98");
    expect(kept[99]?.message).toBe("failed 0");
    expect(kept.map((error) => error.id)).not.toContain(first.id);
  } finally {
    await close();
  }
});

test("the control port refuses: a helper's refusal 409, a bad body 400, anything else 404, and nothing changes", async () => {
  const { fake, controlUrl, close } = await aFakeWithControl();
  try {
    const { organizationId, created } = await aFleet(fake);
    const fleetId = created.fleet.id;
    const archived = await aFleet(fake, organizationId);
    const archive = await api(fake, "PATCH", `/organizations/${organizationId}/fleets/${archived.created.fleet.id}`, { status: "archived" });
    expect(archive.status).toBe(200);
    const revoke = await api(fake, "POST", `/organizations/${organizationId}/fleets/${fleetId}/tokens/${created.tokens.rotate.id}/revoke`, {
      actor: null,
    });
    expect(revoke.status).toBe(200);
    const collector = await enrollFakeCollector(organizationId, fleetId, { name: "edge-a" }, controlUrl);
    const other = await aFleet(fake);
    const theirs = await enrollFakeCollector(other.organizationId, other.created.fleet.id, {}, controlUrl);
    const before = fake.snapshotOf(organizationId);
    const theirsBefore = fake.snapshotOf(other.organizationId);

    // A helper's refusal: 409, with its fixed message.
    const enroll = "enroll a collector";
    const change = "set a collector's state";
    const record = "record a collector's error";
    const seed = "record a fleet's token events";
    const refusals: [() => Promise<unknown>, string, string][] = [
      [() => enrollFakeCollector(organizationId, fleetId, { name: "edge-a" }, controlUrl), enroll, "enrollCollector: the name is invalid or taken"],
      [() => enrollFakeCollector(organizationId, randomUUID(), {}, controlUrl), enroll, "enrollCollector: the organization holds no such fleet"],
      [() => enrollFakeCollector(other.organizationId, fleetId, {}, controlUrl), enroll, "enrollCollector: the organization holds no such fleet"],
      [() => enrollFakeCollector(organizationId, fleetId, { groupId: randomUUID() }, controlUrl), enroll, "enrollCollector: the fleet holds no such group"],
      [() => enrollFakeCollector(organizationId, fleetId, { tokenId: randomUUID() }, controlUrl), enroll, "enrollCollector: the fleet holds no such token"],
      [
        () => enrollFakeCollector(organizationId, fleetId, { tokenId: created.tokens.rotate.id }, controlUrl),
        enroll,
        "enrollCollector: the token is revoked or expired",
      ],
      [() => enrollFakeCollector(organizationId, archived.created.fleet.id, {}, controlUrl), enroll, "enrollCollector: the fleet is archived"],
      [() => setFakeCollectorState(organizationId, randomUUID(), { lastSeenAt: new Date() }, controlUrl), change, "the organization holds no such collector"],
      [() => setFakeCollectorState(organizationId, theirs.id, { lastSeenAt: new Date() }, controlUrl), change, "the organization holds no such collector"],
      [
        () => setFakeCollectorState(organizationId, theirs.id, { reported: { ip: "10.0.0.9" } }, controlUrl),
        change,
        "the organization holds no such collector",
      ],
      [
        () => setFakeCollectorState(organizationId, collector.id, { served: { kind: "publication", id: randomUUID() } }, controlUrl),
        change,
        "setCollectorState: the served target isn't held",
      ],
      // Writing fields beside a failing served target: refused whole, nothing written.
      [
        () =>
          setFakeCollectorState(
            organizationId,
            collector.id,
            { reported: { ip: "10.0.0.9" }, lastSeenAt: new Date(), served: { kind: "publication", id: randomUUID() } },
            controlUrl,
          ),
        change,
        "setCollectorState: the served target isn't held",
      ],
      [() => recordFakeCollectorError(organizationId, randomUUID(), { message: "failed" }, controlUrl), record, "the organization holds no such collector"],
      [() => recordFakeCollectorError(organizationId, theirs.id, { message: "failed" }, controlUrl), record, "the organization holds no such collector"],
      [() => recordFakeCollectorError(organizationId, collector.id, { message: "" }, controlUrl), record, "recordCollectorError: the message is empty"],
      [() => recordFakeTokenEvents(organizationId, randomUUID(), { count: 1 }, controlUrl), seed, "recordTokenEvents: the organization holds no such fleet"],
      [
        () => recordFakeTokenEvents(organizationId, other.created.fleet.id, { count: 1 }, controlUrl),
        seed,
        "recordTokenEvents: the organization holds no such fleet",
      ],
      [
        () => recordFakeTokenEvents(organizationId, fleetId, { count: 1, tokenId: randomUUID() }, controlUrl),
        seed,
        "recordTokenEvents: the fleet holds no such token",
      ],
      // Another fleet's token, even the organization's.
      [
        () => recordFakeTokenEvents(organizationId, fleetId, { count: 1, tokenId: archived.created.tokens.rotate.id }, controlUrl),
        seed,
        "recordTokenEvents: the fleet holds no such token",
      ],
      // Each next event a millisecond earlier: the second would be before the year 0001.
      [
        () => recordFakeTokenEvents(organizationId, fleetId, { count: 2, occurredAt: new Date("0001-01-01T00:00:00.000Z") }, controlUrl),
        seed,
        "recordTokenEvents: the oldest event is before the year 0001",
      ],
    ];
    for (const [refused, what, message] of refusals) {
      await expect(refused()).rejects.toThrow(`answered 409 to ${what}: ${message}`);
    }

    // A body that isn't JSON, or isn't the control port's shape: 400.
    const enrollPath = `${controlUrl}/organizations/${organizationId}/fleets/${fleetId}/collectors`;
    const collectorPath = `${controlUrl}/organizations/${organizationId}/collectors/${collector.id}`;
    const errorsPath = `${collectorPath}/errors`;
    const tokenEventsPath = `${controlUrl}/organizations/${organizationId}/fleets/${fleetId}/token-events`;
    // The imports path a test once added imports through: no route since D16c removed importing.
    const importsPath = `${controlUrl}/organizations/${organizationId}/fleets/${fleetId}/imports`;
    const hash = "a".repeat(64);
    // Instants outside the years 0001 to 9999 UTC once the offset is applied
    // (the last four written inside them), the last two just outside: one
    // millisecond before the first instant, and the first instant after the
    // last millisecond.
    const outsideTheYears = [
      "0000-01-01T00:30:00+01:00",
      "0001-01-01T00:30:00+01:00",
      "9999-12-31T23:30:00-01:00",
      "0001-01-01T00:59:59.999+01:00",
      "9999-12-31T23:00:00-01:00",
    ];
    const badBodies: [string, string, string, string][] = [
      ["POST", enrollPath, "not json", "the body isn't JSON"],
      ["POST", enrollPath, "", "the body isn't JSON"],
      ["POST", enrollPath, "[]", "the body isn't an object"],
      ["POST", enrollPath, "null", "the body isn't an object"],
      ["POST", enrollPath, JSON.stringify({ nmae: "edge-b" }), "the body holds a field the control port doesn't take"],
      ["POST", enrollPath, JSON.stringify({ name: 7 }), "name isn't a string"],
      ["POST", enrollPath, JSON.stringify({ lastSeenAt: "yesterday" }), "lastSeenAt isn't an ISO 8601 date"],
      // A date Date would read, but not ISO 8601 as the helpers send: refused.
      ["POST", enrollPath, JSON.stringify({ lastSeenAt: "Tue, 13 Oct 2026 14:02:11 GMT" }), "lastSeenAt isn't an ISO 8601 date"],
      ["POST", enrollPath, JSON.stringify({ lastSeenAt: "2026-10-13" }), "lastSeenAt isn't an ISO 8601 date"],
      ["POST", enrollPath, "x".repeat(64 * 1024 + 1), "the body is too large"],
      ["PATCH", collectorPath, "{", "the body isn't JSON"],
      ["PATCH", collectorPath, JSON.stringify({ reportd: { ip: "10.0.0.1" } }), "the body holds a field the control port doesn't take"],
      ["PATCH", collectorPath, JSON.stringify({ lastSeenAt: 1_700_000_000_000 }), "lastSeenAt isn't a string"],
      ["PATCH", collectorPath, JSON.stringify({ served: { kind: "other", id: randomUUID() } }), "served.kind isn't publication or null"],
      // D16c: an import is no kind of served state.
      ["PATCH", collectorPath, JSON.stringify({ served: { kind: "import", id: randomUUID() } }), "served.kind isn't publication or null"],
      ["PATCH", collectorPath, JSON.stringify({ served: { kind: null, id: randomUUID(), sha256: "a" } }), "served.id is set with no kind"],
      ["PATCH", collectorPath, JSON.stringify({ effective: { sha256: "a", status: "done" } }), "effective.status isn't applied, applying or failed"],
      ["PATCH", collectorPath, JSON.stringify({ effective: { status: "applied" } }), "effective.sha256 isn't a string"],
      // A sha256 the contract wouldn't carry: refused, the value never echoed.
      ["PATCH", collectorPath, JSON.stringify({ served: { kind: null, sha256: "not-a-hash" } }), "served.sha256 isn't a SHA-256"],
      ["PATCH", collectorPath, JSON.stringify({ served: { kind: "publication", id: randomUUID(), sha256: "AB".repeat(32) } }), "served.sha256 isn't a SHA-256"],
      ["PATCH", collectorPath, JSON.stringify({ effective: { sha256: "a".repeat(63), status: "applied" } }), "effective.sha256 isn't a SHA-256"],
      ["PATCH", collectorPath, JSON.stringify({ effective: { sha256: "a".repeat(64), status: "applied", at: "13/10/2026" } }), "effective.at isn't an ISO 8601 date"],
      ["PATCH", collectorPath, JSON.stringify({ served: { kind: null, sha256: "a".repeat(64), at: "now" } }), "served.at isn't an ISO 8601 date"],
      // An instant outside the years 0001 to 9999 UTC once its offset is applied: refused, for every date.
      ...outsideTheYears.flatMap((at): [string, string, string, string][] => [
        ["POST", enrollPath, JSON.stringify({ lastSeenAt: at }), "lastSeenAt isn't in the years 0001 to 9999 UTC"],
        ["PATCH", collectorPath, JSON.stringify({ lastSeenAt: at }), "lastSeenAt isn't in the years 0001 to 9999 UTC"],
        ["PATCH", collectorPath, JSON.stringify({ served: { kind: null, sha256: hash, at } }), "served.at isn't in the years 0001 to 9999 UTC"],
        [
          "PATCH",
          collectorPath,
          JSON.stringify({ effective: { sha256: hash, status: "applied", at } }),
          "effective.at isn't in the years 0001 to 9999 UTC",
        ],
        ["POST", errorsPath, JSON.stringify({ message: "failed", reportedAt: at }), "reportedAt isn't in the years 0001 to 9999 UTC"],
        ["POST", tokenEventsPath, JSON.stringify({ count: 1, occurredAt: at }), "occurredAt isn't in the years 0001 to 9999 UTC"],
      ]),
      // What a collector reports of itself: its types checked, the field named, never the value.
      ["POST", enrollPath, JSON.stringify({ reported: null }), "reported isn't an object"],
      ["POST", enrollPath, JSON.stringify({ reported: ["10.0.0.1"] }), "reported isn't an object"],
      ["POST", enrollPath, JSON.stringify({ reported: { ip: 10 } }), "reported.ip isn't a string or null"],
      ["PATCH", collectorPath, JSON.stringify({ reported: { ipAddress: "10.0.0.1" } }), "reported holds a field the control port doesn't take"],
      ["PATCH", collectorPath, JSON.stringify({ reported: { collectorVersion: 162 } }), "reported.collectorVersion isn't a string or null"],
      ["PATCH", collectorPath, JSON.stringify({ reported: { hostIp: {} } }), "reported.hostIp isn't a string or null"],
      ["PATCH", collectorPath, JSON.stringify({ reported: { attributes: "host.name=edge-a" } }), "reported.attributes isn't an object or null"],
      ["PATCH", collectorPath, JSON.stringify({ reported: { attributes: ["edge-a"] } }), "reported.attributes isn't an object or null"],
      [
        "PATCH",
        collectorPath,
        JSON.stringify({ reported: { attributes: { "host.name": "edge-a", "host.cpus": 4 } } }),
        "reported.attributes holds a value that isn't a string",
      ],
      // A collector's error.
      ["POST", errorsPath, "not json", "the body isn't JSON"],
      ["POST", errorsPath, "[]", "the body isn't an object"],
      ["POST", errorsPath, "{}", "message isn't a string"],
      ["POST", errorsPath, JSON.stringify({ message: 7 }), "message isn't a string"],
      ["POST", errorsPath, JSON.stringify({ message: null }), "message isn't a string"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", level: "error" }), "the body holds a field the control port doesn't take"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", configSha256: 7 }), "configSha256 isn't a string"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", configSha256: "not-a-hash" }), "configSha256 isn't a SHA-256"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", configSha256: "AB".repeat(32) }), "configSha256 isn't a SHA-256"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", configSha256: `${hash}0` }), "configSha256 isn't a SHA-256"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", reportedAt: "yesterday" }), "reportedAt isn't an ISO 8601 date"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", reportedAt: "2026-10-13" }), "reportedAt isn't an ISO 8601 date"],
      ["POST", errorsPath, JSON.stringify({ message: "failed", reportedAt: null }), "reportedAt isn't a string"],
      ["POST", errorsPath, JSON.stringify({ message: "x".repeat(64 * 1024) }), "the body is too large"],
      // A fleet's token history: each field named, never its value.
      ["POST", tokenEventsPath, "not json", "the body isn't JSON"],
      ["POST", tokenEventsPath, "[]", "the body isn't an object"],
      ["POST", tokenEventsPath, "{}", "count isn't an integer from 1 to 500"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 0 }), "count isn't an integer from 1 to 500"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 501 }), "count isn't an integer from 1 to 500"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1.5 }), "count isn't an integer from 1 to 500"],
      ["POST", tokenEventsPath, JSON.stringify({ count: "3" }), "count isn't an integer from 1 to 500"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, event: "minted" }), "event isn't issued, viewed, rotated or revoked"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, event: null }), "event isn't issued, viewed, rotated or revoked"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, tokenId: 7 }), "tokenId isn't a string"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: "sam@acme.io" }), "actor isn't an object"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: ["sam@acme.io"] }), "actor isn't an object"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: { id: randomUUID(), email: "sam@acme.io", name: "Sam" } }), "actor holds a field the control port doesn't take"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: { id: 7, email: "sam@acme.io" } }), "actor.id isn't a string"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: { id: "sam", email: "sam@acme.io" } }), "actor.id isn't a UUID"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: { id: randomUUID() } }), "actor.email isn't a string"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: { id: randomUUID(), email: "" } }), "actor.email isn't 1 to 320 characters"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: { id: randomUUID(), email: "x".repeat(321) } }), "actor.email isn't 1 to 320 characters"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, actor: { id: randomUUID(), email: "sam\u0000@acme.io" } }), "actor.email holds U+0000"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, occurredAt: "yesterday" }), "occurredAt isn't an ISO 8601 date"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, occurredAt: 1_700_000_000_000 }), "occurredAt isn't a string"],
      ["POST", tokenEventsPath, JSON.stringify({ count: 1, bearer: "c2VjcmV0" }), "the body holds a field the control port doesn't take"],
      ["POST", tokenEventsPath, "x".repeat(64 * 1024 + 1), "the body is too large"],
    ];
    for (const [method, url, body, error] of badBodies) {
      expect(await send(method, url, body), `${method} ${body}`).toEqual({ status: 400, body: { error } });
    }

    // Far past the cap, each sent several times: every 400 arrives. A
    // probabilistic regression net only: before the Task 4 review's fix a
    // reset connection met about one 8 MiB send in six, so these rounds
    // would likely, not surely, catch its return. The proof that the body is
    // drained is the raw-socket test below (the connection stays open).
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      for (const size of [256 * 1024, 8 * 1024 * 1024]) {
        expect(await send("POST", enrollPath, "x".repeat(size)), `${size} bytes, attempt ${attempt}`).toEqual({
          status: 400,
          body: { error: "the body is too large" },
        });
      }
    }

    // Anything else: 404, the contract's own paths among them.
    const elsewhere: [string, string][] = [
      ["GET", enrollPath],
      ["PATCH", enrollPath],
      ["POST", collectorPath],
      ["PUT", collectorPath],
      ["DELETE", collectorPath],
      ["POST", `${enrollPath}/extra`],
      ["POST", `${controlUrl}/api/v1/organizations/${organizationId}/fleets/${fleetId}/collectors`],
      ["GET", errorsPath],
      ["PATCH", errorsPath],
      ["POST", `${errorsPath}/extra`],
      ["POST", `${controlUrl}/organizations/${organizationId}/fleets/${fleetId}/collectors/${collector.id}/errors`],
      ["POST", `${controlUrl}/api/v1/organizations/${organizationId}/collectors/${collector.id}/errors`],
      ["POST", importsPath],
      ["GET", tokenEventsPath],
      ["PATCH", tokenEventsPath],
      ["POST", `${tokenEventsPath}/extra`],
      ["POST", `${controlUrl}/api/v1/organizations/${organizationId}/fleets/${fleetId}/token-events`],
      // The contract's own path for the history: not the control port's.
      ["POST", `${controlUrl}/organizations/${organizationId}/fleets/${fleetId}/tokens/events`],
      ["PATCH", `${controlUrl}/organizations/%E0%A4%A/collectors/${collector.id}`],
      ["GET", `${controlUrl}/`],
    ];
    for (const [method, url] of elsewhere) {
      const body = method === "GET" ? undefined : "{}";
      expect(await send(method, url, body), `${method} ${url}`).toEqual({ status: 404, body: { error: "no such route" } });
    }

    expect(fake.snapshotOf(organizationId)).toEqual(before);
    expect(fake.snapshotOf(other.organizationId)).toEqual(theirsBefore);
  } finally {
    await close();
  }
});

test("the control port accepts the first and the last instants of the years 0001 to 9999 UTC, for every date", async () => {
  const { fake, controlUrl, close } = await aFakeWithControl();
  try {
    const { organizationId, created } = await aFleet(fake);
    const fleetId = created.fleet.id;
    const collector = await enrollFakeCollector(organizationId, fleetId, {}, controlUrl);
    const enrollPath = `${controlUrl}/organizations/${organizationId}/fleets/${fleetId}/collectors`;
    const collectorPath = `${controlUrl}/organizations/${organizationId}/collectors/${collector.id}`;
    const errorsPath = `${collectorPath}/errors`;
    const tokenEventsPath = `${controlUrl}/organizations/${organizationId}/fleets/${fleetId}/token-events`;
    const hash = "a".repeat(64);
    const edges = ["0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z"];
    for (const at of edges) {
      const rows: [string, string, string, number][] = [
        ["POST", enrollPath, JSON.stringify({ lastSeenAt: at }), 201],
        ["PATCH", collectorPath, JSON.stringify({ served: { kind: null, sha256: hash, at } }), 204],
        ["PATCH", collectorPath, JSON.stringify({ effective: { sha256: hash, status: "applied", at } }), 204],
        ["POST", errorsPath, JSON.stringify({ message: "failed", reportedAt: at }), 201],
        ["PATCH", collectorPath, JSON.stringify({ lastSeenAt: at }), 204],
        ["POST", tokenEventsPath, JSON.stringify({ count: 1, occurredAt: at }), 201],
      ];
      const answers: unknown[] = [];
      for (const [method, url, body, status] of rows) {
        const answer = await send(method, url, body);
        expect(answer.status, `${method} ${body}: ${JSON.stringify(answer.body)}`).toBe(status);
        answers.push(answer.body);
      }
      // The collector enrolled at the edge holds it exactly (never "now").
      const { id: enrolledId } = answers[0] as { id: string };
      const enrolled = await collectorOf(fake, organizationId, fleetId, enrolledId);
      expect(Date.parse(enrolled.lastSeenAt), "the enrolment's lastSeenAt").toBe(Date.parse(at));
      expect(enrolled.lastSeenAt, "the enrolment's lastSeenAt").toBe(new Date(at).toISOString());
      // Each date held as sent, and answered within the contract's date-time.
      const read = await collectorOf(fake, organizationId, fleetId, collector.id);
      expect(read.lastSeenAt, "the PATCH's lastSeenAt").toBe(new Date(at).toISOString());
      expect(Date.parse(read.lastSeenAt), "lastSeenAt").toBe(Date.parse(at));
      expect(Date.parse(read.served!.at!), "served.at").toBe(Date.parse(at));
      expect(Date.parse(read.effective!.at), "effective.at").toBe(Date.parse(at));
      const [newest] = await errorsOf(fake, organizationId, fleetId, collector.id);
      expect(Date.parse(newest!.reportedAt), "reportedAt").toBe(Date.parse(at));
      const history = await api<{ events: { occurredAt: string }[] }>(fake, "GET", `/organizations/${organizationId}/fleets/${fleetId}/tokens/events?limit=100`);
      expect(history.body.events.map((event) => Date.parse(event.occurredAt)), "occurredAt").toContain(Date.parse(at));
    }
  } finally {
    await close();
  }
});

test("the control port seeds a fleet's token history, the newest at the time named and each next a millisecond earlier, its actor kept", async () => {
  const { fake, controlUrl, close } = await aFakeWithControl();
  try {
    const { organizationId, created } = await aFleet(fake);
    const fleetId = created.fleet.id;
    const other = await aFleet(fake, organizationId);
    const newest = secondsAgo(3600);
    const oldest = secondsAgo(7200);
    const actor = { id: randomUUID(), email: "sam@acme.example" };

    expect(await recordFakeTokenEvents(organizationId, fleetId, { count: 3, occurredAt: newest, actor }, controlUrl)).toEqual({ count: 3 });
    expect(
      await recordFakeTokenEvents(
        organizationId,
        fleetId,
        { count: 1, event: "revoked", tokenId: created.tokens.rotate.id, occurredAt: oldest },
        controlUrl,
      ),
    ).toEqual({ count: 1 });

    const listed = await api<{ events: { tokenId: string; event: string; actor: unknown; occurredAt: string }[]; nextCursor: string | null }>(
      fake,
      "GET",
      `/organizations/${organizationId}/fleets/${fleetId}/tokens/events`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.nextCursor).toBeNull();
    // The create's two issued (now) first, then the seeded ones.
    expect(listed.body.events.slice(0, 2).map((event) => event.event)).toEqual(["issued", "issued"]);
    expect(listed.body.events.slice(2).map((event) => [event.event, event.tokenId, event.actor, event.occurredAt])).toEqual([
      ["viewed", created.tokens.default.id, actor, newest.toISOString()],
      ["viewed", created.tokens.default.id, actor, new Date(newest.getTime() - 1).toISOString()],
      ["viewed", created.tokens.default.id, actor, new Date(newest.getTime() - 2).toISOString()],
      ["revoked", created.tokens.rotate.id, null, oldest.toISOString()],
    ]);
    // Seeding writes events only: the token stays unrevoked, and the other fleet's history is its own.
    const tokens = await api<{ tokens: { id: string; revokedAt: string | null }[] }>(fake, "GET", `/organizations/${organizationId}/fleets/${fleetId}/tokens`);
    expect(tokens.body.tokens.find((token) => token.id === created.tokens.rotate.id)?.revokedAt).toBeNull();
    const theirs = await api<{ events: unknown[] }>(fake, "GET", `/organizations/${organizationId}/fleets/${other.created.fleet.id}/tokens/events`);
    expect(theirs.body.events).toHaveLength(2);
  } finally {
    await close();
  }
});

/**
 * A raw HTTP/1.1 connection to `port`: requests written as given, responses
 * read in order (a Content-Length body or a chunked one), or "closed" once
 * the server has closed (or reset) the connection with no whole response left.
 */
async function rawConnection(port: number) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let received = Buffer.alloc(0);
  let closed = false;
  let wake: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    wake?.();
  });
  socket.on("close", () => {
    closed = true;
    wake?.();
  });
  // A reset shows as "close".
  socket.on("error", () => {});

  /** The whole response at the head of what has arrived, taken off it, or undefined while it is incomplete. */
  function take(): { status: number; body: string } | undefined {
    const headEnd = received.indexOf("\r\n\r\n");
    if (headEnd < 0) return undefined;
    const head = received.subarray(0, headEnd).toString("latin1");
    const status = Number(head.split(" ")[1]);
    let at = headEnd + 4;
    const length = /\r\ncontent-length: *(\d+)/i.exec(head);
    if (length !== null) {
      const end = at + Number(length[1]);
      if (received.length < end) return undefined;
      const body = received.subarray(at, end).toString("utf8");
      received = received.subarray(end);
      return { status, body };
    }
    // Chunked: size lines, each chunk, then the empty last one.
    const parts: Buffer[] = [];
    for (;;) {
      const lineEnd = received.indexOf("\r\n", at);
      if (lineEnd < 0) return undefined;
      const size = parseInt(received.subarray(at, lineEnd).toString("latin1"), 16);
      const chunkEnd = lineEnd + 2 + size;
      if (received.length < chunkEnd + 2) return undefined;
      if (size === 0) {
        received = received.subarray(chunkEnd + 2);
        return { status, body: Buffer.concat(parts).toString("utf8") };
      }
      parts.push(received.subarray(lineEnd + 2, chunkEnd));
      at = chunkEnd + 2;
    }
  }

  return {
    write(request: string): Promise<void> {
      // A write to a closed connection fails; the next response then reads "closed".
      return new Promise((done) => socket.write(request, () => done()));
    },
    async response(): Promise<{ status: number; body: string } | "closed"> {
      for (;;) {
        const whole = take();
        if (whole !== undefined) return whole;
        if (closed) return "closed";
        await new Promise<void>((resume) => {
          wake = resume;
        });
        wake = undefined;
      }
    },
    close: () => socket.destroy(),
  };
}

test("the control port drains an oversized body to its end: its 400 arrives, and the connection serves the next request", async () => {
  const { fake, address, close } = await aFakeWithControl();
  const connection = await rawConnection(address.port);
  try {
    const { organizationId, created } = await aFleet(fake);
    const enrollPath = `/organizations/${organizationId}/fleets/${created.fleet.id}/collectors`;
    const before = fake.snapshotOf(organizationId);

    for (const size of [64 * 1024 + 1, 256 * 1024, 8 * 1024 * 1024]) {
      await connection.write(
        `POST ${enrollPath} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: ${size}\r\n\r\n${"x".repeat(size)}`,
      );
      expect(await connection.response(), `${size} bytes`).toEqual({
        status: 400,
        body: JSON.stringify({ error: "the body is too large" }),
      });
    }
    // Had the server stopped reading mid-body, it would have destroyed the connection: the same one answers again.
    await connection.write(`GET ${enrollPath} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n`);
    expect(await connection.response()).toEqual({ status: 404, body: JSON.stringify({ error: "no such route" }) });

    expect(fake.snapshotOf(organizationId)).toEqual(before);
  } finally {
    connection.close();
    await close();
  }
});

test("what the E2E fake's control port seeds reaches the platform: a collector's attributes and errors, and a published version it is pinned to through the platform's PATCH, in sync", async ({
  page,
}) => {
  const user = await seedUser({ password: "correct horse battery staple" });
  await signInThroughApi(page, user);
  const organizationId = user.organizationId;
  const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
  const createdFleet = await page.request.post(`/api/v1/organizations/${organizationId}/fleets`, {
    data: { label: `edge-${randomUUID().slice(0, 8)}`, type: "server", rotateExpiresAt: null },
    headers: csrf,
  });
  expect(createdFleet.status()).toBe(201);
  const fleetId = ((await createdFleet.json()) as FleetCreatedResponse).fleet.id;
  const collectorsPath = `/api/v1/organizations/${organizationId}/fleets/${fleetId}/collectors`;

  const { versionId } = await publishedConfiguration(page, organizationId, user.userId, `control-${randomUUID().slice(0, 8)}`);
  const reported = { collectorVersion: "0.162.0", ip: "10.0.0.7", hostIp: "192.168.1.7", attributes: { "host.name": "edge-a" } };
  const collector = await enrollFakeCollector(organizationId, fleetId, { name: "edge-a", reported });

  const pinned = await page.request.patch(`${collectorsPath}/${collector.id}`, {
    data: { pin: { kind: "version", versionId } },
    headers: csrf,
  });
  expect(pinned.status()).toBe(200);
  const pinnedCollector = ((await pinned.json()) as { collector: { pin: { publishedVersionId: string }; resolution: { sha256: string } } }).collector;
  const publishedVersionId = pinnedCollector.pin.publishedVersionId;
  const sha256 = pinnedCollector.resolution.sha256;
  expect((await pinned.json()) as unknown).toMatchObject({
    collector: {
      pin: { kind: "version", versionId, publishedVersionId: expect.stringMatching(UUID) },
      resolution: { from: "pinnedVersion", publishedVersionId, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    },
  });

  const reportedAt = secondsAgo(30);
  const error = await recordFakeCollectorError(organizationId, collector.id, {
    message: "failed to start: no receivers",
    configSha256: sha256,
    reportedAt,
  });
  await setFakeCollectorState(organizationId, collector.id, {
    served: { kind: "publication", id: publishedVersionId },
    effective: { sha256, status: "applied" },
  });
  const read = await page.request.get(`${collectorsPath}/${collector.id}`);
  expect(read.status()).toBe(200);
  expect((await read.json()) as unknown).toMatchObject({
    collector: {
      name: "edge-a",
      reported,
      served: { kind: "version", publishedVersionId, sha256, version: { versionId } },
      effective: { sha256, status: "applied", error: null },
      drift: "inSync",
    },
  });

  const errors = await page.request.get(`${collectorsPath}/${collector.id}/errors`);
  expect(errors.status()).toBe(200);
  expect((await errors.json()) as unknown).toEqual({
    errors: [{ id: error.id, reportedAt: reportedAt.toISOString(), configSha256: sha256, message: "failed to start: no receivers" }],
    nextCursor: null,
  });
});

test("the control port seeds a fleet's token history, which the platform pages newest first", async ({ page }) => {
  const user = await seedUser({ password: "correct horse battery staple" });
  await signInThroughApi(page, user);
  const organizationId = user.organizationId;
  const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
  const createdFleet = await page.request.post(`/api/v1/organizations/${organizationId}/fleets`, {
    data: { label: `edge-${randomUUID().slice(0, 8)}`, type: "server", rotateExpiresAt: null },
    headers: csrf,
  });
  expect(createdFleet.status()).toBe(201);
  const created = (await createdFleet.json()) as FleetCreatedResponse;
  const fleetId = created.fleet.id;
  const eventsPath = `/api/v1/organizations/${organizationId}/fleets/${fleetId}/tokens/events`;

  // Older than the create's two issued: 59 viewed by the person, then one rotated by no one.
  const newest = secondsAgo(3600);
  const oldest = secondsAgo(7200);
  await recordFakeTokenEvents(organizationId, fleetId, { count: 59, occurredAt: newest, actor: { id: user.userId, email: user.email } });
  await recordFakeTokenEvents(organizationId, fleetId, { count: 1, event: "rotated", tokenId: created.tokens.rotate.id, occurredAt: oldest });

  type Page = { events: { id: string; tokenId: string; event: string; actor: unknown; occurredAt: string }[]; nextCursor: string | null };
  const first = await page.request.get(eventsPath);
  expect(first.status()).toBe(200);
  expect(first.headers()["cache-control"] ?? "").not.toContain("no-store");
  const firstPage = (await first.json()) as Page;
  expect(firstPage.events).toHaveLength(50);
  expect(firstPage.nextCursor).toEqual(expect.any(String));
  expect(firstPage.events.slice(0, 2).map((event) => [event.event, event.actor])).toEqual([
    ["issued", { userId: user.userId, email: user.email }],
    ["issued", { userId: user.userId, email: user.email }],
  ]);
  expect(firstPage.events[2]).toEqual({
    id: expect.stringMatching(UUID),
    tokenId: created.tokens.default.id,
    event: "viewed",
    actor: { userId: user.userId, email: user.email },
    occurredAt: newest.toISOString(),
  });

  const second = await page.request.get(`${eventsPath}?cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`);
  expect(second.status()).toBe(200);
  const secondPage = (await second.json()) as Page;
  expect(secondPage.nextCursor).toBeNull();
  // The create's 2, the 59 seeded and the 1: 62 in all, 12 on the second page.
  expect(secondPage.events).toHaveLength(12);
  expect(secondPage.events.at(-1)).toMatchObject({ event: "rotated", tokenId: created.tokens.rotate.id, actor: null, occurredAt: oldest.toISOString() });
  // Newest first across both pages, no event twice.
  const times = [...firstPage.events, ...secondPage.events].map((event) => Date.parse(event.occurredAt));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(new Set([...firstPage.events, ...secondPage.events].map((event) => event.id)).size).toBe(62);
});
