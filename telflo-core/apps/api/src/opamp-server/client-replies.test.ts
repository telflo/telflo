import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { startFakeOpampServer, type FakeOpampServer } from "../testing/fake-opamp-server.js";
import {
  createOpampServerClient,
  DEFAULT_OPAMP_SERVER_TIMEOUT_MS,
  DELETE_OPAMP_SERVER_TIMEOUT_MS,
  OPAMP_SERVER_REPLY_CAPS,
  OpampServerMisconfigurationError,
  sha256Hex,
  type OpampServerClient,
  type OpampServerReplyClass,
} from "./client.js";

// How the opamp-server client reads and refuses replies: every reply of the 34
// operations under its class's cap, the transport's timer and redirects, the
// answers no caller can handle for the fleet model's 25 operations, the ids a
// reply echoes, and what an error may carry (nothing of a query, a bearer, a
// YAML, an attribute or an error text). Replies a real server wouldn't send
// come from an injected fetch; the rest from the fake, which reads its
// violations after each test. The organization variables' 11 operations are
// checked too (their two unpaged reads in U).

let fake: FakeOpampServer;
let client: OpampServerClient;

beforeAll(async () => {
  fake = await startFakeOpampServer();
  client = createOpampServerClient({ url: fake.url, secret: fake.secret });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(fake.takeViolations()).toEqual([]);
});

afterAll(async () => {
  await fake.close();
});

const OPENAPI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../vendor/opamp-server/openapi.yaml",
);

const ACTOR = { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", email: "sam@acme.io" };
const KiB = 1024;
const MiB = 1024 * KiB;

/** The ids a call names. */
interface Ids {
  org: string;
  fleet: string;
  group: string;
  token: string;
  collector: string;
  configuration: string;
  publication: string;
  variable: string;
  variableGroup: string;
}

const randomIds = (): Ids => ({
  variable: randomUUID(),
  variableGroup: randomUUID(),
  org: randomUUID(),
  fleet: randomUUID(),
  group: randomUUID(),
  token: randomUUID(),
  collector: randomUUID(),
  configuration: randomUUID(),
  publication: randomUUID(),
});

function aPublicationRequest(configurationId: string = randomUUID()) {
  const yaml = `receivers: {}\n# ${randomUUID()}\n`;
  return {
    configuration: { id: configurationId, name: "payments-gateway" },
    version: { id: randomUUID(), number: 1, label: null },
    yaml,
    sha256: sha256Hex(yaml),
    publishedBy: null,
    publishedAt: "2026-10-03T14:02:11.000Z",
    collector: { distribution: "otelcol-contrib", version: "0.162.0" },
  };
}

type Call = (c: OpampServerClient, i: Ids) => Promise<unknown>;

/**
 * Every operation, its reply class (written here, not read from the client,
 * so a class moved there fails here), and a call of it naming `ids`.
 */
const EVERY_OPERATION: [string, OpampServerReplyClass, Call][] = [
  ["createOrganization", "S", (c, i) => c.createOrganization({ id: i.org, name: "Acme" })],
  ["getOrganization", "S", (c, i) => c.getOrganization(i.org)],
  ["renameOrganization", "S", (c, i) => c.renameOrganization(i.org, "Acme")],
  ["deleteOrganization", "S", (c, i) => c.deleteOrganization(i.org)],
  ["postPublication", "L", (c, i) => c.postPublication(i.org, i.publication, aPublicationRequest(i.configuration))],
  ["getPublication", "L", (c, i) => c.getPublication(i.org, i.publication)],
  ["listPublications", "M", (c, i) => c.listPublications(i.org, { configurationId: i.configuration })],
  ["deletePublication", "S", (c, i) => c.deletePublication(i.org, i.publication)],
  ["deleteConfigurationPublications", "S", (c, i) => c.deleteConfigurationPublications(i.org, i.configuration)],
  ["getConfigurationUsage", "U", (c, i) => c.getConfigurationUsage(i.org, i.configuration)],
  ["getLimits", "S", (c, i) => c.getLimits(i.org)],
  ["setLimits", "S", (c, i) => c.setLimits(i.org, { maxCollectors: 10, requestsPerMinute: null })],
  [
    "createFleet",
    "S",
    (c, i) => c.createFleet(i.org, { id: i.fleet, label: "edge-prod", type: "server", rotateExpiresAt: null, actor: ACTOR }),
  ],
  ["listFleets", "M", (c, i) => c.listFleets(i.org)],
  ["getFleet", "S", (c, i) => c.getFleet(i.org, i.fleet)],
  ["updateFleet", "S", (c, i) => c.updateFleet(i.org, i.fleet, { label: "renamed" })],
  ["deleteFleet", "S", (c, i) => c.deleteFleet(i.org, i.fleet)],
  ["listCollectorGroups", "U", (c, i) => c.listCollectorGroups(i.org, i.fleet)],
  ["createCollectorGroup", "S", (c, i) => c.createCollectorGroup(i.org, i.fleet, { name: "edge" })],
  ["getCollectorGroup", "S", (c, i) => c.getCollectorGroup(i.org, i.fleet, i.group)],
  ["updateCollectorGroup", "S", (c, i) => c.updateCollectorGroup(i.org, i.fleet, i.group, { name: "renamed" })],
  ["deleteCollectorGroup", "S", (c, i) => c.deleteCollectorGroup(i.org, i.fleet, i.group)],
  ["listEnrollmentTokens", "U", (c, i) => c.listEnrollmentTokens(i.org, i.fleet)],
  ["listEnrollmentTokenEvents", "M", (c, i) => c.listEnrollmentTokenEvents(i.org, i.fleet)],
  [
    "rotateEnrollmentToken",
    "S",
    (c, i) =>
      c.rotateEnrollmentToken(i.org, i.fleet, { expiresAt: null, graceEndsAt: new Date(Date.now() + 3_600_000).toISOString(), actor: ACTOR }),
  ],
  ["issueDefaultEnrollmentToken", "S", (c, i) => c.issueDefaultEnrollmentToken(i.org, i.fleet, ACTOR)],
  ["revealEnrollmentToken", "S", (c, i) => c.revealEnrollmentToken(i.org, i.fleet, i.token, ACTOR)],
  ["revokeEnrollmentToken", "S", (c, i) => c.revokeEnrollmentToken(i.org, i.fleet, i.token, ACTOR)],
  ["listCollectorInstances", "L", (c, i) => c.listCollectorInstances(i.org, i.fleet)],
  ["pinCollectorInstances", "S", (c, i) => c.pinCollectorInstances(i.org, i.fleet, { collectorIds: [i.collector], pin: null })],
  ["getCollectorInstance", "M", (c, i) => c.getCollectorInstance(i.org, i.fleet, i.collector)],
  ["updateCollectorInstance", "M", (c, i) => c.updateCollectorInstance(i.org, i.fleet, i.collector, { name: "renamed" })],
  ["deleteCollectorInstance", "S", (c, i) => c.deleteCollectorInstance(i.org, i.fleet, i.collector)],
  ["listCollectorInstanceErrors", "L", (c, i) => c.listCollectorInstanceErrors(i.org, i.fleet, i.collector)],
  // The organization variables.
  ["listVariables", "U", (c, i) => c.listVariables(i.org)],
  ["createVariable", "S", (c, i) => c.createVariable(i.org, { id: i.variable, name: "REGION", value: "eu", description: null, actor: ACTOR })],
  ["updateVariable", "S", (c, i) => c.updateVariable(i.org, i.variable, { value: "us", actor: ACTOR })],
  ["deleteVariable", "S", (c, i) => c.deleteVariable(i.org, i.variable)],
  ["listVariableGroups", "U", (c, i) => c.listVariableGroups(i.org)],
  ["createVariableGroup", "S", (c, i) => c.createVariableGroup(i.org, { id: i.variableGroup, name: "eu-edge", description: null, actor: ACTOR })],
  ["getVariableGroup", "U", (c, i) => c.getVariableGroup(i.org, i.variableGroup)],
  ["updateVariableGroup", "S", (c, i) => c.updateVariableGroup(i.org, i.variableGroup, { name: "eu-west", actor: ACTOR })],
  ["deleteVariableGroup", "S", (c, i) => c.deleteVariableGroup(i.org, i.variableGroup)],
  ["setVariableGroupOverride", "S", (c, i) => c.setVariableGroupOverride(i.org, i.variableGroup, i.variable, { value: "eu-1", actor: ACTOR })],
  ["resetVariableGroupOverride", "S", (c, i) => c.resetVariableGroupOverride(i.org, i.variableGroup, i.variable, ACTOR)],
];

/** The fleet model's 23, and the organization variables' 11. */
const FLEET_OPERATIONS = EVERY_OPERATION.slice(9);

describe("each operation's timer", () => {
  /** The three deletes whose cascade can be long (a group's takes its collectors with it): 25 s; every other operation 5 s. */
  const LONG = new Set(["deleteOrganization", "deleteFleet", "deleteCollectorGroup"]);

  /** A client whose fetch never answers, until the client's timer aborts it. */
  const hanging = (options: { timeoutMs?: number; deleteTimeoutMs?: number } = {}) =>
    createOpampServerClient({
      url: "http://opamp-server.invalid",
      secret: fake.secret,
      ...options,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });

  /** Whether `call` on `c` is still waiting after `ms - 1` and has timed out at `ms`. */
  async function expectTimeoutAt(c: OpampServerClient, call: Call, ms: number) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled: unknown;
    const pending = call(c, randomIds()).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
  }

  it("is 25 s for an organization's, a fleet's or a group's delete and 5 s for every other operation", () => {
    expect(DELETE_OPAMP_SERVER_TIMEOUT_MS).toBe(25_000);
    expect(DEFAULT_OPAMP_SERVER_TIMEOUT_MS).toBe(5_000);
    expect(EVERY_OPERATION.filter(([operation]) => LONG.has(operation))).toHaveLength(3);
  });

  it.each(EVERY_OPERATION)("%s waits until its own timer: 24.999 s not timed out and 25 s timed out for the three deletes, 4.999 s and 5 s for the rest", async (operation, _class, call) => {
    await expectTimeoutAt(hanging(), call, LONG.has(operation) ? 25_000 : 5_000);
  });

  it("bounds the long deletes by timeoutMs too when only it is given (tests), and by deleteTimeoutMs when that is", async () => {
    const [, , deleteFleet] = EVERY_OPERATION.find(([operation]) => operation === "deleteFleet")!;
    const [, , deleteCollectorGroup] = EVERY_OPERATION.find(([operation]) => operation === "deleteCollectorGroup")!;
    const [, , getFleet] = EVERY_OPERATION.find(([operation]) => operation === "getFleet")!;
    await expectTimeoutAt(hanging({ timeoutMs: 50 }), deleteFleet, 50);
    await expectTimeoutAt(hanging({ timeoutMs: 50, deleteTimeoutMs: 80 }), deleteFleet, 80);
    await expectTimeoutAt(hanging({ timeoutMs: 50, deleteTimeoutMs: 80 }), deleteCollectorGroup, 80);
    await expectTimeoutAt(hanging({ timeoutMs: 50, deleteTimeoutMs: 80 }), getFleet, 50);
  });
});

