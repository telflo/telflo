import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { containerCommand, helmQuickDeployCommand, QUICK_DEPLOY_URL_PATTERN, quickDeployCommands } from "@telflo/contracts";
import { addApiToken, addConfiguration, addConfigurationVersion, addServiceAccount, truncateAll } from "@telflo/db/testing";
import { sha256Hex, type OpampServerClient } from "../../api/src/opamp-server/client.js";
import { loadSettings } from "../../api/src/settings.js";
import { ApiClient } from "../src/api.js";
import { deleteCredentials } from "../src/credentials.js";
import { NO_GROUP_MESSAGE } from "../src/ops/fleets.js";
import { addGroupOrganization, personWithToken, runCli, serviceAccountWithToken, useApiServer, type CliRun } from "./harness.js";

/*
 * telflo fleet list|create|groups|install against the real API in process,
 * its opamp-server the harness's fake.
 *
 * SECRETS: the `tf_` tokens, the fleet's bearers (recorded from the fake's
 * answers, never printed), a link's secret and install's command are
 * checked with boolean canaries only: the command is compared with the
 * shared builders' output for the same inputs as a boolean (`===`), counted
 * on stdout, and searched for in stderr and every line the API logged.
 */

/** Every bearer the fake answered the server (a reveal's, a create's), in memory only. */
let bearers: string[] = [];

const api = useApiServer(() => ({
  opampServer: new Proxy({} as OpampServerClient, {
    get(_target, property) {
      const operation = property as keyof OpampServerClient;
      return async (...args: unknown[]) => {
        const result = await (api.opamp.client[operation] as (...given: unknown[]) => Promise<unknown>)(...args);
        const answer = result as { kind?: string; token?: { bearer?: string }; tokens?: { default: { bearer: string }; rotate: { bearer: string } } };
        if (answer.kind === "revealed" && typeof answer.token?.bearer === "string") bearers.push(answer.token.bearer);
        if (answer.kind === "created" && answer.tokens !== undefined) bearers.push(answer.tokens.default.bearer, answer.tokens.rotate.bearer);
        return result;
      };
    },
  }),
}));

/** The collector version the catalog offers with binaries for every Linux platform (the api's install tests'). */
const COLLECTOR_VERSION = "0.162.0";
/** A YAML reading two variables, NGINX_ENV and BACKEND_API_KEY. */
const YAML = [
  "receivers:",
  "  filelog:",
  "    include: [/var/log/nginx/*.log]",
  "exporters:",
  "  otlphttp:",
  "    endpoint: https://backend.example.com",
  "    headers:",
  "      x-env: ${env:NGINX_ENV}",
  "      x-key: ${env:BACKEND_API_KEY}",
  "",
].join("\n");
/** A variable's value: configuration text, never logged. */
const VALUE = "prod-value-canary-4b17";

let secrets: string[];

/** Whether any text holds any secret of the test (a boolean: none is printed). */
const holdsSecret = (...texts: string[]): boolean => texts.some((text) => [...secrets, ...bearers].some((secret) => text.includes(secret)));
/** How many times `needle` is in `text` (a count, never the text). */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1;
/** The link's URL in a command (its curl config line), or undefined: never printed. */
const linkOf = (command: string): string | undefined => /printf 'url = "%s"\\n' '([^']+)'/.exec(command)?.[1];

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  deleteCredentials();
  secrets = [];
  bearers = [];
  api.logLines.length = 0;
});

/** A logged-in service account (write by default) of a new organization. */
async function loggedIn(access: "read" | "write" = "write"): Promise<{ organizationId: string; token: string }> {
  const account = await serviceAccountWithToken(api.ownerDb, access);
  secrets.push(account.token);
  expect((await runCli(["login", "--server", api.origin], { input: account.token })).code).toBe(0);
  return account;
}

