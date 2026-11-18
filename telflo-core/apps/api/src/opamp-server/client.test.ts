import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeOpampServer, type FakeOpampServer } from "../testing/fake-opamp-server.js";
import {
  createOpampServerClient,
  OpampServerMisconfigurationError,
  sha256Hex,
  type OpampServerClient,
  type PublicationRequest,
} from "./client.js";

// The platform's opamp-server client (D11a Tasks 7 and 10b), against the
// fake, which validates every request and reply against
// vendor/opamp-server/openapi.yaml. Every test ends with no unread
// violation of the contract. Publications live under a registered
// organization (decision 20): `registered`, shared, or `anOrganization()`
// for a test that needs its own.

const RECEIVED_AT = "2026-10-03T14:05:00.000Z";

let fake: FakeOpampServer;
let client: OpampServerClient;
/** The fake's clock: RECEIVED_AT, unless a test moves it (reset after each). */
let fakeNow = new Date(RECEIVED_AT);
/** An organization registered once, for the tests that need any. */
let registered: string;

beforeAll(async () => {
  fake = await startFakeOpampServer({ now: () => fakeNow });
  client = createOpampServerClient({ url: fake.url, secret: fake.secret });
  registered = await anOrganization();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fakeNow = new Date(RECEIVED_AT);
  expect(fake.takeViolations()).toEqual([]);
});

afterAll(async () => {
  await fake.close();
});

function aPublication(overrides: Partial<PublicationRequest> = {}): PublicationRequest {
  const yaml = overrides.yaml ?? `receivers:\n  otlp: # ${randomUUID()}\n`;
  return {
    configuration: { id: randomUUID(), name: "payments-gateway" },
    version: { id: randomUUID(), number: 3, label: "TLS on" },
    yaml,
    sha256: sha256Hex(yaml),
    publishedBy: { id: randomUUID(), email: "ana@acme.io" },
    publishedAt: "2026-10-03T14:02:11.000Z",
    collector: { distribution: "otelcol-contrib", version: "0.161.0" },
    ...overrides,
  };
}

/** Registers a new organization under a fresh id; returns the id. */
async function anOrganization(name = `organization ${randomUUID()}`): Promise<string> {
  const id = randomUUID();
  const result = await client.createOrganization({ id, name });
  expect(result).toEqual({ kind: "created", organizationId: id });
  return id;
}

/** Puts `publication` and expects it created. */
async function put(organizationId: string, publication: PublicationRequest, id = randomUUID()): Promise<string> {
  const result = await client.postPublication(organizationId, id, publication);
  expect(result.kind).toBe("created");
  return id;
}

/** A client whose fetch answers `reply` to everything. */
function clientAnswering(reply: () => Response): OpampServerClient {
  return createOpampServerClient({
    url: "http://opamp-server.invalid",
    secret: fake.secret,
    fetch: () => Promise.resolve(reply()),
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createOrganization", () => {
  it("registers an organization under the caller's id: created, and readable", async () => {
    const id = randomUUID();

    expect(await client.createOrganization({ id, name: "ana@acme.io" })).toEqual({
      kind: "created",
      organizationId: id,
    });
    expect(await client.getOrganization(id)).toEqual({
      kind: "found",
      organization: { organizationId: id, name: "ana@acme.io", createdAt: RECEIVED_AT, updatedAt: RECEIVED_AT },
    });
  });

  it("answers unchanged for the same id and name again: a safe retry", async () => {
    const id = await anOrganization("Acme");

    expect(await client.createOrganization({ id, name: "Acme" })).toEqual({ kind: "unchanged", organizationId: id });
  });

  it.each([
    ["another name", "Globex"],
    ["the name with surrounding whitespace, compared as sent", " Acme "],
    ["the name in another case", "acme"],
  ])("answers conflict for the same id with %s, and never renames", async (_label, name) => {
    const id = await anOrganization("Acme");

    expect(await client.createOrganization({ id, name })).toEqual({ kind: "conflict" });
    expect(await client.getOrganization(id)).toMatchObject({ kind: "found", organization: { name: "Acme" } });
  });

  it("registers under a fresh version 4 UUID when no id is given, another each time", async () => {
    const first = await client.createOrganization({ name: "Acme" });
    const second = await client.createOrganization({ name: "Acme" });

    expect(first).toMatchObject({ kind: "created", organizationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(second.kind).toBe("created");
    if (first.kind !== "created" || second.kind !== "created") return;
    expect(first.organizationId).not.toBe(second.organizationId);
    expect(first.organizationId[14]).toBe("4");
    expect(await client.getOrganization(first.organizationId)).toMatchObject({ kind: "found" });
  });

  it("accepts an id in upper case, and answers it as the server keeps it", async () => {
    const id = randomUUID();

    expect(await client.createOrganization({ id: id.toUpperCase(), name: "Acme" })).toEqual({
      kind: "created",
      organizationId: id,
    });
  });

  it("accepts a name of 400 characters, multi-byte ones included", async () => {
    const id = randomUUID();

    expect(await client.createOrganization({ id, name: "é".repeat(399) + "🚀" })).toMatchObject({ kind: "created" });
    expect(await client.getOrganization(id)).toMatchObject({ organization: { name: "é".repeat(399) + "🚀" } });
  });

  it.each([
    ["over 400 characters", "a".repeat(401)],
    ["empty", ""],
    ["holding U+0000", "Acme\u0000Corp"],
  ])("is invalid (invalid_request) for a name %s, which the fake sees break the contract", async (_label, name) => {
    expect(await client.createOrganization({ id: randomUUID(), name })).toMatchObject({
      kind: "invalid",
      code: "invalid_request",
    });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^createOrganization request body: \/name /)]);
  });

  it("is invalid (payload_too_large) for a body over 2 MiB", async () => {
    expect(await client.createOrganization({ id: randomUUID(), name: "a".repeat(2_100_000) })).toEqual({
      kind: "invalid",
      code: "payload_too_large",
    });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^createOrganization request body: \/name /)]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.createOrganization({ id: randomUUID(), name: "Acme" })).toEqual({
      kind: "unavailable",
      reason: "server_error",
      status: 500,
    });
  });

  it("throws for a reply naming another organization than the id sent", async () => {
    const misrouted = clientAnswering(() => json(201, { organizationId: randomUUID() }));

    await expect(misrouted.createOrganization({ id: randomUUID(), name: "Acme" })).rejects.toThrow(
      "The opamp-server's reply to createOrganization (201) named another organization.",
    );
  });
});