const CAPS: Record<OpampServerReplyClass, number> = { S: 64 * KiB, M: MiB, U: 4 * MiB, L: 10 * MiB };

/** A client whose fetch answers `reply` to every request, recording each request's init. */
function answering(reply: (url: string, init: RequestInit) => Response | Promise<Response>, options: { maxReplyBytes?: Partial<Record<OpampServerReplyClass, number>> } = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const answered = createOpampServerClient({
    url: "http://opamp-server.invalid",
    secret: fake.secret,
    ...options,
    fetch: (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(reply(String(url), init ?? {}));
    },
  });
  return { client: answered, seen };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A 400 every operation documents, its envelope padded with spaces (JSON allows them) to exactly `bytes`. */
function invalidRequestOf(bytes: number): string {
  return JSON.stringify({ error: { code: "invalid_request", message: "m" } }).padEnd(bytes, " ");
}

describe("the classes' caps", () => {
  it("are 64 KiB, 1 MiB, 4 MiB, 10 MiB", () => {
    expect(OPAMP_SERVER_REPLY_CAPS).toEqual(CAPS);
  });

  it.each(EVERY_OPERATION)("%s reads a reply of exactly its class's (%s) cap", async (_operation, replyClass, call) => {
    const { client: capped } = answering(() => new Response(invalidRequestOf(CAPS[replyClass]), { status: 400 }));

    expect(await call(capped, randomIds())).toEqual({ kind: "invalid", code: "invalid_request" });
  });

  it.each(EVERY_OPERATION)("%s refuses a reply one byte over its class's (%s) cap: unavailable, oversized_reply", async (_operation, replyClass, call) => {
    const { client: capped } = answering(() => new Response(invalidRequestOf(CAPS[replyClass] + 1), { status: 400 }));

    expect(await call(capped, randomIds())).toEqual({ kind: "unavailable", reason: "oversized_reply" });
  });

  it.each(EVERY_OPERATION)("%s refuses a Content-Length over its class's (%s) cap before reading, though the body is small", async (_operation, replyClass, call) => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(invalidRequestOf(60)));
        controller.close();
      },
    });
    const { client: capped } = answering(
      () => new Response(stream, { status: 400, headers: { "content-length": String(CAPS[replyClass] + 1) } }),
    );

    expect(await call(capped, randomIds())).toEqual({ kind: "unavailable", reason: "oversized_reply" });
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it.each(EVERY_OPERATION)("%s counts a body past its class's (%s) cap whose Content-Length lies low, the rest never read", async (_operation, replyClass, call) => {
    const chunk = new Uint8Array(64 * KiB).fill(0x20);
    const chunks = Math.ceil(CAPS[replyClass] / chunk.byteLength) + 10;
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === chunks) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client: capped } = answering(() => new Response(stream, { status: 400, headers: { "content-length": "60" } }));

    expect(await call(capped, randomIds())).toEqual({ kind: "unavailable", reason: "oversized_reply" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(chunks);
  });

  it("reads a documented reply padded to exactly its cap, and refuses it one byte longer, in each class", async () => {
    const ids = await aWorld();
    const real = {
      S: await client.getFleet(ids.org, ids.fleet),
      M: await client.getCollectorInstance(ids.org, ids.fleet, ids.collector),
      U: await client.getConfigurationUsage(ids.org, ids.configuration),
      L: await client.listCollectorInstances(ids.org, ids.fleet),
    };
    const bodies = {
      S: real.S.kind === "found" ? real.S.fleet : undefined,
      M: real.M.kind === "found" ? real.M.collector : undefined,
      U: real.U.kind === "found" ? real.U.usage : undefined,
      L: real.L.kind === "page" ? real.L.page : undefined,
    };
    const calls: Record<OpampServerReplyClass, Call> = {
      S: (c, i) => c.getFleet(i.org, i.fleet),
      M: (c, i) => c.getCollectorInstance(i.org, i.fleet, i.collector),
      U: (c, i) => c.getConfigurationUsage(i.org, i.configuration),
      L: (c, i) => c.listCollectorInstances(i.org, i.fleet),
    };

    for (const replyClass of ["S", "M", "U", "L"] as const) {
      const text = JSON.stringify(bodies[replyClass]);
      expect(bodies[replyClass]).toBeDefined();
      const exact = answering(() => new Response(text.padEnd(CAPS[replyClass], " "), { status: 200 })).client;
      const over = answering(() => new Response(text.padEnd(CAPS[replyClass] + 1, " "), { status: 200 })).client;

      expect(await calls[replyClass](exact, ids)).toEqual(real[replyClass]);
      expect(await calls[replyClass](over, ids)).toEqual({ kind: "unavailable", reason: "oversized_reply" });
    }
  });

  it("takes a test's smaller cap for a class, and only for that class", async () => {
    const { client: capped } = answering(() => new Response(invalidRequestOf(2 * KiB), { status: 400 }), { maxReplyBytes: { U: KiB } });
    const ids = randomIds();

    expect(await capped.getConfigurationUsage(ids.org, ids.configuration)).toEqual({ kind: "unavailable", reason: "oversized_reply" });
    expect(await capped.listCollectorGroups(ids.org, ids.fleet)).toEqual({ kind: "unavailable", reason: "oversized_reply" });
    expect(await capped.getFleet(ids.org, ids.fleet)).toMatchObject({ kind: "invalid" });
  });
});