/** A configuration of the organization with one version, published in the platform and the fake. */
async function publishedConfiguration(organizationId: string): Promise<string> {
  // The organization's admin (serviceAccountWithToken's) creates it.
  const creator = await api.ownerDb.selectFrom("organization_members").select("user_id").where("organization_id", "=", organizationId).executeTakeFirstOrThrow();
  const configuration = await addConfiguration(api.ownerDb, { organizationId, created_by_user_id: creator.user_id, name: `nginx-${randomUUID()}` });
  const version = await addConfigurationVersion(api.ownerDb, {
    configurationId: configuration.id,
    organizationId,
    created_by_user_id: creator.user_id,
    version_number: 1,
    yaml_content: YAML,
    collector_distribution: "otelcol-contrib",
    collector_version: COLLECTOR_VERSION,
    publishedAt: new Date(),
    publishedByUserId: creator.user_id,
  });
  const result = await api.opamp.client.postPublication(organizationId, version.publication_id as string, {
    configuration: { id: configuration.id, name: configuration.name },
    version: { id: version.id, number: 1, label: null },
    yaml: YAML,
    sha256: sha256Hex(YAML),
    publishedBy: null,
    publishedAt: new Date().toISOString(),
    collector: { distribution: "otelcol-contrib", version: COLLECTOR_VERSION },
  });
  expect(result.kind).toBe("created");
  return configuration.id;
}

/** `fleet create --json`'s fleet. */
async function createdFleet(type: "server" | "kubernetes-supervisor" = "server"): Promise<{ id: string; tokenId: string }> {
  const created = await runCli(["--json", "fleet", "create", "--label", `edge-${randomUUID()}`, "--type", type]);
  expect(created.code).toBe(0);
  return JSON.parse(created.stdout) as { id: string; tokenId: string };
}

/** A fleet whose first group serves a published configuration (through telflo deploy). */
async function deployedFleet(organizationId: string, type: "server" | "kubernetes-supervisor"): Promise<{ fleetId: string; configurationId: string; groupId: string }> {
  const fleet = await createdFleet(type);
  const configurationId = await publishedConfiguration(organizationId);
  const groups = JSON.parse((await runCli(["--json", "fleet", "groups", fleet.id])).stdout) as Array<{ id: string }>;
  const groupId = groups[0]!.id;
  expect((await runCli(["deploy", "--fleet", fleet.id, "--config", configurationId, "--group", groupId])).code).toBe(0);
  return { fleetId: fleet.id, configurationId, groupId };
}

/** The checks every install run passes: the command on stdout alone, once; never on stderr; nothing secret logged. */
function expectCommandOnlyOnStdout(run: CliRun, command: string): void {
  expect(run.code).toBe(0);
  expect(run.stdout === `${command}\n`).toBe(true);
  expect(countOf(run.stdout, command) === 1).toBe(true);
  expect(run.stderr.includes(command) || holdsSecret(run.stderr)).toBe(false);
  expect(api.logLines.some((line) => line.includes(command) || line.includes(VALUE)) || holdsSecret(...api.logLines)).toBe(false);
}

