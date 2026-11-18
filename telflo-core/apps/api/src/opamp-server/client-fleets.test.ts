import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeOpampServer, type FakeOpampServer } from "../testing/fake-opamp-server.js";
import { createOpampServerClient, sha256Hex, type OpampServerClient } from "./client.js";

// The opamp-server client's methods for D16a's fleet model (D16b Task 2,
// decision 12), each documented result against the fake, which checks every
// request and reply against vendor/opamp-server/openapi.yaml: every
// test ends with no unread violation. The fake's clock is `clock`, moved by
// a test and reset before each.

const BASE = Date.parse("2026-10-13T09:00:00.000Z");
let clock = BASE;
const at = (offset: number) => new Date(BASE + offset).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ACTOR = { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", email: "sam@acme.io" };
/** The contract's EnrollmentTokenBearer, at the real bearer's length: base64 of 134 bytes. */
const BEARER = /^[A-Za-z0-9+/]{178}==$|^[A-Za-z0-9+/]{179}=$/;

let fake: FakeOpampServer;
let client: OpampServerClient;

beforeAll(async () => {
  fake = await startFakeOpampServer({ now: () => new Date(clock) });
  client = createOpampServerClient({ url: fake.url, secret: fake.secret });
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

async function anOrganization(): Promise<string> {
  const id = randomUUID();
  expect(await client.createOrganization({ id, name: "Acme" })).toEqual({ kind: "created", organizationId: id });
  return id;
}

let labels = 0;

/** A fleet created through the client, under a fresh id; answers the `created` result. */
async function aFleet(
  organizationId: string,
  fields: { label?: string; type?: "server" | "kubernetes-supervisor"; rotateExpiresAt?: string | null } = {},
) {
  const result = await client.createFleet(organizationId, {
    id: randomUUID(),
    label: fields.label ?? `fleet-${++labels}`,
    type: fields.type ?? "server",
    rotateExpiresAt: fields.rotateExpiresAt ?? null,
    actor: ACTOR,
  });
  if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
  return result;
}

/** A published version of the organization's, of `configurationId` (a fresh one by default). */
async function aPublication(organizationId: string, configurationId = randomUUID()): Promise<{ id: string; sha256: string }> {
  const id = randomUUID();
  const yaml = `receivers: {}\n# ${id}\n`;
  const result = await client.postPublication(organizationId, id, {
    configuration: { id: configurationId, name: "payments-gateway" },
    version: { id: randomUUID(), number: 1, label: null },
    yaml,
    sha256: sha256Hex(yaml),
    publishedBy: null,
    publishedAt: "2026-10-03T14:02:11.000Z",
    collector: { distribution: "otelcol-contrib", version: "0.162.0" },
  });
  expect(result.kind).toBe("created");
  return { id, sha256: sha256Hex(yaml) };
}

/** An organization with a fleet holding a second group, and a collector in it (with an error). */
async function aWorld() {
  const organizationId = await anOrganization();
  const created = await aFleet(organizationId);
  const fleetId = created.fleet.id;
  const group = await client.createCollectorGroup(organizationId, fleetId, { name: "gateways" });
  if (group.kind !== "created") throw new Error(group.kind);
  const collector = fake.enrollCollector(organizationId, fleetId, { groupId: group.group.id, name: "edge-01" });
  fake.recordCollectorError(organizationId, collector.id, { message: "bad config" });
  return { organizationId, created, fleetId, groupId: group.group.id, collectorId: collector.id };
}

describe("getConfigurationUsage", () => {
  it("is found, empty and not in use, for a configuration with no published version", async () => {
    const organizationId = await anOrganization();
    const configurationId = randomUUID();

    expect(await client.getConfigurationUsage(organizationId, configurationId)).toEqual({
      kind: "found",
      usage: { configurationId, inUse: false, publications: [] },
    });
  });

  it("names the groups assigned each published version and counts the collectors pinned to it", async () => {
    const organizationId = await anOrganization();
    const configurationId = randomUUID();
    const publication = await aPublication(organizationId, configurationId);
    const { fleet } = await aFleet(organizationId);
    const group = await client.createCollectorGroup(organizationId, fleet.id, { name: "edge", assignedPublicationId: publication.id });
    if (group.kind !== "created") throw new Error(group.kind);
    const collector = fake.enrollCollector(organizationId, fleet.id);
    await client.updateCollectorInstance(organizationId, fleet.id, collector.id, { pin: { kind: "publication", id: publication.id } });

    expect(await client.getConfigurationUsage(organizationId, configurationId)).toEqual({
      kind: "found",
      usage: {
        configurationId,
        inUse: true,
        publications: [
          {
            id: publication.id,
            version: { id: expect.any(String), number: 1, label: null },
            publishedAt: "2026-10-03T14:02:11.000Z",
            groups: [{ fleetId: fleet.id, groupId: group.group.id }],
            pinnedCollectors: 1,
          },
        ],
      },
    });
  });

  it("is organization_not_found for an organization that isn't registered", async () => {
    expect(await client.getConfigurationUsage(randomUUID(), randomUUID())).toEqual({ kind: "organization_not_found" });
  });

  it("is invalid for a configuration id that isn't a UUID, which the fake sees break the contract", async () => {
    const organizationId = await anOrganization();

    expect(await client.getConfigurationUsage(organizationId, "not-a-uuid")).toMatchObject({ kind: "invalid", code: "invalid_request" });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^getConfigurationUsage request: path parameter configurationId /)]);
  });
});

