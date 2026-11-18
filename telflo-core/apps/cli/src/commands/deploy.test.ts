import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routedFetch, type FakeFetch } from "../../tests/fake-fetch.js";
import { runCli } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials } from "../credentials.js";
import { NAME_NEEDED_MESSAGE, NODE_ROLE_ON_CREATE_MESSAGE, SEVERAL_SERVING_MESSAGE } from "../ops/deploy.js";
import { positiveInteger, ROLE_ON_UPDATE_NOTE } from "./deploy.js";

/* telflo deploy (D27 decisions 11 and 28): its flags, requests and output, against a stub fetch. */

const SERVER = "https://telflo.example";
const ORG = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const FLEET = "3e1f2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const CONFIG = "5a3b4c6d-7e8f-4091-8bcd-2e3f4a5b6c7d";
const G1 = "7c5d6e8f-9001-42b3-8def-4a5b6c7d8e9f";
const G2 = "8d6e7f90-0112-43c4-9ef0-5b6c7d8e9fa0";

const groupOf = (id: string, configurationId: string | null, versionNumber: number | null = 2) => ({
  id,
  fleetId: FLEET,
  name: "edge",
  isDefault: false,
  role: null,
  namespace: null,
  replicas: null,
  assignedPublishedVersionId: null,
  configurationId,
  versionNumber,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
});

let fake: FakeFetch;

function serve(groups: unknown[], answered = groupOf(G1, CONFIG)): void {
  fake = routedFetch({
    [`GET /configurations/${CONFIG}`]: { json: { id: CONFIG, publishedVersionNumber: 2, versionNumber: 3 } },
    [`GET /fleets/${FLEET}/groups`]: { json: { items: groups, nextCursor: null } },
    [`PATCH /fleets/${FLEET}/groups/${G1}`]: { json: answered },
    [`POST /fleets/${FLEET}/groups`]: { status: 201, json: answered },
  });
  vi.stubGlobal("fetch", fake.fetch);
}

const routes = (): string[] => fake.calls.map((call) => `${call.method} ${call.url.pathname.replace("/api/public/v1", "")}`);

