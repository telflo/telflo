import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addConfiguration, addConfigurationVersion, addValidationPipeline, addValidationRule, truncateAll } from "@telflo/db/testing";
import { NO_PIPELINES_MESSAGE } from "../src/commands/config-rules.js";
import { runCli, serviceAccountWithToken, useApiServer, type CliRun } from "./harness.js";

/*
 * telflo config rules against the real API in process (D27 decisions 27
 * and 33, route 13): a read token lists a version's saved pipelines and
 * rules (the latest version by default); another organization's
 * configuration is the API's 404. Tokens: boolean canaries only.
 */

const api = useApiServer();

const RULE_MARKER = "cli-saved-rule-marker-5b2e";
let tokens: string[];

async function cli(token: string, args: readonly string[]): Promise<CliRun> {
  vi.stubEnv("TELFLO_TOKEN", token);
  vi.stubEnv("TELFLO_SERVER", api.origin);
  const ran = await runCli(args);
  expect(tokens.some((each) => ran.stdout.includes(each) || ran.stderr.includes(each))).toBe(false);
  return ran;
}

beforeEach(async () => {
  await truncateAll(api.ownerDb);
  tokens = [];
  api.logLines.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  const logged = api.logLines.join("\n");
  expect(tokens.some((token) => logged.includes(token))).toBe(false);
  expect(logged.includes(RULE_MARKER)).toBe(false);
});

/** A published configuration of `organizationId` with versions 1 and 2, a saved logs/in pipeline on version 2. */
async function configurationWithRules(organizationId: string) {
  const configuration = await addConfiguration(api.ownerDb, { organizationId });
  const versions = [];
  for (const versionNumber of [1, 2]) {
    versions.push(
      await addConfigurationVersion(api.ownerDb, {
        configurationId: configuration.id,
        organizationId,
        version_number: versionNumber,
        yaml_content: "service:\n  pipelines:\n    logs/in: {}\n",
        publishedAt: new Date(),
      }),
    );
  }
  const ids = { organizationId, configurationId: configuration.id, configurationVersionId: versions[1]!.id };
  const pipeline = await addValidationPipeline(api.ownerDb, { ...ids, pipeline_name: "logs/in", signal: "logs" });
  await addValidationRule(api.ownerDb, { ...ids, validationPipelineId: pipeline.id, position: 1, pattern: RULE_MARKER, name: "has the marker" });
  await addValidationRule(api.ownerDb, {
    ...ids,
    validationPipelineId: pipeline.id,
    position: 2,
    kind: "ottl",
    pattern: null,
    ottl_context: "log",
    ottl_quantifier: "any",
    ottl_condition: "body != nil",
    is_api_owned: true,
  });
  return { configurationId: configuration.id };
}

describe("telflo config rules against the API", () => {
  it("lists the latest version's saved pipelines with a read token; --version names another; --json is route 13's items", async () => {
    const account = await serviceAccountWithToken(api.ownerDb, "read");
    tokens.push(account.token);
    const { configurationId } = await configurationWithRules(account.organizationId);

    const ran = await cli(account.token, ["config", "rules", configurationId]);
    expect(ran.code).toBe(0);
    const lines = ran.stdout.split("\n");
    expect(lines[0]).toBe("logs/in (logs): 2 rules, 1 API-owned");
    expect(lines[3]?.split(/\s{2,}/)).toEqual(["1", "has the marker", "contains_text", "output", RULE_MARKER]);
    expect(lines[4]?.split(/\s{2,}/)).toEqual(["2", "ottl", "output", "yes", "log any body != nil"]);

    const json = await cli(account.token, ["--json", "config", "rules", configurationId, "--version", "2"]);
    const reply = JSON.parse(json.stdout) as { configurationId: string; versionNumber: number; items: Array<{ pipeline: string; rules: unknown[] }> };
    expect(reply).toMatchObject({ configurationId, versionNumber: 2, items: [{ pipeline: "logs/in" }] });
    expect(reply.items[0]?.rules).toHaveLength(2);

    const first = await cli(account.token, ["config", "rules", configurationId, "--version", "1"]);
    expect(first.stdout).toBe(`${NO_PIPELINES_MESSAGE(1)}\n`);
  });

  it("another organization's configuration is the API's 404 (exit 1)", async () => {
    const account = await serviceAccountWithToken(api.ownerDb, "read");
    const other = await serviceAccountWithToken(api.ownerDb, "read");
    tokens.push(account.token, other.token);
    const { configurationId } = await configurationWithRules(other.organizationId);
    const ran = await cli(account.token, ["--json", "config", "rules", configurationId]);
    expect(ran.code).toBe(1);
    expect((JSON.parse(ran.stderr) as { error: { status: number } }).error.status).toBe(404);
  });
});
