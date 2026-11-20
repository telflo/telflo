import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KUBERNETES_ROLES as CONTRACTS_KUBERNETES_ROLES,
  PublicCreateCollectorGroupRequestSchema,
  PublicUpdateCollectorGroupRequestSchema,
} from "@telflo/contracts";
import { envelope, routedFetch, type RecordedCall } from "../../tests/fake-fetch.js";
import { ApiClient } from "../api.js";
import { EXIT, ExitError } from "../output.js";
import {
  deployConfiguration,
  KUBERNETES_ROLES,
  NAME_NEEDED_MESSAGE,
  NODE_ROLE_ON_CREATE_MESSAGE,
  NOT_PUBLISHED_MESSAGE,
  resolveDeployTarget,
  SEVERAL_SERVING_MESSAGE,
} from "./deploy.js";

/*
 * `telflo deploy`'s decision and calls, on collector groups: ids compared
 * through canonicalIdOf, the ambiguity's error listing ids only.
 */

const SERVER = "https://telflo.example";
const FLEET = "3e1f2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CONFIG = "5a3b4c6d-7e8f-4091-8bcd-2e3f4a5b6c7d";
const OTHER_CONFIG = "6b4c5d7e-8f90-41a2-9cde-3f4a5b6c7d8e";
const G1 = "7c5d6e8f-9001-42b3-8def-4a5b6c7d8e9f";
const G2 = "8d6e7f90-0112-43c4-9ef0-5b6c7d8e9fa0";

const groupOf = (id: string, configurationId: string | null, name = "a-group") => ({
  id,
  fleetId: FLEET,
  name,
  isDefault: false,
  role: null,
  namespace: null,
  replicas: null,
  assignedPublishedVersionId: null,
  configurationId,
  versionNumber: configurationId === null ? null : 2,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
});

function clientOf(routes: Parameters<typeof routedFetch>[0]): { client: ApiClient; calls: RecordedCall[] } {
  const fake = routedFetch(routes);
  return { client: new ApiClient({ server: SERVER, token: `tf_${randomBytes(32).toString("base64url")}`, fetch: fake.fetch }), calls: fake.calls };
}

const bodyOf = (call: RecordedCall | undefined): unknown => (call?.body === undefined ? undefined : JSON.parse(call.body));
const routeOf = (call: RecordedCall): string => `${call.method} ${call.url.pathname.replace("/api/public/v1", "")}`;

async function refusalOf(promise: Promise<unknown>): Promise<ExitError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExitError);
    return error as ExitError;
  }
  throw new Error("expected a refusal");
}

describe("KUBERNETES_ROLES", () => {
  it("matches the contracts'", () => {
    expect(KUBERNETES_ROLES).toEqual(CONTRACTS_KUBERNETES_ROLES);
  });
});