/** An organization with a fleet, a second group, a collector, an error, a publication, a variable and a variable group. */
async function aWorld(): Promise<Ids> {
  const org = randomUUID();
  await client.createOrganization({ id: org, name: "Acme" });
  const fleet = randomUUID();
  const created = await client.createFleet(org, { id: fleet, label: "edge", type: "server", rotateExpiresAt: null, actor: ACTOR });
  if (created.kind !== "created") throw new Error(created.kind);
  const group = await client.createCollectorGroup(org, fleet, { name: "gateways" });
  if (group.kind !== "created") throw new Error(group.kind);
  const collector = fake.enrollCollector(org, fleet, { groupId: group.group.id, name: `edge-${randomUUID()}` });
  fake.recordCollectorError(org, collector.id, { message: "bad config" });
  const configuration = randomUUID();
  const publication = randomUUID();
  await client.postPublication(org, publication, aPublicationRequest(configuration));
  const variable = await client.createVariable(org, { id: randomUUID(), name: "OTLP_ENDPOINT", value: "eu:4317", description: null, actor: ACTOR });
  if (variable.kind !== "created") throw new Error(variable.kind);
  const variableGroup = await client.createVariableGroup(org, { id: randomUUID(), name: "eu-edge", description: null, actor: ACTOR });
  if (variableGroup.kind !== "created") throw new Error(variableGroup.kind);
  return {
    org,
    fleet,
    group: group.group.id,
    token: created.tokens.rotate.id,
    collector: collector.id,
    configuration,
    publication,
    variable: variable.variable.id,
    variableGroup: variableGroup.variableGroup.id,
  };
}

describe("the transport, for the fleet model's operations", () => {
  it("times out after 5000 ms over a body that is slow to arrive (one timer over the request and the read)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client: slow } = answering(
      (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"collectors":['));
              init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            },
          }),
          { status: 200 },
        ),
    );
    let settled: unknown;
    const ids = randomIds();
    const pending = slow.listCollectorInstances(ids.org, ids.fleet).then((result) => {
      settled = result;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(settled).toEqual({ kind: "unavailable", reason: "timeout" });
  });

  it.each(FLEET_OPERATIONS)("%s doesn't follow a redirect: the 302 is undocumented, and thrown", async (operation, _class, call) => {
    const { client: redirecting, seen } = answering(() => new Response(null, { status: 302, headers: { location: "http://elsewhere.invalid/" } }));

    await expect(call(redirecting, randomIds())).rejects.toThrow(`The opamp-server answered ${operation} with 302, which the API doesn't document.`);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.init.redirect).toBe("manual");
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe(`Bearer ${fake.secret}`);
  });

  it.each(FLEET_OPERATIONS)("%s is unavailable when the server answers 500, gets no answer in time, or the connection is reset", async (_operation, _class, call) => {
    const ids = await aWorld();
    const impatient = createOpampServerClient({ url: fake.url, secret: fake.secret, timeoutMs: 50 });

    fake.nextFault("error_500");
    expect(await call(client, ids)).toEqual({ kind: "unavailable", reason: "server_error", status: 500 });
    fake.nextFault("hang");
    expect(await call(impatient, ids)).toEqual({ kind: "unavailable", reason: "timeout" });
    fake.nextFault("reset");
    expect(await call(client, ids)).toEqual({ kind: "unavailable", reason: "network" });
  });
});