describe("getLimits and setLimits", () => {
  it("reads both limits unset, sets both, and reads them back", async () => {
    const organizationId = await anOrganization();

    expect(await client.getLimits(organizationId)).toEqual({ kind: "found", limits: { maxCollectors: null, requestsPerMinute: null } });
    expect(await client.setLimits(organizationId, { maxCollectors: 0, requestsPerMinute: 120 })).toEqual({
      kind: "set",
      limits: { maxCollectors: 0, requestsPerMinute: 120 },
    });
    expect(await client.getLimits(organizationId)).toEqual({ kind: "found", limits: { maxCollectors: 0, requestsPerMinute: 120 } });
    expect(await client.setLimits(organizationId, { maxCollectors: null, requestsPerMinute: null })).toEqual({
      kind: "set",
      limits: { maxCollectors: null, requestsPerMinute: null },
    });
  });

  it("is organization_not_found for an organization that isn't registered", async () => {
    expect(await client.getLimits(randomUUID())).toEqual({ kind: "organization_not_found" });
    expect(await client.setLimits(randomUUID(), { maxCollectors: 1, requestsPerMinute: null })).toEqual({
      kind: "organization_not_found",
    });
  });

  it("is invalid for a rate of 0, which the fake sees break the contract", async () => {
    const organizationId = await anOrganization();

    expect(await client.setLimits(organizationId, { maxCollectors: null, requestsPerMinute: 0 })).toMatchObject({
      kind: "invalid",
      code: "invalid_request",
    });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^setLimits request body: /)]);
  });
});

describe("createFleet", () => {
  it("creates a fleet with its Default group and both tokens' bearers, naming the actor given", async () => {
    const organizationId = await anOrganization();
    const id = randomUUID();

    const result = await client.createFleet(organizationId, {
      id,
      label: "edge-prod",
      type: "server",
      rotateExpiresAt: at(30 * 24 * HOUR),
      actor: ACTOR,
    });

    expect(result).toEqual({
      kind: "created",
      fleet: {
        id,
        organizationId,
        label: "edge-prod",
        type: "server",
        status: "active",
        createdBy: ACTOR,
        createdAt: at(0),
        updatedAt: at(0),
      },
      defaultGroup: expect.objectContaining({ fleetId: id, name: "Default", isDefault: true, assignedPublicationId: null }),
      tokens: {
        default: { id: expect.any(String), bearer: expect.stringMatching(BEARER) },
        rotate: { id: expect.any(String), bearer: expect.stringMatching(BEARER), expiresAt: at(30 * 24 * HOUR) },
      },
    });
  });

  it("sends a null actor as null: the client never names one itself", async () => {
    const organizationId = await anOrganization();

    const result = await client.createFleet(organizationId, {
      label: "edge",
      type: "kubernetes-supervisor",
      rotateExpiresAt: null,
      actor: null,
    });

    expect(result).toMatchObject({ kind: "created", fleet: { createdBy: null, type: "kubernetes-supervisor" } });
  });

  it("creates under a server-made id when none is given", async () => {
    const organizationId = await anOrganization();

    const result = await client.createFleet(organizationId, { label: "edge", type: "server", rotateExpiresAt: null, actor: ACTOR });

    expect(result).toMatchObject({ kind: "created", fleet: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), organizationId } });
  });

  it("answers unchanged, with the fleet and no bearer, for the same id, label and type again: a safe retry", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { label: "edge" });

    const retried = await client.createFleet(organizationId, {
      id: created.fleet.id,
      label: "edge",
      type: "server",
      rotateExpiresAt: null,
      actor: ACTOR,
    });

    expect(retried).toEqual({ kind: "unchanged", fleet: created.fleet });
    expect(JSON.stringify(retried)).not.toContain("bearer");
  });

  it("is fleet_conflict for the id with another label, or another organization's id", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { label: "edge" });
    const other = await anOrganization();
    const request = { id: created.fleet.id, label: "other", type: "server" as const, rotateExpiresAt: null, actor: ACTOR };

    expect(await client.createFleet(organizationId, request)).toEqual({ kind: "fleet_conflict" });
    expect(await client.createFleet(other, { ...request, label: "edge" })).toEqual({ kind: "fleet_conflict" });
  });

  it("is fleet_label_taken for another fleet's label", async () => {
    const organizationId = await anOrganization();
    await aFleet(organizationId, { label: "edge" });

    expect(
      await client.createFleet(organizationId, { id: randomUUID(), label: "edge", type: "server", rotateExpiresAt: null, actor: ACTOR }),
    ).toEqual({ kind: "fleet_label_taken" });
  });

  it("is organization_not_found for an organization that isn't registered", async () => {
    expect(await client.createFleet(randomUUID(), { label: "edge", type: "server", rotateExpiresAt: null, actor: ACTOR })).toEqual({
      kind: "organization_not_found",
    });
  });

  it("is invalid for a rotate token's expiry in the past (a clock's skew)", async () => {
    const organizationId = await anOrganization();

    expect(
      await client.createFleet(organizationId, { label: "edge", type: "server", rotateExpiresAt: at(-MINUTE), actor: ACTOR }),
    ).toEqual({ kind: "invalid", code: "invalid_request" });
  });
});