describe("getOrganization", () => {
  it("is not_found for an id no organization has", async () => {
    expect(await client.getOrganization(randomUUID())).toEqual({ kind: "not_found" });
  });

  it("finds an id given in upper case", async () => {
    const id = await anOrganization();

    expect(await client.getOrganization(id.toUpperCase())).toMatchObject({ kind: "found", organization: { organizationId: id } });
  });

  it("is invalid for an id that isn't a UUID", async () => {
    expect(await client.getOrganization("not-a-uuid")).toMatchObject({ kind: "invalid", code: "invalid_request" });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^getOrganization request: path parameter organizationId /)]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.getOrganization(registered)).toMatchObject({ kind: "unavailable" });
  });

  it("throws for another organization than the one asked for", async () => {
    const id = await anOrganization();
    const stored = await client.getOrganization(id);
    if (stored.kind !== "found") throw new Error("expected found");
    const misrouted = clientAnswering(() => json(200, stored.organization));

    await expect(misrouted.getOrganization(randomUUID())).rejects.toThrow(
      "The opamp-server's reply to getOrganization (200) was another organization's.",
    );
  });
});

describe("renameOrganization", () => {
  it("renames: the new name, updatedAt now, createdAt kept", async () => {
    const id = await anOrganization("Acme");
    fakeNow = new Date("2026-10-04T09:00:00.000Z");

    expect(await client.renameOrganization(id, "Acme Corp")).toEqual({
      kind: "renamed",
      organization: { organizationId: id, name: "Acme Corp", createdAt: RECEIVED_AT, updatedAt: "2026-10-04T09:00:00.000Z" },
    });
    expect(await client.getOrganization(id)).toMatchObject({ organization: { name: "Acme Corp" } });
  });

  it("changes nothing, updatedAt included, for the name it has", async () => {
    const id = await anOrganization("Acme");
    fakeNow = new Date("2026-10-04T09:00:00.000Z");

    expect(await client.renameOrganization(id, "Acme")).toMatchObject({
      kind: "renamed",
      organization: { name: "Acme", updatedAt: RECEIVED_AT },
    });
  });

  it("is not_found for an id no organization has", async () => {
    expect(await client.renameOrganization(randomUUID(), "Acme")).toEqual({ kind: "not_found" });
  });

  it("is invalid for an empty name, which the fake sees break the contract", async () => {
    expect(await client.renameOrganization(registered, "")).toMatchObject({ kind: "invalid", code: "invalid_request" });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^renameOrganization request body: \/name /)]);
  });

  it("is invalid (payload_too_large) for a body over 2 MiB", async () => {
    expect(await client.renameOrganization(registered, "a".repeat(2_100_000))).toMatchObject({
      kind: "invalid",
      code: "payload_too_large",
    });
    expect(fake.takeViolations()).toHaveLength(1);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.renameOrganization(registered, "Acme")).toMatchObject({ kind: "unavailable" });
  });

  it("throws for another organization than the one renamed", async () => {
    const renamed = await client.renameOrganization(registered, "Initech");
    if (renamed.kind !== "renamed") throw new Error("expected renamed");
    const misrouted = clientAnswering(() => json(200, renamed.organization));

    await expect(misrouted.renameOrganization(randomUUID(), "Initech")).rejects.toThrow(/another organization's/);
  });
});