describe("telflo fleet create, list and groups", () => {
  it("creates a fleet (no bearer printed), lists it, and lists its Default group", async () => {
    await loggedIn();
    const create = await runCli(["fleet", "create", "--label", "edge prod", "--type", "server", "--expires-in", "180d"]);
    expect(create.code).toBe(0);
    expect(create.stdout.startsWith('Created fleet "edge prod" (')).toBe(true);
    // The two bearers the opamp-server answered the create: in no output, no log line.
    expect(bearers.length).toBe(2);
    expect(holdsSecret(create.stdout, create.stderr, ...api.logLines)).toBe(false);

    const list = await runCli(["--json", "fleet", "list"]);
    expect(list.code).toBe(0);
    const fleets = JSON.parse(list.stdout) as Array<{ id: string; label: string; type: string; status: string }>;
    expect(fleets.map(({ label, type, status }) => ({ label, type, status }))).toEqual([{ label: "edge prod", type: "server", status: "active" }]);
    expect(create.stdout.includes(`(${fleets[0]!.id})`)).toBe(true);

    const groups = await runCli(["--json", "fleet", "groups", fleets[0]!.id.toUpperCase()]);
    expect(groups.code).toBe(0);
    expect((JSON.parse(groups.stdout) as Array<{ name: string; isDefault: boolean }>).map(({ name, isDefault }) => ({ name, isDefault }))).toEqual([
      { name: "Default", isDefault: true },
    ]);
    const table = await runCli(["fleet", "list"]);
    expect(table.stdout.includes("edge prod") && table.stdout.includes(fleets[0]!.id)).toBe(true);
    expect(holdsSecret(list.stdout, groups.stdout, table.stdout)).toBe(false);
  });

  it("follows every page past 100 fleets", async () => {
    const account = await loggedIn();
    const client = new ApiClient({ server: api.origin, token: account.token });
    for (let index = 0; index < 101; index += 1) {
      await client.request("POST", "/fleets", { body: { label: `edge-${index}`, type: "server" } });
    }
    const list = await runCli(["--json", "fleet", "list"]);
    expect(list.code).toBe(0);
    const labels = (JSON.parse(list.stdout) as Array<{ label: string }>).map((fleet) => fleet.label);
    expect(new Set(labels).size).toBe(101);
  });

  it("works for a person's token in a group organization (X-Telflo-Org)", async () => {
    const person = await personWithToken(api.ownerDb);
    secrets.push(person.token);
    const group = await addGroupOrganization(api.ownerDb, person.userId);
    expect((await runCli(["login", "--server", api.origin, "--org", group.organizationId], { input: person.token })).code).toBe(0);
    const created = await createdFleet("kubernetes-supervisor");
    const groups = JSON.parse((await runCli(["--json", "fleet", "groups", created.id])).stdout) as Array<{ role: string; namespace: string }>;
    expect(groups.map(({ role, namespace }) => ({ role, namespace }))).toEqual([{ role: "node", namespace: "telflo-collectors" }]);
  });

  it("answers the envelope's refusals: a taken label exit 1 in its words, a read token exit 3, another organization's fleet exit 1", async () => {
    await loggedIn();
    expect((await runCli(["fleet", "create", "--label", "edge", "--type", "server"])).code).toBe(0);
    const taken = await runCli(["--json", "fleet", "create", "--label", "edge", "--type", "server"]);
    expect(taken.code).toBe(1);
    expect((JSON.parse(taken.stderr) as { error: { code: string; status: number } }).error).toMatchObject({ code: "fleet_label_taken", status: 409 });
    const theirs = (JSON.parse((await runCli(["--json", "fleet", "list"])).stdout) as Array<{ id: string }>)[0]!.id;

    await loggedIn("read");
    const read = await runCli(["fleet", "create", "--label", "edge two", "--type", "server"]);
    expect(read.code).toBe(3);
    expect(read.stderr === "error: This token is read-only: it can't make changes.\n").toBe(true);
    const elsewhere = await runCli(["--json", "fleet", "groups", theirs]);
    expect(elsewhere.code).toBe(1);
    expect((JSON.parse(elsewhere.stderr) as { error: { code: string } }).error.code).toBe("fleet_not_found");
    expect((await runCli(["--json", "fleet", "list"])).stdout === "[]\n").toBe(true);
  });
});