describe("answers no caller can handle, for the fleet model's operations", () => {
  it.each(FLEET_OPERATIONS)("%s throws for a 401: the secret is wrong", async (operation, _class, call) => {
    const wrongSecret = `a-wrong-but-long-enough-secret-${randomUUID()}`;
    const wrong = createOpampServerClient({ url: fake.url, secret: wrongSecret });

    const error = await call(wrong, await aWorld()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpampServerMisconfigurationError);
    expect((error as Error).message).toBe(
      `The opamp-server answered ${operation} with 401: it doesn't accept TELFLO_OPAMP_MANAGEMENT_SECRET.`,
    );
  });

  it.each(FLEET_OPERATIONS)("%s throws for a reply that breaks the contract", async (_operation, _class, call) => {
    const ids = await aWorld();
    fake.nextFault("malformed_reply");

    await expect(call(client, ids)).rejects.toBeInstanceOf(OpampServerMisconfigurationError);
    expect(fake.takeViolations()).toHaveLength(1);
  });

  it.each(FLEET_OPERATIONS)("%s throws for a status it doesn't document", async (operation, _class, call) => {
    const { client: teapot } = answering(() => json(418, { error: { code: "invalid_request", message: "I'm a teapot." } }));

    await expect(call(teapot, randomIds())).rejects.toThrow(`The opamp-server answered ${operation} with 418, which the API doesn't document.`);
  });

  it.each(FLEET_OPERATIONS)("%s throws for a 404 whose code it doesn't document there", async (operation, _class, call) => {
    const { client: wrongCode } = answering(() => json(404, { error: { code: "not_found", message: "Not found." } }));

    await expect(call(wrongCode, randomIds())).rejects.toThrow(
      `The opamp-server answered ${operation} with 404 not_found, which the API doesn't document.`,
    );
  });

  it.each(FLEET_OPERATIONS)("%s throws for a reply that isn't JSON", async (operation, _class, call) => {
    const { client: html } = answering(() => new Response("<html>receivers:</html>", { status: 400 }));

    await expect(call(html, randomIds())).rejects.toThrow(`The opamp-server's reply to ${operation} (400) wasn't JSON.`);
  });

  it.each([
    ["getFleet", 404, "collector_group_not_found", (c: OpampServerClient, i: Ids) => c.getFleet(i.org, i.fleet)],
    ["updateFleet", 409, "fleet_conflict", (c: OpampServerClient, i: Ids) => c.updateFleet(i.org, i.fleet, { label: "x" })],
    ["createFleet", 409, "fleet_archived", (c: OpampServerClient, i: Ids) => c.createFleet(i.org, { label: "x", type: "server", rotateExpiresAt: null, actor: null })],
    ["deleteCollectorGroup", 409, "collector_group_name_taken", (c: OpampServerClient, i: Ids) => c.deleteCollectorGroup(i.org, i.fleet, i.group)],
    ["createCollectorGroup", 422, "collector_not_found", (c: OpampServerClient, i: Ids) => c.createCollectorGroup(i.org, i.fleet, { name: "x" })],
    ["revealEnrollmentToken", 409, "fleet_archived", (c: OpampServerClient, i: Ids) => c.revealEnrollmentToken(i.org, i.fleet, i.token, null)],
    ["issueDefaultEnrollmentToken", 409, "enrollment_token_revoked", (c: OpampServerClient, i: Ids) => c.issueDefaultEnrollmentToken(i.org, i.fleet, null)],
    ["issueDefaultEnrollmentToken", 404, "enrollment_token_not_found", (c: OpampServerClient, i: Ids) => c.issueDefaultEnrollmentToken(i.org, i.fleet, null)],
    ["revokeEnrollmentToken", 404, "collector_not_found", (c: OpampServerClient, i: Ids) => c.revokeEnrollmentToken(i.org, i.fleet, i.token, null)],
    ["getCollectorInstance", 404, "collector_group_not_found", (c: OpampServerClient, i: Ids) => c.getCollectorInstance(i.org, i.fleet, i.collector)],
    ["listFleets", 404, "fleet_not_found", (c: OpampServerClient, i: Ids) => c.listFleets(i.org)],
    ["getConfigurationUsage", 404, "fleet_not_found", (c: OpampServerClient, i: Ids) => c.getConfigurationUsage(i.org, i.configuration)],
    ["pinCollectorInstances", 422, "invalid_request", (c: OpampServerClient, i: Ids) => c.pinCollectorInstances(i.org, i.fleet, { collectorIds: [i.collector], pin: null })],
    ["updateCollectorGroup", 422, "variable_in_use", (c: OpampServerClient, i: Ids) => c.updateCollectorGroup(i.org, i.fleet, i.group, { variableGroupId: i.variableGroup })],
    ["listVariables", 404, "variable_not_found", (c: OpampServerClient, i: Ids) => c.listVariables(i.org)],
    ["createVariable", 409, "variable_group_name_taken", (c: OpampServerClient, i: Ids) => c.createVariable(i.org, { id: i.variable, name: "A", value: "", description: null, actor: null })],
    ["updateVariable", 409, "variable_group_in_use", (c: OpampServerClient, i: Ids) => c.updateVariable(i.org, i.variable, { value: "", actor: null })],
    ["deleteVariable", 404, "variable_group_not_found", (c: OpampServerClient, i: Ids) => c.deleteVariable(i.org, i.variable)],
    ["createVariableGroup", 409, "variable_name_taken", (c: OpampServerClient, i: Ids) => c.createVariableGroup(i.org, { id: i.variableGroup, name: "a", description: null, actor: null })],
    ["getVariableGroup", 404, "variable_not_found", (c: OpampServerClient, i: Ids) => c.getVariableGroup(i.org, i.variableGroup)],
    ["updateVariableGroup", 409, "variable_name_taken", (c: OpampServerClient, i: Ids) => c.updateVariableGroup(i.org, i.variableGroup, { name: "a", actor: null })],
    ["deleteVariableGroup", 409, "variable_in_use", (c: OpampServerClient, i: Ids) => c.deleteVariableGroup(i.org, i.variableGroup)],
    ["setVariableGroupOverride", 404, "collector_not_found", (c: OpampServerClient, i: Ids) => c.setVariableGroupOverride(i.org, i.variableGroup, i.variable, { value: "", actor: null })],
    ["resetVariableGroupOverride", 404, "fleet_not_found", (c: OpampServerClient, i: Ids) => c.resetVariableGroupOverride(i.org, i.variableGroup, i.variable, null)],
  ] as const)("%s throws for a %s whose code (%s) it doesn't document there", async (operation, status, code, call) => {
    const { client: wrongCode } = answering(() => json(status, { error: { code, message: "m" } }));

    await expect(call(wrongCode, randomIds())).rejects.toThrow(
      `The opamp-server answered ${operation} with ${status} ${code}, which the API doesn't document.`,
    );
  });
});

/**
 * The operations whose 413 openapi.yaml documents (`payload_too_large`):
 * those that take a body. Written here, not read from the client; a test
 * below holds it equal to the file's.
 */
const DOCUMENTS_413 = new Set([
  "createOrganization",
  "renameOrganization",
  "postPublication",
  "setLimits",
  "createFleet",
  "updateFleet",
  "createCollectorGroup",
  "updateCollectorGroup",
  "rotateEnrollmentToken",
  "issueDefaultEnrollmentToken",
  "revealEnrollmentToken",
  "revokeEnrollmentToken",
  "pinCollectorInstances",
  "updateCollectorInstance",
  // The variables' writes, a reset's {actor} body among them.
  "createVariable",
  "updateVariable",
  "createVariableGroup",
  "updateVariableGroup",
  "setVariableGroupOverride",
  "resetVariableGroupOverride",
]);