describe("resolveDeployTarget", () => {
  it("the group named wins, canonicalized", () => {
    expect(resolveDeployTarget([groupOf(G1, CONFIG)], OTHER_CONFIG, G2.toUpperCase())).toEqual({ kind: "update", id: G2 });
    expect(resolveDeployTarget([], CONFIG, "kept-as-given")).toEqual({ kind: "update", id: "kept-as-given" });
  });

  it("one group serving the configuration is updated, its ids compared canonically", () => {
    expect(resolveDeployTarget([groupOf(G1, CONFIG.toUpperCase()), groupOf(G2, OTHER_CONFIG)], CONFIG)).toEqual({ kind: "update", id: G1 });
    expect(resolveDeployTarget([groupOf(G1, CONFIG)], CONFIG.toUpperCase())).toEqual({ kind: "update", id: G1 });
    // The reply's id canonicalized too; one that isn't an id is kept (the PATCH's segment encodes it).
    expect(resolveDeployTarget([groupOf(G1.toUpperCase(), CONFIG)], CONFIG)).toEqual({ kind: "update", id: G1 });
    expect(resolveDeployTarget([groupOf("g-1", CONFIG)], CONFIG)).toEqual({ kind: "update", id: "g-1" });
  });

  it("none is a create; an unassigned group or a malformed configuration id never matches", () => {
    expect(resolveDeployTarget([groupOf(G1, OTHER_CONFIG), groupOf(G2, null)], CONFIG)).toEqual({ kind: "create" });
    expect(resolveDeployTarget([groupOf(G1, "c1")], "c1")).toEqual({ kind: "create" });
  });

  it("none serving it, no --name: the fleet's Default group when it serves nothing, its id canonical", () => {
    const unassignedDefault = { ...groupOf(G1.toUpperCase(), null, "Default"), isDefault: true };
    expect(resolveDeployTarget([unassignedDefault, groupOf(G2, OTHER_CONFIG)], CONFIG)).toEqual({ kind: "update", id: G1 });
    // --name asks for a new group: the Default group is left alone.
    expect(resolveDeployTarget([unassignedDefault], CONFIG, undefined, { name: "gw" })).toEqual({ kind: "create" });
    expect(resolveDeployTarget([unassignedDefault], CONFIG, undefined, { name: "" })).toEqual({ kind: "create" });
    // A role but node asks for a new group too; --role node alone may still go to the Default group.
    for (const role of ["cluster", "gateway"] as const) {
      expect(resolveDeployTarget([unassignedDefault], CONFIG, undefined, { role })).toEqual({ kind: "create" });
    }
    expect(resolveDeployTarget([unassignedDefault], CONFIG, undefined, { role: "node" })).toEqual({ kind: "update", id: G1 });
    // A Default group serving something (another configuration, or a version the platform can't name) is never taken.
    expect(resolveDeployTarget([{ ...unassignedDefault, configurationId: OTHER_CONFIG }], CONFIG)).toEqual({ kind: "create" });
    expect(resolveDeployTarget([{ ...unassignedDefault, assignedPublishedVersionId: G2 }], CONFIG)).toEqual({ kind: "create" });
    // Only the Default group: another unassigned group isn't; nor a Default whose id isn't an id.
    expect(resolveDeployTarget([groupOf(G1, null)], CONFIG)).toEqual({ kind: "create" });
    expect(resolveDeployTarget([{ ...unassignedDefault, id: "\u001b[2Jdefault" }], CONFIG)).toEqual({ kind: "create" });
    // A group serving the configuration still wins over the Default group.
    expect(resolveDeployTarget([unassignedDefault, groupOf(G2, CONFIG)], CONFIG)).toEqual({ kind: "update", id: G2 });
  });

  it("several are ambiguous, with their canonical ids only", () => {
    expect(resolveDeployTarget([groupOf(G1, CONFIG), groupOf(G2, CONFIG)], CONFIG)).toEqual({ kind: "ambiguous", candidates: [G1, G2] });
    expect(resolveDeployTarget([groupOf(G1.toUpperCase(), CONFIG), groupOf("\u001b[2Jnot-an-id", CONFIG)], CONFIG)).toEqual({ kind: "ambiguous", candidates: [G1] });
  });
});

