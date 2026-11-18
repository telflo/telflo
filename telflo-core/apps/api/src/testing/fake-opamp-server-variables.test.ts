import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeOpampServer, type FakeOpampServer } from "./fake-opamp-server.js";
import { choose, variableReferences } from "./fake-opamp-server-variables.js";

// The fake opamp-server's organization variables (D20 Task 9): the 11
// routes, the bindings on groups and pins, the undefined check and drift,
// as the Go server answers them (Tasks 3 to 6), through a plain HTTP client,
// every request and reply checked against vendor/opamp-server/openapi.yaml
// (afterEach reads the violations). The clock is the fake's `now`.

let fake: FakeOpampServer;
const BASE = Date.parse("2026-10-20T09:00:00.000Z");
let clock = BASE;
const at = (offset: number) => new Date(BASE + offset).toISOString();
const ACTOR = { id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", email: "sam@acme.io" };
const OTHER_ACTOR = { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", email: "ana@acme.io" };

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
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface Variable {
  id: string;
  name: string;
  value: string;
  description: string | null;
  changedBy: { id: string; email: string } | null;
  changedAt: string;
}
interface VariableGroup {
  id: string;
  name: string;
  description: string | null;
  overrideCount: number;
  usage: { collectorGroups: number; pinnedCollectors: number };
  changedBy: { id: string; email: string } | null;
  changedAt: string;
}
interface Override {
  variableId: string;
  value: string;
  changedBy: { id: string; email: string } | null;
  changedAt: string;
}
interface Answer<T> {
  status: number;
  body: T;
}

async function call<T = ErrorBody>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  const response = await fetch(`${fake.url}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${fake.secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
}

const code = (answer: Answer<unknown>) => (answer.body as ErrorBody).error.code;
const details = (answer: Answer<unknown>) => (answer.body as ErrorBody).error.details;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function anOrganization(): Promise<string> {
  const id = randomUUID();
  expect((await call("POST", "/organizations", { id, name: "Acme" })).status).toBe(201);
  return id;
}

let labels = 0;

async function aFleet(organizationId: string): Promise<{ fleetId: string; defaultGroupId: string }> {
  const answer = await call<{ fleet: { id: string }; defaultGroup: { id: string } }>("POST", `/organizations/${organizationId}/fleets`, {
    label: `fleet-${++labels}`,
    type: "server",
    rotateExpiresAt: null,
    actor: ACTOR,
  });
  expect(answer.status).toBe(201);
  return { fleetId: answer.body.fleet.id, defaultGroupId: answer.body.defaultGroup.id };
}

function publicationBody(yaml: string) {
  return {
    configuration: { id: randomUUID(), name: "edge-config" },
    version: { id: randomUUID(), number: 1, label: null },
    yaml,
    sha256: sha256(yaml),
    publishedBy: null,
    publishedAt: "2026-10-03T14:02:11.000Z",
    collector: { distribution: "otelcol-contrib", version: "0.162.0" },
  };
}

/** A published version of `yaml` (its names written at publish). */
async function aPublication(organizationId: string, yaml: string): Promise<{ id: string; sha256: string }> {
  const id = randomUUID();
  const answer = await call("POST", `/organizations/${organizationId}/publications`, { id, ...publicationBody(yaml) });
  expect(answer.status).toBe(201);
  return { id, sha256: sha256(yaml) };
}

async function aVariable(organizationId: string, name: string, value = "v", description: string | null = null): Promise<Variable> {
  const answer = await call<Variable>("POST", `/organizations/${organizationId}/variables`, {
    id: randomUUID(),
    name,
    value,
    description,
    actor: ACTOR,
  });
  expect(answer.status).toBe(201);
  return answer.body;
}

let groupNames = 0;

async function aVariableGroup(organizationId: string, name = `vg-${++groupNames}`): Promise<VariableGroup> {
  const answer = await call<VariableGroup>("POST", `/organizations/${organizationId}/variable-groups`, {
    id: randomUUID(),
    name,
    description: null,
    actor: ACTOR,
  });
  expect(answer.status).toBe(201);
  return answer.body;
}

async function anOverride(organizationId: string, variableGroupId: string, variableId: string, value: string): Promise<number> {
  const answer = await call("PUT", `/organizations/${organizationId}/variable-groups/${variableGroupId}/overrides/${variableId}`, {
    value,
    actor: ACTOR,
  });
  expect([200, 201]).toContain(answer.status);
  return answer.status;
}

const revisionOf = (organizationId: string) => fake.snapshotOf(organizationId).variablesRevision as number;

describe("the names a published version references (orgvariables.References)", () => {
  const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../vendor/opamp-server/org-token-corpus.json");
  const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
    render: { name: string; text: string; names: string[] }[];
    extract: { name: string; text: string; expected: string[] }[];
  };

  it.each(corpus.extract.map((row) => [row.name, row] as const))("agrees with the corpus' extract row %s", (_name, row) => {
    expect(variableReferences(row.text)).toEqual(row.expected);
  });

  it.each(corpus.render.map((row) => [row.name, row] as const))("agrees with the corpus' render row %s's names", (_name, row) => {
    expect(variableReferences(row.text)).toEqual(row.names);
  });
});

describe("a publish (Ruling 51)", () => {
  it("refuses a live reference to a name over 128 characters, 400 naming yaml and never the name, writing nothing", async () => {
    const organizationId = await anOrganization();
    const long = `A${"B".repeat(128)}`;
    const before = fake.snapshotOf(organizationId);

    const refused = await call("POST", `/organizations/${organizationId}/publications`, { id: randomUUID(), ...publicationBody(`a: \${org:${long}}\n`) });

    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: {
        code: "invalid_request",
        message: "yaml references an organization variable name over 128 characters, which no variable can have.",
      },
    });
    expect(JSON.stringify(refused.body)).not.toContain(long);
    expect(fake.snapshotOf(organizationId)).toEqual(before);
    // 128 characters, or an escaped reference, publishes.
    await aPublication(organizationId, `a: \${org:${long.slice(0, 128)}}\n`);
    await aPublication(organizationId, `a: $\${org:${long}}\n`);
  });
});

describe("variables", () => {
  it("creates under the caller's id, answers a retry 200, and refuses the id with anything else", async () => {
    const organizationId = await anOrganization();
    const id = randomUUID();
    const body = { id, name: "otlp_endpoint", value: "eu:4317", description: "Where to send.", actor: ACTOR };

    const created = await call<Variable>("POST", `/organizations/${organizationId}/variables`, body);
    expect(created).toEqual({
      status: 201,
      body: { id, name: "otlp_endpoint", value: "eu:4317", description: "Where to send.", changedBy: ACTOR, changedAt: at(0) },
    });
    clock += 1000;
    expect(await call("POST", `/organizations/${organizationId}/variables`, { ...body, actor: OTHER_ACTOR })).toEqual({ status: 200, body: created.body });
    for (const changed of [{ value: "us:4317" }, { name: "OTHER" }, { description: null }]) {
      const conflict = await call("POST", `/organizations/${organizationId}/variables`, { ...body, ...changed });
      expect([conflict.status, code(conflict)]).toEqual([409, "variable_conflict"]);
    }
    const taken = await call("POST", `/organizations/${organizationId}/variables`, { ...body, id: randomUUID() });
    expect([taken.status, code(taken)]).toEqual([409, "variable_name_taken"]);
  });

  it("answers another organization's id variable_conflict only when the name is free and the limit isn't reached (Ruling 59)", async () => {
    const mine = await anOrganization();
    const theirs = await anOrganization();
    const theirVariable = await aVariable(theirs, "REGION");
    await aVariable(mine, "TAKEN");

    const conflict = await call("POST", `/organizations/${mine}/variables`, { id: theirVariable.id, name: "FREE", value: "", description: null, actor: null });
    expect([conflict.status, code(conflict)]).toEqual([409, "variable_conflict"]);
    const nameFirst = await call("POST", `/organizations/${mine}/variables`, { id: theirVariable.id, name: "TAKEN", value: "", description: null, actor: null });
    expect([nameFirst.status, code(nameFirst)]).toEqual([409, "variable_name_taken"]);
    expect((await call<{ variables: Variable[] }>("GET", `/organizations/${theirs}/variables`)).body.variables).toEqual([theirVariable]);
  });

  it("lists every variable by name as bytes, values included", async () => {
    const organizationId = await anOrganization();
    const names = ["b", "B", "_x", "A_1", "a"];
    for (const name of names) await aVariable(organizationId, name, `value of ${name}`);

    const listed = await call<{ variables: Variable[] }>("GET", `/organizations/${organizationId}/variables`);

    expect(listed.body.variables.map((v) => v.name)).toEqual(["A_1", "B", "_x", "a", "b"]);
    expect(listed.body.variables.map((v) => v.value)).toEqual(["value of A_1", "value of B", "value of _x", "value of a", "value of b"]);
  });

  it("stamps a value's or a name's change, never a description's, and changes nothing for the same fields", async () => {
    const organizationId = await anOrganization();
    const variable = await aVariable(organizationId, "REGION", "eu");
    const path = `/organizations/${organizationId}/variables/${variable.id}`;
    const revision = revisionOf(organizationId);
    clock += 1000;

    const described = await call<Variable>("PATCH", path, { description: "Where.", actor: OTHER_ACTOR });
    expect(described.body).toEqual({ ...variable, description: "Where.", changedBy: OTHER_ACTOR, changedAt: at(1000) });
    expect(revisionOf(organizationId)).toBe(revision);

    clock += 1000;
    const same = await call<Variable>("PATCH", path, { value: "eu", description: "Where.", actor: ACTOR });
    expect(same.body).toEqual(described.body);
    expect(revisionOf(organizationId)).toBe(revision);

    const valued = await call<Variable>("PATCH", path, { value: "us", actor: ACTOR });
    expect(valued.body).toMatchObject({ value: "us", changedBy: ACTOR, changedAt: at(2000) });
    expect(revisionOf(organizationId)).toBe(revision + 1);
    const renamed = await call<Variable>("PATCH", path, { name: "ZONE", actor: null });
    expect(renamed.body).toMatchObject({ name: "ZONE", changedBy: null });
    expect(revisionOf(organizationId)).toBe(revision + 2);
    await aVariable(organizationId, "TAKEN");
    const taken = await call("PATCH", path, { name: "TAKEN", actor: null });
    expect([taken.status, code(taken)]).toEqual([409, "variable_name_taken"]);
  });

  it("deletes a variable with its overrides, reset rows included, moving the counter on (Ruling 63)", async () => {
    const organizationId = await anOrganization();
    const variable = await aVariable(organizationId, "REGION");
    const kept = await aVariable(organizationId, "KEPT");
    const one = await aVariableGroup(organizationId);
    const two = await aVariableGroup(organizationId);
    await anOverride(organizationId, one.id, variable.id, "a");
    await anOverride(organizationId, two.id, variable.id, "b");
    await anOverride(organizationId, two.id, kept.id, "c");
    await call("DELETE", `/organizations/${organizationId}/variable-groups/${one.id}/overrides/${variable.id}`, { actor: null });
    const revision = revisionOf(organizationId);

    expect((await call("DELETE", `/organizations/${organizationId}/variables/${variable.id}`)).status).toBe(204);

    // Ruling 63: a delete moves the counter on once.
    expect(revisionOf(organizationId)).toBe(revision + 1);

    const overrides = fake.snapshotOf(organizationId).variableGroupOverrides as { variableId: string }[];
    expect(overrides.map((o) => o.variableId)).toEqual([kept.id]);
    const missing = await call("DELETE", `/organizations/${organizationId}/variables/${variable.id}`);
    expect([missing.status, code(missing)]).toEqual([404, "variable_not_found"]);
  });

  it("holds at most 150 variables (Q104) and 100 variable groups (Q90)", async () => {
    const organizationId = await anOrganization();
    for (let n = 0; n < 150; n++) await aVariable(organizationId, `V_${n}`);
    for (let n = 0; n < 100; n++) await aVariableGroup(organizationId);

    const variable = await call("POST", `/organizations/${organizationId}/variables`, { id: randomUUID(), name: "ONE_MORE", value: "", description: null, actor: null });
    expect([variable.status, code(variable)]).toEqual([409, "variable_limit_reached"]);
    expect(variable.body.error.message).toBe("The organization has 150 variables, the most it may have.");
    const group = await call("POST", `/organizations/${organizationId}/variable-groups`, { id: randomUUID(), name: "one-more", description: null, actor: null });
    expect([group.status, code(group)]).toEqual([409, "variable_group_limit_reached"]);
    // The name is checked before the limit.
    const taken = await call("POST", `/organizations/${organizationId}/variables`, { id: randomUUID(), name: "V_0", value: "", description: null, actor: null });
    expect(code(taken)).toBe("variable_name_taken");
    // Another organization has its own limit.
    await aVariable(await anOrganization(), "V_0");
  });
});

describe("variable groups and their overrides", () => {
  it("creates, retries, renames and refuses a taken name", async () => {
    const organizationId = await anOrganization();
    const id = randomUUID();
    const body = { id, name: "eu-edge", description: "Europe's edge.", actor: ACTOR };
    const created = await call<VariableGroup>("POST", `/organizations/${organizationId}/variable-groups`, body);
    expect(created).toEqual({
      status: 201,
      body: {
        id,
        name: "eu-edge",
        description: "Europe's edge.",
        overrideCount: 0,
        usage: { collectorGroups: 0, pinnedCollectors: 0 },
        changedBy: ACTOR,
        changedAt: at(0),
      },
    });
    expect((await call("POST", `/organizations/${organizationId}/variable-groups`, body)).status).toBe(200);
    expect(code(await call("POST", `/organizations/${organizationId}/variable-groups`, { ...body, description: null }))).toBe("variable_group_conflict");
    await aVariableGroup(organizationId, "us-edge");
    expect(code(await call("PATCH", `/organizations/${organizationId}/variable-groups/${id}`, { name: "us-edge", actor: null }))).toBe(
      "variable_group_name_taken",
    );
    clock += 5;
    const renamed = await call<VariableGroup>("PATCH", `/organizations/${organizationId}/variable-groups/${id}`, { name: "eu-west", actor: null });
    expect(renamed.body).toMatchObject({ name: "eu-west", changedBy: null, changedAt: at(5) });
  });

  it("sets an override (201), answers the same value 200 changing nothing, replaces (200), resets (204, its row kept) and revives it (201)", async () => {
    const organizationId = await anOrganization();
    const variable = await aVariable(organizationId, "REGION", "eu");
    const group = await aVariableGroup(organizationId);
    const path = `/organizations/${organizationId}/variable-groups/${group.id}/overrides/${variable.id}`;
    const overrides = () => fake.snapshotOf(organizationId).variableGroupOverrides as { value: string | null; stamp: number }[];
    clock += 10;

    const set = await call<Override>("PUT", path, { value: "eu-1", actor: OTHER_ACTOR });
    expect(set).toEqual({ status: 201, body: { variableId: variable.id, value: "eu-1", changedBy: OTHER_ACTOR, changedAt: at(10) } });
    const stamp = overrides()[0]?.stamp;
    clock += 10;
    const before = fake.snapshotOf(organizationId);
    expect(await call("PUT", path, { value: "eu-1", actor: ACTOR })).toEqual({ status: 200, body: set.body });
    expect(fake.snapshotOf(organizationId)).toEqual(before);

    const replaced = await call<Override>("PUT", path, { value: "eu-2", actor: ACTOR });
    expect(replaced).toEqual({ status: 200, body: { variableId: variable.id, value: "eu-2", changedBy: ACTOR, changedAt: at(20) } });
    expect(overrides()[0]?.stamp).toBeGreaterThan(stamp as number);

    clock += 10;
    expect((await call("DELETE", path, { actor: OTHER_ACTOR })).status).toBe(204);
    expect(overrides()).toEqual([expect.objectContaining({ value: null, changedBy: OTHER_ACTOR })]);
    const detail = await call<{ variableGroup: VariableGroup; overrides: Override[] }>("GET", `/organizations/${organizationId}/variable-groups/${group.id}`);
    // A reset row is never answered nor counted; the group's changedBy and changedAt moved with it.
    expect(detail.body).toEqual({ variableGroup: { ...group, changedBy: OTHER_ACTOR, changedAt: at(30) }, overrides: [] });
    const reset = fake.snapshotOf(organizationId);
    expect((await call("DELETE", path, { actor: ACTOR })).status).toBe(204);
    expect(fake.snapshotOf(organizationId)).toEqual(reset);

    expect((await call("PUT", path, { value: "eu-2", actor: null })).status).toBe(201);
  });

  it("answers a group's overrides by their variable's name, and refuses a missing group before a missing variable", async () => {
    const organizationId = await anOrganization();
    const group = await aVariableGroup(organizationId);
    const zone = await aVariable(organizationId, "ZONE");
    const app = await aVariable(organizationId, "APP");
    await anOverride(organizationId, group.id, zone.id, "z");
    await anOverride(organizationId, group.id, app.id, "a");

    const detail = await call<{ variableGroup: VariableGroup; overrides: Override[] }>("GET", `/organizations/${organizationId}/variable-groups/${group.id}`);
    expect(detail.body.overrides.map((o) => o.value)).toEqual(["a", "z"]);
    expect(detail.body.variableGroup.overrideCount).toBe(2);

    const both = await call("PUT", `/organizations/${organizationId}/variable-groups/${randomUUID()}/overrides/${randomUUID()}`, { value: "", actor: null });
    expect([both.status, code(both)]).toEqual([404, "variable_group_not_found"]);
    const variableMissing = await call("DELETE", `/organizations/${organizationId}/variable-groups/${group.id}/overrides/${randomUUID()}`, { actor: null });
    expect([variableMissing.status, code(variableMissing)]).toEqual([404, "variable_not_found"]);
  });
});

/** A fleet with a group assigned a published version referencing ${org:NAME}s, and a collector pinned to another. */
async function aUsedWorld(names = ["REGION"]) {
  const organizationId = await anOrganization();
  const { fleetId, defaultGroupId } = await aFleet(organizationId);
  const variables = [];
  for (const name of names) variables.push(await aVariable(organizationId, name));
  const yaml = names.map((name) => `${name.toLowerCase()}: \${org:${name}}`).join("\n");
  const assigned = await aPublication(organizationId, `${yaml}\n# assigned\n`);
  const pinned = await aPublication(organizationId, `${yaml}\n# pinned\n`);
  const unused = await aPublication(organizationId, `${yaml}\n# unused\n`);
  expect((await call("PATCH", `/organizations/${organizationId}/fleets/${fleetId}/groups/${defaultGroupId}`, { assignedPublicationId: assigned.id })).status).toBe(200);
  const collector = fake.enrollCollector(organizationId, fleetId);
  const pin = await call("PATCH", `/organizations/${organizationId}/fleets/${fleetId}/collectors/${collector.id}`, {
    pin: { kind: "publication", id: pinned.id },
  });
  expect(pin.status).toBe(200);
  return { organizationId, fleetId, defaultGroupId, variables, assigned, pinned, unused, collectorId: collector.id };
}

describe("the guards (decision 6, Q102)", () => {
  it("refuses a used variable's delete and rename 409 with what uses it, ids and counts only; a value change never", async () => {
    const world = await aUsedWorld();
    const variable = world.variables[0] as Variable;
    const path = `/organizations/${world.organizationId}/variables/${variable.id}`;
    const before = fake.snapshotOf(world.organizationId);
    const expected = {
      usedBy: [
        ...[
          { publicationId: world.assigned.id, groups: [{ fleetId: world.fleetId, groupId: world.defaultGroupId }], pinnedCollectors: 0 },
          { publicationId: world.pinned.id, groups: [], pinnedCollectors: 1 },
        ].sort((a, b) => (a.publicationId < b.publicationId ? -1 : 1)),
      ],
      totalPublications: 2,
      totalGroups: 1,
      totalPinnedCollectors: 1,
    };

    for (const [method, body] of [
      ["DELETE", undefined],
      ["PATCH", { name: "ZONE", actor: null }],
    ] as const) {
      const refused = await call(method, path, body);
      expect([refused.status, code(refused)]).toEqual([409, "variable_in_use"]);
      expect(details(refused)).toEqual(expected);
      expect(JSON.stringify(refused.body)).not.toContain("REGION");
    }
    expect(fake.snapshotOf(world.organizationId)).toEqual(before);
    expect((await call("PATCH", path, { value: "changed", actor: null })).status).toBe(200);
  });

  it("lets a variable go once nothing uses a published version referencing it; an unassigned one doesn't count", async () => {
    const world = await aUsedWorld();
    const variable = world.variables[0] as Variable;
    await call("PATCH", `/organizations/${world.organizationId}/fleets/${world.fleetId}/groups/${world.defaultGroupId}`, { assignedPublicationId: null });
    await call("PATCH", `/organizations/${world.organizationId}/fleets/${world.fleetId}/collectors/${world.collectorId}`, { pin: null });

    expect((await call("DELETE", `/organizations/${world.organizationId}/variables/${variable.id}`)).status).toBe(204);
  });

  it("lists at most 100 entries of a variable's uses, by publication then fleet then group, the totals exact", async () => {
    const world = await aUsedWorld();
    const variable = world.variables[0] as Variable;
    for (let n = 0; n < 110; n++) {
      const group = await call<{ id: string }>("POST", `/organizations/${world.organizationId}/fleets/${world.fleetId}/groups`, {
        name: `group-${n}`,
        assignedPublicationId: world.assigned.id,
      });
      expect(group.status).toBe(201);
    }

    const refused = await call("DELETE", `/organizations/${world.organizationId}/variables/${variable.id}`);
    const answered = details(refused) as {
      usedBy: { publicationId: string; groups: { groupId: string }[]; pinnedCollectors: number }[];
      totalPublications: number;
      totalGroups: number;
      totalPinnedCollectors: number;
    };
    const entries = answered.usedBy.reduce((n, use) => n + Math.max(use.groups.length, use.groups.length === 0 ? 1 : 0), 0);
    expect(entries).toBe(100);
    expect([answered.totalPublications, answered.totalGroups, answered.totalPinnedCollectors]).toEqual([2, 111, 1]);
    for (const use of answered.usedBy) {
      const ids = use.groups.map((g) => g.groupId);
      expect(ids).toEqual([...ids].sort());
    }
    expect(answered.usedBy.map((use) => use.publicationId)).toEqual([...answered.usedBy.map((use) => use.publicationId)].sort());
  });

  it("refuses a used variable group's delete 409 with at most 100 collector groups, their total and its pinned collectors", async () => {
    const organizationId = await anOrganization();
    const { fleetId } = await aFleet(organizationId);
    const variableGroup = await aVariableGroup(organizationId);
    for (let n = 0; n < 101; n++) {
      const group = await call("POST", `/organizations/${organizationId}/fleets/${fleetId}/groups`, { name: `group-${n}`, variableGroupId: variableGroup.id });
      expect(group.status).toBe(201);
    }
    const collector = fake.enrollCollector(organizationId, fleetId);
    await call("PATCH", `/organizations/${organizationId}/fleets/${fleetId}/collectors/${collector.id}`, { pinnedVariableGroupId: variableGroup.id });

    const refused = await call("DELETE", `/organizations/${organizationId}/variable-groups/${variableGroup.id}`);

    expect([refused.status, code(refused)]).toEqual([409, "variable_group_in_use"]);
    const answered = details(refused) as { collectorGroups: { fleetId: string; groupId: string }[]; totalCollectorGroups: number; pinnedCollectors: number };
    expect(answered.collectorGroups).toHaveLength(100);
    expect([answered.totalCollectorGroups, answered.pinnedCollectors]).toEqual([101, 1]);
    const listed = await call<{ variableGroups: VariableGroup[] }>("GET", `/organizations/${organizationId}/variable-groups`);
    expect(listed.body.variableGroups[0]?.usage).toEqual({ collectorGroups: 101, pinnedCollectors: 1 });
  });
});

describe("the undefined check and the bindings' targets (decision 7)", () => {
  async function anUndefinedWorld(count: number) {
    const organizationId = await anOrganization();
    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    await aVariable(organizationId, "DEFINED");
    const names = Array.from({ length: count }, (_, n) => `MISSING_${String(n).padStart(3, "0")}`);
    const publication = await aPublication(organizationId, [...names, "DEFINED"].map((name) => `\${org:${name}}`).join("\n"));
    const collector = fake.enrollCollector(organizationId, fleetId);
    return { organizationId, fleetId, defaultGroupId, names, publication, collectorId: collector.id };
  }

  it("refuses an assignment, a pin and a bulk pin of a version referencing undefined names: at most 100 in byte order, the total exact", async () => {
    const world = await anUndefinedWorld(150);
    const base = `/organizations/${world.organizationId}/fleets/${world.fleetId}`;
    const before = fake.snapshotOf(world.organizationId);
    const expected = { names: world.names.slice(0, 100), totalNames: 150 };

    for (const [method, path, body] of [
      ["POST", `${base}/groups`, { name: "edge", assignedPublicationId: world.publication.id }],
      ["PATCH", `${base}/groups/${world.defaultGroupId}`, { assignedPublicationId: world.publication.id }],
      ["PATCH", `${base}/collectors/${world.collectorId}`, { pin: { kind: "publication", id: world.publication.id } }],
      ["POST", `${base}/collectors/pin`, { collectorIds: [world.collectorId], pin: { kind: "publication", id: world.publication.id } }],
    ] as const) {
      const refused = await call(method, path, body);
      expect([refused.status, code(refused)], path).toEqual([422, "variables_undefined"]);
      expect(details(refused)).toEqual(expected);
    }
    expect(fake.snapshotOf(world.organizationId)).toEqual(before);
  });

  it("checks a group's links in the store's order: the published version, the variable group, the names, then the name", async () => {
    const world = await anUndefinedWorld(1);
    const base = `/organizations/${world.organizationId}/fleets/${world.fleetId}/groups`;
    await call("POST", base, { name: "taken" });

    const all = { name: "taken", assignedPublicationId: randomUUID(), variableGroupId: randomUUID() };
    expect(code(await call("POST", base, all))).toBe("publication_not_found");
    expect(code(await call("POST", base, { ...all, assignedPublicationId: world.publication.id }))).toBe("variable_group_not_found");
    const variableGroup = await aVariableGroup(world.organizationId);
    expect(code(await call("POST", base, { ...all, assignedPublicationId: world.publication.id, variableGroupId: variableGroup.id }))).toBe(
      "variables_undefined",
    );
    expect(code(await call("POST", base, { name: "taken", variableGroupId: variableGroup.id }))).toBe("collector_group_name_taken");
  });

  it("refuses a variable group the organization doesn't hold on a group, a collector and a bulk pin; another organization's included", async () => {
    const organizationId = await anOrganization();
    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    const theirs = await aVariableGroup(await anOrganization());
    const collector = fake.enrollCollector(organizationId, fleetId);
    const base = `/organizations/${organizationId}/fleets/${fleetId}`;

    for (const [method, path, body] of [
      ["POST", `${base}/groups`, { name: "edge", variableGroupId: theirs.id }],
      ["PATCH", `${base}/groups/${defaultGroupId}`, { variableGroupId: theirs.id }],
      ["PATCH", `${base}/collectors/${collector.id}`, { pinnedVariableGroupId: theirs.id }],
      ["POST", `${base}/collectors/pin`, { collectorIds: [collector.id], pinnedVariableGroupId: theirs.id }],
    ] as const) {
      const refused = await call(method, path, body);
      expect([refused.status, code(refused)], path).toEqual([422, "variable_group_not_found"]);
    }
  });

  it("sets and clears a group's and a pin's variable group, and a bulk pin leaves what it isn't given as it is (Q103)", async () => {
    const organizationId = await anOrganization();
    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    const one = await aVariableGroup(organizationId);
    const two = await aVariableGroup(organizationId);
    const publication = await aPublication(organizationId, "a: 1\n");
    const first = fake.enrollCollector(organizationId, fleetId);
    const second = fake.enrollCollector(organizationId, fleetId);
    const base = `/organizations/${organizationId}/fleets/${fleetId}`;
    const read = async (id: string) => (await call<{ pin: unknown; pinnedVariableGroupId: string | null }>("GET", `${base}/collectors/${id}`)).body;

    expect((await call<{ variableGroupId: string }>("PATCH", `${base}/groups/${defaultGroupId}`, { variableGroupId: one.id })).body.variableGroupId).toBe(one.id);
    await call("POST", `${base}/collectors/pin`, { collectorIds: [first.id, second.id], pin: { kind: "publication", id: publication.id } });
    expect(await read(first.id)).toMatchObject({ pin: { kind: "publication", id: publication.id }, pinnedVariableGroupId: null });
    const pinned = await call("POST", `${base}/collectors/pin`, { collectorIds: [first.id, second.id, randomUUID()], pinnedVariableGroupId: two.id });
    expect(pinned.status).toBe(200);
    expect(await read(second.id)).toMatchObject({ pin: { kind: "publication", id: publication.id }, pinnedVariableGroupId: two.id });
    await call("POST", `${base}/collectors/pin`, { collectorIds: [first.id], pin: null });
    expect(await read(first.id)).toMatchObject({ pin: null, pinnedVariableGroupId: two.id });
    expect((await call<{ pinnedVariableGroupId: null }>("PATCH", `${base}/collectors/${first.id}`, { pinnedVariableGroupId: null })).body.pinnedVariableGroupId).toBeNull();
    expect((await call<{ variableGroupId: null }>("PATCH", `${base}/groups/${defaultGroupId}`, { variableGroupId: null })).body.variableGroupId).toBeNull();
    expect((await call<{ variableGroups: VariableGroup[] }>("GET", `/organizations/${organizationId}/variable-groups`)).body.variableGroups.map((g) => g.usage)).toEqual([
      { collectorGroups: 0, pinnedCollectors: 0 },
      { collectorGroups: 0, pinnedCollectors: 1 },
    ]);
  });
});

describe("drift by the served-variables marker (decisions 12 and 34; Choose's three levels)", () => {
  /**
   * A collector of a group bound to `groupLevel`, pinned to `pinLevel` (both
   * variable groups), running a published version referencing REGION and
   * ZONE; UNUSED is defined but not referenced. Served and applied: inSync.
   */
  async function aServedCollector() {
    const organizationId = await anOrganization();
    const { fleetId, defaultGroupId } = await aFleet(organizationId);
    const region = await aVariable(organizationId, "REGION", "eu");
    const zone = await aVariable(organizationId, "ZONE", "a");
    const unused = await aVariable(organizationId, "UNUSED", "x");
    const groupLevel = await aVariableGroup(organizationId);
    const pinLevel = await aVariableGroup(organizationId);
    const publication = await aPublication(organizationId, "region: ${org:REGION}\nzone: ${org:ZONE}\n");
    const base = `/organizations/${organizationId}/fleets/${fleetId}`;
    await call("PATCH", `${base}/groups/${defaultGroupId}`, { assignedPublicationId: publication.id, variableGroupId: groupLevel.id });
    const collector = fake.enrollCollector(organizationId, fleetId);
    await call("PATCH", `${base}/collectors/${collector.id}`, { pinnedVariableGroupId: pinLevel.id });
    const serve = () => {
      clock += 1;
      fake.setCollectorState(organizationId, collector.id, {
        served: { kind: "publication", id: publication.id, sha256: "f".repeat(64) },
        effective: { sha256: "f".repeat(64), status: "applied" },
      });
    };
    const drift = async () => (await call<{ sync: string }>("GET", `${base}/collectors/${collector.id}`)).body.sync;
    const summary = async () => (await call<{ summary: Record<string, number> }>("GET", base)).body.summary;
    serve();
    expect(await drift()).toBe("inSync");
    return { organizationId, fleetId, defaultGroupId, base, region, zone, unused, groupLevel, pinLevel, publication, collectorId: collector.id, serve, drift, summary };
  }

  it("reads Pending after a used value's change until it is served again, and never for an unused value's", async () => {
    const world = await aServedCollector();
    const variablePath = (v: Variable) => `/organizations/${world.organizationId}/variables/${v.id}`;

    await call("PATCH", variablePath(world.unused), { value: "y", actor: null });
    expect(await world.drift()).toBe("inSync");
    await call("PATCH", variablePath(world.unused), { description: "Not used.", actor: null });
    expect(await world.drift()).toBe("inSync");

    await call("PATCH", variablePath(world.region), { value: "us", actor: null });
    expect(await world.drift()).toBe("pending");
    expect(await world.summary()).toMatchObject({ pending: 1, inSync: 0 });
    world.serve();
    expect(await world.drift()).toBe("inSync");
    expect(await world.summary()).toMatchObject({ pending: 0, inSync: 1 });
  });

  it("takes each name's stamp from the pin's variable group, then the group's, then the variable (three levels)", async () => {
    const world = await aServedCollector();
    const { organizationId } = world;

    // The group's override of REGION hides the variable's value: its change is seen…
    await anOverride(organizationId, world.groupLevel.id, world.region.id, "eu-group");
    expect(await world.drift()).toBe("pending");
    world.serve();
    await call("PATCH", `/organizations/${organizationId}/variables/${world.region.id}`, { value: "hidden", actor: null });
    expect(await world.drift()).toBe("inSync");

    // …and the pin's hides the group's.
    await anOverride(organizationId, world.pinLevel.id, world.region.id, "eu-pin");
    expect(await world.drift()).toBe("pending");
    world.serve();
    await anOverride(organizationId, world.groupLevel.id, world.region.id, "eu-group-2");
    expect(await world.drift()).toBe("inSync");

    // A Reset of the pin's override is seen (its row above the source counts, Q100).
    await call("DELETE", `/organizations/${organizationId}/variable-groups/${world.pinLevel.id}/overrides/${world.region.id}`, { actor: null });
    expect(await world.drift()).toBe("pending");
    world.serve();
    expect(await world.drift()).toBe("inSync");
    // A reset of nothing changes nothing.
    await call("DELETE", `/organizations/${organizationId}/variable-groups/${world.pinLevel.id}/overrides/${world.zone.id}`, { actor: null });
    expect(await world.drift()).toBe("inSync");
  });

  it("reads Pending after a group's or a pin's variable-group change, and after a move between groups of different variable groups", async () => {
    const world = await aServedCollector();
    const other = await aVariableGroup(world.organizationId);
    const collectorPath = `${world.base}/collectors/${world.collectorId}`;

    await call("PATCH", `${world.base}/groups/${world.defaultGroupId}`, { variableGroupId: other.id });
    expect(await world.drift()).toBe("pending");
    world.serve();
    await call("PATCH", collectorPath, { pinnedVariableGroupId: null });
    expect(await world.drift()).toBe("pending");
    world.serve();
    // The same setting again stamps nothing.
    await call("PATCH", collectorPath, { pinnedVariableGroupId: null });
    expect(await world.drift()).toBe("inSync");

    const differing = await call<{ id: string }>("POST", `${world.base}/groups`, { name: "differing", assignedPublicationId: world.publication.id });
    await call("PATCH", collectorPath, { groupId: differing.body.id });
    expect(await world.drift()).toBe("pending");
    world.serve();
    const same = await call<{ id: string }>("POST", `${world.base}/groups`, { name: "same", assignedPublicationId: world.publication.id });
    await call("PATCH", collectorPath, { groupId: same.body.id });
    expect(await world.drift()).toBe("inSync");
  });

  it("carries the old group's setting's stamp on a move between groups of the same variable group (Ruling 60)", async () => {
    const world = await aServedCollector();
    const shared = await aVariableGroup(world.organizationId);
    // A group already using the shared variable group, its setting stamped before the collector's last poll…
    const target = await call<{ id: string }>("POST", `${world.base}/groups`, {
      name: "target",
      assignedPublicationId: world.publication.id,
      variableGroupId: shared.id,
    });
    await call("PATCH", `/organizations/${world.organizationId}/variables/${world.region.id}`, { value: "later", actor: null });
    world.serve();
    expect(await world.drift()).toBe("inSync");
    // …then the collector's own group moves to it, unpolled, and the collector moves into the target.
    await call("PATCH", `${world.base}/groups/${world.defaultGroupId}`, { variableGroupId: shared.id });
    expect(await world.drift()).toBe("pending");
    await call("PATCH", `${world.base}/collectors/${world.collectorId}`, { groupId: target.body.id });

    expect(await world.drift()).toBe("pending");
    world.serve();
    expect(await world.drift()).toBe("inSync");
  });

  it("never reads Pending for variables when the published version references none", async () => {
    const world = await aServedCollector();
    const plain = await aPublication(world.organizationId, "receivers: {}\n");
    await call("PATCH", `${world.base}/groups/${world.defaultGroupId}`, { assignedPublicationId: plain.id });
    fake.setCollectorState(world.organizationId, world.collectorId, {
      served: { kind: "publication", id: plain.id, sha256: plain.sha256, variablesStamp: null },
      effective: { sha256: plain.sha256, status: "applied" },
    });
    expect(await world.drift()).toBe("inSync");

    await call("PATCH", `/organizations/${world.organizationId}/variables/${world.region.id}`, { value: "changed", actor: null });
    await call("PATCH", `${world.base}/collectors/${world.collectorId}`, { pinnedVariableGroupId: null });
    expect(await world.drift()).toBe("inSync");
  });

  it("reads Pending when served another published version, whatever the hashes", async () => {
    const world = await aServedCollector();
    const other = await aPublication(world.organizationId, "region: ${org:REGION}\n# other\n");
    fake.setCollectorState(world.organizationId, world.collectorId, {
      served: { kind: "publication", id: other.id, sha256: "f".repeat(64) },
      effective: { sha256: "f".repeat(64), status: "applied" },
    });
    expect(await world.drift()).toBe("pending");
  });

  it("chooses as stamps.go does: the greatest stamp down to the first level with a value", () => {
    expect(choose(undefined, undefined, { value: "org", stamp: 3 })).toEqual({ value: "org", stamp: 3 });
    expect(choose({ value: null, stamp: 9 }, undefined, { value: "org", stamp: 3 })).toEqual({ value: "org", stamp: 9 });
    expect(choose({ value: "pin", stamp: 2 }, { value: "group", stamp: 8 }, { value: "org", stamp: 9 })).toEqual({ value: "pin", stamp: 2 });
    expect(choose(undefined, { value: null, stamp: 5 }, { value: "org", stamp: 1 })).toEqual({ value: "org", stamp: 5 });
    expect(choose({ value: null, stamp: 4 }, { value: "group", stamp: 6 }, { value: "org", stamp: 7 })).toEqual({ value: "group", stamp: 6 });
  });
});

describe("isolation: each organization's own", () => {
  it("answers another organization's variable, variable group and override as not found, and changes nothing of theirs", async () => {
    const theirs = await anOrganization();
    const mine = await anOrganization();
    const variable = await aVariable(theirs, "REGION", "their value");
    const group = await aVariableGroup(theirs);
    await anOverride(theirs, group.id, variable.id, "their override");
    const before = fake.snapshotOf(theirs);
    const myVariable = await aVariable(mine, "MINE");
    const myGroup = await aVariableGroup(mine);

    for (const [method, path, body, expected] of [
      ["PATCH", `/organizations/${mine}/variables/${variable.id}`, { value: "x", actor: null }, "variable_not_found"],
      ["DELETE", `/organizations/${mine}/variables/${variable.id}`, undefined, "variable_not_found"],
      ["GET", `/organizations/${mine}/variable-groups/${group.id}`, undefined, "variable_group_not_found"],
      ["PATCH", `/organizations/${mine}/variable-groups/${group.id}`, { name: "x", actor: null }, "variable_group_not_found"],
      ["DELETE", `/organizations/${mine}/variable-groups/${group.id}`, undefined, "variable_group_not_found"],
      ["PUT", `/organizations/${mine}/variable-groups/${group.id}/overrides/${variable.id}`, { value: "x", actor: null }, "variable_group_not_found"],
      ["PUT", `/organizations/${mine}/variable-groups/${myGroup.id}/overrides/${variable.id}`, { value: "x", actor: null }, "variable_not_found"],
      ["DELETE", `/organizations/${mine}/variable-groups/${group.id}/overrides/${variable.id}`, { actor: null }, "variable_group_not_found"],
    ] as const) {
      const refused = await call(method, path, body);
      expect([refused.status, code(refused)], `${method} ${path}`).toEqual([404, expected]);
      expect(JSON.stringify(refused.body)).not.toContain("their");
    }
    expect((await call<{ variables: Variable[] }>("GET", `/organizations/${mine}/variables`)).body.variables).toEqual([myVariable]);
    expect((await call<{ variableGroups: VariableGroup[] }>("GET", `/organizations/${mine}/variable-groups`)).body.variableGroups).toEqual([myGroup]);
    expect(fake.snapshotOf(theirs)).toEqual(before);
  });

  it("never defines a name with another organization's variable, nor counts its uses", async () => {
    const theirs = await aUsedWorld(["REGION"]);
    const mine = await anOrganization();
    const { fleetId, defaultGroupId } = await aFleet(mine);
    const publication = await aPublication(mine, "a: ${org:REGION}\n");

    const refused = await call("PATCH", `/organizations/${mine}/fleets/${fleetId}/groups/${defaultGroupId}`, { assignedPublicationId: publication.id });
    expect([refused.status, details(refused)]).toEqual([422, { names: ["REGION"], totalNames: 1 }]);
    const myRegion = await aVariable(mine, "REGION");
    expect((await call("DELETE", `/organizations/${mine}/variables/${myRegion.id}`)).status).toBe(204);
    expect(code(await call("DELETE", `/organizations/${theirs.organizationId}/variables/${(theirs.variables[0] as Variable).id}`))).toBe("variable_in_use");
  });

  it("deletes an organization's variables, variable groups and overrides with it", async () => {
    const organizationId = await anOrganization();
    const variable = await aVariable(organizationId, "REGION");
    const group = await aVariableGroup(organizationId);
    await anOverride(organizationId, group.id, variable.id, "o");

    expect((await call("DELETE", `/organizations/${organizationId}`)).status).toBe(204);

    expect(fake.snapshotOf(organizationId)).toMatchObject({ variables: [], variableGroups: [], variableGroupOverrides: [], variablesRevision: 0 });
  });
});