describe("listFleets", () => {
  it("lists the organization's fleets newest first and pages through them with the cursor", async () => {
    const organizationId = await anOrganization();
    const first = await aFleet(organizationId);
    clock += MINUTE;
    const second = await aFleet(organizationId);

    const page = await client.listFleets(organizationId, { limit: 1 });
    if (page.kind !== "page") throw new Error(page.kind);
    expect(page.page.fleets.map((fleet) => fleet.id)).toEqual([second.fleet.id]);
    expect(page.page.fleets[0]?.summary).toMatchObject({ collectors: 0 });
    const next = await client.listFleets(organizationId, { limit: 1, cursor: page.page.nextCursor ?? "" });

    expect(next).toMatchObject({ kind: "page", page: { fleets: [{ id: first.fleet.id }], nextCursor: null } });
  });

  it("keeps the status asked for", async () => {
    const organizationId = await anOrganization();
    const archived = await aFleet(organizationId);
    await aFleet(organizationId);
    await client.updateFleet(organizationId, archived.fleet.id, { status: "archived" });

    expect(await client.listFleets(organizationId, { status: "archived" })).toMatchObject({
      kind: "page",
      page: { fleets: [{ id: archived.fleet.id, status: "archived" }], nextCursor: null },
    });
  });

  it("is organization_not_found for an organization that isn't registered", async () => {
    expect(await client.listFleets(randomUUID())).toEqual({ kind: "organization_not_found" });
  });

  it("is invalid for a cursor the API didn't give", async () => {
    const organizationId = await anOrganization();

    expect(await client.listFleets(organizationId, { cursor: "not-a-cursor" })).toMatchObject({ kind: "invalid", code: "invalid_request" });
  });
});

describe("getFleet", () => {
  it("finds a fleet with its summary at the server's clock", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    fake.enrollCollector(organizationId, created.fleet.id);

    expect(await client.getFleet(organizationId, created.fleet.id)).toEqual({
      kind: "found",
      fleet: {
        ...created.fleet,
        summary: {
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
          lastSeenAt: at(0),
          rotateToken: { expiresAt: null, graceEndsAt: null, validCount: 1 },
        },
      },
    });
  });

  it("finds a fleet whose id is given in upper case", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);

    expect(await client.getFleet(organizationId, created.fleet.id.toUpperCase())).toMatchObject({
      kind: "found",
      fleet: { id: created.fleet.id },
    });
  });

  it("is fleet_not_found for an unknown fleet, and for another organization's", async () => {
    const organizationId = await anOrganization();
    const other = await anOrganization();
    const theirs = await aFleet(other);

    expect(await client.getFleet(organizationId, randomUUID())).toEqual({ kind: "fleet_not_found" });
    expect(await client.getFleet(organizationId, theirs.fleet.id)).toEqual({ kind: "fleet_not_found" });
  });

  it("is organization_not_found for an organization that isn't registered", async () => {
    expect(await client.getFleet(randomUUID(), randomUUID())).toEqual({ kind: "organization_not_found" });
  });
});

describe("updateFleet", () => {
  it("renames a fleet, and archives and unarchives it", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);
    clock += MINUTE;

    expect(await client.updateFleet(organizationId, created.fleet.id, { label: "renamed" })).toEqual({
      kind: "updated",
      fleet: { ...created.fleet, label: "renamed", updatedAt: at(MINUTE) },
    });
    expect(await client.updateFleet(organizationId, created.fleet.id, { status: "archived" })).toMatchObject({
      kind: "updated",
      fleet: { status: "archived" },
    });
    expect(await client.updateFleet(organizationId, created.fleet.id, { label: "edge", status: "active" })).toMatchObject({
      kind: "updated",
      fleet: { label: "edge", status: "active" },
    });
  });

  it("is fleet_label_taken for another fleet's label", async () => {
    const organizationId = await anOrganization();
    await aFleet(organizationId, { label: "taken" });
    const created = await aFleet(organizationId);

    expect(await client.updateFleet(organizationId, created.fleet.id, { label: "taken" })).toEqual({ kind: "fleet_label_taken" });
  });

  it("is fleet_not_found and organization_not_found as a read is", async () => {
    const organizationId = await anOrganization();

    expect(await client.updateFleet(organizationId, randomUUID(), { label: "x" })).toEqual({ kind: "fleet_not_found" });
    expect(await client.updateFleet(randomUUID(), randomUUID(), { label: "x" })).toEqual({ kind: "organization_not_found" });
  });

  it("is invalid for a label with a leading space, which the fake sees break the contract", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);

    expect(await client.updateFleet(organizationId, created.fleet.id, { label: " edge" })).toMatchObject({
      kind: "invalid",
      code: "invalid_request",
    });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^updateFleet request body: /)]);
  });
});

describe("deleteFleet", () => {
  it("deletes a fleet: deleted, then fleet_not_found", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId);

    expect(await client.deleteFleet(organizationId, created.fleet.id)).toEqual({ kind: "deleted" });
    expect(await client.getFleet(organizationId, created.fleet.id)).toEqual({ kind: "fleet_not_found" });
    expect(await client.deleteFleet(organizationId, created.fleet.id)).toEqual({ kind: "fleet_not_found" });
  });

  it("is organization_not_found for an organization that isn't registered", async () => {
    expect(await client.deleteFleet(randomUUID(), randomUUID())).toEqual({ kind: "organization_not_found" });
  });
});

