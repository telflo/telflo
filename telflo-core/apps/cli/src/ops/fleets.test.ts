import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALL_ROOT_PATH as CONTRACTS_DEFAULT_INSTALL_ROOT_PATH,
  FLEET_TYPES as CONTRACTS_FLEET_TYPES,
  INSTALL_ARCHES as CONTRACTS_INSTALL_ARCHES,
  PUBLIC_FLEET_TOKEN_EXPIRIES,
  PUBLIC_INSTALL_PLATFORMS,
  PublicCreateFleetRequestSchema,
  PublicInstallRequestSchema,
} from "@telflo/contracts";
import { envelope, routedFetch, type Answer, type RecordedCall } from "../../tests/fake-fetch.js";
import { ApiClient, ApiError } from "../api.js";
import { EXIT, ExitError } from "../output.js";
import {
  createFleet,
  DEFAULT_INSTALL_ROOT_PATH,
  DISPLAY_NAME_PLATFORM_MESSAGE,
  ENV_FLAG_MESSAGE,
  FLEET_TOKEN_EXPIRIES,
  FLEET_TYPES,
  INSTALL_ARCHES,
  INSTALL_PLATFORMS,
  installFleet,
  installRequestOf,
  LINUX_ONLY_MESSAGE,
  listFleets,
  listGroups,
  NO_GROUP_MESSAGE,
  parseEnvFlags,
  SEVERAL_GROUPS_MESSAGE,
} from "./fleets.js";

/*
 * The fleet calls, on the platform's names, against a stub fetch. Install's
 * command is a SECRET: checked with boolean canaries only.
 */

const SERVER = "https://telflo.example";
const FLEET = "3e1f2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const GROUP = "4f2a3b5c-6d7e-4f80-9bac-1d2e3f4a5b6c";

function clientOf(routes: Parameters<typeof routedFetch>[0]): { client: ApiClient; calls: RecordedCall[] } {
  const fake = routedFetch(routes);
  return { client: new ApiClient({ server: SERVER, token: `tf_${randomBytes(32).toString("base64url")}`, fetch: fake.fetch }), calls: fake.calls };
}

function bodyOf(call: RecordedCall | undefined): unknown {
  return call?.body === undefined ? undefined : JSON.parse(call.body);
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("the choices copied from the contracts", () => {
  it("match the contracts' values", () => {
    expect(FLEET_TYPES).toEqual(CONTRACTS_FLEET_TYPES);
    expect(FLEET_TOKEN_EXPIRIES).toEqual(PUBLIC_FLEET_TOKEN_EXPIRIES);
    expect(INSTALL_PLATFORMS).toEqual(PUBLIC_INSTALL_PLATFORMS);
    expect(INSTALL_ARCHES).toEqual(CONTRACTS_INSTALL_ARCHES);
    expect(DEFAULT_INSTALL_ROOT_PATH).toBe(CONTRACTS_DEFAULT_INSTALL_ROOT_PATH);
  });
});

describe("parseEnvFlags", () => {
  it("parses NAME=value in order, the value keeping any =", () => {
    expect(parseEnvFlags(["A=1", "B=x=y", "C="])).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "x=y" },
      { name: "C", value: "" },
    ]);
    expect(parseEnvFlags(undefined)).toEqual([]);
  });

  it("refuses a flag with no name or no = by its position, never echoing it (exit 2)", () => {
    for (const [flags, position] of [
      [["A=1", "SECRET-VALUE"], 2],
      [["=SECRET-VALUE"], 1],
    ] as const) {
      const error = (() => {
        try {
          parseEnvFlags(flags);
        } catch (caught) {
          return caught as ExitError;
        }
        throw new Error("expected a refusal");
      })();
      expect(error).toBeInstanceOf(ExitError);
      expect(error.exitCode).toBe(EXIT.USAGE);
      expect(error.message).toBe(ENV_FLAG_MESSAGE(position));
      expect(error.message.includes("SECRET-VALUE")).toBe(false);
    }
  });
});