describe("deleteOrganization", () => {
  it("deletes an organization: deleted, then not_found", async () => {
    const id = await anOrganization();

    expect(await client.deleteOrganization(id)).toEqual({ kind: "deleted" });
    expect(await client.getOrganization(id)).toEqual({ kind: "not_found" });
    expect(await client.deleteOrganization(id)).toEqual({ kind: "not_found" });
  });

  it("deletes everything it owns, and nothing another organization owns", async () => {
    const id = await anOrganization("Acme");
    const other = await anOrganization();
    const publication = aPublication();
    const owned = await put(id, publication);
    const othersPublication = await put(other, aPublication({ configuration: publication.configuration }));

    expect(await client.deleteOrganization(id)).toEqual({ kind: "deleted" });

    expect(await client.getPublication(id, owned)).toEqual({ kind: "organization_not_found" });
    // Registering the id again starts an empty organization.
    expect(await client.createOrganization({ id, name: "Acme" })).toMatchObject({ kind: "created" });
    expect(await client.getPublication(id, owned)).toEqual({ kind: "not_found" });
    expect(await client.listPublications(id, { configurationId: publication.configuration.id })).toEqual({
      kind: "page",
      page: { publications: [], nextCursor: null },
    });
    expect(await client.getPublication(other, othersPublication)).toMatchObject({ kind: "found" });
  });

  it("is invalid for an id that isn't a UUID", async () => {
    expect(await client.deleteOrganization("42")).toMatchObject({ kind: "invalid", code: "invalid_request" });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^deleteOrganization request: path parameter organizationId /)]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.deleteOrganization(registered)).toMatchObject({ kind: "unavailable" });
  });
});

describe("publications under an organization that isn't registered", () => {
  it.each([
    ["postPublication", (c: OpampServerClient, organizationId: string) => c.postPublication(organizationId, randomUUID(), aPublication())],
    ["getPublication", (c: OpampServerClient, organizationId: string) => c.getPublication(organizationId, randomUUID())],
    [
      "listPublications",
      (c: OpampServerClient, organizationId: string) => c.listPublications(organizationId, { configurationId: randomUUID() }),
    ],
    ["deletePublication", (c: OpampServerClient, organizationId: string) => c.deletePublication(organizationId, randomUUID())],
    [
      "deleteConfigurationPublications",
      (c: OpampServerClient, organizationId: string) => c.deleteConfigurationPublications(organizationId, randomUUID()),
    ],
  ])("%s is organization_not_found", async (_operation, call) => {
    expect(await call(client, randomUUID())).toEqual({ kind: "organization_not_found" });
  });

  it("is organization_not_found before the body is read: a wrong sha256 isn't reached", async () => {
    const publication = aPublication({ sha256: sha256Hex("something else") });

    expect(await client.postPublication(randomUUID(), randomUUID(), publication)).toEqual({ kind: "organization_not_found" });
  });

  it("is organization_not_found before the query is read: a cursor the API didn't give isn't reached", async () => {
    expect(
      await client.listPublications(randomUUID(), { configurationId: randomUUID(), cursor: "not-a-cursor" }),
    ).toEqual({ kind: "organization_not_found" });
  });

  it("is organization_not_found for another organization's publication too, once that one is deleted", async () => {
    const owner = await anOrganization();
    const id = await put(owner, aPublication());
    expect(await client.deleteOrganization(owner)).toEqual({ kind: "deleted" });

    expect(await client.deletePublication(owner, id)).toEqual({ kind: "organization_not_found" });
  });
});

