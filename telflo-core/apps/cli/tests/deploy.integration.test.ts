import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addApiToken, addConfiguration, addConfigurationVersion, addServiceAccount, truncateAll } from "@telflo/db/testing";
import { sha256Hex } from "../../api/src/opamp-server/client.js";
import { deleteCredentials } from "../src/credentials.js";
import { SEVERAL_SERVING_MESSAGE } from "../src/ops/deploy.js";
import { runCli, serviceAccountWithToken, useApiServer } from "./harness.js";

/*
 * telflo deploy against the real API in process (D27 decisions 28 and
 * 33), its opamp-server the harness's fake: a create with --name, the
 * update of the one group serving the configuration, the ambiguity of two,
 * the envelope's refusals and a read token. Tokens are checked with
 * boolean canaries only.
 */

const api = useApiServer();

const COLLECTOR_VERSION = "0.162.0";
const YAML = ["receivers:", "  otlp:", "    protocols:", "      grpc: {}", "exporters:", "  debug: {}", ""].join("\n");

let tokens: string[];

const holdsToken = (...texts: string[]): boolean => texts.some((text) => tokens.some((token) => text.includes(token)));

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  deleteCredentials();
  tokens = [];
  api.logLines.length = 0;
});

afterEach(() => {
  expect(holdsToken(...api.logLines)).toBe(false);
});

/** A logged-in service account (write) of a new organization. */
async function loggedIn(): Promise<{ organizationId: string }> {
  const account = await serviceAccountWithToken(api.ownerDb);
  tokens.push(account.token);
  expect((await runCli(["login", "--server", api.origin], { input: account.token })).code).toBe(0);
  return account;
}

/** A configuration with `versions` versions, those listed in `published` published (in the platform and the fake). */
async function configurationOf(organizationId: string, versions: number, published: readonly number[]): Promise<string> {
  // The logged-in service account makes it: a draft is its creator's only.
  const creator = await api.ownerDb
    .selectFrom("api_tokens")
    .select("service_account_user_id as user_id")
    .where("organization_id", "=", organizationId)
    .executeTakeFirstOrThrow();
  const configuration = await addConfiguration(api.ownerDb, { organizationId, created_by_user_id: creator.user_id, name: `otlp-${randomUUID()}` });
  for (let number = 1; number <= versions; number += 1) {
    const isPublished = published.includes(number);
    const version = await addConfigurationVersion(api.ownerDb, {
      configurationId: configuration.id,
      organizationId,
      created_by_user_id: creator.user_id,
      version_number: number,
      yaml_content: YAML,
      collector_distribution: "otelcol-contrib",
      collector_version: COLLECTOR_VERSION,
      ...(isPublished && { publishedAt: new Date(), publishedByUserId: creator.user_id }),
    });
    if (isPublished) {
      const result = await api.opamp.client.postPublication(organizationId, version.publication_id as string, {
        configuration: { id: configuration.id, name: configuration.name },
        version: { id: version.id, number, label: null },
        yaml: YAML,
        sha256: sha256Hex(YAML),
        publishedBy: null,
        publishedAt: new Date().toISOString(),
        collector: { distribution: "otelcol-contrib", version: COLLECTOR_VERSION },
      });
      expect(result.kind).toBe("created");
    }
  }
  return configuration.id;
}

async function fleetOf(type: "server" | "kubernetes-supervisor" = "server"): Promise<string> {
  const created = await runCli(["--json", "fleet", "create", "--label", `edge-${randomUUID()}`, "--type", type]);
  expect(created.code).toBe(0);
  return (JSON.parse(created.stdout) as { id: string }).id;
}

interface Group {
  id: string;
  name: string;
  isDefault: boolean;
  configurationId: string | null;
  versionNumber: number | null;
  replicas: number | null;
  namespace: string | null;
  role: string | null;
}

async function groupsOf(fleetId: string): Promise<Group[]> {
  return JSON.parse((await runCli(["--json", "fleet", "groups", fleetId])).stdout) as Group[];
}

