import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpampServer, type FakeOpampServer } from "../testing/fake-opamp-server.js";
import {
  createOpampServerClient,
  OPAMP_SERVER_REPLY_CAPS,
  OpampServerMisconfigurationError,
  type OpampServerClient,
  type OpampServerReplyClass,
} from "./client.js";

// The opamp-server client's organization variables: each of the 11 operations'
// results against the fake, the bindings on a group, a collector and the bulk
// pin with their 422s' details, each new operation's worst reply under its
// class's cap, and what an error may carry (never a value, a name or a
// description).

let fake: FakeOpampServer;
let client: OpampServerClient;

beforeAll(async () => {
  fake = await startFakeOpampServer();
  client = createOpampServerClient({ url: fake.url, secret: fake.secret });
});

afterEach(() => {
  expect(fake.takeViolations()).toEqual([]);
});

afterAll(async () => {
  await fake.close();
});

const ACTOR = { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", email: "sam@acme.io" };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function anOrganization(): Promise<string> {
  const id = randomUUID();
  expect(await client.createOrganization({ id, name: "Acme" })).toEqual({ kind: "created", organizationId: id });
  return id;
}

async function aPublication(organizationId: string, yaml: string): Promise<string> {
  const id = randomUUID();
  const put = await client.postPublication(organizationId, id, {
    configuration: { id: randomUUID(), name: "edge-config" },
    version: { id: randomUUID(), number: 1, label: null },
    yaml,
    sha256: sha256(yaml),
    publishedBy: null,
    publishedAt: "2026-10-20T09:00:00.000Z",
    collector: { distribution: "otelcol-contrib", version: "0.162.0" },
  });
  expect(put.kind).toBe("created");
  return id;
}

async function aVariable(organizationId: string, name: string, value = "v") {
  const created = await client.createVariable(organizationId, { id: randomUUID(), name, value, description: null, actor: ACTOR });
  if (created.kind !== "created") throw new Error(created.kind);
  return created.variable;
}

async function aVariableGroup(organizationId: string, name = `vg-${randomUUID()}`) {
  const created = await client.createVariableGroup(organizationId, { id: randomUUID(), name, description: null, actor: ACTOR });
  if (created.kind !== "created") throw new Error(created.kind);
  return created.variableGroup;
}

async function aFleet(organizationId: string) {
  const created = await client.createFleet(organizationId, {
    id: randomUUID(),
    label: `edge-${randomUUID()}`,
    type: "server",
    rotateExpiresAt: null,
    actor: ACTOR,
  });
  if (created.kind !== "created") throw new Error(created.kind);
  return { fleetId: created.fleet.id, defaultGroupId: created.defaultGroup.id };
}