/**
 * openapi.yaml's operations the platform never calls, so the client has no
 * method for them: 0.2.4's API keys, which take the management secret the
 * platform holds and hand out keys it doesn't use. Written here by name;
 * the checks over "every operation" run over the rest.
 */
const NOT_USED_BY_THE_PLATFORM = new Set(["createApiKey", "listApiKeys", "getApiKey", "updateApiKey", "revokeApiKey"]);

/** The operations the platform calls whose responses in openapi.yaml include `status`. */
function documentingStatus(status: string): string[] {
  const document = parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
  };
  return Object.values(document.paths)
    .flatMap((pathItem) => Object.values(pathItem))
    .filter((operation) => typeof operation === "object" && operation.operationId !== undefined && operation.responses?.[status] !== undefined)
    .map((operation) => operation.operationId as string)
    .filter((operationId) => !NOT_USED_BY_THE_PLATFORM.has(operationId))
    .sort();
}

// A 400 or a 413 is the request's refusal only with the code the operation
// documents for it; any other code, or a 413 an operation doesn't document,
// is thrown like any undocumented answer.
describe("a refusal's code", () => {
  it("names exactly openapi.yaml's operations that document a 413, and every operation documents a 400", () => {
    expect([...DOCUMENTS_413].sort()).toEqual(documentingStatus("413"));
    // The two health probes (getHealth, getReady) document no 400 and aren't the client's.
    expect(EVERY_OPERATION.map(([operation]) => operation).sort()).toEqual(documentingStatus("400"));
  });

  it("leaves out by name only operations openapi.yaml has, which the client has no method for", () => {
    const document = parseYaml(readFileSync(OPENAPI_PATH, "utf8")) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const operationIds = Object.values(document.paths).flatMap((pathItem) =>
      Object.values(pathItem).flatMap((operation) => (typeof operation === "object" && operation.operationId !== undefined ? [operation.operationId] : [])),
    );
    for (const operationId of NOT_USED_BY_THE_PLATFORM) {
      expect(operationIds).toContain(operationId);
      expect(Object.keys(client)).not.toContain(operationId);
    }
    // Every other operation but the health probes is the client's.
    expect(EVERY_OPERATION.map(([operation]) => operation).sort()).toEqual(
      operationIds.filter((operationId) => !NOT_USED_BY_THE_PLATFORM.has(operationId) && operationId !== "getHealth" && operationId !== "getReady").sort(),
    );
  });

  it.each(EVERY_OPERATION)("%s answers a 400 invalid_request invalid, and throws for a 400 with another code", async (operation, _class, call) => {
    const { client: refusing } = answering(() => json(400, { error: { code: "invalid_request", message: "m" } }));
    expect(await call(refusing, randomIds())).toEqual({ kind: "invalid", code: "invalid_request" });

    for (const code of ["payload_too_large", "not_found", "sha256_mismatch"]) {
      const { client: wrongCode } = answering(() => json(400, { error: { code, message: "m" } }));
      await expect(call(wrongCode, randomIds())).rejects.toThrow(
        new OpampServerMisconfigurationError(`The opamp-server answered ${operation} with 400 ${code}, which the API doesn't document.`),
      );
    }
  });

  it.each(EVERY_OPERATION.filter(([operation]) => DOCUMENTS_413.has(operation)))(
    "%s answers a 413 payload_too_large invalid, and throws for a 413 with another code",
    async (operation, _class, call) => {
      const { client: tooLarge } = answering(() => json(413, { error: { code: "payload_too_large", message: "m" } }));
      expect(await call(tooLarge, randomIds())).toEqual({ kind: "invalid", code: "payload_too_large" });

      for (const code of ["invalid_request", "internal_error"]) {
        const { client: wrongCode } = answering(() => json(413, { error: { code, message: "m" } }));
        await expect(call(wrongCode, randomIds())).rejects.toThrow(
          new OpampServerMisconfigurationError(`The opamp-server answered ${operation} with 413 ${code}, which the API doesn't document.`),
        );
      }
    },
  );

  it.each(EVERY_OPERATION.filter(([operation]) => !DOCUMENTS_413.has(operation)))(
    "%s throws for a 413, which it doesn't document, payload_too_large though its code is",
    async (operation, _class, call) => {
      const { client: tooLarge } = answering(() => json(413, { error: { code: "payload_too_large", message: "m" } }));

      await expect(call(tooLarge, randomIds())).rejects.toThrow(
        new OpampServerMisconfigurationError(`The opamp-server answered ${operation} with 413, which the API doesn't document.`),
      );
    },
  );

  it("throws for a 413 on deleteCollectorInstance, which takes no body", async () => {
    const { client: tooLarge } = answering(() => json(413, { error: { code: "payload_too_large", message: "m" } }));
    const ids = randomIds();

    await expect(tooLarge.deleteCollectorInstance(ids.org, ids.fleet, ids.collector)).rejects.toBeInstanceOf(OpampServerMisconfigurationError);
  });

  it("answers a publication's 422 sha256_mismatch invalid, and throws for a 422 with another code", async () => {
    const ids = randomIds();
    const { client: mismatched } = answering(() => json(422, { error: { code: "sha256_mismatch", message: "m" } }));
    expect(await mismatched.postPublication(ids.org, ids.publication, aPublicationRequest(ids.configuration))).toEqual({
      kind: "invalid",
      code: "sha256_mismatch",
    });

    const { client: wrongCode } = answering(() => json(422, { error: { code: "invalid_request", message: "m" } }));
    await expect(wrongCode.postPublication(ids.org, ids.publication, aPublicationRequest(ids.configuration))).rejects.toThrow(
      "The opamp-server answered postPublication with 422 invalid_request, which the API doesn't document.",
    );
  });
});

// A create's 200 is a retry's answer, which only a create that sent its id
// can get; the server made the id of one that sent none.
describe("a fleet's create answered 200", () => {
  const fleetOf = (organizationId: string, id: string) => ({
    id,
    organizationId,
    label: "edge-prod",
    type: "server",
    status: "active",
    createdBy: null,
    createdAt: "2026-10-13T09:00:00.000Z",
    updatedAt: "2026-10-13T09:00:00.000Z",
  });

  it("is unchanged when the create sent its id", async () => {
    const ids = randomIds();
    const { client: retried } = answering(() => json(200, { fleet: fleetOf(ids.org, ids.fleet) }));

    expect(
      await retried.createFleet(ids.org, { id: ids.fleet, label: "edge-prod", type: "server", rotateExpiresAt: null, actor: null }),
    ).toEqual({ kind: "unchanged", fleet: fleetOf(ids.org, ids.fleet) });
  });

  it("throws when the create sent no id, whatever fleet it names", async () => {
    const ids = randomIds();
    const { client: retried } = answering(() => json(200, { fleet: fleetOf(ids.org, ids.fleet) }));

    await expect(retried.createFleet(ids.org, { label: "edge-prod", type: "server", rotateExpiresAt: null, actor: null })).rejects.toThrow(
      new OpampServerMisconfigurationError("The opamp-server answered createFleet with 200, which the API doesn't document."),
    );
  });
});