describe("telflo deploy", () => {
  it("creates a group with --name at the highest published version, then updates the one serving it", async () => {
    const { organizationId } = await loggedIn();
    const fleetId = await fleetOf();
    const configurationId = await configurationOf(organizationId, 3, [1, 2]);

    const created = await runCli(["deploy", "--fleet", fleetId, "--config", configurationId.toUpperCase(), "--name", "edge-east"]);
    expect(created.code).toBe(0);
    const east = (await groupsOf(fleetId)).find((group) => group.name === "edge-east")!;
    expect(created.stdout === `Created group ${east.id} serving v2.\n`).toBe(true);
    expect(east).toMatchObject({ isDefault: false, configurationId, versionNumber: 2 });

    const updated = await runCli(["--json", "deploy", "--fleet", fleetId, "--config", configurationId, "--version", "1"]);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({ action: "updated", id: east.id, configurationId, versionNumber: 1 });
    // The Default group (unassigned) is untouched.
    expect((await groupsOf(fleetId)).find((group) => group.isDefault)).toMatchObject({ configurationId: null });
  });

  it("two groups serving the configuration: exit 2 listing their ids; --group picks one", async () => {
    const { organizationId } = await loggedIn();
    const fleetId = await fleetOf();
    const configurationId = await configurationOf(organizationId, 1, [1]);
    expect((await runCli(["deploy", "--fleet", fleetId, "--config", configurationId, "--name", "edge-east"])).code).toBe(0);
    const defaultId = (await groupsOf(fleetId)).find((group) => group.isDefault)!.id;
    expect((await runCli(["deploy", "--fleet", fleetId, "--config", configurationId, "--group", defaultId.toUpperCase()])).code).toBe(0);

    const ambiguous = await runCli(["deploy", "--fleet", fleetId, "--config", configurationId]);
    expect(ambiguous.code).toBe(2);
    const serving = (await groupsOf(fleetId)).filter((group) => group.configurationId === configurationId).map((group) => group.id);
    expect(serving).toHaveLength(2);
    expect(ambiguous.stderr === `error: ${SEVERAL_SERVING_MESSAGE(serving)}\n`).toBe(true);
    expect(ambiguous.stderr.includes("edge-east")).toBe(false);
  });

  it("a Kubernetes fleet: a gateway pool with its namespace, replicas and role; the Agent updated with --group", async () => {
    const { organizationId } = await loggedIn();
    const fleetId = await fleetOf("kubernetes-supervisor");
    const configurationId = await configurationOf(organizationId, 1, [1]);
    const gateway = await runCli([
      "--json",
      "deploy",
      "--fleet",
      fleetId,
      "--config",
      configurationId,
      "--name",
      "traces",
      "--replicas",
      "3",
      "--namespace",
      "tracing",
      "--role",
      "gateway",
    ]);
    expect(gateway.code).toBe(0);
    expect(JSON.parse(gateway.stdout)).toMatchObject({ action: "created", name: "traces", role: "gateway", namespace: "tracing", replicas: 3, versionNumber: 1 });
    const agentId = (await groupsOf(fleetId)).find((group) => group.isDefault)!.id;
    const agent = await runCli(["--json", "deploy", "--fleet", fleetId, "--config", configurationId, "--group", agentId, "--namespace", "nodes"]);
    expect(JSON.parse(agent.stdout)).toMatchObject({ action: "updated", id: agentId, role: "node", namespace: "nodes", configurationId });
  });

  it("the envelope's refusals: no published version exit 4, a draft or missing version exit 1 in the API's words, another organization's fleet exit 1", async () => {
    const { organizationId } = await loggedIn();
    const fleetId = await fleetOf();
    const draft = await configurationOf(organizationId, 2, [1]);
    const unpublished = await configurationOf(organizationId, 1, []);

    const none = await runCli(["deploy", "--fleet", fleetId, "--config", unpublished, "--name", "edge"]);
    expect(none.code).toBe(4);
    expect(none.stderr.includes(`telflo config publish ${unpublished}`)).toBe(true);

    for (const [version, code] of [
      ["2", "configuration_version_not_published"],
      ["9", "configuration_version_not_found"],
    ] as const) {
      const refused = await runCli(["--json", "deploy", "--fleet", fleetId, "--config", draft, "--version", version, "--name", "edge"]);
      expect(refused.code).toBe(1);
      expect((JSON.parse(refused.stderr) as { error: { code: string } }).error.code).toBe(code);
    }
    const missingFleet = await runCli(["--json", "deploy", "--fleet", randomUUID(), "--config", draft, "--name", "edge"]);
    expect(missingFleet.code).toBe(1);
    expect((JSON.parse(missingFleet.stderr) as { error: { code: string } }).error.code).toBe("fleet_not_found");
    expect((await groupsOf(fleetId)).map((group) => group.name)).toEqual(["Default"]);
  });

  it("a read token is exit 3, nothing changed", async () => {
    const { organizationId } = await loggedIn();
    const fleetId = await fleetOf();
    const configurationId = await configurationOf(organizationId, 1, [1]);
    const createdAt = new Date(Date.now() - 60_000);
    const { user } = await addServiceAccount(api.ownerDb, { organizationId, createdAt });
    const read = await addApiToken(api.ownerDb, { organizationId, serviceAccountUserId: user.id, access: "read", created_at: createdAt });
    tokens.push(read.token);
    expect((await runCli(["login", "--server", api.origin], { input: read.token })).code).toBe(0);
    const refused = await runCli(["deploy", "--fleet", fleetId, "--config", configurationId, "--name", "edge"]);
    expect(refused.code).toBe(3);
    expect(refused.stderr === "error: This token is read-only: it can't make changes.\n").toBe(true);
    expect(holdsToken(refused.stdout, refused.stderr)).toBe(false);
    expect((await groupsOf(fleetId)).map((group) => group.name)).toEqual(["Default"]);
  });
});