describe("collector groups", () => {
  it("lists a fleet's groups, the Default group first, then by name", async () => {
    const { organizationId, created, fleetId, groupId } = await aWorld();
    const another = await client.createCollectorGroup(organizationId, fleetId, { name: "agents" });
    if (another.kind !== "created") throw new Error(another.kind);

    const listed = await client.listCollectorGroups(organizationId, fleetId);

    expect(listed).toMatchObject({ kind: "listed" });
    if (listed.kind !== "listed") return;
    expect(listed.groups.map((group) => group.id)).toEqual([created.defaultGroup.id, another.group.id, groupId]);
  });

  it("creates a group assigned a published version, and one with its Kubernetes settings in its annotations in a kubernetes-supervisor fleet", async () => {
    const organizationId = await anOrganization();
    const publication = await aPublication(organizationId);
    const server = await aFleet(organizationId);
    const kubernetes = await aFleet(organizationId, { type: "kubernetes-supervisor" });

    expect(
      await client.createCollectorGroup(organizationId, server.fleet.id, { name: "edge", assignedPublicationId: publication.id }),
    ).toEqual({
      kind: "created",
      group: {
        id: expect.any(String),
        fleetId: server.fleet.id,
        name: "edge",
        isDefault: false,
        assignedPublicationId: publication.id,
        annotations: null,
        variableGroupId: null,
        createdAt: at(0),
        updatedAt: at(0),
      },
    });
    // D17d-1 decision 2: the opamp-server keeps no Kubernetes field; the settings are the platform's data, passed through.
    const volume = { readOnly: true, mountPath: "/var/log/journal", hostPathType: "Directory", hostPath: "/var/log/journal" };
    const created = await client.createCollectorGroup(organizationId, kubernetes.fleet.id, {
      name: "gateways",
      annotations: { telflo: { kubernetes: { role: "gateway", namespace: "observability", replicas: 3, volumes: [volume] } } },
    });
    expect(created).toMatchObject({
      kind: "created",
      group: {
        annotations: {
          telflo: {
            kubernetes: {
              namespace: "observability",
              replicas: 3,
              role: "gateway",
              volumes: [{ hostPath: "/var/log/journal", hostPathType: "Directory", mountPath: "/var/log/journal", readOnly: true }],
            },
          },
        },
      },
    });
    if (created.kind !== "created") return;
    for (const field of ["role", "namespace", "replicas", "volumes"]) expect(created.group).not.toHaveProperty(field);
  });

  it("is collector_group_name_taken, publication_not_found, fleet_not_found and organization_not_found on a create", async () => {
    const { organizationId, fleetId } = await aWorld();

    expect(await client.createCollectorGroup(organizationId, fleetId, { name: "gateways" })).toEqual({
      kind: "collector_group_name_taken",
    });
    expect(await client.createCollectorGroup(organizationId, fleetId, { name: "new", assignedPublicationId: randomUUID() })).toEqual({
      kind: "publication_not_found",
    });
    expect(await client.createCollectorGroup(organizationId, randomUUID(), { name: "new" })).toEqual({ kind: "fleet_not_found" });
    expect(await client.createCollectorGroup(randomUUID(), randomUUID(), { name: "new" })).toEqual({
      kind: "organization_not_found",
    });
  });

  it("sends only a group request's own fields: an old Kubernetes field never reaches the opamp-server, which would refuse it", async () => {
    const { organizationId, fleetId } = await aWorld();
    const withOldFields = { name: "new", replicas: 2, role: "gateway" } as unknown as Parameters<OpampServerClient["createCollectorGroup"]>[2];

    // The fake checks every request against openapi.yaml, which no longer has the four fields (afterEach: no violation).
    expect(await client.createCollectorGroup(organizationId, fleetId, withOldFields)).toMatchObject({ kind: "created", group: { name: "new" } });
  });

  it("reads a group, and is collector_group_not_found for an unknown one or another fleet's", async () => {
    const { organizationId, fleetId, groupId } = await aWorld();
    const other = await aFleet(organizationId);

    expect(await client.getCollectorGroup(organizationId, fleetId, groupId)).toMatchObject({
      kind: "found",
      group: { id: groupId, fleetId, name: "gateways" },
    });
    expect(await client.getCollectorGroup(organizationId, fleetId, randomUUID())).toEqual({ kind: "collector_group_not_found" });
    expect(await client.getCollectorGroup(organizationId, other.fleet.id, groupId)).toEqual({ kind: "collector_group_not_found" });
    expect(await client.getCollectorGroup(organizationId, randomUUID(), groupId)).toEqual({ kind: "fleet_not_found" });
  });

  // D17c-1 decision 30.
  it("sends a group's annotations on a create and an update, an object replacing them and null clearing them, and reads them back", async () => {
    const { organizationId, fleetId, groupId } = await aWorld();
    const annotations = { telflo: { dockerMounts: [{ hostPath: "/var/log", containerPath: "/logs", readOnly: true }] }, other: [1, "x"] };

    expect(await client.createCollectorGroup(organizationId, fleetId, { name: "edge", annotations })).toMatchObject({
      kind: "created",
      group: { name: "edge", annotations },
    });
    expect(await client.updateCollectorGroup(organizationId, fleetId, groupId, { annotations: { other: true } })).toMatchObject({
      kind: "updated",
      group: { annotations: { other: true } },
    });
    expect(await client.updateCollectorGroup(organizationId, fleetId, groupId, { name: "relays" })).toMatchObject({
      kind: "updated",
      group: { annotations: { other: true } },
    });
    expect(await client.updateCollectorGroup(organizationId, fleetId, groupId, { annotations: null })).toMatchObject({
      kind: "updated",
      group: { annotations: null },
    });
    expect(await client.getCollectorGroup(organizationId, fleetId, groupId)).toMatchObject({ kind: "found", group: { annotations: null } });
  });

  it("renames a group, assigns it a published version and clears it with null", async () => {
    const { organizationId, fleetId, groupId } = await aWorld();
    const publication = await aPublication(organizationId);

    expect(await client.updateCollectorGroup(organizationId, fleetId, groupId, { name: "edge" })).toMatchObject({
      kind: "updated",
      group: { id: groupId, name: "edge", assignedPublicationId: null },
    });
    expect(
      await client.updateCollectorGroup(organizationId, fleetId, groupId, { assignedPublicationId: publication.id }),
    ).toMatchObject({ kind: "updated", group: { name: "edge", assignedPublicationId: publication.id } });
    expect(await client.updateCollectorGroup(organizationId, fleetId, groupId, { assignedPublicationId: null })).toMatchObject({
      kind: "updated",
      group: { assignedPublicationId: null },
    });
  });

  it("is collector_group_is_default, collector_group_name_taken, publication_not_found and collector_group_not_found on an update", async () => {
    const { organizationId, created, fleetId, groupId } = await aWorld();

    expect(await client.updateCollectorGroup(organizationId, fleetId, created.defaultGroup.id, { name: "Renamed" })).toEqual({
      kind: "collector_group_is_default",
    });
    expect(await client.updateCollectorGroup(organizationId, fleetId, groupId, { name: "Default" })).toEqual({
      kind: "collector_group_name_taken",
    });
    expect(await client.updateCollectorGroup(organizationId, fleetId, groupId, { assignedPublicationId: randomUUID() })).toEqual({
      kind: "publication_not_found",
    });
    expect(await client.updateCollectorGroup(organizationId, fleetId, randomUUID(), { name: "x" })).toEqual({
      kind: "collector_group_not_found",
    });
  });

  it("deletes a group with its collectors (D17d-1 decision 3); the Default group itself is collector_group_is_default", async () => {
    const { organizationId, created, fleetId, groupId, collectorId } = await aWorld();

    expect(await client.deleteCollectorGroup(organizationId, fleetId, created.defaultGroup.id)).toEqual({
      kind: "collector_group_is_default",
    });
    expect(await client.deleteCollectorGroup(organizationId, fleetId, groupId)).toEqual({ kind: "deleted" });
    expect(await client.getCollectorInstance(organizationId, fleetId, collectorId)).toEqual({ kind: "collector_not_found" });
    expect(await client.deleteCollectorGroup(organizationId, fleetId, groupId)).toEqual({ kind: "collector_group_not_found" });
  });

  it("is fleet_not_found and organization_not_found for a list", async () => {
    const organizationId = await anOrganization();

    expect(await client.listCollectorGroups(organizationId, randomUUID())).toEqual({ kind: "fleet_not_found" });
    expect(await client.listCollectorGroups(randomUUID(), randomUUID())).toEqual({ kind: "organization_not_found" });
  });
});