describe("telflo fleet install (the command is a secret)", () => {
  const settings = loadSettings(process.env);

  it("docker: the dialog's container command, with the fleet's bearer, on stdout once", async () => {
    const account = await loggedIn();
    const { fleetId, groupId } = await deployedFleet(account.organizationId, "server");
    const mark = bearers.length;
    api.logLines.length = 0;
    const run = await runCli(["fleet", "install", fleetId, "--platform", "docker", "--display-name", "edge 1", "--env", `NGINX_ENV=${VALUE}`]);
    const revealed = bearers.slice(mark);
    expect(revealed.length).toBe(1);
    const expected = containerCommand({
      facts: {
        imageTag: `${settings.install.collectorImageRepository}:${COLLECTOR_VERSION}`,
        endpoint: settings.install.agentPublicUrl,
        allowInsecureConnections: settings.install.allowInsecureConnections,
        groupId,
        mounts: [],
      },
      bearer: revealed[0]!,
      displayName: "edge 1",
      env: [{ name: "NGINX_ENV", value: VALUE }],
    });
    expectCommandOnlyOnStdout(run, expected);
    // The secrets are docker's environment, set before it: never its arguments.
    expect(run.stdout.startsWith("OPAMP_TOKEN='")).toBe(true);
    expect(run.stdout.includes(" \\\ndocker run ")).toBe(true);
    expect(run.stderr.startsWith(`# docker install for server fleet ${fleetId}, group "Default" (${groupId})\n`)).toBe(true);
    // The variable not given is named in the notes, on stderr.
    expect(run.stderr.includes("BACKEND_API_KEY")).toBe(true);
  });

  it("linux: the All In One Quick Deploy command with the web's defaults (amd64, /etc/otelcol, systemd), then the flags", async () => {
    const account = await loggedIn();
    const { fleetId } = await deployedFleet(account.organizationId, "server");
    for (const [flags, rootPath, systemd, displayName] of [
      [[], "/etc/otelcol", true, ""],
      [["--arch", "arm64", "--root-path", "/opt/telflo", "--no-systemd", "--display-name", "vm 7"], "/opt/telflo", false, "vm 7"],
    ] as const) {
      const mark = bearers.length;
      api.logLines.length = 0;
      const run = await runCli(["fleet", "install", fleetId, "--platform", "linux", ...flags]);
      const url = linkOf(run.stdout);
      expect(url !== undefined && QUICK_DEPLOY_URL_PATTERN.test(url)).toBe(true);
      const revealed = bearers.slice(mark);
      expect(revealed.length).toBe(1);
      secrets.push(url!);
      const expected = quickDeployCommands({ url: url!, rootPath, bearer: revealed[0]!, displayName, systemd });
      expectCommandOnlyOnStdout(run, expected);
      expect(run.stderr.includes("# The command's link works until ")).toBe(true);
    }
    const links = await api.ownerDb.selectFrom("quick_deploy_links").select("choices").where("fleet_id", "=", fleetId).orderBy("created_at").execute();
    expect(links.map((link) => link.choices)).toMatchObject([
      { method: "all-in-one", arch: "amd64", rootPath: "/etc/otelcol", systemd: true },
      { method: "all-in-one", arch: "arm64", rootPath: "/opt/telflo", systemd: false },
    ]);
  });

  it("kubernetes: the Helm Quick Deploy command for the only group; --json prints the reply once, nothing on stderr", async () => {
    const account = await loggedIn();
    const { fleetId, groupId } = await deployedFleet(account.organizationId, "kubernetes-supervisor");
    api.logLines.length = 0;
    const run = await runCli(["fleet", "install", fleetId, "--platform", "kubernetes"]);
    const url = linkOf(run.stdout);
    expect(url !== undefined && QUICK_DEPLOY_URL_PATTERN.test(url)).toBe(true);
    secrets.push(url!);
    const expected = helmQuickDeployCommand(url!, {
      release: "telflo-node",
      namespace: "telflo-collectors",
      chartReference: settings.install.helmChartReference,
      chartVersion: settings.install.helmChartVersion,
    });
    expectCommandOnlyOnStdout(run, expected);

    const json = await runCli(["--json", "fleet", "install", fleetId, "--platform", "kubernetes", "--group", groupId]);
    expect(json.code).toBe(0);
    expect(json.stderr === "").toBe(true);
    const reply = JSON.parse(json.stdout) as Record<string, unknown>;
    const jsonUrl = linkOf(String(reply.command));
    expect(jsonUrl !== undefined && QUICK_DEPLOY_URL_PATTERN.test(jsonUrl)).toBe(true);
    secrets.push(jsonUrl!);
    expect(countOf(json.stdout, jsonUrl!) === 1).toBe(true);
    expect({ ...reply, command: undefined, expiresAt: typeof reply.expiresAt }).toEqual({
      fleetId,
      fleetType: "kubernetes-supervisor",
      platform: "kubernetes",
      groupId,
      groupName: "Default",
      command: undefined,
      notes: expect.any(Array) as unknown,
      expiresAt: "string",
    });
    expect(holdsSecret(...api.logLines)).toBe(false);
  });

  it("a new fleet's first deploy: fleet create's next steps as printed, deploy without --group, then install succeeds", async () => {
    const account = await loggedIn();
    for (const [type, platform] of [
      ["server", "docker"],
      ["kubernetes-supervisor", "kubernetes"],
    ] as const) {
      const create = await runCli(["fleet", "create", "--label", `edge-${randomUUID()}`, "--type", type]);
      expect(create.code).toBe(0);
      const fleetId = /\(([0-9a-f-]{36})\)/.exec(create.stdout)?.[1] ?? "";
      expect(create.stdout.includes(`  telflo deploy --fleet ${fleetId} --config <configuration-id>\n  telflo fleet install ${fleetId} --platform ${platform}\n`)).toBe(true);
      const configurationId = await publishedConfiguration(account.organizationId);

      const deploy = await runCli(["--json", "deploy", "--fleet", fleetId, "--config", configurationId]);
      expect(deploy.code).toBe(0);
      const groups = JSON.parse((await runCli(["--json", "fleet", "groups", fleetId])).stdout) as Array<{ id: string; isDefault: boolean; configurationId: string | null }>;
      // No second group: the Default group serves the configuration.
      expect(groups.map(({ isDefault, configurationId: served }) => ({ isDefault, served }))).toEqual([{ isDefault: true, served: configurationId }]);
      expect(JSON.parse(deploy.stdout)).toMatchObject({ action: "updated", id: groups[0]!.id, isDefault: true, versionNumber: 1 });

      const install = await runCli(["fleet", "install", fleetId, "--platform", platform]);
      expect(install.code).toBe(0);
      expect(install.stdout.length > 0 && install.stderr.includes(`group "Default" (${groups[0]!.id})`)).toBe(true);
      const url = linkOf(install.stdout);
      if (url !== undefined) secrets.push(url);
      expect(holdsSecret(install.stderr, ...api.logLines)).toBe(false);
    }
  });

  it("several Kubernetes groups and none named: exit 1 listing their ids, no command; a platform that doesn't suit the fleet: the API's words", async () => {
    const account = await loggedIn();
    const { fleetId, configurationId, groupId } = await deployedFleet(account.organizationId, "kubernetes-supervisor");
    // A second group (deploy would update the one serving the configuration): through the API.
    const client = new ApiClient({ server: api.origin, token: account.token });
    const gateway = await client.request<{ id: string }>("POST", `/fleets/${fleetId}/groups`, {
      body: { name: "traces", configurationId, versionNumber: 1 },
    });
    const gatewayId = gateway.id;
    const several = await runCli(["fleet", "install", fleetId, "--platform", "kubernetes"]);
    expect(several.code).toBe(1);
    expect(several.stdout === "").toBe(true);
    expect(several.stderr.includes("several groups") && several.stderr.includes(groupId) && several.stderr.includes(gatewayId)).toBe(true);
    expect(several.stderr.includes(NO_GROUP_MESSAGE)).toBe(false);

    const unsuited = await runCli(["--json", "fleet", "install", fleetId, "--platform", "docker"]);
    expect(unsuited.code).toBe(1);
    expect(unsuited.stdout === "").toBe(true);
    expect((JSON.parse(unsuited.stderr) as { error: { code: string } }).error.code).toBe("fleet_type_not_installable");
  });

  it("a read token is exit 3 on every platform, nothing revealed", async () => {
    const account = await loggedIn();
    const server = await deployedFleet(account.organizationId, "server");
    // A read token of the same organization: a new service account's.
    const createdAt = new Date(Date.now() - 60_000);
    const { user } = await addServiceAccount(api.ownerDb, { organizationId: account.organizationId, createdAt });
    const read = await addApiToken(api.ownerDb, { organizationId: account.organizationId, serviceAccountUserId: user.id, access: "read", created_at: createdAt });
    secrets.push(read.token);
    expect((await runCli(["login", "--server", api.origin], { input: read.token })).code).toBe(0);
    const mark = bearers.length;
    for (const flags of [["--platform", "docker"], ["--platform", "linux"]]) {
      const run = await runCli(["fleet", "install", server.fleetId, ...flags]);
      expect(run.code).toBe(3);
      expect(run.stdout === "").toBe(true);
    }
    expect(bearers.length).toBe(mark);
    expect(await api.ownerDb.selectFrom("quick_deploy_links").select("id").execute()).toHaveLength(0);
  });
});