describe("postPublication", () => {
  it("stores a new publication: created, with the stored publication", async () => {
    const organizationId = await anOrganization();
    const id = randomUUID();
    const publication = aPublication();

    const result = await client.postPublication(organizationId, id, publication);

    expect(result).toEqual({
      kind: "created",
      publication: {
        id,
        organizationId,
        configuration: publication.configuration,
        version: publication.version,
        yaml: publication.yaml,
        sha256: publication.sha256,
        publishedBy: publication.publishedBy,
        publishedAt: "2026-10-03T14:02:11.000Z",
        receivedAt: RECEIVED_AT,
        collector: { distribution: "otelcol-contrib", version: "0.161.0" },
      },
    });
  });

  it("POSTs …/publications under the organization, with the caller's id in the body (0.2.4's postPublication, D36-1 decision 14)", async () => {
    const sent: { url: string; method: string | undefined; body: Record<string, unknown> }[] = [];
    const publication = aPublication();
    const id = randomUUID();
    const recording = createOpampServerClient({
      url: fake.url,
      secret: fake.secret,
      fetch: (url, init) => {
        sent.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return fetch(url, init);
      },
    });

    const result = await recording.postPublication(registered, id, publication);

    expect(sent).toEqual([
      { url: `${fake.url}/api/v1/organizations/${registered}/publications`, method: "POST", body: { id, ...publication } },
    ]);
    expect(result).toMatchObject({ kind: "created", publication: { id, organizationId: registered } });
    // A retry of the same id and body is the same publication: safe.
    expect(await recording.postPublication(registered, id, publication)).toMatchObject({ kind: "unchanged", publication: { id } });
  });

  it("sends the collector as an object of exactly its two fields, and parses it from the reply (D13a decision 7)", async () => {
    const sent: unknown[] = [];
    const publication = aPublication({ collector: { distribution: "otelcol-k8s", version: "0.155.0" } });
    const id = randomUUID();
    const recording = createOpampServerClient({
      url: fake.url,
      secret: fake.secret,
      fetch: (url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return fetch(url, init);
      },
    });

    const result = await recording.postPublication(registered, id, publication);

    expect(sent).toHaveLength(1);
    expect((sent[0] as { collector: unknown }).collector).toStrictEqual({ distribution: "otelcol-k8s", version: "0.155.0" });
    expect(result).toMatchObject({ kind: "created", publication: { id, collector: publication.collector } });
    if (result.kind !== "created") throw new Error(result.kind);
    expect(result.publication.collector).toStrictEqual({ distribution: "otelcol-k8s", version: "0.155.0" });
    const read = await client.getPublication(registered, id);
    expect(read).toMatchObject({ kind: "found", publication: { collector: publication.collector } });
  });

  it("answers unchanged, with the stored publication, for the same id and body again", async () => {
    const organizationId = await anOrganization();
    const publication = aPublication({ publishedBy: null, version: { id: randomUUID(), number: 1, label: null } });
    const id = await put(organizationId, publication);

    const result = await client.postPublication(organizationId, id, publication);

    expect(result).toMatchObject({ kind: "unchanged", publication: { id, yaml: publication.yaml, receivedAt: RECEIVED_AT } });
  });

  it("answers unchanged for a publishedAt that differs only below the millisecond (Ruling 27)", async () => {
    const organizationId = await anOrganization();
    const publication = aPublication({ publishedAt: "2026-10-03T14:02:11.123Z" });
    const id = await put(organizationId, publication);

    const result = await client.postPublication(organizationId, id, {
      ...publication,
      publishedAt: "2026-10-03T14:02:11.123456Z",
    });

    expect(result).toMatchObject({ kind: "unchanged", publication: { publishedAt: "2026-10-03T14:02:11.123Z" } });
  });

  it.each([
    ["the YAML", (p: PublicationRequest) => ({ ...p, yaml: `${p.yaml}# changed\n`, sha256: sha256Hex(`${p.yaml}# changed\n`) })],
    ["the name", (p: PublicationRequest) => ({ ...p, configuration: { ...p.configuration, name: "renamed" } })],
    ["the label", (p: PublicationRequest) => ({ ...p, version: { ...p.version, label: null } })],
    ["the actor", (p: PublicationRequest) => ({ ...p, publishedBy: null })],
    ["publishedAt by a millisecond", (p: PublicationRequest) => ({ ...p, publishedAt: "2026-10-03T14:02:11.001Z" })],
    ["the collector's distribution", (p: PublicationRequest) => ({ ...p, collector: { ...p.collector, distribution: "otelcol-k8s" } })],
    ["the collector's version", (p: PublicationRequest) => ({ ...p, collector: { ...p.collector, version: "0.162.0" } })],
  ])("answers conflict for the same id with a different body: %s", async (_label, change) => {
    const organizationId = await anOrganization();
    const publication = aPublication();
    const id = await put(organizationId, publication);

    expect(await client.postPublication(organizationId, id, change(publication))).toEqual({ kind: "conflict" });
  });

  it("answers conflict for an id another organization holds, with nothing of its row", async () => {
    const publication = aPublication();
    const id = await put(await anOrganization(), publication);

    expect(await client.postPublication(await anOrganization(), id, publication)).toEqual({ kind: "conflict" });
  });

  it("sends the sha256 it was given, computing nothing: a wrong one is invalid (sha256_mismatch)", async () => {
    const publication = aPublication({ sha256: sha256Hex("something else") });

    expect(await client.postPublication(registered, randomUUID(), publication)).toEqual({
      kind: "invalid",
      code: "sha256_mismatch",
    });
  });

  it("is invalid (invalid_request) for YAML over 1 MiB of UTF-8, naming the field", async () => {
    // 524,289 characters, under the schema's maxLength; 1,048,578 bytes.
    const yaml = "é".repeat(524_289);

    const result = await client.postPublication(registered, randomUUID(), aPublication({ yaml, sha256: sha256Hex(yaml) }));

    expect(result).toEqual({ kind: "invalid", code: "invalid_request" });
  });

  it("is invalid (payload_too_large) for a body over 2 MiB", async () => {
    // 700,000 characters, under the schema's maxLength; 2,100,000 bytes.
    const yaml = "€".repeat(700_000);

    const result = await client.postPublication(registered, randomUUID(), aPublication({ yaml, sha256: sha256Hex(yaml) }));

    expect(result).toEqual({ kind: "invalid", code: "payload_too_large" });
  });

  it("is invalid (invalid_request) for an id that isn't a UUID, which the fake sees break the contract", async () => {
    const result = await client.postPublication(registered, "not-a-uuid", aPublication());

    expect(result).toMatchObject({ kind: "invalid", code: "invalid_request" });
    // 0.2.4 takes the id in the body: the body breaks the contract.
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^postPublication request body: \/id /)]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.postPublication(registered, randomUUID(), aPublication())).toEqual({
      kind: "unavailable",
      reason: "server_error",
      status: 500,
    });
  });
});

describe("getPublication", () => {
  it("finds a publication, its YAML byte for byte", async () => {
    const organizationId = await anOrganization();
    const yaml = 'receivers:\n  otlp: {} # ünïcödé, 日本語, 🚀, <&>, "quoted", \\  \n';
    const id = await put(organizationId, aPublication({ yaml, sha256: sha256Hex(yaml) }));

    const result = await client.getPublication(organizationId, id);

    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(Buffer.from(result.publication.yaml, "utf8").equals(Buffer.from(yaml, "utf8"))).toBe(true);
    expect(result.publication).toMatchObject({ id, organizationId, sha256: sha256Hex(yaml) });
  });

  it("is not_found for an unknown id", async () => {
    expect(await client.getPublication(registered, randomUUID())).toEqual({ kind: "not_found" });
  });

  it("is not_found for another organization's publication", async () => {
    const id = await put(await anOrganization(), aPublication());

    expect(await client.getPublication(await anOrganization(), id)).toEqual({ kind: "not_found" });
  });

  it("finds an id given in upper case", async () => {
    const organizationId = await anOrganization();
    const id = await put(organizationId, aPublication());

    expect(await client.getPublication(organizationId.toUpperCase(), id.toUpperCase())).toMatchObject({ kind: "found" });
  });

  it("is invalid for an id that isn't a UUID", async () => {
    expect(await client.getPublication(registered, "42")).toMatchObject({ kind: "invalid", code: "invalid_request" });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^getPublication request: path parameter publicationId /)]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.getPublication(registered, randomUUID())).toMatchObject({ kind: "unavailable" });
  });
});