describe("enrollment tokens", () => {
  it("lists a fleet's tokens without their bearers, each with its active collectors", async () => {
    const { organizationId, created, fleetId } = await aWorld();

    const listed = await client.listEnrollmentTokens(organizationId, fleetId);

    expect(listed).toMatchObject({ kind: "listed" });
    if (listed.kind !== "listed") return;
    expect(listed.tokens.map((token) => [token.id, token.kind, token.fleetId])).toEqual(
      expect.arrayContaining([
        [created.tokens.default.id, "default", fleetId],
        [created.tokens.rotate.id, "rotate", fleetId],
      ]),
    );
    expect(listed.tokens.find((token) => token.kind === "default")?.activeCollectors).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("bearer");
  });

  it("rotates the rotate token: a new bearer, its predecessor named", async () => {
    const { organizationId, created, fleetId } = await aWorld();

    expect(
      await client.rotateEnrollmentToken(organizationId, fleetId, { expiresAt: null, graceEndsAt: at(HOUR), actor: ACTOR }),
    ).toEqual({
      kind: "rotated",
      token: { id: expect.any(String), bearer: expect.stringMatching(BEARER), expiresAt: null, predecessorId: created.tokens.rotate.id },
    });
  });

  it("is fleet_archived for an archived fleet's rotation, invalid for a grace in the past, fleet_not_found for an unknown fleet", async () => {
    const { organizationId, fleetId } = await aWorld();
    const rotation = { expiresAt: null, graceEndsAt: at(HOUR), actor: ACTOR };

    expect(await client.rotateEnrollmentToken(organizationId, fleetId, { ...rotation, graceEndsAt: at(-MINUTE) })).toMatchObject({
      kind: "invalid",
      code: "invalid_request",
    });
    expect(await client.rotateEnrollmentToken(organizationId, randomUUID(), rotation)).toEqual({ kind: "fleet_not_found" });
    await client.updateFleet(organizationId, fleetId, { status: "archived" });
    expect(await client.rotateEnrollmentToken(organizationId, fleetId, rotation)).toEqual({ kind: "fleet_archived" });
  });

  it("reveals a token's fresh bearer", async () => {
    const { organizationId, created, fleetId } = await aWorld();

    expect(await client.revealEnrollmentToken(organizationId, fleetId, created.tokens.default.id, ACTOR)).toEqual({
      kind: "revealed",
      token: { id: created.tokens.default.id, kind: "default", bearer: expect.stringMatching(BEARER), expiresAt: null },
    });
  });

  it("is enrollment_token_revoked, enrollment_token_expired and enrollment_token_not_found on a reveal", async () => {
    const organizationId = await anOrganization();
    const created = await aFleet(organizationId, { rotateExpiresAt: at(HOUR) });
    const fleetId = created.fleet.id;
    await client.revokeEnrollmentToken(organizationId, fleetId, created.tokens.default.id, ACTOR);

    expect(await client.revealEnrollmentToken(organizationId, fleetId, created.tokens.default.id, null)).toEqual({
      kind: "enrollment_token_revoked",
    });
    clock += 2 * HOUR;
    expect(await client.revealEnrollmentToken(organizationId, fleetId, created.tokens.rotate.id, null)).toEqual({
      kind: "enrollment_token_expired",
    });
    expect(await client.revealEnrollmentToken(organizationId, fleetId, randomUUID(), null)).toEqual({
      kind: "enrollment_token_not_found",
    });
  });

  // D17c-1 decision 29.
  it("issues a new default token once the fleet's default token is revoked: POST …/tokens/default with the actor, its bearer, the issued event", async () => {
    const { organizationId, created, fleetId } = await aWorld();
    const urls: string[] = [];
    const recording = createOpampServerClient({
      url: fake.url,
      secret: fake.secret,
      fetch: (url, init) => {
        urls.push(`${init?.method ?? "GET"} ${String(url)}`);
        return fetch(url, init);
      },
    });

    expect(await recording.issueDefaultEnrollmentToken(organizationId, fleetId, ACTOR)).toEqual({
      kind: "enrollment_token_default_exists",
    });
    await client.revokeEnrollmentToken(organizationId, fleetId, created.tokens.default.id, null);
    clock += MINUTE;
    const issued = await recording.issueDefaultEnrollmentToken(organizationId, fleetId, ACTOR);

    expect(issued).toEqual({
      kind: "issued",
      token: { id: expect.any(String), kind: "default", bearer: expect.stringMatching(BEARER), expiresAt: null },
    });
    expect(urls).toEqual([
      `POST ${fake.url}/api/v1/organizations/${organizationId}/fleets/${fleetId}/tokens/default`,
      `POST ${fake.url}/api/v1/organizations/${organizationId}/fleets/${fleetId}/tokens/default`,
    ]);
    if (issued.kind !== "issued") return;
    const events = await client.listEnrollmentTokenEvents(organizationId, fleetId, { limit: 1 });
    expect(events).toMatchObject({ kind: "page", page: { events: [{ event: "issued", tokenId: issued.token.id, actor: ACTOR, occurredAt: at(MINUTE) }] } });
  });

  it("is fleet_archived for an archived fleet's new default token, fleet_not_found for an unknown fleet", async () => {
    const { organizationId, created, fleetId } = await aWorld();
    await client.revokeEnrollmentToken(organizationId, fleetId, created.tokens.default.id, null);

    expect(await client.issueDefaultEnrollmentToken(organizationId, randomUUID(), ACTOR)).toEqual({ kind: "fleet_not_found" });
    await client.updateFleet(organizationId, fleetId, { status: "archived" });
    expect(await client.issueDefaultEnrollmentToken(organizationId, fleetId, null)).toEqual({ kind: "fleet_archived" });
  });

  it("revokes a token, and answers it as it is to a retry", async () => {
    const { organizationId, created, fleetId } = await aWorld();

    const revoked = await client.revokeEnrollmentToken(organizationId, fleetId, created.tokens.rotate.id, ACTOR);
    expect(revoked).toMatchObject({
      kind: "revoked",
      token: { id: created.tokens.rotate.id, fleetId, kind: "rotate", revokedAt: at(0), createdBy: ACTOR },
    });
    clock += MINUTE;
    expect(await client.revokeEnrollmentToken(organizationId, fleetId, created.tokens.rotate.id, ACTOR)).toEqual(revoked);
    expect(await client.revokeEnrollmentToken(organizationId, fleetId, randomUUID(), ACTOR)).toEqual({
      kind: "enrollment_token_not_found",
    });
  });

  it("is fleet_not_found for a list of an unknown fleet", async () => {
    const organizationId = await anOrganization();

    expect(await client.listEnrollmentTokens(organizationId, randomUUID())).toEqual({ kind: "fleet_not_found" });
  });

  it("lists a fleet's token events newest first, paged by its cursor, each with its actor and never a bearer (D17b-2 decision 19)", async () => {
    const { organizationId, created, fleetId } = await aWorld();
    clock += MINUTE;
    await client.revealEnrollmentToken(organizationId, fleetId, created.tokens.default.id, ACTOR);
    clock += MINUTE;
    await client.revokeEnrollmentToken(organizationId, fleetId, created.tokens.rotate.id, null);

    const whole = await client.listEnrollmentTokenEvents(organizationId, fleetId);
    expect(whole).toMatchObject({ kind: "page", page: { nextCursor: null } });
    if (whole.kind !== "page") return;
    const rows = whole.page.events.map((event) => [event.event, event.tokenId, event.actor, event.occurredAt]);
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 2)).toEqual([
      ["revoked", created.tokens.rotate.id, null, at(2 * MINUTE)],
      ["viewed", created.tokens.default.id, ACTOR, at(MINUTE)],
    ]);
    // The create's two, at one instant: ordered by id.
    expect(rows.slice(2)).toEqual(
      expect.arrayContaining([
        ["issued", created.tokens.default.id, ACTOR, at(0)],
        ["issued", created.tokens.rotate.id, ACTOR, at(0)],
      ]),
    );
    expect(JSON.stringify(whole)).not.toContain("bearer");

    // A page of one, then the rest after its cursor: the same events, in order.
    const first = await client.listEnrollmentTokenEvents(organizationId, fleetId, { limit: 1 });
    expect(first).toMatchObject({ kind: "page", page: { events: [whole.page.events[0]], nextCursor: expect.any(String) } });
    if (first.kind !== "page") return;
    expect(await client.listEnrollmentTokenEvents(organizationId, fleetId, { cursor: first.page.nextCursor ?? "" })).toEqual({
      kind: "page",
      page: { events: whole.page.events.slice(1), nextCursor: null },
    });
  });

  it("is invalid for a cursor it didn't give, fleet_not_found for an unknown fleet or another organization's, organization_not_found for an unregistered organization", async () => {
    const { organizationId, fleetId } = await aWorld();
    const other = await anOrganization();

    expect(await client.listEnrollmentTokenEvents(organizationId, fleetId, { cursor: "x" })).toMatchObject({
      kind: "invalid",
      code: "invalid_request",
    });
    expect(await client.listEnrollmentTokenEvents(organizationId, randomUUID())).toEqual({ kind: "fleet_not_found" });
    expect(await client.listEnrollmentTokenEvents(other, fleetId)).toEqual({ kind: "fleet_not_found" });
    expect(await client.listEnrollmentTokenEvents(randomUUID(), fleetId)).toEqual({ kind: "organization_not_found" });
  });
});