describe("installRequestOf (route 19's body)", () => {
  it("docker: only what was given, env as a list", () => {
    const body = installRequestOf({ platform: "docker", displayName: "web-1", env: ["API_KEY=k"], systemd: true });
    expect(body).toEqual({ platform: "docker", displayName: "web-1", env: [{ name: "API_KEY", value: "k" }] });
    expect(installRequestOf({ platform: "docker", systemd: true })).toEqual({ platform: "docker" });
    expect(PublicInstallRequestSchema.safeParse(body).success).toBe(true);
  });

  it("linux: always arch, rootPath and systemd, with the web's defaults", () => {
    const defaults = installRequestOf({ platform: "linux", systemd: true });
    expect(defaults).toEqual({ platform: "linux", arch: "amd64", rootPath: "/etc/otelcol", systemd: true });
    expect(PublicInstallRequestSchema.safeParse(defaults).success).toBe(true);
    const given = installRequestOf({
      platform: "linux",
      group: GROUP.toUpperCase(),
      displayName: "edge-1",
      arch: "arm64",
      rootPath: "/opt/otelcol",
      systemd: false,
      env: ["DD_API_KEY=abc", "REGION=eu=west"],
    });
    expect(given).toEqual({
      platform: "linux",
      groupId: GROUP,
      displayName: "edge-1",
      arch: "arm64",
      rootPath: "/opt/otelcol",
      systemd: false,
      env: [
        { name: "DD_API_KEY", value: "abc" },
        { name: "REGION", value: "eu=west" },
      ],
    });
    expect(PublicInstallRequestSchema.safeParse(given).success).toBe(true);
    // commander leaves systemd undefined when the command isn't commander's: still true.
    expect(installRequestOf({ platform: "linux" })).toMatchObject({ systemd: true });
  });

  it("kubernetes: the group and env only", () => {
    const body = installRequestOf({ platform: "kubernetes", group: GROUP, env: ["A=1"], systemd: true });
    expect(body).toEqual({ platform: "kubernetes", groupId: GROUP, env: [{ name: "A", value: "1" }] });
    expect(PublicInstallRequestSchema.safeParse(body).success).toBe(true);
  });

  it("refuses linux's flags on another platform, a display name on kubernetes, and a malformed group (exit 2)", () => {
    for (const options of [
      { platform: "docker", arch: "arm64" },
      { platform: "docker", rootPath: "/opt" },
      { platform: "kubernetes", systemd: false },
    ] as const) {
      expect(() => installRequestOf(options)).toThrow(LINUX_ONLY_MESSAGE);
    }
    expect(() => installRequestOf({ platform: "kubernetes", displayName: "x" })).toThrow(DISPLAY_NAME_PLATFORM_MESSAGE);
    expect(() => installRequestOf({ platform: "docker", group: "default" })).toThrow(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });
});

describe("installFleet", () => {
  const reply = (command: string) => ({
    fleetId: FLEET,
    fleetType: "server",
    platform: "docker",
    groupId: GROUP,
    groupName: "Default",
    command,
    notes: [],
    expiresAt: null,
  });

  it("posts the body to the fleet's canonical id and answers the reply as is", async () => {
    const command = `docker run -e OPAMP_TOKEN=${randomBytes(24).toString("base64url")}`;
    const { client, calls } = clientOf({ [`POST /fleets/${FLEET}/install`]: { json: reply(command) } });
    const answered = await installFleet(client, FLEET.toUpperCase(), { platform: "docker", displayName: "web-1", systemd: true });
    expect(answered.command === command).toBe(true);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toEqual({ platform: "docker", displayName: "web-1" });
  });

  it("refuses an unknown fleet id shape and a malformed --env before any request", async () => {
    const { client, calls } = clientOf({});
    expect(await refusalOf(installFleet(client, "fleet-1", { platform: "docker" }))).toMatchObject({ exitCode: EXIT.USAGE });
    expect(await refusalOf(installFleet(client, FLEET, { platform: "docker", env: ["NOPE"] }))).toMatchObject({ exitCode: EXIT.USAGE });
    expect(calls).toHaveLength(0);
  });

  it("says a group-less fleet needs telflo deploy, and lists the ids of several groups", async () => {
    const other = randomUUID();
    const answers: Answer[] = [
      { status: 422, json: envelope("collector_group_required", "This fleet has several groups: name the group to install in groupId.", { groupIds: [] }) },
      {
        status: 422,
        json: envelope("collector_group_required", "This fleet has several groups: name the group to install in groupId.", {
          groupIds: [GROUP.toUpperCase(), other, "not-an-id", 7],
        }),
      },
      { status: 422, json: envelope("collector_group_required", "This fleet has several groups: name the group to install in groupId.") },
    ];
    let index = 0;
    const { client } = clientOf({ [`POST /fleets/${FLEET}/install`]: () => answers[index++]! });
    const none = await refusalOf(installFleet(client, FLEET, { platform: "kubernetes" }));
    expect(none).toBeInstanceOf(ExitError);
    expect(none).toMatchObject({ message: NO_GROUP_MESSAGE, exitCode: EXIT.API, code: "collector_group_required", status: 422 });
    const several = await refusalOf(installFleet(client, FLEET, { platform: "kubernetes" }));
    expect(several).toMatchObject({ message: SEVERAL_GROUPS_MESSAGE([GROUP, other]), exitCode: EXIT.API, code: "collector_group_required", status: 422 });
    expect(await refusalOf(installFleet(client, FLEET, { platform: "kubernetes" }))).toMatchObject({ message: NO_GROUP_MESSAGE });
  });

  it("rewords only the words: the exit code, code and status are the refusal's own ending", async () => {
    const { client } = clientOf({
      [`POST /fleets/${FLEET}/install`]: { status: 403, json: envelope("collector_group_required", "Refused.", { groupIds: [] }) },
    });
    expect(await refusalOf(installFleet(client, FLEET, { platform: "kubernetes" }))).toMatchObject({
      message: NO_GROUP_MESSAGE,
      exitCode: EXIT.AUTH,
      code: "collector_group_required",
      status: 403,
    });
  });

  it("passes every other refusal on as the API's", async () => {
    const { client } = clientOf({
      [`POST /fleets/${FLEET}/install`]: { status: 422, json: envelope("fleet_type_not_installable", "This platform doesn't suit the fleet's type.") },
    });
    const error = await refusalOf(installFleet(client, FLEET, { platform: "kubernetes" }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "fleet_type_not_installable" });
  });
});

describe("listFleets, createFleet and listGroups", () => {
  it("listFleets follows every page", async () => {
    const first = { id: FLEET, label: "prod", type: "server", status: "active", createdAt: "2026-10-26T00:00:00.000Z" };
    const second = { ...first, id: randomUUID(), label: "edge" };
    const { client, calls } = clientOf({
      "GET /fleets": (call) => (call.url.searchParams.get("cursor") === null ? { json: { items: [first], nextCursor: "next" } } : { json: { items: [second], nextCursor: null } }),
    });
    expect(await listFleets(client)).toEqual([first, second]);
    expect(calls.map((call) => call.url.searchParams.get("limit"))).toEqual(["100", "100"]);
  });

  it("createFleet sends the label, the type and the expiry only when given", async () => {
    const created = { id: FLEET, label: "edge", type: "server", tokenId: randomUUID(), tokenExpiresAt: null };
    const { client, calls } = clientOf({ "POST /fleets": { status: 201, json: created } });
    expect(await createFleet(client, { label: "edge", type: "server", expiresIn: "1y" })).toEqual(created);
    await createFleet(client, { label: "edge", type: "kubernetes-supervisor" });
    expect(calls.map(bodyOf)).toEqual([
      { label: "edge", type: "server", expiresIn: "1y" },
      { label: "edge", type: "kubernetes-supervisor" },
    ]);
    expect(calls.every((call) => PublicCreateFleetRequestSchema.safeParse(bodyOf(call)).success)).toBe(true);
  });

  it("listGroups reads the canonical fleet's groups", async () => {
    const group = { id: GROUP, name: "Default" };
    const { client, calls } = clientOf({ [`GET /fleets/${FLEET}/groups`]: { json: { items: [group], nextCursor: null } } });
    expect(await listGroups(client, FLEET.toUpperCase())).toEqual([group]);
    expect(calls).toHaveLength(1);
    expect(await refusalOf(listGroups(client, "nope"))).toMatchObject({ exitCode: EXIT.USAGE });
  });
});