describe("the ids a reply echoes", () => {
  const MISMATCH = /named other ids than the ones asked for\.$/;

  /** A real reply of each kind the checks read, from the fake, with the ids it names. */
  async function realReplies() {
    const ids = await aWorld();
    const replies = {
      created: await client.createFleet(ids.org, { id: randomUUID(), label: `edge-${randomUUID()}`, type: "server", rotateExpiresAt: null, actor: null }),
      fleet: await client.getFleet(ids.org, ids.fleet),
      fleets: await client.listFleets(ids.org),
      groups: await client.listCollectorGroups(ids.org, ids.fleet),
      group: await client.getCollectorGroup(ids.org, ids.fleet, ids.group),
      tokens: await client.listEnrollmentTokens(ids.org, ids.fleet),
      revealed: await client.revealEnrollmentToken(ids.org, ids.fleet, ids.token, null),
      revoked: await client.revokeEnrollmentToken(ids.org, ids.fleet, ids.token, null),
      collectors: await client.listCollectorInstances(ids.org, ids.fleet),
      collector: await client.getCollectorInstance(ids.org, ids.fleet, ids.collector),
      usage: await client.getConfigurationUsage(ids.org, ids.configuration),
      variableGroupDetail: await client.getVariableGroup(ids.org, ids.variableGroup),
      variables: await client.listVariables(ids.org),
      override: await client.setVariableGroupOverride(ids.org, ids.variableGroup, ids.variable, { value: "eu-1", actor: null }),
    };
    return { ids, replies };
  }

  it("throws, naming the operation and status only, for each id that isn't the one asked for", async () => {
    const { ids, replies } = await realReplies();
    const other = randomUUID();
    const { created, fleet, fleets, groups, group, tokens, revealed, revoked, collectors, collector, usage, variableGroupDetail, variables, override } = replies;
    if (
      created.kind !== "created" ||
      fleet.kind !== "found" ||
      fleets.kind !== "page" ||
      groups.kind !== "listed" ||
      group.kind !== "found" ||
      tokens.kind !== "listed" ||
      revealed.kind !== "revealed" ||
      revoked.kind !== "revoked" ||
      collectors.kind !== "page" ||
      collector.kind !== "found" ||
      usage.kind !== "found" ||
      variableGroupDetail.kind !== "found" ||
      variables.kind !== "listed" ||
      override.kind !== "set"
    ) {
      throw new Error("expected every read to succeed");
    }
    const variable = variables.variables[0];
    if (variable === undefined) throw new Error("expected a variable");
    const { variableGroup } = variableGroupDetail;
    const createdBody = { fleet: created.fleet, defaultGroup: created.defaultGroup, tokens: created.tokens };
    const cases: [string, number, unknown, Call][] = [
      ["createFleet: another organization's", 201, { ...createdBody, fleet: { ...created.fleet, organizationId: other } }, (c, i) => c.createFleet(i.org, { id: created.fleet.id, label: created.fleet.label, type: "server", rotateExpiresAt: null, actor: null })],
      ["createFleet: another id than sent", 201, createdBody, (c, i) => c.createFleet(i.org, { id: other, label: created.fleet.label, type: "server", rotateExpiresAt: null, actor: null })],
      ["createFleet: a Default group of another fleet", 201, { ...createdBody, defaultGroup: { ...created.defaultGroup, fleetId: other } }, (c, i) => c.createFleet(i.org, { id: created.fleet.id, label: created.fleet.label, type: "server", rotateExpiresAt: null, actor: null })],
      ["createFleet (unchanged): another organization's", 200, { fleet: { ...created.fleet, organizationId: other } }, (c, i) => c.createFleet(i.org, { id: created.fleet.id, label: created.fleet.label, type: "server", rotateExpiresAt: null, actor: null })],
      ["createFleet (unchanged): another id than sent", 200, { fleet: created.fleet }, (c, i) => c.createFleet(i.org, { id: other, label: created.fleet.label, type: "server", rotateExpiresAt: null, actor: null })],
      ["listFleets: another organization's fleet", 200, { ...fleets.page, fleets: fleets.page.fleets.map((f) => ({ ...f, organizationId: other })) }, (c, i) => c.listFleets(i.org)],
      ["getFleet: another organization's", 200, { ...fleet.fleet, organizationId: other }, (c, i) => c.getFleet(i.org, i.fleet)],
      ["getFleet: another fleet", 200, fleet.fleet, (c, i) => c.getFleet(i.org, other)],
      ["updateFleet: another organization's", 200, { ...created.fleet, organizationId: other }, (c, i) => c.updateFleet(i.org, created.fleet.id, { label: "x" })],
      ["updateFleet: another fleet", 200, created.fleet, (c, i) => c.updateFleet(i.org, other, { label: "x" })],
      ["listCollectorGroups: another fleet's group", 200, { groups: groups.groups.map((g) => ({ ...g, fleetId: other })) }, (c, i) => c.listCollectorGroups(i.org, i.fleet)],
      ["createCollectorGroup: another fleet's", 201, { ...group.group, fleetId: other }, (c, i) => c.createCollectorGroup(i.org, i.fleet, { name: "x" })],
      ["getCollectorGroup: another fleet's", 200, { ...group.group, fleetId: other }, (c, i) => c.getCollectorGroup(i.org, i.fleet, i.group)],
      ["getCollectorGroup: another group", 200, group.group, (c, i) => c.getCollectorGroup(i.org, i.fleet, other)],
      ["updateCollectorGroup: another fleet's", 200, { ...group.group, fleetId: other }, (c, i) => c.updateCollectorGroup(i.org, i.fleet, i.group, { name: "x" })],
      ["updateCollectorGroup: another group", 200, group.group, (c, i) => c.updateCollectorGroup(i.org, i.fleet, other, { name: "x" })],
      ["listEnrollmentTokens: another fleet's token", 200, { tokens: tokens.tokens.map((t) => ({ ...t, fleetId: other })) }, (c, i) => c.listEnrollmentTokens(i.org, i.fleet)],
      ["revealEnrollmentToken: another token", 200, revealed.token, (c, i) => c.revealEnrollmentToken(i.org, i.fleet, other, null)],
      ["revokeEnrollmentToken: another fleet's", 200, { ...revoked.token, fleetId: other }, (c, i) => c.revokeEnrollmentToken(i.org, i.fleet, i.token, null)],
      ["revokeEnrollmentToken: another token", 200, revoked.token, (c, i) => c.revokeEnrollmentToken(i.org, i.fleet, other, null)],
      ["listCollectorInstances: another fleet's collector", 200, { ...collectors.page, collectors: collectors.page.collectors.map((x) => ({ ...x, fleetId: other })) }, (c, i) => c.listCollectorInstances(i.org, i.fleet)],
      ["pinCollectorInstances: an id not sent, updated", 200, { updated: [other], notFound: [] }, (c, i) => c.pinCollectorInstances(i.org, i.fleet, { collectorIds: [i.collector], pin: null })],
      ["pinCollectorInstances: an id not sent, not found", 200, { updated: [ids.collector], notFound: [other] }, (c, i) => c.pinCollectorInstances(i.org, i.fleet, { collectorIds: [i.collector], pin: null })],
      ["getCollectorInstance: another fleet's", 200, { ...collector.collector, fleetId: other }, (c, i) => c.getCollectorInstance(i.org, i.fleet, i.collector)],
      ["getCollectorInstance: another collector", 200, collector.collector, (c, i) => c.getCollectorInstance(i.org, i.fleet, other)],
      ["updateCollectorInstance: another fleet's", 200, { ...collector.collector, fleetId: other }, (c, i) => c.updateCollectorInstance(i.org, i.fleet, i.collector, { name: "x" })],
      ["updateCollectorInstance: another collector", 200, collector.collector, (c, i) => c.updateCollectorInstance(i.org, i.fleet, other, { name: "x" })],
      ["getConfigurationUsage: another configuration's", 200, usage.usage, (c, i) => c.getConfigurationUsage(i.org, other)],
      // A variable, a variable group or an override answered must be the one asked for.
      ["createVariable: another id than sent", 201, variable, (c, i) => c.createVariable(i.org, { id: other, name: variable.name, value: variable.value, description: null, actor: null })],
      ["createVariable (unchanged): another id than sent", 200, variable, (c, i) => c.createVariable(i.org, { id: other, name: variable.name, value: variable.value, description: null, actor: null })],
      ["updateVariable: another variable", 200, variable, (c, i) => c.updateVariable(i.org, other, { value: "x", actor: null })],
      ["createVariableGroup: another id than sent", 201, variableGroup, (c, i) => c.createVariableGroup(i.org, { id: other, name: variableGroup.name, description: null, actor: null })],
      ["getVariableGroup: another variable group", 200, { variableGroup, overrides: variableGroupDetail.overrides }, (c, i) => c.getVariableGroup(i.org, other)],
      ["updateVariableGroup: another variable group", 200, variableGroup, (c, i) => c.updateVariableGroup(i.org, other, { name: "x", actor: null })],
      ["setVariableGroupOverride: another variable's", 201, override.override, (c, i) => c.setVariableGroupOverride(i.org, i.variableGroup, other, { value: "x", actor: null })],
      ["setVariableGroupOverride (replaced): another variable's", 200, override.override, (c, i) => c.setVariableGroupOverride(i.org, i.variableGroup, other, { value: "x", actor: null })],
    ];

    for (const [label, status, body, call] of cases) {
      const { client: misrouted } = answering(() => json(status, body));
      const error = await call(misrouted, ids).catch((caught: unknown) => caught);

      expect(error, label).toBeInstanceOf(OpampServerMisconfigurationError);
      expect((error as Error).message, label).toMatch(MISMATCH);
      expect((error as Error).message, label).not.toContain(other);
    }
    expect(cases).toHaveLength(36);
  });

  it("takes the same ids answered in another case, and the unchecked replies as they are", async () => {
    const { ids, replies } = await realReplies();
    const { fleet, collector } = replies;
    if (fleet.kind !== "found" || collector.kind !== "found") throw new Error("expected found");
    const upper = (id: string) => id.toUpperCase();

    expect(
      await answering(() => json(200, { ...fleet.fleet, id: upper(fleet.fleet.id), organizationId: upper(ids.org) })).client.getFleet(ids.org, ids.fleet),
    ).toMatchObject({ kind: "found" });
    expect(
      await answering(() => json(200, { ...collector.collector, fleetId: upper(ids.fleet) })).client.getCollectorInstance(ids.org, ids.fleet, upper(ids.collector)),
    ).toMatchObject({ kind: "found" });
    expect(
      await answering(() => json(200, { updated: [upper(ids.collector)], notFound: [] })).client.pinCollectorInstances(ids.org, ids.fleet, {
        collectorIds: [ids.collector],
        pin: null,
      }),
    ).toEqual({ kind: "pinned", updated: [upper(ids.collector)], notFound: [] });
    // A rotation's reply names no fleet, and its token is new: nothing to check.
    expect(
      await answering(() =>
        json(201, { id: randomUUID(), bearer: "QUJD", expiresAt: null, predecessorId: null }),
      ).client.rotateEnrollmentToken(ids.org, ids.fleet, { expiresAt: null, graceEndsAt: "2099-01-01T00:00:00.000Z", actor: null }),
    ).toMatchObject({ kind: "rotated" });
  });

  // A new default token's reply names no fleet and a new id, but it must be
  // a default token: never expiring.
  it("takes a new default token's reply as it is, and throws for one that isn't a default token", async () => {
    const ids = randomIds();
    const token = { id: randomUUID(), kind: "default", bearer: "QUJD", expiresAt: null };
    const issue = (body: unknown) => answering(() => json(201, body)).client.issueDefaultEnrollmentToken(ids.org, ids.fleet, null);

    expect(await issue(token)).toEqual({ kind: "issued", token });
    for (const body of [
      { ...token, kind: "rotate" },
      { ...token, expiresAt: "2099-01-01T00:00:00.000Z" },
    ]) {
      await expect(issue(body)).rejects.toThrow(
        new OpampServerMisconfigurationError("The opamp-server's reply to issueDefaultEnrollmentToken (201) wasn't a default token."),
      );
    }
  });
});

