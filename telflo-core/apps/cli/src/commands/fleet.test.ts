import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, routedFetch, type FakeFetch } from "../../tests/fake-fetch.js";
import { runCli } from "../../tests/run-cli.js";
import { deleteCredentials, saveCredentials } from "../credentials.js";
import { NO_GROUP_MESSAGE } from "../ops/fleets.js";
import { NO_FLEETS_MESSAGE, NO_GROUPS_MESSAGE } from "./fleet.js";

/*
 * telflo fleet list|create|groups|install (D27 decisions 11 and 28): each
 * command's request and output, against a stub fetch. Install's command
 * is a SECRET: it is made at run time and checked with boolean canaries
 * only (on stdout exactly once, never on stderr, never in an error).
 */

const SERVER = "https://telflo.example";
const ORG = "0b7e8a9c-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const FLEET = "3e1f2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const GROUP = "4f2a3b5c-6d7e-4f80-9bac-1d2e3f4a5b6c";

let token: string;
let fake: FakeFetch;
/** The install command the stub answers: a fresh secret each test. */
let command: string;

const fleet = { id: FLEET, label: "prod-edge", type: "server", status: "active", createdAt: "2026-10-26T00:00:00.000Z" };
const group = {
  id: GROUP,
  fleetId: FLEET,
  name: "Default",
  isDefault: true,
  role: null,
  namespace: null,
  replicas: null,
  assignedPublishedVersionId: null,
  configurationId: null,
  versionNumber: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const installReply = (platform: string, expiresAt: string | null = null) => ({
  fleetId: FLEET,
  fleetType: platform === "kubernetes" ? "kubernetes-supervisor" : "server",
  platform,
  groupId: GROUP,
  groupName: "Default",
  command,
  notes: ["Set BACKEND_API_KEY before you run it."],
  expiresAt,
});

/** How many times `needle` is in `text` (a count: never the text). */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

const bodies = (): unknown[] => fake.calls.map((call) => (call.body === undefined ? undefined : JSON.parse(call.body)));

beforeEach(() => {
  token = `tf_${randomBytes(32).toString("base64url")}`;
  command = `docker run -e OPAMP_TOKEN='${randomBytes(32).toString("base64url")}' ghcr.io/telflo/telflo/collector:0.162.0`;
  deleteCredentials();
  saveCredentials({ version: 1, server: SERVER, token, kind: "person", tokenName: "laptop", organizationId: ORG });
  fake = routedFetch({
    "GET /fleets": { json: { items: [fleet], nextCursor: null } },
    "POST /fleets": (call) => {
      const body = JSON.parse(call.body!) as { label: string; type: string };
      return { status: 201, json: { id: FLEET, label: body.label, type: body.type, tokenId: GROUP, tokenExpiresAt: null } };
    },
    [`GET /fleets/${FLEET}/groups`]: { json: { items: [group], nextCursor: null } },
    [`POST /fleets/${FLEET}/install`]: (call) => {
      const body = JSON.parse(call.body!) as { platform: string };
      return { json: installReply(body.platform, body.platform === "docker" ? null : "2026-10-27T00:00:00.000Z") };
    },
  });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("telflo fleet list", () => {
  it("prints the fleets as a table, X-Telflo-Org sent, every page asked for 100", async () => {
    const result = await runCli(["fleet", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe("id                                    label      type    status  createdAt");
    expect(result.stdout.includes(FLEET) && result.stdout.includes("prod-edge")).toBe(true);
    expect(fake.calls[0]?.url.searchParams.get("limit")).toBe("100");
    expect(fake.calls[0]?.headers.get("x-telflo-org")).toBe(ORG);
  });

  it("prints the array with --json, and No fleets. for none", async () => {
    expect(JSON.parse((await runCli(["--json", "fleet", "list"])).stdout)).toEqual([fleet]);
    fake = routedFetch({ "GET /fleets": { json: { items: [], nextCursor: null } } });
    vi.stubGlobal("fetch", fake.fetch);
    expect((await runCli(["fleet", "list"])).stdout === `${NO_FLEETS_MESSAGE}\n`).toBe(true);
  });

  it("exits 3 when not logged in", async () => {
    deleteCredentials();
    expect((await runCli(["fleet", "list"])).code).toBe(3);
  });
});

describe("telflo fleet create", () => {
  it("creates the fleet and prints its id and token id, then the next steps: deploy, then install for its type (Ruling 248)", async () => {
    const result = await runCli(["fleet", "create", "--label", "edge", "--type", "kubernetes-supervisor", "--expires-in", "1y"]);
    expect(result.code).toBe(0);
    expect(bodies()).toEqual([{ label: "edge", type: "kubernetes-supervisor", expiresIn: "1y" }]);
    const steps = (platform: string): string =>
      [
        `Created fleet "edge" (${FLEET}). Connection token id: ${GROUP}.`,
        "Next, deploy a published configuration to its Default group, then install a collector:",
        `  telflo deploy --fleet ${FLEET} --config <configuration-id>`,
        `  telflo fleet install ${FLEET} --platform ${platform}`,
        "",
      ].join("\n");
    expect(result.stdout === steps("kubernetes")).toBe(true);
    expect((await runCli(["fleet", "create", "--label", "edge", "--type", "server"])).stdout === steps("docker")).toBe(true);
    const server = await runCli(["--json", "fleet", "create", "--label", "edge", "--type", "server"]);
    expect(JSON.parse(server.stdout)).toEqual({ id: FLEET, label: "edge", type: "server", tokenId: GROUP, tokenExpiresAt: null });
    expect(bodies()[2]).toEqual({ label: "edge", type: "server" });
  });

  it("strips control characters from the fleet's label (Ruling 237)", async () => {
    const result = await runCli(["fleet", "create", "--label", "\u001b]0;edge\u0007", "--type", "server"]);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('Created fleet "]0;edge" (')).toBe(true);
  });

  it("refuses the older CLI's server-supervisor, an unknown expiry and a missing type before any request (exit 2)", async () => {
    for (const args of [
      ["--label", "edge", "--type", "server-supervisor"],
      ["--label", "edge", "--type", "server", "--expires-in", "3y"],
      ["--label", "edge"],
    ]) {
      expect((await runCli(["fleet", "create", ...args])).code).toBe(2);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("a read token's refusal is exit 3; a taken label is the API's words, exit 1", async () => {
    fake = routedFetch({ "POST /fleets": { status: 403, json: envelope("insufficient_access", "This token can't make changes.") } });
    vi.stubGlobal("fetch", fake.fetch);
    expect((await runCli(["fleet", "create", "--label", "edge", "--type", "server"])).code).toBe(3);
    fake = routedFetch({ "POST /fleets": { status: 409, json: envelope("fleet_label_taken", "A fleet with this label exists.") } });
    vi.stubGlobal("fetch", fake.fetch);
    const taken = await runCli(["--json", "fleet", "create", "--label", "edge", "--type", "server"]);
    expect(taken.code).toBe(1);
    expect(JSON.parse(taken.stderr)).toEqual({ error: { code: "fleet_label_taken", message: "A fleet with this label exists.", status: 409 } });
  });
});

describe("telflo fleet groups", () => {
  it("lists the fleet's groups, the id canonicalized", async () => {
    const result = await runCli(["fleet", "groups", FLEET.toUpperCase()]);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")[0]?.startsWith("id")).toBe(true);
    expect(result.stdout.includes(GROUP) && result.stdout.includes("Default")).toBe(true);
    expect(JSON.parse((await runCli(["--json", "fleet", "groups", FLEET])).stdout)).toEqual([group]);
  });

  it("says so for no groups, and refuses a malformed id before the login is read (exit 2)", async () => {
    fake = routedFetch({ [`GET /fleets/${FLEET}/groups`]: { json: { items: [], nextCursor: null } } });
    vi.stubGlobal("fetch", fake.fetch);
    expect((await runCli(["fleet", "groups", FLEET])).stdout === `${NO_GROUPS_MESSAGE}\n`).toBe(true);
    deleteCredentials();
    expect((await runCli(["fleet", "groups", "prod"])).code).toBe(2);
  });
});

describe("telflo fleet install (the command is a secret)", () => {
  it("docker: the command once on stdout, alone; the notes on stderr; the flags sent", async () => {
    const result = await runCli(["fleet", "install", FLEET, "--platform", "docker", "--display-name", "web-1", "--env", "API_KEY=k", "--env", "B=x=y"]);
    expect(result.code).toBe(0);
    expect(bodies()).toEqual([
      {
        platform: "docker",
        displayName: "web-1",
        env: [
          { name: "API_KEY", value: "k" },
          { name: "B", value: "x=y" },
        ],
      },
    ]);
    expect(result.stdout === `${command}\n`).toBe(true);
    expect(countOf(result.stdout, command) === 1).toBe(true);
    expect(result.stderr.includes(command)).toBe(false);
    expect(result.stderr.includes(`group "Default" (${GROUP})`)).toBe(true);
    expect(result.stderr.includes("# Set BACKEND_API_KEY before you run it.")).toBe(true);
    expect(result.stderr.includes("link works until")).toBe(false);
  });

  it("linux: arch, rootPath and systemd always sent (the defaults, then the flags); the link's expiry noted", async () => {
    const defaults = await runCli(["fleet", "install", FLEET, "--platform", "linux"]);
    expect(defaults.code).toBe(0);
    const given = await runCli([
      "fleet",
      "install",
      FLEET,
      "--platform",
      "linux",
      "--group",
      GROUP.toUpperCase(),
      "--arch",
      "arm64",
      "--root-path",
      "/opt/otel",
      "--no-systemd",
    ]);
    expect(given.code).toBe(0);
    expect(bodies()).toEqual([
      { platform: "linux", arch: "amd64", rootPath: "/etc/otelcol", systemd: true },
      { platform: "linux", groupId: GROUP, arch: "arm64", rootPath: "/opt/otel", systemd: false },
    ]);
    expect(given.stderr.includes("# The command's link works until 2026-10-27T00:00:00.000Z.")).toBe(true);
    expect(countOf(given.stdout, command) === 1 && !given.stderr.includes(command)).toBe(true);
  });

  it("kubernetes: the group only", async () => {
    const result = await runCli(["fleet", "install", FLEET, "--platform", "kubernetes", "--group", GROUP]);
    expect(result.code).toBe(0);
    expect(bodies()).toEqual([{ platform: "kubernetes", groupId: GROUP }]);
    expect(countOf(result.stdout, command) === 1).toBe(true);
  });

  it("strips control characters from the reply's words on stderr (Ruling 237), the command left byte-exact", async () => {
    fake = routedFetch({
      [`POST /fleets/${FLEET}/install`]: { json: { ...installReply("docker"), groupName: "\u001b[2JDefault", notes: ["\u009b31mSet it\u0007"] } },
    });
    vi.stubGlobal("fetch", fake.fetch);
    const result = await runCli(["fleet", "install", FLEET, "--platform", "docker"]);
    expect(result.code).toBe(0);
    // eslint-disable-next-line no-control-regex -- the check is "no control character but the newline"
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(result.stderr)).toBe(false);
    expect(result.stderr.includes('group "[2JDefault"') && result.stderr.includes("# 31mSet it\n")).toBe(true);
    expect(result.stdout === `${command}\n`).toBe(true);
  });

  it("--json prints the whole reply to stdout once, nothing on stderr", async () => {
    const result = await runCli(["--json", "fleet", "install", FLEET, "--platform", "docker"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.command === command).toBe(true);
    expect({ ...parsed, command: undefined }).toEqual({ ...installReply("docker"), command: undefined });
    expect(countOf(result.stdout, JSON.stringify(command)) === 1).toBe(true);
    expect(result.stderr === "").toBe(true);
  });

  it("refuses an unknown platform, linux's flags elsewhere, a malformed --env or fleet id, before any request (exit 2)", async () => {
    for (const args of [
      [FLEET, "--platform", "windows"],
      [FLEET],
      [FLEET, "--platform", "docker", "--arch", "arm64"],
      [FLEET, "--platform", "docker", "--no-systemd"],
      [FLEET, "--platform", "linux", "--arch", "s390x"],
      [FLEET, "--platform", "kubernetes", "--display-name", "x"],
      [FLEET, "--platform", "docker", "--env", "NOPE"],
      [FLEET, "--platform", "docker", "--group", "default"],
      ["prod", "--platform", "docker"],
    ]) {
      const result = await runCli(["fleet", "install", ...args]);
      expect(result.code).toBe(2);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a usage error before the login is read: logged out, it is exit 2, not 3", async () => {
    deleteCredentials();
    for (const args of [
      [FLEET, "--platform", "docker", "--arch", "arm64"],
      [FLEET, "--platform", "kubernetes", "--display-name", "x"],
      [FLEET, "--platform", "docker", "--env", "NOPE"],
      [FLEET, "--platform", "docker", "--group", "default"],
    ]) {
      expect((await runCli(["fleet", "install", ...args])).code).toBe(2);
    }
    expect((await runCli(["fleet", "install", FLEET, "--platform", "docker"])).code).toBe(3);
    expect(fake.calls).toHaveLength(0);
  });

  it("a group-less Kubernetes fleet says to run telflo deploy (Preflight ruling 8); a read token is exit 3; neither prints a command", async () => {
    fake = routedFetch({
      [`POST /fleets/${FLEET}/install`]: {
        status: 422,
        json: envelope("collector_group_required", "This fleet has several groups: name the group to install in groupId.", { groupIds: [] }),
      },
    });
    vi.stubGlobal("fetch", fake.fetch);
    const none = await runCli(["fleet", "install", FLEET, "--platform", "kubernetes"]);
    expect(none.code).toBe(1);
    expect(none.stderr === `error: ${NO_GROUP_MESSAGE}\n`).toBe(true);
    expect(none.stdout === "").toBe(true);
    const json = await runCli(["--json", "fleet", "install", FLEET, "--platform", "kubernetes"]);
    expect(json.stdout.includes(command) || json.stderr.includes(command)).toBe(false);
    expect(JSON.parse(json.stderr)).toEqual({ error: { code: "collector_group_required", message: NO_GROUP_MESSAGE, status: 422 } });

    fake = routedFetch({ [`POST /fleets/${FLEET}/install`]: { status: 403, json: envelope("insufficient_access", "Read only.") } });
    vi.stubGlobal("fetch", fake.fetch);
    const read = await runCli(["fleet", "install", FLEET, "--platform", "docker"]);
    expect(read.code).toBe(3);
    expect(read.stdout === "").toBe(true);
  });
});