describe("deployConfiguration", () => {
  const configuration = { id: CONFIG, publishedVersionNumber: 2, versionNumber: 3 };

  it("updates the one group serving it to the highest published version, with replicas and namespace", async () => {
    const { client, calls } = clientOf({
      [`GET /configurations/${CONFIG}`]: { json: configuration },
      [`GET /fleets/${FLEET}/groups`]: { json: { items: [groupOf(G1, CONFIG), groupOf(G2, null)], nextCursor: null } },
      [`PATCH /fleets/${FLEET}/groups/${G1}`]: { json: { ...groupOf(G1, CONFIG), replicas: 3, namespace: "otel" } },
    });
    const result = await deployConfiguration(client, { fleet: FLEET.toUpperCase(), config: CONFIG.toUpperCase(), replicas: 3, namespace: "otel" });
    expect(calls.map(routeOf)).toEqual([`GET /configurations/${CONFIG}`, `GET /fleets/${FLEET}/groups`, `PATCH /fleets/${FLEET}/groups/${G1}`]);
    expect(bodyOf(calls[2])).toEqual({ configurationId: CONFIG, versionNumber: 2, replicas: 3, namespace: "otel" });
    expect(PublicUpdateCollectorGroupRequestSchema.safeParse(bodyOf(calls[2])).success).toBe(true);
    expect(result).toMatchObject({ action: "updated", id: G1, replicas: 3, namespace: "otel", versionNumber: 2 });
  });

  it("a version given skips the configuration's read; a group named skips the list", async () => {
    const { client, calls } = clientOf({
      [`PATCH /fleets/${FLEET}/groups/${G2}`]: { json: groupOf(G2, CONFIG) },
    });
    const result = await deployConfiguration(client, { fleet: FLEET, config: CONFIG, version: 5, group: G2.toUpperCase() });
    expect(calls.map(routeOf)).toEqual([`PATCH /fleets/${FLEET}/groups/${G2}`]);
    expect(bodyOf(calls[0])).toEqual({ configurationId: CONFIG, versionNumber: 5 });
    expect(result.action).toBe("updated");
  });

  it("creates a group named --name when none serves it, with replicas, namespace and role", async () => {
    const { client, calls } = clientOf({
      [`GET /fleets/${FLEET}/groups`]: { json: { items: [groupOf(G1, OTHER_CONFIG)], nextCursor: null } },
      [`POST /fleets/${FLEET}/groups`]: { status: 201, json: { ...groupOf(G2, CONFIG), name: "gw" } },
    });
    const result = await deployConfiguration(client, { fleet: FLEET, config: CONFIG, version: 2, name: "gw", replicas: 2, namespace: "otel", role: "gateway" });
    expect(bodyOf(calls[1])).toEqual({ name: "gw", configurationId: CONFIG, versionNumber: 2, replicas: 2, namespace: "otel", role: "gateway" });
    expect(PublicCreateCollectorGroupRequestSchema.safeParse(bodyOf(calls[1])).success).toBe(true);
    expect(result).toMatchObject({ action: "created", id: G2 });
  });

  it("a configuration with no published version is exit 4 pointing at publish, before the groups are read", async () => {
    const { client, calls } = clientOf({ [`GET /configurations/${CONFIG}`]: { json: { ...configuration, publishedVersionNumber: null } } });
    const error = await refusalOf(deployConfiguration(client, { fleet: FLEET, config: CONFIG }));
    expect(error.exitCode).toBe(EXIT.FAILED);
    expect(error.message).toBe(NOT_PUBLISHED_MESSAGE(CONFIG));
    expect(calls).toHaveLength(1);
  });

  it("several groups serving it is exit 2 listing their ids, never their names; nothing is changed", async () => {
    const { client, calls } = clientOf({
      [`GET /fleets/${FLEET}/groups`]: { json: { items: [groupOf(G1, CONFIG, "alpha-name"), groupOf(G2, CONFIG, "beta-name")], nextCursor: null } },
    });
    const error = await refusalOf(deployConfiguration(client, { fleet: FLEET, config: CONFIG, version: 2 }));
    expect(error).toMatchObject({ exitCode: EXIT.USAGE, code: "collector_group_ambiguous", message: SEVERAL_SERVING_MESSAGE([G1, G2]) });
    expect(error.message.includes("alpha-name") || error.message.includes("beta-name")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("a new fleet's first deploy: no --group, no --name, the version goes to its unassigned Default group", async () => {
    const { client, calls } = clientOf({
      [`GET /configurations/${CONFIG}`]: { json: configuration },
      [`GET /fleets/${FLEET}/groups`]: { json: { items: [{ ...groupOf(G1, null, "Default"), isDefault: true }], nextCursor: null } },
      [`PATCH /fleets/${FLEET}/groups/${G1}`]: { json: { ...groupOf(G1, CONFIG, "Default"), isDefault: true } },
    });
    const result = await deployConfiguration(client, { fleet: FLEET, config: CONFIG });
    expect(calls.map(routeOf)).toEqual([`GET /configurations/${CONFIG}`, `GET /fleets/${FLEET}/groups`, `PATCH /fleets/${FLEET}/groups/${G1}`]);
    expect(bodyOf(calls[2])).toEqual({ configurationId: CONFIG, versionNumber: 2 });
    expect(result).toMatchObject({ action: "updated", id: G1, isDefault: true, configurationId: CONFIG });
  });

  it("a role but node without --name on a new fleet asks for --name (exit 2), never the Default group", async () => {
    const { client, calls } = clientOf({
      [`GET /fleets/${FLEET}/groups`]: { json: { items: [{ ...groupOf(G1, null, "Default"), isDefault: true }], nextCursor: null } },
    });
    for (const role of ["cluster", "gateway"] as const) {
      const error = await refusalOf(deployConfiguration(client, { fleet: FLEET, config: CONFIG, version: 2, role }));
      expect(error).toMatchObject({ exitCode: EXIT.USAGE, message: NAME_NEEDED_MESSAGE(FLEET) });
    }
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("--role node on a create is exit 2 in the CLI's words, nothing created (a new group's role is its name's)", async () => {
    const { client, calls } = clientOf({ [`GET /fleets/${FLEET}/groups`]: { json: { items: [], nextCursor: null } } });
    const error = await refusalOf(deployConfiguration(client, { fleet: FLEET, config: CONFIG, version: 2, name: "agents", role: "node" }));
    expect(error).toMatchObject({ exitCode: EXIT.USAGE, message: NODE_ROLE_ON_CREATE_MESSAGE(FLEET) });
    expect(error.message.includes(`telflo fleet groups ${FLEET}`) && error.message.includes("server fleet")).toBe(true);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("a create without --name is exit 2 naming --group and --name, nothing created", async () => {
    const { client, calls } = clientOf({ [`GET /fleets/${FLEET}/groups`]: { json: { items: [], nextCursor: null } } });
    for (const name of [undefined, ""]) {
      const error = await refusalOf(deployConfiguration(client, { fleet: FLEET.toUpperCase(), config: CONFIG, version: 2, name }));
      expect(error).toMatchObject({ exitCode: EXIT.USAGE, message: NAME_NEEDED_MESSAGE(FLEET) });
    }
    expect(NAME_NEEDED_MESSAGE(FLEET).includes("--group <id>") && NAME_NEEDED_MESSAGE(FLEET).includes(`telflo fleet groups ${FLEET} lists`)).toBe(true);
    expect(NAME_NEEDED_MESSAGE(FLEET).includes("--name")).toBe(true);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("malformed ids are exit 2 before any request", async () => {
    const { client, calls } = clientOf({});
    for (const options of [
      { fleet: "f1", config: CONFIG },
      { fleet: FLEET, config: "c1" },
      { fleet: FLEET, config: CONFIG, group: "g1" },
    ]) {
      expect((await refusalOf(deployConfiguration(client, options))).exitCode).toBe(EXIT.USAGE);
    }
    expect(calls).toHaveLength(0);
  });

  it("passes the API's refusal on (a draft version: 422)", async () => {
    const { client } = clientOf({
      [`GET /fleets/${FLEET}/groups`]: { json: { items: [], nextCursor: null } },
      [`POST /fleets/${FLEET}/groups`]: { status: 422, json: envelope("configuration_version_not_published", "Publish the version first.") },
    });
    await expect(deployConfiguration(client, { fleet: FLEET, config: CONFIG, version: 2, name: "gw" })).rejects.toMatchObject({
      status: 422,
      code: "configuration_version_not_published",
    });
  });
});