describe("collectors", () => {
  it("lists a fleet's collectors, searched, filtered by group, sorted and paged", async () => {
    const { organizationId, created, fleetId, groupId, collectorId } = await aWorld();
    const other = fake.enrollCollector(organizationId, fleetId, { name: "core-01" });

    const all = await client.listCollectorInstances(organizationId, fleetId, { sort: "name", order: "asc" });
    expect(all).toMatchObject({ kind: "page" });
    if (all.kind !== "page") return;
    expect(all.page.collectors.map((collector) => collector.id)).toEqual([other.id, collectorId]);

    expect(await client.listCollectorInstances(organizationId, fleetId, { q: "EDGE" })).toMatchObject({
      kind: "page",
      page: { collectors: [{ id: collectorId }], nextCursor: null },
    });
    expect(await client.listCollectorInstances(organizationId, fleetId, { groupId: created.defaultGroup.id })).toMatchObject({
      kind: "page",
      page: { collectors: [{ id: other.id }] },
    });
    const first = await client.listCollectorInstances(organizationId, fleetId, { sort: "name", order: "desc", limit: 1 });
    if (first.kind !== "page") throw new Error(first.kind);
    expect(first.page.collectors.map((collector) => collector.groupId)).toEqual([groupId]);
    expect(
      await client.listCollectorInstances(organizationId, fleetId, {
        sort: "name",
        order: "desc",
        limit: 1,
        cursor: first.page.nextCursor ?? "",
      }),
    ).toMatchObject({ kind: "page", page: { collectors: [{ id: other.id }], nextCursor: null } });
  });

  it("is invalid for another sort's cursor, fleet_not_found for an unknown fleet", async () => {
    const { organizationId, fleetId } = await aWorld();
    fake.enrollCollector(organizationId, fleetId);
    const first = await client.listCollectorInstances(organizationId, fleetId, { sort: "name", limit: 1 });
    if (first.kind !== "page") throw new Error(first.kind);

    expect(
      await client.listCollectorInstances(organizationId, fleetId, { sort: "lastSeen", cursor: first.page.nextCursor ?? "" }),
    ).toMatchObject({ kind: "invalid", code: "invalid_request" });
    expect(await client.listCollectorInstances(organizationId, randomUUID())).toEqual({ kind: "fleet_not_found" });
  });

  it("reads a collector with what it reported of itself", async () => {
    const { organizationId, fleetId, groupId, collectorId } = await aWorld();
    fake.setCollectorState(organizationId, collectorId, {
      reported: { collectorVersion: "0.162.0", ip: "10.0.0.5", hostIp: null, attributes: { "host.name": "edge-01" } },
      effective: { sha256: "a".repeat(64), status: "failed", error: "receivers: unknown type" },
    });

    expect(await client.getCollectorInstance(organizationId, fleetId, collectorId)).toMatchObject({
      kind: "found",
      collector: {
        id: collectorId,
        fleetId,
        groupId,
        name: "edge-01",
        reported: { collectorVersion: "0.162.0", ip: "10.0.0.5", hostIp: null, attributes: { "host.name": "edge-01" } },
        effective: { status: "failed", error: "receivers: unknown type" },
        liveness: "online",
      },
    });
    expect(await client.getCollectorInstance(organizationId, fleetId, randomUUID())).toEqual({ kind: "collector_not_found" });
  });

  it("pins collectors in bulk, naming the ids the fleet doesn't hold, and unpins them", async () => {
    const { organizationId, fleetId, collectorId } = await aWorld();
    const publication = await aPublication(organizationId);
    const unknown = randomUUID();

    expect(
      await client.pinCollectorInstances(organizationId, fleetId, {
        collectorIds: [collectorId, unknown],
        pin: { kind: "publication", id: publication.id },
      }),
    ).toEqual({ kind: "pinned", updated: [collectorId], notFound: [unknown] });
    expect(await client.getCollectorInstance(organizationId, fleetId, collectorId)).toMatchObject({
      collector: { pin: { kind: "publication", id: publication.id } },
    });
    expect(await client.pinCollectorInstances(organizationId, fleetId, { collectorIds: [collectorId], pin: null })).toEqual({
      kind: "pinned",
      updated: [collectorId],
      notFound: [],
    });
    expect(await client.getCollectorInstance(organizationId, fleetId, collectorId)).toMatchObject({ collector: { pin: null } });
  });

  it("is publication_not_found and fleet_not_found on a bulk pin", async () => {
    const { organizationId, fleetId, collectorId } = await aWorld();

    expect(
      await client.pinCollectorInstances(organizationId, fleetId, {
        collectorIds: [collectorId],
        pin: { kind: "publication", id: randomUUID() },
      }),
    ).toEqual({ kind: "publication_not_found" });
    expect(await client.pinCollectorInstances(organizationId, randomUUID(), { collectorIds: [collectorId], pin: null })).toEqual({
      kind: "fleet_not_found",
    });
  });

  it("renames a collector, moves it to another group, pins it and unpins it", async () => {
    const { organizationId, created, fleetId, collectorId } = await aWorld();
    const publication = await aPublication(organizationId);
    clock += MINUTE;

    expect(
      await client.updateCollectorInstance(organizationId, fleetId, collectorId, {
        name: "edge-02",
        groupId: created.defaultGroup.id,
        pin: { kind: "publication", id: publication.id },
      }),
    ).toMatchObject({
      kind: "updated",
      collector: {
        id: collectorId,
        name: "edge-02",
        groupId: created.defaultGroup.id,
        pin: { kind: "publication", id: publication.id },
        updatedAt: at(MINUTE),
      },
    });
    expect(await client.updateCollectorInstance(organizationId, fleetId, collectorId, { pin: null })).toMatchObject({
      kind: "updated",
      collector: { name: "edge-02", pin: null },
    });
  });

  it("is collector_name_taken, collector_group_not_found, publication_not_found and collector_not_found on an update", async () => {
    const { organizationId, fleetId, collectorId } = await aWorld();
    fake.enrollCollector(organizationId, fleetId, { name: "taken" });

    expect(await client.updateCollectorInstance(organizationId, fleetId, collectorId, { name: "taken" })).toEqual({
      kind: "collector_name_taken",
    });
    expect(await client.updateCollectorInstance(organizationId, fleetId, collectorId, { groupId: randomUUID() })).toEqual({
      kind: "collector_group_not_found",
    });
    expect(
      await client.updateCollectorInstance(organizationId, fleetId, collectorId, { pin: { kind: "publication", id: randomUUID() } }),
    ).toEqual({ kind: "publication_not_found" });
    expect(await client.updateCollectorInstance(organizationId, fleetId, randomUUID(), { name: "x" })).toEqual({
      kind: "collector_not_found",
    });
  });

  it("deletes a collector: deleted, then collector_not_found", async () => {
    const { organizationId, fleetId, collectorId } = await aWorld();

    expect(await client.deleteCollectorInstance(organizationId, fleetId, collectorId)).toEqual({ kind: "deleted" });
    expect(await client.getCollectorInstance(organizationId, fleetId, collectorId)).toEqual({ kind: "collector_not_found" });
    expect(await client.deleteCollectorInstance(organizationId, fleetId, collectorId)).toEqual({ kind: "collector_not_found" });
  });

  it("lists a collector's errors newest first, paged", async () => {
    const { organizationId, fleetId, collectorId } = await aWorld();
    clock += MINUTE;
    const newer = fake.recordCollectorError(organizationId, collectorId, { message: "worse config", configSha256: "b".repeat(64) });

    const first = await client.listCollectorInstanceErrors(organizationId, fleetId, collectorId, { limit: 1 });
    expect(first).toMatchObject({
      kind: "page",
      page: { errors: [{ id: newer.id, message: "worse config", configSha256: "b".repeat(64), reportedAt: at(MINUTE) }] },
    });
    if (first.kind !== "page") return;
    expect(
      await client.listCollectorInstanceErrors(organizationId, fleetId, collectorId, { cursor: first.page.nextCursor ?? "" }),
    ).toMatchObject({ kind: "page", page: { errors: [{ message: "bad config", configSha256: null }], nextCursor: null } });
    expect(await client.listCollectorInstanceErrors(organizationId, fleetId, randomUUID())).toEqual({ kind: "collector_not_found" });
  });
});