// A fleet's summary carries its last seen and its rotate token's state,
// both required. A reply without either isn't the API's: the client throws,
// and the platform's route answers 503.
describe("a fleet's summary", () => {
  it.each(["lastSeenAt", "rotateToken"])("is refused without %s by getFleet and listFleets", async (field) => {
    const ids = await aWorld();
    const read = await client.getFleet(ids.org, ids.fleet);
    if (read.kind !== "found") throw new Error(read.kind);
    expect(read.fleet.summary).toMatchObject({
      lastSeenAt: expect.any(String),
      rotateToken: { expiresAt: null, graceEndsAt: null, validCount: 1 },
    });
    const { [field as "lastSeenAt"]: _dropped, ...summary } = read.fleet.summary;
    const broken = { ...read.fleet, summary };

    for (const call of [
      () => answering(() => json(200, broken)).client.getFleet(ids.org, ids.fleet),
      () => answering(() => json(200, { fleets: [broken], nextCursor: null })).client.listFleets(ids.org),
    ]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpampServerMisconfigurationError);
    }
    // With the field, as the fake answered it, both read.
    expect(await answering(() => json(200, read.fleet)).client.getFleet(ids.org, ids.fleet)).toMatchObject({ kind: "found" });
    expect(await answering(() => json(200, { fleets: [read.fleet], nextCursor: null })).client.listFleets(ids.org)).toMatchObject({
      kind: "page",
    });
  });
});