beforeEach(() => {
  deleteCredentials();
  saveCredentials({
    version: 1,
    server: SERVER,
    token: `tf_${randomBytes(32).toString("base64url")}`,
    kind: "person",
    tokenName: "laptop",
    organizationId: ORG,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("positiveInteger", () => {
  it("takes a whole number of at least 1 only", () => {
    expect(positiveInteger("3")).toBe(3);
    for (const value of ["0", "-1", "1.5", "two", "", "1e3", "9999999999"]) expect(() => positiveInteger(value)).toThrow("at least 1");
  });
});

describe("telflo deploy", () => {
  it("updates the group serving the configuration to its highest published version", async () => {
    serve([groupOf(G1, CONFIG, 1)]);
    const result = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG]);
    expect(result.code).toBe(0);
    expect(routes()).toEqual([`GET /configurations/${CONFIG}`, `GET /fleets/${FLEET}/groups`, `PATCH /fleets/${FLEET}/groups/${G1}`]);
    expect(result.stdout === `Group ${G1} now serves v2.\n`).toBe(true);
    expect(result.stderr === "").toBe(true);
  });

  it("notes that --role does nothing for a group that exists, on stderr; nothing for a new group", async () => {
    serve([groupOf(G1, CONFIG)]);
    const updated = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG, "--role", "gateway"]);
    expect(updated.code).toBe(0);
    expect(updated.stderr === `${ROLE_ON_UPDATE_NOTE}\n`).toBe(true);
    expect(JSON.parse(fake.calls[2]!.body!)).toEqual({ configurationId: CONFIG, versionNumber: 2 });
    serve([]);
    const created = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG, "--name", "traces", "--role", "gateway"]);
    expect(created.code === 0 && created.stderr === "").toBe(true);
  });

  it("with --json, the --role note is one JSON object on stderr; stdout the group (Ruling 249)", async () => {
    serve([groupOf(G1, CONFIG)]);
    const result = await runCli(["--json", "deploy", "--fleet", FLEET, "--config", CONFIG, "--role", "gateway"]);
    expect(result.code).toBe(0);
    expect(result.stderr === `${JSON.stringify({ note: ROLE_ON_UPDATE_NOTE })}\n`).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "updated", id: G1 });
  });

  it("a new fleet's first deploy, neither --group nor --name: its unassigned Default group serves the version (Ruling 248)", async () => {
    serve([{ ...groupOf(G1, null, null), name: "Default", isDefault: true }], { ...groupOf(G1, CONFIG), name: "Default", isDefault: true });
    const result = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG]);
    expect(result.code).toBe(0);
    expect(routes()).toEqual([`GET /configurations/${CONFIG}`, `GET /fleets/${FLEET}/groups`, `PATCH /fleets/${FLEET}/groups/${G1}`]);
    expect(result.stdout === `Group ${G1} now serves v2.\n`).toBe(true);
  });

  it("no group serving it and the Default group busy: exit 2 naming --group and --name; --role node on a create exit 2 (nothing created)", async () => {
    serve([{ ...groupOf(G1, "6b4c5d7e-8f90-41a2-9cde-3f4a5b6c7d8e"), isDefault: true }]);
    const unnamed = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG]);
    expect(unnamed.code).toBe(2);
    expect(unnamed.stderr === `error: ${NAME_NEEDED_MESSAGE(FLEET)}\n`).toBe(true);
    const node = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG, "--name", "agents", "--role", "node"]);
    expect(node.code).toBe(2);
    expect(node.stderr === `error: ${NODE_ROLE_ON_CREATE_MESSAGE(FLEET)}\n`).toBe(true);
    expect(routes().some((route) => !route.startsWith("GET"))).toBe(false);
  });

  it("creates a group with --name and its settings, printing JSON with --json", async () => {
    serve([], { ...groupOf(G2, CONFIG, 4), role: "gateway" } as never);
    const result = await runCli([
      "--json",
      "deploy",
      "--fleet",
      FLEET,
      "--config",
      CONFIG,
      "--version",
      "4",
      "--name",
      "traces",
      "--replicas",
      "2",
      "--namespace",
      "otel",
      "--role",
      "gateway",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(fake.calls[1]!.body!)).toEqual({
      name: "traces",
      configurationId: CONFIG,
      versionNumber: 4,
      replicas: 2,
      namespace: "otel",
      role: "gateway",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ action: "created", id: G2, versionNumber: 4, role: "gateway" });
    serve([]);
    expect((await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG, "--name", "traces"])).stdout === `Created group ${G1} serving v2.\n`).toBe(true);
  });

  it("prints no version for a group the reply leaves unassigned", async () => {
    serve([groupOf(G1, CONFIG)], groupOf(G1, null, null));
    expect((await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG, "--group", G1])).stdout === `Group ${G1} now serves.\n`).toBe(true);
  });

  it("strips control characters from the reply's id (Ruling 237)", async () => {
    serve([groupOf(G1, CONFIG)], { ...groupOf(G1, CONFIG), id: `\u001b[2J${G1}` });
    const result = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG]);
    expect(result.stdout === `Group [2J${G1} now serves v2.\n`).toBe(true);
  });

  it("several groups serving it: exit 2 listing their ids", async () => {
    serve([groupOf(G1, CONFIG), groupOf(G2, CONFIG)]);
    const result = await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG]);
    expect(result.code).toBe(2);
    expect(result.stderr === `error: ${SEVERAL_SERVING_MESSAGE([G1, G2])}\n`).toBe(true);
    expect(routes().some((route) => !route.startsWith("GET"))).toBe(false);
  });

  it("refuses bad flags and malformed ids before any request or login (exit 2)", async () => {
    serve([]);
    for (const args of [
      ["--config", CONFIG],
      ["--fleet", FLEET],
      ["--fleet", FLEET, "--config", CONFIG, "--version", "0"],
      ["--fleet", FLEET, "--config", CONFIG, "--replicas", "many"],
      ["--fleet", FLEET, "--config", CONFIG, "--role", "worker"],
      ["--fleet", FLEET, "--config", CONFIG, "--group", G1, "--name", "edge"],
      ["--fleet", "prod", "--config", CONFIG],
      ["--fleet", FLEET, "--config", "nginx"],
      ["--fleet", FLEET, "--config", CONFIG, "--group", "default"],
    ]) {
      expect((await runCli(["deploy", ...args])).code).toBe(2);
    }
    deleteCredentials();
    expect((await runCli(["deploy", "--fleet", "prod", "--config", CONFIG])).code).toBe(2);
    expect(fake.calls).toHaveLength(0);
    expect((await runCli(["deploy", "--fleet", FLEET, "--config", CONFIG])).code).toBe(3);
  });
});