describe("a variable's results", () => {
  it("answers created, unchanged for a retry, and each 409 by its code", async () => {
    const organizationId = await anOrganization();
    const id = randomUUID();
    const request = { id, name: "OTLP_ENDPOINT", value: "eu:4317", description: "Where to send.", actor: ACTOR };

    const created = await client.createVariable(organizationId, request);
    expect(created).toEqual({
      kind: "created",
      variable: { id, name: "OTLP_ENDPOINT", value: "eu:4317", description: "Where to send.", changedBy: ACTOR, changedAt: expect.any(String) },
    });
    expect(await client.createVariable(organizationId, request)).toEqual({ ...created, kind: "unchanged" });
    expect(await client.createVariable(organizationId, { ...request, value: "us:4317" })).toEqual({ kind: "variable_conflict" });
    expect(await client.createVariable(organizationId, { ...request, id: randomUUID() })).toEqual({ kind: "variable_name_taken" });
    expect(await client.createVariable(randomUUID(), request)).toEqual({ kind: "organization_not_found" });
  });

  it("answers variable_limit_reached at 150", async () => {
    const organizationId = await anOrganization();
    for (let n = 0; n < 150; n++) await aVariable(organizationId, `V_${n}`);

    expect(await client.createVariable(organizationId, { id: randomUUID(), name: "ONE_MORE", value: "", description: null, actor: null })).toEqual({
      kind: "variable_limit_reached",
    });
    const listed = await client.listVariables(organizationId);
    expect(listed.kind === "listed" && listed.variables.length).toBe(150);
  });

  it("lists, updates and deletes, each refusal by its code", async () => {
    const organizationId = await anOrganization();
    const variable = await aVariable(organizationId, "REGION", "eu");
    await aVariable(organizationId, "TAKEN");

    expect(await client.listVariables(organizationId)).toEqual({ kind: "listed", variables: [variable, expect.objectContaining({ name: "TAKEN" })] });
    expect(await client.listVariables(randomUUID())).toEqual({ kind: "organization_not_found" });
    const updated = await client.updateVariable(organizationId, variable.id, { value: "us", description: null, actor: null });
    expect(updated).toEqual({ kind: "updated", variable: { ...variable, value: "us", changedBy: null, changedAt: expect.any(String) } });
    expect(await client.updateVariable(organizationId, variable.id, { name: "TAKEN", actor: null })).toEqual({ kind: "variable_name_taken" });
    expect(await client.updateVariable(organizationId, randomUUID(), { value: "x", actor: null })).toEqual({ kind: "variable_not_found" });
    expect(await client.deleteVariable(organizationId, variable.id)).toEqual({ kind: "deleted" });
    expect(await client.deleteVariable(organizationId, variable.id)).toEqual({ kind: "variable_not_found" });
    expect(await client.deleteVariable(randomUUID(), variable.id)).toEqual({ kind: "organization_not_found" });
  });

  it("answers variable_in_use with its details, on a rename and a delete", async () => {
    const organizationId = await anOrganization();
    const variable = await aVariable(organizationId, "REGION");
    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    const publicationId = await aPublication(organizationId, "region: ${org:REGION}\n");
    expect((await client.updateCollectorGroup(organizationId, fleetId, defaultGroupId, { assignedPublicationId: publicationId })).kind).toBe("updated");
    const expected = {
      kind: "variable_in_use",
      details: {
        usedBy: [{ publicationId, groups: [{ fleetId, groupId: defaultGroupId }], pinnedCollectors: 0 }],
        totalPublications: 1,
        totalGroups: 1,
        totalPinnedCollectors: 0,
      },
    };

    expect(await client.deleteVariable(organizationId, variable.id)).toEqual(expected);
    expect(await client.updateVariable(organizationId, variable.id, { name: "ZONE", actor: null })).toEqual(expected);
    expect((await client.updateVariable(organizationId, variable.id, { value: "changed", actor: null })).kind).toBe("updated");
  });
});