describe("what an error carries", () => {
  it("never a query's text, a cursor, a bearer, a YAML, an attribute, an error text, a URL or the secret, whatever fails", async () => {
    const q = `q-canary-${randomUUID()}`;
    const cursor = `cursor-canary-${randomUUID()}`;
    const bearer = `QmVhcmVyQ2FuYXJ5${randomUUID().replaceAll("-", "")}`;
    const yaml = `receivers: # yaml-canary-${randomUUID()}\n`;
    const attributeKey = `attribute-key-canary-${randomUUID()}`;
    const attributeValue = `attribute-value-canary-${randomUUID()}`;
    const errorText = `error-text-canary-${randomUUID()}`;
    const secret = `secret-canary-${randomUUID()}`;
    const canaries = [q, cursor, bearer, yaml.trim(), attributeKey, attributeValue, errorText, secret];

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

    const ids = await aWorld();
    const query = { q, cursor, sort: "name" as const };
    const collectorRead = await client.getCollectorInstance(ids.org, ids.fleet, ids.collector);
    const publicationRead = await client.getPublication(ids.org, ids.publication);
    if (collectorRead.kind !== "found" || publicationRead.kind !== "found") throw new Error("expected found");
    const plantedCollector = {
      ...collectorRead.collector,
      reported: { collectorVersion: null, ip: null, hostIp: null, attributes: { [attributeKey]: attributeValue, broken: 1 } },
      effective: { sha256: "a".repeat(64), status: "failed", error: errorText, at: "2026-10-13T09:00:00.000Z" },
    };
    const outcomes: unknown[] = [];
    const attempt = async (call: () => Promise<unknown>) => outcomes.push(await call().catch((error: unknown) => error));
    const replying = (reply: () => Response) => answering(reply).client;

    // Each failure kind, with the canaries in the request, the reply, or both.
    await attempt(() => createOpampServerClient({ url: fake.url, secret }).listCollectorInstances(ids.org, ids.fleet, query));
    fake.nextFault("malformed_reply");
    await attempt(() => client.listCollectorInstances(ids.org, ids.fleet, query));
    fake.nextFault("error_500");
    await attempt(() => client.listCollectorInstances(ids.org, ids.fleet, query));
    fake.nextFault("hang");
    await attempt(() => createOpampServerClient({ url: fake.url, secret: fake.secret, timeoutMs: 50 }).listCollectorInstances(ids.org, ids.fleet, query));
    fake.nextFault("reset");
    await attempt(() => client.listCollectorInstances(ids.org, ids.fleet, query));
    await attempt(() => client.listCollectorInstances(ids.org, ids.fleet, query)); // the cursor refused: invalid
    await attempt(() =>
      createOpampServerClient({
        url: "http://opamp-server.invalid",
        secret,
        fetch: (url) => Promise.reject(new TypeError(`fetch failed: ${String(url)} ${secret}`)),
      }).listCollectorInstances(ids.org, ids.fleet, query),
    );
    await attempt(() => replying(() => new Response(`<html>${q} ${bearer} ${yaml}</html>`, { status: 200 })).listCollectorInstances(ids.org, ids.fleet, query));
    await attempt(() => replying(() => json(418, { error: { code: "invalid_request", message: `${q} ${yaml}` } })).listCollectorInstances(ids.org, ids.fleet, query));
    await attempt(() => replying(() => json(404, { error: { code: "not_found", message: `${q} ${bearer}` } })).listCollectorInstances(ids.org, ids.fleet, query));
    await attempt(() => replying(() => json(200, { collectors: [plantedCollector], nextCursor: cursor })).listCollectorInstances(ids.org, ids.fleet, query));
    await attempt(() => replying(() => json(200, plantedCollector)).getCollectorInstance(ids.org, ids.fleet, ids.collector));
    await attempt(() => replying(() => json(200, { ...plantedCollector, reported: collectorRead.collector.reported })).getCollectorInstance(ids.org, ids.fleet, randomUUID()));
    await attempt(() => replying(() => json(200, { id: ids.token, kind: "rotate", bearer: `${bearer}!`, expiresAt: null })).revealEnrollmentToken(ids.org, ids.fleet, ids.token, null));
    await attempt(() => replying(() => json(200, { id: randomUUID(), kind: "rotate", bearer, expiresAt: null })).revealEnrollmentToken(ids.org, ids.fleet, ids.token, null));
    await attempt(() => replying(() => json(201, { id: randomUUID(), bearer, expiresAt: "soon", predecessorId: null })).rotateEnrollmentToken(ids.org, ids.fleet, { expiresAt: null, graceEndsAt: "2099-01-01T00:00:00.000Z", actor: null }));
    await attempt(() => replying(() => json(201, { id: randomUUID(), kind: "rotate", bearer, expiresAt: null })).issueDefaultEnrollmentToken(ids.org, ids.fleet, null));
    await attempt(() => replying(() => json(200, { ...publicationRead.publication, yaml, id: randomUUID() })).getPublication(ids.org, ids.publication));
    await attempt(() => replying(() => json(200, { ...publicationRead.publication, yaml, sha256: "not-a-hash" })).getPublication(ids.org, ids.publication));
    // About 1.05M characters: under the L cap (10 MiB), so it reaches the yaml's maximum length (1,048,576 code points).
    await attempt(() => replying(() => json(200, { ...publicationRead.publication, yaml: yaml.repeat(17_000) })).getPublication(ids.org, ids.publication));
    vi.restoreAllMocks();
    fake.takeViolations(); // the malformed reply's

    expect(outcomes).toHaveLength(20);
    expect(outcomes.filter((outcome) => outcome instanceof OpampServerMisconfigurationError)).toHaveLength(15);
    // The over-long yaml reached its maximum length's check, not the reply's size cap.
    expect(outcomes.at(-1)).toBeInstanceOf(OpampServerMisconfigurationError);
    const seen = [
      ...outcomes.map((outcome) => (outcome instanceof Error ? `${outcome.message}\n${outcome.stack}\n${String(outcome.cause)}` : JSON.stringify(outcome))),
      ...output,
    ].join("\n");
    for (const canary of canaries) expect(seen).not.toContain(canary);
    expect(seen).not.toContain(fake.secret);
    expect(seen).not.toContain("Bearer");
    expect(seen).not.toContain(fake.url);
    expect(seen).not.toContain("opamp-server.invalid");
    expect(seen).not.toContain("/api/v1");
    expect(seen).not.toContain(ids.fleet);
    // The fields at fault are named, an attribute's key replaced.
    expect(seen).toContain("didn't match its schema at: collectors.0.reported.attributes.*");
    expect(seen).toContain("didn't match its schema at: bearer.");
  });
});