describe("listPublications", () => {
  /** Five publications of one configuration: two share a publishedAt. */
  async function fiveOfOneConfiguration(organizationId: string, configurationId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const publishedAt of [
      "2026-10-03T10:00:00.000Z",
      "2026-10-03T12:00:00.000Z",
      "2026-10-03T12:00:00.000Z",
      "2026-10-03T11:00:00.000Z",
      "2026-10-03T09:00:00.000Z",
    ]) {
      const publication = aPublication({ publishedAt });
      ids.push(await put(organizationId, { ...publication, configuration: { ...publication.configuration, id: configurationId } }));
    }
    return ids;
  }

  it("lists a configuration's publications newest first, ties by id, without their YAML", async () => {
    const organizationId = await anOrganization();
    const configurationId = randomUUID();
    const ids = await fiveOfOneConfiguration(organizationId, configurationId);
    await put(organizationId, aPublication()); // another configuration's

    const result = await client.listPublications(organizationId, { configurationId });

    expect(result.kind).toBe("page");
    if (result.kind !== "page") return;
    const tied = [ids[1], ids[2]].sort().reverse();
    expect(result.page.publications.map((p) => p.id)).toEqual([tied[0], tied[1], ids[3], ids[0], ids[4]]);
    expect(result.page.nextCursor).toBeNull();
    for (const summary of result.page.publications) expect(summary).not.toHaveProperty("yaml");
  });

  it("pages with limit 2 over 5 rows, returning every row once", async () => {
    const organizationId = await anOrganization();
    const configurationId = randomUUID();
    const ids = await fiveOfOneConfiguration(organizationId, configurationId);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await client.listPublications(organizationId, {
        configurationId,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.kind !== "page") throw new Error(`expected a page, got ${result.kind}`);
      seen.push(...result.page.publications.map((p) => p.id));
      cursor = result.page.nextCursor ?? undefined;
    }

    expect(cursor).toBeUndefined();
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("never lists another organization's publications of the same configuration id", async () => {
    const configurationId = randomUUID();
    await fiveOfOneConfiguration(await anOrganization(), configurationId);

    expect(await client.listPublications(await anOrganization(), { configurationId })).toEqual({
      kind: "page",
      page: { publications: [], nextCursor: null },
    });
  });

  it("is invalid for a cursor the API didn't give", async () => {
    expect(await client.listPublications(registered, { configurationId: randomUUID(), cursor: "not-a-cursor" })).toEqual({
      kind: "invalid",
      code: "invalid_request",
    });
  });

  it("is invalid for a limit over 100, which the fake sees break the contract", async () => {
    expect(await client.listPublications(registered, { configurationId: randomUUID(), limit: 101 })).toMatchObject({
      kind: "invalid",
    });
    expect(fake.takeViolations()).toEqual([expect.stringMatching(/^listPublications request: query parameter limit /)]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.listPublications(registered, { configurationId: randomUUID() })).toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("deletePublication", () => {
  it("deletes a publication: deleted, then not_found", async () => {
    const organizationId = await anOrganization();
    const id = await put(organizationId, aPublication());

    expect(await client.deletePublication(organizationId, id)).toEqual({ kind: "deleted" });
    expect(await client.getPublication(organizationId, id)).toEqual({ kind: "not_found" });
    expect(await client.deletePublication(organizationId, id)).toEqual({ kind: "not_found" });
  });

  it("is not_found for another organization's publication, which survives", async () => {
    const owner = await anOrganization();
    const id = await put(owner, aPublication());

    expect(await client.deletePublication(await anOrganization(), id)).toEqual({ kind: "not_found" });
    expect(await client.getPublication(owner, id)).toMatchObject({ kind: "found" });
  });

  it("is in_use while a collector group or a collector uses it, and deletes nothing (D16a decision 31)", async () => {
    const organizationId = await anOrganization();
    const id = await put(organizationId, aPublication());
    fake.markPublicationInUse(organizationId, id);

    expect(await client.deletePublication(organizationId, id)).toEqual({ kind: "in_use" });
    expect(await client.getPublication(organizationId, id)).toMatchObject({ kind: "found" });

    fake.markPublicationInUse(organizationId, id, false);
    expect(await client.deletePublication(organizationId, id)).toEqual({ kind: "deleted" });
  });

  it("is invalid for an id that isn't a UUID", async () => {
    expect(await client.deletePublication("not-a-uuid", randomUUID())).toMatchObject({ kind: "invalid" });
    expect(fake.takeViolations()).toEqual([
      expect.stringMatching(/^deletePublication request: path parameter organizationId /),
    ]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.deletePublication(registered, randomUUID())).toMatchObject({ kind: "unavailable" });
  });
});

describe("deleteConfigurationPublications", () => {
  it("deletes exactly that configuration's publications in that organization", async () => {
    const organizationId = await anOrganization();
    const other = await anOrganization();
    const publication = aPublication();
    const configurationId = publication.configuration.id;
    const first = await put(organizationId, publication);
    const second = await put(organizationId, aPublication({ configuration: publication.configuration }));
    const anotherConfiguration = await put(organizationId, aPublication());
    const anotherOrganization = await put(other, aPublication({ configuration: publication.configuration }));

    expect(await client.deleteConfigurationPublications(organizationId, configurationId)).toEqual({ kind: "deleted" });

    expect(await client.getPublication(organizationId, first)).toEqual({ kind: "not_found" });
    expect(await client.getPublication(organizationId, second)).toEqual({ kind: "not_found" });
    expect(await client.getPublication(organizationId, anotherConfiguration)).toMatchObject({ kind: "found" });
    expect(await client.getPublication(other, anotherOrganization)).toMatchObject({ kind: "found" });
  });

  it("is deleted when there were none", async () => {
    expect(await client.deleteConfigurationPublications(registered, randomUUID())).toEqual({ kind: "deleted" });
  });

  it("is in_use while one of them is used, and deletes none of them (D16a decision 31)", async () => {
    const organizationId = await anOrganization();
    const publication = aPublication();
    const used = await put(organizationId, publication);
    const unused = await put(organizationId, aPublication({ configuration: publication.configuration }));
    fake.markPublicationInUse(organizationId, used);

    expect(await client.deleteConfigurationPublications(organizationId, publication.configuration.id)).toEqual({
      kind: "in_use",
    });
    expect(await client.getPublication(organizationId, used)).toMatchObject({ kind: "found" });
    expect(await client.getPublication(organizationId, unused)).toMatchObject({ kind: "found" });
  });

  it("is invalid for a configuration id that isn't a UUID", async () => {
    expect(await client.deleteConfigurationPublications(registered, "nope")).toMatchObject({ kind: "invalid" });
    expect(fake.takeViolations()).toEqual([
      expect.stringMatching(/^deleteConfigurationPublications request: path parameter configurationId /),
    ]);
  });

  it("is unavailable when the server answers 500", async () => {
    fake.nextFault("error_500");

    expect(await client.deleteConfigurationPublications(registered, randomUUID())).toMatchObject({
      kind: "unavailable",
    });
  });
});

/** One call of each method, for the tests every method shares. */
const everyMethod: [string, (c: OpampServerClient) => Promise<unknown>][] = [
  ["createOrganization", (c) => c.createOrganization({ id: randomUUID(), name: "every method" })],
  ["getOrganization", (c) => c.getOrganization(registered)],
  ["renameOrganization", (c) => c.renameOrganization(registered, "every method")],
  ["deleteOrganization", (c) => c.deleteOrganization(randomUUID())],
  ["postPublication", (c) => c.postPublication(registered, randomUUID(), aPublication())],
  ["getPublication", (c) => c.getPublication(registered, randomUUID())],
  ["listPublications", (c) => c.listPublications(registered, { configurationId: randomUUID() })],
  ["deletePublication", (c) => c.deletePublication(registered, randomUUID())],
  ["deleteConfigurationPublications", (c) => c.deleteConfigurationPublications(registered, randomUUID())],
];

describe("answers no caller can handle", () => {
  it.each(everyMethod)("throws for a 401 from %s: the secret is wrong", async (operation, call) => {
    const wrongSecret = "a-wrong-but-long-enough-secret-0123456789";
    const wrong = createOpampServerClient({ url: fake.url, secret: wrongSecret });

    const error = await call(wrong).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpampServerMisconfigurationError);
    expect((error as Error).message).toBe(
      `The opamp-server answered ${operation} with 401: it doesn't accept TELFLO_OPAMP_MANAGEMENT_SECRET.`,
    );
    expect(`${(error as Error).message}${(error as Error).stack}`).not.toContain(wrongSecret);
  });

  it("throws for a reply that doesn't match its schema, naming the field only", async () => {
    const organizationId = await anOrganization();
    const publication = aPublication();
    fake.nextFault("malformed_reply"); // the Publication loses its id

    const error = await client
      .postPublication(organizationId, randomUUID(), publication)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpampServerMisconfigurationError);
    expect((error as Error).message).toBe("The opamp-server's reply to postPublication (201) didn't match its schema at: id.");
    expect(fake.takeViolations()).toEqual([
      "postPublication reply 201 body: (root) must have required property 'id'",
    ]);
  });

  it.each([
    ["null, as a server of the previous release answers it", null, "collector"],
    ["without its version", { distribution: "otelcol-contrib" }, "collector.version"],
    ["with a version that isn't major.minor.patch", { distribution: "otelcol-contrib", version: "0.162" }, "collector.version"],
    ["with a distribution in capitals", { distribution: "Otelcol-Contrib", version: "0.162.0" }, "collector.distribution"],
  ])("throws for a reply whose collector is %s, naming the field only (D13a decision 7)", async (_label, collector, field) => {
    const organizationId = await anOrganization();
    const id = randomUUID();
    const publication = aPublication();
    const stored = await client.postPublication(organizationId, id, publication);
    if (stored.kind !== "created") throw new Error(stored.kind);
    const answering = clientAnswering(() => json(200, { ...stored.publication, collector }));

    const error = await answering.getPublication(organizationId, id).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpampServerMisconfigurationError);
    expect((error as Error).message).toBe(`The opamp-server's reply to getPublication (200) didn't match its schema at: ${field}.`);
  });

  it.each(everyMethod)("throws for a malformed reply to %s", async (_operation, call) => {
    fake.nextFault("malformed_reply");

    await expect(call(client)).rejects.toBeInstanceOf(OpampServerMisconfigurationError);
    expect(fake.takeViolations()).toHaveLength(1);
  });

  it("throws for a status the API doesn't document, and doesn't follow a redirect", async () => {
    const seen: RequestInit[] = [];
    const redirecting = createOpampServerClient({
      url: "http://opamp-server.invalid",
      secret: fake.secret,
      fetch: (_url, init) => {
        seen.push(init ?? {});
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://elsewhere.invalid/" } }));
      },
    });

    await expect(redirecting.getPublication(randomUUID(), randomUUID())).rejects.toThrow(
      "The opamp-server answered getPublication with 302, which the API doesn't document.",
    );
    expect(seen[0]?.redirect).toBe("manual");
  });

  it.each(everyMethod)("throws for a status %s doesn't document", async (operation, call) => {
    const teapot = clientAnswering(() => json(418, { error: { code: "invalid_request", message: "I'm a teapot." } }));

    await expect(call(teapot)).rejects.toThrow(
      `The opamp-server answered ${operation} with 418, which the API doesn't document.`,
    );
  });

  it("throws for a reply that isn't JSON", async () => {
    const html = clientAnswering(() => new Response("<html>receivers:</html>", { status: 200 }));

    await expect(html.listPublications(randomUUID(), { configurationId: randomUUID() })).rejects.toThrow(
      "The opamp-server's reply to listPublications (200) wasn't JSON.",
    );
  });

  it.each([
    ["postPublication", 404, "not_found", (c: OpampServerClient) => c.postPublication(randomUUID(), randomUUID(), aPublication())],
    ["postPublication", 409, "organization_conflict", (c: OpampServerClient) => c.postPublication(randomUUID(), randomUUID(), aPublication())],
    ["getPublication", 404, "publication_conflict", (c: OpampServerClient) => c.getPublication(randomUUID(), randomUUID())],
    ["listPublications", 404, "not_found", (c: OpampServerClient) => c.listPublications(randomUUID(), { configurationId: randomUUID() })],
    ["deleteConfigurationPublications", 404, "not_found", (c: OpampServerClient) => c.deleteConfigurationPublications(randomUUID(), randomUUID())],
    ["deletePublication", 409, "publication_conflict", (c: OpampServerClient) => c.deletePublication(randomUUID(), randomUUID())],
    ["deleteConfigurationPublications", 409, "organization_conflict", (c: OpampServerClient) => c.deleteConfigurationPublications(randomUUID(), randomUUID())],
    ["createOrganization", 409, "publication_conflict", (c: OpampServerClient) => c.createOrganization({ name: "Acme" })],
    ["getOrganization", 404, "organization_not_found", (c: OpampServerClient) => c.getOrganization(randomUUID())],
    ["renameOrganization", 404, "organization_not_found", (c: OpampServerClient) => c.renameOrganization(randomUUID(), "Acme")],
    ["deleteOrganization", 404, "organization_not_found", (c: OpampServerClient) => c.deleteOrganization(randomUUID())],
  ])("throws when %s answers %s with a code it doesn't document there (%s)", async (operation, status, code, call) => {
    const wrongCode = clientAnswering(() => json(status, { error: { code, message: "Not found." } }));

    await expect(call(wrongCode)).rejects.toThrow(
      `The opamp-server answered ${operation} with ${status} ${code}, which the API doesn't document.`,
    );
  });

  it("throws for an error reply without the envelope", async () => {
    const bare = clientAnswering(() => json(404, { message: "nope" }));

    await expect(bare.deletePublication(randomUUID(), randomUUID())).rejects.toThrow(
      "The opamp-server's reply to deletePublication (404) didn't match its schema at: error.",
    );
  });

  it("throws for a publication of another organization, or another id", async () => {
    const organizationId = await anOrganization();
    const id = await put(organizationId, aPublication());
    const stored = await client.getPublication(organizationId, id);
    if (stored.kind !== "found") throw new Error("expected found");
    const misrouted = clientAnswering(() => json(200, stored.publication));

    await expect(misrouted.getPublication(randomUUID(), id)).rejects.toThrow(/another organization's or another publication/);
    await expect(misrouted.getPublication(organizationId, randomUUID())).rejects.toThrow(
      /another organization's or another publication/,
    );
  });

  it("throws for a list holding another organization's or configuration's publication", async () => {
    const organizationId = await anOrganization();
    const publication = aPublication();
    await put(organizationId, publication);
    const page = await client.listPublications(organizationId, { configurationId: publication.configuration.id });
    if (page.kind !== "page") throw new Error("expected a page");
    const misrouted = clientAnswering(() => json(200, page.page));

    await expect(
      misrouted.listPublications(randomUUID(), { configurationId: publication.configuration.id }),
    ).rejects.toThrow(/listed a publication of another organization or configuration/);
    await expect(misrouted.listPublications(organizationId, { configurationId: randomUUID() })).rejects.toThrow(
      /listed a publication of another organization or configuration/,
    );
  });
});

describe("unavailable", () => {
  it.each(everyMethod)("is unavailable when %s gets no answer within the timeout", async (_operation, call) => {
    const impatient = createOpampServerClient({ url: fake.url, secret: fake.secret, timeoutMs: 50 });
    fake.nextFault("hang");

    expect(await call(impatient)).toEqual({ kind: "unavailable", reason: "timeout" });
  });

  it.each(everyMethod)("is unavailable when the connection is reset during %s", async (_operation, call) => {
    fake.nextFault("reset");

    expect(await call(client)).toEqual({ kind: "unavailable", reason: "network" });
  });

  it("is unavailable when the reply breaks off while it is read", async () => {
    const brokenOff = clientAnswering(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":'));
              controller.error(new Error("other side closed"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    expect(await brokenOff.getPublication(randomUUID(), randomUUID())).toEqual({ kind: "unavailable", reason: "network" });
  });

  it("is unavailable when nothing listens", async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((done) => closed.close(() => done()));
    const nobody = createOpampServerClient({ url: `http://127.0.0.1:${port}`, secret: fake.secret });

    expect(await nobody.getPublication(randomUUID(), randomUUID())).toEqual({ kind: "unavailable", reason: "network" });
  });

  it.each([502, 503, 504])("is unavailable for any 5xx, %s included, whatever its body", async (status) => {
    const failing = clientAnswering(() => new Response("<html>Bad gateway</html>", { status }));

    expect(await failing.postPublication(randomUUID(), randomUUID(), aPublication())).toEqual({
      kind: "unavailable",
      reason: "server_error",
      status,
    });
  });

  it("is unavailable for the opamp-server's 503 delete_in_progress on either long delete, as every 5xx", async () => {
    // D16b Ruling 36: the server answers a delete it is already running at once.
    const running = clientAnswering(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "delete_in_progress",
              message: "This delete is already running: retry later; once it has finished, a retry answers 404.",
            },
          }),
          { status: 503, headers: { "content-type": "application/json", "retry-after": "10" } },
        ),
    );

    expect(await running.deleteOrganization(randomUUID())).toEqual({ kind: "unavailable", reason: "server_error", status: 503 });
    expect(await running.deleteFleet(randomUUID(), randomUUID())).toEqual({
      kind: "unavailable",
      reason: "server_error",
      status: 503,
    });
  });

  it("times out after 5000 ms by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hanging = createOpampServerClient({
      url: "http://opamp-server.invalid",
      secret: fake.secret,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    let settled: unknown;
    const pending = hanging.getPublication(randomUUID(), randomUUID()).then((result) => {
      settled = result;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
  });
});

describe("secrets and YAML", () => {
  it("never puts the secret or the YAML in an error, a result or a log line of a failing call", async () => {
    const yaml = `receivers:\n  otlp: # yaml-marker-${randomUUID()}\n`;
    const secret = `secret-marker-${randomUUID()}`;
    const output: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" ")));
    }
    const capture = (chunk: unknown) => {
      output.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);

    const wrong = createOpampServerClient({ url: fake.url, secret });
    const impatient = createOpampServerClient({ url: fake.url, secret: fake.secret, timeoutMs: 50 });
    const publication = aPublication({ yaml, sha256: sha256Hex(yaml) });
    const failures: unknown[] = [];
    const attempt = async (call: () => Promise<unknown>) => failures.push(await call().catch((error: unknown) => error));

    await attempt(() => wrong.postPublication(registered, randomUUID(), publication));
    fake.nextFault("malformed_reply");
    await attempt(() => client.postPublication(registered, randomUUID(), publication));
    fake.nextFault("error_500");
    await attempt(() => client.postPublication(registered, randomUUID(), publication));
    fake.nextFault("hang");
    await attempt(() => impatient.postPublication(registered, randomUUID(), publication));
    fake.nextFault("reset");
    await attempt(() => client.postPublication(registered, randomUUID(), publication));
    await attempt(() => client.postPublication(registered, randomUUID(), { ...publication, sha256: sha256Hex("other") }));
    vi.restoreAllMocks();
    fake.takeViolations(); // the malformed reply's

    expect(failures).toHaveLength(6);
    const seen = [
      ...failures.map((failure) =>
        failure instanceof Error ? `${failure.message}\n${failure.stack}` : JSON.stringify(failure),
      ),
      ...output,
    ].join("\n");
    expect(seen).not.toContain(secret);
    expect(seen).not.toContain(fake.secret);
    expect(seen).not.toContain("yaml-marker");
    expect(seen).not.toContain("Bearer");
  });
});

describe("sha256Hex", () => {
  it("hashes a multi-byte string's UTF-8 bytes", () => {
    // "é" is c3 a9 in UTF-8 (e9 in Latin-1); "🚀" is four bytes.
    expect(sha256Hex("é🚀")).toBe(createHash("sha256").update(Buffer.from([0xc3, 0xa9, 0xf0, 0x9f, 0x9a, 0x80])).digest("hex"));
    expect(sha256Hex("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
    expect(sha256Hex("é")).not.toBe(createHash("sha256").update(Buffer.from([0xe9])).digest("hex"));
  });
});