describe("a variable group's results", () => {
  it("answers created, unchanged, its 409s, found with its overrides, updated and deleted", async () => {
    const organizationId = await anOrganization();
    const id = randomUUID();
    const request = { id, name: "eu-edge", description: null, actor: ACTOR };

    const created = await client.createVariableGroup(organizationId, request);
    expect(created).toEqual({
      kind: "created",
      variableGroup: {
        id,
        name: "eu-edge",
        description: null,
        overrideCount: 0,
        usage: { collectorGroups: 0, pinnedCollectors: 0 },
        changedBy: ACTOR,
        changedAt: expect.any(String),
      },
    });
    expect(await client.createVariableGroup(organizationId, request)).toEqual({ ...created, kind: "unchanged" });
    expect(await client.createVariableGroup(organizationId, { ...request, description: "other" })).toEqual({ kind: "variable_group_conflict" });
    expect(await client.createVariableGroup(organizationId, { ...request, id: randomUUID() })).toEqual({ kind: "variable_group_name_taken" });
    expect(await client.listVariableGroups(organizationId)).toEqual({
      kind: "listed",
      variableGroups: [created.kind === "created" ? created.variableGroup : undefined],
    });

    const variable = await aVariable(organizationId, "REGION");
    expect(await client.setVariableGroupOverride(organizationId, id, variable.id, { value: "eu-1", actor: null })).toMatchObject({ kind: "set" });
    const found = await client.getVariableGroup(organizationId, id);
    expect(found).toEqual({
      kind: "found",
      variableGroup: expect.objectContaining({ id, overrideCount: 1, changedBy: null }),
      overrides: [{ variableId: variable.id, value: "eu-1", changedBy: null, changedAt: expect.any(String) }],
    });
    expect(await client.getVariableGroup(organizationId, randomUUID())).toEqual({ kind: "variable_group_not_found" });

    await aVariableGroup(organizationId, "us-edge");
    expect(await client.updateVariableGroup(organizationId, id, { name: "us-edge", actor: null })).toEqual({ kind: "variable_group_name_taken" });
    expect(await client.updateVariableGroup(organizationId, id, { name: "eu-west", description: "Europe.", actor: ACTOR })).toMatchObject({
      kind: "updated",
      variableGroup: { name: "eu-west", description: "Europe.", changedBy: ACTOR },
    });
    expect(await client.updateVariableGroup(organizationId, randomUUID(), { name: "x", actor: null })).toEqual({ kind: "variable_group_not_found" });
    expect(await client.deleteVariableGroup(organizationId, id)).toEqual({ kind: "deleted" });
    expect(await client.deleteVariableGroup(organizationId, id)).toEqual({ kind: "variable_group_not_found" });
  });

  it("answers variable_group_limit_reached at 100, and variable_group_in_use with its details", async () => {
    const organizationId = await anOrganization();
    const used = await aVariableGroup(organizationId);
    for (let n = 1; n < 100; n++) await aVariableGroup(organizationId);
    expect(await client.createVariableGroup(organizationId, { id: randomUUID(), name: "one-more", description: null, actor: null })).toEqual({
      kind: "variable_group_limit_reached",
    });

    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    expect((await client.updateCollectorGroup(organizationId, fleetId, defaultGroupId, { variableGroupId: used.id })).kind).toBe("updated");
    expect(await client.deleteVariableGroup(organizationId, used.id)).toEqual({
      kind: "variable_group_in_use",
      details: { collectorGroups: [{ fleetId, groupId: defaultGroupId }], totalCollectorGroups: 1, pinnedCollectors: 0 },
    });
  });

  it("answers an override's PUT set whether new (201), the same value again or replaced (200), and its reset reset, the actor recorded", async () => {
    const organizationId = await anOrganization();
    const group = await aVariableGroup(organizationId);
    const variable = await aVariable(organizationId, "REGION");

    const created = await client.setVariableGroupOverride(organizationId, group.id, variable.id, { value: "eu-1", actor: ACTOR });
    expect(created).toEqual({ kind: "set", override: { variableId: variable.id, value: "eu-1", changedBy: ACTOR, changedAt: expect.any(String) } });
    expect(await client.setVariableGroupOverride(organizationId, group.id, variable.id, { value: "eu-1", actor: null })).toEqual(created);
    expect(await client.setVariableGroupOverride(organizationId, group.id, variable.id, { value: "eu-2", actor: null })).toMatchObject({
      kind: "set",
      override: { value: "eu-2", changedBy: null },
    });
    const other = { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", email: "ana@acme.io" };
    expect(await client.resetVariableGroupOverride(organizationId, group.id, variable.id, other)).toEqual({ kind: "reset" });
    expect(await client.resetVariableGroupOverride(organizationId, group.id, variable.id, null)).toEqual({ kind: "reset" });
    const found = await client.getVariableGroup(organizationId, group.id);
    expect(found).toMatchObject({ kind: "found", variableGroup: { overrideCount: 0, changedBy: other }, overrides: [] });
    expect((await client.setVariableGroupOverride(organizationId, group.id, variable.id, { value: "eu-3", actor: null })).kind).toBe("set");

    for (const [groupId, variableId, kind] of [
      [randomUUID(), randomUUID(), "variable_group_not_found"],
      [group.id, randomUUID(), "variable_not_found"],
    ] as const) {
      expect(await client.setVariableGroupOverride(organizationId, groupId, variableId, { value: "", actor: null })).toEqual({ kind });
      expect(await client.resetVariableGroupOverride(organizationId, groupId, variableId, null)).toEqual({ kind });
    }
    expect(await client.resetVariableGroupOverride(randomUUID(), group.id, variable.id, null)).toEqual({ kind: "organization_not_found" });
  });
});

describe("the bindings and their 422s", () => {
  it("binds a group's and a pin's variable group, and the bulk pin's alone", async () => {
    const organizationId = await anOrganization();
    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    const group = await aVariableGroup(organizationId);
    const collector = fake.enrollCollector(organizationId, fleetId);

    const created = await client.createCollectorGroup(organizationId, fleetId, { name: "edge", variableGroupId: group.id });
    expect(created).toMatchObject({ kind: "created", group: { variableGroupId: group.id } });
    expect(await client.updateCollectorGroup(organizationId, fleetId, defaultGroupId, { variableGroupId: group.id })).toMatchObject({
      kind: "updated",
      group: { variableGroupId: group.id },
    });
    expect(await client.updateCollectorInstance(organizationId, fleetId, collector.id, { pinnedVariableGroupId: group.id })).toMatchObject({
      kind: "updated",
      collector: { pinnedVariableGroupId: group.id, pin: null },
    });
    expect(await client.pinCollectorInstances(organizationId, fleetId, { collectorIds: [collector.id], pinnedVariableGroupId: null })).toEqual({
      kind: "pinned",
      updated: [collector.id],
      notFound: [],
    });
    expect(await client.getCollectorInstance(organizationId, fleetId, collector.id)).toMatchObject({ collector: { pinnedVariableGroupId: null } });
  });

  it("answers variable_group_not_found and variables_undefined (with the names) on each assignment and pin", async () => {
    const organizationId = await anOrganization();
    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    const collector = fake.enrollCollector(organizationId, fleetId);
    const publicationId = await aPublication(organizationId, "a: ${org:ZONE}\nb: ${org:API_KEY_HEADER}\n");
    const missing = randomUUID();
    const pin = { kind: "publication", id: publicationId } as const;
    const undefinedNames = { kind: "variables_undefined", details: { names: ["API_KEY_HEADER", "ZONE"], totalNames: 2 } };

    expect(await client.createCollectorGroup(organizationId, fleetId, { name: "edge", variableGroupId: missing })).toEqual({ kind: "variable_group_not_found" });
    expect(await client.createCollectorGroup(organizationId, fleetId, { name: "edge", assignedPublicationId: publicationId })).toEqual(undefinedNames);
    expect(await client.updateCollectorGroup(organizationId, fleetId, defaultGroupId, { variableGroupId: missing })).toEqual({ kind: "variable_group_not_found" });
    expect(await client.updateCollectorGroup(organizationId, fleetId, defaultGroupId, { assignedPublicationId: publicationId })).toEqual(undefinedNames);
    expect(await client.updateCollectorInstance(organizationId, fleetId, collector.id, { pinnedVariableGroupId: missing })).toEqual({
      kind: "variable_group_not_found",
    });
    expect(await client.updateCollectorInstance(organizationId, fleetId, collector.id, { pin })).toEqual(undefinedNames);
    expect(await client.pinCollectorInstances(organizationId, fleetId, { collectorIds: [collector.id], pinnedVariableGroupId: missing })).toEqual({
      kind: "variable_group_not_found",
    });
    expect(await client.pinCollectorInstances(organizationId, fleetId, { collectorIds: [collector.id], pin })).toEqual(undefinedNames);
    // publication_not_found is still its own kind.
    expect(await client.pinCollectorInstances(organizationId, fleetId, { collectorIds: [collector.id], pin: { kind: "publication", id: missing } })).toEqual({
      kind: "publication_not_found",
    });
  });
});

/** A client whose fetch answers `text` with `status` to every request. */
function answering(status: number, text: string): OpampServerClient {
  return createOpampServerClient({
    url: "http://opamp-server.invalid",
    secret: fake.secret,
    fetch: () => Promise.resolve(new Response(text, { status, headers: { "content-type": "application/json" } })),
  });
}

/** The JSON as Go's encoder writes it with HTML escaping off (writeJSON): U+2028 and U+2029 as 6-byte escapes. */
function goJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

describe("each new operation's worst reply under its class's cap", () => {
  const ASTRAL = "\u{1F680}";
  const SEPARATOR = String.fromCharCode(0x2028);
  const AT = "2026-10-20T09:00:00.000Z";
  const id = () => randomUUID();
  /** A 6-byte escape at each inner character (length - 2 of them), a character at either end: the description's and the names' patterns take it. */
  const escaped = (length: number) => `a${SEPARATOR.repeat(length - 2)}a`;
  const actor = () => ({ id: id(), email: SEPARATOR.repeat(320) });
  const name128 = `A${"_".repeat(127)}`;
  const variable = () => ({ id: id(), name: name128, value: ASTRAL.repeat(1024), description: escaped(1000), changedBy: actor(), changedAt: AT });
  const variableGroup = () => ({
    id: id(),
    name: escaped(200),
    description: escaped(1000),
    overrideCount: 150,
    usage: { collectorGroups: 2 ** 31, pinnedCollectors: 2 ** 31 },
    changedBy: actor(),
    changedAt: AT,
  });
  const override = () => ({ variableId: id(), value: ASTRAL.repeat(1024), changedBy: actor(), changedAt: AT });
  const refs = (count: number) => Array.from({ length: count }, () => ({ fleetId: id(), groupId: id() }));
  const errorWith = (code: string, details: unknown) => ({ error: { code, message: "m".repeat(200), details } });
  const inUse = errorWith("variable_in_use", {
    // The 100 entries allowed, each a publication with one group (an entry is a
    // group row): the largest a real reply's 100 entries make.
    usedBy: Array.from({ length: 100 }, () => ({ publicationId: id(), groups: refs(1), pinnedCollectors: 2 ** 31 })),
    totalPublications: 2 ** 31,
    totalGroups: 2 ** 31,
    totalPinnedCollectors: 2 ** 31,
  });
  const undefinedNames = errorWith("variables_undefined", { names: Array.from({ length: 100 }, () => name128), totalNames: 2 ** 31 });
  const o = randomUUID();
  const g = randomUUID();
  const v = randomUUID();
  const f = randomUUID();
  const c = randomUUID();

  const cases: [string, OpampServerReplyClass, number, () => unknown, (client: OpampServerClient) => Promise<{ kind: string }>][] = [
    ["listVariables", "U", 200, () => ({ variables: Array.from({ length: 150 }, variable) }), (x) => x.listVariables(o)],
    ["getVariableGroup", "U", 200, () => ({ variableGroup: { ...variableGroup(), id: g }, overrides: Array.from({ length: 150 }, override) }), (x) => x.getVariableGroup(o, g)],
    ["listVariableGroups", "U", 200, () => ({ variableGroups: Array.from({ length: 100 }, variableGroup) }), (x) => x.listVariableGroups(o)],
    ["createVariable", "S", 201, () => ({ ...variable(), id: v }), (x) => x.createVariable(o, { id: v, name: "A", value: "", description: null, actor: null })],
    ["updateVariable", "S", 409, () => inUse, (x) => x.updateVariable(o, v, { name: "B", actor: null })],
    ["deleteVariable", "S", 409, () => inUse, (x) => x.deleteVariable(o, v)],
    ["createVariableGroup", "S", 201, () => ({ ...variableGroup(), id: g }), (x) => x.createVariableGroup(o, { id: g, name: "a", description: null, actor: null })],
    ["updateVariableGroup", "S", 200, () => ({ ...variableGroup(), id: g }), (x) => x.updateVariableGroup(o, g, { name: "a", actor: null })],
    [
      "deleteVariableGroup",
      "S",
      409,
      () => errorWith("variable_group_in_use", { collectorGroups: refs(100), totalCollectorGroups: 2 ** 31, pinnedCollectors: 2 ** 31 }),
      (x) => x.deleteVariableGroup(o, g),
    ],
    ["setVariableGroupOverride", "S", 200, () => ({ ...override(), variableId: v }), (x) => x.setVariableGroupOverride(o, g, v, { value: "", actor: null })],
    ["resetVariableGroupOverride", "S", 404, () => errorWith("variable_not_found", undefined), (x) => x.resetVariableGroupOverride(o, g, v, null)],
    ["createCollectorGroup", "S", 422, () => undefinedNames, (x) => x.createCollectorGroup(o, f, { name: "a" })],
    ["updateCollectorGroup", "S", 422, () => undefinedNames, (x) => x.updateCollectorGroup(o, f, g, { name: "a" })],
    ["updateCollectorInstance", "M", 422, () => undefinedNames, (x) => x.updateCollectorInstance(o, f, c, { name: "a" })],
    ["pinCollectorInstances", "S", 422, () => undefinedNames, (x) => x.pinCollectorInstances(o, f, { collectorIds: [c], pin: null })],
  ];

  it.each(cases)("%s's worst reply, as Go writes it, is read under its class (%s)", async (_operation, replyClass, status, body, call) => {
    const text = goJson(body());
    const bytes = Buffer.byteLength(text, "utf8");

    expect(bytes).toBeLessThanOrEqual(OPAMP_SERVER_REPLY_CAPS[replyClass]);
    expect((await call(answering(status, text))).kind).not.toBe("unavailable");
  });

  it("needs U for the organization's variables: their worst list is over M's cap, about 1.85 MB", () => {
    const [, , , body] = cases[0] as (typeof cases)[number];
    const bytes = Buffer.byteLength(goJson(body()), "utf8");

    expect(bytes).toBeGreaterThan(OPAMP_SERVER_REPLY_CAPS.M);
    expect(bytes).toBeLessThan(1_900_000);
  });
});

describe("what an error carries for the variables", () => {
  it("never a value, a name or a description, whatever fails", async () => {
    const value = `value-canary-${randomUUID()}`;
    const description = `description-canary-${randomUUID()}`;
    const name = `NAME_CANARY_${randomUUID().replaceAll("-", "_")}`;
    const groupName = `group-canary-${randomUUID()}`;
    const variableId = randomUUID();
    const groupId = randomUUID();
    const o = randomUUID();
    const goodVariable = { id: variableId, name, value, description, changedBy: null, changedAt: "2026-10-20T09:00:00.000Z" };
    const goodGroup = {
      id: groupId,
      name: groupName,
      description,
      overrideCount: 0,
      usage: { collectorGroups: 0, pinnedCollectors: 0 },
      changedBy: null,
      changedAt: "2026-10-20T09:00:00.000Z",
    };
    const outcomes = await Promise.all(
      [
        () => answering(200, JSON.stringify({ variables: [{ ...goodVariable, changedAt: "soon" }] })).listVariables(o),
        () => answering(200, JSON.stringify({ variables: [{ ...goodVariable, value: `${value}\n` }] })).listVariables(o),
        () => answering(200, JSON.stringify({ ...goodVariable, id: randomUUID() })).updateVariable(o, variableId, { value, actor: null }),
        () => answering(200, JSON.stringify({ variableGroup: { ...goodGroup, name: ` ${groupName}` }, overrides: [] })).getVariableGroup(o, groupId),
        () => answering(200, JSON.stringify({ variableId, value: `${value}\t`, changedBy: null, changedAt: "2026-10-20T09:00:00.000Z" })).setVariableGroupOverride(o, groupId, variableId, { value, actor: null }),
        () => answering(409, JSON.stringify({ error: { code: "variable_in_use", message: `${name} ${value}`, details: { usedBy: [], totalPublications: -1 } } })).deleteVariable(o, variableId),
        () => answering(422, JSON.stringify({ error: { code: "variables_undefined", message: name, details: { names: [`${name}!`], totalNames: 1 } } })).pinCollectorInstances(o, randomUUID(), { collectorIds: [randomUUID()], pin: null }),
        () => answering(409, JSON.stringify({ error: { code: "variable_conflict", message: `${description} ${value}` } })).deleteVariable(o, variableId),
      ].map((call) => call().catch((error: unknown) => error)),
    );

    expect(outcomes.every((outcome) => outcome instanceof OpampServerMisconfigurationError)).toBe(true);
    const seen = outcomes.map((outcome) => `${(outcome as Error).message}\n${(outcome as Error).stack}`).join("\n");
    for (const canary of [value, description, name, groupName]) expect(seen).not.toContain(canary);
    expect(seen).toContain("didn't match its schema at: variables.0.changedAt.");
    expect(seen).toContain("didn't match its schema at: error.details.names.0.");
  });
});
